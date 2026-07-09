const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./load-logic');

test('isTransferable is case-insensitive equality', () => {
  assert.equal(L.isTransferable('me@X.com', 'ME@x.com'), true);
  assert.equal(L.isTransferable('me@x.com', 'other@x.com'), false);
  assert.equal(L.isTransferable('', 'me@x.com'), false);
  assert.equal(L.isTransferable('me@x.com', ''), false);
});

test('joinPath composes and treats empty root as bare name', () => {
  assert.equal(L.joinPath('', 'root'), 'root');
  assert.equal(L.joinPath('root', 'child'), 'root/child');
  assert.equal(L.joinPath('root/child', 'leaf.txt'), 'root/child/leaf.txt');
});

test('escapeHtml handles all sensitive characters', () => {
  const out = L.escapeHtml('<a href="x&y">\'ok\'</a>');
  assert.equal(out, '&lt;a href=&quot;x&amp;y&quot;&gt;&#39;ok&#39;&lt;/a&gt;');
  assert.equal(L.escapeHtml(null), '');
  assert.equal(L.escapeHtml(undefined), '');
});

test('buildExecutionPlan orders folders before files and records skip reasons', () => {
  const activeUser = 'me@x.com';
  const tree = {
    id: 'root', name: 'Root', path: 'Root', isFolder: true, owner: 'me@x.com', mimeType: 'folder',
    children: [
      { id: 'f1', name: 'a.txt', path: 'Root/a.txt', isFolder: false, owner: 'me@x.com', children: [] },
      { id: 'sub', name: 'Sub', path: 'Root/Sub', isFolder: true, owner: 'me@x.com', children: [
        { id: 'f2', name: 'b.txt', path: 'Root/Sub/b.txt', isFolder: false, owner: 'someone@else.com', children: [] },
        { id: 'f3', name: 'c.txt', path: 'Root/Sub/c.txt', isFolder: false, owner: 'me@x.com', children: [] }
      ]}
    ]
  };
  const selected = { root: true, f1: true, sub: true, f3: true }; // f2 not owned; also not selected
  const { plan, preLogs } = L.buildExecutionPlan(tree, selected, activeUser);

  const folderIds = plan.filter(p => p.isFolder).map(p => p.id);
  const fileIds   = plan.filter(p => !p.isFolder).map(p => p.id);
  assert.deepEqual(folderIds, ['root', 'sub']);
  assert.deepEqual(fileIds.sort(), ['f1', 'f3']);
  const skipReasons = preLogs.map(p => p.status);
  assert.deepEqual(skipReasons, [L.STATUS.SKIPPED_NOT_OWNED]);
  assert.match(preLogs[0].message, /someone@else\.com/);
});

test('buildExecutionPlan flags deselected transferables as SKIPPED_DESELECTED', () => {
  const tree = {
    id: 'root', name: 'Root', path: 'Root', isFolder: true, owner: 'me@x.com', children: [
      { id: 'f1', name: 'a.txt', path: 'Root/a.txt', isFolder: false, owner: 'me@x.com', children: [] }
    ]
  };
  const { plan, preLogs } = L.buildExecutionPlan(tree, { root: true }, 'me@x.com');
  assert.equal(plan.length, 1);            // root only
  assert.equal(plan[0].id, 'root');
  assert.equal(preLogs.length, 1);
  assert.equal(preLogs[0].status, L.STATUS.SKIPPED_DESELECTED);
  assert.equal(preLogs[0].id, 'f1');
});

test('shouldCheckpoint triggers only past the budget', () => {
  const start = 1_000_000;
  assert.equal(L.shouldCheckpoint(start, start + 60_000, 300_000), false);
  assert.equal(L.shouldCheckpoint(start, start + 299_999, 300_000), false);
  assert.equal(L.shouldCheckpoint(start, start + 300_000, 300_000), true);
});

test('summarizeLog counts each status bucket', () => {
  const log = [
    { status: L.STATUS.SUCCESS },
    { status: L.STATUS.SUCCESS },
    { status: L.STATUS.FAILED },
    { status: L.STATUS.SKIPPED_NOT_OWNED },
    { status: L.STATUS.SKIPPED_DESELECTED },
    { status: L.STATUS.SKIPPED_DESELECTED }
  ];
  const s = L.summarizeLog(log);
  assert.deepEqual(s, { total: 6, success: 2, failed: 1, skippedNotOwned: 1, skippedDeselected: 2 });
});

test('formatReportHtml embeds metrics and failure rows, escapes hostile input', () => {
  const html = L.formatReportHtml({
    targetFolderId: 'FOLDER<X>',
    newOwnerEmail: 'a@b.c',
    completedAt: '2026-07-09T00:00:00Z',
    log: [
      { status: L.STATUS.SUCCESS, name: 'ok.txt', id: 'id1', message: '' },
      { status: L.STATUS.FAILED,  name: '<script>bad</script>', id: 'id2', message: 'Permission denied' }
    ]
  });
  assert.match(html, /Drive Ownership Transfer/);
  assert.match(html, /FOLDER&lt;X&gt;/);
  assert.match(html, /a@b\.c/);
  assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(html, /Permission denied/);
  assert.doesNotMatch(html, /<script>bad<\/script>/);
});

test('formatReportHtml handles zero failures cleanly', () => {
  const html = L.formatReportHtml({
    targetFolderId: 'x', newOwnerEmail: 'a@b.c', completedAt: 't',
    log: [{ status: L.STATUS.SUCCESS, name: 'ok', id: 'i', message: '' }]
  });
  assert.match(html, /No failures recorded/);
});

test('logToCsv escapes commas, quotes and newlines and includes header row', () => {
  const csv = L.logToCsv([
    { timestamp: '2026-01-01T00:00:00Z', status: 'SUCCESS', name: 'ok, file', id: 'id1', path: 'r/ok, file', message: '' },
    { timestamp: '2026-01-01T00:00:01Z', status: 'FAILED',  name: 'bad "x"',   id: 'id2', path: 'r/bad',      message: 'line1\nline2' }
  ]);
  // First line is always the header.
  assert.ok(csv.startsWith('timestamp,status,name,id,path,message\n'));
  assert.match(csv, /"ok, file"/);           // comma escaping
  assert.match(csv, /"r\/ok, file"/);        // comma escaping in path
  assert.match(csv, /"bad ""x"""/);          // quote doubling
  assert.match(csv, /"line1\nline2"/);       // literal newline preserved inside quoted field
});

test('logToCsv handles empty log', () => {
  const csv = L.logToCsv([]);
  assert.equal(csv, 'timestamp,status,name,id,path,message');
});
