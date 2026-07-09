/**
 * Code.gs — Google Apps Script server entrypoint.
 *
 * Public entrypoints:
 *   doGet()                → serves the web UI (Index.html) or a "not authorized" page
 *   browseFolder(id)       → RPC: shallow one-level lazy listing for the tree UI
 *   getMyDriveRoot()       → RPC: My Drive shortcut for the browse tree
 *   previewTransfer(payload) → RPC: dry-run summary + email
 *   commitTransfer(payload)→ RPC: enqueues a run; runs it if nothing else is in flight
 *   listJobs()             → RPC: registry of running/queued jobs for the queue UI
 *   resumeTransfer()       → time-driven trigger handler for batching (NOT rate-gated)
 */

// Legacy single-job key, retained for one-shot migration inside runBatch_.
// New jobs use the registry + per-job state keys defined below.
var PROP_STATE_KEY_LEGACY = 'gmove.state.v1';

// Multi-job storage. Registry holds meta only (small); per-job state keys
// hold the big plan + log arrays.
var PROP_REGISTRY_KEY = 'gmove.jobs.registry.v1';
var PROP_STATE_PREFIX = 'gmove.jobs.state.';

// Cache slot for listJobs — pollers hit it every 8s, so shave load with a
// 2-second TTL. Mutators invalidate immediately.
var CACHE_REGISTRY_KEY = 'gmove.jobs.registry.cache';
var CACHE_REGISTRY_TTL = 2;

// Script lock timeout for the critical section around registry/state writes
// and trigger management. Apps Script tri-color LockService allows exactly
// one holder at a time; 30s is generous vs. the ~1s of work we do inside.
var LOCK_TIMEOUT_MS = 30 * 1000;

// How often (in items processed) runBatch_ pushes a progress update into
// the registry mid-batch so the queue view reflects reality instead of
// sitting at 0/N until the first 4.5-minute checkpoint fires.
var PROGRESS_UPDATE_INTERVAL = 10;

var RESUME_TRIGGER_HANDLER = 'resumeTransfer';

// Serialized-state ceiling before we refuse to persist. ScriptProperties per-store
// quota is 500 KB total; 400 KB leaves headroom for the log to grow during
// execution and for other property keys.
var MAX_STATE_BYTES = 400 * 1024;

// Cap on children returned per browseFolder() call. DriveApp iterators page under
// the hood; without a cap, a folder with tens of thousands of children would push
// browseFolder up against the 6-minute execution quota and produce a client
// response too large to render. If the cap is hit, response.truncated is true.
var BROWSE_PAGE_CAP = 500;

// ---------- Access allowlist ----------------------------------------------
//
// The Apps Script webapp manifest already restricts access to the princeton.edu
// domain (webapp.access = DOMAIN). This constant restricts further, down to a
// specific set of individuals. A ScriptProperty override at key
// 'gmove.allowed_users' (comma-separated list) takes precedence over the
// in-code list — that lets an owner rotate membership without a code deploy.
var SETTINGS = {
  ALLOWED_USERS: [
    'bino@princeton.edu',
    'orfe-files@princeton.edu',
    'cdreyer@princeton.edu'
  ],
  SUPPORT_CONTACT: 'bino@princeton.edu'
};

function getAllowlist_() {
  var override = PropertiesService.getScriptProperties().getProperty('gmove.allowed_users');
  var list = override
    ? override.split(',')
    : SETTINGS.ALLOWED_USERS.slice();
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var e = String(list[i] || '').trim().toLowerCase();
    if (e) out.push(e);
  }
  return out;
}

function isAllowedUser_(email) {
  if (!email) return false;
  var needle = String(email).trim().toLowerCase();
  var haystack = getAllowlist_();
  for (var i = 0; i < haystack.length; i++) {
    if (haystack[i] === needle) return true;
  }
  return false;
}

/**
 * Guard used by every user-invoked RPC. resumeTransfer() must NOT call this
 * (it runs from a time-driven trigger with no active user session).
 */
function assertAuthorized_() {
  var email = getActiveUserEmail();
  if (!isAllowedUser_(email)) {
    console.warn('gmove: rejected access attempt by ' + (email || '(unknown)'));
    throw new Error(
      'You are not on the Drive Ownership Transfer access list. Contact ' +
      SETTINGS.SUPPORT_CONTACT + ' to request access.'
    );
  }
}

/**
 * Looser guard for editor-manual diagnostic functions. When called from the
 * Apps Script editor's function picker (Run menu), Session.getActiveUser
 * usually returns the script owner's email; from google.script.run it
 * returns the client's email. Either path is fine as long as the email
 * is on the allowlist. If getActiveUser returns nothing (rare — happens
 * in some trigger contexts), fall back to allowing execution since only
 * the script owner can reach the editor at all.
 */
function assertAuthorizedForDiagnostics_() {
  var email = getActiveUserEmail();
  if (!email) return;
  if (!isAllowedUser_(email)) {
    console.warn('gmove: rejected diagnostic access attempt by ' + email);
    throw new Error(
      'You are not on the Drive Ownership Transfer access list. Contact ' +
      SETTINGS.SUPPORT_CONTACT + ' to request access.'
    );
  }
}

// ---------- Web UI ---------------------------------------------------------

function doGet() {
  var email = getActiveUserEmail();
  if (!isAllowedUser_(email)) {
    console.warn('gmove: doGet rejected ' + (email || '(unknown)'));
    return renderUnauthorized_(email);
  }
  var t = HtmlService.createTemplateFromFile('Index');
  t.activeUserEmail = email;
  return t.evaluate()
    .setTitle('Drive Ownership Transfer')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getActiveUserEmail() {
  return Session.getActiveUser().getEmail();
}

function renderUnauthorized_(email) {
  var contact = SETTINGS.SUPPORT_CONTACT;
  var safeEmail = String(email || 'unknown').replace(/[<>&"']/g, '');
  var safeContact = contact.replace(/[<>&"']/g, '');
  var html = [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"><title>Not authorized</title>',
    include('Styles'),
    '</head><body>',
    '<div class="pt-container pt-unauthorized">',
      '<h1>Access restricted</h1>',
      '<p>You are signed in as <code>' + safeEmail + '</code>.</p>',
      '<p>Drive Ownership Transfer is limited to a specific list of Princeton ',
        'accounts. If you believe you should have access, contact ',
        '<a href="mailto:' + safeContact + '">' + safeContact + '</a>.</p>',
    '</div></body></html>'
  ].join('');
  return HtmlService.createHtmlOutput(html)
    .setTitle('Not authorized — Drive Ownership Transfer')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// ---------- Convenience: My Drive root -----------------------------------

/**
 * Return the caller's My Drive root as {id, name}. Used by the "Browse My
 * Drive" client shortcut for users who don't know how to copy a folder ID
 * out of a Drive URL. Note: shared drives are NOT reachable from My Drive —
 * a shared-drive folder ID still has to be pasted in manually.
 */
function getMyDriveRoot() {
  assertAuthorized_();
  var root = DriveApp.getRootFolder();
  return { id: root.getId(), name: root.getName() };
}

// ---------- Phase 1: browse (lazy, one level at a time) ------------------

/**
 * Return the target folder's metadata plus its immediate children (folders
 * and files) as shallow stubs. The client calls this once per expand — for
 * the root and for every folder the user clicks to open.
 *
 * The response is capped at BROWSE_PAGE_CAP children. When capped, the
 * response includes `truncated: true` so the UI can surface a warning. A
 * pagination follow-up is not implemented — the intent is that anyone with
 * folders that large restructures rather than transfers item-by-item.
 */
function browseFolder(folderId) {
  assertAuthorized_();
  if (!folderId) throw new Error('folder id is required.');
  var activeUser = getActiveUserEmail();

  var folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (e) { throw new Error('Cannot open folder ' + folderId + ': ' + e.message); }

  var ownerEmail = safeOwnerEmail_(folder);
  var node = {
    id: folder.getId(),
    name: folder.getName(),
    isFolder: true,
    owner: ownerEmail,
    transferable: isTransferable(ownerEmail, activeUser),
    mimeType: 'application/vnd.google-apps.folder'
  };

  var children = [];
  var truncated = false;

  var subs = folder.getFolders();
  while (subs.hasNext()) {
    if (children.length >= BROWSE_PAGE_CAP) { truncated = true; break; }
    var sf = subs.next();
    var so = safeOwnerEmail_(sf);
    children.push({
      id: sf.getId(), name: sf.getName(), isFolder: true, owner: so,
      transferable: isTransferable(so, activeUser),
      mimeType: 'application/vnd.google-apps.folder'
    });
  }
  if (!truncated) {
    var files = folder.getFiles();
    while (files.hasNext()) {
      if (children.length >= BROWSE_PAGE_CAP) { truncated = true; break; }
      var f = files.next();
      var fo = safeOwnerEmail_(f);
      children.push({
        id: f.getId(), name: f.getName(), isFolder: false, owner: fo,
        transferable: isTransferable(fo, activeUser),
        mimeType: f.getMimeType()
      });
    }
  }

  return {
    activeUserEmail: activeUser,
    node: node,
    children: children,
    truncated: truncated,
    cap: BROWSE_PAGE_CAP
  };
}

function safeOwnerEmail_(item) {
  try {
    var o = item.getOwner();
    return o ? o.getEmail() : '';
  } catch (e) {
    return '';
  }
}

// ---------- Phase 2: commit + batching ------------------------------------

/**
 * The client sends recursive folder ids + explicit individual item ids. The
 * server walks each recursive subtree in full (DriveApp) and passes the
 * gathered trees to the pure `mergeSelection` in Logic.gs, which produces
 * the ordered plan and any pre-computed skip logs.
 *
 * There is deliberately no "deselect" input. The absence of that vocabulary
 * is what enforces the "folder → everything inside" invariant server-side:
 * once a folder is in recursiveIds, every transferable descendant it
 * contains is in the plan.
 */
/**
 * Read-only preview of what commitTransfer would do given the current
 * selection. Runs the same walk + merge as the real commit but persists
 * nothing and transfers nothing. The client uses this as the explicit
 * "Dry Run" phase: user sees counts + paths before authorizing the run.
 */
function previewTransfer(payload) {
  assertAuthorized_();
  var built = walkAndMerge_(payload);
  var merged = built.merged;

  var stateBytes = JSON.stringify({ plan: merged.plan, log: merged.preLogs }).length;
  var overCap = stateBytes > MAX_STATE_BYTES;

  var folders = 0, files = 0;
  for (var i = 0; i < merged.plan.length; i++) {
    if (merged.plan[i].isFolder) folders++; else files++;
  }

  var summary = {
    willTransfer: merged.plan.length,
    willSkip:     merged.preLogs.length,
    folders:      folders,
    files:        files,
    stateBytes:   stateBytes,
    overCap:      overCap,
    capBytes:     MAX_STATE_BYTES
  };

  // Email the full report to the initiator. We always send — the user asked
  // for a persistent record of every dry run, and the full plan + skip list
  // is far too large for a browser dialog. The client-side card is a fast
  // interactive view; the email is the auditable copy.
  var emailStatus = emailDryRunReport_({
    initiatorEmail: built.activeUser,
    targetFolderId: (payload && payload.targetFolderId) || '',
    newOwnerEmail:  String((payload && payload.newOwnerEmail) || '').trim(),
    summary:        summary,
    plan:           merged.plan,
    skip:           merged.preLogs
  });

  // Cap the payload we send back to the client — a 5000-item plan does not
  // need to round-trip in full for a preview. Summary counts always reflect
  // the real totals.
  var PREVIEW_CAP = 500;
  var planPreview = merged.plan.slice(0, PREVIEW_CAP);
  var skipPreview = merged.preLogs.slice(0, PREVIEW_CAP);

  return {
    summary:         summary,
    plan:            planPreview,
    planTruncated:   merged.plan.length > PREVIEW_CAP,
    skip:            skipPreview,
    skipTruncated:   merged.preLogs.length > PREVIEW_CAP,
    previewCap:      PREVIEW_CAP,
    emailedTo:       emailStatus.sent ? built.activeUser : null,
    emailError:      emailStatus.error || null
  };
}

/**
 * Send the dry-run report email. Returns {sent: bool, error: string?} so the
 * client can surface a specific message if MailApp bounces (typically a
 * daily-quota trip).
 */
function emailDryRunReport_(context) {
  var completedAt = new Date().toISOString();
  var html = formatDryRunReportHtml({
    targetFolderId: context.targetFolderId,
    newOwnerEmail:  context.newOwnerEmail,
    summary:        context.summary,
    plan:           context.plan,
    skip:           context.skip,
    completedAt:    completedAt
  });
  var csv = dryRunToCsv(context.plan, context.skip);
  var subject = '[DRY RUN] Drive Ownership Transfer — ' +
    context.summary.willTransfer + ' would transfer, ' +
    context.summary.willSkip + ' would skip';
  var attachment = Utilities.newBlob(csv, 'text/csv',
    'drive-transfer-dryrun-' + Date.now() + '.csv');
  try {
    MailApp.sendEmail({
      to: context.initiatorEmail,
      subject: subject,
      htmlBody: html,
      attachments: [attachment]
    });
    return { sent: true };
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    console.error('MailApp.sendEmail (dry run) failed: ' + msg);
    return { sent: false, error: msg };
  }
}

function commitTransfer(payload) {
  assertAuthorized_();
  var newOwnerEmail = String((payload && payload.newOwnerEmail) || '').trim();
  if (!newOwnerEmail) throw new Error('New owner email is required.');

  // Walk + merge happens outside the lock so a long DriveApp walk doesn't
  // block other users' listJobs polls. The lock only guards the tight
  // registry + state + trigger transaction after the plan is built.
  var built = walkAndMerge_(payload);
  var merged = built.merged;

  var jobId = Utilities.getUuid();
  var startedAt = new Date().toISOString();
  var state = {
    jobId: jobId,
    targetFolderId: (payload && payload.targetFolderId) || '',
    newOwnerEmail: newOwnerEmail,
    initiatorEmail: built.activeUser,
    startedAt: startedAt,
    plan: merged.plan,
    cursor: 0,
    log: merged.preLogs.slice()
  };

  // Fail fast if the plan would blow the ScriptProperties quota. Check now,
  // before we acquire the lock or write anything.
  var raw = JSON.stringify(state);
  if (raw.length > MAX_STATE_BYTES) {
    throw new Error(
      'Selection is too large (~' + Math.round(raw.length / 1024) + ' KB serialized; ' +
      'plan has ' + merged.plan.length + ' items). ScriptProperties per-store cap ' +
      'is 500 KB; narrow the selection and try again.'
    );
  }

  var meta = {
    jobId:           jobId,
    initiator:       built.activeUser,
    newOwnerEmail:   newOwnerEmail,
    targetFolderId:  state.targetFolderId,
    startedAt:       startedAt,
    processed:       0,
    total:           merged.plan.length,
    checkpointedAt:  null,
    status:          'queued'
  };

  var registered = withScriptLock_(function () {
    migrateLegacyStateIfPresent_();
    var registry = pruneJobsRegistry(loadJobsRegistry_());
    var runningExists = false;
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].status === 'running') { runningExists = true; break; }
    }
    if (!runningExists) meta.status = 'running';
    registry.push(meta);
    saveJobsRegistry_(registry);
    saveJobState_(jobId, state);
    var queuedAhead = 0;
    for (var j = 0; j < registry.length; j++) {
      if (registry[j].jobId === jobId) break;
      if (registry[j].status !== 'done') queuedAhead++;
    }
    return { jobId: jobId, queued: runningExists, ahead: queuedAhead };
  });

  // If we're first in line, run the first batch SYNCHRONOUSLY. Do not depend
  // on Apps Script's time-driven trigger for kickoff — `after(1000)` triggers
  // are sometimes dropped by the scheduler, which strands the job at 0/N.
  // The lock is already released; runBatch_ acquires its own. Client waits
  // up to the Apps Script per-call limit (~6 min) but sees real progress in
  // the queue view via the mid-batch progress writes.
  if (!registered.queued) {
    try {
      runBatch_();
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      var stack = e && e.stack ? e.stack : '(no stack)';
      console.error('gmove: initial runBatch_ threw for ' + jobId + ': ' + msg + '\n' + stack);
      // Persist the error to the job's meta so the queue UI can surface it,
      // then schedule a retry trigger so the job isn't permanently stranded.
      try {
        withScriptLock_(function () {
          updateJobMeta_(jobId, {
            lastError: msg.slice(0, 500),
            lastErrorAt: new Date().toISOString()
          });
          ensureResumeTrigger_(60 * 1000);
        });
      } catch (e2) {
        console.error('gmove: could not persist lastError / schedule retry: ' +
                      (e2 && e2.message ? e2.message : e2));
      }
    }
  }

  // Report whether the job finished within the sync call (registry entry
  // gone) or is still in flight. The client uses `done` to switch its
  // status message between "Transfer complete" and "Job started / running."
  var finalRegistry = loadJobsRegistry_();
  var stillThere = false;
  var lastKnown = null;
  for (var k = 0; k < finalRegistry.length; k++) {
    if (finalRegistry[k].jobId === jobId) { stillThere = true; lastKnown = finalRegistry[k]; break; }
  }
  registered.done = !stillThere;
  if (stillThere && lastKnown) {
    registered.processed = lastKnown.processed || 0;
    registered.total = lastKnown.total || 0;
  }
  return registered;
}

/**
 * Cancel a single job by id. Drops its registry entry and per-job state
 * key so `runBatch_` will never touch it again. Does NOT undo any Drive
 * ownership changes that already went through — cancellation is about the
 * TRACKING state, not the effect on Drive. If the job had already
 * transferred N items, those N are transferred; cancellation only stops
 * the remaining items from being attempted.
 *
 * Any allowlisted user can cancel any job. This is a small trusted team
 * (three users on the allowlist) and the queue view is already shared —
 * gating cancellation to just the initiator would surprise users who see
 * a stuck job in the queue and want to unstick it.
 */
function cancelJob(jobId) {
  assertAuthorized_();
  if (!jobId) throw new Error('jobId is required.');
  var caller = getActiveUserEmail();
  var result = withScriptLock_(function () {
    var registry = loadJobsRegistry_();
    var job = null;
    for (var i = 0; i < registry.length; i++) {
      if (registry[i].jobId === jobId) { job = registry[i]; break; }
    }
    if (!job) {
      return { cancelled: false, reason: 'job not in registry (already completed or already cancelled)' };
    }
    var wasStatus = job.status;
    var wasProcessed = job.processed || 0;
    var wasTotal = job.total || 0;
    removeJobFromRegistry_(jobId);
    deleteJobState_(jobId);
    console.warn('gmove: cancelJob by ' + (caller || '(unknown)') + ' — ' + JSON.stringify({
      jobId: jobId,
      initiator: job.initiator,
      newOwnerEmail: job.newOwnerEmail,
      priorStatus: wasStatus,
      processed: wasProcessed,
      total: wasTotal
    }));
    // If we just cancelled the running job, the resume trigger cycle will
    // still fire and pick up whatever is next in the registry. Nothing to
    // clean up on the trigger side — ensureResumeTrigger_ is idempotent.
    return {
      cancelled: true,
      jobId: jobId,
      initiator: job.initiator,
      priorStatus: wasStatus,
      processed: wasProcessed,
      total: wasTotal
    };
  });
  return result;
}

/**
 * Read-only snapshot of the current jobs registry for the queue UI. Cached
 * for 2 seconds because pollers hit this every 8s and PropertiesService
 * reads are serialized script-wide. Writers invalidate the cache slot.
 */
function listJobs() {
  assertAuthorized_();
  var cache = CacheService.getScriptCache();
  var hit = cache.get(CACHE_REGISTRY_KEY);
  if (hit) return JSON.parse(hit);
  var jobs = loadJobsRegistry_();
  var payload = { jobs: jobs, fetchedAt: new Date().toISOString() };
  try { cache.put(CACHE_REGISTRY_KEY, JSON.stringify(payload), CACHE_REGISTRY_TTL); }
  catch (e) { /* cache is best-effort */ }
  return payload;
}

/**
 * Shared walk + merge used by both previewTransfer and commitTransfer so
 * the preview cannot drift out of sync with what the real run would do.
 * Does no persistence or authorization; callers must gate.
 */
function walkAndMerge_(payload) {
  if (!payload) throw new Error('Missing payload.');
  var selection = payload.selection || {};
  var recursiveIds = selection.recursiveIds || [];
  var explicitIds  = selection.explicitIds  || [];
  if (!recursiveIds.length && !explicitIds.length) {
    throw new Error('No items selected.');
  }
  var activeUser = getActiveUserEmail();

  var recursiveTrees = [];
  for (var i = 0; i < recursiveIds.length; i++) {
    var rid = recursiveIds[i];
    var f;
    try { f = DriveApp.getFolderById(rid); }
    catch (e) { throw new Error('Cannot access folder ' + rid + ': ' + e.message); }
    recursiveTrees.push(walkFullTree_(f, ''));
  }
  var explicitItems = [];
  for (var j = 0; j < explicitIds.length; j++) {
    var it = resolveItem_(explicitIds[j]);
    if (it) explicitItems.push(it);
  }
  var merged = mergeSelection({
    recursiveTrees: recursiveTrees,
    explicitItems: explicitItems,
    activeUserEmail: activeUser
  });
  return { merged: merged, activeUser: activeUser };
}

function walkFullTree_(folder, parentPath) {
  var here = joinPath(parentPath, folder.getName());
  var node = {
    id: folder.getId(),
    name: folder.getName(),
    path: here,
    isFolder: true,
    owner: safeOwnerEmail_(folder),
    children: []
  };
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    node.children.push(walkFullTree_(subs.next(), here));
  }
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    node.children.push({
      id: f.getId(),
      name: f.getName(),
      path: joinPath(here, f.getName()),
      isFolder: false,
      owner: safeOwnerEmail_(f),
      children: []
    });
  }
  return node;
}

function resolveItem_(id) {
  var handle = null;
  var isFolder = false;
  try { handle = DriveApp.getFolderById(id); isFolder = true; }
  catch (e1) {
    try { handle = DriveApp.getFileById(id); }
    catch (e2) { return null; }
  }
  return {
    id: id,
    name: handle.getName(),
    path: handle.getName(),
    isFolder: isFolder,
    owner: safeOwnerEmail_(handle),
    children: []
  };
}

function resumeTransfer() {
  // Runs from a time-driven trigger; there is no active user, so DO NOT gate.
  // Do NOT blanket-clear triggers here — ensureResumeTrigger_ is the only
  // path that creates them, and it keeps the "at most one" invariant. If
  // this handler ran because a scheduled trigger fired, that trigger is
  // already consumed.
  try {
    runBatch_();
  } catch (e) {
    // Whatever went wrong, do NOT leave the job stranded. Log full stack
    // for post-mortem, then schedule a retry so the next tick has a chance
    // to succeed (e.g., after a transient PropertiesService blip).
    var msg = e && e.message ? e.message : String(e);
    var stack = e && e.stack ? e.stack : '(no stack)';
    console.error('gmove: resumeTransfer runBatch_ threw: ' + msg + '\n' + stack);
    try {
      ensureResumeTrigger_(60 * 1000);
      console.info('gmove: scheduled retry trigger 60s out after runBatch_ failure.');
    } catch (e2) {
      console.error('gmove: failed to schedule retry: ' + (e2 && e2.message ? e2.message : e2));
    }
    // Re-throw so the Executions view shows Failed with the real error,
    // rather than a silent Completed that hides the problem.
    throw e;
  }
}

// ---------- Diagnostics (run from the editor Run menu) ---------------------

/**
 * Snapshot every piece of state runBatch_ / the queue view care about, so
 * an operator can tell from the Apps Script editor whether a job is
 * running, stuck, or gone. Run from the editor Function dropdown → Run.
 * The return value shows in the Executions view; the JSON body also lands
 * in console.info so it stays in the log stream.
 */
function debugState() {
  assertAuthorizedForDiagnostics_();
  var props = PropertiesService.getScriptProperties();
  var registry = loadJobsRegistry_();
  var allKeys = props.getKeys();
  var stateKeys = [];
  for (var i = 0; i < allKeys.length; i++) {
    if (allKeys[i].indexOf(PROP_STATE_PREFIX) === 0) stateKeys.push(allKeys[i]);
  }
  var registryIds = {};
  for (var j = 0; j < registry.length; j++) registryIds[registry[j].jobId] = true;
  var orphanStateKeys = [];
  for (var k = 0; k < stateKeys.length; k++) {
    var jobId = stateKeys[k].substring(PROP_STATE_PREFIX.length);
    if (!registryIds[jobId]) orphanStateKeys.push(stateKeys[k]);
  }
  var triggers = ScriptApp.getProjectTriggers();
  var resumeTriggers = [];
  for (var t = 0; t < triggers.length; t++) {
    if (triggers[t].getHandlerFunction() === RESUME_TRIGGER_HANDLER) {
      resumeTriggers.push({
        handler: triggers[t].getHandlerFunction(),
        source: String(triggers[t].getTriggerSource()),
        uniqueId: triggers[t].getUniqueId()
      });
    }
  }
  var out = {
    now: new Date().toISOString(),
    activeUser: getActiveUserEmail() || '(none — script owner context)',
    registry: registry.map(function (row) {
      return {
        jobId: row.jobId,
        status: row.status,
        initiator: row.initiator,
        newOwnerEmail: row.newOwnerEmail,
        processed: row.processed,
        total: row.total,
        startedAt: row.startedAt,
        checkpointedAt: row.checkpointedAt,
        hasStateKey: registryIds[row.jobId] && stateKeys.indexOf(PROP_STATE_PREFIX + row.jobId) !== -1
      };
    }),
    orphanStateKeys: orphanStateKeys,
    resumeTriggerCount: resumeTriggers.length,
    resumeTriggers: resumeTriggers,
    legacyStatePresent: !!props.getProperty(PROP_STATE_KEY_LEGACY)
  };
  console.info('gmove debugState: ' + JSON.stringify(out));
  return out;
}

/**
 * Manually kick the batch runner. Use when debugState() shows a running
 * job but no resume trigger, or when a trigger appears to have died. Safe
 * to call any time — if nothing is pending it returns immediately. Runs
 * synchronously and processes up to one batch of the current job before
 * returning.
 */
function nudgeResume() {
  assertAuthorizedForDiagnostics_();
  console.info('gmove nudgeResume: manual invocation by ' + (getActiveUserEmail() || '(script owner)'));
  return runBatch_();
}

/**
 * DANGEROUS — wipes the entire jobs registry and all per-job state keys,
 * and drops every resume trigger. Only run if debugState() shows a
 * corrupted or clearly-abandoned run that will not clear via nudgeResume.
 * Does NOT undo any Drive changes; only the tracking state.
 */
function debugClearAllJobs() {
  assertAuthorizedForDiagnostics_();
  var props = PropertiesService.getScriptProperties();
  var keys = props.getKeys();
  var removed = [];
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === PROP_REGISTRY_KEY ||
        keys[i] === PROP_STATE_KEY_LEGACY ||
        keys[i].indexOf(PROP_STATE_PREFIX) === 0) {
      props.deleteProperty(keys[i]);
      removed.push(keys[i]);
    }
  }
  var triggers = ScriptApp.getProjectTriggers();
  var droppedTriggers = 0;
  for (var t = 0; t < triggers.length; t++) {
    if (triggers[t].getHandlerFunction() === RESUME_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[t]);
      droppedTriggers++;
    }
  }
  invalidateRegistryCache_();
  console.warn('gmove debugClearAllJobs: removed keys=' + JSON.stringify(removed) +
               ' droppedTriggers=' + droppedTriggers);
  return { removedKeys: removed, droppedTriggers: droppedTriggers };
}

/**
 * Advance whichever job is currently in-flight (or promote the oldest
 * queued one if nothing is running). Returns after either a checkpoint,
 * completion, or if nothing was pending. Handles at most ONE job per
 * invocation — the resume trigger cycle drains the queue over multiple
 * calls. That keeps the per-invocation time budget simple and prevents
 * one huge job's plan from starving another.
 */
function runBatch_() {
  var currentJobId = null;
  try {
    return runBatch_impl_(function (id) { currentJobId = id; });
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    var stack = e && e.stack ? e.stack : '(no stack)';
    console.error('gmove runBatch_ error' +
      (currentJobId ? ' [job ' + currentJobId + ']' : '') + ': ' + msg + '\n' + stack);
    if (currentJobId) {
      try {
        withScriptLock_(function () {
          updateJobMeta_(currentJobId, {
            lastError: msg.slice(0, 500),
            lastErrorAt: new Date().toISOString()
          });
        });
      } catch (e2) { /* best-effort */ }
    }
    throw e;
  }
}

function runBatch_impl_(setCurrentJobId) {
  // Pick + load under the lock so nothing else can grab or delete our job.
  var loaded = withScriptLock_(function () {
    migrateLegacyStateIfPresent_();
    var registry = pruneJobsRegistry(loadJobsRegistry_());
    var job = pickNextJob(registry);
    if (!job) {
      saveJobsRegistry_(registry);
      invalidateRegistryCache_();
      return null;
    }
    if (job.status === 'queued') {
      job.status = 'running';
      saveJobsRegistry_(registry);
      invalidateRegistryCache_();
    }
    var state = loadJobState_(job.jobId);
    if (!state) {
      // Registry meta without state is a corrupted entry — drop it and let
      // the next tick pick something else.
      console.error('gmove: registry entry with no state, dropping: ' + JSON.stringify(job));
      removeJobFromRegistry_(job.jobId);
      return null;
    }
    return { job: job, state: state };
  });
  if (!loaded) return { done: true, message: 'No pending jobs.' };

  var job = loaded.job;
  var state = loaded.state;
  setCurrentJobId(job.jobId);
  var startedAtMs = Date.now();
  var newOwner = state.newOwnerEmail;
  // Clear any stale lastError on this job now that we're actually running.
  // If we throw before making progress, the outer catch rewrites it fresh.
  if (job.lastError) {
    withScriptLock_(function () {
      updateJobMeta_(job.jobId, { lastError: null, lastErrorAt: null });
    });
  }

  // If this is a report_pending job, all items were already processed; go
  // straight to finalize (which will retry mail).
  var alreadyDone = state.cursor >= state.plan.length;
  if (!alreadyDone) {
    var sinceProgressPush = 0;
    while (state.cursor < state.plan.length) {
      if (shouldCheckpoint(startedAtMs, Date.now(), TIME_BUDGET_MS)) {
        withScriptLock_(function () {
          saveJobState_(job.jobId, state);
          updateJobMeta_(job.jobId, {
            processed: state.cursor,
            checkpointedAt: new Date().toISOString()
          });
          ensureResumeTrigger_(60 * 1000);
        });
        return { done: false, jobId: job.jobId, processed: state.cursor, total: state.plan.length };
      }
      var item = state.plan[state.cursor];
      state.log.push(attemptTransfer_(item, newOwner));
      state.cursor++;
      sinceProgressPush++;
      // Cheap mid-batch progress update — the registry write is small
      // (meta only, no plan or log), and the queue view starts reflecting
      // real progress instead of sitting at 0/N for minutes.
      if (sinceProgressPush >= PROGRESS_UPDATE_INTERVAL) {
        sinceProgressPush = 0;
        var cursorSnapshot = state.cursor;
        withScriptLock_(function () {
          updateJobMeta_(job.jobId, { processed: cursorSnapshot });
        });
      }
    }
  }

  // Completion path — mail first, prune only on success.
  var mailStatus = sendReport_(state);
  if (mailStatus.sent) {
    // Best-effort: also send a summary to the new owner so they know what
    // just landed in their Drive. Not gating job cleanup on this — the
    // initiator's report is the auditable record; the new-owner email is
    // a courtesy notification.
    sendNewOwnerReport_(state);
  }
  withScriptLock_(function () {
    if (mailStatus.sent) {
      deleteJobState_(job.jobId);
      removeJobFromRegistry_(job.jobId);
    } else {
      // Keep state; keep the entry as report_pending so the next resume
      // trigger retries the mail send. Log so operators can spot repeated
      // failures in Stackdriver.
      console.error('gmove: report send failed for ' + job.jobId + ' — retaining as report_pending. ' +
                    (mailStatus.error || ''));
      updateJobMeta_(job.jobId, { status: 'report_pending', processed: state.cursor });
    }
    // Whether success or retention, if there are more jobs waiting, kick a
    // near-future trigger so runBatch_ picks the next one up.
    var registry = pruneJobsRegistry(loadJobsRegistry_());
    if (registry.length > 0) ensureResumeTrigger_(10 * 1000);
  });
  return {
    done: mailStatus.sent,
    jobId: job.jobId,
    processed: state.cursor,
    total: state.plan.length,
    reportPending: !mailStatus.sent
  };
}

/**
 * Transfer ownership of one Drive item via the Drive REST API v3 directly.
 *
 * Uses the same OAuth token DriveApp uses (no manifest / advanced-service
 * changes; the linter that stripped the manifest cannot break this path).
 * Two behaviors that DriveApp.setOwner cannot do on its own:
 *
 *   - moveToNewOwnersRoot: for items the user picked directly (item.moveToRoot),
 *     Drive re-parents the item to the new owner's My Drive root so it is
 *     visible in a generic "My Drive" listing. Descendants pulled in by a
 *     recursive walk have moveToRoot=false — they follow their parent and
 *     keep the subtree intact.
 *
 *   - sendNotificationEmail: kept at true (Drive's default for role=owner)
 *     because a prior attempt at suppressing it triggered "consent required"
 *     failures. Once we have a clean sample of the working path, we can
 *     revisit that.
 *
 * On failure we log the full Drive API response body to Stackdriver so
 * `clasp open-logs` gives you the actual reason instead of a wrapped
 * message.
 */
function attemptTransfer_(item, newOwnerEmail) {
  var ts = new Date().toISOString();
  var moveToRoot = !!item.moveToRoot;
  // sendNotificationEmail=false — per-item mail is what triggers the
  // "successfully shared but emails could not be sent" throttle when the
  // same new owner is on the receiving end of a large batch. The script
  // now sends ONE consolidated summary to the new owner from
  // sendNewOwnerReport_ once the whole run finishes, so per-item mail is
  // pure noise.
  var url = 'https://www.googleapis.com/drive/v3/files/' +
            encodeURIComponent(item.id) +
            '/permissions?transferOwnership=true' +
            '&moveToNewOwnersRoot=' + (moveToRoot ? 'true' : 'false') +
            '&sendNotificationEmail=false';
  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({
        role: 'owner',
        type: 'user',
        emailAddress: newOwnerEmail
      }),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      return {
        timestamp: ts, id: item.id, name: item.name, path: item.path,
        isFolder: !!item.isFolder, moveToRoot: moveToRoot,
        status: STATUS.SUCCESS,
        message: 'Transferred to ' + newOwnerEmail +
          (moveToRoot ? ' (moved to their My Drive root).' : ' (kept in transferred subtree).')
      };
    }
    // Non-2xx: extract Drive's message before deciding whether this is a real
    // failure. Drive returns 400 with a very specific message when the
    // ownership change actually succeeded but the notification email got
    // rate-limited (common when the same new owner is on the receiving end
    // of a large batch). Treat that case as SUCCESS with a note.
    var body = response.getContentText();
    var driveMsg = extractDriveError_(body);
    if (isDriveNotificationOnlyFailure(driveMsg)) {
      console.info('gmove: notification email throttled but transfer succeeded: ' + JSON.stringify({
        itemId: item.id, itemName: item.name, itemPath: item.path,
        newOwner: newOwnerEmail
      }));
      return {
        timestamp: ts, id: item.id, name: item.name, path: item.path,
        status: STATUS.SUCCESS,
        message: 'Transferred to ' + newOwnerEmail +
          (moveToRoot ? ' (moved to their My Drive root).' : ' (kept in transferred subtree).') +
          ' [Drive throttled the notification email; new owner will not receive one for this item.]'
      };
    }
    console.error('gmove transfer failed: ' + JSON.stringify({
      httpStatus: code,
      itemId: item.id,
      itemName: item.name,
      itemPath: item.path,
      isFolder: !!item.isFolder,
      moveToRoot: moveToRoot,
      newOwner: newOwnerEmail,
      driveBody: body
    }));
    return {
      timestamp: ts, id: item.id, name: item.name, path: item.path,
      status: STATUS.FAILED,
      message: driveMsg || ('Drive API HTTP ' + code)
    };
  } catch (e) {
    var errMsg = e && e.message ? e.message : String(e);
    console.error('gmove transfer threw: ' + JSON.stringify({
      itemId: item.id, itemName: item.name, itemPath: item.path,
      isFolder: !!item.isFolder, moveToRoot: moveToRoot,
      newOwner: newOwnerEmail, error: errMsg
    }));
    return {
      timestamp: ts, id: item.id, name: item.name, path: item.path,
      status: STATUS.FAILED, message: errMsg
    };
  }
}

function extractDriveError_(body) {
  if (!body) return '';
  try {
    var j = JSON.parse(body);
    if (j && j.error && j.error.message) return j.error.message;
  } catch (e) { /* not JSON — fall through */ }
  return '';
}

// ---------- Registry + per-job state via PropertiesService -----------------

function loadJobsRegistry_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_REGISTRY_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) || []; }
  catch (e) {
    console.error('gmove: corrupt registry, resetting: ' + (e && e.message));
    return [];
  }
}
function saveJobsRegistry_(registry) {
  PropertiesService.getScriptProperties().setProperty(PROP_REGISTRY_KEY, JSON.stringify(registry || []));
  invalidateRegistryCache_();
}
function invalidateRegistryCache_() {
  try { CacheService.getScriptCache().remove(CACHE_REGISTRY_KEY); }
  catch (e) { /* best-effort */ }
}

function loadJobState_(jobId) {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_STATE_PREFIX + jobId);
  return raw ? JSON.parse(raw) : null;
}
function saveJobState_(jobId, state) {
  PropertiesService.getScriptProperties().setProperty(PROP_STATE_PREFIX + jobId, JSON.stringify(state));
}
function deleteJobState_(jobId) {
  PropertiesService.getScriptProperties().deleteProperty(PROP_STATE_PREFIX + jobId);
}

function removeJobFromRegistry_(jobId) {
  var registry = loadJobsRegistry_();
  var out = [];
  for (var i = 0; i < registry.length; i++) {
    if (registry[i].jobId !== jobId) out.push(registry[i]);
  }
  saveJobsRegistry_(out);
}

function updateJobMeta_(jobId, patch) {
  var registry = loadJobsRegistry_();
  for (var i = 0; i < registry.length; i++) {
    if (registry[i].jobId === jobId) {
      for (var k in patch) if (patch.hasOwnProperty(k)) registry[i][k] = patch[k];
    }
  }
  saveJobsRegistry_(registry);
}

/**
 * One-shot migration for a pre-refactor deploy that left a job mid-flight
 * under the legacy PROP_STATE_KEY_LEGACY key. Runs inside the lock (always
 * called from `commitTransfer` / `runBatch_` critical sections). Idempotent
 * — after the first call the legacy key is gone.
 */
function migrateLegacyStateIfPresent_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(PROP_STATE_KEY_LEGACY);
  if (!raw) return;
  var registry = loadJobsRegistry_();
  var wasEmpty = registry.length === 0;
  props.deleteProperty(PROP_STATE_KEY_LEGACY);
  if (!wasEmpty) {
    console.warn('gmove: legacy state key present alongside a live registry; discarded.');
    return;
  }
  try {
    var legacy = JSON.parse(raw);
    var jobId = 'legacy-' + Utilities.getUuid();
    var meta = {
      jobId:           jobId,
      initiator:       legacy.initiatorEmail || '',
      newOwnerEmail:   legacy.newOwnerEmail || '',
      targetFolderId:  legacy.targetFolderId || '',
      startedAt:       legacy.startedAt || new Date().toISOString(),
      processed:       legacy.cursor || 0,
      total:           (legacy.plan && legacy.plan.length) || 0,
      checkpointedAt:  new Date().toISOString(),
      status:          'running'
    };
    saveJobState_(jobId, {
      jobId: jobId,
      targetFolderId: meta.targetFolderId,
      newOwnerEmail: meta.newOwnerEmail,
      initiatorEmail: meta.initiator,
      startedAt: meta.startedAt,
      plan: legacy.plan || [],
      cursor: legacy.cursor || 0,
      log: legacy.log || []
    });
    saveJobsRegistry_([meta]);
    console.info('gmove: migrated legacy state to job ' + jobId);
  } catch (e) {
    console.error('gmove: legacy state was unparseable; deleted anyway: ' + (e && e.message));
  }
}

// ---------- Trigger management ---------------------------------------------

/**
 * Ensure at most one resume trigger exists. If one already exists, leave it
 * alone (do not shorten or lengthen). If none exists, create one at the
 * requested delay. Always called from within a lock so no two callers race
 * to create duplicates.
 */
function ensureResumeTrigger_(delayMs) {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === RESUME_TRIGGER_HANDLER) return;
  }
  ScriptApp.newTrigger(RESUME_TRIGGER_HANDLER)
    .timeBased()
    .after(Math.max(1000, delayMs || 0))
    .create();
}

// ---------- Script lock helper ---------------------------------------------

function withScriptLock_(fn) {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
      throw new Error('Could not acquire script lock within ' + LOCK_TIMEOUT_MS + 'ms.');
    }
    return fn();
  } finally {
    try { lock.releaseLock(); } catch (_) { /* ignore */ }
  }
}

// ---------- Reporting -------------------------------------------------------

/**
 * Send the new-owner summary email. One consolidated notification listing
 * every item now owned by them, with a Drive link per item as a fallback
 * so they can navigate to the items even if My Drive listings do not
 * surface them right away. Best-effort — never throws; a failure is
 * console.error'd and does not block the initiator's report or job
 * pruning.
 */
function sendNewOwnerReport_(state) {
  var newOwner = String(state.newOwnerEmail || '').trim();
  if (!newOwner) return { sent: false, error: 'no new owner email on state' };

  // Only successes — the new owner does not need to see failures or
  // not-owned skips (those aren't their items).
  var successes = [];
  for (var i = 0; i < (state.log || []).length; i++) {
    if (state.log[i].status === STATUS.SUCCESS) successes.push(state.log[i]);
  }
  if (successes.length === 0) {
    console.info('gmove: new-owner report skipped — no successes to report.');
    return { sent: false, error: 'no successes' };
  }

  var completedAt = new Date().toISOString();
  var html = formatNewOwnerNotificationHtml({
    initiatorEmail: state.initiatorEmail,
    completedAt: completedAt,
    log: successes
  });
  // Attach the full CSV of successes so the new owner has a durable
  // fallback list of Drive links for every item, in case some do not
  // surface in My Drive right away.
  var csv = logToCsv(successes);
  var attachment = Utilities.newBlob(csv, 'text/csv',
    'drive-ownership-transferred-to-you-' + Date.now() + '.csv');
  var subject = 'You now own ' + successes.length + ' item' +
    (successes.length === 1 ? '' : 's') + ' — transferred by ' +
    (state.initiatorEmail || 'a colleague');
  try {
    MailApp.sendEmail({
      to: newOwner,
      subject: subject,
      htmlBody: html,
      attachments: [attachment]
    });
    return { sent: true };
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    console.error('gmove: sendNewOwnerReport_ failed for ' + newOwner + ': ' + msg);
    return { sent: false, error: msg };
  }
}

/**
 * Format and send the completion report. Returns {sent, error?} so the
 * caller can decide whether to prune the job or keep it as report_pending.
 * Never throws.
 */
function sendReport_(state) {
  var summary = summarizeLog(state.log);
  var completedAt = new Date().toISOString();
  var html = formatReportHtml({
    targetFolderId: state.targetFolderId,
    newOwnerEmail: state.newOwnerEmail,
    log: state.log,
    completedAt: completedAt
  });
  var csv = logToCsv(state.log);
  var subject = 'Drive Ownership Transfer — ' + summary.success + ' succeeded, ' + summary.failed + ' failed';
  var attachment = Utilities.newBlob(csv, 'text/csv', 'drive-transfer-log-' + Date.now() + '.csv');
  try {
    MailApp.sendEmail({
      to: state.initiatorEmail,
      subject: subject,
      htmlBody: html,
      attachments: [attachment]
    });
    return { sent: true };
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    console.error('MailApp.sendEmail failed: ' + msg);
    return { sent: false, error: msg };
  }
}
