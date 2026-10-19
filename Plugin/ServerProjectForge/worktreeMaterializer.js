'use strict';
// Internal protocol for trusted local Windows filesystems and cooperative writers.
// No Forge metadata import, workspace authorization, cross-journal locking or power-loss guarantee.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { validateProjectBundle } = require('./projectBundle');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const TABLES = ['materialize_attempts', 'materialize_jobs', 'materialize_meta'];
const SCHEMA = `
CREATE TABLE materialize_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO materialize_meta VALUES('version','1');
CREATE TABLE materialize_jobs(
 id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,bundle_hash TEXT NOT NULL,
 destination TEXT NOT NULL UNIQUE COLLATE NOCASE,parent TEXT NOT NULL,
 parent_dev TEXT NOT NULL,parent_ino TEXT NOT NULL,state TEXT NOT NULL,
 attempt INTEGER NOT NULL DEFAULT 0,stage TEXT,stage_dev TEXT,stage_ino TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE materialize_attempts(
 job_id TEXT NOT NULL REFERENCES materialize_jobs(id),
 seq INTEGER NOT NULL,path TEXT NOT NULL UNIQUE,
 PRIMARY KEY(job_id,seq)
);`;

class MaterializeError extends Error {
    constructor(code, message) { super(message); this.name = 'MaterializeError'; this.code = code; }
}
function check(ok, code, message) {
    if (!ok) throw new MaterializeError(code, message);
}
function exists(file) {
    try { fs.lstatSync(file); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function noLinks(absolute) {
    const resolved = path.resolve(absolute);
    const base = path.parse(resolved).root;
    let current = base;
    for (const part of resolved.slice(base.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (!exists(current)) return;
        check(!fs.lstatSync(current).isSymbolicLink(), 'UNSAFE_PATH', 'Linked path ancestry');
    }
}
function identity(directory) {
    noLinks(directory);
    const stat = fs.lstatSync(directory, { bigint: true });
    check(stat.isDirectory() && stat.ino !== 0n, 'UNSAFE_PATH', 'Directory has no usable identity');
    return { dev: String(stat.dev), ino: String(stat.ino) };
}
function same(value, dev, ino) { return value.dev === dev && value.ino === ino; }
function requestId(value) {
    check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
        'INVALID_ARGUMENT', 'A bounded request identifier is required');
}
function basenameSafe(value) {
    check(value && value === value.normalize('NFC') && value === value.trim() &&
        !value.endsWith('.') && !/[\\/:<>"|?*]/.test(value) &&
        !Array.from(value).some(c => c.codePointAt(0) < 32 || c.codePointAt(0) === 127) &&
        !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(value) &&
        !['.', '..', '.git'].includes(value.toLowerCase()) &&
        !value.toLowerCase().startsWith('.pf-stage-') && Buffer.byteLength(value, 'utf8') <= 180,
    'UNSAFE_PATH', 'Unsafe destination directory name');
}
function destinationOf(value) {
    check(typeof value === 'string' && path.isAbsolute(value), 'INVALID_ARGUMENT', 'Absolute destination required');
    const destination = path.resolve(value);
    check(destination !== path.parse(destination).root && !destination.startsWith('\\\\'),
        'UNSAFE_PATH', 'Volume roots, UNC and device namespace paths are unsupported');
    basenameSafe(path.basename(destination));
    noLinks(destination);
    return destination;
}
function plan(bytes, expectedHash) {
    check(typeof expectedHash === 'string' && /^[0-9a-f]{64}$/.test(expectedHash),
        'INVALID_ARGUMENT', 'Explicit trusted bundle SHA-256 required');
    validateProjectBundle(bytes, { expectedHash });
    const data = JSON.parse(bytes.toString('utf8'));
    const buffers = new Map(data.blobs.map(row => [row.hash, Buffer.from(row.base64, 'base64')]));
    const files = new Map();
    const directories = new Set();
    for (const row of data.files) {
        if (row.hash === null) continue;
        files.set(row.file_path, { hash: row.hash, bytes: buffers.get(row.hash) });
        const parts = row.file_path.split('/');
        parts.pop();
        while (parts.length) { directories.add(parts.join('/')); parts.pop(); }
    }
    for (const row of data.files) {
        check(row.hash !== null || !directories.has(row.file_path),
            'INCONSISTENT_TREE', 'A tombstone would be a live directory');
        const parts = row.file_path.split('/');
        parts.pop();
        while (parts.length) {
            check(!files.has(parts.join('/')), 'INCONSISTENT_TREE', 'A known path descends from a live file');
            parts.pop();
        }
    }
    return { files, directories, hash: expectedHash };
}
function verifyTree(root, expected, dev, ino) {
    const actual = identity(root);
    if (dev !== undefined) check(same(actual, dev, ino), 'IDENTITY_MISMATCH', 'Directory identity changed');
    const seenFiles = new Set();
    const seenDirectories = new Set();
    function walk(directory, prefix = '') {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix + entry.name;
            const absolute = path.join(directory, entry.name);
            const stat = fs.lstatSync(absolute, { bigint: true });
            check(!stat.isSymbolicLink(), 'UNSAFE_PATH', 'Linked materialized entry');
            if (stat.isDirectory()) {
                check(expected.directories.has(relative), 'TREE_DRIFT', 'Unexpected directory: ' + relative);
                seenDirectories.add(relative);
                walk(absolute, relative + '/');
            } else {
                const file = expected.files.get(relative);
                check(file && stat.isFile() && stat.nlink === 1n &&
                    stat.size === BigInt(file.bytes.length), 'TREE_DRIFT', 'Unexpected or altered file: ' + relative);
                const fd = fs.openSync(absolute, 'r');
                try {
                    const opened = fs.fstatSync(fd, { bigint: true });
                    check(opened.isFile() && opened.nlink === 1n && opened.ino === stat.ino &&
                        opened.dev === stat.dev && opened.size === stat.size, 'TREE_DRIFT', 'File changed during open');
                    const bytes = Buffer.alloc(file.bytes.length + 1);
                    let count = 0;
                    while (count < bytes.length) {
                        const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
                        if (!n) break;
                        count += n;
                    }
                    check(count === file.bytes.length && sha256(bytes.subarray(0, count)) === file.hash,
                        'TREE_DRIFT', 'File hash mismatch: ' + relative);
                } finally { fs.closeSync(fd); }
                seenFiles.add(relative);
            }
        }
    }
    walk(root);
    check(seenFiles.size === expected.files.size && seenDirectories.size === expected.directories.size,
        'TREE_DRIFT', 'Expected tree entries are missing');
    return actual;
}

class WorktreeMaterializer {
    constructor(journalPath, { busyTimeoutMs = 5000, _testHook = null } = {}) {
        check(process.platform === 'win32', 'UNSUPPORTED_PLATFORM', 'No-replace publication is Windows-only');
        check(typeof journalPath === 'string' && path.isAbsolute(journalPath) &&
            !path.resolve(journalPath).startsWith('\\\\'), 'INVALID_ARGUMENT', 'Absolute local journal path required');
        check(Number.isSafeInteger(busyTimeoutMs) && busyTimeoutMs >= 0 && busyTimeoutMs <= 60000,
            'INVALID_ARGUMENT', 'Invalid SQLite busy timeout');
        check(_testHook === null || typeof _testHook === 'function', 'INVALID_ARGUMENT', 'Invalid test hook');
        this.journalPath = path.resolve(journalPath);
        noLinks(this.journalPath);
        identity(path.dirname(this.journalPath));
        if (exists(this.journalPath)) {
            const stat = fs.lstatSync(this.journalPath);
            check(stat.isFile() && stat.nlink === 1, 'UNSAFE_PATH', 'Journal must be a single-link regular file');
        }
        this._testHook = _testHook;
        const db = new Database(this.journalPath);
        try {
            db.pragma(`busy_timeout = ${busyTimeoutMs}`);
            db.pragma('foreign_keys = ON');
            db.transaction(() => {
                const tables = db.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                ).all().map(row => row.name);
                if (!tables.length) db.exec(SCHEMA);
                else {
                    check(JSON.stringify(tables) === JSON.stringify(TABLES),
                        'WRONG_DATABASE', 'Not a dedicated materialization journal');
                    check(db.prepare("SELECT value FROM materialize_meta WHERE key='version'").get()?.value === '1',
                        'SCHEMA_VERSION', 'Unsupported journal version');
                }
                db.prepare('INSERT OR IGNORE INTO materialize_meta(key,value) VALUES (?,?)')
                    .run('journal_id', 'j_' + crypto.randomUUID());
                const id = db.prepare("SELECT value FROM materialize_meta WHERE key='journal_id'").get()?.value;
                check(typeof id === 'string' && /^j_[0-9a-f-]{36}$/.test(id),
                    'JOURNAL_CORRUPT', 'Invalid publication journal identity');
            }).immediate();
            db.pragma('journal_mode = WAL');
            db.pragma('synchronous = FULL');
            this.db = db;
        } catch (error) { db.close(); throw error; }
    }

    close() { if (this.db?.open) this.db.close(); this.db = null; }
    _connection() {
        check(this.db?.open, 'CLOSED', 'Journal is closed');
        return this.db;
    }
    _write(fn) {
        const db = this._connection();
        check(!db.inTransaction, 'INVALID_ARGUMENT', 'Caller transactions are not supported');
        return db.transaction(fn).immediate();
    }
    _emit(event, row) { if (this._testHook) this._testHook(event, { ...row }); }
    _row(id) {
        requestId(id);
        const row = this._connection().prepare('SELECT * FROM materialize_jobs WHERE id=?').get(id);
        check(row, 'NOT_FOUND', 'Unknown materialization job');
        return row;
    }
    _view(row) {
        return {
            id: row.id, requestId: row.request_id, bundleHash: row.bundle_hash,
            destination: row.destination, state: row.state, attempt: row.attempt,
            stage: row.stage, metadataImported: false,
            retainedStages: this.db.prepare(
                'SELECT path FROM materialize_attempts WHERE job_id=? AND seq<? ORDER BY seq'
            ).all(row.id, row.attempt).map(item => item.path),
        };
    }
    getJob(id) { return this._view(this._row(id)); }
    getJournalId() {
        return this._connection().prepare("SELECT value FROM materialize_meta WHERE key='journal_id'").get().value;
    }
    _context(row) {
        check(destinationOf(row.destination) === row.destination && path.dirname(row.destination) === row.parent,
            'JOURNAL_CORRUPT', 'Invalid recorded destination');
        check(same(identity(row.parent), row.parent_dev, row.parent_ino),
            'IDENTITY_MISMATCH', 'Destination parent identity changed');
        check(Number.isSafeInteger(row.attempt) && row.attempt >= 0 && row.attempt <= 16 &&
            ['planned', 'staging', 'ready', 'published'].includes(row.state),
        'JOURNAL_CORRUPT', 'Invalid recorded state');
        if (row.state === 'planned') {
            check(row.attempt === 0 && row.stage === null, 'JOURNAL_CORRUPT', 'Unexpected planned stage');
        } else {
            check(typeof row.stage === 'string' && path.dirname(row.stage) === row.parent &&
                path.basename(row.stage).startsWith('.pf-stage-' + row.id + '-') &&
                this.db.prepare('SELECT path FROM materialize_attempts WHERE job_id=? AND seq=?')
                    .get(row.id, row.attempt)?.path === row.stage, 'JOURNAL_CORRUPT', 'Invalid stage path');
            if (row.state === 'ready' || row.state === 'published') {
                check(typeof row.stage_dev === 'string' && typeof row.stage_ino === 'string',
                    'JOURNAL_CORRUPT', 'Ready stage has no identity');
            }
            noLinks(row.stage);
        }
    }
    _allocate(row) {
        check(row.attempt < 16, 'ATTEMPT_LIMIT', 'Retained stage limit reached; manual inspection required');
        const sequence = row.attempt + 1;
        const stage = path.join(row.parent, '.pf-stage-' + row.id + '-' + crypto.randomBytes(12).toString('hex'));
        check(!exists(stage), 'DESTINATION_EXISTS', 'Allocated stage unexpectedly exists');
        this.db.prepare('INSERT INTO materialize_attempts(job_id,seq,path) VALUES (?,?,?)')
            .run(row.id, sequence, stage);
        this.db.prepare(`UPDATE materialize_jobs SET state='staging',attempt=?,stage=?,
            stage_dev=NULL,stage_ino=NULL,updated_at=? WHERE id=?`)
            .run(sequence, stage, new Date().toISOString(), row.id);
        return this._row(row.id);
    }

    createJob({ requestId: request, destination: input, bundle, expectedHash }) {
        requestId(request);
        plan(bundle, expectedHash);
        const destination = destinationOf(input);
        const parent = path.dirname(destination);
        const parentIdentity = identity(parent);
        check(this.journalPath.toLowerCase() !== destination.toLowerCase() &&
            !this.journalPath.toLowerCase().startsWith(destination.toLowerCase() + path.sep),
        'INVALID_ARGUMENT', 'Journal cannot be inside the published worktree');
        return this._write(() => {
            const prior = this.db.prepare('SELECT * FROM materialize_jobs WHERE request_id=?').get(request);
            if (prior) {
                check(prior.destination.toLowerCase() === destination.toLowerCase() &&
                    prior.bundle_hash === expectedHash, 'REQUEST_CONFLICT', 'Job request payload changed');
                this._context(prior);
                return this._view(prior);
            }
            check(!exists(destination), 'DESTINATION_EXISTS', 'Never overwrite an existing destination');
            check(!this.db.prepare('SELECT 1 FROM materialize_jobs WHERE destination=?').get(destination),
                'DESTINATION_BUSY', 'Destination already belongs to another job');
            const now = new Date().toISOString();
            const id = 'm_' + crypto.randomUUID();
            this.db.prepare(`INSERT INTO materialize_jobs
                (id,request_id,bundle_hash,destination,parent,parent_dev,parent_ino,state,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,'planned',?,?)`).run(id, request, expectedHash, destination,
                parent, parentIdentity.dev, parentIdentity.ino, now, now);
            return this._view(this._row(id));
        });
    }

    advance(jobId, bundle, { expectedHash } = {}) {
        const expected = plan(bundle, expectedHash);
        const result = this._write(() => {
            const row = this._row(jobId);
            check(row.bundle_hash === expected.hash, 'REQUEST_CONFLICT', 'Bundle differs from recorded job');
            this._context(row);
            if (row.state === 'planned') {
                check(!exists(row.destination), 'DESTINATION_EXISTS', 'Destination appeared before staging');
                return this._view(this._allocate(row));
            }
            if (row.state === 'staging') {
                check(!exists(row.destination), 'DESTINATION_EXISTS', 'Destination appeared before staging');
                if (exists(row.stage)) {
                    // Earlier filesystem writes outlived an interrupted DB transaction. Preserve, never repair/delete.
                    return this._view(this._allocate(row));
                }
                fs.mkdirSync(row.stage);
                this._emit('stage-created', row);
                for (const relative of [...expected.directories].sort((a, b) =>
                    a.split('/').length - b.split('/').length || a.localeCompare(b))) {
                    fs.mkdirSync(path.join(row.stage, ...relative.split('/')));
                }
                for (const [relative, file] of expected.files) {
                    const fd = fs.openSync(path.join(row.stage, ...relative.split('/')), 'wx', 0o600);
                    try { fs.writeFileSync(fd, file.bytes); fs.fsyncSync(fd); }
                    finally { fs.closeSync(fd); }
                    this._emit('file-written', row);
                }
                const stageIdentity = verifyTree(row.stage, expected);
                this._emit('stage-verified', row);
                this.db.prepare(`UPDATE materialize_jobs SET state='ready',stage_dev=?,stage_ino=?,updated_at=? WHERE id=?`)
                    .run(stageIdentity.dev, stageIdentity.ino, new Date().toISOString(), row.id);
                return this._view(this._row(row.id));
            }
            if (row.state === 'ready') {
                if (exists(row.stage)) {
                    check(!exists(row.destination), 'DESTINATION_EXISTS', 'Destination appeared; publication blocked');
                    verifyTree(row.stage, expected, row.stage_dev, row.stage_ino);
                    this._emit('before-publish', row);
                    this._context(row);
                    // Windows no-replace directory rename; non-Windows platforms fail at construction.
                    fs.renameSync(row.stage, row.destination);
                    this._emit('renamed', row);
                } else {
                    check(exists(row.destination), 'MISSING_STAGE', 'Stage and destination are both absent');
                }
                // Rename can outlive the transaction. Adopt only the recorded directory identity AND exact tree.
                verifyTree(row.destination, expected, row.stage_dev, row.stage_ino);
                this.db.prepare("UPDATE materialize_jobs SET state='published',updated_at=? WHERE id=?")
                    .run(new Date().toISOString(), row.id);
                return this._view(this._row(row.id));
            }
            verifyTree(row.destination, expected, row.stage_dev, row.stage_ino);
            return this._view(row);
        });
        this._emit('committed:' + result.state, result);
        return result;
    }

    resume(jobId, bundle, options) {
        for (let step = 0; step < 36; step++) {
            const result = this.advance(jobId, bundle, options);
            if (result.state === 'published') return result;
        }
        throw new MaterializeError('STEP_LIMIT', 'Bounded recovery exhausted; inspect journal');
    }
}

module.exports = { WorktreeMaterializer, MaterializeError };