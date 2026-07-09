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

  var result = withScriptLock_(function () {
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
    // Kick off runBatch_ immediately when we are first in line, otherwise
    // the existing runner will pick this job up when it finishes its
    // current one via its own scheduleResume_ call at the end of a batch.
    if (!runningExists) ensureResumeTrigger_(0);
    var queuedAhead = 0;
    for (var j = 0; j < registry.length; j++) {
      if (registry[j].jobId === jobId) break;
      if (registry[j].status !== 'done') queuedAhead++;
    }
    return { jobId: jobId, queued: runningExists, ahead: queuedAhead };
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
  runBatch_();
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
  var startedAtMs = Date.now();
  var newOwner = state.newOwnerEmail;

  // If this is a report_pending job, all items were already processed; go
  // straight to finalize (which will retry mail).
  var alreadyDone = state.cursor >= state.plan.length;
  if (!alreadyDone) {
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
    }
  }

  // Completion path — mail first, prune only on success.
  var mailStatus = sendReport_(state);
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
  var url = 'https://www.googleapis.com/drive/v3/files/' +
            encodeURIComponent(item.id) +
            '/permissions?transferOwnership=true' +
            '&moveToNewOwnersRoot=' + (moveToRoot ? 'true' : 'false') +
            '&sendNotificationEmail=true';
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
