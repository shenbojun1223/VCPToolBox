'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto');
const { CatalogSourceStore } = require('../../Plugin/ServerProjectForge/catalogSourceStore');
const { CatalogPublishJournal } = require('../../Plugin/ServerProjectForge/catalogPublishJournal');
const { canonicalCodeInventory } = require('../../Plugin/ServerProjectForge/catalogCodeInventory');
const { projectEngineeringDetail } = require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');
const hubId = 'hub-11111111-2222-4333-8444-555555555555';
const at = '2026-10-22T02:00:00.000Z';
const clone = value => JSON.parse(JSON.stringify(value));
function inventory(text = 'PRIVATE_SOURCE_中文\r\n') {
    const records = [{
        identity: { sourceId: 'source-A', localProjectId: 'p1' },
        project: { id: 'p1', name: '工程', status: 'active', availability: 'ready',
            created_at: at, updated_at: at, deleted_at: null }, todos: [],
    }];
    const detail = projectEngineeringDetail({
        project: { report: 'public report' }, batches: [], batchTotal: 0,
        files: [{ file_path: 'src/a.js', edits: 1, added: 1, removed: 0, last_node: 1 }],
        fileTotal: 1,
    }, { shared: true });
    const bytes = Buffer.from(text);
    return { records, details: [{ localProjectId: 'p1', detail }],
        codes: [{ localProjectId: 'p1', code: { version: 1, state: 'shared', files: [{
            file_path: 'src/a.js', node: 1, batch: 1,
            before: { state: 'absent', hash: null, size: 0, text: null },
            after: { state: 'text', hash: crypto.createHash('sha256').update(bytes).digest('hex'),
                size: bytes.length, text },
        }] } }] };
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-code-storage-')), opened = [];
    const openStore = () => {
        const store = new CatalogSourceStore(path.join(root, 'source.db'), { hubId });
        opened.push(store); return store;
    };
    const openJournal = () => {
        const journal = new CatalogPublishJournal(path.join(root, 'journal.db'), {
            hubId, deviceId: 'device-A', sourceId: 'source-A',
            storePath: path.join(root, 'unused-business.db'),
        });
        opened.push(journal); return journal;
    };
    t.after(() => {
        opened.forEach(resource => resource.close());
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { openStore, openJournal };
}
const request = (input = inventory(), overrides = {}) => ({
    sourceId: 'source-A', deviceId: 'device-A', expectedVersion: 0,
    requestId: 'request-1', protocolVersion: 3, ...input, ...overrides,
});
const pin = receipt => ({
    version: receipt.version, digest: receipt.digest, localProjectId: 'p1',
});
test('v3 source survives reopen; directory and engineering responses exclude source text', t => {
    const f = fixture(t), input = inventory(), first = f.openStore();
    const receipt = first.publish(request(input));
    assert.equal(receipt.digest, canonicalCodeInventory(
        'source-A', input.records, input.details, input.codes).digest);
    first.close();
    const store = f.openStore();
    assert.deepEqual(store.publish(request(input)), receipt);
    const source = store.get('source-A');
    assert.doesNotMatch(JSON.stringify(source.snapshot.list()), /PRIVATE_SOURCE/);
    assert.deepEqual(store.getEngineering('source-A', pin(receipt)), input.details[0].detail);
    const result = store.getCode('source-A', { ...pin(receipt), node: 1 });
    assert.deepEqual(result.file, input.codes[0].code.files[0]);
    result.file.after.text = 'caller mutation';
    assert.match(store.getCode('source-A', { ...pin(receipt), node: 1 }).file.after.text,
        /PRIVATE_SOURCE/);
});
test('code-only updates advance shared version; stale pins and foreign identities fail', t => {
    const store = fixture(t).openStore();
    const first = store.publish(request());
    const second = store.publish(request(inventory('new code'), {
        expectedVersion: 1, requestId: 'request-2',
    }));
    assert.equal(second.version, 2);
    assert.notEqual(second.digest, first.digest);
    assert.throws(() => store.getCode('source-A', { ...pin(first), node: 1 }),
        { code: 'REQUEST_CONFLICT' });
    for (const options of [
        { ...pin(second), node: 2 },
        { ...pin(second), node: 1, localProjectId: 'p2' },
    ]) assert.throws(() => store.getCode('source-A', options), { code: 'NOT_FOUND' });
    assert.throws(() => store.publish(request(inventory(), {
        expectedVersion: 2, requestId: 'foreign', deviceId: 'device-B',
    })), { code: 'FORBIDDEN' });
});
test('legacy and v2 publications remain readable and report code not-shared', t => {
    const store = fixture(t).openStore(), input = inventory();
    for (const protocol of [1, 2]) {
        const args = request(input, { expectedVersion: protocol - 1, requestId: `legacy-${protocol}` });
        delete args.codes;
        if (protocol === 1) { delete args.protocolVersion; delete args.details; }
        else args.protocolVersion = 2;
        const receipt = store.publish(args);
        assert.deepEqual(store.getCode('source-A', { ...pin(receipt), node: 1 }),
            { version: 1, state: 'not-shared' });
    }
});
test('invalid v3 bindings and protocol mismatches leave committed bytes unchanged', t => {
    const store = fixture(t).openStore();
    store.publish(request());
    const before = store.db.serialize();
    for (const mutate of [
        args => { delete args.codes; },
        args => { args.protocolVersion = 2; },
        args => { args.codes[0].localProjectId = 'p2'; },
        args => { args.codes[0].code.files[0].node = 2; },
        args => { args.codes[0].code.files[0].after.text = 'tampered'; },
        args => { args.codes.push(clone(args.codes[0])); },
    ]) {
        const args = request(inventory(), { expectedVersion: 1, requestId: 'bad' });
        mutate(args);
        assert.throws(() => store.publish(args));
        assert.deepEqual(store.db.serialize(), before);
    }
});
test('v3 pending survives lost receipt and restart; changes and downgrade cannot replace it', t => {
    const f = fixture(t), store = f.openStore(), journal = f.openJournal(), input = inventory();
    const pending = journal.stage(input.records, { details: input.details, codes: input.codes });
    assert.equal(pending.protocolVersion, 3);
    const receipt = store.publish({ ...pending, deviceId: 'device-A' });
    journal.close();
    const resumed = f.openJournal();
    assert.deepEqual(resumed.pending(), pending);
    const before = resumed.db.serialize();
    assert.throws(() => resumed.stage(input.records, { details: input.details }),
        { code: 'REQUEST_CONFLICT' });
    const changed = inventory('changed');
    assert.throws(() => resumed.stage(changed.records, {
        details: changed.details, codes: changed.codes,
    }), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => resumed.acknowledge(pending.requestId, {
        ...receipt, digest: '0'.repeat(64),
    }), { code: 'REQUEST_CONFLICT' });
    assert.deepEqual(resumed.db.serialize(), before);
    assert.deepEqual(store.publish({ ...resumed.pending(), deviceId: 'device-A' }), receipt);
    resumed.acknowledge(pending.requestId, receipt);
    assert.equal(resumed.pending(), null);
    assert.equal(resumed.stage(input.records, { details: input.details, codes: input.codes }), null);
    const next = resumed.stage(input.records, { details: input.details });
    assert.equal(next.protocolVersion, 2);
    assert.equal(next.expectedVersion, 1);
});