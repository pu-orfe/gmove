/**
 * Logic.gs
 *
 * Framework-free helpers. Do NOT reference DriveApp / Session / PropertiesService here.
 * The Node test harness under /tests eval-loads this file in a sandbox.
 */

/** Runs *ms* before we treat the invocation as too close to the 6-minute hard cap. */
var TIME_BUDGET_MS = 4.5 * 60 * 1000;

var STATUS = {
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  SKIPPED_NOT_OWNED: 'SKIPPED (NOT OWNED)',
  SKIPPED_DESELECTED: 'SKIPPED (USER DESELECTED)'
};

/** True iff the active user currently owns the item and can therefore call setOwner. */
function isTransferable(currentOwnerEmail, activeUserEmail) {
  if (!currentOwnerEmail || !activeUserEmail) return false;
  return String(currentOwnerEmail).toLowerCase() === String(activeUserEmail).toLowerCase();
}

/**
 * Given a scan tree and the set of ids the UI kept checked, return the ordered
 * list of items to attempt to transfer (folders first so children inherit,
 * then files). Anything not owned or not selected is emitted as a pre-computed
 * skip log entry.
 */
function buildExecutionPlan(tree, selectedIdSet, activeUserEmail) {
  var toTransfer = [];
  var preLogs = [];
  var folders = [];
  var files = [];

  function walk(node) {
    if (!node) return;
    var selected = selectedIdSet && selectedIdSet[node.id];
    var transferable = isTransferable(node.owner, activeUserEmail);
    if (!transferable) {
      preLogs.push({
        id: node.id,
        name: node.name,
        path: node.path,
        status: STATUS.SKIPPED_NOT_OWNED,
        message: 'Owned by ' + (node.owner || 'unknown')
      });
    } else if (!selected) {
      preLogs.push({
        id: node.id,
        name: node.name,
        path: node.path,
        status: STATUS.SKIPPED_DESELECTED,
        message: 'User deselected in UI'
      });
    } else {
      var bucket = node.isFolder ? folders : files;
      bucket.push({
        id: node.id,
        name: node.name,
        path: node.path,
        isFolder: !!node.isFolder
      });
    }
    if (node.children && node.children.length) {
      for (var i = 0; i < node.children.length; i++) walk(node.children[i]);
    }
  }
  walk(tree);
  toTransfer = folders.concat(files);
  return { plan: toTransfer, preLogs: preLogs };
}

/** Decide whether we should checkpoint and hand off to a resume trigger. */
function shouldCheckpoint(startedAtMs, nowMs, budgetMs) {
  var elapsed = nowMs - startedAtMs;
  return elapsed >= (budgetMs != null ? budgetMs : TIME_BUDGET_MS);
}

/** Aggregate a log array into dashboard counters. */
function summarizeLog(log) {
  var summary = { total: log.length, success: 0, failed: 0, skippedNotOwned: 0, skippedDeselected: 0 };
  for (var i = 0; i < log.length; i++) {
    var s = log[i].status;
    if (s === STATUS.SUCCESS) summary.success++;
    else if (s === STATUS.FAILED) summary.failed++;
    else if (s === STATUS.SKIPPED_NOT_OWNED) summary.skippedNotOwned++;
    else if (s === STATUS.SKIPPED_DESELECTED) summary.skippedDeselected++;
  }
  return summary;
}

/** Minimal HTML escaper for values interpolated into the report. */
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build the HTML email body. */
function formatReportHtml(context) {
  var log = context.log || [];
  var summary = summarizeLog(log);
  var targetFolder = escapeHtml(context.targetFolderId || '');
  var newOwner = escapeHtml(context.newOwnerEmail || '');
  var completedAt = escapeHtml(context.completedAt || '');
  var failures = [];
  for (var i = 0; i < log.length; i++) if (log[i].status === STATUS.FAILED) failures.push(log[i]);

  var rows = '';
  if (failures.length === 0) {
    rows = '<tr><td colspan="3" style="padding:8px;color:#666;">No failures recorded.</td></tr>';
  } else {
    for (var j = 0; j < failures.length; j++) {
      var f = failures[j];
      rows +=
        '<tr>' +
        '<td style="padding:6px;border:1px solid #ddd;">' + escapeHtml(f.name) + '</td>' +
        '<td style="padding:6px;border:1px solid #ddd;font-family:monospace;font-size:12px;">' + escapeHtml(f.id) + '</td>' +
        '<td style="padding:6px;border:1px solid #ddd;">' + escapeHtml(f.message) + '</td>' +
        '</tr>';
    }
  }

  // Paper Tiger colors, inlined for email clients that ignore <style>.
  var C = {
    ink:      '#333333',
    heading:  '#121212',
    brand:    '#e77500',
    brandDk:  '#C1560E',
    brandLt:  '#FEECDE',
    brandBg:  '#FFF7F2',
    neutral5: '#f7f7f7',
    n10:      '#eeeeee',
    n60:      '#717171'
  };
  var fontDisplay = "'sofia-pro','Source Sans 3','Helvetica Neue',Arial,sans-serif";
  var fontBody    = "'abril-text','Source Serif 4',Georgia,'Times New Roman',serif";

  return [
    '<div style="font-family:' + fontBody + ';color:' + C.ink + ';max-width:720px;">',
      '<div style="background:' + C.heading + ';color:#fff;padding:20px 24px;">',
        '<h2 style="margin:0;font-family:' + fontDisplay + ';font-weight:700;font-size:26px;',
          'border-bottom:4px solid ' + C.brand + ';display:inline-block;padding-bottom:6px;">',
          'Drive Ownership Transfer',
        '</h2>',
        '<p style="margin:12px 0 0;font-family:' + fontBody + ';color:#eeeeee;font-size:14px;">',
          'Root folder <code style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#fff;">' + targetFolder + '</code>',
          ' → new owner <b style="color:#fff;">' + newOwner + '</b>.<br>',
          'Completed at ' + completedAt + '.',
        '</p>',
      '</div>',
      '<div style="padding:20px 24px;background:#fff;border:1px solid ' + C.n10 + ';border-top:none;">',
        '<table style="border-collapse:collapse;margin-bottom:20px;">',
          '<tr>',
            metricCell('Total',                summary.total,              C.neutral5, C.heading),
            metricCell('Success',              summary.success,            C.brandBg,  C.brandDk),
            metricCell('Failed',               summary.failed,             '#fff',     C.brand),
            metricCell('Skipped (Not Owned)',  summary.skippedNotOwned,    C.neutral5, C.n60),
            metricCell('Skipped (Deselected)', summary.skippedDeselected,  C.neutral5, C.n60),
          '</tr>',
        '</table>',
        '<h3 style="margin:16px 0 8px 0;font-family:' + fontDisplay + ';font-weight:700;',
          'color:' + C.heading + ';border-bottom:2px solid ' + C.heading + ';padding-bottom:4px;">',
          'Failure manifest',
        '</h3>',
        '<table style="border-collapse:collapse;min-width:100%;font-family:' + fontDisplay + ';font-size:14px;">',
          '<thead><tr>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">File</th>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">ID</th>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">Error</th>',
          '</tr></thead>',
          '<tbody>' + rows + '</tbody>',
        '</table>',
        '<p style="margin:20px 0 0;color:' + C.n60 + ';font-size:12px;font-family:' + fontDisplay + ';">',
          'Full audit log attached as CSV.',
        '</p>',
      '</div>',
      '<div style="border-top:5px solid ' + C.brand + ';background:' + C.heading + ';color:#fff;',
        'padding:12px 24px;font-family:' + fontDisplay + ';font-size:12px;">',
        'Themed to Paper Tiger — Princeton ORFE.',
      '</div>',
    '</div>'
  ].join('');
}

function metricCell(label, value, bg, fg) {
  var C_border = '#eeeeee';
  return (
    '<td style="padding:12px 16px;border:1px solid ' + C_border + ';background:' + bg + ';text-align:center;">' +
    '<div style="font-size:11px;color:#717171;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;">' +
      escapeHtml(label) +
    '</div>' +
    '<div style="font-size:24px;font-weight:700;color:' + (fg || '#121212') + ';margin-top:4px;">' +
      escapeHtml(String(value)) +
    '</div>' +
    '</td>'
  );
}

/** Serialize log rows into RFC-4180-ish CSV suitable for attachment. */
function logToCsv(log) {
  var headers = ['timestamp', 'status', 'name', 'id', 'path', 'message'];
  var rows = [headers.join(',')];
  for (var i = 0; i < log.length; i++) {
    var r = log[i];
    rows.push([
      csvField(r.timestamp || ''),
      csvField(r.status || ''),
      csvField(r.name || ''),
      csvField(r.id || ''),
      csvField(r.path || ''),
      csvField(r.message || '')
    ].join(','));
  }
  return rows.join('\n');
}

function csvField(v) {
  var s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Merge a child name into the running path (root is ''). */
function joinPath(parent, name) {
  if (!parent) return name;
  return parent + '/' + name;
}

// Node interop: expose to require() while remaining a valid GAS file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TIME_BUDGET_MS: TIME_BUDGET_MS,
    STATUS: STATUS,
    isTransferable: isTransferable,
    buildExecutionPlan: buildExecutionPlan,
    shouldCheckpoint: shouldCheckpoint,
    summarizeLog: summarizeLog,
    formatReportHtml: formatReportHtml,
    logToCsv: logToCsv,
    joinPath: joinPath,
    escapeHtml: escapeHtml
  };
}
