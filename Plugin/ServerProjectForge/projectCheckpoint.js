'use strict';
// Trusted internal helpers. No filesystem writes, network, schema changes or implicit merge.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { validateProjectBundle, exportProjectBundle } = require('./projectBundle');
const { SyncError } = require('./projectSync');
const check = (ok, code) => { if (!ok) throw new SyncError(code, code); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function decode(bytes, expectedHash) {
    validateProjectBundle(bytes, { expectedHash });
    return JSON.parse(bytes.toString('utf8'));
}
function normalize(data) {
    const nodes = [...data.nodes].sort((a, b) => a.id - b.id);
    const batches = [...data.batches].sort((a, b) => a.id - b.id);
    const todos = [...data.todos].sort((a, b) => a.seq - b.seq);
    check(new Set(todos.map(t => t.seq)).size === todos.length, 'CHECKPOINT_AMBIGUOUS');
    const todoId = new Map(todos.map(t => [t.id, t.seq]));
    const batchId = new Map(batches.map((b, i) => [b.id, i + 1]));
    const nodeId = new Map(nodes.map((n, i) => [n.id, i + 1]));
    const captureId = new Map(data.captures.map(c => [c.id, c.request_id]));
    const without = (row, omit) => Object.fromEntries(Object.entries(row)
        .filter(([k]) => !omit.includes(k)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const ref = (map, value) => value === null ? null : map.get(value);
    return {
        project: without(data.project, ['id']),
        todos: todos.map(t => without(t, ['id'])),
        batches: batches.map(b => without(b, ['id'])),
        nodes: nodes.map(n => without({ ...n, batch_id: ref(batchId, n.batch_id),
            todo_id: ref(todoId, n.todo_id) }, ['id'])),
        captures: [...data.captures].sort((a, b) => a.request_id < b.request_id ? -1 : 1).map(c =>
            without({ ...c, todo_id: ref(todoId, c.todo_id), batch_id: ref(batchId, c.batch_id),
                baseline_node: c.baseline_node === 0 ? 0 : nodeId.get(c.baseline_node) }, ['id'])),
        capture_files: data.capture_files.map(f => ({ before_hash: f.before_hash,
            capture_id: captureId.get(f.capture_id), file_path: f.file_path }))
            .sort((a, b) => JSON.stringify([a.capture_id, a.file_path]).localeCompare(JSON.stringify([b.capture_id, b.file_path]), 'en')),
        files: [...data.files].sort((a, b) => a.file_path < b.file_path ? -1 : 1).map(f => without(f, [])),
    };
}
function fingerprint(bytes) { return sha(Buffer.from(JSON.stringify(normalize(decode(bytes))))); }
function assertClean(store, projectId, baselineBytes) {
    const local = exportProjectBundle(store, projectId);
    check(fingerprint(local.bytes) === fingerprint(baselineBytes), 'LOCAL_CHANGES');
    return local;
}
function assertForward(baseBytes, nextBytes) {
    const a = normalize(decode(baseBytes)), b = normalize(decode(nextBytes));
    check(a.project.created_at === b.project.created_at && a.project.created_by === b.project.created_by, 'HISTORY_CONFLICT');
    for (const name of ['nodes', 'batches']) {
        check(b[name].length >= a[name].length && equal(b[name].slice(0, a[name].length), a[name]), 'HISTORY_CONFLICT');
    }
    for (const capture of a.captures) {
        const next = b.captures.find(c => c.request_id === capture.request_id);
        check(equal(capture, next), 'HISTORY_CONFLICT');
        check(equal(a.capture_files.filter(f => f.capture_id === capture.request_id),
            b.capture_files.filter(f => f.capture_id === capture.request_id)), 'HISTORY_CONFLICT');
    }
    // The portable format cannot represent a file->directory transition alongside its tombstone.
    const previous = new Set(a.files.filter(f => f.hash !== null).map(f => f.file_path));
    const current = new Set(b.files.filter(f => f.hash !== null).map(f => f.file_path));
    for (const file of new Set([...previous, ...current])) {
        const parts = file.split('/'); parts.pop();
        while (parts.length) {
            const parent = parts.join('/');
            check(!(previous.has(parent) && current.has(file)) && !(current.has(parent) && previous.has(file)),
                'STRUCTURAL_CONFLICT');
            parts.pop();
        }
    }
    return { base: a, next: b };
}
// Caller owns an IMMEDIATE receiving DB transaction and a persistent closed update gate.
// Existing rows are never delete/reimported. The base is a LOCAL export frozen before hiding the project.
function applyMetadata(store, projectId, localBaseBytes, remoteBytes) {
    check(store.db.inTransaction, 'UPDATE_TRANSACTION_REQUIRED');
    const base = decode(localBaseBytes), next = decode(remoteBytes);
    assertForward(localBaseBytes, remoteBytes);
    const db = store.db;
    const ordered = rows => [...rows].sort((a, b) => a.id - b.id);
    const maps = { todos: new Map(), batches: new Map(), nodes: new Map(), captures: new Map() };
    for (const blob of next.blobs) {
        const bytes = Buffer.from(blob.base64, 'base64');
        check(store.putBlob(bytes) === blob.hash, 'HASH_MISMATCH');
        const stored = db.prepare('SELECT size,data FROM blobs WHERE hash=?').get(blob.hash);
        check(stored?.size === blob.size && Buffer.isBuffer(stored.data) &&
            stored.data.length <= 96 * 1024 * 1024, 'CORRUPT_BLOB');
        let actual;
        try { actual = zlib.gunzipSync(stored.data, { maxOutputLength: Math.max(1, blob.size) }); }
        catch { throw new SyncError('CORRUPT_BLOB', 'Invalid retained snapshot'); }
        check(actual.equals(bytes), 'CORRUPT_BLOB');
    }
    const oldTodos = new Map(base.todos.map(t => [t.seq, t]));
    for (const todo of next.todos) {
        const columns = Object.keys(todo).filter(k => k !== 'id' && k !== 'seq');
        const old = oldTodos.get(todo.seq);
        let id;
        if (old) {
            id = old.id;
            db.prepare(`UPDATE todos SET ${columns.map(k => k + '=?').join(',')} WHERE project_id=? AND id=?`)
                .run(...columns.map(k => todo[k]), projectId, id);
        } else {
            id = Number(db.prepare(`INSERT INTO todos(project_id,seq,${columns.join(',')})
                VALUES (${Array(columns.length + 2).fill('?').join(',')})`)
                .run(projectId, todo.seq, ...columns.map(k => todo[k])).lastInsertRowid);
        }
        maps.todos.set(todo.id, id);
    }
    const retained = new Set(next.todos.map(t => t.seq));
    for (const todo of base.todos) if (!retained.has(todo.seq)) db.prepare('DELETE FROM todos WHERE project_id=? AND id=?').run(projectId, todo.id);
    for (const table of ['batches', 'nodes']) {
        const previous = ordered(base[table]), incoming = ordered(next[table]);
        for (let index = 0; index < incoming.length; index++) {
            const row = incoming[index];
            if (index < previous.length) { maps[table].set(row.id, previous[index].id); continue; }
            const columns = Object.keys(row).filter(k => k !== 'id');
            const value = k => k === 'batch_id' && row[k] !== null ? maps.batches.get(row[k]) :
                k === 'todo_id' && row[k] !== null ? maps.todos.get(row[k]) : row[k];
            const id = Number(db.prepare(`INSERT INTO ${table}(project_id,${columns.join(',')})
                VALUES (${Array(columns.length + 1).fill('?').join(',')})`)
                .run(projectId, ...columns.map(value)).lastInsertRowid);
            maps[table].set(row.id, id);
        }
    }
    const oldCaptures = new Map(base.captures.map(c => [c.request_id, c]));
    for (const capture of next.captures) {
        const old = oldCaptures.get(capture.request_id), id = old?.id ?? 'c' + crypto.randomBytes(12).toString('hex');
        maps.captures.set(capture.id, id);
        if (old) continue;
        const row = { ...capture, id,
            todo_id: capture.todo_id === null ? null : maps.todos.get(capture.todo_id),
            batch_id: capture.batch_id === null ? null : maps.batches.get(capture.batch_id),
            baseline_node: capture.baseline_node === 0 ? 0 : maps.nodes.get(capture.baseline_node) };
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO captures(project_id,root,${columns.join(',')})
            VALUES (${Array(columns.length + 2).fill('?').join(',')})`)
            .run(projectId, db.prepare('SELECT root FROM projects WHERE id=?').get(projectId).root, ...columns.map(k => row[k]));
        for (const file of next.capture_files.filter(f => f.capture_id === capture.id)) db.prepare(
            'INSERT INTO capture_files(capture_id,file_path,before_hash) VALUES (?,?,?)').run(id, file.file_path, file.before_hash);
    }
    db.prepare('DELETE FROM file_state WHERE project_id=?').run(projectId);
    for (const file of next.files) db.prepare('INSERT INTO file_state VALUES (?,?,?)').run(projectId, file.file_path, file.hash);
    const columns = Object.keys(next.project).filter(k => k !== 'id');
    db.prepare(`UPDATE projects SET ${columns.map(k => k + '=?').join(',')} WHERE id=?`)
        .run(...columns.map(k => next.project[k]), projectId);
    return Object.fromEntries(Object.entries(maps).map(([name, map]) => [name, Object.fromEntries(map)]));
}
module.exports = { decode, normalize, fingerprint, assertClean, assertForward, applyMetadata };