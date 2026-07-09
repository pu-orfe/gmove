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

test('mergeSelection: moveToRoot is true for user-picked roots only, false for descendants', () => {
  // The user recursively selected Root/. That means Root itself is a "root of transfer"
  // (moveToRoot: true). Every descendant is pulled in by the walk and must inherit its
  // parent — moveToRoot: false — otherwise it would get flattened onto the new owner's
  // My Drive root as a sibling of Root, exploding the folder structure.
  const t = tree('root', 'Root', true, 'me@x.com', [
    { id: 'a', name: 'a.txt', path: 'Root/a.txt', isFolder: false, owner: 'me@x.com', children: [] },
    { id: 'sub', name: 'Sub', path: 'Root/Sub', isFolder: true, owner: 'me@x.com', children: [
      { id: 'b', name: 'b.txt', path: 'Root/Sub/b.txt', isFolder: false, owner: 'me@x.com', children: [] }
    ]}
  ]);
  const explicit = [
    { id: 'z', name: 'orphan.txt', path: 'orphan.txt', isFolder: false, owner: 'me@x.com' }
  ];
  const { plan } = L.mergeSelection({
    recursiveTrees: [t], explicitItems: explicit, activeUserEmail: 'me@x.com'
  });
  const byId = Object.fromEntries(plan.map(p => [p.id, p]));
  assert.equal(byId.root.moveToRoot, true,   'user-picked recursive root moves to new owner root');
  assert.equal(byId.a.moveToRoot,    false,  'file inside a recursive root stays inside it');
  assert.equal(byId.sub.moveToRoot,  false,  'subfolder of a recursive root stays inside it');
  assert.equal(byId.b.moveToRoot,    false,  'file two levels down stays inside its parent');
  assert.equal(byId.z.moveToRoot,    true,   'explicit item is a root by definition');
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

test('formatDryRunReportHtml renders DRY RUN banner, both tables, escapes hostile input', () => {
  const html = L.formatDryRunReportHtml({
    targetFolderId: 'FOLDER<X>',
    newOwnerEmail: 'a@b.c',
    completedAt: '2026-07-09T00:00:00Z',
    summary: { willTransfer: 2, willSkip: 1, folders: 1, files: 1, stateBytes: 1024, overCap: false, capBytes: 400000 },
    plan: [
      { id: 'idA', name: 'A/', path: 'root/A/', isFolder: true,  owner: 'me@x.com' },
      { id: 'idB', name: 'b.txt', path: 'root/A/<b>.txt', isFolder: false, owner: 'me@x.com' }
    ],
    skip: [
      { id: 'idC', name: 'c.txt', path: 'root/A/c.txt', status: L.STATUS.SKIPPED_NOT_OWNED, message: 'Owned by <hacker>@x.com' }
    ]
  });
  assert.match(html, /Dry Run — nothing was modified/);
  assert.match(html, /Would transfer \(2\)/);
  assert.match(html, /Would skip — not owned \(1\)/);
  assert.match(html, /FOLDER&lt;X&gt;/);
  assert.match(html, /root\/A\/&lt;b&gt;\.txt/);
  assert.match(html, /Owned by &lt;hacker&gt;@x\.com/);
  assert.doesNotMatch(html, /<hacker>/);
});

test('formatDryRunReportHtml surfaces over-cap warning when plan exceeds ScriptProperties ceiling', () => {
  const html = L.formatDryRunReportHtml({
    targetFolderId: 'x', newOwnerEmail: 'a@b.c', completedAt: 't',
    summary: { willTransfer: 5000, willSkip: 0, folders: 100, files: 4900, stateBytes: 900000, overCap: true, capBytes: 400000 },
    plan: [], skip: []
  });
  assert.match(html, /over the ScriptProperties ceiling/i);
  assert.match(html, /~879 KB/);   // 900000/1024 = 878.9 → rounds to 879
  assert.match(html, /~391 KB/);   // 400000/1024 = 390.6 → rounds to 391
});

test('dryRunToCsv emits WOULD_TRANSFER and SKIPPED buckets with headers, escapes commas', () => {
  const csv = L.dryRunToCsv(
    [{ id: 'i1', name: 'ok, file', path: 'r/ok, file', isFolder: false, owner: 'me@x.com' }],
    [{ id: 'i2', name: 'skip', path: 'r/skip', status: L.STATUS.SKIPPED_NOT_OWNED, message: 'Owned by bob' }]
  );
  const lines = csv.split('\n');
  assert.equal(lines[0], 'bucket,kind,name,id,path,owner_or_reason');
  assert.match(lines[1], /^WOULD_TRANSFER,file,"ok, file",i1,"r\/ok, file",me@x\.com$/);
  assert.match(lines[2], /^SKIPPED \(NOT OWNED\),,skip,i2,r\/skip,Owned by bob$/);
});

test('dryRunToCsv handles empty inputs', () => {
  const csv = L.dryRunToCsv([], []);
  assert.equal(csv, 'bucket,kind,name,id,path,owner_or_reason');
});

test('pruneJobsRegistry drops done entries, keeps everything else', () => {
  assert.deepEqual(L.pruneJobsRegistry([]), []);
  assert.deepEqual(L.pruneJobsRegistry(null), []);
  assert.deepEqual(
    L.pruneJobsRegistry([
      { jobId: 'a', status: 'running' },
      { jobId: 'b', status: 'done' },
      { jobId: 'c', status: 'queued' },
      { jobId: 'd', status: 'report_pending' }
    ]).map(j => j.jobId),
    ['a', 'c', 'd']
  );
});

test('pickNextJob returns null for an empty registry', () => {
  assert.equal(L.pickNextJob([]), null);
  assert.equal(L.pickNextJob(null), null);
});

test('pickNextJob prefers the running job when one exists', () => {
  const running = { jobId: 'a', status: 'running', startedAt: '2026-01-02T00:00:00Z' };
  const queued  = { jobId: 'b', status: 'queued',  startedAt: '2026-01-01T00:00:00Z' };
  assert.equal(L.pickNextJob([queued, running]).jobId, 'a');
});

test('pickNextJob returns oldest queued when no job is running', () => {
  const newer = { jobId: 'a', status: 'queued', startedAt: '2026-01-02T00:00:00Z' };
  const older = { jobId: 'b', status: 'queued', startedAt: '2026-01-01T00:00:00Z' };
  assert.equal(L.pickNextJob([newer, older]).jobId, 'b');
});

test('pickNextJob falls back to report_pending only when no queued/running exists', () => {
  const rp     = { jobId: 'a', status: 'report_pending', startedAt: '2026-01-01T00:00:00Z' };
  const queued = { jobId: 'b', status: 'queued',         startedAt: '2026-01-02T00:00:00Z' };
  // Queued outranks report_pending — mail retries are lowest priority.
  assert.equal(L.pickNextJob([rp, queued]).jobId, 'b');
  // Alone, report_pending wins.
  assert.equal(L.pickNextJob([rp]).jobId, 'a');
});
