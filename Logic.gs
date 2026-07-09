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
  SKIPPED_NOT_OWNED: 'SKIPPED (NOT OWNED)'
};

/** True iff the active user currently owns the item and can therefore call setOwner. */
function isTransferable(currentOwnerEmail, activeUserEmail) {
  if (!currentOwnerEmail || !activeUserEmail) return false;
  return String(currentOwnerEmail).toLowerCase() === String(activeUserEmail).toLowerCase();
}

/**
 * mergeSelection — combine recursive-folder subtrees + individually-picked
 * items into a single ordered plan.
 *
 * Emission order within each recursive subtree is DFS pre-order with files
 * before subfolders:  folder → its files → recurse into subfolders. This
 * keeps state coherent across checkpoints — if a resume trigger fires mid
 * batch, the containing folder was already transferred before any of its
 * files, so a partial run does not leave files stranded under an old-owner
 * folder.
 *
 * Non-owned items become SKIPPED_NOT_OWNED preLogs and are NOT added to the
 * plan. The plan is the exact list runBatch_ will attempt to setOwner on.
 *
 * There is deliberately no "deselect" input. That is the whole point of the
 * new selection model: the server has no vocabulary for "skip a file inside
 * a selected folder," which is what enforces the hard "folder → everything
 * inside" invariant end-to-end.
 *
 * Duplicates (same id in multiple recursive trees, or in both recursive and
 * explicit) are deduped by id — the first occurrence wins.
 *
 * @param {Object} opts
 * @param {Array<Object>} opts.recursiveTrees  Fully-walked subtree nodes
 *        {id,name,path,isFolder,owner,children:[…]}.
 * @param {Array<Object>} opts.explicitItems   Flat items {id,name,path,isFolder,owner}.
 * @param {string}        opts.activeUserEmail For the ownership check.
 * @return {{plan: Array<Object>, preLogs: Array<Object>}}
 */
function mergeSelection(opts) {
  opts = opts || {};
  var recursiveTrees = opts.recursiveTrees || [];
  var explicitItems  = opts.explicitItems  || [];
  var activeUser     = opts.activeUserEmail;

  var plan = [];
  var preLogs = [];
  var seen = {};

  // moveToRoot marks items the SERVER-SIDE walk considers a "top of transfer" —
  // i.e., items the user picked directly. Only these should be re-parented to
  // the new owner's My Drive root; descendants inherit their (moved) parent
  // and setting moveToRoot on them too would flatten the whole subtree onto
  // the new owner's My Drive as siblings.
  function record(node, moveToRoot) {
    if (seen[node.id]) return;
    seen[node.id] = true;
    if (isTransferable(node.owner, activeUser)) {
      plan.push({
        id: node.id,
        name: node.name,
        path: node.path,
        isFolder: !!node.isFolder,
        owner: node.owner,
        moveToRoot: !!moveToRoot
      });
    } else {
      preLogs.push({
        id: node.id,
        name: node.name,
        path: node.path,
        status: STATUS.SKIPPED_NOT_OWNED,
        message: 'Owned by ' + (node.owner || 'unknown')
      });
    }
  }

  // depth === 0 means "this node was directly chosen by the user"; deeper nodes
  // were pulled in by the walk and inherit their parent's placement.
  function walk(node, depth) {
    record(node, depth === 0);
    if (!node.children || !node.children.length) return;
    var files = [];
    var subs  = [];
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.isFolder) subs.push(c);
      else files.push(c);
    }
    for (var f = 0; f < files.length; f++) record(files[f], false);
    for (var s = 0; s < subs.length;  s++) walk(subs[s], depth + 1);
  }

  for (var r = 0; r < recursiveTrees.length; r++) walk(recursiveTrees[r], 0);
  // Explicit items are always user-selected roots — they get moveToRoot=true.
  for (var e = 0; e < explicitItems.length;  e++) record(explicitItems[e], true);
  return { plan: plan, preLogs: preLogs };
}

/** Decide whether we should checkpoint and hand off to a resume trigger. */
function shouldCheckpoint(startedAtMs, nowMs, budgetMs) {
  var elapsed = nowMs - startedAtMs;
  return elapsed >= (budgetMs != null ? budgetMs : TIME_BUDGET_MS);
}

/** Aggregate a log array into dashboard counters. */
function summarizeLog(log) {
  var summary = { total: log.length, success: 0, failed: 0, skippedNotOwned: 0 };
  for (var i = 0; i < log.length; i++) {
    var s = log[i].status;
    if (s === STATUS.SUCCESS) summary.success++;
    else if (s === STATUS.FAILED) summary.failed++;
    else if (s === STATUS.SKIPPED_NOT_OWNED) summary.skippedNotOwned++;
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

/**
 * Build the HTML body of the dry-run report email. Same visual language as
 * the production-run report (formatReportHtml) but with a prominent DRY RUN
 * banner and two "would" tables (would-transfer, would-skip) instead of
 * success/failure. context = {targetFolderId, newOwnerEmail, summary, plan,
 * skip, completedAt}.
 */
function formatDryRunReportHtml(context) {
  var summary = context.summary || {};
  var plan = context.plan || [];
  var skip = context.skip || [];
  var targetFolder = escapeHtml(context.targetFolderId || '');
  var newOwner     = escapeHtml(context.newOwnerEmail  || '(not specified)');
  var completedAt  = escapeHtml(context.completedAt    || '');

  // Paper Tiger colors, inlined for email clients that ignore <style>.
  var C = {
    ink: '#333333', heading: '#121212', brand: '#e77500', brandDk: '#C1560E',
    brandLt: '#FEECDE', brandBg: '#FFF7F2',
    warn: '#c62828', warnBg: '#ffebee',
    neutral5: '#f7f7f7', n10: '#eeeeee', n60: '#717171'
  };
  var fontDisplay = "'sofia-pro','Source Sans 3','Helvetica Neue',Arial,sans-serif";
  var fontBody    = "'abril-text','Source Serif 4',Georgia,'Times New Roman',serif";

  function planRows(items) {
    if (items.length === 0) {
      return '<tr><td colspan="3" style="padding:8px;color:#666;">Nothing selected in this bucket.</td></tr>';
    }
    var rows = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      rows +=
        '<tr>' +
        '<td style="padding:6px;border:1px solid ' + C.n10 + ';">' + escapeHtml(it.isFolder ? 'folder' : 'file') + '</td>' +
        '<td style="padding:6px;border:1px solid ' + C.n10 + ';">' + escapeHtml(it.path || it.name) + '</td>' +
        '<td style="padding:6px;border:1px solid ' + C.n10 + ';font-family:monospace;font-size:12px;">' + escapeHtml(it.id) + '</td>' +
        '</tr>';
    }
    return rows;
  }

  function skipRows(items) {
    if (items.length === 0) {
      return '<tr><td colspan="3" style="padding:8px;color:#666;">No non-owned items in this selection.</td></tr>';
    }
    var rows = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      rows +=
        '<tr>' +
        '<td style="padding:6px;border:1px solid ' + C.n10 + ';">' + escapeHtml(it.path || it.name) + '</td>' +
        '<td style="padding:6px;border:1px solid ' + C.n10 + ';font-family:monospace;font-size:12px;">' + escapeHtml(it.id) + '</td>' +
        '<td style="padding:6px;border:1px solid ' + C.n10 + ';">' + escapeHtml(it.message || '') + '</td>' +
        '</tr>';
    }
    return rows;
  }

  var overCapBanner = '';
  if (summary.overCap) {
    overCapBanner =
      '<div style="background:' + C.warnBg + ';border-left:4px solid ' + C.warn + ';padding:12px 16px;margin-top:12px;">' +
        '<b style="color:' + C.warn + ';">Selection is over the ScriptProperties ceiling.</b> ' +
        'This plan (~' + Math.round((summary.stateBytes || 0) / 1024) + ' KB) exceeds ~' +
        Math.round((summary.capBytes || 0) / 1024) + ' KB. Committing as-is would fail — narrow the selection.' +
      '</div>';
  }

  return [
    '<div style="font-family:' + fontBody + ';color:' + C.ink + ';max-width:720px;">',

      '<div style="background:' + C.heading + ';color:#fff;padding:20px 24px;">',
        '<div style="display:inline-block;background:' + C.brand + ';color:#fff;font-family:' + fontDisplay + ';',
          'font-weight:700;padding:4px 10px;letter-spacing:0.08em;text-transform:uppercase;font-size:12px;',
          'margin-bottom:8px;">Dry Run — nothing was modified</div>',
        '<h2 style="margin:0;font-family:' + fontDisplay + ';font-weight:700;font-size:26px;',
          'border-bottom:4px solid ' + C.brand + ';display:inline-block;padding-bottom:6px;">',
          'Drive Ownership Transfer — Preview',
        '</h2>',
        '<p style="margin:12px 0 0;font-family:' + fontBody + ';color:#eeeeee;font-size:14px;">',
          'Root folder <code style="font-family:ui-monospace,Menlo,Consolas,monospace;color:#fff;">' + targetFolder + '</code>',
          ' → intended new owner <b style="color:#fff;">' + newOwner + '</b>.<br>',
          'Preview generated at ' + completedAt + '.',
        '</p>',
      '</div>',

      '<div style="padding:20px 24px;background:#fff;border:1px solid ' + C.n10 + ';border-top:none;">',
        overCapBanner,

        '<table style="border-collapse:collapse;margin:12px 0 20px;">',
          '<tr>',
            metricCell('Would transfer', summary.willTransfer || 0, C.brandBg,  C.brandDk),
            metricCell('Folders',        summary.folders      || 0, C.neutral5, C.heading),
            metricCell('Files',          summary.files        || 0, C.neutral5, C.heading),
            metricCell('Would skip',     summary.willSkip     || 0, C.neutral5, C.n60),
            metricCell('State size',     Math.round((summary.stateBytes || 0) / 1024) + ' KB',
                                         (summary.overCap ? C.warnBg : C.neutral5),
                                         (summary.overCap ? C.warn : C.heading)),
          '</tr>',
        '</table>',

        '<h3 style="margin:16px 0 8px 0;font-family:' + fontDisplay + ';font-weight:700;',
          'color:' + C.heading + ';border-bottom:2px solid ' + C.heading + ';padding-bottom:4px;">',
          'Would transfer (' + plan.length + ')',
        '</h3>',
        '<table style="border-collapse:collapse;min-width:100%;font-family:' + fontDisplay + ';font-size:14px;">',
          '<thead><tr>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">Kind</th>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">Path</th>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">ID</th>',
          '</tr></thead>',
          '<tbody>' + planRows(plan) + '</tbody>',
        '</table>',

        '<h3 style="margin:20px 0 8px 0;font-family:' + fontDisplay + ';font-weight:700;',
          'color:' + C.heading + ';border-bottom:2px solid ' + C.heading + ';padding-bottom:4px;">',
          'Would skip — not owned (' + skip.length + ')',
        '</h3>',
        '<table style="border-collapse:collapse;min-width:100%;font-family:' + fontDisplay + ';font-size:14px;">',
          '<thead><tr>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">Path</th>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">ID</th>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">Reason</th>',
          '</tr></thead>',
          '<tbody>' + skipRows(skip) + '</tbody>',
        '</table>',

        '<p style="margin:20px 0 0;color:' + C.n60 + ';font-size:12px;font-family:' + fontDisplay + ';">',
          'Full preview attached as CSV. This report was generated by the ',
          '<b>Preview transfer (dry run)</b> button — no Drive ownership was changed. ',
          'To execute this plan, return to the web app and click <b>Confirm &amp; Transfer Ownership</b>.',
        '</p>',
      '</div>',

      '<div style="border-top:5px solid ' + C.brand + ';background:' + C.heading + ';color:#fff;',
        'padding:12px 24px;font-family:' + fontDisplay + ';font-size:12px;">',
        'Themed to Paper Tiger — Princeton ORFE.',
      '</div>',

    '</div>'
  ].join('');
}

/** CSV audit of a dry-run: every planned item and every skipped item. */
function dryRunToCsv(plan, skip) {
  var headers = ['bucket', 'kind', 'name', 'id', 'path', 'owner_or_reason'];
  var rows = [headers.join(',')];
  var i, r;
  for (i = 0; i < plan.length; i++) {
    r = plan[i];
    rows.push([
      csvField('WOULD_TRANSFER'),
      csvField(r.isFolder ? 'folder' : 'file'),
      csvField(r.name || ''),
      csvField(r.id   || ''),
      csvField(r.path || ''),
      csvField(r.owner || '')
    ].join(','));
  }
  for (i = 0; i < skip.length; i++) {
    r = skip[i];
    rows.push([
      csvField(r.status || 'SKIPPED'),
      csvField(''),
      csvField(r.name || ''),
      csvField(r.id   || ''),
      csvField(r.path || ''),
      csvField(r.message || '')
    ].join(','));
  }
  return rows.join('\n');
}

/**
 * HTML body for the "you now own these" email that the script sends to the
 * new owner once a run completes successfully. Distinct from
 * formatReportHtml (which goes to the initiator with the full audit trail)
 * — this one is the out-of-band notification the initiator would otherwise
 * have to send by hand.
 *
 * Only items that landed at the new owner's My Drive root (moveToRoot=true
 * on the plan entry, preserved into the log entry by attemptTransfer_) are
 * enumerated in the "items to look for" table — those are what the new
 * owner will actually see when they open My Drive. Descendants pulled in
 * by a recursive walk live inside their parent folder and don't need
 * separate mention.
 */
function formatNewOwnerNotificationHtml(context) {
  var log = context.log || [];
  var initiator = escapeHtml(context.initiatorEmail || 'a colleague');
  var completedAt = escapeHtml(context.completedAt || '');

  var success = 0, folders = 0, files = 0;
  var rootItems = [];
  for (var i = 0; i < log.length; i++) {
    var e = log[i];
    if (e.status !== STATUS.SUCCESS) continue;
    success++;
    if (e.isFolder) folders++; else files++;
    if (e.moveToRoot) rootItems.push(e);
  }

  var LIST_CAP = 100;
  var shown = rootItems.slice(0, LIST_CAP);
  var overflow = rootItems.length > LIST_CAP;

  var C = {
    ink: '#333333', heading: '#121212', brand: '#e77500', brandDk: '#C1560E',
    brandBg: '#FFF7F2', neutral5: '#f7f7f7', n10: '#eeeeee', n60: '#717171'
  };
  var fontDisplay = "'sofia-pro','Source Sans 3','Helvetica Neue',Arial,sans-serif";
  var fontBody    = "'abril-text','Source Serif 4',Georgia,'Times New Roman',serif";

  function itemRow(it) {
    var isFolder = !!it.isFolder;
    var link = 'https://drive.google.com/open?id=' + encodeURIComponent(it.id);
    return (
      '<tr>' +
        '<td style="padding:6px 10px;border:1px solid ' + C.n10 + ';">' + escapeHtml(isFolder ? 'Folder' : 'File') + '</td>' +
        '<td style="padding:6px 10px;border:1px solid ' + C.n10 + ';">' + escapeHtml(it.name || '') + '</td>' +
        '<td style="padding:6px 10px;border:1px solid ' + C.n10 + ';">' +
          '<a href="' + escapeHtml(link) + '" style="color:' + C.brandDk + ';text-decoration:underline;">Open in Drive</a>' +
        '</td>' +
      '</tr>'
    );
  }

  var rows;
  if (shown.length === 0) {
    rows = '<tr><td colspan="3" style="padding:8px;color:#666;">' +
      'No new items landed at your My Drive root. Ownership transferred, but the transferred items were nested inside folders you already owned — they are wherever they were before, just with you as the owner now.' +
      '</td></tr>';
  } else {
    var acc = '';
    for (var j = 0; j < shown.length; j++) acc += itemRow(shown[j]);
    rows = acc;
  }

  var overflowLine = overflow
    ? '<p style="margin:12px 0 0;color:' + C.n60 + ';font-size:13px;font-family:' + fontDisplay + ';">' +
        '… and ' + (rootItems.length - LIST_CAP) + ' more items at your My Drive root.' +
      '</p>'
    : '';

  return [
    '<div style="font-family:' + fontBody + ';color:' + C.ink + ';max-width:720px;">',

      '<div style="background:' + C.heading + ';color:#fff;padding:20px 24px;">',
        '<h2 style="margin:0;font-family:' + fontDisplay + ';font-weight:700;font-size:26px;',
          'border-bottom:4px solid ' + C.brand + ';display:inline-block;padding-bottom:6px;">',
          'You now own ' + success + ' item' + (success === 1 ? '' : 's'),
        '</h2>',
        '<p style="margin:12px 0 0;font-family:' + fontBody + ';color:#eeeeee;font-size:14px;">',
          '<b style="color:#fff;">' + initiator + '</b> transferred ownership of ',
          success + ' file' + (success === 1 ? '' : 's') + '/folder' + (success === 1 ? '' : 's') + ' to you.<br>',
          'Completed at ' + completedAt + '.',
        '</p>',
      '</div>',

      '<div style="padding:20px 24px;background:#fff;border:1px solid ' + C.n10 + ';border-top:none;">',
        '<table style="border-collapse:collapse;margin:0 0 20px;">',
          '<tr>',
            metricCell('Total transferred', success, C.brandBg,  C.brandDk),
            metricCell('Folders',           folders, C.neutral5, C.heading),
            metricCell('Files',             files,   C.neutral5, C.heading),
            metricCell('At your My Drive root', rootItems.length, C.neutral5, C.heading),
          '</tr>',
        '</table>',

        '<h3 style="margin:0 0 8px 0;font-family:' + fontDisplay + ';font-weight:700;',
          'color:' + C.heading + ';border-bottom:2px solid ' + C.heading + ';padding-bottom:4px;">',
          'Items at the root of your My Drive',
        '</h3>',
        '<p style="margin:0 0 12px 0;font-family:' + fontDisplay + ';font-size:14px;color:' + C.n60 + ';">',
          'These are the top-level items transferred to you. Descendants (files inside a transferred folder) are still inside their folder and were not moved separately.',
        '</p>',
        '<table style="border-collapse:collapse;min-width:100%;font-family:' + fontDisplay + ';font-size:14px;">',
          '<thead><tr>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">Kind</th>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">Name</th>',
            '<th style="padding:8px;border-bottom:2px solid ' + C.brand + ';background:' + C.neutral5 + ';text-align:left;">Link</th>',
          '</tr></thead>',
          '<tbody>' + rows + '</tbody>',
        '</table>',
        overflowLine,

        '<p style="margin:24px 0 0;font-family:' + fontDisplay + ';font-size:13px;color:' + C.n60 + ';">',
          'If you have questions about these transfers, contact ' +
          '<a href="mailto:' + initiator + '" style="color:' + C.brandDk + ';">' + initiator + '</a>.',
        '</p>',
      '</div>',

      '<div style="border-top:5px solid ' + C.brand + ';background:' + C.heading + ';color:#fff;',
        'padding:12px 24px;font-family:' + fontDisplay + ';font-size:12px;">',
        'Themed to Paper Tiger — Princeton ORFE.',
      '</div>',

    '</div>'
  ].join('');
}

/** Serialize log rows into RFC-4180-ish CSV suitable for attachment. */
function logToCsv(log) {
  var headers = ['timestamp', 'status', 'name', 'id', 'path', 'url', 'message'];
  var rows = [headers.join(',')];
  for (var i = 0; i < log.length; i++) {
    var r = log[i];
    var url = r.id ? ('https://drive.google.com/open?id=' + encodeURIComponent(r.id)) : '';
    rows.push([
      csvField(r.timestamp || ''),
      csvField(r.status || ''),
      csvField(r.name || ''),
      csvField(r.id || ''),
      csvField(r.path || ''),
      csvField(url),
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

/**
 * Detect the specific Drive REST error that means "the ownership transfer
 * actually happened, but Drive could not deliver the notification email
 * for this item." This shows up when the same new owner has received a
 * lot of notifications in a short window — Drive throttles the mailer,
 * returns HTTP 400, but the permission is already written.
 *
 * We treat this as a SUCCESS in the report so the audit trail matches
 * what actually happened in Drive; the message column carries a note so
 * a human reader can still see which items had the notification skipped.
 *
 * Observed wording (2026-07):
 *   "Sorry, the items were successfully shared but emails could not be
 *    sent to <address>."
 */
function isDriveNotificationOnlyFailure(driveMessage) {
  if (!driveMessage) return false;
  var s = String(driveMessage).toLowerCase();
  return s.indexOf('successfully shared') !== -1 &&
         s.indexOf('emails could not be sent') !== -1;
}

/**
 * Remove any job whose status is 'done'. In the current deployment 'done'
 * jobs are pruned immediately by finalizeAndReport_, so this helper is a
 * defensive safeguard against a bug or a hand-edited registry — it should
 * always be a no-op in production.
 */
function pruneJobsRegistry(registry) {
  if (!registry || !registry.length) return [];
  var out = [];
  for (var i = 0; i < registry.length; i++) {
    if (registry[i] && registry[i].status !== 'done') out.push(registry[i]);
  }
  return out;
}

/**
 * Pick the job that runBatch_ should service next.
 *
 * Priority:
 *   1. The single job with status === 'running' (the current in-flight one).
 *   2. Otherwise the oldest 'queued' job by startedAt (ISO strings sort correctly).
 *   3. Otherwise a 'report_pending' job whose mail send needs retrying.
 *   4. Otherwise null.
 *
 * Serialization is enforced by never promoting a queued job to running while
 * another is still in-flight — that is the caller's job (runBatch_ inside
 * the lock).
 */
function pickNextJob(registry) {
  if (!registry || !registry.length) return null;
  var running = null;
  var oldestQueued = null;
  var oldestReportPending = null;
  for (var i = 0; i < registry.length; i++) {
    var j = registry[i];
    if (!j) continue;
    if (j.status === 'running') return j; // there is only ever one
    if (j.status === 'queued') {
      if (!oldestQueued || String(j.startedAt) < String(oldestQueued.startedAt)) {
        oldestQueued = j;
      }
    } else if (j.status === 'report_pending') {
      if (!oldestReportPending || String(j.startedAt) < String(oldestReportPending.startedAt)) {
        oldestReportPending = j;
      }
    }
  }
  return running || oldestQueued || oldestReportPending || null;
}

// Node interop: expose to require() while remaining a valid GAS file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TIME_BUDGET_MS: TIME_BUDGET_MS,
    STATUS: STATUS,
    isTransferable: isTransferable,
    mergeSelection: mergeSelection,
    shouldCheckpoint: shouldCheckpoint,
    summarizeLog: summarizeLog,
    formatReportHtml: formatReportHtml,
    formatDryRunReportHtml: formatDryRunReportHtml,
    formatNewOwnerNotificationHtml: formatNewOwnerNotificationHtml,
    dryRunToCsv: dryRunToCsv,
    logToCsv: logToCsv,
    joinPath: joinPath,
    escapeHtml: escapeHtml,
    pruneJobsRegistry: pruneJobsRegistry,
    pickNextJob: pickNextJob,
    isDriveNotificationOnlyFailure: isDriveNotificationOnlyFailure
  };
}
