'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { CatalogBrowser } = require('../../Plugin/ServerProjectForge/catalogBrowser');
const { CatalogHost } = require('../../Plugin/ServerProjectForge/catalogHost');
const { CodeSnapshot } = require('../../Plugin/ServerProjectForge/catalogCodePages');
const { projectEngineeringDetail } = require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');
const id = 'remote:' + 'c'.repeat(64);
const binding = { sourceId: 'source-A', localProjectId: 'p1',
    version: 7, digest: 'a'.repeat(64), node: 9 };
const options = { version: binding.version, digest: binding.digest, node: binding.node };
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
};
function fixture() {
    const text = '\uFEFF中文🌿\r\n'.repeat(500), bytes = Buffer.from(text);
    const value = { version: 1, state: 'shared', file: {
        file_path: 'src/a.js', node: 9, batch: 3,
        before: { state: 'absent', hash: null, size: 0, text: null },
        after: { state: 'text', hash: crypto.createHash('sha256').update(bytes).digest('hex'),
            size: bytes.length, text },
    } };
    const engineering = projectEngineeringDetail({
        project: {}, batches: [], batchTotal: 0, fileTotal: 1,
        files: [{ file_path: 'src/a.js', edits: 1, added: 1, removed: 0, last_node: 9 }],
    }, { shared: true });
    const entry = { id, kind: 'source', pin: {
        sourceId: binding.sourceId, version: binding.version, digest: binding.digest,
    }, summary: { localProjectId: 'p1' } };
    let calls = 0;
    const snapshot = new CodeSnapshot(value, binding);
    const client = { hubId: 'hub-11111111-2222-4333-8444-555555555555',
        async getCatalogCode(sourceId, args) {
            calls++;
            assert.equal(sourceId, binding.sourceId);
            return { ...binding, page: snapshot.page({ cursor: args.cursor }) };
        },
    };
    const browser = new CatalogBrowser(client);
    browser.entries.set(id, clone(entry));
    return { value, engineering, entry, client, browser, snapshot, calls: () => calls,
        read: () => browser.code(id, options, engineering) };
}
test('assembly preserves exact text and keeps publication version distinct from format version', async () => {
    const f = fixture(), result = await f.read();
    assert.ok(f.calls() > 1);
    assert.deepEqual(result.binding, binding);
    assert.equal(result.version, 1);
    assert.equal(result.binding.version, 7);
    assert.deepEqual(result.file, f.value.file);
    result.file.after.text = 'caller mutation';
    assert.deepEqual((await f.read()).file, f.value.file);
});
test('stale pins, unrelated nodes and global entries are refused before network', async () => {
    const f = fixture();
    for (const change of [{ version: 6 }, { digest: '0'.repeat(64) }, { node: 8 }]) {
        await assert.rejects(f.browser.code(id, { ...options, ...change }, f.engineering));
    }
    f.browser.entries.set(id, { ...f.entry, kind: 'global' });
    await assert.rejects(f.read(), { code: 'NOT_FOUND' });
    assert.equal(f.calls(), 0);
});
test('digest, file ownership, text hashes and response whitelist are all checked', async () => {
    for (const mutate of [
        v => { v.file.file_path = 'other.js'; },
        v => { v.file.node = 10; },
        v => { v.file.after.text = 'corrupt'; },
        v => { v.extra = true; },
        v => { v.state = 'unknown'; },
    ]) {
        const f = fixture(), value = clone(f.value);
        mutate(value);
        const snapshot = new CodeSnapshot(value, binding);
        f.client.getCatalogCode = async (_, args) =>
            ({ ...binding, page: snapshot.page({ cursor: args.cursor }) });
        await assert.rejects(f.read(), { code: 'INVALID_RESPONSE' });
    }
    const f = fixture();
    f.client.getCatalogCode = async (_, args) => {
        const page = f.snapshot.page({ cursor: args.cursor });
        page.snapshot = '0'.repeat(64);
        if (page.next) page.next.snapshot = page.snapshot;
        return { ...binding, page };
    };
    await assert.rejects(f.read());
});
test('not-shared is explicit; malformed page identity and changing totals are refused', async () => {
    const f = fixture();
    const unshared = new CodeSnapshot({ version: 1, state: 'not-shared' }, binding);
    f.client.getCatalogCode = async () => ({ ...binding, page: unshared.page() });
    assert.deepEqual(await f.read(), { binding, version: 1, state: 'not-shared' });
    f.client.getCatalogCode = async () => ({
        ...binding, localProjectId: 'other', page: unshared.page(),
    });
    await assert.rejects(f.read(), { code: 'INVALID_RESPONSE' });
    const g = fixture();
    g.client.getCatalogCode = async (_, args) => {
        const page = g.snapshot.page({ cursor: args.cursor });
        if (args.cursor) page.total++;
        return { ...binding, page };
    };
    await assert.rejects(g.read(), { code: 'INVALID_RESPONSE' });
});
test('clear, identical-entry refresh generation and close invalidate in-flight responses', async () => {
    for (const action of ['clear', 'refresh', 'close']) {
        const f = fixture(), pending = deferred();
        f.client.getCatalogCode = () => pending.promise;
        const read = f.read();
        if (action === 'refresh') {
            f.browser.entries = new Map([[id, clone(f.entry)]]);
            f.browser.generation = {};
        } else f.browser[action]();
        pending.resolve({ ...binding, page: f.snapshot.page() });
        await assert.rejects(read, { code: action === 'close' ? 'CLOSED' : 'REQUEST_CONFLICT' });
    }
});
test('host never caches code or substitutes stale source on network failure', async () => {
    const f = fixture();
    const host = new CatalogHost({ config: { read: true, client: f.client } });
    host.browser = f.browser;
    host.details.set(id, { engineering: f.engineering });
    const before = JSON.stringify([...host.details]);
    assert.equal((await host.getRemoteCode(id, options)).state, 'shared');
    assert.equal(JSON.stringify([...host.details]), before);
    f.client.getCatalogCode = async () => {
        throw Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR' });
    };
    await assert.rejects(host.getRemoteCode(id, options), { code: 'NETWORK_ERROR' });
    assert.equal(JSON.stringify([...host.details]), before);
    await host.stop();
});
test('late authentication denial invalidates even a newer generation; stop blocks late success', async () => {
    for (const mode of ['denied', 'stop']) {
        const f = fixture(), pending = deferred();
        f.client.getCatalogCode = () => pending.promise;
        const host = new CatalogHost({ config: { read: true, client: f.client } });
        host.browser = f.browser;
        host.details.set(id, { engineering: f.engineering });
        const read = host.getRemoteCode(id, options);
        if (mode === 'denied') {
            f.browser.generation = {};
            pending.reject(Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' }));
            await assert.rejects(read, { code: 'FORBIDDEN' });
            assert.equal(f.browser.entries.size, 0);
            assert.equal(host.details.size, 0);
        } else {
            await host.stop();
            pending.resolve({ ...binding, page: f.snapshot.page() });
            await assert.rejects(read, { code: 'CLOSED' });
        }
        await host.stop();
    }
});

test('host cache miss fetches metadata online without retaining source or metadata', async () => {
    const f = fixture();
    const host = new CatalogHost({ config: { read: true, client: f.client } });
    host.browser = f.browser;
    let metadataCalls = 0;
    f.browser.detail = async () => {
        metadataCalls++;
        return { engineering: f.engineering };
    };
    try {
        await assert.rejects(host.getRemoteCode(id, { ...options, version: 6 }),
            { code: 'REQUEST_CONFLICT' });
        assert.equal(metadataCalls, 0);
        assert.equal(f.calls(), 0);
        assert.deepEqual((await host.getRemoteCode(id, options)).file, f.value.file);
        assert.equal(metadataCalls, 1);
        assert.equal(host.details.size, 0);
        const codeCalls = f.calls();
        f.browser.detail = async () => {
            throw Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR' });
        };
        await assert.rejects(host.getRemoteCode(id, options), { code: 'NETWORK_ERROR' });
        assert.equal(f.calls(), codeCalls);
    } finally { await host.stop(); }
});

test('cache-miss metadata cannot survive refresh, stop or authentication denial', async () => {
    for (const mode of ['refresh', 'stop', 'denied']) {
        const f = fixture(), pending = deferred();
        const host = new CatalogHost({ config: { read: true, client: f.client } });
        host.browser = f.browser;
        f.browser.detail = () => pending.promise;
        const read = host.getRemoteCode(id, options);
        if (mode === 'stop') await host.stop();
        else f.browser.generation = {};
        if (mode === 'denied') {
            pending.reject(Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' }));
        } else pending.resolve({ engineering: f.engineering });
        await assert.rejects(read, {
            code: mode === 'stop' ? 'CLOSED' : mode === 'denied' ? 'FORBIDDEN' : 'REQUEST_CONFLICT',
        });
        assert.equal(f.calls(), 0);
        assert.equal(host.details.size, 0);
        if (mode === 'denied') assert.equal(f.browser.entries.size, 0);
        await host.stop();
    }
});