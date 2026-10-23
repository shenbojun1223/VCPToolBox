'use strict';
// Internal library only. Workspace authorization and stopping external writers belong to the caller.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Availability = require('./projectAvailability');
const Writer = require('./projectWriteGate');
const { metadataHash } = Availability;

const FORMAT = 'projectforge-records';
const VERSION = 1;
const DEFAULT_LIMITS = Object.freeze({
    maxBundleBytes: 96 * 1024 * 1024,
    maxBlobBytes: 8 * 1024 * 1024,
    maxTotalBlobBytes: 64 * 1024 * 1024,
    maxRows: 50000,
});
const COLUMNS = {
    project: 'id name status report created_by deleted_by report_by created_at updated_at',
    todos: 'id seq title status note updated_by updated_at',
    batches: 'id kind reason maid summary created_at',
    nodes: 'id batch_id file_path op before_hash after_hash todo_id reason summary added removed created_at',
    captures: 'id request_id reason maid todo_id baseline_node status batch_id created_at finished_at',
    capture_files: 'capture_id file_path before_hash',
    files: 'file_path hash',
    blobs: 'hash size base64',
};
const HASH = /^[0-9a-f]{64}$/;
const TODO_STATES = new Set(['pending', 'doing', 'done', 'blocked']);
const NODE_OPS = new Set(['edit', 'create', 'delete', 'remove', 'move', 'rollback', 'external']);
const BATCH_KINDS = new Set(['edit', 'create', 'delete', 'remove', 'move', 'copy', 'rollback', 'external']);

class BundleError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'BundleError';
        this.code = code;
    }
}
function fail(code, message) { throw new BundleError(code, message); }
function check(condition, code, message) { if (!condition) fail(code, message); }
function limitsOf(overrides = {}) {
    check(overrides && typeof overrides === 'object' && !Array.isArray(overrides), 'INVALID_ARGUMENT', 'Invalid limits');
    const result = { ...DEFAULT_LIMITS };
    for (const [key, value] of Object.entries(overrides)) {
        check(Object.hasOwn(result, key) && Number.isSafeInteger(value) && value > 0 &&
            value <= DEFAULT_LIMITS[key], 'INVALID_ARGUMENT', 'Limits may only tighten built-in bounds');
        result[key] = value;
    }
    return result;
}
function number(value, minimum = 0) {
    check(Number.isSafeInteger(value) && value >= minimum, 'INVALID_BUNDLE', 'Invalid integer');
}
function text(value, { nullable = false, empty = true } = {}) {
    if (value === null && nullable) return;
    check(typeof value === 'string' && (empty || value.length > 0),
        'INVALID_BUNDLE', 'Invalid text field');
}
function hash(value, nullable = true) {
    check((nullable && value === null) || (typeof value === 'string' && HASH.test(value)),
        'INVALID_BUNDLE', 'Invalid SHA-256 reference');
}
function keys(row, expected) {
    check(row && typeof row === 'object' && !Array.isArray(row) &&
        Object.keys(row).sort().join('\0') === [...expected].sort().join('\0'),
        'INVALID_BUNDLE', 'Missing or unexpected fields');
}
function shape(row, name) { keys(row, COLUMNS[name].split(' ')); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function portablePath(value) {
    text(value, { empty: false });
    check(value.length <= 1024 && value === value.normalize('NFC'),
        'UNSAFE_PATH', 'Path is too long or not NFC');
    const parts = value.split('/');
    check(parts.length <= 32, 'UNSAFE_PATH', 'Path depth limit exceeded');
    for (const part of parts) {
        check(part && part !== '.' && part !== '..' && part.trim() === part &&
            !part.endsWith('.') && !/[\\<>:"|?*]/.test(part) &&
            !Array.from(part).some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127) &&
            Buffer.byteLength(part, 'utf8') <= 255 &&
            part.toLowerCase() !== '.git' &&
            !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part),
        'UNSAFE_PATH', `Nonportable path: ${value}`);
    }
    return value;
}
function pathRegistry() {
    const components = new Map();
    return value => {
        portablePath(value);
        let prefix = '';
        for (const part of value.split('/')) {
            prefix += (prefix ? '/' : '') + part;
            const folded = prefix.toLowerCase();
            check(!components.has(folded) || components.get(folded) === prefix,
                'UNSAFE_PATH', 'Case-colliding path components');
            components.set(folded, prefix);
        }
    };
}
function indexRows(rows, idKey = 'id') {
    const map = new Map();
    for (const row of rows) {
        const id = row[idKey];
        check(!map.has(id), 'INVALID_BUNDLE', 'Duplicate record identifier');
        map.set(id, row);
    }
    return map;
}
function reference(id, map, { nullable = true, zero = false } = {}) {
    if ((nullable && id === null) || (zero && id === 0)) return;
    check(map.has(id), 'DANGLING_REFERENCE', 'Reference does not resolve within this project');
}
function connection(store) {
    check(store?.db?.open && typeof store.newProjectId === 'function' &&
        typeof store.putBlob === 'function', 'INVALID_ARGUMENT', 'An open ProjectStore is required');
    check(!store.db.inTransaction, 'INVALID_ARGUMENT', 'Caller transaction is not supported');
    check(['4', '5', '6'].includes(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value),
        'SCHEMA_VERSION', 'Receiving Forge schema 4/5/6 is required; portable bundle remains schema 3');
    return store.db;
}
function readBlob(db, id, limits) {
    const row = db.prepare('SELECT size,data FROM blobs WHERE hash=?').get(id);
    check(row && Number.isSafeInteger(row.size) && row.size >= 0 &&
        row.size <= limits.maxBlobBytes && Buffer.isBuffer(row.data) &&
        row.data.length <= limits.maxBundleBytes, 'CORRUPT_BLOB', 'Missing or oversized stored blob');
    let bytes;
    try { bytes = zlib.gunzipSync(row.data, { maxOutputLength: Math.max(1, row.size) }); }
    catch { fail('CORRUPT_BLOB', 'Invalid or oversized compressed snapshot'); }
    check(bytes.length === row.size && digest(bytes) === id, 'CORRUPT_BLOB', 'Stored snapshot digest mismatch');
    return bytes;
}
function noLinks(absolute) {
    const resolved = path.resolve(absolute);
    const parsed = path.parse(resolved);
    let current = parsed.root;
    const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (const segment of segments) {
        current = path.join(current, segment);
        let stat;
        try { stat = fs.lstatSync(current); }
        catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        check(!stat.isSymbolicLink(), 'UNSAFE_PATH', 'Symlink or junction in project ancestry');
    }
}
function diskHash(root, relative, limits) {
    portablePath(relative);
    const absolute = path.join(root, ...relative.split('/'));
    noLinks(absolute);
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    check(stat.isFile() && stat.nlink === 1, 'UNSAFE_PATH', 'Expected an unlinked regular file');
    check(stat.size <= limits.maxBlobBytes, 'LIMIT_EXCEEDED', 'Disk file exceeds blob bound');
    const fd = fs.openSync(absolute, 'r');
    try {
        const opened = fs.fstatSync(fd);
        check(opened.isFile() && opened.nlink === 1 && opened.size <= limits.maxBlobBytes &&
            opened.dev === stat.dev && opened.ino === stat.ino, 'UNSAFE_PATH', 'File changed while opening');
        // Bounded read even if a concurrent writer grows the file after stat.
        const bytes = Buffer.alloc(opened.size + 1);
        let used = 0;
        while (used < bytes.length) {
            const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
            if (!count) break;
            used += count;
        }
        check(used === opened.size, 'DRIFT', 'File size changed while reading');
        return digest(bytes.subarray(0, used));
    } finally { fs.closeSync(fd); }
}

function decode(bytes, { expectedHash, limits: overrides } = {}) {
    const limits = limitsOf(overrides);
    check(Buffer.isBuffer(bytes) && bytes.length <= limits.maxBundleBytes,
        'LIMIT_EXCEEDED', 'Expected a bounded Buffer');
    const sha256 = digest(bytes);
    if (expectedHash !== undefined) {
        hash(expectedHash, false);
        check(sha256 === expectedHash, 'HASH_MISMATCH', 'Bundle digest does not match trusted reference');
    }
    let data;
    try {
        const string = bytes.toString('utf8');
        check(Buffer.from(string, 'utf8').equals(bytes), 'INVALID_BUNDLE', 'Noncanonical UTF-8');
        data = JSON.parse(string);
    } catch (error) {
        if (error instanceof BundleError) throw error;
        fail('INVALID_BUNDLE', 'Invalid bundle JSON');
    }
    keys(data, ['format', 'version', 'schema', 'project', 'todos', 'batches', 'nodes',
        'captures', 'capture_files', 'files', 'blobs']);
    check(data.format === FORMAT && data.version === VERSION && data.schema === 3,
        'SCHEMA_VERSION', 'Unsupported bundle version');
    shape(data.project, 'project');
    text(data.project.id, { empty: false });
    text(data.project.name, { empty: false });
    check(['active', 'review', 'accepted'].includes(data.project.status), 'INVALID_BUNDLE', 'Invalid project status');
    for (const key of ['report', 'created_by', 'deleted_by', 'report_by']) text(data.project[key], { nullable: true });
    for (const key of ['created_at', 'updated_at']) text(data.project[key], { empty: false });
    let rowCount = 0;
    for (const table of ['todos', 'batches', 'nodes', 'captures', 'capture_files', 'files', 'blobs']) {
        check(Array.isArray(data[table]), 'INVALID_BUNDLE', 'Missing record array');
        rowCount += data[table].length;
        check(rowCount <= limits.maxRows, 'LIMIT_EXCEEDED', 'Record count bound exceeded');
        for (const row of data[table]) shape(row, table);
    }
    const paths = pathRegistry();
    const sequences = new Set();
    for (const row of data.todos) {
        number(row.id, 1); number(row.seq, 1);
        check(!sequences.has(row.seq), 'INVALID_BUNDLE', 'Duplicate Todo sequence');
        sequences.add(row.seq);
        text(row.title, { empty: false }); text(row.note, { nullable: true });
        text(row.updated_by, { nullable: true }); text(row.updated_at, { empty: false });
        check(TODO_STATES.has(row.status), 'INVALID_BUNDLE', 'Invalid Todo status');
    }
    const todos = indexRows(data.todos);
    for (const row of data.batches) {
        number(row.id, 1);
        check(BATCH_KINDS.has(row.kind), 'INVALID_BUNDLE', 'Unknown batch kind');
        for (const key of ['reason', 'maid', 'summary']) text(row[key], { nullable: true });
        text(row.created_at, { empty: false });
    }
    const batches = indexRows(data.batches);
    let previousId = 0;
    const lastNodes = new Map();
    const needed = new Set();
    const addHash = id => { hash(id); if (id !== null) needed.add(id); };
    for (const row of data.nodes) {
        number(row.id, 1);
        check(row.id > previousId, 'INVALID_BUNDLE', 'Nodes must be in strict chronological ID order');
        previousId = row.id;
        if (row.batch_id !== null) number(row.batch_id, 1);
        if (row.todo_id !== null) number(row.todo_id, 1);
        reference(row.batch_id, batches); reference(row.todo_id, todos);
        check(NODE_OPS.has(row.op), 'INVALID_BUNDLE', 'Unknown node operation');
        paths(row.file_path); addHash(row.before_hash); addHash(row.after_hash);
        check(!lastNodes.has(row.file_path) || lastNodes.get(row.file_path) === row.before_hash,
            'INVALID_BUNDLE', 'File history has a discontinuous snapshot chain');
        for (const key of ['reason', 'summary']) text(row[key], { nullable: true });
        text(row.created_at, { empty: false }); number(row.added); number(row.removed);
        lastNodes.set(row.file_path, row.after_hash);
    }
    const nodes = indexRows(data.nodes);
    const requests = new Set();
    for (const row of data.captures) {
        text(row.id, { empty: false }); text(row.request_id, { empty: false });
        check(!requests.has(row.request_id), 'INVALID_BUNDLE', 'Duplicate capture request');
        requests.add(row.request_id);
        check(row.status === 'finished', 'OPEN_CAPTURE', 'Unfinished captures are not portable');
        text(row.reason, { empty: false }); text(row.maid, { nullable: true });
        text(row.created_at, { empty: false }); text(row.finished_at, { empty: false });
        if (row.todo_id !== null) number(row.todo_id, 1);
        if (row.batch_id !== null) number(row.batch_id, 1);
        number(row.baseline_node);
        reference(row.todo_id, todos); reference(row.batch_id, batches);
        reference(row.baseline_node, nodes, { nullable: false, zero: true });
    }
    const captures = indexRows(data.captures);
    const captureFiles = new Set();
    for (const row of data.capture_files) {
        reference(row.capture_id, captures, { nullable: false });
        paths(row.file_path); addHash(row.before_hash);
        const key = JSON.stringify([row.capture_id, row.file_path]);
        check(!captureFiles.has(key), 'INVALID_BUNDLE', 'Duplicate capture file');
        captureFiles.add(key);
    }
    const files = indexRows(data.files, 'file_path');
    for (const row of data.files) { paths(row.file_path); addHash(row.hash); }
    for (const [file, id] of lastNodes) {
        check(files.has(file) && files.get(file).hash === id, 'INVALID_BUNDLE', 'Latest file state disagrees with history');
    }
    for (const row of data.capture_files) {
        check(files.has(row.file_path), 'INVALID_BUNDLE', 'Capture-only current state is missing');
    }
    const present = new Set(data.files.filter(row => row.hash !== null).map(row => row.file_path));
    for (const file of present) {
        const parts = file.split('/');
        parts.pop();
        while (parts.length) {
            check(!present.has(parts.join('/')), 'UNSAFE_PATH', 'A current file is also a parent directory');
            parts.pop();
        }
    }
    const buffers = new Map();
    let totalBytes = 0;
    for (const row of data.blobs) {
        hash(row.hash, false); number(row.size);
        check(row.size <= limits.maxBlobBytes, 'LIMIT_EXCEEDED', 'Blob size bound exceeded');
        totalBytes += row.size;
        check(totalBytes <= limits.maxTotalBlobBytes, 'LIMIT_EXCEEDED', 'Total blob bound exceeded');
        check(!buffers.has(row.hash) && needed.has(row.hash), 'INVALID_BUNDLE', 'Duplicate or unreferenced blob');
        check(typeof row.base64 === 'string' && row.base64.length === 4 * Math.ceil(row.size / 3),
            'INVALID_BUNDLE', 'Invalid base64 length');
        const buffer = Buffer.from(row.base64, 'base64');
        check(buffer.length === row.size && buffer.toString('base64') === row.base64 &&
            digest(buffer) === row.hash, 'HASH_MISMATCH', 'Snapshot bytes or digest mismatch');
        buffers.set(row.hash, buffer);
    }
    check(buffers.size === needed.size, 'DANGLING_REFERENCE', 'Referenced snapshot is absent');
    return { data, buffers, sha256, limits, totalBytes };
}

function exportProjectBundle(store, projectId, { limits: overrides } = {}) {
    const limits = limitsOf(overrides);
    const db = connection(store);
    text(projectId, { empty: false });
    return db.transaction(() => {
        const project = store.getProject(projectId);
        check(project, 'NOT_FOUND', 'Unknown, unavailable or deleted project');
        Availability.assertPathAvailable(db, project.root);
        const open = db.prepare("SELECT 1 FROM captures WHERE project_id=? AND status!='finished' LIMIT 1").get(projectId);
        check(!open, 'OPEN_CAPTURE', 'Finish all captures before exporting');
        check(path.isAbsolute(project.root), 'UNSAFE_PATH', 'Project root must be explicit and absolute');
        noLinks(project.root);
        check(fs.statSync(project.root).isDirectory(), 'UNSAFE_PATH', 'Project root must be a directory');
        const pick = (row, table) => Object.fromEntries(COLUMNS[table].split(' ').map(key => [key, row[key]]));
        const data = { format: FORMAT, version: VERSION, schema: 3, project: pick(project, 'project') };
        for (const table of ['todos', 'batches', 'nodes', 'captures']) {
            data[table] = db.prepare(`SELECT * FROM ${table} WHERE project_id=? ORDER BY id LIMIT ?`)
                .all(projectId, limits.maxRows + 1).map(row => pick(row, table));
        }
        data.capture_files = db.prepare(`SELECT f.* FROM capture_files f JOIN captures c ON c.id=f.capture_id
            WHERE c.project_id=? ORDER BY c.created_at,c.id,f.file_path LIMIT ?`)
            .all(projectId, limits.maxRows + 1).map(row => pick(row, 'capture_files'));
        data.files = db.prepare('SELECT file_path,hash FROM file_state WHERE project_id=? ORDER BY file_path LIMIT ?')
            .all(projectId, limits.maxRows + 1);
        const files = new Map(data.files.map(row => [row.file_path, row]));
        // Finished no-change captures may own the only snapshot of an otherwise unseen file.
        // Capture IDs are random, not chronological. Equal-time conflicting snapshots are ambiguous.
        const captureIndex = new Map(data.captures.map(row => [row.id, row]));
        const captureOnly = new Map();
        for (const row of data.capture_files) {
            if (files.has(row.file_path)) continue;
            const capture = captureIndex.get(row.capture_id);
            check(capture, 'DANGLING_REFERENCE', 'Capture file has no owning capture');
            const previous = captureOnly.get(row.file_path);
            if (previous && previous.createdAt === capture.created_at) {
                check(previous.hash === row.before_hash, 'AMBIGUOUS_STATE',
                    'Equal-time capture-only snapshots disagree');
            }
            if (!previous || previous.createdAt < capture.created_at) {
                captureOnly.set(row.file_path, { hash: row.before_hash, createdAt: capture.created_at });
            }
        }
        for (const [file, state] of captureOnly) files.set(file, { file_path: file, hash: state.hash });
        data.files = [...files.values()].sort((a, b) => a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0);
        const rowCount = ['todos', 'batches', 'nodes', 'captures', 'capture_files', 'files']
            .reduce((sum, table) => sum + data[table].length, 0);
        check(rowCount <= limits.maxRows, 'LIMIT_EXCEEDED', 'Record count bound exceeded');
        const needed = new Set();
        for (const row of data.nodes) for (const id of [row.before_hash, row.after_hash]) if (id !== null) needed.add(id);
        for (const row of data.capture_files) if (row.before_hash !== null) needed.add(row.before_hash);
        for (const row of data.files) if (row.hash !== null) needed.add(row.hash);
        check(rowCount + needed.size <= limits.maxRows, 'LIMIT_EXCEEDED', 'Blob count bound exceeded');
        let total = 0;
        data.blobs = [...needed].sort().map(id => {
            hash(id, false);
            const row = db.prepare('SELECT size FROM blobs WHERE hash=?').get(id);
            check(row && Number.isSafeInteger(row.size) && row.size >= 0, 'CORRUPT_BLOB', 'Missing stored snapshot');
            total += row.size;
            check(total <= limits.maxTotalBlobBytes, 'LIMIT_EXCEEDED', 'Total snapshot bound exceeded');
            const buffer = readBlob(db, id, limits);
            return { hash: id, size: buffer.length, base64: buffer.toString('base64') };
        });
        const bytes = Buffer.from(JSON.stringify(data), 'utf8');
        const verified = decode(bytes, { limits });
        // No awaits: DB read snapshot and both disk checks execute under one write reservation.
        // External filesystem writers must still be stopped by the caller; this is not a sandbox.
        for (let pass = 0; pass < 2; pass++) {
            for (const row of data.files) {
                check(diskHash(project.root, row.file_path, limits) === row.hash,
                    'DRIFT', `Unarchived disk drift: ${row.file_path}`);
            }
        }
        return { bytes, sha256: verified.sha256 };
    }).immediate();
}

function validateProjectBundle(bytes, options) {
    const result = decode(bytes, options);
    return {
        sha256: result.sha256, sourceProjectId: result.data.project.id,
        files: result.data.files.length, snapshots: result.buffers.size,
        snapshotBytes: result.totalBytes, nodes: result.data.nodes.length,
        captures: result.data.captures.length,
    };
}

// Internal plan reader; publication identity and access authorization belong
// to the Hub adapter. Never expose decoded blobs, paths or import machinery.
// This verifies the full checkpoint before returning a detached projection.
function readProjectPlanBundle(bytes, options) {
    const { data, sha256 } = decode(bytes, options);
    const p = data.project;
    return {
        sha256,
        project: {
            id: p.id,
            name: p.name,
            status: p.status,
            created_at: p.created_at,
            updated_at: p.updated_at,
        },
        todos: data.todos.map(t => ({
            seq: t.seq,
            title: t.title,
            status: t.status,
            note: t.note,
            updated_by: t.updated_by,
            updated_at: t.updated_at,
        })),
    };
}

function normalizeImportTarget(target) {
    check(target && typeof target === 'object' && !Array.isArray(target), 'INVALID_ARGUMENT', 'Explicit local target required');
    check(typeof target.root === 'string' && path.isAbsolute(target.root) &&
        path.resolve(target.root) !== path.parse(path.resolve(target.root)).root,
    'INVALID_ARGUMENT', 'Explicit non-volume-root local destination required');
    check(typeof target.workspaceAlias === 'string' && target.workspaceAlias.trim(),
        'INVALID_ARGUMENT', 'Local workspace alias required');
    check(target.workspaceId === undefined || target.workspaceId === null || typeof target.workspaceId === 'string',
        'INVALID_ARGUMENT', 'Invalid workspace ID');
    const subpath = target.subpath ?? '';
    check(typeof subpath === 'string', 'INVALID_ARGUMENT', 'Invalid local subpath');
    if (subpath) portablePath(subpath);
    return {
        root: path.resolve(target.root), workspaceId: target.workspaceId ?? null,
        workspaceAlias: target.workspaceAlias, subpath,
    };
}

function assertImportDestination(db, root) {
    Availability.assertPathAvailable(db, root);
    noLinks(root);
    let absent = false;
    try { fs.lstatSync(root); } catch (error) { if (error.code === 'ENOENT') absent = true; else throw error; }
    check(absent, 'DESTINATION_EXISTS', 'Metadata copy requires an absent worktree destination');
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    check(!db.prepare('SELECT root FROM projects').all().some(row => key(row.root) === key(root)),
        'DESTINATION_EXISTS', 'Destination already belongs to a local project');
}

// Caller must own the outer IMMEDIATE transaction. Not exported as a transaction bypass.
function insertImportedProject(store, decoded, target, availability = 'ready') {
    const { data, buffers, limits } = decoded;
    const db = store.db;
    for (const [id, buffer] of buffers) {
        const existing = db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(id);
        if (existing) check(readBlob(db, id, limits).equals(buffer), 'CORRUPT_BLOB', 'Destination snapshot mismatch');
        else check(store.putBlob(buffer) === id, 'HASH_MISMATCH', 'Stored snapshot hash changed');
    }
    const projectId = store.newProjectId();
    db.prepare(`INSERT INTO projects
        (id,name,workspace_id,workspace_alias,root,subpath,status,report,created_by,deleted_by,report_by,created_at,updated_at,availability)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(projectId, data.project.name, target.workspaceId,
        target.workspaceAlias, target.root, target.subpath, data.project.status, data.project.report,
        data.project.created_by, data.project.deleted_by, data.project.report_by,
        data.project.created_at, data.project.updated_at, availability);
    const maps = { todos: new Map(), batches: new Map(), nodes: new Map(), captures: new Map() };
    const insertNumeric = (table, rows) => {
        const columns = COLUMNS[table].split(' ').filter(key => key !== 'id');
        const statement = db.prepare(`INSERT INTO ${table}(project_id,${columns.join(',')})
            VALUES (${['project_id', ...columns].map(() => '?').join(',')})`);
        for (const row of rows) {
            const id = Number(statement.run(projectId, ...columns.map(key => row[key])).lastInsertRowid);
            maps[table].set(row.id, id);
        }
    };
    insertNumeric('todos', data.todos);
    insertNumeric('batches', [...data.batches].sort((a, b) => a.id - b.id));
    const mapped = (map, id) => id === null ? null : map.get(id);
    insertNumeric('nodes', data.nodes.map(row => ({
        ...row, batch_id: mapped(maps.batches, row.batch_id), todo_id: mapped(maps.todos, row.todo_id),
    })));
    const captureInsert = db.prepare(`INSERT INTO captures
        (id,project_id,request_id,root,reason,maid,todo_id,baseline_node,status,batch_id,created_at,finished_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of data.captures) {
        const id = `c${crypto.randomBytes(12).toString('hex')}`;
        maps.captures.set(row.id, id);
        captureInsert.run(id, projectId, row.request_id, target.root, row.reason, row.maid,
            mapped(maps.todos, row.todo_id), row.baseline_node === 0 ? 0 : maps.nodes.get(row.baseline_node),
            'finished', mapped(maps.batches, row.batch_id), row.created_at, row.finished_at);
    }
    const captureFileInsert = db.prepare('INSERT INTO capture_files(capture_id,file_path,before_hash) VALUES (?,?,?)');
    for (const row of data.capture_files) {
        captureFileInsert.run(maps.captures.get(row.capture_id), row.file_path, row.before_hash);
    }
    const fileInsert = db.prepare('INSERT INTO file_state(project_id,file_path,hash) VALUES (?,?,?)');
    for (const row of data.files) fileInsert.run(projectId, row.file_path, row.hash);
    return {
        projectId, sourceProjectId: data.project.id, sha256: decoded.sha256,
        requiresMaterialization: true,
        idMap: Object.fromEntries(Object.entries(maps).map(([key, map]) => [key, Object.fromEntries(map)])),
    };
}

function importProjectBundle(store, bytes, target, options) {
    const decoded = decode(bytes, options);
    const db = connection(store);
    const local = normalizeImportTarget(target);
    return db.transaction(() => {
        assertImportDestination(db, local.root);
        Writer.assertRootFree(store, local.root);
        return insertImportedProject(store, decoded, local);
    }).immediate();
}

// Opt-in receipt extension; ordinary bundle import does not create it.
const RECEIPT_VERSION = Availability.RECEIPT_VERSION;

function importRequest(value) {
    check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
        'INVALID_ARGUMENT', 'Bounded import requestId required');
}
function publicationOf(value) {
    check(value && typeof value === 'object', 'INVALID_ARGUMENT', 'Publication binding required');
    for (const key of ['journalId', 'jobId']) importRequest(value[key]);
    check(typeof value.journalPath === 'string' && path.isAbsolute(value.journalPath),
        'INVALID_ARGUMENT', 'Absolute publication journal path required');
    return { journalId: value.journalId, journalPath: path.resolve(value.journalPath), jobId: value.jobId };
}
function receiptConnection(store) {
    const db = connection(store);
    check(db.prepare("SELECT value FROM meta WHERE key='project_import_receipts_version'").get()?.value === RECEIPT_VERSION,
        'SCHEMA_VERSION', 'Initialize the import receipt extension explicitly');
    return db;
}

function initializeProjectImports(store) {
    const db = connection(store);
    return db.transaction(() => Availability.initializeReceipts(db)).immediate();
}

function receiptView(row) {
    return {
        requestId: row.request_id, bundleHash: row.bundle_hash, projectId: row.original_project_id,
        state: row.state, target: JSON.parse(row.target_json), publication: JSON.parse(row.publication_json),
        result: JSON.parse(row.result_json), completedAt: row.completed_at, purgedAt: row.purged_at,
        // Recorded state only. Coordinator must revalidate published bytes before reporting verified completion.
        filesystemVerified: false,
    };
}
function findReceipt(db, requestId) {
    return db.prepare('SELECT * FROM project_import_receipts WHERE request_id=?').get(requestId);
}
function assertReceipt(row, decoded, target, publication) {
    check(row.bundle_hash === decoded.sha256 && row.target_json === JSON.stringify(target) &&
        row.publication_json === JSON.stringify(publication), 'REQUEST_CONFLICT', 'Import request or publication binding changed');
}
function assertImportedState(db, row, decoded) {
    check(row.state !== 'purged', 'IMPORT_PURGED', 'Import was purged; request identity is retained');
    check(metadataHash(db, row.project_id) === row.metadata_hash, 'IMPORT_DRIFT', 'Imported metadata changed');
    const project = db.prepare('SELECT availability,deleted_at,deleted_by FROM projects WHERE id=?').get(row.project_id);
    check(project.deleted_at === null && project.deleted_by === row.source_deleted_by,
        'IMPORT_DRIFT', 'Imported deletion state changed');
    check((row.state === 'pending' && project.availability === 'pending') ||
        (row.state === 'complete' && project.availability === 'ready'),
    'IMPORT_DRIFT', 'Imported availability changed');
    for (const [id, buffer] of decoded.buffers) {
        check(readBlob(db, id, decoded.limits).equals(buffer), 'CORRUPT_BLOB', 'Imported snapshot changed');
    }
}
function getProjectImportReceipt(store, requestId) {
    importRequest(requestId);
    const row = findReceipt(receiptConnection(store), requestId);
    return row ? receiptView(row) : null;
}

function importProjectBundleOnce(store, bytes, target, {
    requestId, publication, expectedHash, _testHook = null,
} = {}) {
    importRequest(requestId);
    hash(expectedHash, false);
    check(_testHook === null || typeof _testHook === 'function', 'INVALID_ARGUMENT', 'Invalid test hook');
    const decoded = decode(bytes, { expectedHash });
    const local = normalizeImportTarget(target);
    const binding = publicationOf(publication);
    const db = receiptConnection(store);
    return db.transaction(() => {
        const previous = findReceipt(db, requestId);
        if (previous) {
            assertReceipt(previous, decoded, local, binding);
            assertImportedState(db, previous, decoded);
            return receiptView(previous);
        }
        assertImportDestination(db, local.root);
        Writer.assertRootFree(store, local.root);
        Availability.assertExclusiveImportRoot(db, local.root);
        const result = insertImportedProject(store, decoded, local, 'pending');
        const pendingAt = new Date().toISOString();
        db.prepare(`INSERT INTO project_import_receipts
            (request_id,bundle_hash,target_json,destination_key,publication_json,project_id,original_project_id,state,
             result_json,metadata_hash,pending_at,source_deleted_by)
            VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(requestId, decoded.sha256,
            JSON.stringify(local), process.platform === 'win32' ? local.root.toLowerCase() : local.root,
            JSON.stringify(binding), result.projectId, result.projectId, JSON.stringify(result),
            metadataHash(db, result.projectId), pendingAt, decoded.data.project.deleted_by);
        if (_testHook) _testHook('import-before-commit', { projectId: result.projectId, requestId });
        return receiptView(findReceipt(db, requestId));
    }).immediate();
}

// Internal completion gate: caller MUST verify the bound publication before invoking.
function completeProjectImport(store, bytes, {
    requestId, publication, expectedHash, _testHook = null,
} = {}) {
    importRequest(requestId);
    hash(expectedHash, false);
    check(_testHook === null || typeof _testHook === 'function', 'INVALID_ARGUMENT', 'Invalid test hook');
    const decoded = decode(bytes, { expectedHash });
    const binding = publicationOf(publication);
    const db = receiptConnection(store);
    return db.transaction(() => {
        const row = findReceipt(db, requestId);
        check(row, 'NOT_FOUND', 'No imported receipt to complete');
        assertReceipt(row, decoded, JSON.parse(row.target_json), binding);
        assertImportedState(db, row, decoded);
        if (row.state === 'complete') return receiptView(row);
        db.prepare("UPDATE projects SET availability='ready' WHERE id=?").run(row.project_id);
        db.prepare("UPDATE project_import_receipts SET state='complete',completed_at=? WHERE request_id=?")
            .run(new Date().toISOString(), requestId);
        if (_testHook) _testHook('complete-before-commit', { projectId: row.project_id, requestId });
        return receiptView(findReceipt(db, requestId));
    }).immediate();
}

module.exports = {
    exportProjectBundle, validateProjectBundle, readProjectPlanBundle, importProjectBundle, BundleError, DEFAULT_LIMITS,
    initializeProjectImports, getProjectImportReceipt, importProjectBundleOnce, completeProjectImport,
};