/**
 * Code.gs — Google Apps Script server entrypoint.
 *
 * Public entrypoints:
 *   doGet()               → serves the web UI (Index.html)
 *   scanDirectory(id)     → RPC: Phase 1 dry-run inventory
 *   commitTransfer(...)   → RPC: kicks off Phase 2 production run
 *   resumeTransfer()      → time-driven trigger handler for batching
 */

var PROP_STATE_KEY = 'gmove.state.v1';
var RESUME_TRIGGER_HANDLER = 'resumeTransfer';

// ---------- Web UI ---------------------------------------------------------

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Drive Ownership Transfer')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getActiveUserEmail() {
  return Session.getActiveUser().getEmail();
}

// ---------- Phase 1: scan --------------------------------------------------

/**
 * Recursively walk the target folder and return a tree describing every item,
 * whether the current user owns it, and therefore whether we could transfer it.
 * Read-only — makes no mutations.
 */
function scanDirectory(targetFolderId) {
  if (!targetFolderId) throw new Error('TARGET_FOLDER_ID is required.');
  var activeUserEmail = getActiveUserEmail();
  var root;
  try {
    root = DriveApp.getFolderById(targetFolderId);
  } catch (e) {
    throw new Error('Cannot open folder ' + targetFolderId + ': ' + e.message);
  }

  var visited = {};
  var tree = walkFolder_(root, '', visited, activeUserEmail);
  return {
    activeUserEmail: activeUserEmail,
    tree: tree
  };
}

function walkFolder_(folder, parentPath, visited, activeUserEmail) {
  var id = folder.getId();
  if (visited[id]) {
    return { id: id, name: folder.getName(), path: joinPath(parentPath, folder.getName()), isFolder: true, owner: '', mimeType: 'application/vnd.google-apps.folder', transferable: false, children: [], note: 'cycle-skipped' };
  }
  visited[id] = true;

  var name = folder.getName();
  var here = joinPath(parentPath, name);
  var ownerEmail = safeOwnerEmail_(folder);

  var node = {
    id: id,
    name: name,
    path: here,
    isFolder: true,
    owner: ownerEmail,
    mimeType: 'application/vnd.google-apps.folder',
    transferable: isTransferable(ownerEmail, activeUserEmail),
    children: []
  };

  var subFolders = folder.getFolders();
  while (subFolders.hasNext()) {
    node.children.push(walkFolder_(subFolders.next(), here, visited, activeUserEmail));
  }

  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var fOwner = safeOwnerEmail_(f);
    node.children.push({
      id: f.getId(),
      name: f.getName(),
      path: joinPath(here, f.getName()),
      isFolder: false,
      owner: fOwner,
      mimeType: f.getMimeType(),
      transferable: isTransferable(fOwner, activeUserEmail),
      children: []
    });
  }
  return node;
}

function safeOwnerEmail_(item) {
  try {
    var o = item.getOwner();
    return o ? o.getEmail() : '';
  } catch (e) {
    // Shared drive items have no single owner and throw.
    return '';
  }
}

// ---------- Phase 2: commit + batching ------------------------------------

/**
 * Called from the client after the user finalises the checkbox scope. Persists
 * a plan into ScriptProperties and either runs it to completion or checkpoints.
 */
function commitTransfer(payload) {
  if (!payload) throw new Error('Missing payload.');
  var newOwnerEmail = String(payload.newOwnerEmail || '').trim();
  if (!newOwnerEmail) throw new Error('NEW_OWNER_EMAIL is required.');
  if (!payload.tree) throw new Error('Scan tree is required.');
  var selectedIds = payload.selectedIds || [];
  var selectedSet = {};
  for (var i = 0; i < selectedIds.length; i++) selectedSet[selectedIds[i]] = true;

  var activeUserEmail = getActiveUserEmail();
  var built = buildExecutionPlan(payload.tree, selectedSet, activeUserEmail);

  var state = {
    targetFolderId: payload.targetFolderId || '',
    newOwnerEmail: newOwnerEmail,
    initiatorEmail: activeUserEmail,
    startedAt: new Date().toISOString(),
    plan: built.plan,
    cursor: 0,
    log: built.preLogs.slice()
  };
  saveState_(state);
  clearResumeTriggers_();
  return runBatch_();
}

function resumeTransfer() {
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
    // Do not swallow silently — bubble to Stackdriver for later inspection.
    console.error('MailApp.sendEmail failed: ' + (e && e.message));
  }
}
