'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto');
const { HubStore } = require('../../Plugin/ServerProjectForge/hubStore');
const { HubContentStore } = require('../../Plugin/ServerProjectForge/hubContentStore');
const { CatalogSourceStore } = require('../../Plugin/ServerProjectForge/catalogSourceStore');
const { HubNetworkServer } = require('../../Plugin/ServerProjectForge/hubNetworkServer');
const { HubNetworkClient } = require('../../Plugin/ServerProjectForge/hubNetworkClient');
const { projectEngineeringDetail } = require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');
const { codeDigest, validateCodePage } = require('../../Plugin/ServerProjectForge/catalogCodePages');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const at = '2026-10-22T02:00:00.000Z';
function publication(text = '\uFEFFPRIVATE_SOURCE_中文🌿\r\n'.repeat(200)) {
    const detail = projectEngineeringDetail({
        project: { report: 'public report' }, batches: [], batchTotal: 0,
        files: [{ file_path: 'src/a.js', edits: 1, added: 1, removed: 0, last_node: 1 }],
        fileTotal: 1,
    }, { shared: true });
    return {
        sourceId: 'source-A', expectedVersion: 0, requestId: 'request-1', protocolVersion: 3,
        records: [{
            identity: { sourceId: 'source-A', localProjectId: 'p1' },
            project: { id: 'p1', name: 'test', status: 'active', availability: 'ready',
                created_at: at, updated_at: at, deleted_at: null }, todos: [],
        }],
        details: [{ localProjectId: 'p1', detail }],
        codes: [{ localProjectId: 'p1', code: { version: 1, state: 'shared', files: [{
            file_path: 'src/a.js', node: 1, batch: 1,
            before: { state: 'absent', hash: null, size: 0, text: null },
            after: { state: 'text', hash: sha(Buffer.from(text)),
                size: Buffer.byteLength(text), text },
        }] } }],
    };
}
async function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-code-network-'));
    const content = new HubContentStore(path.join(root, 'content.db'));
    const hub = new HubStore(path.join(root, 'hub.db'), { contentStore: content });
    const catalog = new CatalogSourceStore(path.join(root, 'catalog.db'), { hubId: hub.getHubId() });
    const tokens = {}, principals = [];
    for (const [device, permissions, sources, codeSources] of [
        ['P', ['catalog:publish', 'catalog:code:publish'], ['source-A', 'source-B']],
        ['L', ['catalog:publish', 'catalog:read'], ['source-A']],
        ['R', ['catalog:read', 'catalog:code:read'], ['source-A'], ['source-A']],
        ['X', ['catalog:read', 'catalog:code:read'], ['source-X'], ['source-X']],
        ['C', ['catalog:code:read'], ['source-A'], ['source-A']],
        ['M', ['catalog:read', 'catalog:code:read'], ['source-A', 'source-B'], ['source-A']],
        ['D', ['catalog:read', 'catalog:code:read'], ['source-A']],
        ['E', ['catalog:read', 'catalog:code:read'], ['source-A'], []],
        ['N', ['catalog:read', 'catalog:code:read'], ['source-B'], ['source-A']],
    ]) {
        tokens[device] = crypto.randomBytes(32).toString('base64url');
        principals.push({ token: tokens[device], deviceId: device,
            originIds: [], projectIds: [], permissions,
            catalogOriginIds: sources, catalogPublishSourceIds: sources,
            ...(codeSources === undefined ? {} : { catalogCodeOriginIds: codeSources }) });
    }
    const server = new HubNetworkServer(hub, path.join(root, 'network.db'),
        { principals, catalogStore: catalog });
    t.after(async () => {
        await server.close();
        catalog.close(); hub.close(); content.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const endpoint = await server.listen();
    const clients = Object.fromEntries(Object.entries(tokens).map(([deviceId, token]) =>
        [deviceId, new HubNetworkClient(endpoint.baseUrl, { deviceId, token, hubId: hub.getHubId() })]));
    return { ...clients, catalog, hub };
}
const pin = receipt => ({
    localProjectId: 'p1', version: receipt.version, digest: receipt.digest, node: 1,
});

test('HTTP v3 publication and paged read preserve bytes without any lease or global registration', async t => {
    const f = await fixture(t), input = publication();
    const receipt = await f.P.publishCatalogSource(input);
    assert.deepEqual(await f.P.publishCatalogSource(input), receipt);
    const binding = { sourceId: 'source-A', ...pin(receipt) }, parts = [];
    let cursor = null, snapshot, total;
    do {
        const result = await f.R.getCatalogCode('source-A', { ...pin(receipt), cursor });
        if (snapshot === undefined) { snapshot = result.page.snapshot; total = result.page.total; }
        assert.equal(result.page.snapshot, snapshot);
        assert.equal(result.page.total, total);
        parts.push(validateCodePage(result.page, cursor));
        cursor = result.page.next;
    } while (cursor !== null);
    assert.ok(parts.length > 1);
    const bytes = Buffer.concat(parts);
    assert.equal(bytes.length, total);
    assert.equal(codeDigest(binding, bytes), snapshot);
    assert.deepEqual(JSON.parse(bytes.toString('utf8')).file, input.codes[0].code.files[0]);
    assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_projects').get().n, 0);
});

test('legacy directory privileges do not grant code publication or code reading', async t => {
    const f = await fixture(t), input = publication();
    await assert.rejects(f.L.publishCatalogSource(input), { code: 'FORBIDDEN' });
    assert.equal(f.catalog.get('source-A'), null);
    const receipt = await f.P.publishCatalogSource(input);
    for (const client of [f.L, f.C, f.X]) {
        await assert.rejects(client.getCatalogCode('source-A', pin(receipt)), { code: 'FORBIDDEN' });
    }
    const source = await f.L.getCatalogSource('source-A', {
        version: receipt.version, digest: receipt.digest,
    });
    assert.doesNotMatch(JSON.stringify(source), /PRIVATE_SOURCE/);
    const details = await f.L.getCatalogEngineering('source-A', {
        localProjectId: 'p1', version: receipt.version, digest: receipt.digest, section: 'files',
    });
    assert.doesNotMatch(JSON.stringify(details), /PRIVATE_SOURCE/);
    await assert.rejects(f.X.getCatalogCode('unknown-source', pin(receipt)), { code: 'FORBIDDEN' });
});

test('source updates invalidate old pins and cursors; foreign nodes never resolve by local ID', async t => {
    const f = await fixture(t), input = publication();
    const first = await f.P.publishCatalogSource(input);
    const page = await f.R.getCatalogCode('source-A', pin(first));
    const second = await f.P.publishCatalogSource({
        ...publication('new source'), expectedVersion: 1, requestId: 'request-2',
    });
    await assert.rejects(f.R.getCatalogCode('source-A', {
        ...pin(first), cursor: page.page.next,
    }), { code: 'REQUEST_CONFLICT' });
    await assert.rejects(f.R.getCatalogCode('source-A', {
        ...pin(second), node: 2,
    }), { code: 'NOT_FOUND' });
    await assert.rejects(f.R.getCatalogCode('source-A', {
        ...pin(second), localProjectId: 'p2',
    }), { code: 'NOT_FOUND' });
    // Keep offset valid for the new value to isolate cursor snapshot binding.
    await assert.rejects(f.R.getCatalogCode('source-A', {
        ...pin(second), cursor: { snapshot: page.page.snapshot, offset: 1 },
    }), { code: 'REQUEST_CONFLICT' });
});

test('raw requests cannot inject scope or send v3 through the engineering route', async t => {
    const f = await fixture(t), input = publication();
    await assert.rejects(f.P._request('POST', '/v1/catalog/engineering/publish', {
        bytes: Buffer.from(JSON.stringify(input)),
    }), { code: 'INVALID_BODY' });
    const receipt = await f.P.publishCatalogSource(input);
    await assert.rejects(f.R._request('POST', '/v1/catalog/code/detail', {
        value: { sourceId: 'source-A', ...pin(receipt), catalogOriginIds: ['source-X'] },
    }), { code: 'INVALID_BODY' });
    const before = f.catalog.db.serialize();
    await assert.rejects(f.P.publishCatalogSource({
        ...input, expectedVersion: 1, requestId: 'bad', codes: [],
    }));
    assert.deepEqual(f.catalog.db.serialize(), before);
});
test('code scope is independent, default-deny and intersected with directory scope', async t => {
    const f = await fixture(t);
    const a = await f.P.publishCatalogSource(publication('source A'));
    const inputB = publication('source B');
    inputB.sourceId = 'source-B';
    inputB.records[0].identity.sourceId = 'source-B';
    const b = await f.P.publishCatalogSource(inputB);
    for (const [sourceId, receipt] of [['source-A', a], ['source-B', b]]) {
        const directory = await f.M.getCatalogSource(sourceId, {
            version: receipt.version, digest: receipt.digest,
        });
        assert.doesNotMatch(JSON.stringify(directory), /source A|source B/);
        await f.M.getCatalogEngineering(sourceId, {
            localProjectId: 'p1', version: receipt.version, digest: receipt.digest, section: 'files',
        });
    }
    await f.M.getCatalogCode('source-A', pin(a));
    await assert.rejects(f.M.getCatalogCode('source-B', pin(b)), { code: 'FORBIDDEN' });
    for (const client of [f.D, f.E, f.N]) {
        await assert.rejects(client.getCatalogCode('source-A', pin(a)), { code: 'FORBIDDEN' });
    }
    await assert.rejects(f.M.getCatalogCode('unknown-source', pin(a)), { code: 'FORBIDDEN' });
    await assert.rejects(f.M._request('POST', '/v1/catalog/code/detail', {
        value: { sourceId: 'source-B', ...pin(b), catalogCodeOriginIds: ['source-B'] },
    }), { code: 'INVALID_BODY' });
});