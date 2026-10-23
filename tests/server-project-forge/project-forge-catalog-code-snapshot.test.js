'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Database = require('better-sqlite3');
const { projectEngineeringDetail } = require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');
const { CODE_LIMITS, validateSide, validateCodeSnapshot, collectCodeSnapshot } =
    require('../../Plugin/ServerProjectForge/catalogCodeSnapshot');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(t) {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(`
        CREATE TABLE projects(id TEXT PRIMARY KEY,root TEXT,availability TEXT);
        CREATE TABLE batches(id INTEGER PRIMARY KEY,project_id TEXT);
        CREATE TABLE nodes(id INTEGER PRIMARY KEY,project_id TEXT,batch_id INTEGER,
            file_path TEXT,before_hash TEXT,after_hash TEXT);
        CREATE TABLE blobs(hash TEXT PRIMARY KEY,size INTEGER,data BLOB);
        INSERT INTO projects VALUES ('p1','PRIVATE_ROOT','ready'),('p2','OTHER_ROOT','ready');
        INSERT INTO batches VALUES (1,'p1'),(2,'p2');
    `);
    const put = value => {
        if (value === null) return null;
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const digest = sha(bytes);
        db.prepare('INSERT OR IGNORE INTO blobs VALUES (?,?,?)').run(digest, bytes.length, zlib.gzipSync(bytes));
        return digest;
    };
    const add = (id, file, before, after, project = 'p1', batch = 1) =>
        db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?)')
            .run(id, project, batch, file, put(before), put(after));
    const detail = () => {
        const files = db.prepare(`SELECT file_path,MAX(id) AS last_node,COUNT(*) AS edits
            FROM nodes WHERE project_id='p1' GROUP BY file_path ORDER BY last_node DESC`).all();
        return projectEngineeringDetail({ project: {}, batches: [], batchTotal: 0,
            files: files.map(row => ({ ...row, added: 0, removed: 0 })), fileTotal: files.length },
        { shared: true });
    };
    const read = (options = {}, supplied) => db.transaction(() =>
        collectCodeSnapshot({ db }, 'p1', supplied || detail(), {
            shared: true, authorize: () => true, ...options,
        })).deferred();
    return { db, put, add, detail, read };
}

test('disabled sharing touches neither store nor engineering nor authorize', () => {
    const bomb = new Proxy({}, { get() { throw Error('TOUCHED'); } });
    assert.deepEqual(collectCodeSnapshot(bomb, 'p1', bomb),
        { version: 1, state: 'not-shared' });
    assert.deepEqual(collectCodeSnapshot(bomb, 'p1', bomb, {
        shared: false, authorize() { throw Error('TOUCHED'); },
    }), { version: 1, state: 'not-shared' });
    assert.throws(() => collectCodeSnapshot(bomb, 'p1', bomb, { shared: 'true' }));
});

test('authorization is synchronous inside an existing read transaction; collection is read-only', t => {
    const f = fixture(t);
    f.add(1, 'a.js', 'before', 'after');
    const before = f.db.serialize();
    assert.throws(() => collectCodeSnapshot({ db: f.db }, 'p1', f.detail(), {
        shared: true, authorize: () => true,
    }), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => f.read({ authorize: () => false }), { code: 'FORBIDDEN' });
    assert.throws(() => f.read({ authorize: async () => true }), { code: 'FORBIDDEN' });
    f.read({ authorize(project) {
        assert.equal(f.db.inTransaction, true);
        assert.equal(project.id, 'p1');
        project.availability = 'pending';
        return true;
    } });
    assert.deepEqual(f.db.serialize(), before);
});

test('preserves BOM CRLF Unicode and empty text; absent is different from empty', t => {
    const f = fixture(t), source = '\uFEFFconst 中文 = "🌿";\r\n';
    f.add(1, 'src/a.js', '', source);
    f.add(2, 'deleted.js', 'old', null);
    f.add(3, 'created.js', null, '');
    const value = f.read();
    const row = value.files.find(file => file.node === 1);
    assert.equal(row.before.state, 'text');
    assert.equal(row.before.size, 0);
    assert.equal(row.after.text, source);
    assert.equal(row.after.hash, sha(Buffer.from(source)));
    assert.equal(value.files[0].before.state, 'absent');
    assert.equal(value.files[0].after.state, 'text');
    assert.equal(value.files[1].after.state, 'absent');
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_ROOT|OTHER_ROOT/);
    assert.deepEqual(validateCodeSnapshot(value, f.detail()), value);
});

test('binary, invalid UTF8 and oversized blobs have explicit non-text states', t => {
    const f = fixture(t);
    f.add(1, 'binary.bin', null, Buffer.from([65, 0, 66]));
    f.add(2, 'legacy.txt', null, Buffer.from([0xff, 0xfe, 65]));
    f.add(3, 'large.txt', null, Buffer.alloc(CODE_LIMITS.blobBytes + 1, 65));
    f.add(4, 'exact.txt', null, Buffer.alloc(CODE_LIMITS.blobBytes, 65));
    const value = f.read();
    assert.deepEqual(value.files.map(row => row.after.state),
        ['text', 'too-large', 'unsupported-encoding', 'binary']);
    for (const row of value.files.slice(1)) assert.equal(row.after.text, null);
});

test('only the latest project-owned node and matching batch are accepted', t => {
    const f = fixture(t);
    f.add(1, 'a.js', null, 'old');
    const stale = f.detail();
    f.add(2, 'a.js', 'old', 'new');
    f.add(3, 'secret.js', null, 'OTHER_SECRET', 'p2', 2);
    assert.equal(f.read().files.length, 1);
    assert.equal(f.read().files[0].node, 2);
    assert.throws(() => f.read({}, stale), { code: 'CONTENT_BINDING' });
    const foreign = clone(f.detail());
    foreign.files.items[0].last_node = 3;
    assert.throws(() => f.read({}, foreign), { code: 'CONTENT_BINDING' });
    f.db.prepare('UPDATE nodes SET batch_id=2 WHERE id=2').run();
    assert.throws(() => f.read(), { code: 'CONTENT_BINDING' });
});

test('missing, corrupt or inconsistent blob data fails rather than becoming an empty file', t => {
    const f = fixture(t);
    f.add(1, 'a.js', null, 'hello');
    const digest = sha(Buffer.from('hello'));
    f.db.prepare('UPDATE blobs SET data=? WHERE hash=?').run(zlib.gzipSync(Buffer.from('jello')), digest);
    assert.throws(() => f.read(), { code: 'CORRUPT_BLOB' });
    f.db.prepare('UPDATE blobs SET size=6 WHERE hash=?').run(digest);
    assert.throws(() => f.read(), { code: 'CORRUPT_BLOB' });
    f.db.prepare('DELETE FROM blobs').run();
    assert.throws(() => f.read(), { code: 'CORRUPT_BLOB' });
});

test('strict frozen validation rejects extra fields, text/hash tampering and reordered files', t => {
    const f = fixture(t);
    f.add(1, 'a.js', null, 'first');
    f.add(2, 'b.js', null, 'second');
    const original = f.read();
    for (const mutate of [
        value => { value.secret = 'unexpected'; },
        value => { value.files[0].after.text = 'tamper'; },
        value => { value.files[0].after.hash = '0'.repeat(64); },
        value => { value.files.reverse(); },
        value => { value.files.pop(); },
        value => { value.files[0].file_path = '../escape'; },
        value => { value.files[0].node++; },
    ]) {
        const value = clone(original); mutate(value);
        assert.throws(() => validateCodeSnapshot(value, f.detail()));
    }
    assert.throws(() => validateCodeSnapshot(original, { version: 1, state: 'not-shared' }));
    assert.throws(() => validateSide({ state: 'text', text: '\ud800', size: 3, hash: '0'.repeat(64) }));
    assert.throws(() => validateSide({ state: 'too-large', text: null, size: 1, hash: '0'.repeat(64) }));
    assert.throws(() => validateSide({ state: 'absent', text: '', size: 0, hash: null }));
});

test('pending or missing projects fail closed, and shared empty projects remain shared', t => {
    const f = fixture(t);
    assert.deepEqual(f.read(), { version: 1, state: 'shared', files: [] });
    f.db.prepare("UPDATE projects SET availability='pending' WHERE id='p1'").run();
    assert.throws(() => f.read(), { code: 'BUSY' });
    f.db.prepare("DELETE FROM projects WHERE id='p1'").run();
    assert.throws(() => f.read(), { code: 'NOT_FOUND' });
});

test('actual serialized byte budget bounds escaped content across files', t => {
    const f = fixture(t);
    const text = '\u0001'.repeat(CODE_LIMITS.blobBytes);
    for (let i = 1; i <= 30; i++) f.add(i, `src/${i}.js`, text, text);
    assert.throws(() => f.read(), { code: 'LIMIT_EXCEEDED' });
});