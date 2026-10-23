'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const zlib = require('node:zlib');
const { ProjectStore } = require('../../Plugin/ServerProjectForge/store');
const { collectCatalog } = require('../../Plugin/ServerProjectForge/catalogCollect');
const { CODE_LIMITS } = require('../../Plugin/ServerProjectForge/catalogCodeSnapshot');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-code-real-store-'));
    const store = new ProjectStore(path.join(root, 'store.db'));
    t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const project = store.createProject({ name: 'gzip snapshot', root, workspaceAlias: 'fixture' });
    const batch = store.createBatch(project.id, 'create', 'test', 'Kerr');
    const add = (filePath, bytes) => {
        const digest = store.putBlob(bytes);
        store.addNode({ projectId: project.id, batchId: batch, filePath,
            op: 'create', beforeHash: null, afterHash: digest });
        return digest;
    };
    const collect = () => collectCatalog(store, { sourceId: 'fixture',
        authorize: () => true, engineeringDetails: true, codeSnapshots: true });
    return { root, store, project, add, collect };
}

test('actual ProjectStore gzip blobs yield exact source bytes through complete v3 collection', t => {
    const f = fixture(t), text = '\uFEFFconst 中文 = "🌿";\r\n';
    const digest = f.add('a.js', Buffer.from(text));
    const row = f.store.db.prepare('SELECT size,data FROM blobs WHERE hash=?').get(digest);
    assert.equal(row.data[0], 0x1f);
    assert.equal(row.data[1], 0x8b);
    assert.equal(zlib.gunzipSync(row.data).toString('utf8'), text);
    const before = f.store.db.serialize();
    const result = f.collect();
    assert.equal(result.protocolVersion, 3);
    const file = result.codes[0].code.files[0];
    assert.equal(file.after.text, text);
    assert.equal(file.after.hash, digest);
    assert.equal(file.before.state, 'absent');
    assert.deepEqual(f.store.db.serialize(), before);
    assert.equal(fs.existsSync(path.join(f.root, 'a.js')), false);
});

test('actual compressed empty binary and oversized snapshots retain explicit states', t => {
    const f = fixture(t);
    f.add('empty.txt', Buffer.alloc(0));
    f.add('binary.bin', Buffer.from([0, 255, 1]));
    f.add('large.txt', Buffer.alloc(CODE_LIMITS.blobBytes + 1, 65));
    const files = new Map(f.collect().codes[0].code.files.map(row => [row.file_path, row.after]));
    assert.equal(files.get('empty.txt').state, 'text');
    assert.equal(files.get('empty.txt').text, '');
    assert.equal(files.get('binary.bin').state, 'binary');
    assert.equal(files.get('large.txt').state, 'too-large');
});

test('decompression expansion and corrupt gzip fail closed without returning partial content', t => {
    const f = fixture(t), digest = f.add('a.js', Buffer.from('valid'));
    for (const data of [
        Buffer.from('not gzip'),
        zlib.gzipSync(Buffer.alloc(CODE_LIMITS.blobBytes + 1, 65)),
        zlib.gzipSync(Buffer.from('other')),
        Buffer.alloc(CODE_LIMITS.blobBytes + 4096, 65),
    ]) {
        f.store.db.prepare('UPDATE blobs SET data=? WHERE hash=?').run(data, digest);
        assert.throws(() => f.collect(), { code: 'CORRUPT_BLOB' });
    }
});