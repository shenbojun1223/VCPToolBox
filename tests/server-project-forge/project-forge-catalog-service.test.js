'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const plugin = path.resolve(__dirname, '../../Plugin/ServerProjectForge');
const { ProjectStore } = require(path.join(plugin, 'store'));
const { HubContentStore } = require(path.join(plugin, 'hubContentStore'));
const { HubStore } = require(path.join(plugin, 'hubStore'));
const { HubNetworkServer } = require(path.join(plugin, 'hubNetworkServer'));
const { CatalogSourceStore } = require(path.join(plugin, 'catalogSourceStore'));

async function until(fn) {
    const deadline = performance.now() + 6000;
    while (performance.now() < deadline) {
        const value = fn();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error('catalog service condition timeout');
}

async function fixture(t, { publish = true, seed = true, codeSharing = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-catalog-service-'));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const file = require.resolve(path.join(plugin, 'ProjectForgeService'));
    delete require.cache[file];
    const forge = require(file);
    const resources = {};
    t.after(async () => {
        // Stop writers before listeners and borrowed databases.
        await forge.cleanup();
        if (resources.server) await resources.server.close();
        resources.catalog?.close();
        resources.hub?.close();
        resources.content?.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const dbPath = path.join(root, 'business.db');
    let seeded;
    if (seed) {
        const store = new ProjectStore(dbPath);
        try {
            seeded = store.createProject({
                name: '已有计划', root: path.join(workspace, 'seed'), workspaceAlias: 'fixture',
            });
            store.addTodos(seeded.id, ['已有待办']);
        } finally { store.close(); }
    }
    const content = resources.content = new HubContentStore(path.join(root, 'content.db'));
    const hub = resources.hub = new HubStore(path.join(root, 'hub.db'), { contentStore: content });
    const catalog = resources.catalog = new CatalogSourceStore(path.join(root, 'catalog.db'), { hubId: hub.getHubId() });
    const token = crypto.randomBytes(32).toString('base64url');
    const server = resources.server = new HubNetworkServer(hub, path.join(root, 'network.db'), {
        catalogStore: catalog,
        principals: [{
            token, deviceId: 'service-A', originIds: [], projectIds: [],
            permissions: ['catalog:read', 'catalog:publish',
                ...(codeSharing ? ['catalog:code:read', 'catalog:code:publish'] : [])],
            catalogOriginIds: ['plans-A'], catalogPublishSourceIds: ['plans-A'],
            ...(codeSharing ? { catalogCodeOriginIds: ['plans-A'] } : {}),
        }],
    });
    const endpoint = await server.listen();
    const tokenFile = path.join(root, 'token.txt');
    fs.writeFileSync(tokenFile, token);
    const configPath = path.join(root, 'catalog.json');
    const journalPath = path.join(root, 'publisher.db');
    fs.writeFileSync(configPath, JSON.stringify({
        version: 1, endpoint: endpoint.baseUrl, hubId: hub.getHubId(),
        deviceId: 'service-A', tokenFile, read: true,
        ...(publish ? { publish: {
            sourceId: 'plans-A', journalPath, allProjects: true, intervalMs: 100,
            ...(codeSharing ? { engineeringDetails: true, codeSnapshots: true } : {}),
        } } : {}),
    }));
    const options = {
        dbPath,
        config: {
            WORKSPACES: 'fixture|' + workspace, ACTIVE_WORKSPACE: 'fixture',
            AST_INDEX_ENABLED: false, CATALOG_CONFIG_PATH: configPath,
        },
        logger: { log() {}, warn() {}, error() {} },
    };
    return { root, forge, hub, catalog, server, seeded, options, configPath, journalPath, dbPath };
}

test('real Forge initialization backfills plans and ordinary tools publish without manual upload', async t => {
    const f = await fixture(t);
    const ready = f.forge.initialize(f.options);
    assert.equal(f.forge.initialize(f.options), ready);
    await ready;
    const runtime = f.forge._test.getRuntime();
    assert.equal(runtime.autoResume, null);
    assert.equal(f.forge.events.listenerCount('changed'), 1);
    assert.equal(f.catalog.get('plans-A').snapshot.list().items[0].localProjectId, f.seeded.id);

    const created = await f.forge.processToolCall({
        command: 'CreateProject', name: '新计划', workspace: 'fixture',
        dir: 'new-project', todos: '实现\n验收', maid: 'Kerr',
    });
    const project = created.details.project;
    await until(() => f.catalog.get('plans-A')?.snapshot.list().items.length === 2);
    await f.forge.processToolCall({
        command: 'UpdateTodos', projectId: project.id, done: '1', maid: 'Kerr',
    });
    await until(() => f.catalog.get('plans-A')?.snapshot.list().items
        .find(p => p.localProjectId === project.id)?.progress.done === 1);
    assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_projects').get().n, 0);
    assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_lease_requests').get().n, 0);
    assert.throws(() => f.forge.initialize({
        ...f.options, config: { ...f.options.config, CATALOG_CONFIG_PATH: f.configPath + '.other' },
    }), /AUTO_CLEANUP_REQUIRED/);
    assert.throws(() => f.forge._test.resetForTests(), /CATALOG_CLEANUP_REQUIRED/);

    const business = runtime.store, host = runtime.catalog;
    const connection = business.db;
    await f.forge.cleanup();
    assert.equal(f.forge.events.listenerCount('changed'), 0);
    assert.equal(connection.open, false);
    assert.equal(business.db, null);
    assert.equal(host.journal.db, null);
    assert.equal(host.publisher.timer, null);
    const finalVersion = f.catalog.get('plans-A').version;
    f.forge.events.emit('changed');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.catalog.get('plans-A').version, finalVersion);
});

test('read-only service starts without opening business DB or acquiring write rights', async t => {
    const f = await fixture(t, { publish: false, seed: false });
    await f.forge.initialize(f.options);
    assert.equal(f.forge._test.getRuntime().store, null);
    assert.equal(f.forge._test.getRuntime().autoResume, null);
    assert.equal(fs.existsSync(f.dbPath), false);
    assert.equal(fs.existsSync(f.journalPath), false);
    assert.equal(f.forge.catalogStatus().read, true);
    assert.equal(f.forge.catalogStatus().publisher.phase, 'disabled');
    assert.equal(f.forge.events.listenerCount('changed'), 0);
});

test('invalid catalog configuration rejects startup without publishing or opening business DB', async t => {
    const f = await fixture(t, { seed: false });
    fs.writeFileSync(f.configPath, '{"private":"DO-NOT-REFLECT"');
    assert.throws(() => f.forge.initialize(f.options), { code: 'CATALOG_CONFIG_INVALID' });
    assert.throws(() => f.forge.ensureRuntime(f.options), /CATALOG_CONFIG_INVALID/);
    assert.equal(f.forge._test.getRuntime().store, null);
    assert.equal(fs.existsSync(f.dbPath), false);
    assert.equal(f.catalog.get('plans-A'), null);
});

test('immediate cleanup cancels queued catalog startup without reopening resources', async t => {
    const f = await fixture(t);
    const ready = f.forge.initialize(f.options);
    const host = f.forge._test.getRuntime().catalog;
    await f.forge.cleanup();
    await ready;
    assert.equal(host.closed, true);
    assert.equal(host.journal.db, null);
    assert.equal(host.publisher.timer, null);
    assert.equal(f.forge.events.listenerCount('changed'), 0);
    assert.equal(f.catalog.get('plans-A'), null);
});
function remoteInventory(id) {
    const time = '2026-10-21T00:00:00.000Z';
    return [{
        identity: { sourceId: 'plans-A', localProjectId: id },
        project: { id, name: '服务器计划', availability: 'ready', status: 'accepted',
            created_at: time, updated_at: time, deleted_at: null },
        todos: [{ project_id: id, seq: 1, title: '服务器待办', status: 'done',
            note: '远端备注', updated_at: time, updated_by: 'Kerr' }],
    }];
}

test('unified GUI keeps colliding local IDs separate and serves explicitly stale offline views', async t => {
    const f = await fixture(t, { publish: false });
    f.catalog.publish({ sourceId: 'plans-A', deviceId: 'service-A',
        expectedVersion: 0, requestId: 'remote-seed', records: remoteInventory(f.seeded.id) });
    await f.forge.initialize(f.options);
    const list = await f.forge.gui.listUnifiedProjects();
    assert.equal(list.catalog.phase, 'online');
    assert.equal(list.projects.length, 2);
    const remote = list.projects.find(p => p.catalog?.remote);
    assert.ok(remote.id.startsWith('remote:'));
    assert.notEqual(remote.id, f.seeded.id);
    assert.equal(remote.catalog.localProjectId, f.seeded.id);
    assert.equal(remote.rootInfo.writable, false);
    assert.equal(remote.stats, null);
    const detail = await f.forge.gui.getUnifiedProject(remote.id);
    assert.equal(detail.todos[0].title, '服务器待办');
    assert.deepEqual(detail.timeline, []);
    assert.equal(detail.project.catalog.stale, false);
    const business = f.forge._test.getRuntime().store;
    const before = business.db.serialize();
    let changes = 0;
    const onChanged = () => { changes++; };
    f.forge.events.on('changed', onChanged);
    try {
        for (const id of [remote.id, ' ' + remote.id + ' ']) {
            for (const readOrDelete of [
                () => f.forge.gui.deleteProject(id, 'Kerr'),
                () => f.forge.gui.getProject(id),
                () => f.forge.gui.searchHistory({ projectId: id }),
                () => f.forge.gui.getBatchNodes(id, 1),
                () => f.forge.gui.getNodeDetail(id, 1),
            ]) assert.throws(readOrDelete, { code: 'REMOTE_PROJECT_READ_ONLY' });
            await assert.rejects(f.forge.gui.revertFileChange({
                projectId: id, nodeId: 1, signature: 'Kerr', force: true,
            }), { code: 'REMOTE_PROJECT_READ_ONLY' });
        }
        assert.equal(changes, 0);
        assert.deepEqual(business.db.serialize(), before);
    } finally { f.forge.events.removeListener('changed', onChanged); }
    assert.ok(f.forge.gui.getProject(f.seeded.id));

    await f.server.close();
    const offline = await f.forge.gui.listUnifiedProjects();
    assert.equal(offline.catalog.phase, 'offline');
    assert.equal(offline.catalog.cached, true);
    const cached = offline.projects.find(p => p.id === remote.id);
    assert.equal(cached.catalog.stale, true);
    assert.equal(cached.catalog.observedAt, remote.catalog.observedAt);
    const cachedDetail = await f.forge.gui.getUnifiedProject(remote.id);
    assert.equal(cachedDetail.project.catalog.stale, true);
    assert.equal(cachedDetail.project.catalog.observedAt, detail.project.catalog.observedAt);
    assert.equal(cachedDetail.todos[0].title, '服务器待办');
    assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_lease_requests').get().n, 0);
});

test('authentication revocation clears remote rows and details instead of serving stale data', async t => {
    const f = await fixture(t, { publish: false });
    f.catalog.publish({ sourceId: 'plans-A', deviceId: 'service-A',
        expectedVersion: 0, requestId: 'remote-seed', records: remoteInventory(f.seeded.id) });
    await f.forge.initialize(f.options);
    const list = await f.forge.gui.listUnifiedProjects();
    const remote = list.projects.find(p => p.catalog?.remote);
    await f.forge.gui.getUnifiedProject(remote.id);
    // Synthetic test-only credential revocation, not a production admin API.
    f.server._principals.clear();
    const denied = await f.forge.gui.listUnifiedProjects();
    assert.equal(denied.catalog.phase, 'error');
    assert.equal(denied.catalog.cached, false);
    assert.deepEqual(denied.projects.map(p => p.id), [f.seeded.id]);
    assert.equal(f.forge._test.getRuntime().catalog.details.size, 0);
    await assert.rejects(f.forge.gui.getUnifiedProject(remote.id), { code: 'NOT_FOUND' });
});

test('unified GUI deduplicates this publisher source against the complete local set', async t => {
    const f = await fixture(t);
    await f.forge.initialize(f.options);
    const list = await f.forge.gui.listUnifiedProjects();
    assert.equal(list.catalog.phase, 'online');
    assert.deepEqual(list.projects.map(p => p.id), [f.seeded.id]);
    assert.ok(Array.isArray(f.forge.gui.listProjects())); // Legacy synchronous API.
    f.forge._test.getRuntime().store.softDeleteProjects([f.seeded.id]);
    // Local tombstone must hide the older remote row before publication catches up.
    const hidden = await f.forge.gui.listUnifiedProjects();
    assert.deepEqual(hidden.projects, []);
    const all = await f.forge.gui.listUnifiedProjects({ includeDeleted: true });
    assert.equal(all.projects.length, 1);
    assert.equal(all.projects[0].id, f.seeded.id);
    assert.ok(all.projects[0].deleted_at);
});
for (const outcome of ['success', 'failure', 'reinitialize']) {
    test('unified list cannot reopen or cross runtime after cleanup: ' + outcome, async t => {
        const f = await fixture(t, { publish: false });
        await f.forge.initialize(f.options);
        const owner = f.forge._test.getRuntime();
        const host = owner.catalog;
        let settle;
        host.listRemote = () => new Promise((resolve, reject) => {
            settle = () => outcome === 'failure'
                ? reject(Object.assign(Error('offline'), { code: 'NETWORK_ERROR' }))
                : resolve({ projects: [], status: { phase: 'online' } });
        });
        const pending = f.forge.gui.listUnifiedProjects();
        const rejected = assert.rejects(pending, { code: 'CLOSED' });
        const connection = owner.store.db;
        assert.equal(typeof settle, 'function');
        await f.forge.cleanup();
        assert.equal(connection.open, false);
        assert.equal(owner.store, null);
        if (outcome === 'reinitialize') {
            await f.forge.initialize(f.options);
            assert.notEqual(f.forge._test.getRuntime(), owner);
        }
        settle();
        await rejected;
        assert.equal(owner.store, null);
        assert.equal(f.forge._test.getRuntime().store, null);
        assert.equal(connection.open, false);
    });
}

test('engineering real Forge tools auto-publish report and file summaries to an independent HTTP reader', async t => {
    const f = await fixture(t, { seed: false });
    const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
    config.publish.engineeringDetails = true;
    fs.writeFileSync(f.configPath, JSON.stringify(config));
    await f.forge.initialize(f.options);
    const created = await f.forge.processToolCall({
        command: 'CreateProject', name: '工程说明闭环', workspace: 'fixture',
        dir: 'engineering-project', todos: '实现\n验收', maid: 'Kerr',
    });
    const project = created.details.project;
    await f.forge.processToolCall({
        command: 'CreateFile', projectId: project.id, path: 'src/example.txt',
        content: 'SYNTHETIC_SOURCE_NOT_IN_CATALOG', reason: '工程说明文件摘要验证', maid: 'Kerr',
    });
    await f.forge.processToolCall({
        command: 'SubmitReport', projectId: project.id, status: 'review',
        conclusion: 'ENGINEERING_REPORT_FIRST：临时工程验证完成',
        issues: '仅合成环境', maid: 'Kerr',
    });
    const published = await until(() => {
        const source = f.catalog.get('plans-A');
        if (!source) return false;
        const detail = f.catalog.getEngineering('plans-A', {
            version: source.version, digest: source.digest, localProjectId: project.id,
        });
        return detail.state === 'shared' &&
            detail.report.text?.includes('ENGINEERING_REPORT_FIRST') &&
            detail.files.items.some(row => row.file_path === 'src/example.txt') && source;
    });

    const { loadCatalogConfig } = require(path.join(plugin, 'catalogConfig'));
    const { CatalogHost } = require(path.join(plugin, 'catalogHost'));
    const loaded = loadCatalogConfig(f.configPath);
    const reader = new CatalogHost({
        config: { client: loaded.client, read: true, publish: null },
        getStore() { throw Error('READ_ONLY_READER_MUST_NOT_OPEN_BUSINESS_DB'); },
    });
    try {
        await reader.start();
        const list = await reader.listRemote();
        const row = list.projects.find(p => p.catalog.localProjectId === project.id);
        assert.ok(row);
        const detail = await reader.getRemote(row.id);
        assert.equal(detail.project.catalog.version, published.version);
        assert.equal(detail.project.rootInfo.writable, false);
        assert.equal(detail.project.catalog.historyAvailable, false);
        assert.match(detail.project.report, /ENGINEERING_REPORT_FIRST/);
        assert.equal(detail.engineering.state, 'shared');
        assert.ok(detail.engineering.timeline.items.some(b =>
            b.reason === '工程说明文件摘要验证'));
        assert.equal(detail.engineering.files.items[0].file_path, 'src/example.txt');
        assert.equal(detail.todos.length, 2);
        assert.deepEqual(detail.timeline, []);
        assert.deepEqual(detail.files, []);
        assert.doesNotMatch(JSON.stringify(detail), /SYNTHETIC_SOURCE_NOT_IN_CATALOG/);

        await f.forge.processToolCall({
            command: 'SubmitReport', projectId: project.id, status: 'review',
            conclusion: 'ENGINEERING_REPORT_SECOND：报告更新自动发布',
            maid: 'Kerr',
        });
        await until(() => {
            const current = f.catalog.get('plans-A');
            if (current.version <= published.version) return false;
            return f.catalog.getEngineering('plans-A', {
                version: current.version, digest: current.digest, localProjectId: project.id,
            }).report.text?.includes('ENGINEERING_REPORT_SECOND');
        });
        await reader.listRemote();
        const updated = await reader.getRemote(row.id);
        assert.match(updated.project.report, /ENGINEERING_REPORT_SECOND/);
        assert.ok(updated.project.catalog.version > published.version);
        assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_projects').get().n, 0);
        assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_lease_requests').get().n, 0);
        assert.equal(reader.publisher, null);
        assert.equal(reader.journal, null);
    } finally {
        await reader.stop();
    }
});

test('real Forge create and edit automatically publish gzip snapshots to independent readonly HTTP viewer', async t => {
    const f = await fixture(t, { seed: false, codeSharing: true });
    await f.forge.initialize(f.options);
    const created = await f.forge.processToolCall({
        command: 'CreateProject', name: '代码只读闭环', workspace: 'fixture',
        dir: 'code-project', maid: 'Kerr',
    });
    const project = created.details.project;
    const firstText = 'const greeting = "中文🌿";\n';
    await f.forge.processToolCall({
        command: 'CreateFile', projectId: project.id, path: 'src/a.js',
        content: firstText, reason: '合成代码创建', maid: 'Kerr',
    });
    const waitCode = text => until(() => {
        const source = f.catalog.get('plans-A');
        if (!source) return false;
        const pin = { version: source.version, digest: source.digest, localProjectId: project.id };
        // Project creation and file creation may publish in separate cycles.
        if (!source.snapshot.list().items.some(row => row.localProjectId === project.id)) return false;
        const engineering = f.catalog.getEngineering('plans-A', pin);
        const file = engineering.files?.items.find(row => row.file_path === 'src/a.js');
        if (!file) return false;
        const code = f.catalog.getCode('plans-A', { ...pin, node: file.last_node });
        return code.file?.after.text === text && { source, file };
    });
    const first = await waitCode(firstText);
    const { loadCatalogConfig } = require(path.join(plugin, 'catalogConfig'));
    const { CatalogHost } = require(path.join(plugin, 'catalogHost'));
    const reader = new CatalogHost({
        config: { client: loadCatalogConfig(f.configPath).client, read: true },
        getStore() { throw Error('READER_MUST_NOT_OPEN_BUSINESS_DB'); },
    });
    try {
        await reader.start();
        const list = await reader.listRemote();
        const row = list.projects.find(p => p.catalog.localProjectId === project.id);
        assert.ok(row);
        const detail = await reader.getRemote(row.id);
        assert.doesNotMatch(JSON.stringify(detail), /const greeting/);
        const options = { version: detail.project.catalog.version,
            digest: detail.project.catalog.digest, node: first.file.last_node };
        // Focus/list refresh clears host details while the renderer still displays
        // the same pinned project. Code reads must not depend on cache residency.
        await reader.listRemote();
        assert.equal(reader.details.has(row.id), false);
        const code = await reader.getRemoteCode(row.id, options);
        assert.equal(code.file.before.state, 'absent');
        assert.equal(code.file.after.text, firstText);
        assert.equal(code.binding.version, options.version);

        await f.forge.processToolCall({
            command: 'EditCode', projectId: project.id, path: 'src/a.js',
            target: '中文🌿', replace: '新版🌿', reason: '合成代码更新', maid: 'Kerr',
        });
        const nextText = firstText.replace('中文🌿', '新版🌿');
        const second = await waitCode(nextText);
        assert.ok(second.source.version > first.source.version);
        await assert.rejects(reader.getRemoteCode(row.id, options), { code: 'REQUEST_CONFLICT' });
        await reader.listRemote();
        const fresh = await reader.getRemote(row.id);
        const next = await reader.getRemoteCode(row.id, {
            version: fresh.project.catalog.version, digest: fresh.project.catalog.digest,
            node: fresh.engineering.files.items[0].last_node,
        });
        assert.equal(next.file.before.text, firstText);
        assert.equal(next.file.after.text, nextText);
        assert.equal(reader.publisher, null);
        assert.equal(reader.journal, null);
        assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_projects').get().n, 0);
        assert.equal(f.hub.db.prepare('SELECT count(*) n FROM hub_lease_requests').get().n, 0);
    } finally { await reader.stop(); }
});