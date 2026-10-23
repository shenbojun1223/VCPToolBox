'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { ProjectStore, sha256 } = require('../../Plugin/ServerProjectForge/store');
const {
    exportProjectBundle, validateProjectBundle, importProjectBundle,
} = require('../../Plugin/ServerProjectForge/projectBundle');
const code = expected => error => error.code === expected;
const encode = data => Buffer.from(JSON.stringify(data), 'utf8');
const manifest = bundle => JSON.parse(bundle.bytes.toString('utf8'));
const bytesA = Buffer.from('\uFEFF中文 before\r\n');
const bytesB = Buffer.from('\uFEFF中文 after\r\n');
const binary = Buffer.from([0, 1, 2, 255]);

function databaseSnapshot(store) {
    const tables = ['meta', 'projects', 'todos', 'batches', 'nodes', 'captures',
        'capture_files', 'file_state', 'blobs', 'sqlite_sequence'];
    return Object.fromEntries(tables.map(table => [
        table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]));
}

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-bundle-'));
    const source = new ProjectStore(path.join(dir, 'source.db'));
    const target = new ProjectStore(path.join(dir, 'target.db'));
    t.after(() => {
        source.close(); target.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const root = path.join(dir, 'source');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const project = source.createProject({
        name: '中文工程', workspaceId: 'old-ws', workspaceAlias: 'old',
        root, createdBy: 'Kerr',
    });
    source.addTodos(project.id, ['修复实现', '验收'], 'Kerr');
    const todo = source.listTodos(project.id)[0];
    source.updateTodo(project.id, 1, { status: 'done', note: '独立验收', updatedBy: 'Reviewer' });
    const record = (file, before, after, op = 'edit', batchId = null) => {
        const batch = batchId ?? source.createBatch(project.id, op, '施工原因', 'Worker');
        return source.addNode({
            projectId: project.id, batchId: batch, filePath: file,
            op, beforeHash: source.putBlob(before), afterHash: source.putBlob(after),
            todoId: todo.id, reason: '节点原因', summary: '历史摘要', added: 1, removed: 1,
        });
    };
    record('src/a.txt', null, bytesA, 'create');
    record('deleted.txt', null, Buffer.from('deleted'), 'create');
    record('deleted.txt', Buffer.from('deleted'), null, 'remove');
    record('binary.bin', null, binary, 'create');
    const capture = source.createCapture({
        projectId: project.id, requestId: 'worker-1', root,
        reason: '外部施工', maid: 'PI-Worker', todoId: todo.id,
        files: [{ path: 'src/a.txt', buffer: bytesA }],
    });
    const externalBatch = source.createBatch(project.id, 'external', '外部施工', 'PI-Worker');
    record('src/a.txt', bytesA, bytesB, 'external', externalBatch);
    source.finishCapture(project.id, capture.id, externalBatch);
    fs.writeFileSync(path.join(root, 'src/a.txt'), bytesB);
    fs.writeFileSync(path.join(root, 'binary.bin'), binary);
    fs.writeFileSync(path.join(root, 'unseen.txt'), 'capture-only');
    const noChange = source.createCapture({
        projectId: project.id, requestId: 'no-change', root, reason: '无改动收录',
        files: [{ path: 'unseen.txt', buffer: Buffer.from('capture-only') },
            { path: 'missing.txt', buffer: null }],
    });
    source.finishCapture(project.id, noChange.id, null);
    source.updateProject(project.id, { report: '原工程验收报告；n1 是来源库编号。', status: 'accepted', reportBy: 'Reviewer' });
    const foreign = source.createProject({ name: '不属于导出范围', root: path.join(dir, 'foreign') });
    source.addNode({
        projectId: foreign.id, filePath: 'foreign.txt', op: 'create',
        beforeHash: null, afterHash: source.putBlob(Buffer.from('FOREIGN-SYNTHETIC-CONTENT')),
    });
    // Occupy destination IDs and seed one shared blob before importing.
    const noise = target.createProject({
        name: '目标旧工程', root: path.join(dir, 'existing'), workspaceAlias: 'target',
    });
    for (let i = 0; i < 12; i++) {
        const ids = target.addTodos(noise.id, ['occupied-' + i]);
        const batch = target.createBatch(noise.id, 'create', '占号', 'Other');
        target.addNode({
            projectId: noise.id, batchId: batch, filePath: `noise-${i}.txt`,
            op: 'create', beforeHash: null, afterHash: target.putBlob(bytesA), todoId: ids[0],
        });
    }
    const destination = (name = 'copy') => ({
        root: path.join(dir, name), workspaceId: 'target-ws', workspaceAlias: 'target', subpath: name,
    });
    const exported = () => exportProjectBundle(source, project.id);
    return { dir, root, source, target, project, todo, capture, noChange, noise,
        externalBatch, record, destination, exported };
}

test('export is deterministic, scoped and read-only; all referenced snapshots included', t => {
    const f = fixture(t);
    const before = databaseSnapshot(f.source);
    const bundle = f.exported();
    assert.deepEqual(f.exported(), bundle);
    assert.deepEqual(databaseSnapshot(f.source), before);
    const data = manifest(bundle);
    assert.equal(validateProjectBundle(bundle.bytes, { expectedHash: bundle.sha256 }).nodes, 5);
    assert.equal(data.project.name, '中文工程');
    assert.ok(!Object.hasOwn(data.project, 'root'));
    assert.ok(!Object.hasOwn(data.project, 'workspace_id'));
    assert.ok(!bundle.bytes.includes(Buffer.from('FOREIGN-SYNTHETIC-CONTENT')));
    assert.ok(!data.blobs.some(blob => blob.hash === sha256(Buffer.from('FOREIGN-SYNTHETIC-CONTENT'))));
    assert.ok(data.files.some(file => file.file_path === 'unseen.txt' && file.hash === sha256(Buffer.from('capture-only'))));
    assert.ok(data.files.some(file => file.file_path === 'missing.txt' && file.hash === null));
    assert.equal(data.captures.length, 2);
});

test('transaction import remaps all local IDs, preserves bytes/history/report and writes no worktree', t => {
    const f = fixture(t);
    const bundle = f.exported();
    const oldProject = f.target.getProject(f.noise.id);
    const oldNodes = f.target.db.prepare('SELECT * FROM nodes WHERE project_id=? ORDER BY id').all(f.noise.id);
    const imported = importProjectBundle(f.target, bundle.bytes, f.destination(), { expectedHash: bundle.sha256 });
    assert.equal(imported.requiresMaterialization, true);
    assert.equal(fs.existsSync(f.destination().root), false);
    assert.equal(imported.sourceProjectId, f.project.id);
    assert.deepEqual(f.target.getProject(f.noise.id), oldProject);
    assert.deepEqual(f.target.db.prepare('SELECT * FROM nodes WHERE project_id=? ORDER BY id').all(f.noise.id), oldNodes);
    const copied = f.target.getProject(imported.projectId);
    assert.equal(copied.workspace_id, 'target-ws');
    assert.equal(copied.root, f.destination().root);
    assert.equal(copied.report, f.source.getProject(f.project.id).report);
    assert.equal(copied.report_by, 'Reviewer');
    assert.equal(copied.status, 'accepted'); // Historical status, NOT a new local acceptance.
    const todo = f.target.listTodos(imported.projectId)[0];
    assert.notEqual(todo.id, f.todo.id);
    assert.equal(todo.note, '独立验收');
    const nodes = f.target.db.prepare('SELECT * FROM nodes WHERE project_id=? ORDER BY id').all(imported.projectId);
    assert.equal(nodes.length, 5);
    assert.ok(nodes.every(node => node.todo_id === todo.id));
    assert.ok(nodes.every(node => f.target.getBatch(imported.projectId, node.batch_id)));
    for (const row of manifest(bundle).nodes) {
        assert.equal(f.target.getNode(imported.projectId, imported.idMap.nodes[row.id]).file_path, row.file_path);
    }
    const capture = f.target.captureByRequest(imported.projectId, 'worker-1');
    assert.notEqual(capture.id, f.capture.id);
    assert.equal(capture.root, f.destination().root);
    assert.equal(capture.todo_id, todo.id);
    assert.equal(capture.baseline_node, imported.idMap.nodes[f.capture.baseline_node]);
    assert.equal(capture.batch_id, imported.idMap.batches[f.externalBatch]);
    assert.deepEqual(f.target.getBlob(capture.files[0].before_hash), bytesA);
    assert.deepEqual(f.target.getBlob(f.target.getFileState(imported.projectId, 'src/a.txt')), bytesB);
    assert.deepEqual(f.target.getBlob(f.target.getFileState(imported.projectId, 'binary.bin')), binary);
    assert.equal(f.target.getFileState(imported.projectId, 'deleted.txt'), null);
    assert.equal(f.target.getCapture(imported.projectId, imported.idMap.captures[f.noChange.id]).batch_id, null);
    f.target.gcBlobs();
    assert.deepEqual(f.target.getBlob(sha256(Buffer.from('capture-only'))), Buffer.from('capture-only'));
});

test('roundtrip after explicit test-only materialization preserves logical project', t => {
    const f = fixture(t);
    const bundle = f.exported();
    const data = manifest(bundle);
    const copied = importProjectBundle(f.target, bundle.bytes, f.destination());
    // The library never does this: only the isolated test fixture creates its worktree.
    fs.mkdirSync(f.destination().root);
    for (const file of data.files) {
        if (file.hash === null) continue;
        const absolute = path.join(f.destination().root, file.file_path);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, f.target.getBlob(file.hash));
    }
    const next = exportProjectBundle(f.target, copied.projectId);
    const roundtrip = manifest(next);
    assert.deepEqual(roundtrip.files, data.files);
    assert.deepEqual(roundtrip.blobs, data.blobs);
    assert.equal(roundtrip.project.report, data.project.report);
    assert.equal(roundtrip.nodes.length, data.nodes.length);
    assert.equal(roundtrip.captures.length, data.captures.length);
});

test('snapshot-only capture with baseline zero survives import', t => {
    const f = fixture(t);
    const root = path.join(f.dir, 'only-capture');
    fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'a.txt'), '');
    const project = f.source.createProject({ name: 'empty-history', root });
    const capture = f.source.createCapture({
        projectId: project.id, requestId: 'zero', root, reason: 'unchanged',
        files: [{ path: 'a.txt', buffer: Buffer.alloc(0) }],
    });
    f.source.finishCapture(project.id, capture.id);
    const bundle = exportProjectBundle(f.source, project.id);
    const imported = importProjectBundle(f.target, bundle.bytes, f.destination());
    assert.equal(f.target.captureByRequest(imported.projectId, 'zero').baseline_node, 0);
    assert.deepEqual(f.target.getBlob(f.target.getFileState(imported.projectId, 'a.txt')), Buffer.alloc(0));
});

test('latest no-change capture determines otherwise unseen current file state', t => {
    const f = fixture(t);
    for (const [index, value] of ['first', 'second'].entries()) {
        const capture = f.source.createCapture({
            projectId: f.project.id, requestId: `loose-${index}`, root: f.root, reason: 'unchanged',
            files: [{ path: 'loose.txt', buffer: Buffer.from(value) }],
        });
        // Explicit timestamps make the test independent of clock resolution.
        f.source.db.prepare('UPDATE captures SET created_at=? WHERE id=?')
            .run(`2026-01-01T00:00:0${index}.000Z`, capture.id);
        f.source.finishCapture(f.project.id, capture.id);
    }
    fs.writeFileSync(path.join(f.root, 'loose.txt'), 'second');
    assert.ok(manifest(f.exported()).files.some(row => row.file_path === 'loose.txt' &&
        row.hash === sha256(Buffer.from('second'))));
});

test('open capture blocks export; finished capture permits it', t => {
    const f = fixture(t);
    const capture = f.source.createCapture({
        projectId: f.project.id, requestId: 'open', root: f.root, reason: 'open', files: [],
    });
    assert.throws(f.exported, code('OPEN_CAPTURE'));
    f.source.finishCapture(f.project.id, capture.id);
    assert.ok(f.exported().bytes.length);
});

test('modified, deleted, unexpectedly present and snapshot-only drift all refuse export', t => {
    const f = fixture(t);
    const cases = [
        ['src/a.txt', Buffer.from('external'), bytesB],
        ['src/a.txt', null, bytesB],
        ['deleted.txt', Buffer.from('unexpected'), null],
        ['unseen.txt', Buffer.from('changed'), Buffer.from('capture-only')],
    ];
    for (const [relative, changed, restore] of cases) {
        const absolute = path.join(f.root, relative);
        if (changed === null) fs.unlinkSync(absolute); else fs.writeFileSync(absolute, changed);
        assert.throws(f.exported, code('DRIFT'));
        if (restore === null) fs.unlinkSync(absolute); else fs.writeFileSync(absolute, restore);
    }
});

test('unrecorded files are not swept into a bundle', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, 'not-recorded.env'), 'synthetic-only');
    const data = manifest(f.exported());
    assert.ok(!data.files.some(row => row.file_path === 'not-recorded.env'));
    assert.ok(!data.blobs.some(row => row.hash === sha256(Buffer.from('synthetic-only'))));
});

test('dangling deleted Todo refuses export instead of silently dropping linkage', t => {
    const f = fixture(t);
    f.source.removeTodo(f.project.id, 1);
    assert.throws(f.exported, code('DANGLING_REFERENCE'));
});

test('malformed format, unexpected fields, duplicate IDs and unresolved references reject', t => {
    const f = fixture(t);
    const bundle = f.exported();
    const mutate = edit => { const data = manifest(bundle); edit(data); return encode(data); };
    for (const bytes of [
        Buffer.from('{bad'), mutate(data => { data.extra = true; }),
        mutate(data => { data.todos.push(data.todos[0]); }),
        mutate(data => { data.nodes[0].todo_id = 999999; }),
        mutate(data => { data.captures[0].baseline_node = 999999; }),
    ]) assert.throws(() => validateProjectBundle(bytes));
    assert.throws(() => validateProjectBundle(mutate(data => { data.version = 999; })), code('SCHEMA_VERSION'));
    assert.throws(() => validateProjectBundle(mutate(data => { data.captures[0].status = 'open'; })), code('OPEN_CAPTURE'));
});

test('bundle trust hash, raw snapshot hashes and complete reference closure are checked', t => {
    const f = fixture(t);
    const bundle = f.exported();
    assert.throws(() => validateProjectBundle(bundle.bytes, { expectedHash: '0'.repeat(64) }), code('HASH_MISMATCH'));
    const corrupt = manifest(bundle);
    corrupt.blobs[0].base64 = Buffer.alloc(corrupt.blobs[0].size, 42).toString('base64');
    assert.throws(() => validateProjectBundle(encode(corrupt)), code('HASH_MISMATCH'));
    const missing = manifest(bundle); missing.blobs.pop();
    assert.throws(() => validateProjectBundle(encode(missing)), code('DANGLING_REFERENCE'));
    const extra = manifest(bundle);
    extra.blobs.push({ hash: sha256(Buffer.from('extra')), size: 5, base64: Buffer.from('extra').toString('base64') });
    assert.throws(() => validateProjectBundle(encode(extra)), code('INVALID_BUNDLE'));
});

test('unsafe portable paths and case-colliding components are refused before import', t => {
    const f = fixture(t);
    const bundle = f.exported();
    for (const file of ['../escape', '/absolute', 'C:/escape', 'dir\\file', '.git/config',
        'dir/NUL.txt', 'x:stream', 'x.', ' x', 'x//y', 'x/./y', 'e\u0301.txt', 'bad\u0000name']) {
        const data = manifest(bundle);
        data.files.push({ file_path: file, hash: null });
        assert.throws(() => validateProjectBundle(encode(data)), code('UNSAFE_PATH'), file);
    }
    const collision = manifest(bundle);
    collision.files.push({ file_path: 'SRC/other.txt', hash: null });
    assert.throws(() => validateProjectBundle(encode(collision)), code('UNSAFE_PATH'));
    const parent = manifest(bundle);
    parent.files.push({ file_path: 'src', hash: sha256(bytesB) });
    assert.throws(() => validateProjectBundle(encode(parent)), code('UNSAFE_PATH'));
});

test('bounded rows, serialized bytes, single blob and total snapshots', t => {
    const f = fixture(t);
    const bundle = f.exported();
    for (const limits of [{ maxBundleBytes: 5 }, { maxRows: 1 },
        { maxBlobBytes: 1 }, { maxTotalBlobBytes: 1 }]) {
        assert.throws(() => validateProjectBundle(bundle.bytes, { limits }), code('LIMIT_EXCEEDED'));
    }
    assert.throws(() => f.exported() && exportProjectBundle(f.source, f.project.id,
        { limits: { maxRows: 1 } }), code('LIMIT_EXCEEDED'));
    assert.throws(() => validateProjectBundle(bundle.bytes, { limits: { maxRows: 50001 } }), code('INVALID_ARGUMENT'));
});

test('missing and corrupt compressed source snapshots refuse export', t => {
    const f = fixture(t);
    const id = sha256(bytesA);
    f.source.db.prepare('UPDATE blobs SET size=1 WHERE hash=?').run(id);
    assert.throws(f.exported, code('CORRUPT_BLOB'));
    f.source.db.prepare('DELETE FROM blobs WHERE hash=?').run(id);
    assert.throws(f.exported, code('CORRUPT_BLOB'));
});

test('hardlinked known file refuses export', t => {
    const f = fixture(t);
    fs.linkSync(path.join(f.root, 'src/a.txt'), path.join(f.dir, 'hardlink'));
    assert.throws(f.exported, code('UNSAFE_PATH'));
});

test('symlink or junction ancestor refuses export', t => {
    const f = fixture(t);
    const original = path.join(f.dir, 'original-src');
    fs.renameSync(path.join(f.root, 'src'), original);
    try { fs.symlinkSync(original, path.join(f.root, 'src'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
        if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink permission unavailable'); return; }
        throw error;
    }
    assert.throws(f.exported, code('UNSAFE_PATH'));
});

for (const table of ['nodes', 'captures', 'capture_files', 'file_state']) {
    test(`SQL failure during ${table} insertion rolls back project, IDs, blobs and all references`, t => {
        const f = fixture(t);
        const bundle = f.exported();
        f.target.db.exec(`CREATE TRIGGER reject_bundle BEFORE INSERT ON ${table}
            BEGIN SELECT RAISE(ABORT, 'injected bundle failure'); END;`);
        const before = databaseSnapshot(f.target);
        assert.throws(() => importProjectBundle(f.target, bundle.bytes, f.destination()), /injected bundle failure/);
        assert.deepEqual(databaseSnapshot(f.target), before);
        assert.equal(fs.existsSync(f.destination().root), false);
        f.target.db.exec('DROP TRIGGER reject_bundle');
        assert.ok(importProjectBundle(f.target, bundle.bytes, f.destination()).projectId);
    });
}

test('corrupt existing destination blob is rejected without partial import', t => {
    const f = fixture(t);
    const bundle = f.exported();
    f.target.db.prepare('UPDATE blobs SET data=? WHERE hash=?')
        .run(zlib.gzipSync(Buffer.from('wrong')), sha256(bytesA));
    const before = databaseSnapshot(f.target);
    assert.throws(() => importProjectBundle(f.target, bundle.bytes, f.destination()), code('CORRUPT_BLOB'));
    assert.deepEqual(databaseSnapshot(f.target), before);
});

test('invalid or existing local destination and caller transactions are refused', t => {
    const f = fixture(t);
    const bundle = f.exported();
    for (const target of [null, { ...f.destination(), root: 'relative' },
        { ...f.destination(), root: path.parse(f.dir).root }, { ...f.destination(), workspaceAlias: '' }]) {
        assert.throws(() => importProjectBundle(f.target, bundle.bytes, target), code('INVALID_ARGUMENT'));
    }
    fs.mkdirSync(f.destination().root);
    assert.throws(() => importProjectBundle(f.target, bundle.bytes, f.destination()), code('DESTINATION_EXISTS'));
    f.target.transaction(() => {
        assert.throws(() => importProjectBundle(f.target, bundle.bytes, f.destination('other')), code('INVALID_ARGUMENT'));
    });
});

test('repeat imports are explicit independent copies, not implicit replacement or idempotent retries', t => {
    const f = fixture(t);
    const bundle = f.exported();
    const a = importProjectBundle(f.target, bundle.bytes, f.destination('copy-a'));
    const b = importProjectBundle(f.target, bundle.bytes, f.destination('copy-b'));
    assert.notEqual(a.projectId, b.projectId);
    assert.equal(f.target.getProject(a.projectId).name, '中文工程');
    assert.equal(f.target.getProject(b.projectId).name, '中文工程');
    const blobCount = f.target.db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n;
    assert.equal(blobCount, manifest(bundle).blobs.length);
    assert.throws(() => importProjectBundle(f.target, bundle.bytes, f.destination('copy-a')), code('DESTINATION_EXISTS'));
});
test('equal-time conflicting capture-only snapshots refuse ambiguous current state', t => {
    const f = fixture(t);
    for (const [index, value] of ['first', 'second'].entries()) {
        const capture = f.source.createCapture({
            projectId: f.project.id, requestId: `equal-conflict-${index}`, root: f.root,
            reason: 'no-change', files: [{ path: 'equal.txt', buffer: Buffer.from(value) }],
        });
        f.source.db.prepare('UPDATE captures SET created_at=? WHERE id=?')
            .run('2026-01-01T00:00:00.000Z', capture.id);
        f.source.finishCapture(f.project.id, capture.id);
    }
    fs.writeFileSync(path.join(f.root, 'equal.txt'), 'second');
    assert.throws(f.exported, code('AMBIGUOUS_STATE'));
});

test('equal-time identical capture-only snapshots are unambiguous', t => {
    const f = fixture(t);
    for (let index = 0; index < 2; index++) {
        const capture = f.source.createCapture({
            projectId: f.project.id, requestId: `equal-same-${index}`, root: f.root,
            reason: 'no-change', files: [{ path: 'equal.txt', buffer: Buffer.from('same') }],
        });
        f.source.db.prepare('UPDATE captures SET created_at=? WHERE id=?')
            .run('2026-01-01T00:00:00.000Z', capture.id);
        f.source.finishCapture(f.project.id, capture.id);
    }
    fs.writeFileSync(path.join(f.root, 'equal.txt'), 'same');
    assert.ok(manifest(f.exported()).files.some(row =>
        row.file_path === 'equal.txt' && row.hash === sha256(Buffer.from('same'))));
});

test('discontinuous before/after history is rejected before destination mutation', t => {
    const f = fixture(t);
    const data = manifest(f.exported());
    data.nodes[data.nodes.length - 1].before_hash = null;
    const before = databaseSnapshot(f.target);
    assert.throws(() => validateProjectBundle(encode(data)), code('INVALID_BUNDLE'));
    assert.throws(() => importProjectBundle(f.target, encode(data), f.destination()), code('INVALID_BUNDLE'));
    assert.deepEqual(databaseSnapshot(f.target), before);
});
test('plan reader returns only detached plan fields without importing or writing', t => {
    const { readProjectPlanBundle } =
        require('../../Plugin/ServerProjectForge/projectBundle');
    const f = fixture(t);
    const bundle = f.exported();
    const beforeSource = databaseSnapshot(f.source);
    const beforeTarget = databaseSnapshot(f.target);
    const result = readProjectPlanBundle(bundle.bytes, { expectedHash: bundle.sha256 });
    assert.deepEqual(Object.keys(result).sort(), ['project', 'sha256', 'todos']);
    assert.deepEqual(Object.keys(result.project).sort(),
        ['id', 'name', 'status', 'created_at', 'updated_at'].sort());
    assert.equal(result.sha256, bundle.sha256);
    assert.equal(result.project.name, '中文工程');
    assert.equal(result.project.status, 'accepted');
    assert.equal(result.todos.length, 2);
    assert.deepEqual(Object.keys(result.todos[0]).sort(),
        ['seq', 'title', 'status', 'note', 'updated_by', 'updated_at'].sort());
    assert.equal(result.todos[0].status, 'done');
    assert.equal(result.todos[0].note, '独立验收');
    assert.equal(JSON.stringify(result).includes('src/a.txt'), false);
    assert.equal(JSON.stringify(result).includes(bytesB.toString('base64')), false);
    assert.deepEqual(databaseSnapshot(f.source), beforeSource);
    assert.deepEqual(databaseSnapshot(f.target), beforeTarget);
    result.todos[0].title = 'changed';
    assert.equal(readProjectPlanBundle(bundle.bytes).todos[0].title, '修复实现');
});

test('plan reader still validates full checkpoint and expected content hash', t => {
    const { readProjectPlanBundle } =
        require('../../Plugin/ServerProjectForge/projectBundle');
    const f = fixture(t);
    const bundle = f.exported();
    assert.throws(() => readProjectPlanBundle(bundle.bytes, { expectedHash: '0'.repeat(64) }));
    const damaged = manifest(bundle);
    damaged.blobs[0].base64 = Buffer.from('CORRUPTED').toString('base64');
    assert.throws(() => readProjectPlanBundle(encode(damaged)));
    assert.throws(() => readProjectPlanBundle(Buffer.from('not JSON')));
});
function catalogHubFixture(bundle) {
    const globalId = 'g_11111111-2222-4333-8444-555555555555';
    const head = {
        id: globalId, originId: 'origin-source', localProjectId: 'poriginal',
        revision: 7, bundleHash: bundle.sha256,
    };
    const revision = {
        projectId: globalId, revision: 7, baseRevision: 6,
        bundleHash: bundle.sha256, publishedAt: 123456,
    };
    const calls = [];
    const hub = {
        getProject(id) { calls.push(['get', id]); return { ...head }; },
        downloadRevision(id, rev) {
            calls.push(['download', id, rev]);
            return { revision: { ...revision }, bytes: bundle.bytes };
        },
    };
    return { globalId, head, revision, calls, hub };
}

test('published catalog plan uses Hub origin identity, not checkpoint replica ID', t => {
    const { readPublishedPlan } =
        require('../../Plugin/ServerProjectForge/catalogPublishedPlan');
    const { CatalogSnapshot } =
        require('../../Plugin/ServerProjectForge/catalogSnapshot');
    const f = fixture(t), bundle = f.exported(), h = catalogHubFixture(bundle);
    const before = databaseSnapshot(f.source);
    const result = readPublishedPlan(h.hub, h.globalId);
    assert.notEqual(f.project.id, 'poriginal');
    assert.equal(result.record.project.id, 'poriginal');
    assert.equal(result.record.identity.sourceId, 'origin-source');
    assert.equal(result.record.identity.globalProjectId, h.globalId);
    assert.ok(result.record.todos.every(todo => todo.project_id === 'poriginal'));
    assert.deepEqual(result.publication, {
        globalProjectId: h.globalId, revision: 7,
        bundleHash: bundle.sha256, publishedAt: 123456,
    });
    assert.deepEqual(h.calls, [['get', h.globalId], ['download', h.globalId, 7]]);
    const snapshot = new CatalogSnapshot([result.record]);
    const summary = snapshot.list().items[0];
    assert.equal(summary.progress.done, 1);
    assert.equal(snapshot.todos(summary.key).items.length, 2);
    assert.deepEqual(databaseSnapshot(f.source), before);
});

test('unpublished catalog project fails explicitly without downloading', t => {
    const { readPublishedPlan } =
        require('../../Plugin/ServerProjectForge/catalogPublishedPlan');
    const f = fixture(t), h = catalogHubFixture(f.exported());
    h.head.revision = 0;
    h.head.bundleHash = null;
    assert.throws(() => readPublishedPlan(h.hub, h.globalId), code('CONTENT_NOT_FOUND'));
    assert.deepEqual(h.calls, [['get', h.globalId]]);
});

test('published catalog rejects head/revision mismatch and damaged checkpoint', t => {
    const { readPublishedPlan } =
        require('../../Plugin/ServerProjectForge/catalogPublishedPlan');
    const f = fixture(t), bundle = f.exported();
    for (const mutate of [
        h => { h.head.id = 'g_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; },
        h => { h.revision.projectId = 'g_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; },
        h => { h.revision.revision = 6; },
        h => { h.revision.baseRevision = 3; },
        h => { h.revision.bundleHash = '0'.repeat(64); },
    ]) {
        const h = catalogHubFixture(bundle);
        mutate(h);
        assert.throws(() => readPublishedPlan(h.hub, h.globalId), code('CONTENT_BINDING'));
    }
    const h = catalogHubFixture({ ...bundle, bytes: Buffer.from('corrupt') });
    assert.throws(() => readPublishedPlan(h.hub, h.globalId));
});

test('published catalog pins observed revision even if head subsequently advances', t => {
    const { readPublishedPlan } =
        require('../../Plugin/ServerProjectForge/catalogPublishedPlan');
    const f = fixture(t), h = catalogHubFixture(f.exported());
    const download = h.hub.downloadRevision;
    h.hub.downloadRevision = (id, revision) => {
        h.head.revision = 8;
        return download(id, revision);
    };
    const result = readPublishedPlan(h.hub, h.globalId);
    assert.equal(result.publication.revision, 7);
    assert.equal(h.head.revision, 8);
    assert.deepEqual(h.calls, [['get', h.globalId], ['download', h.globalId, 7]]);
});