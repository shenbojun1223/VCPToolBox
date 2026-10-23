'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const plugin = path.resolve(__dirname, '../../Plugin/ServerProjectForge');
const { ProjectStore } = require(path.join(plugin, 'store'));
const Bundle = require(path.join(plugin, 'projectBundle'));
const C = require(path.join(plugin, 'projectCheckpoint'));
const code = c => e => e.code === c;
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-roundtrip-'));
    const A = new ProjectStore(path.join(root, 'A.db')), B = new ProjectStore(path.join(root, 'B.db'));
    const source = path.join(root, 'A'); fs.mkdirSync(source);
    const p = A.createProject({ name: 'roundtrip', root: source, workspaceAlias: 'A' });
    A.addTodos(p.id, ['first', 'second']);
    const bytes = Buffer.from('\uFEFF中文\r\n');
    fs.writeFileSync(path.join(source, 'a.txt'), bytes);
    const batch = A.createBatch(p.id, 'create', 'seed', 'Kerr');
    const node = A.addNode({ projectId: p.id, batchId: batch, filePath: 'a.txt', op: 'create',
        beforeHash: null, afterHash: A.putBlob(bytes), todoId: A.getTodoBySeq(p.id, 1).id });
    const cap = A.createCapture({ projectId: p.id, requestId: 'capture', root: source,
        reason: 'snapshot', files: [{ path: 'a.txt', buffer: bytes }] });
    A.finishCapture(p.id, cap.id, null);
    const base = Bundle.exportProjectBundle(A, p.id);
    const target = path.join(root, 'B');
    B.createProject({ name: 'offset-ids', root: path.join(root, 'dummy'), workspaceAlias: 'B' });
    const copied = Bundle.importProjectBundle(B, base.bytes, { root: target, workspaceAlias: 'B' });
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'a.txt'), bytes);
    const imported = Bundle.exportProjectBundle(B, copied.projectId);
    t.after(() => { A.close(); B.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, A, B, p, node, cap, base, imported, copied, target, source, bytes };
}
function change(f) {
    const id = f.copied.projectId, bytes = Buffer.from('\uFEFFB changed\r\n');
    fs.writeFileSync(path.join(f.target, 'a.txt'), bytes);
    const batch = f.B.createBatch(id, 'edit', 'B change', 'Kerr');
    f.B.addNode({ projectId: id, batchId: batch, filePath: 'a.txt', op: 'edit',
        beforeHash: f.B.getFileState(id, 'a.txt'), afterHash: f.B.putBlob(bytes), todoId: f.B.getTodoBySeq(id, 2).id });
    f.B.updateTodo(id, 2, { status: 'done', updatedBy: 'Kerr' });
    return Bundle.exportProjectBundle(f.B, id);
}
test('baseline ignores remapped IDs but preserves every portable field', t => {
    const f = fixture(t);
    assert.notEqual(f.p.id, f.copied.projectId);
    assert.equal(C.fingerprint(f.base.bytes), C.fingerprint(f.imported.bytes));
    assert.doesNotThrow(() => C.assertClean(f.A, f.p.id, f.imported.bytes));
});
for (const kind of ['todo', 'project', 'file', 'capture']) test('local conflict is rejected: ' + kind, t => {
    const f = fixture(t);
    if (kind === 'todo') f.A.updateTodo(f.p.id, 1, { status: 'done' });
    if (kind === 'project') f.A.updateProject(f.p.id, { name: 'local name' });
    if (kind === 'file') fs.writeFileSync(path.join(f.source, 'a.txt'), 'outside edit');
    if (kind === 'capture') f.A.createCapture({ projectId: f.p.id, requestId: 'open', root: f.source,
        reason: 'unfinished', files: [{ path: 'a.txt', buffer: f.bytes }] });
    assert.throws(() => C.assertClean(f.A, f.p.id, f.base.bytes));
});
test('valid remote extension preserves original project, node, batch, todo and Capture IDs', t => {
    const f = fixture(t), next = change(f);
    assert.doesNotThrow(() => C.assertForward(f.base.bytes, next.bytes));
    const oldTodo = f.A.getTodoBySeq(f.p.id, 2).id;
    f.A.db.transaction(() => C.applyMetadata(f.A, f.p.id, f.base.bytes, next.bytes)).immediate();
    fs.writeFileSync(path.join(f.source, 'a.txt'), fs.readFileSync(path.join(f.target, 'a.txt')));
    assert.equal(f.A.getProject(f.p.id).id, f.p.id);
    assert.equal(f.A.getNode(f.p.id, f.node).id, f.node);
    assert.equal(f.A.getTodoBySeq(f.p.id, 2).id, oldTodo);
    assert.equal(f.A.getCapture(f.p.id, f.cap.id).id, f.cap.id);
    assert.equal(C.fingerprint(Bundle.exportProjectBundle(f.A, f.p.id).bytes), C.fingerprint(next.bytes));
    assert.equal(f.A.projectStats(f.p.id).nodeCount, 2);
});
test('rewritten old history is not accepted as a forward version', t => {
    const f = fixture(t), changed = JSON.parse(change(f).bytes);
    changed.nodes[0].summary = 'rewritten';
    assert.throws(() => C.assertForward(f.base.bytes, Buffer.from(JSON.stringify(changed))), code('HISTORY_CONFLICT'));
});
test('metadata SQL failure rolls back the entire original-engine update', t => {
    const f = fixture(t), next = change(f);
    f.A.db.exec("CREATE TRIGGER reject_remote BEFORE INSERT ON nodes BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    assert.throws(() => f.A.db.transaction(() => C.applyMetadata(f.A, f.p.id, f.base.bytes, next.bytes)).immediate(), /synthetic failure/);
    assert.equal(C.fingerprint(Bundle.exportProjectBundle(f.A, f.p.id).bytes), C.fingerprint(f.base.bytes));
});
async function networkFixture(t) {
    const crypto = require('node:crypto');
    const { HubContentStore } = require(path.join(plugin, 'hubContentStore'));
    const { HubStore } = require(path.join(plugin, 'hubStore'));
    const { HubNetworkServer } = require(path.join(plugin, 'hubNetworkServer'));
    const { HubNetworkClient } = require(path.join(plugin, 'hubNetworkClient'));
    const { ProjectTakeover } = require(path.join(plugin, 'projectTakeover'));
    const { ProjectAutoResume } = require(path.join(plugin, 'projectAutoResume'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-roundtrip-net-')), forge = {};
    for (const side of ['A', 'B']) {
        fs.mkdirSync(path.join(root, side));
        const filename = require.resolve(path.join(plugin, 'ProjectForgeService'));
        delete require.cache[filename]; forge[side] = require(filename);
        forge[side].initialize({ dbPath: path.join(root, side + '.db'),
            config: { WORKSPACES: side + '|' + path.join(root, side), ACTIVE_WORKSPACE: side, AST_INDEX_ENABLED: false },
            trash: async file => fs.renameSync(file, path.join(root, 'trash-' + crypto.randomUUID())),
            logger: { log() {}, warn() {}, error() {} } });
        await forge[side].processToolCall({ command: 'ListProjects' });
    }
    const p = (await forge.A.processToolCall({ command: 'CreateProject', name: 'normal-roundtrip', dir: 'source', todos: 'first\nsecond' })).details.project;
    await forge.A.processToolCall({ command: 'CreateFile', projectId: p.id, path: 'a.txt', content: '\uFEFF中文\r\n', reason: 'seed' });
    const A = forge.A._test.getRuntime().store, B = forge.B._test.getRuntime().store;
    const takeover = new ProjectTakeover(A, path.join(root, 'A-journal.db')), origin = takeover.storeId; takeover.close();
    const content = new HubContentStore(path.join(root, 'content.db'));
    const hub = new HubStore(path.join(root, 'hub.db'), { contentStore: content });
    const secrets = Object.fromEntries(['A', 'B'].map(s => [s, crypto.randomBytes(32).toString('base64url')]));
    const server = new HubNetworkServer(hub, path.join(root, 'network.db'), { principals: ['A', 'B'].map(s =>
        ({ token: secrets[s], deviceId: s, originIds: [origin], projectIds: [], permissions: ['read', 'write', 'register'] })) });
    const endpoint = await server.listen();
    const clients = Object.fromEntries(['A', 'B'].map(s => [s, new HubNetworkClient(endpoint.baseUrl, {
        token: secrets[s], deviceId: s, hubId: hub.getHubId() })]));
    const opened = [];
    const target = { root: path.join(root, 'B', 'incoming'), workspaceAlias: 'B', subpath: 'incoming' };
    const options = side => ({ client: clients[side], journalPath: path.join(root, side + '-journal.db'),
        mappingPath: path.join(root, side + '-mapping.db'), ttlMs: 30000, pollMs: 1000, checkpointMs: 600000, safetyMs: 100 });
    const auto = (side, extra = {}) => {
        const controller = new ProjectAutoResume(side === 'A' ? A : B, { ...options(side),
            ...(side === 'A' ? { localProjectId: p.id } : {}), ...extra });
        opened.push(controller); return controller;
    };
    t.after(async () => {
        for (const controller of opened.reverse()) await controller.stop();
        await forge.A.cleanup(); await forge.B.cleanup(); await server.close(); hub.close(); content.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, forge, A, B, p, hub, content, server, clients, secrets, endpoint, options, target, auto };
}
async function outward(f) {
    const a = f.auto('A'); assert.equal((await a.start()).writable, true);
    await a.handoff(); const global = a.globalId; await a.stop();
    const b = f.auto('B', { globalProjectId: global, target: f.target });
    assert.equal((await b.start()).writable, true);
    await f.forge.B.processToolCall({ command: 'EditCode', projectId: b.localId, path: 'a.txt',
        target: '中文', replace: 'B changed', reason: 'B edit' });
    await f.forge.B.processToolCall({ command: 'UpdateTodos', projectId: b.localId, done: '2' });
    await b.handoff(); const bid = b.localId; await b.stop();
    return { global, bid };
}
test('normal tools + real HTTP A->B->A->B update ORIGINAL project IDs/roots and retain original node IDs', async t => {
    const f = await networkFixture(t), first = await outward(f);
    const originalNode = f.A.timeline(f.p.id)[0].id;
    const originalTodo = f.A.getTodoBySeq(f.p.id, 1).id;
    const untracked = path.join(f.p.root, 'keep-untracked.txt'); fs.writeFileSync(untracked, 'preserve');
    const again = f.auto('A'); const status = await again.start();
    assert.equal(status.writable, true, JSON.stringify(status)); assert.equal(again.localId, f.p.id);
    assert.equal(f.A.getProject(f.p.id).root, f.p.root);
    assert.equal(f.A.getTodoBySeq(f.p.id, 1).id, originalTodo);
    assert.equal(f.A.getTodoBySeq(f.p.id, 2).status, 'done');
    assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'a.txt')), Buffer.from('\uFEFFB changed\r\n'));
    assert.equal(fs.readFileSync(untracked, 'utf8'), 'preserve');
    assert.ok(f.A.timeline(f.p.id).some(b => b.id === originalNode));
    await f.forge.A.processToolCall({ command: 'EditCode', projectId: f.p.id, path: 'a.txt',
        target: 'B changed', replace: 'A continued', reason: 'A continues' });
    await again.handoff(); await again.stop();
    const returnedB = f.auto('B', { globalProjectId: first.global, target: f.target });
    const result = await returnedB.start(); assert.equal(result.writable, true, JSON.stringify(result));
    assert.equal(returnedB.localId, first.bid);
    assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), Buffer.from('\uFEFFA continued\r\n'));
    assert.equal(f.A.listProjects().length, 1); assert.equal(f.B.listProjects().length, 1);
    assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_projects').get().n, 1);
    assert.equal(f.A.projectStats(f.p.id).nodeCount, 3); assert.equal(f.B.projectStats(first.bid).nodeCount, 3);
});
for (const kind of ['file', 'todo', 'history', 'open-capture']) {
    test('stale local changes block automatic update without overwriting: ' + kind, async t => {
        const f = await networkFixture(t); await outward(f);
        if (kind === 'file') fs.writeFileSync(path.join(f.p.root, 'a.txt'), 'local editor');
        if (kind === 'todo') f.A.db.prepare("UPDATE todos SET note='local note' WHERE project_id=?").run(f.p.id);
        if (kind === 'history') f.A.db.prepare("UPDATE nodes SET summary='local history' WHERE project_id=?").run(f.p.id);
        if (kind === 'open-capture') f.A.db.prepare(`INSERT INTO captures
            (id,project_id,request_id,root,reason,baseline_node,status,created_at) VALUES ('c-open',?,'open',?,'unfinished',0,'open','now')`)
            .run(f.p.id, f.p.root);
        const bytes = fs.readFileSync(path.join(f.p.root, 'a.txt'));
        const a = f.auto('A'), status = await a.start();
        assert.equal(status.writable, false); assert.ok(status.error);
        assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'a.txt')), bytes);
        assert.equal(f.A.projectStats(f.p.id).nodeCount, 1);
    });
}
test('unknown file colliding with remote new file is preserved even if bytes match', async t => {
    const f = await networkFixture(t);
    const a = f.auto('A'); await a.start(); await a.handoff(); const global = a.globalId; await a.stop();
    const b = f.auto('B', { globalProjectId: global, target: f.target }); await b.start();
    await f.forge.B.processToolCall({ command: 'CreateFile', projectId: b.localId, path: 'new.txt', content: 'same', reason: 'new remote file' });
    await b.handoff(); await b.stop();
    fs.writeFileSync(path.join(f.p.root, 'new.txt'), 'same');
    const again = f.auto('A'); assert.equal((await again.start()).writable, false);
    assert.equal(fs.readFileSync(path.join(f.p.root, 'new.txt'), 'utf8'), 'same');
    assert.equal(f.A.projectStats(f.p.id).nodeCount, 1);
});
for (const event of ['update-planned', 'update-file-staged', 'update-file-installed', 'update-metadata-applied', 'update-mapping-recorded']) {
    test('interrupted original-directory update remains hidden and resumes: ' + event, async t => {
        const f = await networkFixture(t); await outward(f);
        let failed = false;
        const interrupted = f.auto('A', { _testHook: name => {
            if (name === event && !failed) { failed = true; throw Error('interrupt'); }
        } });
        assert.equal((await interrupted.start()).writable, false);
        assert.equal(failed, true);
        assert.equal(f.A.getProject(f.p.id), null);
        assert.equal(f.A.listProjects().length, 0);
        assert.throws(() => f.A.listTodos(f.p.id), code('PROJECT_UPDATING'));
        await interrupted.stop();
        const again = f.auto('A'), status = await again.start();
        assert.equal(status.writable, true, JSON.stringify(status));
        assert.equal(again.localId, f.p.id); assert.equal(f.A.projectStats(f.p.id).nodeCount, 2);
        assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'a.txt')), Buffer.from('\uFEFFB changed\r\n'));
    });
}

test('registered add/delete/move and binary Capture update preserve unknown files and original GUI node IDs', async t => {
    const f = await networkFixture(t), a = f.auto('A'); await a.start();
    const initialNode = f.A.searchNodes({ projectId: f.p.id })[0].id;
    for (const file of ['delete.txt', 'move.txt']) await f.forge.A.processToolCall({
        command: 'CreateFile', projectId: f.p.id, path: file, content: file, reason: 'source seed',
    });
    const binaryBefore = Buffer.from([0, 255, 128, 13, 10]), binaryAfter = Buffer.from([0, 2, 254, 13, 10, 128]);
    async function captured(side, controller, relative, bytes, requestId) {
        return controller.runWorker(async () => {
            await f.forge[side].processToolCall({ command: 'BeginCapture', projectId: controller.localId,
                path: relative, requestId, reason: 'synthetic binary writer' });
            const root = side === 'A' ? f.p.root : f.target.root;
            fs.writeFileSync(path.join(root, relative), bytes);
            await f.forge[side].processToolCall({ command: 'FinishCapture', projectId: controller.localId, requestId });
        });
    }
    await captured('A', a, 'binary.bin', binaryBefore, 'binary-source');
    await a.handoff(); const global = a.globalId; await a.stop();
    const b = f.auto('B', { globalProjectId: global, target: f.target }); await b.start();
    await f.forge.B.processToolCall({ command: 'RemoveFile', projectId: b.localId, path: 'delete.txt', reason: 'remote deletion' });
    await f.forge.B.processToolCall({ command: 'MoveFile', projectId: b.localId,
        from: 'move.txt', to: 'nested/moved.txt', reason: 'remote move' });
    await f.forge.B.processToolCall({ command: 'CreateFile', projectId: b.localId,
        path: 'nested/new.txt', content: '\uFEFF新文件\r\n', reason: 'remote addition' });
    await f.forge.B.processToolCall({ command: 'EditCode', projectId: b.localId,
        path: 'a.txt', target: '中文', replace: 'remote text', reason: 'remote text edit' });
    await captured('B', b, 'binary.bin', binaryAfter, 'binary-remote');
    await b.handoff(); await b.stop();
    fs.writeFileSync(path.join(f.p.root, 'keep.txt'), 'unknown file stays');
    fs.mkdirSync(path.join(f.p.root, 'unknown-directory'));
    const again = f.auto('A'), status = await again.start();
    assert.equal(status.writable, true, JSON.stringify(status));
    assert.equal(fs.existsSync(path.join(f.p.root, 'delete.txt')), false);
    assert.equal(fs.existsSync(path.join(f.p.root, 'move.txt')), false);
    assert.equal(fs.readFileSync(path.join(f.p.root, 'nested/moved.txt'), 'utf8'), 'move.txt');
    assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'nested/new.txt')), Buffer.from('\uFEFF新文件\r\n'));
    assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'binary.bin')), binaryAfter);
    assert.equal(fs.readFileSync(path.join(f.p.root, 'keep.txt'), 'utf8'), 'unknown file stays');
    assert.equal(fs.statSync(path.join(f.p.root, 'unknown-directory')).isDirectory(), true);
    assert.equal(f.A.getNode(f.p.id, initialNode).file_path, 'a.txt');
    const rollback = await f.forge.A.gui.revertFileChange({ projectId: f.p.id,
        nodeId: initialNode, mode: 'after', signature: 'Kerr', force: true });
    assert.equal(rollback.status, 'ok');
    assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'a.txt')), Buffer.from('\uFEFF中文\r\n'));
    await again.handoff();
});

async function crashUpdate(f, event) {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [path.join(__dirname, 'helpers/forgeRoundtripCrash.cjs')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PF_ROUNDTRIP_CRASH: JSON.stringify({
            root: f.root, endpoint: f.endpoint.baseUrl, hubId: f.hub.getHubId(),
            token: f.secrets.A, localProjectId: f.p.id, event,
        }) }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2048); });
    const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => child.kill(), 15000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (exit, signal) => { clearTimeout(timer); resolve({ exit, signal }); });
    });
    assert.equal(result.exit, 73, stderr); assert.equal(result.signal, null);
}
for (const event of ['update-planned', 'update-file-staged', 'update-file-installed',
    'update-metadata-applied', 'update-mapping-recorded']) {
    test('real process.exit(73) preserves hidden original project and resumes: ' + event, async t => {
        const f = await networkFixture(t); await outward(f);
        await crashUpdate(f, event);
        assert.equal(f.A.getProject(f.p.id, { includeDeleted: true }), null);
        assert.equal(f.A.searchNodes().length, 0);
        const second = new ProjectStore(path.join(f.root, 'A.db'));
        try {
            assert.equal(second.getProject(f.p.id), null);
            assert.equal(second.listProjects({ includeDeleted: true }).length, 0);
            assert.equal(second.searchNodes({ projectId: f.p.id }).length, 0);
            assert.throws(() => second.listTodos(f.p.id), code('PROJECT_UPDATING'));
            assert.throws(() => second.softDeleteProjects([f.p.id]), code('PROJECT_UPDATING'));
            assert.throws(() => second.createProject({ name: 'nested-bypass',
                root: path.join(f.p.root, 'bypass'), workspaceAlias: 'A' }));
            assert.equal(second.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '6');
        } finally { second.close(); }
        const resumed = f.auto('A'), status = await resumed.start();
        assert.equal(status.writable, true, JSON.stringify(status));
        assert.equal(f.A.projectStats(f.p.id).nodeCount, 2);
        assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'a.txt')), Buffer.from('\uFEFFB changed\r\n'));
        assert.equal(f.A.db.prepare("SELECT count(*) n FROM project_update_jobs WHERE state='complete'").get().n, 1);
        assert.equal(f.A.db.prepare("SELECT count(*) n FROM meta WHERE key LIKE 'project_update:%'").get().n, 0);
    });
}
for (const replace of ['unknown-bytes', 'same-bytes-new-inode', 'root-identity']) {
    test('recovery refuses external replacement without overwriting it: ' + replace, async t => {
        const f = await networkFixture(t); await outward(f);
        const first = f.auto('A', { _testHook: event => { if (event === 'update-file-installed') throw Error('interrupt'); } });
        assert.equal((await first.start()).writable, false); await first.stop();
        let preserved;
        if (replace === 'root-identity') {
            fs.renameSync(f.p.root, f.p.root + '-old');
            fs.mkdirSync(f.p.root);
            preserved = Buffer.from('new owner');
            fs.writeFileSync(path.join(f.p.root, 'a.txt'), preserved);
        } else {
            const file = path.join(f.p.root, 'a.txt');
            preserved = replace === 'unknown-bytes' ? Buffer.from('external edit') : fs.readFileSync(file);
            fs.renameSync(file, file + '-old'); fs.writeFileSync(file, preserved);
        }
        const again = f.auto('A'), status = await again.start();
        assert.equal(status.writable, false);
        assert.equal(status.error, replace === 'root-identity' ? 'IDENTITY_MISMATCH' : 'FILE_DRIFT');
        assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'a.txt')), preserved);
        assert.equal(f.A.getProject(f.p.id), null);
    });
}
test('SQL metadata failure after files installed stays hidden and retries without duplicate nodes', async t => {
    const f = await networkFixture(t); await outward(f);
    f.A.db.exec("CREATE TRIGGER reject_update BEFORE INSERT ON nodes BEGIN SELECT RAISE(ABORT,'update SQL failure'); END");
    const first = f.auto('A'); assert.equal((await first.start()).writable, false); await first.stop();
    assert.equal(f.A.getProject(f.p.id), null);
    f.A.db.exec('DROP TRIGGER reject_update');
    const second = f.auto('A'), status = await second.start();
    assert.equal(status.writable, true, JSON.stringify(status));
    assert.equal(f.A.projectStats(f.p.id).nodeCount, 2);
    assert.equal(f.A.db.prepare('SELECT count(*) n FROM projects').get().n, 1);
});
test('authorization removed after staging prevents live replacement and keeps evidence hidden', async t => {
    const f = await networkFixture(t); await outward(f); let authorized = true;
    const before = fs.readFileSync(path.join(f.p.root, 'a.txt'));
    const a = f.auto('A', { authorizeTarget: target => {
        if (!authorized) throw Object.assign(Error('disabled workspace'), { code: 'AUTO_TARGET_UNAUTHORIZED' });
        return target;
    }, _testHook: event => { if (event === 'update-file-staged') authorized = false; } });
    const status = await a.start();
    assert.equal(status.writable, false); assert.equal(status.error, 'AUTO_TARGET_UNAUTHORIZED');
    assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'a.txt')), before);
    assert.equal(f.A.getProject(f.p.id), null);
});
test('loss of confirmed update lease before local plan changes no files or project visibility', async t => {
    const f = await networkFixture(t); const { global } = await outward(f);
    const client = f.clients.A;
    const broken = new Proxy(client, { get(target, name) {
        if (name === 'renewLease') return async () => {
            throw Object.assign(Error('expired synthetic lease'), { code: 'LEASE_EXPIRED' });
        };
        const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const before = fs.readFileSync(path.join(f.p.root, 'a.txt'));
    const a = f.auto('A', { client: broken }), status = await a.start();
    assert.equal(status.writable, false); assert.equal(status.error, 'LEASE_EXPIRED');
    assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'a.txt')), before);
    assert.equal(f.A.getProject(f.p.id).id, f.p.id);
    assert.equal(f.hub.getProject(global).revision, 2);
});

test('local conflict stops automatic polling, releases lease and allows the other device to continue', async t => {
    const f = await networkFixture(t), { global } = await outward(f);
    f.A.db.prepare("UPDATE todos SET note='unpublished local change' WHERE project_id=?").run(f.p.id);
    let requests = 0;
    const client = new Proxy(f.clients.A, { get(target, name) {
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? (...args) => { requests++; return value.apply(target, args); } : value;
    } });
    const a = f.auto('A', { client, pollMs: 20 }), status = await a.start();
    assert.equal(status.phase, 'conflict'); assert.equal(status.error, 'LOCAL_CHANGES');
    assert.equal(status.leaseRelease, 'released'); assert.equal(status.writable, false);
    assert.equal(a.running, false); assert.equal(f.hub.getProject(global).lease, null);
    const calls = requests;
    await new Promise(resolve => setTimeout(resolve, 80)); await a.tick();
    assert.equal(requests, calls);
    const lease = await f.clients.B.acquireLease({ projectId: global, requestId: 'after-conflict', ttlMs: 30000 });
    assert.equal(lease.holder, 'B'); await f.clients.B.releaseLease(lease);
    assert.equal(f.A.listTodos(f.p.id)[0].note, 'unpublished local change');
});
for (const committed of [false, true]) {
    test('conflict release reply failure is unconfirmed and is not automatically retried; committed=' + committed, async t => {
        const f = await networkFixture(t), { global } = await outward(f);
        fs.writeFileSync(path.join(f.p.root, 'a.txt'), 'unpublished bytes');
        let releases = 0, requests = 0;
        const client = new Proxy(f.clients.A, { get(target, name) {
            if (name === 'releaseLease') return async args => {
                requests++; releases++;
                if (committed) await target.releaseLease(args);
                throw Object.assign(Error('synthetic lost response'), { code: 'NETWORK_ERROR' });
            };
            const value = Reflect.get(target, name);
            return typeof value === 'function' ? (...args) => { requests++; return value.apply(target, args); } : value;
        } });
        const a = f.auto('A', { client, pollMs: 20 }), status = await a.start();
        assert.equal(status.phase, 'conflict'); assert.equal(status.error, 'DRIFT');
        assert.equal(status.leaseRelease, 'unconfirmed'); assert.equal(status.writable, false);
        const calls = requests;
        await new Promise(resolve => setTimeout(resolve, 80)); await a.tick();
        assert.equal(requests, calls); assert.equal(releases, 1);
        assert.equal(f.hub.getProject(global).lease === null, committed);
        assert.equal(fs.readFileSync(path.join(f.p.root, 'a.txt'), 'utf8'), 'unpublished bytes');
    });
}

test('corrupt pre-existing snapshot with incoming hash cannot be silently reused', t => {
    const f = fixture(t), next = change(f), decoded = C.decode(next.bytes);
    const old = new Set(C.decode(f.base.bytes).blobs.map(b => b.hash));
    const incoming = decoded.blobs.find(b => !old.has(b.hash));
    assert.ok(incoming);
    f.A.db.prepare('INSERT INTO blobs VALUES (?,?,?)').run(incoming.hash, incoming.size,
        require('node:zlib').gzipSync(Buffer.from('bad retained bytes')));
    assert.throws(() => f.A.db.transaction(() => C.applyMetadata(f.A, f.p.id, f.base.bytes, next.bytes)).immediate(),
        code('CORRUPT_BLOB'));
    assert.equal(f.A.projectStats(f.p.id).nodeCount, 1);
    assert.equal(f.A.getTodoBySeq(f.p.id, 2).status, 'pending');
});
for (const collision of ['directory-at-file', 'file-at-parent']) {
    test('directory structure collision halts retries and releases lease: ' + collision, async t => {
        const f = await networkFixture(t), a = f.auto('A'); await a.start(); await a.handoff();
        const global = a.globalId; await a.stop();
        const b = f.auto('B', { globalProjectId: global, target: f.target }); await b.start();
        await f.forge.B.processToolCall({ command: 'CreateFile', projectId: b.localId,
            path: 'nested/new.txt', content: 'remote', reason: 'new nested file' });
        await b.handoff(); await b.stop();
        if (collision === 'directory-at-file') fs.mkdirSync(path.join(f.p.root, 'nested/new.txt'), { recursive: true });
        else fs.writeFileSync(path.join(f.p.root, 'nested'), 'local parent file');
        const resumed = f.auto('A', { pollMs: 20 }), status = await resumed.start();
        assert.equal(status.phase, 'conflict'); assert.equal(status.writable, false);
        assert.equal(status.leaseRelease, 'released'); assert.equal(resumed.running, false);
        assert.equal(f.hub.getProject(global).lease, null);
        if (collision === 'directory-at-file') assert.ok(fs.statSync(path.join(f.p.root, 'nested/new.txt')).isDirectory());
        else assert.equal(fs.readFileSync(path.join(f.p.root, 'nested'), 'utf8'), 'local parent file');
        assert.equal(f.A.getProject(f.p.id).id, f.p.id);
    });
}