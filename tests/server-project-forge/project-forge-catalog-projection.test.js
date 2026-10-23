'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogIdentity, projectSummary } =
    require('../../Plugin/ServerProjectForge/catalogProjection');

const time = '2026-10-21T00:00:00.000Z';
const globalId = 'g_11111111-2222-4333-8444-555555555555';
function fixture() {
    return {
        project: {
            id: 'p1234', name: '跨端计划', status: 'active', availability: 'ready',
            created_at: time, updated_at: time, deleted_at: null,
            root: 'C:\\private\\repo', report: 'not part of the summary',
            workspace_id: 'private-workspace', subpath: 'private/subpath',
        },
        todos: [
            { project_id: 'p1234', seq: 1, status: 'done', title: '完成' },
            { project_id: 'p1234', seq: 2, status: 'blocked', title: '等待' },
        ],
        identity: { sourceId: 'home', localProjectId: 'p1234' },
    };
}
const project = f => projectSummary(f.project, f.todos, f.identity);

test('same short ID on different sources is not merged', () => {
    const a = catalogIdentity({ sourceId: 'home', localProjectId: 'p1234' });
    const b = catalogIdentity({ sourceId: 'server', localProjectId: 'p1234' });
    assert.notEqual(a.key, b.key);
});
test('verified global mappings share a key despite different local IDs', () => {
    const a = catalogIdentity({ sourceId: 'home', localProjectId: 'p1234', globalProjectId: globalId });
    const b = catalogIdentity({ sourceId: 'server', localProjectId: 'p5678', globalProjectId: globalId });
    assert.equal(a.key, b.key);
    assert.notEqual(a.localProjectId, b.localProjectId);
});
test('identity encoding does not collide on permitted separators', () => {
    const a = catalogIdentity({ sourceId: 'a:b', localProjectId: 'c' });
    const b = catalogIdentity({ sourceId: 'a', localProjectId: 'b:c' });
    assert.notEqual(a.key, b.key);
});
test('summary exports only explicit display fields and accurate counts', () => {
    const f = fixture();
    const result = project(f);
    assert.deepEqual(Object.keys(result).sort(), [
        'key', 'sourceId', 'localProjectId', 'globalProjectId',
        'name', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'progress',
    ].sort());
    assert.deepEqual(result.progress, { total: 2, pending: 0, doing: 0, done: 1, blocked: 1 });
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(f.project.root, 'C:\\private\\repo');
});
test('soft deletion is explicit and is not inferred from a missing listing', () => {
    const f = fixture();
    f.project.deleted_at = time;
    assert.equal(project(f).deletedAt, time);
});
test('rejects mismatched identity, partial imports and foreign todos', () => {
    for (const mutate of [
        f => { f.identity.localProjectId = 'p9999'; },
        f => { f.project.availability = 'pending'; },
        f => { f.todos[0].project_id = 'p9999'; },
        f => { f.todos[1].seq = 1; },
        f => { f.todos[0].status = 'unknown'; },
        f => { f.project.status = 'unknown'; },
    ]) {
        const f = fixture(); mutate(f);
        assert.throws(() => project(f), { code: 'INVALID_ARGUMENT' });
    }
});
test('rejects malformed global IDs, names and timestamps', () => {
    for (const mutate of [
        f => { f.identity.globalProjectId = '../../secret'; },
        f => { f.project.name = 'x'.repeat(4097); },
        f => { f.project.updated_at = 'not-a-date'; },
    ]) {
        const f = fixture(); mutate(f);
        assert.throws(() => project(f), { code: 'INVALID_ARGUMENT' });
    }
});
const { todoDetail } =
    require('../../Plugin/ServerProjectForge/catalogProjection');
function todoFixture() {
    return {
        id: 999, project_id: 'p1234', seq: 3, status: 'doing',
        title: '实现目录', note: '只读查看', updated_by: 'Kerr', updated_at: time,
        root: 'C:\\private', extra: 'not exported',
    };
}
test('todo detail exports only presentation fields', () => {
    assert.deepEqual(todoDetail(todoFixture(), 'p1234'), {
        seq: 3, status: 'doing', title: '实现目录', note: '只读查看',
        updatedBy: 'Kerr', updatedAt: time, truncated: [],
    });
});
test('long previews explicitly identify each truncated field', () => {
    const todo = todoFixture();
    todo.title = '中'.repeat(513);
    todo.note = '文'.repeat(2049);
    todo.updated_by = 'a'.repeat(101);
    const result = todoDetail(todo, 'p1234');
    assert.deepEqual(result.truncated, ['title', 'note', 'updatedBy']);
    assert.equal(result.title.length, 512);
    assert.equal(result.note.length, 2048);
    assert.equal(result.updatedBy.length, 100);
    assert.equal(todo.note.length, 2049);
});
test('preview clipping preserves surrogate pairs', () => {
    const todo = todoFixture();
    todo.note = 'x'.repeat(2047) + '\uD83D\uDE80' + 'tail';
    const result = todoDetail(todo, 'p1234');
    assert.equal(result.note, 'x'.repeat(2047));
    assert.deepEqual(result.truncated, ['note']);
});
test('optional todo text is nullable but title and ownership are required', () => {
    const todo = todoFixture();
    delete todo.note;
    todo.updated_by = null;
    const result = todoDetail(todo, 'p1234');
    assert.equal(result.note, null);
    assert.equal(result.updatedBy, null);
    for (const patch of [
        { title: null }, { note: {} }, { updated_by: 42 },
        { seq: 0 }, { status: 'invalid' }, { project_id: 'p9999' },
        { updated_at: 'yesterday' },
    ]) {
        assert.throws(() => todoDetail({ ...todo, ...patch }, 'p1234'),
            { code: 'INVALID_ARGUMENT' });
    }
});
test('timestamps reject calendar rollover rather than silently normalizing', () => {
    for (const value of [
        '2026-02-30T00:00:00.000Z',
        '2026-02-29T00:00:00.000Z',
        '2026-04-31T00:00:00Z',
        '2026-10-21T24:00:00.000Z',
    ]) {
        const f = fixture();
        f.project.updated_at = value;
        assert.throws(() => project(f), { code: 'INVALID_ARGUMENT' });
        assert.throws(() => todoDetail({ ...todoFixture(), updated_at: value }, 'p1234'),
            { code: 'INVALID_ARGUMENT' });
    }
    for (const value of ['2024-02-29T00:00:00.000Z', '2026-10-21T00:00:00Z']) {
        const f = fixture();
        f.project.updated_at = value;
        assert.equal(project(f).updatedAt, value);
        assert.equal(todoDetail({ ...todoFixture(), updated_at: value }, 'p1234').updatedAt, value);
    }
});