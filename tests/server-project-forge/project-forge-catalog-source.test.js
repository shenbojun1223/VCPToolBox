'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CatalogSourceStore } =
    require('../../Plugin/ServerProjectForge/catalogSourceStore');
const hubId = 'hub-11111111-2222-4333-8444-555555555555';
const time = '2026-10-21T00:00:00.000Z';
function record(id = 'p1', sourceId = 'source-A') {
    return {
        identity: { sourceId, localProjectId: id },
        project: { id, name: '计划', status: 'active', availability: 'ready',
            created_at: time, updated_at: time, deleted_at: null, root: 'PRIVATE_PATH' },
        todos: [{ project_id: id, seq: 1, title: '待办', status: 'pending',
            note: null, updated_by: 'Kerr', updated_at: time, secret: 'EXTRA_FIELD' }],
    };
}
function fixture(t, options = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-catalog-source-'));
    const file = path.join(dir, 'catalog.db'), stores = [];
    const open = () => {
        const store = new CatalogSourceStore(file, { hubId, ...options });
        stores.push(store); return store;
    };
    t.after(() => { stores.forEach(s => s.close()); fs.rmSync(dir, { recursive: true, force: true }); });
    return { file, open, store: open() };
}
function args(extra = {}) {
    return { sourceId: 'source-A', deviceId: 'device-A', expectedVersion: 0,
        requestId: 'request-1', records: [record()], ...extra };
}
test('source inventory survives restart and same request retries idempotently', t => {
    const f = fixture(t), first = f.store.publish(args());
    f.store.close();
    const reopened = f.open();
    assert.deepEqual(reopened.publish(args()), first);
    const read = reopened.get('source-A');
    assert.equal(read.version, 1);
    assert.equal(read.snapshot.list().items.length, 1);
    assert.equal(read.snapshot.todos(read.snapshot.list().items[0].key).items[0].title, '待办');
});
test('stale versions and changed retry payload cannot overwrite current inventory', t => {
    const { store } = fixture(t);
    store.publish(args());
    assert.throws(() => store.publish(args({ records: [] })), { code: 'REQUEST_CONFLICT' });
    store.publish(args({ expectedVersion: 1, requestId: 'request-2', records: [record('p2')] }));
    assert.throws(() => store.publish(args()), { code: 'REVISION_CONFLICT' });
    assert.equal(store.get('source-A').version, 2);
    assert.equal(store.get('source-A').snapshot.list().items[0].localProjectId, 'p2');
});
test('device binding, source binding and global identity are enforced', t => {
    const { store } = fixture(t);
    store.publish(args());
    assert.throws(() => store.publish(args({ deviceId: 'device-B', expectedVersion: 1,
        requestId: 'other' })), { code: 'FORBIDDEN' });
    assert.throws(() => store.publish(args({ records: [record('p2', 'foreign')] })),
        { code: 'CONTENT_BINDING' });
    const r = record();
    r.identity.globalProjectId = 'g_11111111-2222-4333-8444-555555555555';
    assert.throws(() => store.publish(args({ records: [r] })), { code: 'CONTENT_BINDING' });
    assert.equal(store.get('source-A').version, 1);
});
test('complete replacement removes absent entries; empty inventory is explicit', t => {
    const { store } = fixture(t);
    store.publish(args({ records: [record('p1'), record('p2')] }));
    store.publish(args({ expectedVersion: 1, requestId: 'request-2', records: [] }));
    assert.deepEqual(store.get('source-A').snapshot.list().items, []);
    assert.equal(store.get('source-A').version, 2);
    assert.equal(store.get('unknown'), null);
});
test('only plan fields persist; invalid publication leaves prior state intact', t => {
    const { store } = fixture(t);
    store.publish(args());
    const before = store.db.prepare('SELECT * FROM catalog_sources').all();
    const payload = before[0].payload;
    assert.equal(payload.includes('PRIVATE_PATH'), false);
    assert.equal(payload.includes('EXTRA_FIELD'), false);
    const bad = record(); bad.todos[0].status = 'invalid';
    assert.throws(() => store.publish(args({ expectedVersion: 1, requestId: 'request-2',
        records: [bad] })), { code: 'INVALID_ARGUMENT' });
    assert.deepEqual(store.db.prepare('SELECT * FROM catalog_sources').all(), before);
});
test('independent connections obey CAS and source capacity', t => {
    const f = fixture(t, { maxSources: 1 }), second = f.open();
    f.store.publish(args());
    assert.throws(() => second.publish(args({ requestId: 'competitor' })), { code: 'REVISION_CONFLICT' });
    assert.throws(() => second.publish(args({ sourceId: 'source-B',
        records: [record('p2', 'source-B')] })), { code: 'CAPACITY_EXCEEDED' });
    assert.equal(second.get('source-A').version, 1);
});
test('reopening with another Hub binding refuses the database', t => {
    const f = fixture(t);
    f.store.publish(args()); f.store.close();
    assert.throws(() => new CatalogSourceStore(f.file, {
        hubId: 'hub-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    }), { code: 'CONTENT_BINDING' });
});