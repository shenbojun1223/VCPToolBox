'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CatalogPublisher } = require('../../Plugin/ServerProjectForge/catalogPublisher');
const { CatalogPublishJournal } = require('../../Plugin/ServerProjectForge/catalogPublishJournal');
const { CatalogSourceStore } = require('../../Plugin/ServerProjectForge/catalogSourceStore');
function deferred() {
    let resolve; const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-catalog-publisher-'));
    const binding = { hubId: 'hub-11111111-2222-4333-8444-555555555555',
        sourceId: 'plans-A', deviceId: 'A', storePath: path.join(root, 'business.db') };
    const journal = new CatalogPublishJournal(path.join(root, 'journal.db'), binding);
    const remote = new CatalogSourceStore(path.join(root, 'remote.db'), { hubId: binding.hubId });
    const controllers = [], calls = [];
    let records = [];
    const collect = () => ({ records });
    const client = { async publishCatalogSource(request) {
        calls.push(request);
        return remote.publish({ ...request, deviceId: 'A' });
    } };
    const make = (options = {}) => {
        const p = new CatalogPublisher({ client, journal, collect,
            authorizePending: () => true, intervalMs: 300000, ...options });
        controllers.push(p); return p;
    };
    t.after(async () => {
        for (const p of controllers) await p.stop();
        journal.close(); remote.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { journal, remote, calls, client, make, setRecords: value => { records = value; } };
}
function records() {
    const time = '2026-10-21T00:00:00.000Z';
    return [{ identity: { sourceId: 'plans-A', localProjectId: 'p1' },
        project: { id: 'p1', name: '新计划', availability: 'ready', status: 'active',
            created_at: time, updated_at: time, deleted_at: null }, todos: [] }];
}
test('start publishes initial inventory and concurrent flushes share one flight', async t => {
    const f = fixture(t), entered = deferred(), release = deferred();
    const original = f.client.publishCatalogSource;
    f.client.publishCatalogSource = async request => {
        entered.resolve(); await release.promise; return original(request);
    };
    const p = f.make(), first = p.start();
    await entered.promise;
    const second = p.flush();
    assert.equal(first, second);
    assert.equal(f.journal.pending().expectedVersion, 0);
    release.resolve();
    assert.equal((await first).phase, 'watching');
    await p.flush();
    assert.equal(f.calls.length, 1);
    assert.equal(f.journal.pending(), null);
});
test('lost reply recovers identical request before publishing newer collected state', async t => {
    const f = fixture(t), original = f.client.publishCatalogSource;
    let lost = true;
    f.client.publishCatalogSource = async request => {
        const receipt = await original(request);
        if (lost) { lost = false; throw Object.assign(Error('lost'), { code: 'NETWORK_ERROR' }); }
        return receipt;
    };
    const p = f.make();
    assert.equal((await p.flush()).lastError, 'NETWORK_ERROR');
    const pending = f.journal.pending();
    f.setRecords(records());
    await p.flush();
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls[0], f.calls[1]);
    assert.equal(f.calls[1].requestId, pending.requestId);
    assert.equal(f.calls[2].expectedVersion, 1);
    assert.equal(f.remote.get('plans-A').version, 2);
    assert.equal(f.remote.get('plans-A').snapshot.list().items.length, 1);
});
test('stop drains in-flight acknowledgement but does not collect or send another inventory', async t => {
    const f = fixture(t);
    f.journal.stage([]);
    const entered = deferred(), release = deferred(), original = f.client.publishCatalogSource;
    let collections = 0;
    f.client.publishCatalogSource = async request => {
        entered.resolve(); await release.promise; return original(request);
    };
    const p = f.make({ collect: () => { collections++; return { records: records() }; } });
    const run = p.start();
    await entered.promise;
    let stopped = false;
    const stop = p.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    release.resolve();
    await Promise.all([run, stop]);
    assert.equal(f.calls.length, 1);
    assert.equal(collections, 0);
    assert.equal(f.journal.pending(), null);
    assert.equal((await p.flush()).phase, 'stopped');
    assert.equal(p.timer, null);
});
test('authorization revoked for a persisted request prevents any transport', async t => {
    const f = fixture(t);
    f.journal.stage(records());
    const before = f.journal.pending();
    const p = f.make({ authorizePending: request => {
        request.records.length = 0; // Must not mutate durable payload.
        return false;
    } });
    assert.equal((await p.start()).phase, 'blocked');
    assert.equal(p.status().lastError, 'FORBIDDEN');
    await p.flush();
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.journal.pending(), before);
    assert.equal(p.timer, null);
});
test('version conflict stays blocked with original pending request', async t => {
    const f = fixture(t);
    f.remote.publish({ sourceId: 'plans-A', deviceId: 'A',
        expectedVersion: 0, requestId: 'other-publisher', records: [] });
    const p = f.make();
    const result = await p.start();
    assert.equal(result.phase, 'blocked');
    assert.equal(result.lastError, 'REVISION_CONFLICT');
    const pending = f.journal.pending();
    await p.start(); await p.flush();
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.journal.pending(), pending);
    assert.equal(f.remote.get('plans-A').version, 1);
});
test('incomplete collection retries without publishing a partial inventory', async t => {
    const f = fixture(t);
    let ready = false;
    const p = f.make({ collect: () => {
        if (!ready) throw Object.assign(Error('updating'), { code: 'BUSY' });
        return { records: records() };
    } });
    assert.equal((await p.flush()).lastError, 'BUSY');
    assert.equal(f.journal.pending(), null);
    assert.equal(f.calls.length, 0);
    ready = true;
    assert.equal((await p.flush()).lastError, null);
    assert.equal(f.calls.length, 1);
});