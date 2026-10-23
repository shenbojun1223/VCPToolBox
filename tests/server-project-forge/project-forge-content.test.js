'use strict';
// All bytes and databases are synthetic. No resident service, network or real configuration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const plugin = path.resolve(__dirname, '../../Plugin/ServerProjectForge');
const { ProjectStore } = require(path.join(plugin, 'store'));
const { exportProjectBundle } = require(path.join(plugin, 'projectBundle'));
const { HubContentStore } = require(path.join(plugin, 'hubContentStore'));
const { HubStore } = require(path.join(plugin, 'hubStore'));
const code = expected => e => e.code === expected;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-content-'));
    const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
    const source = new ProjectStore(path.join(root, 'source.db'));
    const project = source.createProject({ name: 'synthetic', root: sourceRoot, workspaceAlias: 'test' });
    const bytes = Buffer.from('\uFEFF可信内容\r\n');
    fs.writeFileSync(path.join(sourceRoot, 'a.txt'), bytes);
    const hash = source.putBlob(bytes), batch = source.createBatch(project.id, 'create', 'fixture', 'Kerr');
    source.addNode({ projectId: project.id, batchId: batch, filePath: 'a.txt', op: 'create', afterHash: hash, beforeHash: null });
    const bundle = exportProjectBundle(source, project.id);
    const contentPath = path.join(root, 'content.db');
    const content = new HubContentStore(contentPath, options), opened = [content];
    const open = opts => { const s = new HubContentStore(contentPath, opts); opened.push(s); return s; };
    t.after(() => { for (const s of opened) s.close(); source.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, contentPath, source, project, bundle, content, open, opened };
}
function put(f, content = f.content) { return content.put(f.bundle.bytes, { expectedHash: f.bundle.sha256 }); }
function altered(f, fn) {
    const data = JSON.parse(f.bundle.bytes); fn(data);
    const bytes = Buffer.from(JSON.stringify(data)); return { bytes, sha256: sha(bytes) };
}
test('complete validated bytes, identity and immutable copies survive reopen', t => {
    const f = fixture(t); put(f);
    const reopened = f.open();
    assert.equal(reopened.getId(), f.content.getId());
    assert.deepEqual(reopened.get(f.bundle.sha256), f.bundle.bytes);
    const copy = reopened.get(f.bundle.sha256); copy.fill(0);
    assert.deepEqual(reopened.get(f.bundle.sha256), f.bundle.bytes);
    assert.deepEqual(put(f, reopened), { hash: f.bundle.sha256, size: f.bundle.bytes.length, stored: true });
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM content_bundles').get().n, 1);
});
test('explicit hash and bounded Buffer are mandatory', t => {
    const f = fixture(t);
    for (const hash of [undefined, '../escape', 'A'.repeat(64)]) {
        assert.throws(() => f.content.put(f.bundle.bytes, { expectedHash: hash }), code('INVALID_ARGUMENT'));
        assert.throws(() => f.content.get(hash), code('INVALID_ARGUMENT'));
    }
    assert.throws(() => f.content.put(f.bundle.bytes.toString(), { expectedHash: f.bundle.sha256 }), code('LIMIT_EXCEEDED'));
    assert.throws(() => f.content.put(Buffer.alloc(96 * 1024 * 1024 + 1), { expectedHash: f.bundle.sha256 }), code('LIMIT_EXCEEDED'));
});
test('caller supplied digest is verified, never trusted', t => {
    const f = fixture(t);
    assert.throws(() => f.content.put(f.bundle.bytes, { expectedHash: '0'.repeat(64) }), code('HASH_MISMATCH'));
    assert.equal(f.content.db.prepare('SELECT count(*) AS n FROM content_bundles').get().n, 0);
});
for (const [name, mutate] of [
    ['unsafe portable path', data => { data.files[0].file_path = '../secret'; }],
    ['missing snapshot', data => { data.blobs = []; }],
    ['corrupt snapshot bytes', data => { data.blobs[0].base64 = Buffer.alloc(data.blobs[0].size).toString('base64'); }],
    ['unexpected payload fields', data => { data.untrusted = 'extra'; }],
]) test('invalid semantic bundle is not stored: ' + name, t => {
    const f = fixture(t), b = altered(f, mutate);
    assert.throws(() => f.content.put(b.bytes, { expectedHash: b.sha256 }));
    assert.equal(f.content.db.prepare('SELECT count(*) AS n FROM content_bundles').get().n, 0);
});
test('persistent count quota does not evict or reject identical retry', t => {
    const f = fixture(t, { maxBundles: 1 }); put(f); put(f);
    const b = altered(f, d => { d.project.name = 'second'; });
    assert.throws(() => f.open().put(b.bytes, { expectedHash: b.sha256 }), code('CAPACITY_EXCEEDED'));
    assert.deepEqual(f.content.get(f.bundle.sha256), f.bundle.bytes);
    assert.throws(() => f.open({ maxBundles: 2 }), code('QUOTA_MISMATCH'));
});
test('persistent byte quota rejects an entire package without a partial row', t => {
    const f = fixture(t, { maxTotalBytes: 1 });
    assert.throws(() => put(f), code('CAPACITY_EXCEEDED'));
    assert.equal(f.content.db.prepare('SELECT count(*) AS n FROM content_bundles').get().n, 0);
});
test('wrong database and unknown schema are refused', t => {
    const f = fixture(t); const wrong = path.join(f.root, 'wrong.db');
    const db = new Database(wrong); db.exec('CREATE TABLE ordinary(x)'); db.close();
    assert.throws(() => new HubContentStore(wrong), code('WRONG_DATABASE'));
    f.content.db.prepare("UPDATE content_meta SET value='999' WHERE key='schema_version'").run();
    assert.throws(() => f.open(), code('SCHEMA_VERSION'));
});
test('closed content capability fails without returning bytes', t => {
    const f = fixture(t); f.content.close();
    assert.throws(() => f.content.getId(), code('CLOSED'));
    assert.throws(() => f.content.get(f.bundle.sha256), code('CLOSED'));
});
test('same-length tampering is detected on download and duplicate upload', t => {
    const f = fixture(t); put(f);
    const bad = Buffer.from(f.bundle.bytes); bad[bad.indexOf(Buffer.from('synthetic'))] ^= 1;
    f.content.db.prepare('UPDATE content_bundles SET data=? WHERE hash=?').run(bad, f.bundle.sha256);
    assert.throws(() => f.content.get(f.bundle.sha256), code('HASH_MISMATCH'));
    assert.throws(() => put(f), code('HASH_MISMATCH'));
});
test('source metadata tampering is detected', t => {
    const f = fixture(t); put(f);
    f.content.db.prepare("UPDATE content_bundles SET source_project_id='wrong'").run();
    assert.throws(() => f.content.get(f.bundle.sha256), code('CORRUPT_CONTENT'));
});
test('SQL failure rolls back the complete upload', t => {
    const f = fixture(t);
    f.content.db.exec("CREATE TRIGGER reject_content BEFORE INSERT ON content_bundles BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => put(f), /injected/);
    assert.equal(f.open().db.prepare('SELECT count(*) AS n FROM content_bundles').get().n, 0);
});
for (const event of ['content-inserted', 'content-committed']) {
    test('real process.exit recovery at ' + event, t => {
        const f = fixture(t);
        const bundlePath = path.join(f.root, 'bundle.json'); fs.writeFileSync(bundlePath, f.bundle.bytes);
        const child = spawnSync(process.execPath, ['-e', `
            const fs=require('node:fs');
            const {HubContentStore}=require(${JSON.stringify(path.join(plugin, 'hubContentStore'))});
            const c=new HubContentStore(${JSON.stringify(f.contentPath)},{_testHook:e=>{if(e===${JSON.stringify(event)})process.exit(73)}});
            c.put(fs.readFileSync(${JSON.stringify(bundlePath)}),{expectedHash:${JSON.stringify(f.bundle.sha256)}});
        `], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
        assert.equal(child.status, 73, child.stderr);
        const reopened = f.open();
        assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM content_bundles').get().n, event === 'content-inserted' ? 0 : 1);
        put(f, reopened); assert.deepEqual(reopened.get(f.bundle.sha256), f.bundle.bytes);
    });
}
test('four independent SQLite connections enforce one quota slot', async t => {
    const f = fixture(t, { maxBundles: 1 });
    const workers = Array.from({ length: 4 }, (_, i) => new Worker(`
        const {parentPort,workerData:d}=require('node:worker_threads');
        const crypto=require('node:crypto');
        const {HubContentStore}=require(d.module);
        const bytes=Buffer.from(d.bytes);const data=JSON.parse(bytes);data.project.name='race-'+d.i;
        const b=Buffer.from(JSON.stringify(data)),hash=crypto.createHash('sha256').update(b).digest('hex');
        const c=new HubContentStore(d.db);
        try{c.put(b,{expectedHash:hash});parentPort.postMessage('ok')}
        catch(e){parentPort.postMessage(e.code)}finally{c.close()}
    `, { eval: true, workerData: { module: path.join(plugin, 'hubContentStore'), db: f.contentPath, bytes: f.bundle.bytes, i } }));
    const values = await Promise.all(workers.map(w => new Promise((resolve, reject) => {
        let received = false, value;
        const timer = setTimeout(() => { reject(Error('Worker did not exit within 30s')); void w.terminate(); }, 30000);
        w.once('message', message => { received = true; value = message; });
        w.once('error', error => { clearTimeout(timer); reject(error); });
        w.once('exit', status => {
            clearTimeout(timer);
            if (status === 0 && received) resolve(value);
            else reject(Error('Worker exited without successful result: ' + status));
        });
    })));
    assert.equal(values.filter(v => v === 'ok').length, 1);
    assert.deepEqual(values.filter(v => v !== 'ok'), Array(3).fill('CAPACITY_EXCEEDED'));
});
function bound(t, options = {}) {
    const f = fixture(t);
    const hub = new HubStore(path.join(f.root, 'hub.db'), { contentStore: f.content, ...options }); f.opened.push(hub);
    const project = hub.registerProject({ originId: 'receiver-A', localProjectId: f.project.id, name: 'synthetic' });
    const lease = hub.acquireLease({ projectId: project.id, holder: 'A', requestId: 'lease-1', ttlMs: 1000 });
    const publish = args => hub.publishRevision({ ...lease, requestId: 'pub-1', expectedRevision: 0, bundleHash: f.bundle.sha256, ...args });
    return { ...f, hub, global: project, lease, publish };
}
test('upload is not publication; missing content cannot advance a revision', t => {
    const f = bound(t);
    assert.throws(() => f.publish(), code('CONTENT_NOT_FOUND'));
    assert.equal(f.hub.getProject(f.global.id).revision, 0);
    put(f); assert.equal(f.hub.getProject(f.global.id).revision, 0);
    const r = f.publish(); assert.equal(r.revision, 1);
    assert.deepEqual(f.hub.downloadRevision(f.global.id, 1).bytes, f.bundle.bytes);
    assert.throws(() => f.hub.downloadRevision(f.global.id, 2), code('NOT_FOUND'));
});
test('bound Hub cannot reopen without content or with another content identity', t => {
    const f = bound(t), dbPath = path.join(f.root, 'hub.db'); put(f); f.publish();
    assert.throws(() => new HubStore(dbPath), code('CONTENT_REQUIRED'));
    const other = new HubContentStore(path.join(f.root, 'other.db')); f.opened.push(other);
    assert.throws(() => new HubStore(dbPath, { contentStore: other }), code('CONTENT_BINDING'));
    const reopened = new HubStore(dbPath, { contentStore: f.open() }); f.opened.push(reopened);
    assert.equal(reopened.getHubId(), f.hub.getHubId());
});
test('content corruption blocks publish replay as well as download', t => {
    const f = bound(t); put(f); f.publish();
    f.content.db.prepare("UPDATE content_bundles SET source_project_id='bad'").run();
    assert.throws(() => f.publish(), code('CORRUPT_CONTENT'));
    assert.throws(() => f.hub.downloadRevision(f.global.id, 1), code('CORRUPT_CONTENT'));
    assert.equal(f.hub.getProject(f.global.id).revision, 1);
});
test('stale writers cannot publish uploaded content or replay a formerly accepted revision', t => {
    let now = 10000; const f = bound(t, { clock: () => now }); put(f); f.publish();
    now += 1000;
    const next = f.hub.acquireLease({ projectId: f.global.id, holder: 'B', requestId: 'lease-2', ttlMs: 1000 });
    assert.throws(() => f.publish(), code('STALE_LEASE'));
    assert.equal(f.hub.publishRevision({ ...next, requestId: 'pub-2', expectedRevision: 1, bundleHash: f.bundle.sha256 }).revision, 2);
    assert.throws(() => f.hub.publishRevision({ ...next, requestId: 'bad-base', expectedRevision: 1, bundleHash: f.bundle.sha256 }), code('REVISION_CONFLICT'));
});
test('schema1 binding requires all previously published content and rolls migration back on failure', t => {
    const f = fixture(t), dbPath = path.join(f.root, 'legacy-hub.db');
    const clock = () => 10000;
    const old = new HubStore(dbPath, { clock }); f.opened.push(old);
    const g = old.registerProject({ originId: 'A', localProjectId: 'p1', name: 'legacy' });
    const lease = old.acquireLease({ projectId: g.id, holder: 'A', requestId: 'acq', ttlMs: 1000 });
    old.publishRevision({ ...lease, requestId: 'pub', expectedRevision: 0, bundleHash: f.bundle.sha256 });
    assert.throws(() => new HubStore(dbPath, { contentStore: f.content, clock }), code('CONTENT_NOT_FOUND'));
    assert.equal(old.db.prepare("SELECT value FROM hub_meta WHERE key='schema_version'").get().value, '1');
    put(f);
    const migrated = new HubStore(dbPath, { contentStore: f.content, clock }); f.opened.push(migrated);
    assert.equal(migrated.db.prepare("SELECT value FROM hub_meta WHERE key='schema_version'").get().value, '2');
    // An already-open CURRENT implementation rechecks the durable mode before publication.
    assert.throws(() => old.publishRevision({ ...lease, requestId: 'pub2', expectedRevision: 1, bundleHash: f.bundle.sha256 }), code('CONTENT_REQUIRED'));
    assert.deepEqual(migrated.downloadRevision(g.id, 1).bytes, f.bundle.bytes);
});

test('caller transactions cannot claim durable content or publish uncommitted upload', t => {
    const f = bound(t);
    f.content.db.transaction(() => {
        assert.throws(() => put(f), code('INVALID_ARGUMENT'));
        assert.throws(() => f.content.getId(), code('INVALID_ARGUMENT'));
        assert.throws(() => f.publish(), code('INVALID_ARGUMENT'));
    }).immediate();
    assert.equal(f.hub.getProject(f.global.id).revision, 0);
    assert.equal(f.content.db.prepare('SELECT count(*) AS n FROM content_bundles').get().n, 0);
    put(f); assert.equal(f.publish().revision, 1);
});