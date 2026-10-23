'use strict';
// Real HTTP on ephemeral loopback ports. All credentials, bytes and DBs are synthetic.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), http = require('node:http'), net = require('node:net');
const plugin = path.resolve(__dirname, '../../Plugin/ServerProjectForge');
const { ProjectStore } = require(path.join(plugin, 'store'));
const { exportProjectBundle } = require(path.join(plugin, 'projectBundle'));
const { ProjectTakeover } = require(path.join(plugin, 'projectTakeover'));
const { HubContentStore } = require(path.join(plugin, 'hubContentStore'));
const { HubStore } = require(path.join(plugin, 'hubStore'));
const { HubNetworkServer } = require(path.join(plugin, 'hubNetworkServer'));
const { HubNetworkClient } = require(path.join(plugin, 'hubNetworkClient'));
const code = expected => error => error.code === expected;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
async function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-network-'));
    const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
    const source = new ProjectStore(path.join(root, 'source.db'));
    const p = source.createProject({ name: '网络合成工程', root: sourceRoot, workspaceAlias: 'source' });
    source.addTodos(p.id, ['retain progress']);
    const text = Buffer.from('\uFEFF中文\r\n'), binary = Buffer.from([0, 255, 128, 3]);
    const batch = source.createBatch(p.id, 'create', 'synthetic seed', 'Kerr');
    for (const [name, bytes] of [['a.txt', text], ['nested/b.bin', binary]]) {
        fs.mkdirSync(path.dirname(path.join(sourceRoot, name)), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, name), bytes);
        source.addNode({ projectId: p.id, batchId: batch, filePath: name,
            op: 'create', beforeHash: null, afterHash: source.putBlob(bytes) });
    }
    const bundle = exportProjectBundle(source, p.id), tokens = { A: token(), B: token(), R: token(), X: token() };
    const content = new HubContentStore(path.join(root, 'content.db'));
    let now = 100000;
    const hub = new HubStore(path.join(root, 'hub.db'), { contentStore: content, clock: () => now });
    const principals = [
        { token: tokens.A, deviceId: 'A', originIds: ['origin-A'], projectIds: [], permissions: ['read', 'write', 'register'] },
        { token: tokens.B, deviceId: 'B', originIds: ['origin-A'], projectIds: [], permissions: ['read', 'write'] },
        { token: tokens.R, deviceId: 'R', originIds: ['origin-A'], projectIds: [], permissions: ['read'] },
        { token: tokens.X, deviceId: 'X', originIds: ['origin-X'], projectIds: [], permissions: ['read', 'write', 'register'] },
    ];
    const servers = [];
    const ownedCatalogStores = [];
    const open = async (opts = {}) => {
        const s = new HubNetworkServer(hub, path.join(root, 'network.db'), { principals, ...options, ...opts });
        servers.push(s); const endpoint = await s.listen();
        rawHubIds.set(endpoint.baseUrl, hub.getHubId());
        return { s, endpoint };
    };
    t.after(async () => {
        for (const server of servers) await server.close();
        for (const catalog of ownedCatalogStores) catalog.close();
        hub.close(); content.close(); source.close(); fs.rmSync(root, { recursive: true, force: true });
    });
    const { s, endpoint } = await open();
    const client = (device, config = {}) => new HubNetworkClient(endpoint.baseUrl, {
        token: tokens[device], deviceId: device, hubId: hub.getHubId(),
        ...(options.tls ? { ca: options.tls.cert } : {}), ...config,
    });
    const A = client('A'), B = client('B'), R = client('R'), X = client('X');
    const global = await A.registerProject({ originId: 'origin-A', localProjectId: p.id, name: p.name });
    const lease = await A.acquireLease({ projectId: global.id, requestId: 'lease-A', ttlMs: 1000 });
    const publish = extra => A.publishRevision({
        ...lease, requestId: 'pub-A', expectedRevision: 0, bundleHash: bundle.sha256, ...extra,
    });
    const upload = (who = A, credentials = lease) => who.uploadBundle({
        projectId: global.id, bundle: bundle.bytes, expectedHash: bundle.sha256, lease: credentials,
    });
    return { root, source, text, binary, bundle, tokens, content, hub, server: s, endpoint,
        principals, open, client, A, B, R, X, global, lease, publish, upload,
        ownedCatalogStores, advance: ms => { now += ms; } };
}
const rawHubIds = new Map(); // Synthetic per-endpoint test pins, never credentials.
function raw(baseUrl, route, { method = 'GET', token: secret, body, headers = {} } = {}) {
    const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const h = { Connection: 'close', 'X-PF-Hub-Id': rawHubIds.get(baseUrl), ...(secret ? { Authorization: 'Bearer ' + secret } : {}) };
    if (bytes) Object.assign(h, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) });
    Object.assign(h, headers);
    return new Promise((resolve, reject) => {
        const req = http.request(baseUrl + route, { method, headers: h, agent: false }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.once('end', () => {
                const bytes = Buffer.concat(chunks); let data;
                try { data = JSON.parse(bytes); } catch { data = null; }
                resolve({ status: res.statusCode, data, bytes });
            });
            res.once('error', reject);
        });
        req.once('error', reject); req.setTimeout(5000, () => req.destroy(Error('raw timeout'))); req.end(bytes);
    });
}
test('real HTTP A upload/publish -> B verified download -> new local directory takeover', async t => {
    const f = await fixture(t);
    assert.deepEqual(await f.A.identity(), { hubId: f.hub.getHubId(), protocol: 1, deviceId: 'A' });
    await f.upload(); assert.equal((await f.B.getProject(f.global.id)).revision, 0);
    const r = await f.publish(); assert.equal(r.revision, 1);
    const downloaded = await f.B.downloadRevision(f.global.id, 1);
    assert.deepEqual(downloaded.bytes, f.bundle.bytes);
    const receiver = new ProjectStore(path.join(f.root, 'receiver.db'));
    const parent = path.join(f.root, 'targets'); fs.mkdirSync(parent);
    const takeover = new ProjectTakeover(receiver, path.join(f.root, 'publication.db'));
    try {
        const args = { requestId: 'network-receive', bundle: downloaded.bytes, expectedHash: downloaded.revision.bundleHash,
            target: { root: path.join(parent, 'incoming'), workspaceAlias: 'B' } };
        const one = takeover.takeover(args), again = takeover.takeover(args);
        assert.equal(one.projectId, again.projectId);
        assert.equal(receiver.listTodos(one.projectId).length, 1);
        assert.deepEqual(fs.readFileSync(path.join(args.target.root, 'a.txt')), f.text);
        assert.deepEqual(fs.readFileSync(path.join(args.target.root, 'nested/b.bin')), f.binary);
        assert.equal(receiver.db.prepare('SELECT count(*) AS n FROM projects').get().n, 1);
    } finally { takeover.close(); receiver.close(); }
});
test('no or incorrect credential is rejected without reflecting secrets', async t => {
    const f = await fixture(t);
    for (const credential of [undefined, token()]) {
        const r = await raw(f.endpoint.baseUrl, '/v1/identity', { token: credential });
        assert.equal(r.status, 401); assert.equal(r.data.error.code, 'UNAUTHENTICATED');
        assert.equal(r.bytes.includes(Buffer.from(f.tokens.A)), false);
    }
});
test('scope and permissions deny cross-project metadata, leases and registration', async t => {
    const f = await fixture(t);
    await assert.rejects(f.X.getProject(f.global.id), code('FORBIDDEN'));
    await assert.rejects(f.X.acquireLease({ projectId: f.global.id, requestId: 'steal' }), code('FORBIDDEN'));
    await assert.rejects(f.X.registerProject({ originId: 'origin-A', localProjectId: 'p-fake', name: 'fake' }), code('FORBIDDEN'));
    await assert.rejects(f.R.acquireLease({ projectId: f.global.id, requestId: 'readonly' }), code('FORBIDDEN'));
    assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_projects').get().n, 1);
});
test('JSON cannot spoof holder or smuggle unrecognized lease fields', async t => {
    const f = await fixture(t);
    const r = await raw(f.endpoint.baseUrl, '/v1/projects/' + f.global.id + '/lease/acquire', {
        token: f.tokens.B, method: 'POST', body: { requestId: 'impersonate', holder: 'A' },
    });
    assert.equal(r.data.error.code, 'INVALID_BODY');
    await assert.rejects(f.B.acquireLease({ projectId: f.global.id, requestId: 'B-busy' }), code('LEASE_BUSY'));
});
test('uploaded bytes alone and guessed global content hash cannot create a network revision', async t => {
    const f = await fixture(t);
    f.content.put(f.bundle.bytes, { expectedHash: f.bundle.sha256 });
    await assert.rejects(f.publish(), code('UPLOAD_REQUIRED'));
    await f.upload(); await f.publish();
    const other = await f.X.registerProject({ originId: 'origin-X', localProjectId: 'p2', name: 'other' });
    const lease = await f.X.acquireLease({ projectId: other.id, requestId: 'lease-X', ttlMs: 1000 });
    await assert.rejects(f.X.publishRevision({ ...lease, requestId: 'guess', expectedRevision: 0,
        bundleHash: f.bundle.sha256 }), code('UPLOAD_REQUIRED'));
    const hidden = await raw(f.endpoint.baseUrl, '/v1/bundles/' + f.bundle.sha256, { token: f.tokens.X });
    assert.equal(hidden.status, 404);
});
test('duplicate upload/publication preserve one receipt and one revision; CAS still enforced', async t => {
    const f = await fixture(t); await f.upload(); await f.upload();
    const one = await f.publish(); assert.deepEqual(await f.publish(), one);
    assert.equal(f.server.db.prepare('SELECT count(*) AS n FROM network_uploads').get().n, 1);
    await assert.rejects(f.publish({ requestId: 'bad-base' }), code('REVISION_CONFLICT'));
    assert.equal((await f.A.getProject(f.global.id)).revision, 1);
});
test('lease rotation rejects old writer upload, renew, release and publish replay', async t => {
    const f = await fixture(t); await f.upload(); await f.publish(); f.advance(1000);
    const leaseB = await f.B.acquireLease({ projectId: f.global.id, requestId: 'lease-B', ttlMs: 1000 });
    await assert.rejects(f.upload(), code('STALE_LEASE'));
    await assert.rejects(f.A.renewLease(f.lease), code('STALE_LEASE'));
    await assert.rejects(f.A.releaseLease(f.lease), code('STALE_LEASE'));
    await assert.rejects(f.publish(), code('STALE_LEASE'));
    await f.B.publishRevision({ ...leaseB, requestId: 'pub-B', expectedRevision: 1, bundleHash: f.bundle.sha256 });
    assert.equal((await f.A.getProject(f.global.id)).revision, 2);
});
test('revoked during upload leaves at most unreferenced content, never an authorized receipt', async t => {
    let armed = true, f;
    f = await fixture(t, { _testHook: event => {
        if (armed && event === 'upload-content-stored') { armed = false; f.hub.releaseLease(f.lease); }
    } });
    await assert.rejects(f.upload(), code('STALE_LEASE'));
    assert.equal(f.server.db.prepare('SELECT count(*) AS n FROM network_uploads').get().n, 0);
    assert.deepEqual(f.content.get(f.bundle.sha256), f.bundle.bytes);
    const lease = await f.A.acquireLease({ projectId: f.global.id, requestId: 'new-lease', ttlMs: 1000 });
    await f.upload(f.A, lease);
    await f.A.publishRevision({ ...lease, requestId: 'retry', expectedRevision: 0, bundleHash: f.bundle.sha256 });
});
test('receipt survives service restart and remains tied to this Hub/content identity', async t => {
    const f = await fixture(t); await f.upload(); await f.server.close();
    const { endpoint } = await f.open();
    const A = new HubNetworkClient(endpoint.baseUrl, { token: f.tokens.A, deviceId: 'A', hubId: f.hub.getHubId() });
    await A.publishRevision({ ...f.lease, requestId: 'after-restart', expectedRevision: 0, bundleHash: f.bundle.sha256 });
    assert.deepEqual((await A.downloadRevision(f.global.id, 1)).bytes, f.bundle.bytes);
    const content = new HubContentStore(path.join(f.root, 'other-content.db'));
    const hub = new HubStore(path.join(f.root, 'other-hub.db'), { contentStore: content });
    try {
        assert.throws(() => new HubNetworkServer(hub, path.join(f.root, 'network.db'), { principals: f.principals }), code('CONTENT_BINDING'));
    } finally { hub.close(); content.close(); }
});
test('SQL receipt failure preserves unpublished content and retry completes without duplicate receipt', async t => {
    const f = await fixture(t);
    f.server.db.exec("CREATE TRIGGER reject_upload BEFORE INSERT ON network_uploads BEGIN SELECT RAISE(ABORT,'private-db-path'); END");
    await assert.rejects(f.upload(), code('INTERNAL'));
    assert.equal(f.server.db.prepare('SELECT count(*) AS n FROM network_uploads').get().n, 0);
    await assert.rejects(f.publish(), code('UPLOAD_REQUIRED'));
    f.server.db.exec('DROP TRIGGER reject_upload');
    await f.upload(); await f.publish(); assert.equal((await f.A.getProject(f.global.id)).revision, 1);
});
test('lost publication reply is not retried automatically; original request recovers accepted revision', async t => {
    let armed = true;
    const f = await fixture(t, { _testHook: event => {
        if (armed && event === 'revision-published') { armed = false; throw Error('lost after commit'); }
    } });
    await f.upload(); await assert.rejects(f.publish(), code('INTERNAL'));
    assert.equal(f.hub.getProject(f.global.id).revision, 1);
    assert.equal((await f.B.getRevision(f.global.id, 1)).requestId, 'pub-A');
    assert.equal((await f.publish()).revision, 1);
    assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_revisions').get().n, 1);
});
for (const [name, route, headers, expected] of [
    ['browser origin', '/v1/identity', { Origin: 'https://browser.invalid' }, 'INVALID_HEADERS'],
    ['wrong Host', '/v1/identity', { Host: 'attacker.invalid' }, 'INVALID_HEADERS'],
    ['query string', '/v1/identity?x=1', {}, 'NOT_FOUND'],
    ['encoded path', '/v1/%69dentity', {}, 'NOT_FOUND'],
    ['compressed body', '/v1/identity', { 'Content-Encoding': 'gzip' }, 'INVALID_HEADERS'],
]) test('strict request boundary: ' + name, async t => {
    const f = await fixture(t);
    const r = await raw(f.endpoint.baseUrl, route, { token: f.tokens.A, headers });
    assert.equal(r.data.error.code, expected);
});
test('bad JSON, wrong content type, upload hash and body bounds fail closed', async t => {
    const f = await fixture(t);
    const base = '/v1/projects/' + f.global.id;
    let r = await raw(f.endpoint.baseUrl, base + '/lease/acquire', { token: f.tokens.A, method: 'POST', body: Buffer.from('{') });
    assert.equal(r.data.error.code, 'INVALID_JSON');
    r = await raw(f.endpoint.baseUrl, base + '/lease/acquire', { token: f.tokens.A, method: 'POST', body: {},
        headers: { 'Content-Type': 'text/plain' } });
    assert.equal(r.data.error.code, 'UNSUPPORTED_MEDIA');
    r = await raw(f.endpoint.baseUrl, base + '/bundles/' + '0'.repeat(64), { token: f.tokens.A, method: 'PUT',
        body: f.bundle.bytes, headers: { 'Content-Type': 'application/octet-stream',
            'X-PF-Lease-Id': f.lease.leaseId, 'X-PF-Fence': String(f.lease.fence) } });
    assert.equal(r.data.error.code, 'HASH_MISMATCH');
    r = await raw(f.endpoint.baseUrl, base + '/lease/acquire', { token: f.tokens.A, method: 'POST',
        body: Buffer.alloc(16385, 32) });
    assert.equal(r.status, 413);
    assert.equal(f.server.db.prepare('SELECT count(*) AS n FROM network_uploads').get().n, 0);
});
test('stored tampering is detected on network publish replay and download', async t => {
    const f = await fixture(t); await f.upload(); await f.publish();
    f.content.db.prepare("UPDATE content_bundles SET source_project_id='tampered'").run();
    await assert.rejects(f.publish(), code('CORRUPT_CONTENT'));
    await assert.rejects(f.B.downloadRevision(f.global.id, 1), code('CORRUPT_CONTENT'));
});
test('bind and client endpoint rules reject cleartext remote hosts, credentials and ambiguous origins', async t => {
    const f = await fixture(t);
    assert.throws(() => new HubNetworkServer(f.hub, path.join(f.root, 'unsafe.db'),
        { principals: f.principals, host: '0.0.0.0' }), code('TLS_REQUIRED'));
    for (const url of ['http://example.invalid', 'http://localhost:1234', 'http://127.0.0.1/path',
        'http://user:pass@127.0.0.1', 'http://127.0.0.1/?q=1', 'http://127.0.0.1/#fragment']) {
        assert.throws(() => new HubNetworkClient(url, { token: f.tokens.A, hubId: f.hub.getHubId(), deviceId: 'A' }));
    }
    await assert.rejects(f.client('A', { hubId: 'hub-' + crypto.randomUUID() }).identity(), code('HUB_MISMATCH'));
    await assert.rejects(f.client('A', { deviceId: 'B' }).identity(), code('IDENTITY_MISMATCH'));
});
async function fake(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
    return 'http://127.0.0.1:' + server.address().port;
}
function json(res, data, status = 200, headers = {}) {
    const bytes = Buffer.from(JSON.stringify(data));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, Connection: 'close', ...headers });
    res.end(bytes);
}
test('client refuses redirects without sending bearer to another server', async t => {
    let redirected = 0;
    const target = await fake(t, (_req, res) => { redirected++; json(res, {}); });
    const source = await fake(t, (_req, res) => json(res, {}, 307, { Location: target + '/v1/identity' }));
    const client = new HubNetworkClient(source, { token: token(), hubId: 'hub-' + crypto.randomUUID(), deviceId: 'A' });
    await assert.rejects(client.identity(), code('REDIRECT_REFUSED')); assert.equal(redirected, 0);
});
test('client enforces response length/type/Hub identity without reflecting remote error text', async t => {
    const hubId = 'hub-' + crypto.randomUUID(), secret = token(); let mode = 'large';
    const source = await fake(t, (_req, res) => {
        if (mode === 'large') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 999999 }); res.end(); }
        if (mode === 'type') json(res, { hubId, result: {} }, 200, { 'Content-Type': 'text/plain' });
        if (mode === 'bad') json(res, { error: { code: 'dump:' + secret, message: secret } }, 500);
    });
    const client = new HubNetworkClient(source, { token: secret, hubId, deviceId: 'A' });
    await assert.rejects(client.identity(), code('RESPONSE_TOO_LARGE'));
    mode = 'type'; await assert.rejects(client.identity(), code('INVALID_RESPONSE'));
    mode = 'bad'; await assert.rejects(client.identity(), e => e.code === 'REMOTE_ERROR' && !e.message.includes(secret));
});
test('client total timeout is bounded and does not retry a request', async t => {
    let requests = 0;
    const source = await fake(t, () => { requests++; });
    const client = new HubNetworkClient(source, { token: token(), hubId: 'hub-' + crypto.randomUUID(),
        deviceId: 'A', limits: { requestMs: 150 } });
    await assert.rejects(client.identity(), code('REQUEST_TIMEOUT')); assert.equal(requests, 1);
});
test('partial headers cannot hold a server connection indefinitely', async t => {
    const f = await fixture(t, { limits: { requestMs: 300 } }), url = new URL(f.endpoint.baseUrl);
    const started = Date.now();
    await new Promise((resolve, reject) => {
        const socket = net.connect(Number(url.port), '127.0.0.1', () => socket.write('GET /v1/identity HTTP/1.1\r\nHost: '));
        const timer = setTimeout(() => { socket.destroy(); reject(Error('Unbounded header socket')); }, 3000);
        socket.on('data', () => {}); socket.on('error', () => {});
        socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
    assert.ok(Date.now() - started < 2500);
});
test('wrong Hub pin rejects registration and upload before either database is changed', async t => {
    const f = await fixture(t), wrong = f.client('A', { hubId: 'hub-' + crypto.randomUUID() });
    await assert.rejects(wrong.registerProject({ originId: 'origin-A', localProjectId: 'p-wrong', name: 'no-write' }), code('HUB_MISMATCH'));
    await assert.rejects(wrong.uploadBundle({ projectId: f.global.id, bundle: f.bundle.bytes,
        expectedHash: f.bundle.sha256, lease: f.lease }), code('HUB_MISMATCH'));
    assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_projects').get().n, 1);
    assert.equal(f.content.db.prepare('SELECT count(*) AS n FROM content_bundles').get().n, 0);
    assert.equal(f.server.db.prepare('SELECT count(*) AS n FROM network_uploads').get().n, 0);
    assert.throws(() => { f.A.hubId = 'hub-' + crypto.randomUUID(); }, TypeError);
    assert.throws(() => { f.A.url = new URL('http://127.0.0.1:1'); }, TypeError);
});
test('real TLS verifies the configured CA and rejects an untrusted certificate', async t => {
    const tls = require('./helpers/forgeNetworkTls').syntheticTls();
    const f = await fixture(t, { tls });
    const trusted = f.client('A', { ca: tls.cert });
    await trusted.identity();
    await trusted.uploadBundle({ projectId: f.global.id, bundle: f.bundle.bytes, expectedHash: f.bundle.sha256, lease: f.lease });
    const published = await trusted.publishRevision({ ...f.lease, requestId: 'tls-publish', expectedRevision: 0,
        bundleHash: f.bundle.sha256 });
    assert.equal(published.revision, 1);
    assert.deepEqual((await f.client('B', { ca: tls.cert }).downloadRevision(f.global.id, 1)).bytes, f.bundle.bytes);
    await assert.rejects(f.client('A', { ca: undefined }).identity(), code('NETWORK_ERROR'));
});
test('explicit project grants work without exposing unrelated origins', async t => {
    const f = await fixture(t); await f.upload(); await f.publish(); await f.server.close();
    const secret = token(), { endpoint } = await f.open({ principals: [{
        token: secret, deviceId: 'project-reader', originIds: [], projectIds: [f.global.id], permissions: ['read'],
    }] });
    const reader = new HubNetworkClient(endpoint.baseUrl, { token: secret, deviceId: 'project-reader', hubId: f.hub.getHubId() });
    assert.deepEqual((await reader.downloadRevision(f.global.id, 1)).bytes, f.bundle.bytes);
    const hidden = f.hub.registerProject({ originId: 'origin-A', localProjectId: 'p-hidden', name: 'hidden' });
    await assert.rejects(reader.getProject(hidden.id), code('FORBIDDEN'));
    await assert.rejects(f.X.downloadRevision(f.global.id, 1));
});
test('missing pin, empty Origin, duplicate auth and excess headers are rejected', async t => {
    const f = await fixture(t);
    for (const headers of [
        { 'X-PF-Hub-Id': '' },
        { Origin: '' },
        { Authorization: ['Bearer ' + f.tokens.A, 'Bearer ' + f.tokens.B] },
        Object.fromEntries(Array.from({ length: 34 }, (_, i) => ['X-Extra-' + i, 'value'])),
    ]) {
        const r = await raw(f.endpoint.baseUrl, '/v1/identity', { token: f.tokens.A, headers });
        assert.ok(['HUB_MISMATCH', 'INVALID_HEADERS'].includes(r.data?.error?.code), JSON.stringify(r.data));
    }
});
test('lease expiring at the strict boundary cannot upload or publish', async t => {
    const f = await fixture(t); await f.upload(); f.advance(1000);
    await assert.rejects(f.upload(), code('LEASE_EXPIRED'));
    await assert.rejects(f.publish(), code('LEASE_EXPIRED'));
    assert.equal(f.hub.getProject(f.global.id).revision, 0);
});
test('valid digest of a semantically invalid package creates neither content nor receipt', async t => {
    const f = await fixture(t), bytes = Buffer.from('{"not":"a project bundle"}');
    const r = await raw(f.endpoint.baseUrl, '/v1/projects/' + f.global.id + '/bundles/' + sha(bytes), {
        method: 'PUT', token: f.tokens.A, body: bytes, headers: { 'Content-Type': 'application/octet-stream',
            'X-PF-Lease-Id': f.lease.leaseId, 'X-PF-Fence': String(f.lease.fence) },
    });
    assert.equal(r.data.error.code, 'INVALID_BUNDLE');
    assert.equal(f.content.db.prepare('SELECT count(*) AS n FROM content_bundles').get().n, 0);
    assert.equal(f.server.db.prepare('SELECT count(*) AS n FROM network_uploads').get().n, 0);
});
test('receipt quota permits duplicate retries and rejects a second distinct checkpoint', async t => {
    const f = await fixture(t, { limits: { maxReceipts: 1 } }); await f.upload(); await f.upload();
    const data = JSON.parse(f.bundle.bytes); data.project.name = 'another checkpoint';
    const bytes = Buffer.from(JSON.stringify(data)), hash = sha(bytes);
    await assert.rejects(f.A.uploadBundle({ projectId: f.global.id, bundle: bytes, expectedHash: hash,
        lease: f.lease }), code('CAPACITY_EXCEEDED'));
    assert.equal(f.server.db.prepare('SELECT count(*) AS n FROM network_uploads').get().n, 1);
    await assert.rejects(f.publish({ bundleHash: hash }), code('UPLOAD_REQUIRED'));
    await f.publish();
});
test('slow request body occupies one bounded slot; excess requests are refused and close cleans up', async t => {
    const f = await fixture(t, { limits: { maxInflight: 1, requestMs: 1500 } });
    const url = new URL(f.endpoint.baseUrl);
    const req = http.request({
        hostname: '127.0.0.1', port: url.port, path: '/v1/projects/' + f.global.id + '/lease/acquire', method: 'POST',
        headers: { Host: url.host, Authorization: 'Bearer ' + f.tokens.A, 'X-PF-Hub-Id': f.hub.getHubId(),
            'Content-Type': 'application/json', 'Content-Length': '100', Connection: 'close' },
    });
    req.on('error', () => {}); req.on('response', res => res.resume());
    const closed = new Promise(resolve => req.once('close', resolve));
    req.write('{');
    try {
        const end = Date.now() + 1000;
        while (!f.server.active && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(f.server.active, 1);
        const r = await raw(f.endpoint.baseUrl, '/v1/identity', { token: f.tokens.A });
        assert.equal(r.status, 429); assert.equal(r.data.error.code, 'BUSY');
        const start = Date.now(); await f.server.close(); await closed;
        assert.ok(Date.now() - start < 1000);
        assert.equal(f.hub.getProject(f.global.id).revision, 0);
    } finally { req.destroy(); }
});
test('slow request body times out without a new lease or upload receipt', async t => {
    const f = await fixture(t, { limits: { requestMs: 300 } }), url = new URL(f.endpoint.baseUrl);
    const start = Date.now();
    await new Promise((resolve, reject) => {
        const socket = net.connect(Number(url.port), '127.0.0.1', () => socket.write(
            'POST /v1/projects/' + f.global.id + '/lease/acquire HTTP/1.1\r\nHost: ' + url.host +
            '\r\nAuthorization: Bearer ' + f.tokens.A + '\r\nX-PF-Hub-Id: ' + f.hub.getHubId() +
            '\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'));
        const timer = setTimeout(() => { socket.destroy(); reject(Error('Unbounded request')); }, 3000);
        socket.on('error', () => {}); socket.on('data', () => {});
        socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
    assert.ok(Date.now() - start < 2500);
    assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_lease_requests').get().n, 1);
    assert.equal(f.server.db.prepare('SELECT count(*) AS n FROM network_uploads').get().n, 0);
});
test('client revalidates bytes even when a server sends the expected digest header', async t => {
    const f = await fixture(t); await f.upload(); const revision = await f.publish();
    const source = await fake(t, (req, res) => {
        if (!req.url.endsWith('/bundle')) { json(res, { hubId: f.hub.getHubId(), result: revision }); return; }
        const bytes = Buffer.from(f.bundle.bytes); bytes[bytes.length - 1] ^= 1;
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length,
            'X-PF-Hub-Id': f.hub.getHubId(), 'X-PF-Bundle-Hash': f.bundle.sha256 });
        res.end(bytes);
    });
    const client = new HubNetworkClient(source, { token: token(), hubId: f.hub.getHubId(), deviceId: 'B' });
    await assert.rejects(client.downloadRevision(f.global.id, 1), code('HASH_MISMATCH'));
});
async function crashServer(t, f, event) {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', `
        const path=require('node:path');
        process.once('message',async d=>{
            const {HubContentStore}=require(path.join(d.plugin,'hubContentStore'));
            const {HubStore}=require(path.join(d.plugin,'hubStore'));
            const {HubNetworkServer}=require(path.join(d.plugin,'hubNetworkServer'));
            try{
                const content=new HubContentStore(path.join(d.root,'content.db'));
                const hub=new HubStore(path.join(d.root,'hub.db'),{contentStore:content,clock:()=>100000});
                const server=new HubNetworkServer(hub,path.join(d.root,'network.db'),{
                    principals:d.principals,_testHook:e=>{if(e===d.event)process.exit(73)}
                });
                process.send({endpoint:await server.listen()});
            }catch(e){process.send({error:e.code||'CHILD_SETUP_FAILED'});process.exit(1)}
        });
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const exited = new Promise(resolve => child.once('exit', resolve));
    t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
    const endpoint = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error('Child startup timed out')); }, 10000);
        child.once('error', e => { clearTimeout(timer); reject(e); });
        child.once('exit', status => { clearTimeout(timer); reject(Error('Child startup exit ' + status)); });
        child.once('message', value => {
            clearTimeout(timer);
            if (value.error) reject(Error(value.error)); else resolve(value.endpoint);
        });
        child.send({ root: f.root, plugin, principals: f.principals, event });
    });
    return { client: new HubNetworkClient(endpoint.baseUrl, { token: f.tokens.A, deviceId: 'A',
        hubId: f.hub.getHubId() }), exited };
}
for (const event of ['upload-content-stored', 'upload-receipt-committed', 'revision-published']) {
    test('real server process.exit(73) recovery at ' + event, async t => {
        const f = await fixture(t);
        if (event === 'revision-published') await f.upload();
        await f.server.close();
        const crashed = await crashServer(t, f, event);
        if (event === 'revision-published') {
            await assert.rejects(crashed.client.publishRevision({ ...f.lease, requestId: 'crash-publish',
                expectedRevision: 0, bundleHash: f.bundle.sha256 }), code('NETWORK_ERROR'));
        } else {
            await assert.rejects(crashed.client.uploadBundle({ projectId: f.global.id, bundle: f.bundle.bytes,
                expectedHash: f.bundle.sha256, lease: f.lease }), code('NETWORK_ERROR'));
        }
        assert.equal(await crashed.exited, 73);
        const { s, endpoint } = await f.open();
        assert.equal(s.db.prepare('SELECT count(*) AS n FROM network_uploads').get().n,
            event === 'upload-content-stored' ? 0 : 1);
        const A = new HubNetworkClient(endpoint.baseUrl, { token: f.tokens.A, deviceId: 'A', hubId: f.hub.getHubId() });
        await A.uploadBundle({ projectId: f.global.id, bundle: f.bundle.bytes, expectedHash: f.bundle.sha256, lease: f.lease });
        const requestId = event === 'revision-published' ? 'crash-publish' : 'after-crash';
        const r = await A.publishRevision({ ...f.lease, requestId, expectedRevision: 0, bundleHash: f.bundle.sha256 });
        assert.equal(r.revision, 1);
        assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_revisions').get().n, 1);
        assert.deepEqual((await A.downloadRevision(f.global.id, 1)).bytes, f.bundle.bytes);
    });
}
for (const replay of [false, true]) {
    test('lease expires during content verification; ' + (replay ? 'replay' : 'first publish') + ' fails closed', async t => {
        const f = await fixture(t); await f.upload();
        if (replay) await f.publish();
        const get = f.content.get.bind(f.content);
        f.content.get = hash => { const bytes = get(hash); f.advance(1000); return bytes; };
        await assert.rejects(f.publish(), code('LEASE_EXPIRED'));
        assert.equal(f.hub.getProject(f.global.id).revision, replay ? 1 : 0);
        assert.equal(f.hub.db.prepare('SELECT count(*) AS n FROM hub_revisions').get().n, replay ? 1 : 0);
    });
}
test('publication timestamp reflects final content verification, not the earlier lease check', async t => {
    const f = await fixture(t); await f.upload();
    const get = f.content.get.bind(f.content);
    f.content.get = hash => { const bytes = get(hash); f.advance(100); return bytes; };
    const result = await f.publish();
    assert.equal(result.publishedAt, 100100);
    assert.equal(result.revision, 1);
});
test('fixed HTTPS pathPrefix through stripping reverse proxy retains auth, TLS and full checkpoint bytes', async t => {
    const f = await fixture(t), https = require('node:https');
    const tls = require('./helpers/forgeNetworkTls').syntheticTls();
    const upstream = new URL(f.endpoint.baseUrl), seen = [], prefix = '/forge-sync';
    const proxy = https.createServer(tls, (req, res) => {
        seen.push(req.url); // Route only; never store bearer headers.
        if (!req.url.startsWith(prefix + '/v1/')) {
            res.writeHead(404, { 'Content-Length': '0', Connection: 'close' }); res.end(); return;
        }
        const forwarded = http.request({ hostname: upstream.hostname, port: upstream.port,
            path: req.url.slice(prefix.length), method: req.method,
            headers: { ...req.headers, host: upstream.host }, agent: false }, answer => {
            res.writeHead(answer.statusCode, answer.headers); answer.pipe(res);
        });
        forwarded.on('error', () => { res.destroy(); });
        req.on('error', () => forwarded.destroy()); req.pipe(forwarded);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); });
    });
    const baseUrl = 'https://127.0.0.1:' + proxy.address().port;
    const options = { token: f.tokens.A, deviceId: 'A', hubId: f.hub.getHubId(), pathPrefix: prefix, ca: tls.cert };
    const client = new HubNetworkClient(baseUrl, options);
    assert.equal((await client.identity()).deviceId, 'A');
    await client.uploadBundle({ projectId: f.global.id, bundle: f.bundle.bytes, expectedHash: f.bundle.sha256, lease: f.lease });
    const r = await client.publishRevision({ ...f.lease, requestId: 'prefix-publish', expectedRevision: 0, bundleHash: f.bundle.sha256 });
    assert.equal(r.revision, 1);
    assert.deepEqual((await client.downloadRevision(f.global.id, 1)).bytes, f.bundle.bytes);
    await assert.rejects(new HubNetworkClient(baseUrl, { ...options, token: token() }).identity(), code('UNAUTHENTICATED'));
    const { ca, ...untrusted } = options;
    await assert.rejects(new HubNetworkClient(baseUrl, untrusted).identity(), code('NETWORK_ERROR'));
    assert.ok(seen.every(route => route.startsWith(prefix + '/v1/')));
    assert.ok(seen.some(route => route.endsWith('/revisions/1/bundle')));
});
test('pathPrefix rejects traversal, encoded/ambiguous paths and non-path targets before I/O', () => {
    const opts = { token: token(), deviceId: 'A', hubId: 'hub-' + crypto.randomUUID() };
    for (const prefix of ['/', '/a/', '/a//b', '/a/../b', '/%2e', '/a?x', '/a#x', 'a', '/a\\b', '//host', 'https://other']) {
        assert.throws(() => new HubNetworkClient('https://127.0.0.1', { ...opts, pathPrefix: prefix }), code('UNSAFE_ENDPOINT'));
    }
    assert.doesNotThrow(() => new HubNetworkClient('https://127.0.0.1', { ...opts, pathPrefix: '/forge-sync/v1-hub' }));
});
test('catalog-only HTTP principal can enumerate but cannot read bundles or acquire leases', async t => {
    const f = await fixture(t);
    const reader = {
        token: f.tokens.R, deviceId: 'R', originIds: [], projectIds: [],
        permissions: ['catalog:read'], catalogOriginIds: ['origin-A'],
    };
    const { endpoint } = await f.open({ principals: [reader] });
    const client = new HubNetworkClient(endpoint.baseUrl, {
        token: f.tokens.R, deviceId: 'R', hubId: f.hub.getHubId(),
    });
    const before = f.hub.db.prepare('SELECT * FROM hub_projects ORDER BY id').all();
    const page = await client.listCatalogProjects();
    assert.deepEqual(page.items.map(p => p.id), [f.global.id]);
    assert.equal(page.next, null);
    assert.equal(JSON.stringify(page).includes(f.lease.leaseId), false);
    await assert.rejects(client.getProject(f.global.id), code('FORBIDDEN'));
    await assert.rejects(client.downloadRevision(f.global.id, 1), code('FORBIDDEN'));
    await assert.rejects(client.acquireLease({
        projectId: f.global.id, requestId: 'catalog-must-not-write',
    }), code('FORBIDDEN'));
    await assert.rejects(client.registerProject({
        originId: 'origin-A', localProjectId: 'forbidden', name: 'no',
    }), code('FORBIDDEN'));
    const injected = await raw(endpoint.baseUrl, '/v1/catalog/projects', {
        token: f.tokens.R, method: 'POST', body: { originIds: ['origin-X'] },
    });
    assert.equal(injected.status, 400);
    assert.equal(injected.data.error.code, 'INVALID_BODY');
    assert.deepEqual(f.hub.db.prepare('SELECT * FROM hub_projects ORDER BY id').all(), before);
});

test('legacy read/write credentials receive no implicit catalog access', async t => {
    const f = await fixture(t);
    for (const client of [f.A, f.B, f.R, f.X]) {
        await assert.rejects(client.listCatalogProjects(), code('FORBIDDEN'));
    }
});

test('catalog scopes are independent and empty scopes do not inherit source access', async t => {
    const f = await fixture(t);
    const { endpoint } = await f.open({ principals: [{
        token: f.tokens.R, deviceId: 'R', originIds: ['origin-A'], projectIds: [f.global.id],
        permissions: ['read', 'catalog:read'],
    }] });
    const client = new HubNetworkClient(endpoint.baseUrl, {
        token: f.tokens.R, deviceId: 'R', hubId: f.hub.getHubId(),
    });
    assert.equal((await client.getProject(f.global.id)).id, f.global.id);
    assert.deepEqual(await client.listCatalogProjects(), { items: [], next: null });
});

test('catalog HTTP pagination returns all scoped projects without foreign rows', async t => {
    const f = await fixture(t);
    const expected = [f.global.id];
    for (let i = 0; i < 24; i++) {
        expected.push((await f.A.registerProject({
            originId: 'origin-A', localProjectId: 'catalog-' + i, name: '计划' + i,
        })).id);
    }
    const hidden = await f.X.registerProject({
        originId: 'origin-X', localProjectId: 'hidden', name: 'hidden',
    });
    const { endpoint } = await f.open({ principals: [{
        token: f.tokens.R, deviceId: 'R', originIds: [], projectIds: [],
        permissions: ['catalog:read'], catalogOriginIds: ['origin-A'],
    }] });
    const client = new HubNetworkClient(endpoint.baseUrl, {
        token: f.tokens.R, deviceId: 'R', hubId: f.hub.getHubId(),
    });
    const found = [];
    let after = '';
    do {
        const page = await client.listCatalogProjects({ after, limit: 7 });
        found.push(...page.items.map(p => p.id));
        after = page.next;
    } while (after !== null);
    assert.deepEqual(found, expected.sort());
    assert.equal(found.includes(hidden.id), false);
    await assert.rejects(client.listCatalogProjects({ limit: 21 }), code('INVALID_ARGUMENT'));
});
test('catalog plan HTTP returns paginated todos but no checkpoint files or blobs', async t => {
    const f = await fixture(t);
    f.source.addTodos(f.global.localProjectId, ['second plan']);
    const bundle = exportProjectBundle(f.source, f.global.localProjectId);
    await f.A.uploadBundle({
        projectId: f.global.id, bundle: bundle.bytes, expectedHash: bundle.sha256, lease: f.lease,
    });
    await f.publish({ bundleHash: bundle.sha256 });
    const { endpoint } = await f.open({ principals: [{
        token: f.tokens.R, deviceId: 'R', originIds: [], projectIds: [],
        permissions: ['catalog:read'], catalogProjectIds: [f.global.id],
    }] });
    const query = body => raw(endpoint.baseUrl, '/v1/catalog/plan', {
        token: f.tokens.R, method: 'POST', body,
    });
    const before = f.hub.db.prepare('SELECT * FROM hub_projects ORDER BY id').all();
    const first = await query({ projectId: f.global.id, limit: 1 });
    assert.equal(first.status, 200);
    const result = first.data.result;
    assert.deepEqual(Object.keys(result).sort(), ['publication', 'summary', 'todos']);
    assert.equal(result.summary.progress.total, 2);
    assert.equal(result.publication.revision, 1);
    assert.equal(result.todos.items.length, 1);
    assert.ok(result.todos.next);
    assert.equal(first.bytes.includes(Buffer.from('a.txt')), false);
    assert.equal(first.bytes.includes(Buffer.from(f.text.toString('base64'))), false);
    assert.equal(first.bytes.includes(Buffer.from(f.lease.leaseId)), false);
    const second = await query({
        projectId: f.global.id, cursor: result.todos.next, limit: 1,
    });
    assert.equal(second.status, 200);
    assert.equal(second.data.result.todos.items[0].seq, 2);
    assert.equal(second.data.result.todos.next, null);
    assert.deepEqual(f.hub.db.prepare('SELECT * FROM hub_projects ORDER BY id').all(), before);

    const hidden = await f.X.registerProject({
        originId: 'origin-X', localProjectId: 'private-plan', name: 'private',
    });
    const forbidden = await query({ projectId: hidden.id });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.data.error.code, 'FORBIDDEN');
    const legacy = await raw(f.endpoint.baseUrl, '/v1/catalog/plan', {
        token: f.tokens.A, method: 'POST', body: { projectId: f.global.id },
    });
    assert.equal(legacy.status, 403);

    f.source.updateTodo(f.global.localProjectId, 1, { status: 'done' });
    const next = exportProjectBundle(f.source, f.global.localProjectId);
    await f.A.uploadBundle({
        projectId: f.global.id, bundle: next.bytes, expectedHash: next.sha256, lease: f.lease,
    });
    await f.publish({ requestId: 'catalog-next', expectedRevision: 1, bundleHash: next.sha256 });
    const stale = await query({ projectId: f.global.id, cursor: result.todos.next, limit: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, 'REQUEST_CONFLICT');
    const refreshed = await query({ projectId: f.global.id });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.data.result.publication.revision, 2);
    assert.equal(refreshed.data.result.summary.progress.done, 1);
});
test('catalog plan cursor pins publication even when identical content is republished', async t => {
    const f = await fixture(t);
    f.source.addTodos(f.global.localProjectId, ['second']);
    const bundle = exportProjectBundle(f.source, f.global.localProjectId);
    await f.A.uploadBundle({
        projectId: f.global.id, bundle: bundle.bytes, expectedHash: bundle.sha256, lease: f.lease,
    });
    await f.publish({ bundleHash: bundle.sha256 });
    const { endpoint } = await f.open({ principals: [{
        token: f.tokens.R, deviceId: 'R', originIds: [], projectIds: [],
        permissions: ['catalog:read'], catalogProjectIds: [f.global.id],
    }] });
    const query = cursor => raw(endpoint.baseUrl, '/v1/catalog/plan', {
        token: f.tokens.R, method: 'POST',
        body: { projectId: f.global.id, limit: 1, ...(cursor === undefined ? {} : { cursor }) },
    });
    const first = await query();
    assert.equal(first.status, 200);
    const cursor = first.data.result.todos.next;
    assert.equal(cursor.revision, 1);
    assert.equal(cursor.bundleHash, bundle.sha256);
    const invalid = await query({ ...cursor, page: null });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error.code, 'INVALID_BODY');

    await f.publish({
        requestId: 'identical-plan-next', expectedRevision: 1, bundleHash: bundle.sha256,
    });
    const stale = await query(cursor);
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, 'REQUEST_CONFLICT');
    const fresh = await query();
    assert.equal(fresh.status, 200);
    assert.equal(fresh.data.result.publication.revision, 2);
    assert.equal(fresh.data.result.todos.snapshot, first.data.result.todos.snapshot);
    const continued = await query(fresh.data.result.todos.next);
    assert.equal(continued.status, 200);
    assert.equal(continued.data.result.todos.items[0].seq, 2);
    assert.equal(continued.data.result.todos.next, null);
});
test('catalog client validates real plan pages and rejects malformed response projections', async t => {
    const f = await fixture(t);
    f.source.addTodos(f.global.localProjectId, ['second']);
    const bundle = exportProjectBundle(f.source, f.global.localProjectId);
    await f.A.uploadBundle({
        projectId: f.global.id, bundle: bundle.bytes, expectedHash: bundle.sha256, lease: f.lease,
    });
    await f.publish({ bundleHash: bundle.sha256 });
    const { endpoint } = await f.open({ principals: [{
        token: f.tokens.R, deviceId: 'R', originIds: [], projectIds: [],
        permissions: ['catalog:read'], catalogProjectIds: [f.global.id],
    }] });
    const options = { token: f.tokens.R, deviceId: 'R', hubId: f.hub.getHubId() };
    const client = new HubNetworkClient(endpoint.baseUrl, options);
    const first = await client.getCatalogPlan(f.global.id, { limit: 1 });
    const second = await client.getCatalogPlan(f.global.id, {
        cursor: first.todos.next, limit: 1,
    });
    assert.equal(first.todos.items[0].seq, 1);
    assert.equal(second.todos.items[0].seq, 2);
    assert.equal(second.todos.next, null);
    const full = await client.getCatalogPlan(f.global.id);
    assert.equal(full.todos.items.length, 2);
    for (const mutate of [
        r => { r.publication.globalProjectId = 'g_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; },
        r => { r.summary.key = 'wrong'; },
        r => { r.summary.root = 'C:/private'; },
        r => { r.summary.progress.done = 100; },
        r => { r.todos.total = 3; },
        r => { r.todos.items.pop(); },
        r => { r.todos.items[1].seq = r.todos.items[0].seq; },
        r => { r.todos.items[0].title = 'x'.repeat(513); },
        r => { r.todos.items[0].truncated = ['unknown']; },
        r => { r.todos.items[0].root = 'C:/private'; },
    ]) {
        const broken = JSON.parse(JSON.stringify(full));
        mutate(broken);
        class FakeClient extends HubNetworkClient {
            async _request() { return broken; }
        }
        await assert.rejects(new FakeClient(endpoint.baseUrl, options)
            .getCatalogPlan(f.global.id), code('INVALID_RESPONSE'));
    }
    const broken = JSON.parse(JSON.stringify(first));
    broken.todos.next.page.offset++;
    class BadCursorClient extends HubNetworkClient {
        async _request() { return broken; }
    }
    await assert.rejects(new BadCursorClient(endpoint.baseUrl, options)
        .getCatalogPlan(f.global.id, { limit: 1 }), code('INVALID_RESPONSE'));
});
test('ordinary catalog inventories publish atomically and remain separate from engineering rights', async t => {
    const { CatalogSourceStore } = require(path.join(plugin, 'catalogSourceStore'));
    const f = await fixture(t);
    const catalog = new CatalogSourceStore(path.join(f.root, 'catalog.db'), { hubId: f.hub.getHubId() });
    f.ownedCatalogStores.push(catalog);
    const { endpoint } = await f.open({ catalogStore: catalog, principals: [
        { token: f.tokens.A, deviceId: 'A', originIds: [], projectIds: [],
            permissions: ['catalog:publish'], catalogPublishSourceIds: ['plans-A'] },
        { token: f.tokens.R, deviceId: 'R', originIds: [], projectIds: [],
            permissions: ['catalog:read'], catalogOriginIds: ['plans-A'] },
        { token: f.tokens.X, deviceId: 'X', originIds: [], projectIds: [],
            permissions: ['catalog:publish', 'catalog:read'],
            catalogPublishSourceIds: ['plans-X'], catalogOriginIds: ['plans-X'] },
    ] });

    const time = '2026-10-21T00:00:00.000Z';
    const records = Array.from({ length: 25 }, (_, i) => {
        const id = 'plan-' + i;
        return {
            identity: { sourceId: 'plans-A', localProjectId: id },
            project: { id, name: '普通计划' + i, status: 'active', availability: 'ready',
                created_at: time, updated_at: time, deleted_at: null },
            todos: [{ project_id: id, seq: 1, status: 'pending', title: '实现',
                note: '中文说明'.repeat(150), updated_by: 'Kerr', updated_at: time }],
        };
    });
    const payload = { sourceId: 'plans-A', expectedVersion: 0, requestId: 'inventory-1', records };
    const publishInventory = (body, secret = f.tokens.A) => raw(endpoint.baseUrl,
        '/v1/catalog/source/publish', {
            token: secret, method: 'POST', body: Buffer.from(JSON.stringify(body)),
            headers: { 'Content-Type': 'application/octet-stream' },
        });
    const read = (body, secret = f.tokens.R) => raw(endpoint.baseUrl, '/v1/catalog/source', {
        token: secret, method: 'POST', body,
    });
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 16 * 1024);
    const beforeHub = f.hub.db.prepare('SELECT * FROM hub_projects ORDER BY id').all();
    const first = await publishInventory(payload);
    assert.equal(first.status, 200);
    assert.equal(first.data.result.version, 1);
    assert.deepEqual((await publishInventory(payload)).data.result, first.data.result);

    const found = [];
    let cursor = null, firstPage;
    do {
        const response = await read({
            sourceId: 'plans-A', limit: 7, cursor,
            version: first.data.result.version, digest: first.data.result.digest,
        });
        assert.equal(response.status, 200);
        if (!firstPage) firstPage = response.data.result;
        found.push(...response.data.result.page.items);
        cursor = response.data.result.page.next;
    } while (cursor);
    assert.equal(found.length, 25);
    assert.equal(new Set(found.map(p => p.key)).size, 25);
    const detail = await read({
        sourceId: 'plans-A', key: found[0].key, version: 1, digest: first.data.result.digest,
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.result.page.items[0].note, records[0].todos[0].note);

    for (const secret of [f.tokens.R, f.tokens.X]) {
        assert.equal((await publishInventory(payload, secret)).status, 403);
    }
    assert.equal((await read({ sourceId: 'plans-A' }, f.tokens.X)).status, 403);
    assert.equal((await read({ sourceId: 'plans-A' }, f.tokens.A)).status, 403);
    const forged = await publishInventory({ ...payload, deviceId: 'R' });
    assert.equal(forged.status, 400);
    assert.equal(forged.data.error.code, 'INVALID_BODY');
    const changedRetry = await publishInventory({ ...payload, records: [] });
    assert.equal(changedRetry.status, 409);
    assert.equal(changedRetry.data.error.code, 'REQUEST_CONFLICT');

    const next = await publishInventory({
        ...payload, expectedVersion: 1, requestId: 'inventory-2', records: [],
    });
    assert.equal(next.status, 200);
    assert.equal(next.data.result.version, 2);
    const stale = await read({
        sourceId: 'plans-A', version: 1, digest: first.data.result.digest,
        cursor: firstPage.page.next,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, 'REQUEST_CONFLICT');
    assert.equal((await publishInventory(payload)).data.error.code, 'REVISION_CONFLICT');
    const empty = await read({ sourceId: 'plans-A' });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data.result.page.items, []);
    assert.equal(empty.data.result.page.next, null);
    assert.deepEqual(f.hub.db.prepare('SELECT * FROM hub_projects ORDER BY id').all(), beforeHub);
});

test('ordinary catalog capability is opt-in and rejects a foreign Hub store binding', async t => {
    const { CatalogSourceStore } = require(path.join(plugin, 'catalogSourceStore'));
    const f = await fixture(t);
    const principals = [{
        token: f.tokens.R, deviceId: 'R', originIds: [], projectIds: [],
        permissions: ['catalog:read'], catalogOriginIds: ['plans-A'],
    }];
    const { endpoint } = await f.open({ principals });
    const response = await raw(endpoint.baseUrl, '/v1/catalog/source', {
        token: f.tokens.R, method: 'POST', body: { sourceId: 'plans-A' },
    });
    assert.equal(response.status, 404);
    const foreign = new CatalogSourceStore(path.join(f.root, 'foreign-catalog.db'), {
        hubId: 'hub-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });
    try {
        assert.throws(() => new HubNetworkServer(f.hub, path.join(f.root, 'unused-network.db'), {
            principals, catalogStore: foreign,
        }), code('CONTENT_BINDING'));
    } finally { foreign.close(); }
});
test('catalog source discovery is scoped, paginated and does not expose publisher identity', async t => {
    const { CatalogSourceStore } = require(path.join(plugin, 'catalogSourceStore'));
    const f = await fixture(t);
    const catalog = new CatalogSourceStore(path.join(f.root, 'discovery.db'), { hubId: f.hub.getHubId() });
    f.ownedCatalogStores.push(catalog);
    const visible = Array.from({ length: 25 }, (_, i) => 'source-' + String(i).padStart(2, '0'));
    for (const sourceId of [...visible, 'hidden-source']) {
        catalog.publish({ sourceId, deviceId: 'publisher-private', expectedVersion: 0,
            requestId: 'private-request', records: [] });
    }
    const { endpoint } = await f.open({ catalogStore: catalog, principals: [
        { token: f.tokens.R, deviceId: 'R', originIds: [], projectIds: [],
            permissions: ['catalog:read'], catalogOriginIds: [...visible, 'not-published'] },
        { token: f.tokens.X, deviceId: 'X', originIds: [], projectIds: [],
            permissions: ['catalog:read'] },
        { token: f.tokens.A, deviceId: 'A', originIds: [], projectIds: [],
            permissions: ['catalog:publish'], catalogPublishSourceIds: visible },
    ] });
    const options = { token: f.tokens.R, deviceId: 'R', hubId: f.hub.getHubId() };
    const reader = new HubNetworkClient(endpoint.baseUrl, options);
    const before = catalog.db.prepare('SELECT * FROM catalog_sources ORDER BY source_id').all();
    const found = [];
    let after = '';
    do {
        const page = await reader.listCatalogSources({ after, limit: 7 });
        found.push(...page.items);
        after = page.next;
    } while (after !== null);
    assert.deepEqual(found.map(item => item.sourceId), visible);
    assert.ok(found.every(item => item.version === 1));
    assert.equal(JSON.stringify(found).includes('publisher-private'), false);
    assert.equal(JSON.stringify(found).includes('private-request'), false);
    assert.equal(JSON.stringify(found).includes('hidden-source'), false);
    const empty = new HubNetworkClient(endpoint.baseUrl, {
        token: f.tokens.X, deviceId: 'X', hubId: f.hub.getHubId(),
    });
    assert.deepEqual(await empty.listCatalogSources(), { items: [], next: null });
    const writer = new HubNetworkClient(endpoint.baseUrl, {
        token: f.tokens.A, deviceId: 'A', hubId: f.hub.getHubId(),
    });
    await assert.rejects(writer.listCatalogSources(), code('FORBIDDEN'));
    const injection = await raw(endpoint.baseUrl, '/v1/catalog/sources', {
        token: f.tokens.R, method: 'POST', body: { sourceIds: ['hidden-source'] },
    });
    assert.equal(injection.status, 400);
    assert.equal(injection.data.error.code, 'INVALID_BODY');
    for (const body of [{ after: null }, { limit: null }, { limit: 21 }]) {
        assert.equal((await raw(endpoint.baseUrl, '/v1/catalog/sources', {
            token: f.tokens.R, method: 'POST', body,
        })).status, 400);
    }
    const valid = await reader.listCatalogSources({ limit: 2 });
    for (const mutate of [
        r => { r.items[0].deviceId = 'leaked'; },
        r => { r.items[0].version = 0; },
        r => { r.items[0].digest = 'bad'; },
        r => { r.items.reverse(); },
        r => { r.next = 'hidden-source'; },
    ]) {
        const broken = JSON.parse(JSON.stringify(valid)); mutate(broken);
        class BadClient extends HubNetworkClient { async _request() { return broken; } }
        await assert.rejects(new BadClient(endpoint.baseUrl, options)
            .listCatalogSources({ limit: 2 }), code('INVALID_RESPONSE'));
    }
    assert.deepEqual(catalog.db.prepare('SELECT * FROM catalog_sources ORDER BY source_id').all(), before);
});
test('catalog publisher strips private fields before transport and verifies commit receipts', async t => {
    const { CatalogSourceStore } = require(path.join(plugin, 'catalogSourceStore'));
    const f = await fixture(t);
    const catalog = new CatalogSourceStore(path.join(f.root, 'publisher-client.db'), { hubId: f.hub.getHubId() });
    f.ownedCatalogStores.push(catalog);
    const { endpoint } = await f.open({ catalogStore: catalog, principals: [{
        token: f.tokens.A, deviceId: 'A', originIds: [], projectIds: [],
        permissions: ['catalog:publish'], catalogPublishSourceIds: ['plans-A'],
    }] });
    const options = { token: f.tokens.A, deviceId: 'A', hubId: f.hub.getHubId() };
    const time = '2026-10-21T00:00:00.000Z';
    const request = {
        sourceId: 'plans-A', expectedVersion: 0, requestId: 'durable-request-1',
        records: [{
            identity: { sourceId: 'plans-A', localProjectId: 'p1' },
            project: { id: 'p1', name: '计划', availability: 'ready', status: 'active',
                created_at: time, updated_at: time, deleted_at: null, root: 'PRIVATE_ROOT_SENTINEL' },
            todos: [{ project_id: 'p1', seq: 1, title: '待办', status: 'pending',
                note: '中文'.repeat(10000), updated_at: time, updated_by: null,
                secret: 'PRIVATE_EXTRA_SENTINEL' }],
        }],
    };
    const original = JSON.stringify(request);
    const captured = [];
    class ObservedClient extends HubNetworkClient {
        _request(method, route, payload) {
            captured.push({ method, route, bytes: Buffer.from(payload.bytes) });
            return super._request(method, route, payload);
        }
    }
    const client = new ObservedClient(endpoint.baseUrl, options);
    const receipt = await client.publishCatalogSource(request);
    assert.equal(receipt.version, 1);
    assert.deepEqual(await client.publishCatalogSource(request), receipt);
    assert.equal(JSON.stringify(request), original);
    assert.equal(captured.length, 2);
    assert.ok(captured[0].bytes.length > 16 * 1024);
    for (const sent of captured) {
        assert.equal(sent.method, 'POST');
        assert.equal(sent.route, '/v1/catalog/source/publish');
        assert.equal(sent.bytes.includes(Buffer.from('PRIVATE_ROOT_SENTINEL')), false);
        assert.equal(sent.bytes.includes(Buffer.from('PRIVATE_EXTRA_SENTINEL')), false);
        assert.equal(Object.hasOwn(JSON.parse(sent.bytes), 'deviceId'), false);
    }
    const newer = await client.publishCatalogSource({
        ...request, expectedVersion: 1, requestId: 'durable-request-2', records: [],
    });
    assert.equal(newer.version, 2);
    await assert.rejects(client.publishCatalogSource(request), code('REVISION_CONFLICT'));
    assert.equal(catalog.get('plans-A').version, 2);

    for (const patch of [
        { sourceId: 'foreign' }, { version: 9 }, { digest: '0'.repeat(64) },
        { receivedAt: -1 }, { private: 'unexpected' },
    ]) {
        let attempts = 0;
        class BadReceiptClient extends HubNetworkClient {
            async _request() { attempts++; return { ...receipt, ...patch }; }
        }
        await assert.rejects(new BadReceiptClient(endpoint.baseUrl, options)
            .publishCatalogSource(request), code('INVALID_RESPONSE'));
        assert.equal(attempts, 1);
    }
    let sends = 0;
    class NoSendClient extends HubNetworkClient {
        async _request() { sends++; throw Error('must not send'); }
    }
    const small = new NoSendClient(endpoint.baseUrl, { ...options, limits: { maxBundleBytes: 512 } });
    await assert.rejects(small.publishCatalogSource(request), code('LIMIT_EXCEEDED'));
    await assert.rejects(small.publishCatalogSource({ ...request, deviceId: 'forged' }), code('INVALID_BODY'));
    await assert.rejects(small.publishCatalogSource({
        ...request, expectedVersion: Number.MAX_SAFE_INTEGER,
    }), code('INVALID_ARGUMENT'));
    assert.equal(sends, 0);
});
test('ordinary source client pins inventory pages and rejects foreign or malformed rows', async t => {
    const { CatalogSourceStore } = require(path.join(plugin, 'catalogSourceStore'));
    const f = await fixture(t);
    const catalog = new CatalogSourceStore(path.join(f.root, 'reader-client.db'), { hubId: f.hub.getHubId() });
    f.ownedCatalogStores.push(catalog);
    const time = '2026-10-21T00:00:00.000Z';
    const records = ['p1', 'p2'].map(id => ({
        identity: { sourceId: 'plans-A', localProjectId: id },
        project: { id, name: '计划', availability: 'ready', status: 'active',
            created_at: time, updated_at: time, deleted_at: null },
        todos: [1, 2].map(seq => ({ project_id: id, seq, title: '待办', status: 'pending',
            note: '中'.repeat(3000), updated_at: time, updated_by: null })),
    }));
    const publication = catalog.publish({ sourceId: 'plans-A', deviceId: 'A',
        expectedVersion: 0, requestId: 'seed', records });
    const { endpoint } = await f.open({ catalogStore: catalog, principals: [{
        token: f.tokens.R, deviceId: 'R', originIds: [], projectIds: [],
        permissions: ['catalog:read'], catalogOriginIds: ['plans-A'],
    }] });
    const config = { token: f.tokens.R, deviceId: 'R', hubId: f.hub.getHubId() };
    const client = new HubNetworkClient(endpoint.baseUrl, config);
    const pin = { version: publication.version, digest: publication.digest };
    const first = await client.getCatalogSource('plans-A', { limit: 1 });
    const second = await client.getCatalogSource('plans-A', { ...pin, cursor: first.page.next, limit: 1 });
    assert.equal(second.page.next, null);
    assert.notEqual(first.page.items[0].key, second.page.items[0].key);
    const key = first.page.items[0].key;
    const detail = await client.getCatalogSource('plans-A', { ...pin, key, limit: 1 });
    assert.deepEqual(detail.page.items[0].truncated, ['note']);
    assert.equal(detail.page.items[0].note.length, 2048);
    const detail2 = await client.getCatalogSource('plans-A', {
        ...pin, key, cursor: detail.page.next, limit: 1,
    });
    assert.equal(detail2.page.items[0].seq, 2);
    assert.equal(detail2.page.next, null);

    for (const [valid, options, mutations] of [
        [first, { limit: 1 }, [
            r => { r.sourceId = 'foreign'; },
            r => { r.page.items[0].sourceId = 'foreign'; },
            r => { r.page.items[0].root = 'private'; },
            r => { r.page.items[0].progress.done = 8; },
            r => { r.page.next.offset = 2; },
            r => { r.page.next = null; },
            r => { r.page.kind = 'todos'; },
        ]],
        [detail, { ...pin, key, limit: 1 }, [
            r => { r.version++; },
            r => { r.digest = '0'.repeat(64); },
            r => { r.page.items[0].seq = 0; },
            r => { r.page.items[0].note = 'x'.repeat(2049); },
            r => { r.page.items[0].truncated = ['secret']; },
            r => { r.page.items[0].extra = 'private'; },
        ]],
    ]) {
        for (const mutate of mutations) {
            const bad = JSON.parse(JSON.stringify(valid)); mutate(bad);
            class BadClient extends HubNetworkClient { async _request() { return bad; } }
            await assert.rejects(new BadClient(endpoint.baseUrl, config)
                .getCatalogSource('plans-A', options), code('INVALID_RESPONSE'));
        }
    }
    let sends = 0;
    class NoSendClient extends HubNetworkClient {
        async _request() { sends++; throw Error('unexpected send'); }
    }
    const noSend = new NoSendClient(endpoint.baseUrl, config);
    for (const options of [
        { key }, { cursor: first.page.next }, { version: 1 },
        { ...pin, key: JSON.stringify(['local', 'foreign', 'p1']) },
        { ...pin, sourceIds: ['foreign'] },
    ]) {
        await assert.rejects(noSend.getCatalogSource('plans-A', options));
    }
    assert.equal(sends, 0);
    catalog.publish({ sourceId: 'plans-A', deviceId: 'A', expectedVersion: 1,
        requestId: 'new-version', records: [] });
    await assert.rejects(client.getCatalogSource('plans-A', { ...pin, key }), code('REQUEST_CONFLICT'));
    assert.deepEqual((await client.getCatalogSource('plans-A')).page.items, []);
});

async function engineeringFixture(t) {
    const f = await fixture(t);
    const { CatalogSourceStore } = require(path.join(plugin, 'catalogSourceStore'));
    const { projectEngineeringDetail } = require(path.join(plugin, 'catalogEngineeringDetail'));
    const catalog = new CatalogSourceStore(path.join(f.root, 'engineering-catalog.db'), {
        hubId: f.hub.getHubId(),
    });
    f.ownedCatalogStores.push(catalog);
    const { endpoint } = await f.open({ catalogStore: catalog, principals: [
        { token: f.tokens.A, deviceId: 'A', originIds: [], projectIds: [],
            permissions: ['catalog:publish'], catalogPublishSourceIds: ['plans-A'] },
        { token: f.tokens.R, deviceId: 'R', originIds: [], projectIds: [],
            permissions: ['catalog:read'], catalogOriginIds: ['plans-A'] },
        { token: f.tokens.X, deviceId: 'X', originIds: [], projectIds: [],
            permissions: ['catalog:read', 'catalog:publish'],
            catalogOriginIds: ['plans-X'], catalogPublishSourceIds: ['plans-X'] },
    ] });
    const client = device => new HubNetworkClient(endpoint.baseUrl, {
        token: f.tokens[device], deviceId: device, hubId: f.hub.getHubId(),
    });
    const at = '2026-10-22T02:00:00.000Z';
    const records = [{
        identity: { sourceId: 'plans-A', localProjectId: 'p1' },
        project: { id: 'p1', name: '工程说明', status: 'active', availability: 'ready',
            created_at: at, updated_at: at, deleted_at: null },
        todos: [],
    }];
    const detail = projectEngineeringDetail({
        project: { report: ('报告😀"\\\n').repeat(900), report_by: 'Kerr' },
        batches: [], batchTotal: 0, files: [], fileTotal: 0,
    }, { shared: true });
    const publication = { sourceId: 'plans-A', expectedVersion: 0,
        requestId: 'engineering-1', records, protocolVersion: 2,
        details: [{ localProjectId: 'p1', detail }] };
    return { ...f, catalog, engineeringEndpoint: endpoint, writer: client('A'),
        reader: client('R'), outsider: client('X'), publication, detail };
}

test('engineering HTTP publication preserves legacy browsing and pinned report pagination', async t => {
    const f = await engineeringFixture(t);
    const receipt = await f.writer.publishCatalogSource(f.publication);
    assert.deepEqual(await f.writer.publishCatalogSource(f.publication), receipt);
    const legacy = await f.reader.getCatalogSource('plans-A', {
        version: receipt.version, digest: receipt.digest,
    });
    assert.equal(legacy.page.items[0].name, '工程说明');
    assert.equal(Object.hasOwn(legacy, 'details'), false);
    let cursor = null, text = '', snapshot = null, completed = false;
    for (let i = 0; i < 20; i++) {
        const result = await f.reader.getCatalogEngineering('plans-A', {
            version: receipt.version, digest: receipt.digest, localProjectId: 'p1',
            section: 'report', cursor, limit: 1,
        });
        assert.equal(result.version, receipt.version);
        assert.equal(result.digest, receipt.digest);
        assert.equal(result.localProjectId, 'p1');
        assert.equal(result.page.state, 'shared');
        assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 64 * 1024);
        if (snapshot === null) snapshot = result.page.snapshot;
        assert.equal(result.page.snapshot, snapshot);
        for (const chunk of result.page.items) {
            assert.equal(chunk.offset, text.length);
            text += chunk.text;
        }
        cursor = result.page.next;
        if (cursor === null) { completed = true; break; }
    }
    assert.equal(completed, true);
    assert.equal(text, f.detail.report.text);
});

test('engineering HTTP enforces read/publish separation and source scope before lookup', async t => {
    const f = await engineeringFixture(t);
    const receipt = await f.writer.publishCatalogSource(f.publication);
    const options = { version: receipt.version, digest: receipt.digest,
        localProjectId: 'p1', section: 'report' };
    await assert.rejects(f.writer.getCatalogEngineering('plans-A', options), code('FORBIDDEN'));
    await assert.rejects(f.outsider.getCatalogEngineering('plans-A', options), code('FORBIDDEN'));
    await assert.rejects(f.outsider.getCatalogEngineering('missing-source', options), code('FORBIDDEN'));
    await assert.rejects(f.reader.publishCatalogSource(f.publication), code('FORBIDDEN'));
    await assert.rejects(f.outsider.publishCatalogSource(f.publication), code('FORBIDDEN'));
    await assert.rejects(f.reader.getCatalogEngineering('plans-A', {
        ...options, localProjectId: 'missing',
    }), code('NOT_FOUND'));
    assert.equal(f.catalog.get('plans-A').version, 1);
    // Reading engineering metadata must not confer ordinary project/bundle rights.
    await assert.rejects(f.reader.getProject(f.global.id), code('FORBIDDEN'));
});

test('engineering HTTP rejects stale pins and does not accept v2 through legacy publish route', async t => {
    const f = await engineeringFixture(t);
    const first = await f.writer.publishCatalogSource(f.publication);
    const options = { version: first.version, digest: first.digest,
        localProjectId: 'p1', section: 'report', limit: 1 };
    const page = await f.reader.getCatalogEngineering('plans-A', options);
    assert.ok(page.page.next);
    const next = JSON.parse(JSON.stringify(f.publication));
    next.requestId = 'engineering-2'; next.expectedVersion = 1;
    next.details[0].detail.report.text = 'updated report';
    next.details[0].detail.report.truncated = [];
    const second = await f.writer.publishCatalogSource(next);
    assert.equal(second.version, 2);
    await assert.rejects(f.reader.getCatalogEngineering('plans-A', {
        ...options, cursor: page.page.next,
    }), code('REQUEST_CONFLICT'));
    const rejected = await raw(f.engineeringEndpoint.baseUrl, '/v1/catalog/source/publish', {
        method: 'POST', token: f.tokens.A,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: { ...next, requestId: 'wrong-route', expectedVersion: 2 },
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.error.code, 'INVALID_BODY');
    assert.equal(f.catalog.get('plans-A').version, 2);
});

test('engineering client rejects malformed identity, report pages and cursor progress', async () => {
    const { EngineeringSnapshot } = require(path.join(plugin, 'catalogEngineeringPages'));
    const { projectEngineeringDetail } = require(path.join(plugin, 'catalogEngineeringDetail'));
    const binding = { sourceId: 'plans-A', localProjectId: 'p1',
        version: 2, digest: 'a'.repeat(64) };
    const detail = projectEngineeringDetail({
        project: { report: 'x'.repeat(3000), report_by: 'Kerr' },
        batches: [], batchTotal: 0, files: [], fileTotal: 0,
    }, { shared: true });
    const page = new EngineeringSnapshot(detail, binding).page('report', { limit: 1 });
    const valid = { ...binding, page };
    let response;
    class ResponseClient extends HubNetworkClient {
        async _request() { return JSON.parse(JSON.stringify(response)); }
    }
    const client = new ResponseClient('http://127.0.0.1:1', {
        token: token(), deviceId: 'synthetic-reader',
        hubId: 'hub-11111111-2222-4333-8444-555555555555',
    });
    const options = { localProjectId: 'p1', version: 2, digest: binding.digest,
        section: 'report', limit: 1 };
    response = valid;
    assert.deepEqual(await client.getCatalogEngineering('plans-A', options), valid);
    const mutations = [
        r => { r.sourceId = 'foreign'; },
        r => { r.localProjectId = 'p2'; },
        r => { r.version = 3; },
        r => { r.digest = 'b'.repeat(64); },
        r => { r.unexpected = true; },
        r => { r.page.section = 'files'; },
        r => { r.page.total = 999; },
        r => { r.page.metadata.present = false; },
        r => { r.page.metadata.secret = 'unexpected'; },
        r => { r.page.items[0].offset = 1; },
        r => { r.page.items[0].text = ''; },
        r => { r.page.items[0].text = 'x'.repeat(1025); },
        r => { r.page.items[0].text = '\uD800'; },
        r => { r.page.items[0].extra = 'unexpected'; },
        r => { r.page.next.offset = 0; },
        r => { r.page.next.offset = 2; },
        r => { r.page.next.snapshot = 'b'.repeat(64); },
        r => { r.page.next.section = 'files'; },
        r => { r.page.next = null; },
        r => { r.page.items = []; },
        r => { r.page.state = 'not-shared'; },
    ];
    for (const mutate of mutations) {
        response = JSON.parse(JSON.stringify(valid));
        mutate(response);
        await assert.rejects(client.getCatalogEngineering('plans-A', options),
            code('INVALID_RESPONSE'), mutate.toString());
    }
});

test('engineering client does not downgrade or retry when enhanced endpoints are unsupported', async () => {
    const calls = [];
    class UnsupportedClient extends HubNetworkClient {
        async _request(method, route) {
            calls.push({ method, route });
            throw Object.assign(Error('NOT_FOUND'), { code: 'NOT_FOUND' });
        }
    }
    const client = new UnsupportedClient('http://127.0.0.1:1', {
        token: token(), deviceId: 'synthetic',
        hubId: 'hub-11111111-2222-4333-8444-555555555555',
    });
    await assert.rejects(client.publishCatalogSource({
        sourceId: 'plans-A', expectedVersion: 0, requestId: 'unsupported-v2',
        protocolVersion: 2, records: [], details: [],
    }), code('NOT_FOUND'));
    assert.deepEqual(calls, [{ method: 'POST', route: '/v1/catalog/engineering/publish' }]);
    await assert.rejects(client.getCatalogEngineering('plans-A', {
        localProjectId: 'p1', version: 1, digest: 'a'.repeat(64), section: 'report',
    }), code('NOT_FOUND'));
    assert.deepEqual(calls, [
        { method: 'POST', route: '/v1/catalog/engineering/publish' },
        { method: 'POST', route: '/v1/catalog/engineering/detail' },
    ]);
});