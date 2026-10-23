'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { CatalogPublishJournal } =
    require('../../Plugin/ServerProjectForge/catalogPublishJournal');
const { canonicalRecords } =
    require('../../Plugin/ServerProjectForge/catalogInventory');
const { canonicalEngineeringInventory } =
    require('../../Plugin/ServerProjectForge/catalogEngineeringInventory');
const { projectEngineeringDetail } =
    require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');

const at = '2026-10-22T02:00:00.000Z';
function records() {
    return [{
        identity: { sourceId: 'source-A', localProjectId: 'p1' },
        project: { id: 'p1', name: '工程', status: 'active', availability: 'ready',
            created_at: at, updated_at: at, deleted_at: null },
        todos: [],
    }];
}
function details(text = '报告') {
    return [{ localProjectId: 'p1', detail: projectEngineeringDetail({
        project: { report: text, report_by: 'Kerr' },
        batches: [], files: [], batchTotal: 0, fileTotal: 0,
    }, { shared: true }) }];
}
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-engineering-journal-'));
    const filename = path.join(dir, 'journal.db'), opened = [];
    const binding = { hubId: 'hub-11111111-2222-4333-8444-555555555555',
        deviceId: 'device-A', sourceId: 'source-A', storePath: path.join(dir, 'unused-business.db') };
    const open = () => {
        const journal = new CatalogPublishJournal(filename, binding);
        opened.push(journal);
        return journal;
    };
    t.after(() => {
        opened.forEach(j => j.close());
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { open, journal: open() };
}
function receipt(request) {
    const normalized = request.protocolVersion === 2
        ? canonicalEngineeringInventory(request.sourceId, request.records, request.details)
        : canonicalRecords(request.sourceId, request.records);
    return { sourceId: request.sourceId, version: request.expectedVersion + 1,
        digest: normalized.digest, receivedAt: 1792634400000 };
}

test('v2 pending request survives reopen with explicit protocol and frozen details', t => {
    const f = fixture(t), input = details();
    const request = f.journal.stage(records(), { details: input });
    assert.equal(request.protocolVersion, 2);
    assert.deepEqual(request.details, input);
    input[0].detail.report.text = 'caller mutation';
    assert.equal(f.journal.pending().details[0].detail.report.text, '报告');
    const stored = f.journal.db.prepare('SELECT payload,payload_digest FROM catalog_publish_state').get();
    const envelope = JSON.parse(stored.payload);
    assert.equal(envelope.version, 2);
    assert.equal(stored.payload_digest,
        canonicalEngineeringInventory('source-A', request.records, request.details).digest);
    f.journal.close();
    const reopened = f.open();
    assert.deepEqual(reopened.pending(), request);
    reopened.acknowledge(request.requestId, receipt(request));
    assert.equal(reopened.pending(), null);
    assert.equal(reopened.stage(records(), { details: details() }), null);
});

test('unacknowledged v1 cannot be replaced by v2; acknowledgement advances one shared counter', t => {
    const f = fixture(t);
    const legacy = f.journal.stage(records());
    assert.equal(Object.hasOwn(legacy, 'protocolVersion'), false);
    assert.equal(Object.hasOwn(legacy, 'details'), false);
    const before = f.journal.db.serialize();
    assert.throws(() => f.journal.stage(records(), { details: details() }), { code: 'REQUEST_CONFLICT' });
    assert.deepEqual(f.journal.db.serialize(), before);
    assert.deepEqual(f.journal.pending(), legacy);
    f.journal.acknowledge(legacy.requestId, receipt(legacy));
    const enhanced = f.journal.stage(records(), { details: details() });
    assert.equal(enhanced.protocolVersion, 2);
    assert.equal(enhanced.expectedVersion, 1);
    assert.notEqual(enhanced.requestId, legacy.requestId);
});

test('v2 pending cannot silently downgrade or replace report after a lost reply', t => {
    const f = fixture(t);
    const first = f.journal.stage(records(), { details: details() });
    const before = f.journal.db.serialize();
    assert.throws(() => f.journal.stage(records()), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => f.journal.stage(records(), { details: details('new report') }),
        { code: 'REQUEST_CONFLICT' });
    assert.deepEqual(f.journal.db.serialize(), before);
    assert.deepEqual(f.journal.pending(), first);
});

test('a legacy-only digest cannot acknowledge an enhanced request', t => {
    const f = fixture(t);
    const request = f.journal.stage(records(), { details: details() });
    const before = f.journal.db.serialize();
    const wrong = { ...receipt(request), digest: canonicalRecords('source-A', records()).digest };
    assert.throws(() => f.journal.acknowledge(request.requestId, wrong), { code: 'REQUEST_CONFLICT' });
    assert.deepEqual(f.journal.db.serialize(), before);
    f.journal.acknowledge(request.requestId, receipt(request));
    const next = f.journal.stage(records(), { details: details('next report') });
    assert.equal(next.expectedVersion, 1);
    assert.equal(next.protocolVersion, 2);
});

test('empty v2 inventory remains versioned and malformed options cannot silently publish v1', t => {
    const f = fixture(t);
    for (const options of [{ details: null }, { details: [], typo: true }, { shared: true }]) {
        assert.throws(() => f.journal.stage([], options));
        assert.equal(f.journal.pending(), null);
    }
    const request = f.journal.stage([], { details: [] });
    assert.equal(request.protocolVersion, 2);
    assert.deepEqual(request.details, []);
    f.journal.close();
    assert.deepEqual(f.open().pending(), request);
});