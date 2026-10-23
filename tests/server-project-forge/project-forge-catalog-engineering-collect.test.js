'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { collectEngineeringDetail } = require('../../Plugin/ServerProjectForge/catalogEngineeringCollect');
const { DETAIL_LIMITS } = require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');
const at = '2026-10-22T02:00:00.000Z';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-detail-collect-'));
    const filename = path.join(root, 'fixture.db');
    const db = new Database(filename);
    t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
    db.pragma('journal_mode=WAL');
    db.exec(`
        CREATE TABLE projects(id TEXT PRIMARY KEY,root TEXT,availability TEXT,report TEXT,report_by TEXT);
        CREATE TABLE batches(id INTEGER PRIMARY KEY,project_id TEXT,kind TEXT,reason TEXT,maid TEXT,created_at TEXT);
        CREATE TABLE nodes(id INTEGER PRIMARY KEY,project_id TEXT,batch_id INTEGER,file_path TEXT,added INTEGER,removed INTEGER);
        INSERT INTO projects VALUES ('p1','private-root','ready','original report','Kerr');
        INSERT INTO projects VALUES ('p2','other-root','ready','OTHER_PRIVATE_REPORT','Other');
    `);
    const add = (id, batchId, projectId, file) => db.prepare('INSERT INTO nodes VALUES (?,?,?,?,?,?)')
        .run(id, projectId, batchId, file, 2, 1);
    const batch = (id, projectId = 'p1') => db.prepare('INSERT INTO batches VALUES (?,?,?,?,?,?)')
        .run(id, projectId, 'edit', 'reason', 'Kerr', at);
    const read = (options = {}) => collectEngineeringDetail({ db }, 'p1', {
        shared: true, authorize: () => true, ...options,
    });
    return { db, filename, add, batch, read };
}

test('disabled sharing does not access the database or authorization callback', () => {
    const store = new Proxy({}, { get() { throw Error('DATABASE_TOUCHED'); } });
    assert.deepEqual(collectEngineeringDetail(store, 'p1'),
        { version: 1, state: 'not-shared' });
    assert.deepEqual(collectEngineeringDetail(store, 'p1', {
        shared: false, authorize() { throw Error('AUTH_TOUCHED'); },
    }), { version: 1, state: 'not-shared' });
    assert.throws(() => collectEngineeringDetail(store, 'p1', { shared: 'true' }));
});

test('authorization runs in the snapshot and denial or async results fail closed', t => {
    const f = fixture(t);
    const before = f.db.serialize();
    assert.throws(() => f.read({ authorize: () => false }), { code: 'FORBIDDEN' });
    assert.throws(() => f.read({ authorize: async () => true }), { code: 'FORBIDDEN' });
    const result = f.read({ authorize(p) {
        assert.equal(f.db.inTransaction, true);
        assert.equal(p.id, 'p1');
        p.report = 'MUTATED_CALLBACK_COPY';
        return true;
    } });
    assert.equal(result.report.text, 'original report');
    assert.deepEqual(f.db.serialize(), before);
});

test('only project-owned nodes contribute; empty batches are omitted', t => {
    const f = fixture(t);
    f.batch(1); f.batch(2); f.batch(3, 'p2');
    f.add(1, 1, 'p1', 'src/a,comma.js');
    f.add(2, 1, 'p2', 'OTHER_PRIVATE_PATH.js'); // inconsistent foreign node must not leak
    f.add(3, 3, 'p2', 'other.js');
    const before = f.db.serialize();
    const result = f.read();
    assert.equal(result.timeline.total, 1);
    assert.equal(result.timeline.items[0].node_count, 1);
    assert.deepEqual(result.timeline.items[0].files, ['src/a,comma.js']);
    assert.equal(result.files.total, 1);
    assert.doesNotMatch(JSON.stringify(result), /OTHER_PRIVATE|private-root|other-root/);
    assert.deepEqual(f.db.serialize(), before);
});

test('large histories return bounded deterministic previews with exact totals', t => {
    const f = fixture(t);
    f.db.transaction(() => {
        for (let i = 1; i <= 25; i++) { f.batch(i); f.add(i, i, 'p1', `src/b-${i}.js`); }
        for (let i = 26; i <= 150; i++) f.add(i, 25, 'p1', `src/b-${i}.js`);
    })();
    const result = f.read();
    assert.equal(result.timeline.total, 25);
    assert.equal(result.timeline.items.length, DETAIL_LIMITS.maxBatches);
    assert.equal(result.timeline.items[0].id, 25);
    assert.equal(result.timeline.items[0].file_total, 126);
    assert.equal(result.timeline.items[0].files.length, DETAIL_LIMITS.maxBatchFiles);
    assert.equal(result.timeline.items[0].files_truncated, true);
    assert.equal(result.files.total, 150);
    assert.equal(result.files.items.length, DETAIL_LIMITS.maxFiles);
    assert.equal(result.files.items[0].last_node, 150);
    assert.equal(result.files.truncated, true);
    assert.deepEqual(f.read(), result);
});

test('outer read transaction is reused and concurrent commits do not mix versions', t => {
    const f = fixture(t);
    const other = new Database(f.filename);
    try {
        const result = f.db.transaction(() => {
            f.db.prepare('SELECT report FROM projects WHERE id=?').get('p1');
            other.prepare("UPDATE projects SET report='new report' WHERE id='p1'").run();
            return f.read();
        }).deferred();
        assert.equal(result.report.text, 'original report');
        assert.equal(f.read().report.text, 'new report');
    } finally { other.close(); }
});

test('unavailable and missing projects are not represented as empty details', t => {
    const f = fixture(t);
    f.db.prepare("UPDATE projects SET availability='pending' WHERE id='p1'").run();
    assert.throws(() => f.read(), { code: 'BUSY' });
    f.db.prepare("DELETE FROM projects WHERE id='p1'").run();
    assert.throws(() => f.read(), { code: 'NOT_FOUND' });
});