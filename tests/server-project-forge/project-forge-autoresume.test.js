'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const plugin = path.resolve(__dirname, '../../Plugin/ServerProjectForge');
const { ProjectStore } = require(path.join(plugin, 'store'));
const { ProjectTakeover } = require(path.join(plugin, 'projectTakeover'));
const { HubContentStore } = require(path.join(plugin, 'hubContentStore'));
const { HubStore } = require(path.join(plugin, 'hubStore'));
const { HubNetworkServer } = require(path.join(plugin, 'hubNetworkServer'));
const { HubNetworkClient } = require(path.join(plugin, 'hubNetworkClient'));
const { ProjectNetworkSync } = require(path.join(plugin, 'projectNetworkSync'));
const { ProjectAutoResume } = require(path.join(plugin, 'projectAutoResume'));
const W = require(path.join(plugin, 'projectWriteGate'));
const code = c => e => e.code === c;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
    const end = performance.now() + 6000;
    while (performance.now() < end) { const value = await fn(); if (value) return value; await sleep(20); }
    throw Error('condition timeout');
}
function freshForge() {
    const filename = require.resolve(path.join(plugin, 'ProjectForgeService'));
    delete require.cache[filename]; return require(filename);
}
function wrap(client, overrides) {
    return new Proxy(client, { get(target, k) {
        if (Object.hasOwn(overrides, k)) return overrides[k];
        const v = Reflect.get(target, k); return typeof v === 'function' ? v.bind(target) : v;
    } });
}
async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-auto-'));
    const A = freshForge(), B = freshForge();
    const config = side => ({ dbPath: path.join(root, side + '.db'),
        config: { WORKSPACES: side + '|' + path.join(root, side), ACTIVE_WORKSPACE: side, AST_INDEX_ENABLED: false },
        trash: async file => { fs.renameSync(file, path.join(root, 'trash-' + crypto.randomUUID())); },
        logger: { log() {}, warn() {}, error() {} } });
    fs.mkdirSync(path.join(root, 'A')); fs.mkdirSync(path.join(root, 'B'));
    A.initialize(config('A')); B.initialize(config('B'));
    const p = (await A.processToolCall({ command: 'CreateProject', name: 'synthetic-auto', dir: 'source', todos: 'first\nsecond' })).details.project;
    await A.processToolCall({ command: 'CreateFile', projectId: p.id, path: 'a.txt', content: '\uFEFF中文\r\n', reason: 'synthetic seed' });
    const source = A._test.getRuntime().store;
    // Initialize receiver and store identities BEFORE authorizing the synthetic fixed Hub.
    await B.processToolCall({ command: 'ListProjects' });
    const receiver = B._test.getRuntime().store;
    const paths = side => ({ journalPath: path.join(root, side + '-journal.db'), mappingPath: path.join(root, side + '-mapping.db') });
    const ta = new ProjectTakeover(source, paths('A').journalPath), originId = ta.storeId; ta.close();
    const content = new HubContentStore(path.join(root, 'content.db'));
    const hub = new HubStore(path.join(root, 'hub.db'), { contentStore: content });
    const secrets = { A: crypto.randomBytes(32).toString('base64url'), B: crypto.randomBytes(32).toString('base64url') };
    const server = new HubNetworkServer(hub, path.join(root, 'network.db'), { principals: [
        { token: secrets.A, deviceId: 'A', originIds: [originId], projectIds: [], permissions: ['read', 'write', 'register'] },
        { token: secrets.B, deviceId: 'B', originIds: [originId], projectIds: [], permissions: ['read', 'write'] },
    ] });
    const endpoint = await server.listen();
    const client = side => new HubNetworkClient(endpoint.baseUrl, { token: secrets[side], deviceId: side, hubId: hub.getHubId() });
    const ca = client('A'), cb = client('B'), opened = [], autos = [];
    const sync = (side, opts = {}) => {
        const s = new ProjectNetworkSync(side === 'A' ? source : receiver, paths(side).journalPath, paths(side).mappingPath,
            { client: side === 'A' ? ca : cb, ...opts }); opened.push(s); return s;
    };
    const auto = (side, opts = {}) => {
        const a = new ProjectAutoResume(side === 'A' ? source : receiver, {
            client: side === 'A' ? ca : cb, ...paths(side), ttlMs: 10000, pollMs: 20, checkpointMs: 20, safetyMs: 100,
            ...(side === 'A' ? { localProjectId: p.id } : {}), ...opts,
        }); autos.push(a); return a;
    };
    t.after(async () => {
        for (const a of autos.reverse()) await a.stop();
        for (const s of opened) s.close();
        await A.cleanup(); await B.cleanup(); await server.close(); hub.close(); content.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, A, B, source, receiver, p, ca, cb, hub, content, server, endpoint, secrets, originId,
        paths, sync, auto, config, target: { root: path.join(root, 'B', 'incoming'), workspaceAlias: 'B', subpath: 'incoming' } };
}
async function registered(f, opts = {}) {
    const s = f.sync('A', opts), m = await s.registerLocal(f.p.id);
    const lease = await f.ca.acquireLease({ projectId: m.globalProjectId, requestId: 'lease-test', ttlMs: 10000 });
    return { s, m, lease, args: { globalProjectId: m.globalProjectId, lease, expectedRevision: 0, requestId: 'fixed-publication' } };
}
test('normal Forge writes auto-publish -> safe handoff -> B startup restores same identity/Todo/history and continues', async t => {
    const f = await fixture(t);
    const a = f.auto('A'); assert.equal((await a.start()).writable, true);
    await f.A.processToolCall({ command: 'EditCode', projectId: f.p.id, path: 'a.txt', target: '中文', replace: '自动接续', reason: 'real tool edit' });
    await f.A.processToolCall({ command: 'UpdateTodos', projectId: f.p.id, done: '1' });
    await until(() => f.hub.getProject(a.globalId).revision > 0);
    const h = await a.handoff(); assert.equal(h.released, true);
    await assert.rejects(f.A.processToolCall({ command: 'CreateFile', projectId: f.p.id, path: 'late.txt', content: 'no', reason: 'late' }));
    const b = f.auto('B', { globalProjectId: a.globalId, target: f.target });
    assert.equal((await b.start()).writable, true);
    assert.equal(b.globalId, a.globalId); assert.notEqual(b.localId, f.p.id);
    assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), Buffer.from('\uFEFF自动接续\r\n'));
    assert.equal(f.receiver.listTodos(b.localId)[0].status, 'done');
    assert.equal(f.receiver.projectStats(b.localId).nodeCount, f.source.projectStats(f.p.id).nodeCount);
    await f.B.processToolCall({ command: 'CreateFile', projectId: b.localId, path: 'continued.txt', content: 'B', reason: 'continue' });
    await until(() => f.hub.getProject(a.globalId).revision > h.revision);
    assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_projects').get().n, 1);
    assert.equal(f.receiver.listProjects().length, 1);
});
test('B automatic polling waits for live A writer without creating a directory then resumes after release', async t => {
    const f = await fixture(t), a = f.auto('A'); await a.start();
    await until(() => f.hub.getProject(a.globalId).revision > 0);
    const b = f.auto('B', { globalProjectId: a.globalId, target: f.target });
    assert.equal((await b.start()).writable, false); assert.equal(fs.existsSync(f.target.root), false);
    await a.handoff();
    await until(() => b.status().writable);
    assert.equal(f.receiver.listProjects().length, 1);
});
test('checkpoint is durably frozen BEFORE first upload; retry never incorporates later edits', async t => {
    const f = await fixture(t); let stopped = false;
    const r = await registered(f, { _testHook: event => { if (event === 'checkpoint-frozen' && !stopped) { stopped = true; throw Error('freeze stop'); } } });
    await assert.rejects(r.s.publishLocal(r.args), /freeze stop/);
    assert.equal(f.content.db.prepare('SELECT count(*) n FROM content_bundles').get().n, 0);
    assert.equal(r.s.db.prepare('SELECT count(*) n FROM sync_payloads').get().n, 1);
    await f.A.processToolCall({ command: 'EditCode', projectId: f.p.id, path: 'a.txt', target: '中文', replace: 'later', reason: 'later edit' });
    await r.s.publishLocal(r.args);
    await f.sync('B').receive({ globalProjectId: r.m.globalProjectId, requestId: 'receive', target: f.target });
    assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), Buffer.from('\uFEFF中文\r\n'));
    assert.equal(r.s.db.prepare('SELECT count(*) n FROM sync_payloads').get().n, 0);
});
test('publication response lost after remote COMMIT reconciles read-only after lease release', async t => {
    const f = await fixture(t);
    const client = wrap(f.ca, { publishRevision: async args => { await f.ca.publishRevision(args); throw Object.assign(Error('reply lost'), { code: 'NETWORK_ERROR' }); } });
    const r = await registered(f, { client });
    await assert.rejects(r.s.publishLocal(r.args), code('NETWORK_ERROR'));
    assert.equal(f.hub.getProject(r.m.globalProjectId).revision, 1);
    await f.ca.releaseLease(r.lease);
    assert.equal((await r.s.reconcilePublication(r.args.requestId)).revision, 1);
    assert.equal(f.hub.getProject(r.m.globalProjectId).revision, 1);
});
test('frozen uncommitted checkpoint survives reopen and retries same bytes under newer fence', async t => {
    const f = await fixture(t), r = await registered(f, { _testHook: e => { if (e === 'checkpoint-frozen') throw Error('stop'); } });
    await assert.rejects(r.s.publishLocal(r.args), /stop/);
    r.s.close(); await f.ca.releaseLease(r.lease);
    const lease = await f.ca.acquireLease({ projectId: r.m.globalProjectId, requestId: 'new-generation', ttlMs: 10000 });
    const reopened = f.sync('A');
    assert.equal((await reopened.publishLocal({ ...r.args, lease })).revision, 1);
    assert.equal(lease.fence, r.lease.fence + 1);
});
test('SQL failure recording remote publish keeps frozen bytes; same request restores local accounting', async t => {
    const f = await fixture(t), r = await registered(f);
    r.s.db.exec("CREATE TRIGGER reject_ack BEFORE UPDATE ON sync_publications BEGIN SELECT RAISE(ABORT,'ack failure'); END");
    await assert.rejects(r.s.publishLocal(r.args), /ack failure/);
    assert.equal(f.hub.getProject(r.m.globalProjectId).revision, 1);
    assert.equal(r.s.getMapping(r.m.globalProjectId).revision, 0);
    r.s.db.exec('DROP TRIGGER reject_ack');
    await r.s.reconcilePublication(r.args.requestId);
    assert.equal(r.s.getMapping(r.m.globalProjectId).revision, 1);
});
test('WriterGate strict monotonic deadline aborts cooperative worker and rejects further writes', async () => {
    let now = 0; const gate = new W.WriterGate({ now: () => now, safetyMs: 10 });
    gate.grant({ fence: 1 }, 0, 100);
    await gate.run(async signal => { gate.assert(); now = 90; assert.throws(() => gate.assert()); assert.equal(signal.aborted, true); });
    assert.equal(gate.status().writable, false); gate.close();
});
test('seal immediately rejects new entries but drains admitted async operation before freezing', async () => {
    const gate = new W.WriterGate(); gate.grant({ fence: 1 }, performance.now(), 5000);
    let finish; const ready = new Promise(r => { finish = r; });
    const operation = gate.run(async () => { await ready; gate.assert(); });
    gate.seal(); await assert.rejects(gate.run(async () => {}));
    const draining = gate.drain(); assert.equal(gate.active, 1); finish(); await operation; await draining;
    assert.equal(gate.phase, 'frozen'); gate.reopen(); gate.close();
});
test('drain timeout closes gate and cannot resurrect old active writer under a new grant', async () => {
    const gate = new W.WriterGate({ drainMs: 30 }); gate.grant({ fence: 1 }, performance.now(), 5000);
    let finish; const op = gate.run(() => new Promise(r => { finish = r; }));
    await assert.rejects(gate.drain(), code('WRITER_DRAIN_TIMEOUT'));
    assert.throws(() => gate.grant({ fence: 2 }, performance.now(), 5000), code('WRITER_ACTIVE'));
    finish(); await op; gate.close();
});
test('second Store connection defaults to no writer; bulk mutation preflights every ID', async t => {
    const f = await fixture(t), a = f.auto('A'); await a.start();
    const other = new ProjectStore(path.join(f.root, 'A.db'));
    try {
        assert.throws(() => other.addTodos(f.p.id, ['bypass']), code('WRITE_LEASE_REQUIRED'));
        const ordinary = other.createProject({ name: 'ordinary', root: path.join(f.root, 'unbound'), workspaceAlias: 'other' });
        assert.throws(() => other.softDeleteProjects([ordinary.id, f.p.id]), code('WRITE_LEASE_REQUIRED'));
        assert.equal(other.getProject(ordinary.id).deleted_at, null);
        assert.equal(other.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '5');
    } finally { other.close(); }
});
test('ordinary directory rebinding/create and bound delete cannot bypass single-project scope', async t => {
    const f = await fixture(t), a = f.auto('A'); await a.start();
    assert.throws(() => f.source.createProject({ name: 'bypass', root: path.join(f.p.root, 'child'), workspaceAlias: 'A' }), code('WRITE_SCOPE'));
    const ordinary = f.source.createProject({ name: 'ordinary', root: path.join(f.root, 'unbound'), workspaceAlias: 'A' });
    assert.throws(() => f.source.updateProject(ordinary.id, { root: f.p.root }), code('WRITE_SCOPE'));
    await assert.rejects(f.A.processToolCall({ command: 'DeleteProjects', projectIds: f.p.id }), code('WRITE_BINDING'));
});
test('network uncertainty closes normal tools, GUI and Store mutation without leaking lease credentials', async t => {
    const f = await fixture(t), a = f.auto('A'); await a.start(); a.gate.lose();
    await assert.rejects(f.A.processToolCall({ command: 'CreateFile', projectId: f.p.id, path: 'no.txt', content: 'no', reason: 'blocked' }));
    assert.throws(() => f.A.gui.deleteProject(f.p.id));
    assert.throws(() => f.source.updateTodo(f.p.id, 1, { status: 'done' }));
    assert.equal(JSON.stringify(a.status()).includes(a.lease.leaseId), false);
    assert.equal(fs.existsSync(path.join(f.p.root, 'no.txt')), false);
});
test('open capture prevents final handoff and lease release; explicit stop is not a successful handoff', async t => {
    const f = await fixture(t), a = f.auto('A', { checkpointMs: 600000 }); await a.start();
    await f.A.processToolCall({ command: 'BeginCapture', projectId: f.p.id, paths: 'a.txt', requestId: 'external', reason: 'external worker' });
    await assert.rejects(a.handoff(), code('OPEN_CAPTURE'));
    assert.equal(a.status().writable, false); assert.equal(f.hub.getProject(a.globalId).lease.holder, 'A');
});
test('handoff signals cooperative Worker and awaits actual completion before publishing/releasing', async t => {
    const f = await fixture(t), a = f.auto('A', { checkpointMs: 600000 }); await a.start();
    let exited = false;
    const worker = a.runWorker(signal => new Promise(resolve => signal.addEventListener('abort', () => {
        setTimeout(() => { exited = true; resolve(); }, 20);
    }, { once: true })));
    const result = await a.handoff(); await worker;
    assert.equal(exited, true); assert.equal(result.released, true);
});
test('existing target stays untouched and receiver never becomes writable', async t => {
    const f = await fixture(t), a = f.auto('A'); await a.start(); await a.handoff();
    fs.mkdirSync(f.target.root); fs.writeFileSync(path.join(f.target.root, 'sentinel'), 'keep');
    const b = f.auto('B', { globalProjectId: a.globalId, target: f.target });
    assert.equal((await b.start()).writable, false);
    assert.equal(fs.readFileSync(path.join(f.target.root, 'sentinel'), 'utf8'), 'keep');
});
test('same process cannot open two automatic owners for one mapping', async t => {
    const f = await fixture(t), a = f.auto('A'); await a.start();
    assert.throws(() => f.auto('A'), code('AUTO_ALREADY_RUNNING'));
});
test('normal host startAutoResume and cleanup perform final publish/release without a new tool platform', async t => {
    const f = await fixture(t);
    const status = await f.A.startAutoResume({ client: f.ca, ...f.paths('A'), localProjectId: f.p.id,
        ttlMs: 10000, pollMs: 1000, checkpointMs: 600000 });
    assert.equal(status.writable, true);
    await f.A.processToolCall({ command: 'UpdateTodos', projectId: f.p.id, done: '2' });
    await f.A.cleanup();
    assert.equal(f.hub.getProject(status.globalProjectId).lease, null);
    assert.equal(f.hub.getProject(status.globalProjectId).revision, 1);
});
test('renewal transport failure closes writer immediately and aborts an admitted Worker', async t => {
    const f = await fixture(t); let failRenew = false;
    const client = wrap(f.ca, { renewLease: args => failRenew
        ? Promise.reject(Object.assign(Error('synthetic network loss'), { code: 'NETWORK_ERROR' }))
        : f.ca.renewLease(args) });
    const a = f.auto('A', { client, pollMs: 1000, checkpointMs: 600000 }); await a.start();
    let aborted = false;
    const worker = a.runWorker(signal => new Promise(resolve => signal.addEventListener('abort', () => {
        aborted = true; resolve();
    }, { once: true })));
    failRenew = true; a.lastRenew = -100000;
    await assert.rejects(a.tick(), code('NETWORK_ERROR')); await worker;
    assert.equal(aborted, true); assert.equal(a.status().writable, false);
    assert.throws(() => f.source.addTodos(f.p.id, ['must reject']));
});
test('reopened automatic controller starts closed and only renew-confirmed grant restores write access', async t => {
    const f = await fixture(t), a = f.auto('A', { pollMs: 1000, checkpointMs: 600000 });
    await a.start(); const global = a.globalId; await a.stop(); await a.stop();
    assert.throws(() => f.source.addTodos(f.p.id, ['stopped']));
    const again = f.auto('A', { pollMs: 1000, checkpointMs: 600000 });
    assert.equal(again.status().writable, false); assert.equal((await again.start()).writable, true);
    assert.equal(again.globalId, global);
});
test('normal CreateFile rechecks authorization after async mkdir before live write', async t => {
    const f = await fixture(t), a = f.auto('A', { pollMs: 1000, checkpointMs: 600000 }); await a.start();
    const mkdir = fs.promises.mkdir, destination = path.join(f.p.root, 'nested');
    fs.promises.mkdir = async function (dir, ...rest) {
        const result = await mkdir.call(this, dir, ...rest);
        if (dir === destination) a.gate.lose();
        return result;
    };
    try {
        await assert.rejects(f.A.processToolCall({ command: 'CreateFile', projectId: f.p.id,
            path: 'nested/no.txt', content: 'must not exist', reason: 'async lost lease' }));
        assert.equal(fs.existsSync(path.join(destination, 'no.txt')), false);
    } finally { fs.promises.mkdir = mkdir; }
});
test('GUI backup await cannot bypass a lease lost before live rollback', async t => {
    const f = await fixture(t), a = f.auto('A', { pollMs: 1000, checkpointMs: 600000 }); await a.start();
    const edited = await f.A.processToolCall({ command: 'EditCode', projectId: f.p.id,
        path: 'a.txt', target: '中文', replace: 'keep', reason: 'newer content' });
    const write = fs.promises.writeFile;
    fs.promises.writeFile = async function (file, ...rest) {
        const result = await write.call(this, file, ...rest);
        if (String(file).includes('revert-') && String(file).endsWith('.bak')) a.gate.lose();
        return result;
    };
    try {
        await assert.rejects(f.A.gui.revertFileChange({ projectId: f.p.id, nodeId: edited.details.nodeId,
            signature: 'Kerr', force: true }));
        assert.deepEqual(fs.readFileSync(path.join(f.p.root, 'a.txt')), Buffer.from('\uFEFFkeep\r\n'));
    } finally { fs.promises.writeFile = write; }
});
test('handoff drains Worker finishing its already-admitted Capture before open-capture check', async t => {
    const f = await fixture(t), a = f.auto('A', { pollMs: 1000, checkpointMs: 600000 }); await a.start();
    let notify;
    const admitted = new Promise(resolve => { notify = resolve; });
    const worker = a.runWorker(async signal => {
        const capture = await f.A.processToolCall({ command: 'BeginCapture', projectId: f.p.id,
            paths: 'a.txt', requestId: 'worker-final', reason: 'cooperative worker' });
        notify();
        await new Promise(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', resolve, { once: true });
        });
        fs.writeFileSync(path.join(f.p.root, 'a.txt'), Buffer.from('\uFEFFWorker done\r\n'));
        await f.A.processToolCall({ command: 'FinishCapture', projectId: f.p.id,
            requestId: 'worker-final' });
        return capture;
    });
    await admitted; const result = await a.handoff(); await worker;
    assert.equal(result.released, true);
    assert.equal(f.source.db.prepare("SELECT count(*) n FROM captures WHERE status='open'").get().n, 0);
    assert.equal(f.source.lastBatch(f.p.id).kind, 'external');
});
test('wrapped host initialize starts enabled controller and refuses reinitialize while startup is pending', async t => {
    const f = await fixture(t); await f.A.cleanup();
    f.A.initialize({ ...f.config('A'), autoResume: { client: f.ca, ...f.paths('A'), localProjectId: f.p.id,
        ttlMs: 10000, pollMs: 1000, checkpointMs: 600000 } });
    assert.throws(() => f.A.initialize(f.config('A')), /AUTO_CLEANUP_REQUIRED/);
    await f.A._test.getRuntime().autoStart;
    assert.equal(f.A.autoResumeStatus().writable, true);
    await f.A.cleanup(); assert.equal(f.A._test.getRuntime().store, null);
});
test('network mapping migration invalidates existing synchronous coordinator and rejects later synchronous open', async t => {
    const f = await fixture(t);
    const { ProjectSync } = require(path.join(plugin, 'projectSync'));
    const old = new ProjectSync(f.source, f.paths('A').journalPath, f.paths('A').mappingPath, { hub: f.hub, deviceId: 'A' });
    try {
        f.sync('A');
        assert.throws(() => old._entry(), code('SCHEMA_VERSION'));
        assert.throws(() => new ProjectSync(f.source, f.paths('A').journalPath, f.paths('A').mappingPath,
            { hub: f.hub, deviceId: 'A' }));
    } finally { old.close(); }
});
test('failed final host checkpoint still closes stoppable resources and reports failure, not handoff success', async t => {
    const f = await fixture(t);
    await f.A.startAutoResume({ client: f.ca, ...f.paths('A'), localProjectId: f.p.id,
        ttlMs: 10000, pollMs: 1000, checkpointMs: 600000 });
    await f.A.processToolCall({ command: 'BeginCapture', projectId: f.p.id,
        paths: 'a.txt', requestId: 'unfinished', reason: 'unfinished external' });
    await assert.rejects(f.A.cleanup(), code('OPEN_CAPTURE'));
    assert.equal(f.A._test.getRuntime().store, null);
});
async function crash(f, side, event, extra = {}) {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [path.join(__dirname, 'helpers/forgeAutoCrash.cjs')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PF_SYNTHETIC_CRASH: JSON.stringify({
            root: f.root, side, event, baseUrl: f.endpoint.baseUrl, token: f.secrets[side],
            hubId: f.hub.getHubId(), localProjectId: f.p.id, ...extra,
        }) }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-4096); });
    const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); }, 15000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (exit, signal) => { clearTimeout(timer); resolve({ exit, signal }); });
    });
    assert.equal(result.exit, 73, stderr); assert.equal(result.signal, null);
}
for (const event of ['origin-registered', 'checkpoint-frozen', 'revision-published']) {
    test('real sender process.exit(73) at ' + event + ' recovers automatically without duplicate identity/checkpoint', async t => {
        const f = await fixture(t); await crash(f, 'A', event);
        const a = f.auto('A', { pollMs: 1000, checkpointMs: 600000 });
        assert.equal(a.status().writable, false);
        assert.equal((await a.start()).writable, true);
        assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_projects').get().n, 1);
        assert.equal(a.sync.pendingPublications(a.globalId).length, 0);
        assert.equal(f.hub.getProject(a.globalId).revision, event === 'origin-registered' ? 0 : 1);
        assert.equal(a.sync.db.prepare('SELECT count(*) n FROM sync_payloads').get().n, 0);
    });
}
for (const event of ['mapping-planned', 'takeover-started', 'takeover:files-published', 'takeover-complete']) {
    test('real receiver process.exit(73) at ' + event + ' resumes same mapping/receipt/directory on startup', async t => {
        const f = await fixture(t), a = f.auto('A', { pollMs: 1000, checkpointMs: 600000 });
        await a.start(); await a.handoff();
        await crash(f, 'B', event, { globalProjectId: a.globalId, target: f.target });
        const b = f.auto('B', { globalProjectId: a.globalId, target: f.target, pollMs: 1000, checkpointMs: 600000 });
        assert.equal((await b.start()).writable, true);
        assert.equal(f.receiver.listProjects().length, 1);
        assert.equal(f.receiver.db.prepare('SELECT count(*) n FROM project_import_receipts').get().n, 1);
        assert.equal(b.sync.takeover.materializer.db.prepare('SELECT count(*) n FROM materialize_jobs').get().n, 1);
        assert.deepEqual(fs.readFileSync(path.join(f.target.root, 'a.txt')), Buffer.from('\uFEFF中文\r\n'));
    });
}
test('escaped async continuation from completed operation cannot write after gate is reopened', async () => {
    const gate = new W.WriterGate(); gate.grant({ fence: 1 }, performance.now(), 5000);
    let release, probe;
    await gate.run(() => {
        const pending = new Promise(resolve => { release = resolve; });
        probe = pending.then(() => assert.throws(() => gate.assert()));
    });
    gate.lose(); gate.grant({ fence: 1 }, performance.now(), 5000);
    release(); await probe; gate.close();
});
test('forged replacement fence cannot poison persisted frozen request', async t => {
    const f = await fixture(t), r = await registered(f, { _testHook: e => { if (e === 'checkpoint-frozen') throw Error('stop'); } });
    await assert.rejects(r.s.publishLocal(r.args), /stop/);
    await assert.rejects(r.s.publishLocal({ ...r.args, lease: { ...r.lease, fence: r.lease.fence + 100 } }));
    assert.equal(r.s._attempt(r.args.requestId).fence, r.lease.fence);
});
for (const patch of [{ workspaceAlias: 'other' }, { deletedAt: '2026-10-16T00:00:00.000Z' }]) {
    test('bound project rejects actual Store patch field ' + Object.keys(patch)[0], async t => {
        const f = await fixture(t), a = f.auto('A', { pollMs: 1000, checkpointMs: 600000 }); await a.start();
        const before = f.source.getProject(f.p.id);
        assert.throws(() => f.source.updateProject(f.p.id, patch), code('WRITE_BINDING'));
        assert.deepEqual(f.source.getProject(f.p.id), before);
    });
}
test('escaped old controller continuation cannot enter a replacement controller', async () => {
    const old = new W.WriterGate(), next = new W.WriterGate();
    old.grant({ fence: 1 }, performance.now(), 5000);
    next.grant({ fence: 1 }, performance.now(), 5000);
    let release, probe;
    await old.run(() => {
        probe = new Promise(resolve => { release = resolve; }).then(async () => {
            await assert.rejects(next.run(async () => {}));
        });
    });
    old.close(); release(); await probe; next.close();
});
function configuredHost(f, side, overrides = {}) {
    const tokenFile = path.join(f.root, side + '.synthetic-token');
    fs.writeFileSync(tokenFile, f.secrets[side], { flag: 'wx' });
    const filename = path.join(f.root, side + '-auto.json');
    const config = {
        version: 1, endpoint: f.endpoint.baseUrl, hubId: f.hub.getHubId(), deviceId: side,
        tokenFile, ...f.paths(side), ttlMs: 10000, pollMs: 1000, checkpointMs: 600000,
        ...(side === 'A' ? { localProjectId: f.p.id } : {}), ...overrides,
    };
    fs.writeFileSync(filename, JSON.stringify(config), { flag: 'wx' });
    const host = f.config(side);
    host.config.AUTORESUME_CONFIG_PATH = filename;
    return { filename, config, host };
}
test('flat server configuration installs closed gate before returning, then shutdown publishes/releases', async t => {
    const f = await fixture(t), c = configuredHost(f, 'A');
    await f.A.cleanup();
    const config = { ...c.host.config, PROJECTFORGE_DB_PATH: c.host.dbPath };
    const pending = f.A.initialize(config, { vcpLogFunctions: c.host.logger });
    const runtime = f.A._test.getRuntime();
    assert.ok(runtime.autoResume); assert.equal(runtime.autoResume.gate.phase, 'closed');
    assert.throws(() => runtime.store.addTodos(f.p.id, ['too early']), code('WRITE_LEASE_REQUIRED'));
    const ready = await pending; assert.equal(ready.writable, true);
    await f.A.processToolCall({ command: 'UpdateTodos', projectId: f.p.id, done: '1' });
    assert.equal(f.A.shutdown, f.A.cleanup);
    await f.A.shutdown();
    assert.equal(f.hub.getProject(ready.globalProjectId).lease, null);
    assert.equal(f.hub.getProject(ready.globalProjectId).revision, 1);
    assert.equal(f.A._test.getRuntime().store, null);
    await f.A.shutdown();
});
test('identical GUI/direct file-config initialization reuses controller; changed binding refuses', async t => {
    const f = await fixture(t), c = configuredHost(f, 'A');
    await f.A.cleanup();
    const pending = f.A.initialize(c.host);
    const controller = f.A._test.getRuntime().autoResume;
    const again = f.A.initialize({ ...c.host, app: {}, services: {} });
    assert.equal(f.A._test.getRuntime().autoResume, controller);
    assert.equal(again, pending); await again;
    assert.throws(() => f.A.initialize({ ...c.host, config: {
        ...c.host.config, AUTORESUME_CONFIG_PATH: path.join(f.root, 'other.json'),
    } }), /AUTO_CLEANUP_REQUIRED/);
    assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_projects').get().n, 1);
});
test('invalid configured startup fails closed without opening a project DB or leaking configuration', async t => {
    const f = await fixture(t); await f.A.cleanup();
    const bad = path.join(f.root, 'private-config.json');
    fs.writeFileSync(bad, '{"token":"synthetic-secret-DO-NOT-LOG"');
    const opts = f.config('A'); opts.config.AUTORESUME_CONFIG_PATH = bad;
    assert.throws(() => f.A.initialize(opts), code('AUTO_CONFIG_INVALID'));
    assert.equal(f.A._test.getRuntime().store, null);
    await assert.rejects(f.A.processToolCall({ command: 'ListProjects' }), /AUTO_CONFIG_INVALID/);
    assert.throws(() => f.A.ensureRuntime(opts), /AUTO_CONFIG_INVALID/);
    await f.A.cleanup();
});
test('configured receiver rejects target outside authorized workspace before network or import', async t => {
    const f = await fixture(t), a = f.auto('A', { pollMs: 1000, checkpointMs: 600000 });
    await a.start(); await a.handoff(); await f.B.cleanup();
    const c = configuredHost(f, 'B', { globalProjectId: a.globalId,
        target: { root: path.join(f.root, 'unauthorized', 'incoming'), workspaceAlias: 'B' } });
    assert.throws(() => f.B.initialize(c.host), code('AUTO_CONFIG_INVALID'));
    assert.equal(fs.existsSync(c.config.target.root), false);
    assert.equal(f.B._test.getRuntime().autoResume, null);
    await f.B.cleanup();
});
test('workspace disabled during remote download blocks receiver publication after await', async t => {
    const f = await fixture(t), a = f.auto('A', { pollMs: 1000, checkpointMs: 600000 });
    await a.start(); await a.handoff();
    let enabled = true;
    const opts = f.config('B');
    opts.services = { workspaceService: {
        list: () => [{ id: 'B-dynamic', alias: 'B', path: path.join(f.root, 'B'), enabled }],
        getActiveWorkspaceId: () => 'B-dynamic',
    } };
    opts.config.WORKSPACES = ''; await f.B.cleanup(); f.B.initialize(opts);
    const client = wrap(f.cb, { downloadRevision: async (...args) => {
        const value = await f.cb.downloadRevision(...args); enabled = false; return value;
    } });
    const status = await f.B.startAutoResume({ client, ...f.paths('B'), globalProjectId: a.globalId,
        target: f.target, ttlMs: 10000, pollMs: 1000, checkpointMs: 600000 });
    assert.equal(status.writable, false);
    assert.equal(fs.existsSync(f.target.root), false);
    assert.equal(f.B._test.getRuntime().store.listProjects().length, 0);
});
test('enabled writer rechecks current workspace permission before normal Forge mutation', async t => {
    const f = await fixture(t); let enabled = true;
    const opts = f.config('A'); opts.config.WORKSPACES = '';
    opts.services = { workspaceService: {
        list: () => [{ id: 'A-live', alias: 'A', path: path.join(f.root, 'A'), enabled }],
        getActiveWorkspaceId: () => 'A-live',
    } };
    await f.A.cleanup(); f.A.initialize(opts);
    const ready = await f.A.startAutoResume({ client: f.ca, ...f.paths('A'), localProjectId: f.p.id,
        ttlMs: 10000, pollMs: 1000, checkpointMs: 600000 });
    assert.equal(ready.writable, true); enabled = false;
    await assert.rejects(f.A.processToolCall({ command: 'UpdateTodos', projectId: f.p.id, done: '2' }));
    const store = f.A._test.getRuntime().store;
    assert.equal(store.listTodos(f.p.id)[1].status, 'pending');
    enabled = true; // Permit clean teardown of this synthetic host.
});
test('read-only catalog coexists with configured auto-resume without additional lease acquisition', async t => {
    const f = await fixture(t), c = configuredHost(f, 'A');
    const catalogPath = path.join(f.root, 'catalog-readonly.json');
    fs.writeFileSync(catalogPath, JSON.stringify({
        version: 1, endpoint: f.endpoint.baseUrl, hubId: f.hub.getHubId(),
        deviceId: 'A', tokenFile: c.config.tokenFile, read: true,
    }));
    c.host.config.CATALOG_CONFIG_PATH = catalogPath;
    await f.A.cleanup();
    const ready = f.A.initialize(c.host);
    const runtime = f.A._test.getRuntime();
    const controller = runtime.autoResume, catalog = runtime.catalog;
    assert.equal(controller.gate.phase, 'closed');
    assert.equal(catalog.publisher, null);
    assert.equal(f.A.initialize(c.host), ready);
    assert.equal(f.A._test.getRuntime().catalog, catalog);
    await ready;
    assert.equal((await f.A.whenAutoResumeReady()).writable, true);
    assert.equal(f.A.catalogStatus().read, true);
    assert.equal(f.A.catalogStatus().publisher.phase, 'disabled');
    assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_projects').get().n, 1);
    assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_lease_requests').get().n, 1);
    await f.A.processToolCall({ command: 'UpdateTodos', projectId: f.p.id, done: '1' });
    const globalId = controller.globalId;
    await f.A.cleanup();
    assert.equal(catalog.closed, true);
    assert.equal(catalog.browser.closed, true);
    assert.equal(f.hub.getProject(globalId).lease, null);
    assert.equal(f.hub.getProject(globalId).revision, 1);
    assert.equal(runtime.store, null);
    assert.equal(runtime.autoResume, null);
    assert.equal(runtime.catalog, null);
});

test('invalid catalog config prevents combined startup before auto-resume opens a store', async t => {
    const f = await fixture(t), c = configuredHost(f, 'A');
    const catalogPath = path.join(f.root, 'catalog-invalid.json');
    fs.writeFileSync(catalogPath, '{"version":');
    c.host.config.CATALOG_CONFIG_PATH = catalogPath;
    await f.A.cleanup();
    assert.throws(() => f.A.initialize(c.host), { code: 'CATALOG_CONFIG_INVALID' });
    const runtime = f.A._test.getRuntime();
    assert.equal(runtime.store, null);
    assert.equal(runtime.autoResume, null);
    assert.equal(runtime.autoStart, null);
    assert.equal(runtime.catalog, null);
    assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_projects').get().n, 0);
    assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_lease_requests').get().n, 0);
    await f.A.cleanup();
});
for (const immediateCleanup of [false, true]) {
    test('catalog host construction failure cancels queued auto startup: cleanup=' + immediateCleanup, async t => {
        const f = await fixture(t), c = configuredHost(f, 'A');
        const journalPath = path.join(f.root, 'broken-catalog.db');
        const original = Buffer.from('synthetic invalid SQLite, must remain intact');
        fs.writeFileSync(journalPath, original);
        const catalogPath = path.join(f.root, 'catalog-publish.json');
        fs.writeFileSync(catalogPath, JSON.stringify({
            version: 1, endpoint: f.endpoint.baseUrl, hubId: f.hub.getHubId(),
            deviceId: 'A', tokenFile: c.config.tokenFile, read: true,
            publish: { sourceId: 'plans-A', journalPath, allProjects: true },
        }));
        c.host.config.CATALOG_CONFIG_PATH = catalogPath;
        await f.A.cleanup();
        assert.throws(() => f.A.initialize(c.host), { code: 'CATALOG_CONFIG_INVALID' });
        const runtime = f.A._test.getRuntime();
        const controller = runtime.autoResume;
        assert.ok(controller);
        let identityCalls = 0;
        controller.client = wrap(controller.client, {
            identity: async () => { identityCalls++; throw Error('must not start network'); },
        });
        if (immediateCleanup) await f.A.cleanup();
        else {
            await runtime.autoStart;
            assert.equal(controller.stopped, true);
            await f.A.cleanup();
        }
        assert.equal(identityCalls, 0);
        assert.equal(controller.stopped, true);
        assert.equal(controller.running, false);
        assert.equal(runtime.store, null);
        assert.equal(runtime.autoResume, null);
        assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_projects').get().n, 0);
        assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_lease_requests').get().n, 0);
        assert.deepEqual(fs.readFileSync(journalPath), original);
    });
}