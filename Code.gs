/**
 * Code.gs — Google Apps Script server entrypoint.
 *
 * Public entrypoints:
 *   doGet()                → serves the web UI (Index.html) or a "not authorized" page
 *   browseFolder(id)       → RPC: shallow one-level lazy listing for the tree UI
 *   commitTransfer(payload)→ RPC: kicks off Phase 2 production run
 *   resumeTransfer()       → time-driven trigger handler for batching (NOT rate-gated)
 */

var PROP_STATE_KEY = 'gmove.state.v1';
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

  var built = walkAndMerge_(payload);
  var merged = built.merged;

  var state = {
    targetFolderId: (payload && payload.targetFolderId) || '',
    newOwnerEmail: newOwnerEmail,
    initiatorEmail: built.activeUser,
    startedAt: new Date().toISOString(),
    plan: merged.plan,
    cursor: 0,
    log: merged.preLogs.slice()
  };

  // Fail fast if the plan would blow the ScriptProperties quota. We check
  // AFTER building the plan but BEFORE saveState_, so failure loses no work.
  var raw = JSON.stringify(state);
  if (raw.length > MAX_STATE_BYTES) {
    throw new Error(
      'Selection is too large (~' + Math.round(raw.length / 1024) + ' KB serialized; ' +
      'plan has ' + merged.plan.length + ' items). ScriptProperties per-store cap ' +
      'is 500 KB; narrow the selection and try again.'
    );
  }

  saveState_(state);
  clearResumeTriggers_();
  return runBatch_();
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
  clearResumeTriggers_();
  runBatch_();
}

function runBatch_() {
  var state = loadState_();
  if (!state) return { done: true, message: 'No pending transfer state.' };

  var startedAtMs = Date.now();
  var newOwner = state.newOwnerEmail;

  while (state.cursor < state.plan.length) {
    if (shouldCheckpoint(startedAtMs, Date.now(), TIME_BUDGET_MS)) {
      saveState_(state);
      scheduleResume_();
      return { done: false, processed: state.cursor, total: state.plan.length };
    }
    var item = state.plan[state.cursor];
    var entry = attemptTransfer_(item, newOwner);
    state.log.push(entry);
    state.cursor++;
  }

  clearState_();
  finalizeAndReport_(state);
  return { done: true, processed: state.cursor, total: state.plan.length };
}

function attemptTransfer_(item, newOwnerEmail) {
  var ts = new Date().toISOString();
  try {
    var handle = item.isFolder ? DriveApp.getFolderById(item.id) : DriveApp.getFileById(item.id);
    handle.setOwner(newOwnerEmail);
    return {
      timestamp: ts, id: item.id, name: item.name, path: item.path,
      status: STATUS.SUCCESS, message: 'Ownership transferred to ' + newOwnerEmail
    };
  } catch (e) {
    return {
      timestamp: ts, id: item.id, name: item.name, path: item.path,
      status: STATUS.FAILED, message: e && e.message ? e.message : String(e)
    };
  }
}

// ---------- State via PropertiesService ------------------------------------

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(PROP_STATE_KEY, JSON.stringify(state));
}
function loadState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROP_STATE_KEY);
  return raw ? JSON.parse(raw) : null;
}
function clearState_() {
  PropertiesService.getScriptProperties().deleteProperty(PROP_STATE_KEY);
}

function scheduleResume_() {
  ScriptApp.newTrigger(RESUME_TRIGGER_HANDLER)
    .timeBased()
    .after(60 * 1000)
    .create();
}
function clearResumeTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === RESUME_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

// ---------- Reporting -------------------------------------------------------

function finalizeAndReport_(state) {
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
  } catch (e) {
    console.error('MailApp.sendEmail failed: ' + (e && e.message));
  }
}
