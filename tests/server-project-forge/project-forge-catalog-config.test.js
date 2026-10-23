'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { loadCatalogConfig } = require('../../Plugin/ServerProjectForge/catalogConfig');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-catalog-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'config.json'), tokenFile = path.join(root, 'token.txt');
    fs.writeFileSync(tokenFile, 'A'.repeat(43));
    const journalPath = path.join(root, 'publish.db');
    const base = {
        version: 1, endpoint: 'http://127.0.0.1:1', hubId: 'hub-11111111-2222-4333-8444-555555555555',
        deviceId: 'A', tokenFile, read: true,
    };
    const load = config => {
        fs.writeFileSync(file, JSON.stringify(config));
        return loadCatalogConfig(file);
    };
    return { root, file, tokenFile, journalPath, base, load };
}
test('disabled catalog does not require any file', () => {
    for (const value of [undefined, null, '']) assert.equal(loadCatalogConfig(value), null);
});
test('read-only configuration creates no publisher journal and exposes no bearer', t => {
    const f = fixture(t), before = fs.readdirSync(f.root);
    const config = f.load(f.base);
    assert.equal(config.read, true);
    assert.equal(config.publish, null);
    assert.equal(config.client.deviceId, 'A');
    assert.equal(fs.existsSync(f.journalPath), false);
    assert.equal(JSON.stringify(config).includes('A'.repeat(43)), false);
    assert.deepEqual(fs.readdirSync(f.root).sort(), [...before, 'config.json'].sort());
});
test('publish-only requires explicit all-projects sharing and preserves separate read flag', t => {
    const f = fixture(t);
    const config = f.load({ ...f.base, read: false, publish: {
        sourceId: 'source-A', journalPath: f.journalPath, allProjects: true,
    } });
    assert.equal(config.read, false);
    assert.deepEqual(config.publish, {
        sourceId: 'source-A', journalPath: f.journalPath, allProjects: true, intervalMs: 5000,
    });
    assert.equal(fs.existsSync(f.journalPath), false);
});
test('invalid scopes, endpoints, paths and old autoresume fields fail statically', t => {
    const f = fixture(t), publish = {
        sourceId: 'source-A', journalPath: f.journalPath, allProjects: true,
    };
    for (const config of [
        { ...f.base, read: false },
        { ...f.base, read: 'true' },
        { ...f.base, localProjectId: 'p1' },
        { ...f.base, endpoint: 'http://example.com' },
        { ...f.base, pathPrefix: '/unsafe/../path' },
        { ...f.base, publish: { ...publish, allProjects: false } },
        { ...f.base, publish: { ...publish, intervalMs: 0 } },
        { ...f.base, publish: { ...publish, sourceId: '../bad' } },
        { ...f.base, publish: { ...publish, journalPath: 'relative.db' } },
        { ...f.base, publish: { ...publish, journalPath: f.tokenFile } },
        { ...f.base, publish: { ...publish, journalPath: f.file } },
        { ...f.base, publish: { ...publish, journalPath: path.join(f.root, 'missing', 'journal.db') } },
    ]) {
        assert.throws(() => f.load(config), { code: 'CATALOG_CONFIG_INVALID' });
    }
    assert.equal(fs.existsSync(f.journalPath), false);
    assert.equal(fs.readFileSync(f.tokenFile, 'utf8'), 'A'.repeat(43));
});
test('malformed configuration and credential failures never reflect private data', t => {
    const f = fixture(t);
    const secret = 'synthetic-PRIVATE-DO-NOT-LOG';
    fs.writeFileSync(f.file, '{"secret":"' + secret);
    try { loadCatalogConfig(f.file); assert.fail('must reject'); }
    catch (error) {
        assert.equal(error.message, 'CATALOG_CONFIG_INVALID');
        assert.equal(error.code, 'CATALOG_CONFIG_INVALID');
        assert.equal(error.stack.includes(secret), false);
        assert.equal(error.stack.includes(f.root), false);
    }
    fs.writeFileSync(f.tokenFile, secret);
    assert.throws(() => f.load(f.base), { message: 'CATALOG_CONFIG_INVALID' });
    fs.writeFileSync(f.tokenFile, Buffer.from([0xff, 0xfe]));
    assert.throws(() => f.load(f.base), { code: 'CATALOG_CONFIG_INVALID' });
});
test('hardlinked journal aliases are rejected without modifying the linked file', t => {
    const f = fixture(t);
    fs.linkSync(f.tokenFile, f.journalPath);
    assert.throws(() => f.load({ ...f.base, publish: {
        sourceId: 'source-A', journalPath: f.journalPath, allProjects: true,
    } }), { code: 'CATALOG_CONFIG_INVALID' });
    assert.equal(fs.readFileSync(f.tokenFile, 'utf8'), 'A'.repeat(43));
});

test('engineering details require an explicit boolean publish option without changing legacy defaults', t => {
    const f = fixture(t);
    const publish = { sourceId: 'source-A', journalPath: f.journalPath, allProjects: true };
    const legacy = f.load({ ...f.base, publish });
    assert.equal(Object.hasOwn(legacy.publish, 'engineeringDetails'), false);
    for (const enabled of [true, false]) {
        const loaded = f.load({ ...f.base, publish: { ...publish, engineeringDetails: enabled } });
        assert.equal(loaded.publish.engineeringDetails, enabled);
    }
    for (const invalid of ['true', 1, null, {}, []]) {
        assert.throws(() => f.load({
            ...f.base, publish: { ...publish, engineeringDetails: invalid },
        }), { code: 'CATALOG_CONFIG_INVALID' });
    }
    assert.equal(fs.existsSync(f.journalPath), false);
});
test('code sharing defaults off and requires explicit engineering sharing', t => {
    const f = fixture(t);
    const publish = { sourceId: 'source-A', journalPath: f.journalPath, allProjects: true };
    assert.equal(Object.hasOwn(f.load({ ...f.base, publish }).publish, 'codeSnapshots'), false);
    for (const codeSnapshots of [false, true]) {
        const loaded = f.load({ ...f.base, publish: {
            ...publish, engineeringDetails: true, codeSnapshots,
        } });
        assert.equal(loaded.publish.codeSnapshots, codeSnapshots);
    }
    for (const extra of [
        { codeSnapshots: true }, { codeSnapshots: true, engineeringDetails: false },
        ...['true', 1, null, {}, []].map(codeSnapshots => ({
            engineeringDetails: true, codeSnapshots,
        })),
    ]) {
        assert.throws(() => f.load({ ...f.base, publish: { ...publish, ...extra } }),
            { code: 'CATALOG_CONFIG_INVALID' });
    }
    assert.equal(fs.existsSync(f.journalPath), false);
});