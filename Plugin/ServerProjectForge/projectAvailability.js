'use strict';
// Local availability is independent of soft deletion. No ordinary API can opt into pending.
// The raw SQLite handle and internal publication completion gate remain trusted capabilities.
const crypto = require('node:crypto');
const path = require('node:path');
const Writer = require('./projectWriteGate');
const RECEIPT_VERSION = '2';
const RECEIPT_COLUMNS = 'request_id bundle_hash target_json destination_key publication_json project_id original_project_id state result_json metadata_hash pending_at source_deleted_by completed_at purged_at';
const LEGACY_COLUMNS = 'request_id bundle_hash target_json destination_key publication_json project_id state result_json metadata_hash pending_at source_deleted_by completed_at';
const RECEIPT_SCHEMA = `CREATE TABLE project_import_receipts(
    request_id TEXT PRIMARY KEY,
    bundle_hash TEXT NOT NULL,
    target_json TEXT NOT NULL,
    destination_key TEXT NOT NULL UNIQUE,
    publication_json TEXT NOT NULL,
    project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE SET NULL,
    original_project_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('pending','complete','purged')),
    result_json TEXT NOT NULL,
    metadata_hash TEXT NOT NULL,
    pending_at TEXT NOT NULL,
    source_deleted_by TEXT,
    completed_at TEXT,
    purged_at TEXT
)`;
class AvailabilityError extends Error {
    constructor(code, message) { super(message); this.name = 'AvailabilityError'; this.code = code; }
}
function check(ok, code, message) { if (!ok) throw new AvailabilityError(code, message); }
function hasReceipts(db) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_import_receipts'").get());
}
function metadataHash(db, projectId) {
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    check(project, 'IMPORT_DRIFT', 'Imported project was removed');
    const metadata = { ...project };
    delete metadata.deleted_at;
    delete metadata.deleted_by;
    delete metadata.availability;
    const records = { project: metadata };
    for (const table of ['todos', 'batches', 'nodes', 'captures']) {
        records[table] = db.prepare(`SELECT * FROM ${table} WHERE project_id=? ORDER BY id`).all(projectId);
    }
    records.capture_files = db.prepare(`SELECT f.* FROM capture_files f JOIN captures c ON c.id=f.capture_id
        WHERE c.project_id=? ORDER BY f.capture_id,f.file_path`).all(projectId);
    records.files = db.prepare('SELECT * FROM file_state WHERE project_id=? ORDER BY file_path').all(projectId);
    return crypto.createHash('sha256').update(JSON.stringify(records), 'utf8').digest('hex');
}
function updatePending(db, projectId) {
    return db.prepare('SELECT value FROM meta WHERE key=?').get('project_update:' + projectId)?.value || null;
}
function validateUpdates(db) {
    const version = db.prepare("SELECT value FROM meta WHERE key='project_updates_version'").get()?.value;
    const markers = db.prepare("SELECT key,value FROM meta WHERE key LIKE 'project_update:%'").all();
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_update_jobs'").get();
    check((version === undefined && !table && markers.length === 0) || (version === '1' && table),
        'SCHEMA_VERSION', 'Invalid update extension');
    if (!table) return;
    const jobs = db.prepare("SELECT request_id,project_id FROM project_update_jobs WHERE state!='complete'").all();
    check(jobs.length === markers.length, 'UPDATE_GATE_DRIFT', 'Update marker count mismatch');
    for (const job of jobs) {
        check(updatePending(db, job.project_id) === job.request_id &&
            db.prepare('SELECT 1 FROM projects WHERE id=?').get(job.project_id),
        'UPDATE_GATE_DRIFT', 'Update journal or project missing');
    }
}
function assertAvailable(db, projectId) {
    check(!updatePending(db, projectId), 'PROJECT_UPDATING', 'Project checkpoint update is incomplete');
    const row = db.prepare('SELECT availability FROM projects WHERE id=?').get(projectId);
    check(!row || row.availability === 'ready', 'PROJECT_UNAVAILABLE',
        'Project is pending publication; ordinary access is blocked');
}
function pathsOverlap(left, right) {
    const inside = (root, value) => {
        const relative = path.relative(path.resolve(root), path.resolve(value));
        return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    };
    return inside(left, right) || inside(right, left);
}
function assertPathAvailable(db, root) {
    const pending = db.prepare(`SELECT root FROM projects WHERE availability='pending' OR
        EXISTS(SELECT 1 FROM meta WHERE key='project_update:'||projects.id)`).all();
    check(!pending.some(row => pathsOverlap(row.root, root)), 'PROJECT_UNAVAILABLE',
        'Path overlaps a pending publication in this receiving store');
}
function assertExclusiveImportRoot(db, root) {
    assertPathAvailable(db, root);
    check(!db.prepare('SELECT root FROM projects').all().some(row => pathsOverlap(row.root, root)),
        'DESTINATION_EXISTS', 'Takeover destination overlaps another local project');
}
function assertReceiptSchema(db, version) {
    const columns = db.prepare('PRAGMA table_info(project_import_receipts)').all().map(row => row.name).join(' ');
    const fk = db.prepare('PRAGMA foreign_key_list(project_import_receipts)').all();
    check(columns === (version === '1' ? LEGACY_COLUMNS : RECEIPT_COLUMNS) &&
        fk.length === 1 && fk[0].table === 'projects' && fk[0].from === 'project_id' &&
        fk[0].on_delete === (version === '1' ? 'RESTRICT' : 'SET NULL'),
    'SCHEMA_VERSION', 'Unexpected import receipt schema');
}
function installPurgeTriggers(db) {
    // Preserve request identity even if an internal SQL deletion bypasses ProjectStore.purgeProjects.
    db.exec(`CREATE TRIGGER IF NOT EXISTS pf_import_pending_delete
        BEFORE DELETE ON projects WHEN OLD.availability != 'ready'
        BEGIN SELECT RAISE(ABORT,'PROJECT_UNAVAILABLE'); END;
        CREATE TRIGGER IF NOT EXISTS pf_import_purge_receipt
        BEFORE DELETE ON projects WHEN OLD.availability = 'ready'
        BEGIN
            UPDATE project_import_receipts SET state='purged',project_id=NULL,
                purged_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE project_id=OLD.id AND state='complete';
        END;`);
}
function validateReceiptRows(db) {
    for (const row of db.prepare('SELECT * FROM project_import_receipts').all()) {
        const project = row.project_id === null ? null : db.prepare('SELECT availability FROM projects WHERE id=?').get(row.project_id);
        check((row.state === 'purged' && row.project_id === null && row.purged_at !== null) ||
            (row.state === 'pending' && project?.availability === 'pending' && row.project_id === row.original_project_id) ||
            (row.state === 'complete' && project?.availability === 'ready' && row.project_id === row.original_project_id),
        'IMPORT_DRIFT', 'Receipt identity or project availability is inconsistent');
    }
}
// Must execute inside the constructor's schema transaction, BEFORE ordinary access is possible.
function migrateExistingReceipts(db) {
    validateUpdates(db);
    const version = db.prepare("SELECT value FROM meta WHERE key='project_import_receipts_version'").get()?.value;
    if (!hasReceipts(db)) {
        check(version === undefined, 'SCHEMA_VERSION', 'Receipt version exists without table');
        check(!db.prepare("SELECT 1 FROM projects WHERE availability='pending' LIMIT 1").get(),
            'IMPORT_DRIFT', 'Pending project has no receipt extension');
        return;
    }
    check(version === '1' || version === RECEIPT_VERSION, 'SCHEMA_VERSION', 'Unsupported receipt version');
    assertReceiptSchema(db, version);
    if (version === '1') {
        const rows = db.prepare('SELECT * FROM project_import_receipts ORDER BY request_id').all();
        for (const row of rows) {
            const project = db.prepare('SELECT * FROM projects WHERE id=?').get(row.project_id);
            check(project && ['pending', 'complete'].includes(row.state), 'IMPORT_DRIFT', 'Legacy receipt has no project');
            if (row.state === 'pending') {
                check(project.deleted_at === row.pending_at && project.deleted_by === 'takeover:' + row.request_id &&
                    metadataHash(db, row.project_id) === row.metadata_hash,
                'IMPORT_DRIFT', 'Legacy pending import is not intact; migration refused');
            }
        }
        db.exec('ALTER TABLE project_import_receipts RENAME TO pf_legacy_import_receipts');
        db.exec(RECEIPT_SCHEMA);
        const insert = db.prepare(`INSERT INTO project_import_receipts(${RECEIPT_COLUMNS.split(' ').join(',')})
            VALUES (${RECEIPT_COLUMNS.split(' ').map(() => '?').join(',')})`);
        for (const row of rows) {
            if (row.state === 'pending') {
                db.prepare("UPDATE projects SET availability='pending',deleted_at=NULL,deleted_by=? WHERE id=?")
                    .run(row.source_deleted_by, row.project_id);
            }
            const next = { ...row, original_project_id: row.project_id, purged_at: null };
            insert.run(...RECEIPT_COLUMNS.split(' ').map(key => next[key]));
        }
        db.exec('DROP TABLE pf_legacy_import_receipts');
        db.prepare("UPDATE meta SET value=? WHERE key='project_import_receipts_version'").run(RECEIPT_VERSION);
    }
    const id = db.prepare("SELECT value FROM meta WHERE key='project_import_store_id'").get()?.value;
    check(typeof id === 'string' && /^i_[0-9a-f-]{36}$/.test(id), 'SCHEMA_VERSION', 'Invalid receiving store identity');
    validateReceiptRows(db);
    check(!db.prepare(`SELECT 1 FROM projects p WHERE p.availability='pending' AND NOT EXISTS(
        SELECT 1 FROM project_import_receipts r WHERE r.project_id=p.id AND r.state='pending') LIMIT 1`).get(),
    'IMPORT_DRIFT', 'Orphan pending project has no import receipt');
    installPurgeTriggers(db);
}
function initializeReceipts(db) {
    if (!hasReceipts(db)) {
        check(!db.prepare("SELECT 1 FROM meta WHERE key='project_import_receipts_version'").get(),
            'SCHEMA_VERSION', 'Receipt version exists without table');
        db.exec(RECEIPT_SCHEMA);
        db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('project_import_receipts_version', RECEIPT_VERSION);
        db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('project_import_store_id', 'i_' + crypto.randomUUID());
    }
    migrateExistingReceipts(db);
    return db.prepare("SELECT value FROM meta WHERE key='project_import_store_id'").get().value;
}
function reservedProjectId(db, id) {
    return hasReceipts(db) && Boolean(db.prepare(
        'SELECT 1 FROM project_import_receipts WHERE original_project_id=?').get(id));
}
function installStoreGuards(Store) {
    const reads = [
        'listTodos', 'getTodoBySeq', 'getFileState', 'getCapture', 'captureByRequest',
        'getBatch', 'getNode', 'getBatchNodes', 'nodesAfter', 'fileHashAt', 'lastBatch',
        'timeline', 'projectStats', 'contributors', 'changedFiles',
    ];
    const writes = [
        'updateProject', 'touchProject', 'addTodos', 'updateTodo', 'removeTodo',
        'setFileState', 'finishCapture', 'createBatch',
    ];
    for (const name of [...reads, ...writes, 'createCapture', 'addNode',
        'softDeleteProjects', 'restoreProjects', 'purgeProjects', 'createProject']) {
        const original = Store.prototype[name];
        check(typeof original === 'function', 'SCHEMA_VERSION', 'Missing guarded method: ' + name);
        Store.prototype[name] = function (...args) {
            const run = () => {
                const ids = ['softDeleteProjects', 'restoreProjects', 'purgeProjects'].includes(name) ? args[0] :
                    name === 'createProject' ? [] :
                    [name === 'createCapture' || name === 'addNode' ? args[0].projectId : args[0]];
                if (name === 'createProject') {
                    assertPathAvailable(this.db, args[0].root);
                    Writer.assertRootFree(this, args[0].root);
                }
                if (name === 'updateProject' && Object.hasOwn(args[1], 'root')) {
                    assertPathAvailable(this.db, args[1].root);
                    Writer.assertRootFree(this, args[1].root, args[0]);
                }
                for (const id of ids) {
                    assertAvailable(this.db, id);
                    if (!reads.includes(name)) {
                        Writer.assertWrite(this, id);
                        if (Writer.binding(this, id) && (
                            ['softDeleteProjects', 'restoreProjects', 'purgeProjects'].includes(name) ||
                            (name === 'updateProject' && ['root', 'workspaceId', 'workspaceAlias', 'workspace_id', 'workspace_alias', 'subpath', 'deletedAt', 'deleted_at'].some(k => Object.hasOwn(args[1], k)))
                        )) throw new Writer.WriteGateError('WRITE_BINDING');
                        const project = this.db.prepare('SELECT root FROM projects WHERE id=?').get(id);
                        if (project) Writer.assertPath(this, id, project.root);
                    }
                }
                const result = original.apply(this, args);
                if (!reads.includes(name)) Writer.changed(this, ids);
                return result;
            };
            // Guard and mutation share the reservation; preflight ALL IDs before any bulk write.
            const transaction = this.db.transaction(run);
            return reads.includes(name) ? transaction() : transaction.immediate();
        };
    }
}
module.exports = {
    AvailabilityError, RECEIPT_VERSION, metadataHash, assertAvailable,
    migrateExistingReceipts, initializeReceipts, reservedProjectId, installStoreGuards,
    assertPathAvailable, assertExclusiveImportRoot, updatePending,
};