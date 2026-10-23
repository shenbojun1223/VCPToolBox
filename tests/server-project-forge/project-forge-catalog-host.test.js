'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { CatalogHost } = require('../../Plugin/ServerProjectForge/catalogHost');
const { ProjectStore } = require('../../Plugin/ServerProjectForge/store');
const { CatalogSourceStore } = require('../../Plugin/ServerProjectForge/catalogSourceStore');
const W = require('../../Plugin/ServerProjectForge/projectWriteGate');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-catalog-host-'));
    const store = new ProjectStore(path.join(root, 'business.db'));
    const hubId = 'hub-11111111-2222-4333-8444-555555555555';
    const remote = new CatalogSourceStore(path.join(root, 'remote.db'), { hubId });
    const events = new EventEmitter(), hosts = [], calls = [];
    const client = { hubId, deviceId: 'A', async publishCatalogSource(request) {
        calls.push(request); return remote.publish({ ...request, deviceId: 'A' });
    } };
    const config = { client, read: true, publish: {
        sourceId: 'plans-A', allProjects: true,
        journalPath: path.join(root, 'journal.db'), intervalMs: 300000,
    } };
    const make = (extra = {}) => {
        const host = new CatalogHost({ config, events, getStore: () => store,
            authorize: () => true, ...extra });
        hosts.push(host); return host;
    };
    t.after(async () => {
        for (const host of hosts) await host.stop();
        store.close(); remote.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const project = store.createProject({ name: '已有计划', root: path.join(root, 'project'),
        workspaceAlias: 'fixture' });
    store.addTodos(project.id, ['first']);
    return { root, store, project, remote, events, client, config, make, calls };
}
test('read-only host never opens business store, subscribes or creates journal', async t => {
    const f = fixture(t);
    const host = f.make({
        config: { client: f.client, read: true, publish: null },
        getStore: () => { throw Error('read-only must not open DB'); },
    });
    await host.start();
    assert.equal(host.status().publisher.phase, 'disabled');
    assert.equal(f.events.listenerCount('changed'), 0);
    assert.equal(fs.existsSync(f.config.publish.journalPath), false);
    assert.equal(f.calls.length, 0);
});
test('host backfills existing plans and publishes changes without closing borrowed store', async t => {
    const f = fixture(t), host = f.make();
    assert.equal(f.calls.length, 0);
    await host.start(); await host.start();
    assert.equal(f.events.listenerCount('changed'), 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.remote.get('plans-A').snapshot.list().items.length, 1);
    f.store.updateTodo(f.project.id, 1, { status: 'done' });
    f.events.emit('changed', { projectId: f.project.id });
    await host.publisher.flush();
    const result = f.remote.get('plans-A');
    assert.equal(result.version, 2);
    assert.equal(result.snapshot.list().items[0].progress.done, 1);
    f.store.softDeleteProjects([f.project.id]);
    f.events.emit('changed');
    await host.publisher.flush();
    assert.ok(f.remote.get('plans-A').snapshot.list().items[0].deletedAt);
    const stop1 = host.stop(), stop2 = host.stop();
    assert.equal(stop1, stop2);
    await stop1;
    assert.equal(f.events.listenerCount('changed'), 0);
    assert.equal(host.journal.db, null);
    assert.equal(f.store.db.open, true);
    const count = f.calls.length;
    f.events.emit('changed');
    await host.publisher.flush();
    assert.equal(f.calls.length, count);
});
test('scope denial fails before journal creation or transport', t => {
    const f = fixture(t);
    assert.throws(() => f.make({ authorize: () => false }), { code: 'FORBIDDEN' });
    assert.equal(fs.existsSync(f.config.publish.journalPath), false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.events.listenerCount('changed'), 0);
});
test('restart refuses pending ordinary records that became globally bound', async t => {
    const f = fixture(t);
    const first = f.make();
    const original = f.client.publishCatalogSource;
    f.client.publishCatalogSource = async () => {
        throw Object.assign(Error('offline'), { code: 'NETWORK_ERROR' });
    };
    await first.start();
    const pending = first.journal.pending();
    assert.ok(pending);
    await first.stop();
    W.bind(f.store, f.project.id, {
        hubId: f.client.hubId, globalProjectId: 'g_11111111-2222-4333-8444-555555555555',
        mappingId: 'mapping-A',
    });
    f.client.publishCatalogSource = original;
    const restarted = f.make();
    await restarted.start();
    assert.equal(restarted.status().publisher.phase, 'blocked');
    assert.equal(restarted.status().publisher.lastError, 'FORBIDDEN');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(restarted.journal.pending(), pending);
});
test('changes during an in-flight publication are picked up on the next cycle', async t => {
    const f = fixture(t);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const original = f.client.publishCatalogSource;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.client.publishCatalogSource = async request => {
        entered(); await gate; return original(request);
    };
    const host = f.make(), running = host.start();
    await started;
    f.store.addTodos(f.project.id, ['second']);
    f.events.emit('changed');
    release();
    await running;
    f.client.publishCatalogSource = original;
    await host.publisher.flush();
    assert.equal(f.remote.get('plans-A').snapshot.list().items[0].progress.total, 2);
    assert.equal(f.calls.length, 2);
});
test('detail cache bounds UTF8 content as well as count without truncating details', async () => {
    const host = new CatalogHost({ config: {
        read: true, publish: null, client: { hubId: 'synthetic-hub' },
    } });
    try {
        const maximum = 8 * 1024 * 1024;
        const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
        const total = () => [...host.details.values()].reduce((n, v) => n + size(v), 0);
        const large = { note: '中'.repeat(1024 * 1024) };
        host._rememberDetail('a', large);
        host._rememberDetail('b', large);
        host._rememberDetail('c', large);
        assert.deepEqual([...host.details.keys()], ['b', 'c']);
        assert.ok(total() <= maximum);
        host._rememberDetail('b', { note: 'small replacement' });
        assert.equal(host.details.get('b').note, 'small replacement');
        const huge = { note: 'x'.repeat(maximum) };
        host._rememberDetail('b', huge);
        assert.equal(host.details.has('b'), false);
        assert.equal(huge.note.length, maximum);
        assert.ok(total() <= maximum);
        host.details.clear();
        for (let i = 0; i < 17; i++) host._rememberDetail(String(i), { note: 'small' });
        assert.equal(host.details.size, 16);
        assert.equal(host.details.has('0'), false);
        assert.ok(total() <= maximum);
    } finally { await host.stop(); }
    assert.equal(host.details.size, 0);
});

test('engineering host opt-in publishes report and plan under one source version', async t => {
    const f = fixture(t);
    f.store.updateProject(f.project.id, { report: 'first report', report_by: 'Kerr' });
    const config = { ...f.config, publish: { ...f.config.publish, engineeringDetails: true } };
    const host = f.make({ config });
    const before = f.store.db.serialize();
    await host.start();
    assert.equal(host.status().publisher.lastError, null);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].protocolVersion, 2);
    const first = f.remote.get('plans-A');
    const read = source => f.remote.getEngineering('plans-A', {
        version: source.version, digest: source.digest, localProjectId: f.project.id,
    });
    assert.equal(read(first).report.text, 'first report');
    assert.deepEqual(f.store.db.serialize(), before);
    f.store.updateProject(f.project.id, { report: 'second report' });
    f.events.emit('changed', { projectId: f.project.id });
    await host.publisher.flush();
    const second = f.remote.get('plans-A');
    assert.equal(second.version, first.version + 1);
    assert.equal(read(second).report.text, 'second report');
    assert.equal(second.snapshot.list().items[0].progress.total, 1);
});

test('engineering host default never publishes report fields', async t => {
    const f = fixture(t);
    f.store.updateProject(f.project.id, { report: 'NOT_SHARED_REPORT' });
    const host = f.make();
    await host.start();
    assert.equal(f.calls.length, 1);
    assert.equal(Object.hasOwn(f.calls[0], 'protocolVersion'), false);
    assert.equal(Object.hasOwn(f.calls[0], 'details'), false);
    assert.equal(JSON.stringify(f.calls).includes('NOT_SHARED_REPORT'), false);
});

test('engineering host restart with sharing disabled blocks frozen enhanced request without sending', async t => {
    const f = fixture(t);
    const config = { ...f.config, publish: { ...f.config.publish, engineeringDetails: true } };
    const send = f.client.publishCatalogSource;
    let attempts = 0;
    f.client.publishCatalogSource = async () => {
        attempts++;
        throw Object.assign(Error('offline'), { code: 'NETWORK_ERROR' });
    };
    const first = f.make({ config });
    await first.start();
    const pending = first.journal.pending();
    assert.equal(pending.protocolVersion, 2);
    assert.equal(attempts, 1);
    await first.stop();
    f.client.publishCatalogSource = send;
    const restarted = f.make({
        config: { ...f.config, publish: { ...f.config.publish, engineeringDetails: false } },
    });
    await restarted.start();
    assert.equal(restarted.status().publisher.phase, 'blocked');
    assert.equal(restarted.status().publisher.lastError, 'FORBIDDEN');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(restarted.journal.pending(), pending);
});

test('v3 committed but unacknowledged code remains frozen when sharing is disabled on restart', async t => {
    const f = fixture(t);
    const config = { ...f.config, publish: {
        ...f.config.publish, engineeringDetails: true, codeSnapshots: true,
    } };
    const batch = f.store.createBatch(f.project.id, 'create', 'code sharing', 'Kerr');
    f.store.addNode({
        projectId: f.project.id, batchId: batch, filePath: 'a.js', op: 'create',
        beforeHash: null, afterHash: f.store.putBlob('PRIVATE_FROZEN_SOURCE'),
    });
    const send = f.client.publishCatalogSource;
    f.client.publishCatalogSource = async request => {
        await send(request);
        throw Object.assign(Error('lost receipt'), { code: 'NETWORK_ERROR' });
    };
    const first = f.make({ config });
    await first.start();
    const pending = first.journal.pending();
    assert.equal(pending.protocolVersion, 3);
    assert.match(JSON.stringify(pending.codes), /PRIVATE_FROZEN_SOURCE/);
    const published = f.remote.get('plans-A');
    assert.equal(published.version, 1);
    await first.stop();
    f.client.publishCatalogSource = send;
    const disabled = f.make({ config: { ...config, publish: {
        ...config.publish, codeSnapshots: false,
    } } });
    const before = disabled.journal.db.serialize();
    await disabled.start();
    assert.equal(disabled.status().publisher.phase, 'blocked');
    assert.equal(disabled.status().publisher.lastError, 'FORBIDDEN');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(disabled.journal.pending(), pending);
    assert.deepEqual(disabled.journal.db.serialize(), before);
    // Disabling is not remote erasure: the already committed publication remains.
    assert.equal(f.remote.get('plans-A').digest, published.digest);
    await disabled.stop();

    // Trusted explicit re-enable permits retry of exactly the original request.
    const resumed = f.make({ config });
    await resumed.start();
    assert.equal(resumed.journal.pending(), null);
    assert.deepEqual(f.calls[1], pending);
    assert.equal(f.remote.get('plans-A').version, 1);
});

test('after acknowledged v3, disabling code publishes v2 without code and advances the same version', async t => {
    const f = fixture(t);
    const config = { ...f.config, publish: {
        ...f.config.publish, engineeringDetails: true, codeSnapshots: true,
    } };
    const batch = f.store.createBatch(f.project.id, 'create', 'code sharing', 'Kerr');
    f.store.addNode({
        projectId: f.project.id, batchId: batch, filePath: 'a.js', op: 'create',
        beforeHash: null, afterHash: f.store.putBlob('PRIVATE_SOURCE'),
    });
    const host = f.make({ config });
    await host.start();
    assert.equal(host.journal.pending(), null);
    assert.equal(f.calls[0].protocolVersion, 3);
    config.publish.codeSnapshots = false;
    await host.publisher.flush();
    assert.equal(f.calls[1].protocolVersion, 2);
    assert.equal(Object.hasOwn(f.calls[1], 'codes'), false);
    assert.doesNotMatch(JSON.stringify(f.calls[1]), /PRIVATE_SOURCE/);
    const current = f.remote.get('plans-A');
    assert.equal(current.version, 2);
    const pin = { version: current.version, digest: current.digest, localProjectId: f.project.id };
    const detail = f.remote.getEngineering('plans-A', pin);
    assert.deepEqual(f.remote.getCode('plans-A', {
        ...pin, node: detail.files.items[0].last_node,
    }), { version: 1, state: 'not-shared' });
});