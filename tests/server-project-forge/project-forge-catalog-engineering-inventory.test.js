'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { canonicalRecords } = require('../../Plugin/ServerProjectForge/catalogInventory');
const { projectEngineeringDetail, DETAIL_LIMITS } =
    require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');
const { canonicalEngineeringInventory } =
    require('../../Plugin/ServerProjectForge/catalogEngineeringInventory');

const sourceId = 'source-A', at = '2026-10-22T02:00:00.000Z';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
function record(id = 'p1') {
    return {
        identity: { sourceId, localProjectId: id },
        project: { id, name: '工程', status: 'active', availability: 'ready',
            created_at: at, updated_at: at, deleted_at: null, root: 'PRIVATE_ROOT' },
        todos: [{ project_id: id, seq: 1, title: '实现', status: 'doing',
            note: null, updated_by: 'Kerr', updated_at: at }],
    };
}
function detail(text = '验收说明') {
    return projectEngineeringDetail({
        project: { report: text, report_by: 'Kerr' },
        batches: [], files: [], batchTotal: 0, fileTotal: 0,
    }, { shared: true });
}
const entry = (id = 'p1', value = detail()) => ({ localProjectId: id, detail: value });

test('v2 wraps the unchanged legacy projection and hashes the entire envelope', () => {
    const rows = [record()];
    const legacy = canonicalRecords(sourceId, rows);
    const result = canonicalEngineeringInventory(sourceId, rows, [entry()]);
    const value = JSON.parse(result.payload);
    assert.equal(value.version, 2);
    assert.deepEqual(Object.keys(value).sort(), ['details', 'records', 'version']);
    assert.deepEqual(value.records, JSON.parse(legacy.payload));
    assert.deepEqual(value.details, [entry()]);
    assert.equal(result.digest, sha(result.payload));
    assert.notEqual(result.digest, legacy.digest);
    assert.deepEqual(canonicalRecords(sourceId, rows), legacy);
    assert.doesNotMatch(result.payload, /PRIVATE_ROOT/);
});

test('canonical order is stable and returned payload cannot alias caller objects', () => {
    const rows = [record('p2'), record('p1')];
    const details = [entry('p2'), entry('p1')];
    const before = JSON.stringify({ rows, details });
    const a = canonicalEngineeringInventory(sourceId, rows, details);
    const b = canonicalEngineeringInventory(sourceId, [...rows].reverse(), [...details].reverse());
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify({ rows, details }), before);
    details[0].detail.report.text = 'later mutation';
    assert.doesNotMatch(a.payload, /later mutation/);
});

test('detail changes alter the same inventory digest even if Todo and timestamps do not change', () => {
    const rows = [record()];
    const a = canonicalEngineeringInventory(sourceId, rows, [entry()]);
    const b = canonicalEngineeringInventory(sourceId, rows, [entry('p1', detail('新报告'))]);
    assert.notEqual(a.digest, b.digest);
    assert.deepEqual(JSON.parse(a.payload).records, JSON.parse(b.payload).records);
});

test('every project has an explicit detail state; missing, duplicate or foreign entries fail', () => {
    const rows = [record()];
    for (const entries of [[], [entry(), entry()], [entry('p2')], [entry(), entry('p2')]]) {
        assert.throws(() => canonicalEngineeringInventory(sourceId, rows, entries));
    }
    const notShared = { version: 1, state: 'not-shared' };
    const result = canonicalEngineeringInventory(sourceId, rows, [entry('p1', notShared)]);
    assert.deepEqual(JSON.parse(result.payload).details[0].detail, notShared);
    assert.throws(() => canonicalEngineeringInventory(sourceId, rows, [
        entry('p1', { ...notShared, report: { text: 'MUST_NOT_LEAK' } }),
    ]));
});

test('strict projected detail validation refuses unknown fields and invalid states', () => {
    const variants = [
        { ...detail(), root: 'PRIVATE_ROOT' },
        { ...detail(), state: 'unknown' },
        { ...detail(), version: 99 },
        { ...detail(), report: { ...detail().report, secret: 'NO' } },
        { ...detail(), report: { ...detail().report, text: 42 } },
        { ...detail(), files: { items: [], total: 1, truncated: false } },
    ];
    for (const value of variants) {
        assert.throws(() => canonicalEngineeringInventory(sourceId, [record()], [entry('p1', value)]));
    }
});

test('frozen projected truncation metadata survives canonical replay', () => {
    const value = detail('x'.repeat(DETAIL_LIMITS.reportChars + 10));
    assert.deepEqual(value.report.truncated, ['text']);
    const a = canonicalEngineeringInventory(sourceId, [record()], [entry('p1', value)]);
    const decoded = JSON.parse(a.payload);
    const b = canonicalEngineeringInventory(sourceId, decoded.records, decoded.details);
    assert.deepEqual(a, b);
    assert.deepEqual(decoded.details[0].detail.report.truncated, ['text']);
});

test('empty enhanced inventory is explicit and cannot be mistaken for a v1 array', () => {
    const result = canonicalEngineeringInventory(sourceId, [], []);
    assert.deepEqual(JSON.parse(result.payload), { version: 2, records: [], details: [] });
    assert.throws(() => canonicalRecords(sourceId, JSON.parse(result.payload)));
});