'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { CatalogBrowser } = require('../../Plugin/ServerProjectForge/catalogBrowser');
const { CatalogSnapshot } = require('../../Plugin/ServerProjectForge/catalogSnapshot');
function fixture() {
    const time = '2026-10-21T00:00:00.000Z';
    const sources = ['home', 'server'];
    const snapshots = new Map(sources.map(sourceId => [sourceId, new CatalogSnapshot(
        Array.from({ length: 13 }, (_, i) => {
            const id = 'p' + i;
            return { identity: { sourceId, localProjectId: id },
                project: { id, name: '计划', availability: 'ready', status: 'active',
                    created_at: time, updated_at: time, deleted_at: null },
                todos: [1, 2, 3].map(seq => ({ project_id: id, seq, title: '待办',
                    status: 'pending', updated_at: time, note: null, updated_by: null })) };
        })
    )]));
    const calls = [];
    const client = {
        hubId: 'hub-11111111-2222-4333-8444-555555555555',
        async listCatalogSources({ after }) {
            const sourceId = after === '' ? 'home' : 'server';
            return { items: [{ sourceId, version: 1, digest: 'a'.repeat(64) }],
                next: after === '' ? 'home' : null };
        },
        async getCatalogSource(sourceId, options) {
            calls.push({ sourceId, options });
            assert.equal(options.version, 1);
            assert.equal(options.digest, 'a'.repeat(64));
            const snapshot = snapshots.get(sourceId);
            const page = options.key
                ? snapshot.todos(options.key, { cursor: options.cursor, limit: 1 })
                : snapshot.list({ cursor: options.cursor, limit: 5 });
            return { sourceId, version: 1, digest: 'a'.repeat(64), page };
        },
        async listCatalogProjects() { return { items: [], next: null }; },
    };
    return { client, calls, browser: new CatalogBrowser(client) };
}
test('all source pages appear with nonlocal collision-free IDs and complete Todo detail', async () => {
    const f = fixture(), rows = await f.browser.refresh();
    assert.equal(rows.length, 26);
    assert.equal(new Set(rows.map(r => r.id)).size, 26);
    assert.ok(rows.every(r => r.id.startsWith('remote:')));
    const home = rows.find(r => r.summary.sourceId === 'home' && r.summary.localProjectId === 'p1');
    const server = rows.find(r => r.summary.sourceId === 'server' && r.summary.localProjectId === 'p1');
    assert.notEqual(home.id, server.id);
    const detail = await f.browser.detail(home.id);
    assert.deepEqual(detail.todos.map(t => t.seq), [1, 2, 3]);
    rows[0].summary.name = 'mutated';
    assert.notEqual(f.browser.entries.get(rows[0].id).summary.name, 'mutated');
    await assert.rejects(f.browser.detail('p1'), { code: 'NOT_FOUND' });
});
test('refresh is single-flight and failed refresh never commits a partial list', async () => {
    const f = fixture(), initial = await f.browser.refresh();
    const original = f.client.getCatalogSource;
    f.client.getCatalogSource = async (sourceId, options) => {
        if (sourceId === 'server') throw Object.assign(Error('offline'), { code: 'NETWORK_ERROR' });
        return original(sourceId, options);
    };
    const a = f.browser.refresh(), b = f.browser.refresh();
    assert.equal(a, b);
    await assert.rejects(a, { code: 'NETWORK_ERROR' });
    assert.deepEqual([...f.browser.entries.values()], initial);
});
test('refresh or clear during detail invalidates the returned view', async () => {
    const f = fixture(), rows = await f.browser.refresh();
    const original = f.client.getCatalogSource;
    f.client.getCatalogSource = async (...args) => {
        const result = await original(...args);
        f.browser.clear();
        return result;
    };
    await assert.rejects(f.browser.detail(rows[0].id), { code: 'REQUEST_CONFLICT' });
});
test('close prevents an in-flight refresh from repopulating entries', async () => {
    const f = fixture();
    const original = f.client.listCatalogSources;
    f.client.listCatalogSources = async options => {
        f.browser.close();
        return original(options);
    };
    await assert.rejects(f.browser.refresh(), { code: 'CLOSED' });
    assert.equal(f.browser.entries.size, 0);
});
test('global detail refuses revision newer than selected list entry', async () => {
    const f = fixture();
    const id = 'g_11111111-2222-4333-8444-555555555555';
    f.client.listCatalogProjects = async () => ({
        items: [{ id, revision: 1, bundleHash: 'a'.repeat(64) }], next: null,
    });
    f.client.getCatalogPlan = async () => ({
        publication: { revision: 2, bundleHash: 'a'.repeat(64) },
        todos: {}, summary: {},
    });
    const rows = await f.browser.refresh();
    const global = rows.find(r => r.kind === 'global');
    await assert.rejects(f.browser.detail(global.id), { code: 'REQUEST_CONFLICT' });
});
function barrier() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}
test('clear invalidates refresh waiting on its final network response', async () => {
    const f = fixture();
    await f.browser.refresh();
    const entered = barrier(), release = barrier();
    f.client.listCatalogProjects = async () => {
        entered.resolve();
        await release.promise;
        return { items: [], next: null };
    };
    const running = f.browser.refresh();
    const rejected = assert.rejects(running, { code: 'REQUEST_CONFLICT' });
    await entered.promise;
    f.browser.clear();
    release.resolve();
    await rejected;
    assert.equal(f.browser.entries.size, 0);
    // A fresh explicit read after invalidation is still permitted.
    assert.equal((await f.browser.refresh()).length, 26);
});
test('clear invalidates old detail even when identical entry data reappears', async () => {
    const f = fixture(), rows = await f.browser.refresh();
    const saved = JSON.parse(JSON.stringify(rows[0]));
    const original = f.client.getCatalogSource;
    const entered = barrier(), release = barrier();
    let held = false;
    f.client.getCatalogSource = async (...args) => {
        const result = await original(...args);
        if (!held) {
            held = true;
            entered.resolve();
            await release.promise;
        }
        return result;
    };
    const running = f.browser.detail(saved.id);
    const rejected = assert.rejects(running, { code: 'REQUEST_CONFLICT' });
    await entered.promise;
    f.browser.clear();
    // Reproduce ABA independently of wall-clock observedAt resolution.
    f.browser.entries.set(saved.id, saved);
    release.resolve();
    await rejected;
});
test('host discards superseded detail without clearing a newer successful index', async t => {
    const { CatalogHost } = require('../../Plugin/ServerProjectForge/catalogHost');
    const f = fixture();
    const host = new CatalogHost({ config: { client: f.client, read: true, publish: null } });
    t.after(() => host.stop());
    const first = await host.listRemote();
    const id = first.projects[0].id;
    const original = f.client.getCatalogSource;
    const entered = barrier(), release = barrier();
    let held = false;
    f.client.getCatalogSource = async (sourceId, options) => {
        const result = await original(sourceId, options);
        if (options.key && !held) {
            held = true;
            entered.resolve();
            await release.promise;
        }
        return result;
    };
    const old = host.getRemote(id);
    const rejected = assert.rejects(old);
    await entered.promise;
    const newer = await host.listRemote();
    assert.equal(newer.projects.length, 26);
    const generation = host.browser.generation;
    release.resolve();
    await rejected;
    assert.equal(host.browser.generation, generation);
    assert.equal(host.browser.entries.size, 26);
    assert.equal(host.details.size, 0);
    assert.equal((await host.getRemote(id)).todos.length, 3);
});

test('host permission denial invalidates an already in-flight index refresh', async t => {
    const { CatalogHost } = require('../../Plugin/ServerProjectForge/catalogHost');
    const f = fixture();
    const host = new CatalogHost({ config: { client: f.client, read: true, publish: null } });
    t.after(() => host.stop());
    const first = await host.listRemote();
    const id = first.projects[0].id;
    await host.getRemote(id);
    const entered = barrier(), release = barrier();
    f.client.listCatalogProjects = async () => {
        entered.resolve();
        await release.promise;
        return { items: [], next: null };
    };
    const refresh = host.listRemote();
    const refreshRejected = assert.rejects(refresh);
    await entered.promise;
    const original = f.client.getCatalogSource;
    f.client.getCatalogSource = async (sourceId, options) => {
        if (options.key) throw Object.assign(Error('synthetic denied'), { code: 'FORBIDDEN' });
        return original(sourceId, options);
    };
    await assert.rejects(host.getRemote(id), { code: 'CATALOG_READ_FAILED' });
    assert.equal(host.browser.entries.size, 0);
    assert.equal(host.details.size, 0);
    release.resolve();
    await refreshRejected;
    assert.equal(host.browser.entries.size, 0);
    assert.equal(host.details.size, 0);
});

function engineeringBrowserFixture() {
    const f = fixture();
    const { projectEngineeringDetail } =
        require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');
    const { EngineeringSnapshot } =
        require('../../Plugin/ServerProjectForge/catalogEngineeringPages');
    const detail = projectEngineeringDetail({
        project: { report: '工程报告😀'.repeat(400), report_by: 'Kerr' },
        batches: [{
            id: 7, kind: 'edit', reason: '修复', maid: 'Kerr',
            created_at: '2026-10-22T02:00:00.000Z',
            node_count: 1, added: 2, removed: 1, files: ['src/a.js'],
        }],
        batchTotal: 1,
        files: [{ file_path: 'src/a.js', edits: 1, added: 2, removed: 1, last_node: 9 }],
        fileTotal: 1,
    }, { shared: true });
    const requests = [];
    const respond = async (sourceId, options) => {
        requests.push({ sourceId, ...options });
        const binding = { sourceId, localProjectId: options.localProjectId,
            version: options.version, digest: options.digest };
        return { ...binding, page: new EngineeringSnapshot(detail, binding)
            .page(options.section, { cursor: options.cursor, limit: 1 }) };
    };
    f.client.getCatalogEngineering = respond;
    return { ...f, detail, requests, respond, EngineeringSnapshot };
}

test('engineering browser assembles all sections with pinned identity and no aliasing', async () => {
    const f = engineeringBrowserFixture();
    const rows = await f.browser.refresh();
    const row = rows.find(r => r.summary.sourceId === 'home');
    const result = await f.browser.detail(row.id);
    assert.deepEqual(result.engineering, f.detail);
    assert.deepEqual(result.todos.map(t => t.seq), [1, 2, 3]);
    assert.deepEqual([...new Set(f.requests.map(r => r.section))], ['report', 'timeline', 'files']);
    assert.ok(f.requests.every(r => r.sourceId === 'home' &&
        r.localProjectId === row.summary.localProjectId &&
        r.version === row.pin.version && r.digest === row.pin.digest));
    result.engineering.files.items[0].file_path = 'caller.js';
    assert.equal((await f.browser.detail(row.id)).engineering.files.items[0].file_path, 'src/a.js');
});

test('engineering browser distinguishes not-shared from endpoint unavailable and never masks denial', async () => {
    const f = engineeringBrowserFixture();
    const rows = await f.browser.refresh(), id = rows[0].id;
    f.client.getCatalogEngineering = async (sourceId, options) => {
        const binding = { sourceId, localProjectId: options.localProjectId,
            version: options.version, digest: options.digest };
        return { ...binding, page: new f.EngineeringSnapshot(
            { version: 1, state: 'not-shared' }, binding).page(options.section) };
    };
    assert.deepEqual((await f.browser.detail(id)).engineering, { version: 1, state: 'not-shared' });
    f.client.getCatalogEngineering = async () => {
        throw Object.assign(Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    };
    assert.deepEqual((await f.browser.detail(id)).engineering,
        { version: 1, state: 'unavailable', reason: 'endpoint-or-resource-unavailable' });
    for (const code of ['FORBIDDEN', 'UNAUTHENTICATED', 'CONTENT_NOT_FOUND',
        'REQUEST_CONFLICT', 'INVALID_RESPONSE', 'NETWORK_ERROR']) {
        f.client.getCatalogEngineering = async () => { throw Object.assign(Error(code), { code }); };
        await assert.rejects(f.browser.detail(id), { code });
    }
});

test('engineering browser rejects mixed sections and discontinuous report chunks', async () => {
    const f = engineeringBrowserFixture();
    const rows = await f.browser.refresh(), id = rows[0].id;
    f.client.getCatalogEngineering = async (...args) => {
        const result = await f.respond(...args);
        if (args[1].section === 'timeline') result.page.snapshot = 'b'.repeat(64);
        return result;
    };
    await assert.rejects(f.browser.detail(id), { code: 'REQUEST_CONFLICT' });
    f.client.getCatalogEngineering = async (...args) => {
        const result = await f.respond(...args);
        if (args[1].section === 'report' && args[1].cursor !== null) {
            result.page.items[0].offset++;
        }
        return result;
    };
    await assert.rejects(f.browser.detail(id), { code: 'INVALID_RESPONSE' });
    // A later failure cannot erase already fetched sections into "unavailable".
    f.client.getCatalogEngineering = async (...args) => {
        if (args[1].section === 'timeline') {
            throw Object.assign(Error('NOT_FOUND'), { code: 'NOT_FOUND' });
        }
        return f.respond(...args);
    };
    await assert.rejects(f.browser.detail(id), { code: 'NOT_FOUND' });
});

test('engineering browser refuses late results after clear even for unavailable endpoints', async () => {
    for (const missing of [false, true]) {
        const f = engineeringBrowserFixture();
        const rows = await f.browser.refresh();
        f.client.getCatalogEngineering = async (...args) => {
            f.browser.clear();
            if (missing) throw Object.assign(Error('NOT_FOUND'), { code: 'NOT_FOUND' });
            return f.respond(...args);
        };
        await assert.rejects(f.browser.detail(rows[0].id), { code: 'REQUEST_CONFLICT' });
        assert.equal(f.browser.entries.size, 0);
    }
});