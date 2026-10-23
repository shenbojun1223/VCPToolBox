'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ProjectStore } = require('../../Plugin/ServerProjectForge/store');
const W = require('../../Plugin/ServerProjectForge/projectWriteGate');
const { collectCatalog } = require('../../Plugin/ServerProjectForge/catalogCollect');
const sourceId = 'plans-A';
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-catalog-collect-'));
    const store = new ProjectStore(path.join(root, 'source.db'));
    t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const projects = Array.from({ length: 13 }, (_, i) => {
        const p = store.createProject({ name: '计划' + i, root: path.join(root, 'p' + i),
            workspaceAlias: 'test' });
        store.addTodos(p.id, ['待办'], 'Kerr');
        return p;
    });
    const collect = (authorize = () => true) => collectCatalog(store, { sourceId, authorize });
    return { root, store, projects, collect };
}
test('collects all ordinary plans and soft deletion without private fields or DB writes', t => {
    const f = fixture(t);
    f.store.softDeleteProjects([f.projects[0].id], 'Kerr');
    const before = f.store.db.serialize();
    let checked = 0;
    const result = f.collect(p => {
        checked++;
        assert.equal(f.store.db.inTransaction, true);
        assert.equal(p.workspace_alias, 'test');
        return true;
    });
    assert.equal(checked, 13);
    assert.equal(result.records.length, 13);
    assert.equal(result.records.filter(r => r.project.deleted_at !== null).length, 1);
    assert.equal(result.records.every(r => r.todos.length === 1), true);
    assert.equal(result.records.some(r => Object.hasOwn(r.project, 'root')), false);
    assert.equal(JSON.stringify(result).includes(f.root.replace(/\\/g, '\\\\')), false);
    assert.deepEqual(result.delegated, []);
    assert.deepEqual(f.store.db.serialize(), before);
    assert.equal(f.collect().digest, result.digest);
});
test('denial or async authorization rejects the entire inventory', t => {
    const f = fixture(t);
    let seen = 0;
    assert.throws(() => f.collect(() => ++seen < 3), { code: 'FORBIDDEN' });
    assert.equal(seen, 3);
    assert.throws(() => f.collect(async () => true), { code: 'FORBIDDEN' });
    assert.equal(f.collect().records.length, 13);
});
test('bound global plans are delegated without acquiring a gate or reading stale todos', t => {
    const f = fixture(t), p = f.projects[0];
    const binding = {
        hubId: 'hub-11111111-2222-4333-8444-555555555555',
        globalProjectId: 'g_11111111-2222-4333-8444-555555555555',
        mappingId: 'mapping-test',
    };
    W.bind(f.store, p.id, binding);
    const before = f.store.db.serialize();
    const result = f.collect(project => { assert.notEqual(project.id, p.id); return true; });
    assert.equal(result.records.length, 12);
    assert.deepEqual(result.delegated, [{
        localProjectId: p.id, hubId: binding.hubId, globalProjectId: binding.globalProjectId,
    }]);
    assert.deepEqual(f.store.db.serialize(), before);
    assert.equal(W.gateFor(f.store, p.id), undefined);
});
test('incomplete registration or update cannot turn into an incomplete inventory', t => {
    const f = fixture(t), p = f.projects[0];
    f.store.db.prepare('INSERT INTO meta VALUES (?,?)').run('project_update:' + p.id, 'pending');
    assert.throws(() => f.collect(), { code: 'BUSY' });
    f.store.db.prepare('DELETE FROM meta WHERE key=?').run('project_update:' + p.id);
    f.store.db.prepare("UPDATE projects SET availability='pending' WHERE id=?").run(p.id);
    assert.throws(() => f.collect(), { code: 'BUSY' });
    f.store.db.prepare("UPDATE projects SET availability='ready' WHERE id=?").run(p.id);
    W.bind(f.store, p.id, {
        hubId: 'hub-11111111-2222-4333-8444-555555555555',
        globalProjectId: null, mappingId: 'mapping-test',
    });
    assert.throws(() => f.collect(), { code: 'BUSY' });
});
test('caller transaction is refused and read snapshot does not reserve a writer', t => {
    const f = fixture(t);
    assert.throws(() => f.store.db.transaction(() => f.collect())(), { code: 'INVALID_ARGUMENT' });
    const other = new (require('better-sqlite3'))(f.store.dbPath);
    try {
        let updated = false;
        const result = f.collect(() => {
            if (!updated) {
                updated = true;
                other.prepare("UPDATE todos SET title='newer committed title'").run();
            }
            return true;
        });
        assert.ok(result.records.every(r => r.todos[0].title === '待办'));
        assert.ok(f.collect().records.every(r => r.todos[0].title === 'newer committed title'));
    } finally { other.close(); }
});