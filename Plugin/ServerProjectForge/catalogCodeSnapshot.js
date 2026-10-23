'use strict';
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { check, fields, identifier, integer, hash } = require('./hubNetworkProtocol');
const { validateEngineeringDetail } = require('./catalogEngineeringInventory');

const CODE_LIMITS = Object.freeze({
    blobBytes: 16 * 1024,
    maxFiles: 100,
    maxBytes: 4 * 1024 * 1024,
});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const absent = () => ({ state: 'absent', hash: null, size: 0, text: null });

// Preserve BOM, CRLF and Unicode exactly. Display normalization belongs to the UI.
function validateSide(side) {
    fields(side, ['state', 'hash', 'size', 'text']);
    integer(side.size);
    if (side.state === 'absent') {
        check(side.hash === null && side.size === 0 && side.text === null, 'CONTENT_BINDING');
        return absent();
    }
    hash(side.hash);
    check(['text', 'binary', 'unsupported-encoding', 'too-large'].includes(side.state));
    if (side.state === 'text') {
        check(typeof side.text === 'string');
        const bytes = Buffer.from(side.text, 'utf8');
        check(bytes.toString('utf8') === side.text && bytes.length === side.size &&
            bytes.length <= CODE_LIMITS.blobBytes && !bytes.includes(0), 'CONTENT_BINDING');
        check(sha(bytes) === side.hash, 'HASH_MISMATCH');
    } else {
        check(side.text === null);
        check(side.state === 'too-large'
            ? side.size > CODE_LIMITS.blobBytes
            : side.size > 0 && side.size <= CODE_LIMITS.blobBytes, 'CONTENT_BINDING');
    }
    return { state: side.state, hash: side.hash, size: side.size, text: side.text };
}

// Frozen code must correspond one-for-one to the engineering file preview.
// A digest is a consistency check, never permission to retrieve a global blob.
function validateCodeSnapshot(value, engineering) {
    fields(value, ['version', 'state'], ['files']);
    check(value.version === 1);
    if (value.state === 'not-shared') {
        fields(value, ['version', 'state']);
        return { version: 1, state: 'not-shared' };
    }
    check(value.state === 'shared');
    fields(value, ['version', 'state', 'files']);
    const detail = validateEngineeringDetail(engineering);
    check(detail.state === 'shared', 'CONTENT_BINDING');
    check(Array.isArray(value.files) && value.files.length <= CODE_LIMITS.maxFiles &&
        value.files.length === detail.files.items.length, 'CONTENT_BINDING');
    const files = value.files.map((file, index) => {
        fields(file, ['file_path', 'node', 'batch', 'before', 'after']);
        const expected = detail.files.items[index];
        integer(file.node, 1); integer(file.batch, 1);
        check(file.file_path === expected.file_path && file.node === expected.last_node,
            'CONTENT_BINDING');
        return { file_path: file.file_path, node: file.node, batch: file.batch,
            before: validateSide(file.before), after: validateSide(file.after) };
    });
    const result = { version: 1, state: 'shared', files };
    check(Buffer.byteLength(JSON.stringify(result), 'utf8') <= CODE_LIMITS.maxBytes,
        'LIMIT_EXCEEDED');
    return result;
}

// Trusted host helper. Call inside the SAME read transaction as engineering
// collection. No filesystem reads, network, migrations or writer lease changes.
// Explicit sharing includes historical content; no automatic secret redaction.
function collectCodeSnapshot(store, projectId, engineering, options = {}) {
    fields(options, [], ['shared', 'authorize']);
    check(options.shared === undefined || typeof options.shared === 'boolean');
    if (options.shared !== true) return { version: 1, state: 'not-shared' };
    identifier(projectId);
    check(typeof options.authorize === 'function');
    const detail = validateEngineeringDetail(engineering);
    check(detail.state === 'shared', 'CONTENT_BINDING');
    const db = store?.db;
    check(db?.open && db.inTransaction, 'INVALID_ARGUMENT');
    const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
    check(project, 'NOT_FOUND');
    check(options.authorize({ ...project }) === true, 'FORBIDDEN');
    check(project.availability === 'ready', 'BUSY');

    const nodeQuery = db.prepare(`
        SELECT n.id,n.batch_id,n.file_path,n.before_hash,n.after_hash
        FROM nodes n JOIN batches b ON b.id=n.batch_id AND b.project_id=n.project_id
        WHERE n.project_id=? AND n.id=?
    `);
    // Forge stores gzip bytes; size is the UNCOMPRESSED length. Inspect metadata
    // before loading data, and bound both compressed input and inflated output.
    const metaQuery = db.prepare('SELECT size,length(data) AS actual FROM blobs WHERE hash=?');
    const dataQuery = db.prepare('SELECT data FROM blobs WHERE hash=?');
    const side = digest => {
        if (digest === null) return absent();
        hash(digest);
        const meta = metaQuery.get(digest);
        check(meta && Number.isSafeInteger(meta.size) && meta.size >= 0 &&
            Number.isSafeInteger(meta.actual) && meta.actual > 0, 'CORRUPT_BLOB');
        if (meta.size > CODE_LIMITS.blobBytes) {
            // Metadata-only: do not claim the omitted body has been verified.
            return { state: 'too-large', hash: digest, size: meta.size, text: null };
        }
        check(meta.actual <= CODE_LIMITS.blobBytes + 1024, 'CORRUPT_BLOB');
        const compressed = dataQuery.get(digest)?.data;
        check(Buffer.isBuffer(compressed) && compressed.length === meta.actual, 'CORRUPT_BLOB');
        let bytes;
        try {
            bytes = zlib.gunzipSync(compressed, { maxOutputLength: CODE_LIMITS.blobBytes });
        } catch {
            check(false, 'CORRUPT_BLOB');
        }
        check(bytes.length === meta.size && sha(bytes) === digest, 'CORRUPT_BLOB');
        const text = bytes.toString('utf8');
        const state = bytes.includes(0) ? 'binary'
            : Buffer.from(text, 'utf8').equals(bytes) ? 'text' : 'unsupported-encoding';
        return { state, hash: digest, size: bytes.length, text: state === 'text' ? text : null };
    };
    let size = 0;
    const files = detail.files.items.map(file => {
        const node = nodeQuery.get(projectId, file.last_node);
        check(node && node.file_path === file.file_path, 'CONTENT_BINDING');
        // Reject stale preview input, even when an older node still exists.
        const latest = db.prepare(
            'SELECT MAX(id) AS id FROM nodes WHERE project_id=? AND file_path=?'
        ).get(projectId, file.file_path);
        check(latest.id === node.id, 'CONTENT_BINDING');
        const row = { file_path: file.file_path, node: node.id, batch: node.batch_id,
            before: side(node.before_hash), after: side(node.after_hash) };
        size += Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
        check(size <= CODE_LIMITS.maxBytes, 'LIMIT_EXCEEDED');
        return row;
    });
    return validateCodeSnapshot({ version: 1, state: 'shared', files }, detail);
}

module.exports = { CODE_LIMITS, validateSide, validateCodeSnapshot, collectCodeSnapshot };