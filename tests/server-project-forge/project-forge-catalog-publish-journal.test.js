'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CatalogPublishJournal } = require('../../Plugin/ServerProjectForge/catalogPublishJournal');
const { CatalogSourceStore } = require('../../Plugin/ServerProjectForge/catalogSourceStore');
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-catalog-journal-'));
    const binding = { hubId: 'hub-11111111-2222-4333-8444-555555555555',
        deviceId: 'device-A', sourceId: 'source-A', storePath: path.join(dir, 'business.db') };
    const file = path.join(dir, 'publisher.db'), journals = [];
    const open = () => {
        const j = new CatalogPublishJournal(file, binding); journals.push(j); return j;
    };
    const remote = new CatalogSourceStore(path.join(dir, 'remote.db'), { hubId: binding.hubId });
    t.after(() => { journals.forEach(j => j.close()); remote.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const send = request => remote.publish({ ...request, deviceId: binding.deviceId });
    return { file, binding, open, journal: open(), remote, send };
}
function records() {
    const time = '2026-10-21T00:00:00.000Z';
    return [{
        identity: { sourceId: 'source-A', localProjectId: 'p1' },
        project: { id: 'p1', name: '计划', status: 'active', availability: 'ready',
            created_at: time, updated_at: time, deleted_at: null, root: 'DO_NOT_PERSIST' },
        todos: [],
    }];
}
test('lost acknowledgement reopens with identical request and recovers idempotently', t => {
    const f = fixture(t);
    const first = f.journal.stage(records());
    const committed = f.send(first);
    f.journal.close();
    const reopened = f.open();
    assert.deepEqual(reopened.pending(), first);
    assert.deepEqual(f.send(reopened.pending()), committed);
    reopened.acknowledge(first.requestId, committed);
    assert.equal(reopened.pending(), null);
    assert.equal(reopened.stage(records()), null);
    const next = reopened.stage([]);
    assert.equal(next.expectedVersion, 1);
    assert.notEqual(next.requestId, first.requestId);
    reopened.acknowledge(next.requestId, f.send(next));
    assert.equal(reopened.stage([]), null);
    assert.equal(f.remote.get('source-A').version, 2);
});
test('concurrent journal connections cannot replace a pending payload', t => {
    const f = fixture(t), second = f.open();
    const a = f.journal.stage(records());
    assert.deepEqual(second.stage(records()), a);
    assert.throws(() => second.stage([]), { code: 'REQUEST_CONFLICT' });
    const returned = second.pending();
    returned.records[0].project.name = 'tampered';
    assert.deepEqual(f.journal.pending(), a);
    assert.equal(f.journal.db.prepare('SELECT payload FROM catalog_publish_state').get().payload
        .includes('DO_NOT_PERSIST'), false);
});
test('incorrect receipt or request cannot advance local version or discard payload', t => {
    const f = fixture(t), request = f.journal.stage(records()), receipt = f.send(request);
    const before = f.journal.db.serialize();
    assert.throws(() => f.journal.acknowledge('wrong-request', receipt), { code: 'REQUEST_CONFLICT' });
    for (const patch of [{ sourceId: 'foreign' }, { version: 2 }, { digest: '0'.repeat(64) }]) {
        assert.throws(() => f.journal.acknowledge(request.requestId, { ...receipt, ...patch }),
            { code: 'REQUEST_CONFLICT' });
    }
    assert.deepEqual(f.journal.db.serialize(), before);
    f.journal.acknowledge(request.requestId, receipt);
    assert.throws(() => f.journal.acknowledge(request.requestId, receipt), { code: 'REQUEST_CONFLICT' });
});
test('empty first inventory publishes once and state remains durable after acknowledgement', t => {
    const f = fixture(t), request = f.journal.stage([]);
    assert.ok(request);
    assert.equal(request.expectedVersion, 0);
    f.journal.acknowledge(request.requestId, f.send(request));
    f.journal.close();
    assert.equal(f.open().stage([]), null);
});
test('journal rejects foreign binding, business DB path and caller transactions', t => {
    const f = fixture(t);
    for (const patch of [{ deviceId: 'device-B' }, { sourceId: 'source-B' },
        { hubId: 'hub-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
        { storePath: f.binding.storePath + '.other' }]) {
        assert.throws(() => new CatalogPublishJournal(f.file, { ...f.binding, ...patch }),
            { code: 'CONTENT_BINDING' });
    }
    assert.throws(() => new CatalogPublishJournal(f.binding.storePath, f.binding),
        { code: 'CONTENT_BINDING' });
    assert.equal(fs.existsSync(f.binding.storePath), false);
    assert.throws(() => f.journal.db.transaction(() => f.journal.stage([]))(),
        { code: 'INVALID_ARGUMENT' });
});