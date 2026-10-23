'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CatalogSnapshot } =
    require('../../Plugin/ServerProjectForge/catalogSnapshot');
const time = '2026-10-21T00:00:00.000Z';
function record(n, count = 2) {
    const id = 'p' + n;
    return {
        project: { id, name: '工程' + n, availability: 'ready', status: 'active',
            created_at: time, updated_at: time, deleted_at: null },
        identity: { sourceId: 'source-A', localProjectId: id },
        todos: Array.from({ length: count }, (_, i) => ({
            project_id: id, seq: i + 1, status: 'pending', title: '计划' + i,
            note: null, updated_by: null, updated_at: time,
        })),
    };
}
test('all 137 projects are returned exactly once across bounded pages', () => {
    const snapshot = new CatalogSnapshot(Array.from({ length: 137 }, (_, i) => record(i)));
    const rows = [];
    let cursor = null;
    do {
        const page = snapshot.list({ cursor, limit: 10 });
        assert.equal(page.total, 137);
        assert.ok(page.items.length > 0 && page.items.length <= 10);
        rows.push(...page.items);
        cursor = page.next;
    } while (cursor);
    assert.equal(rows.length, 137);
    assert.equal(new Set(rows.map(r => r.key)).size, 137);
});
test('snapshot order and identity are independent of input order', () => {
    const rows = [record(3), record(1), record(2)];
    const a = new CatalogSnapshot(rows);
    const b = new CatalogSnapshot([...rows].reverse());
    assert.equal(a.id, b.id);
    assert.deepEqual(a.list(), b.list());
});
test('input and output mutation cannot change a retained snapshot', () => {
    const source = record(1);
    const snapshot = new CatalogSnapshot([source]);
    const before = snapshot.list();
    source.project.name = 'changed';
    source.todos[0].title = 'changed';
    const page = snapshot.list();
    page.items[0].name = 'tampered';
    page.items[0].progress.done = 999;
    assert.deepEqual(snapshot.list(), before);
    const key = before.items[0].key;
    const detail = snapshot.todos(key);
    detail.items[0].title = 'tampered';
    assert.equal(snapshot.todos(key).items[0].title, '计划0');
});
test('UTF-8 byte budget controls pages without dropping Chinese todos', () => {
    const source = record(1, 15);
    source.todos.forEach(t => { t.note = '汉'.repeat(500); });
    const snapshot = new CatalogSnapshot([source]);
    const key = snapshot.list().items[0].key;
    const rows = [];
    let cursor = null;
    do {
        const page = snapshot.todos(key, { cursor, maxBytes: 2500 });
        assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 2500);
        assert.ok(page.items.length > 0);
        rows.push(...page.items);
        cursor = page.next;
    } while (cursor);
    assert.deepEqual(rows.map(t => t.seq), Array.from({ length: 15 }, (_, i) => i + 1));
});
test('cursor cannot cross snapshot, list kind or project detail', () => {
    const a = new CatalogSnapshot([record(1), record(2)]);
    const changed = record(1);
    changed.todos[0].status = 'done';
    const b = new CatalogSnapshot([changed, record(2)]);
    const listCursor = a.list({ limit: 1 }).next;
    assert.throws(() => b.list({ cursor: listCursor }), { code: 'REQUEST_CONFLICT' });
    const keys = a.list().items.map(p => p.key);
    assert.throws(() => a.todos(keys[0], { cursor: listCursor }), { code: 'REQUEST_CONFLICT' });
    const todoCursor = a.todos(keys[0], { limit: 1 }).next;
    assert.throws(() => a.todos(keys[1], { cursor: todoCursor }), { code: 'REQUEST_CONFLICT' });
});
test('empty snapshot and empty todo list terminate with null cursor', () => {
    const empty = new CatalogSnapshot([]).list();
    assert.deepEqual(empty.items, []);
    assert.equal(empty.next, null);
    const snapshot = new CatalogSnapshot([record(1, 0)]);
    const page = snapshot.todos(snapshot.list().items[0].key);
    assert.deepEqual(page.items, []);
    assert.equal(page.next, null);
});
test('oversized item and invalid page limits fail rather than silently omit', () => {
    const r = record(1);
    r.project.name = '汉'.repeat(4096);
    const snapshot = new CatalogSnapshot([r]);
    assert.throws(() => snapshot.list({ maxBytes: 512 }), { code: 'LIMIT_EXCEEDED' });
    for (const limit of [0, -1, 201, 1.5]) {
        assert.throws(() => snapshot.list({ limit }), { code: 'INVALID_ARGUMENT' });
    }
    assert.throws(() => snapshot.todos('missing'), { code: 'NOT_FOUND' });
});
test('duplicate global identities require upstream authority resolution', () => {
    const a = record(1), b = record(2);
    a.identity.globalProjectId = b.identity.globalProjectId =
        'g_11111111-2222-4333-8444-555555555555';
    assert.throws(() => new CatalogSnapshot([a, b]), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => new CatalogSnapshot([a, a]), { code: 'REQUEST_CONFLICT' });
});
test('source, todo and page capacity bounds are explicit', () => {
    assert.throws(() => new CatalogSnapshot(Array(8193)), { code: 'LIMIT_EXCEEDED' });
    const r = record(1, 0);
    r.todos = Array(50001);
    assert.throws(() => new CatalogSnapshot([r]), { code: 'LIMIT_EXCEEDED' });
    const snapshot = new CatalogSnapshot([record(1), record(2)]);
    const cursor = snapshot.list({ limit: 1 }).next;
    assert.throws(() => snapshot.list({ cursor: { ...cursor, offset: -1 } }),
        { code: 'INVALID_ARGUMENT' });
    assert.throws(() => snapshot.list({ maxBytes: 49153 }), { code: 'INVALID_ARGUMENT' });
});