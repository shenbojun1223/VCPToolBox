'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { CatalogSourceStore } =
    require('../../Plugin/ServerProjectForge/catalogSourceStore');
const { canonicalEngineeringInventory } =
    require('../../Plugin/ServerProjectForge/catalogEngineeringInventory');
const { projectEngineeringDetail } =
    require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');

const hubId = 'hub-11111111-2222-4333-8444-555555555555';
const at = '2026-10-22T02:00:00.000Z';
function records() {
    return [{
        identity: { sourceId: 'source-A', localProjectId: 'p1' },
        project: { id: 'p1', name: '工程', status: 'active', availability: 'ready',
            created_at: at, updated_at: at, deleted_at: null },
        todos: [],
    }];
}
function detail(text = '报告') {
    return projectEngineeringDetail({
        project: { report: text, report_by: 'Kerr' },
        batches: [], files: [], batchTotal: 0, fileTotal: 0,
    }, { shared: true });
}
function request(overrides = {}) {
    return {
        sourceId: 'source-A', deviceId: 'device-A', expectedVersion: 0,
        requestId: 'request-1', records: records(), protocolVersion: 2,
        details: [{ localProjectId: 'p1', detail: detail() }], ...overrides,
    };
}
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-engineering-source-'));
    const file = path.join(dir, 'catalog.db'), opened = [];
    const open = () => {
        const store = new CatalogSourceStore(file, { hubId });
        opened.push(store);
        return store;
    };
    t.after(() => {
        opened.forEach(s => s.close());
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { open, store: open() };
}
const pin = receipt => ({ version: receipt.version, digest: receipt.digest, localProjectId: 'p1' });

test('enhanced source survives restart and retains legacy directory projection', t => {
    const f = fixture(t), args = request(), receipt = f.store.publish(args);
    assert.equal(receipt.digest,
        canonicalEngineeringInventory(args.sourceId, args.records, args.details).digest);
    f.store.close();
    const store = f.open();
    assert.deepEqual(store.publish(args), receipt);
    const source = store.get('source-A');
    assert.equal(source.version, 1);
    assert.equal(source.snapshot.list().items[0].name, '工程');
    assert.equal(source.snapshot.todos(source.snapshot.list().items[0].key).total, 0);
    assert.deepEqual(store.getEngineering('source-A', pin(receipt)), detail());
});

test('report-only updates advance one version and old detail pins are refused', t => {
    const { store } = fixture(t);
    const first = store.publish(request());
    const second = store.publish(request({
        requestId: 'request-2', expectedVersion: 1,
        details: [{ localProjectId: 'p1', detail: detail('新版报告') }],
    }));
    assert.equal(second.version, 2);
    assert.notEqual(second.digest, first.digest);
    assert.throws(() => store.getEngineering('source-A', pin(first)), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => store.getEngineering('source-A', {
        ...pin(second), digest: first.digest,
    }), { code: 'REQUEST_CONFLICT' });
    assert.equal(store.getEngineering('source-A', pin(second)).report.text, '新版报告');
    assert.throws(() => store.getEngineering('source-A', { localProjectId: 'p1' }));
});

test('legacy and explicit unshared inventories never fabricate empty reports', t => {
    const { store } = fixture(t);
    const legacy = request();
    delete legacy.protocolVersion; delete legacy.details;
    const first = store.publish(legacy);
    assert.deepEqual(store.getEngineering('source-A', pin(first)),
        { version: 1, state: 'not-shared' });
    const second = store.publish(request({
        requestId: 'request-2', expectedVersion: 1,
        details: [{ localProjectId: 'p1', detail: { version: 1, state: 'not-shared' } }],
    }));
    assert.deepEqual(store.getEngineering('source-A', pin(second)),
        { version: 1, state: 'not-shared' });
    assert.throws(() => store.getEngineering('source-A', {
        ...pin(second), localProjectId: 'missing',
    }), { code: 'NOT_FOUND' });
    assert.throws(() => store.getEngineering('unknown', pin(second)), { code: 'CONTENT_NOT_FOUND' });
});

test('ambiguous protocol or malformed details cannot silently overwrite the source', t => {
    const { store } = fixture(t);
    store.publish(request());
    const before = store.db.serialize();
    const base = request({ requestId: 'request-2', expectedVersion: 1 });
    const noVersion = { ...base }; delete noVersion.protocolVersion;
    const noDetails = { ...base }; delete noDetails.details;
    for (const bad of [
        noVersion, noDetails, { ...base, protocolVersion: 1 },
        { ...base, protocolVersion: 99 }, { ...base, details: [] },
        { ...base, details: [{ localProjectId: 'p2', detail: detail() }] },
    ]) {
        assert.throws(() => store.publish(bad));
        assert.deepEqual(store.db.serialize(), before);
    }
});

test('changed retry and foreign writer cannot replace a frozen enhanced publication', t => {
    const { store } = fixture(t);
    const first = store.publish(request());
    assert.throws(() => store.publish(request({
        details: [{ localProjectId: 'p1', detail: detail('different') }],
    })), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => store.publish(request({
        deviceId: 'device-B', requestId: 'foreign', expectedVersion: 1,
    })), { code: 'FORBIDDEN' });
    const returned = store.getEngineering('source-A', pin(first));
    returned.report.text = 'caller mutation';
    assert.equal(store.getEngineering('source-A', pin(first)).report.text, '报告');
});