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

// Helper — builds a recursive-subtree node with the fields mergeSelection expects.
const tree = (id, name, isFolder, owner, children = []) => ({
  id, name, path: name, isFolder, owner, children
});

test('mergeSelection: within a subtree emits folder, then files, then recurses into subfolders (DFS pre-order)', () => {
  //  Root                    ← folder
  //  ├── a.txt               ← file (should come immediately after Root)
  //  ├── b.txt               ← file
  //  └── Sub                 ← subfolder (visited AFTER Root's own files)
  //      ├── c.txt           ← file
  //      └── Deep            ← nested folder
  //          └── d.txt
  const t = tree('root', 'Root', true, 'me@x.com', [
    { id: 'a', name: 'a.txt', path: 'Root/a.txt', isFolder: false, owner: 'me@x.com', children: [] },
    { id: 'b', name: 'b.txt', path: 'Root/b.txt', isFolder: false, owner: 'me@x.com', children: [] },
    { id: 'sub', name: 'Sub', path: 'Root/Sub', isFolder: true, owner: 'me@x.com', children: [
      { id: 'c', name: 'c.txt', path: 'Root/Sub/c.txt', isFolder: false, owner: 'me@x.com', children: [] },
      { id: 'deep', name: 'Deep', path: 'Root/Sub/Deep', isFolder: true, owner: 'me@x.com', children: [
        { id: 'd', name: 'd.txt', path: 'Root/Sub/Deep/d.txt', isFolder: false, owner: 'me@x.com', children: [] }
      ]}
    ]}
  ]);
  const { plan, preLogs } = L.mergeSelection({
    recursiveTrees: [t], explicitItems: [], activeUserEmail: 'me@x.com'
  });
  assert.deepEqual(plan.map(p => p.id), ['root', 'a', 'b', 'sub', 'c', 'deep', 'd']);
  assert.deepEqual(preLogs, []);
});

test('mergeSelection: non-owned items become SKIPPED_NOT_OWNED and never enter the plan', () => {
  const t = tree('root', 'Root', true, 'me@x.com', [
    { id: 'mine',  name: 'mine.txt',  path: 'Root/mine.txt',  isFolder: false, owner: 'me@x.com',        children: [] },
    { id: 'theirs', name: 'theirs.txt', path: 'Root/theirs.txt', isFolder: false, owner: 'someone@else.com', children: [] }
  ]);
  const { plan, preLogs } = L.mergeSelection({
    recursiveTrees: [t], explicitItems: [], activeUserEmail: 'me@x.com'
  });
  assert.deepEqual(plan.map(p => p.id), ['root', 'mine']);
  assert.equal(preLogs.length, 1);
  assert.equal(preLogs[0].id, 'theirs');
  assert.equal(preLogs[0].status, L.STATUS.SKIPPED_NOT_OWNED);
  assert.match(preLogs[0].message, /someone@else\.com/);
});

test('mergeSelection: non-owned intermediate folders are skipped but their owned descendants still transfer', () => {
  // Root(me) → Bob's folder → my file inside.  Rare but real edge case in Drive.
  const t = tree('root', 'Root', true, 'me@x.com', [
    { id: 'bob', name: 'BobFolder', path: 'Root/BobFolder', isFolder: true, owner: 'bob@x.com', children: [
      { id: 'insidebob', name: 'nested.txt', path: 'Root/BobFolder/nested.txt', isFolder: false, owner: 'me@x.com', children: [] }
    ]}
  ]);
  const { plan, preLogs } = L.mergeSelection({
    recursiveTrees: [t], explicitItems: [], activeUserEmail: 'me@x.com'
  });
  assert.deepEqual(plan.map(p => p.id), ['root', 'insidebob']);
  assert.deepEqual(preLogs.map(p => p.id), ['bob']);
});

test('mergeSelection: explicit items appended after recursive walks; duplicates deduped by id', () => {
  const t = tree('root', 'Root', true, 'me@x.com', [
    { id: 'a', name: 'a.txt', path: 'Root/a.txt', isFolder: false, owner: 'me@x.com', children: [] }
  ]);
  const explicit = [
    { id: 'a', name: 'a.txt', path: 'Root/a.txt', isFolder: false, owner: 'me@x.com' },  // dup of recursive walk
    { id: 'z', name: 'orphan.txt', path: 'orphan.txt', isFolder: false, owner: 'me@x.com' }  // net new
  ];
  const { plan } = L.mergeSelection({
    recursiveTrees: [t], explicitItems: explicit, activeUserEmail: 'me@x.com'
  });
  assert.deepEqual(plan.map(p => p.id), ['root', 'a', 'z']);
});

test('mergeSelection: same id in two recursive trees is deduped', () => {
  const shared = { id: 'shared', name: 'shared.txt', path: 'A/shared.txt', isFolder: false, owner: 'me@x.com', children: [] };
  const treeA = tree('A', 'A', true, 'me@x.com', [shared]);
  const treeB = tree('B', 'B', true, 'me@x.com', [shared]);
  const { plan } = L.mergeSelection({
    recursiveTrees: [treeA, treeB], explicitItems: [], activeUserEmail: 'me@x.com'
  });
  // 'shared' appears once even though it was walked under both A and B.
  assert.deepEqual(plan.filter(p => p.id === 'shared').length, 1);
  assert.deepEqual(plan.map(p => p.id), ['A', 'shared', 'B']);
});

test('mergeSelection: empty inputs → empty plan and empty preLogs', () => {
  const r = L.mergeSelection({ recursiveTrees: [], explicitItems: [], activeUserEmail: 'me@x.com' });
  assert.deepEqual(r, { plan: [], preLogs: [] });
});

test('mergeSelection: explicit-only selection (no recursive) produces the items in order', () => {
  const explicit = [
    { id: 'x', name: 'x.txt', path: 'x.txt', isFolder: false, owner: 'me@x.com' },
    { id: 'y', name: 'y.txt', path: 'y.txt', isFolder: false, owner: 'bob@x.com' },
    { id: 'z', name: 'z.txt', path: 'z.txt', isFolder: false, owner: 'me@x.com' }
  ];
  const { plan, preLogs } = L.mergeSelection({
    recursiveTrees: [], explicitItems: explicit, activeUserEmail: 'me@x.com'
  });
  assert.deepEqual(plan.map(p => p.id), ['x', 'z']);
  assert.deepEqual(preLogs.map(p => p.id), ['y']);
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
    { status: L.STATUS.SKIPPED_NOT_OWNED }
  ];
  const s = L.summarizeLog(log);
  assert.deepEqual(s, { total: 5, success: 2, failed: 1, skippedNotOwned: 2 });
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
