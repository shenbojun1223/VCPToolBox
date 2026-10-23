'use strict';
// Pure projection only. Explicit consent is required; free-text secrets are NOT
// automatically redacted. No database, filesystem, network or lifecycle effects.
const DETAIL_LIMITS = Object.freeze({
    reportChars: 8192,
    authorChars: 100,
    reasonChars: 1024,
    maxBatches: 20,
    maxFiles: 100,
    maxBatchFiles: 20,
    pathChars: 512,
    maxBytes: 128 * 1024,
});
const KINDS = new Set(['edit', 'create', 'remove', 'delete', 'move', 'copy', 'rollback', 'external']);
function check(ok, code = 'INVALID_ARGUMENT') {
    if (!ok) throw Object.assign(new Error(code), { code });
}
function object(value) {
    check(value !== null && typeof value === 'object' && !Array.isArray(value));
}
function integer(value, minimum = 0) {
    check(Number.isSafeInteger(value) && value >= minimum);
    return value;
}
function clipped(value, maximum, key, truncated) {
    if (value === null || value === undefined) return null;
    check(typeof value === 'string');
    if (value.length <= maximum) return value;
    let end = maximum;
    if (/[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end--;
    truncated.push(key);
    return value.slice(0, end);
}
function timestamp(value) {
    check(typeof value === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
        Number.isFinite(Date.parse(value)));
    const canonical = value.includes('.') ? value : value.slice(0, -1) + '.000Z';
    check(new Date(value).toISOString() === canonical);
    return value;
}
function relativePath(value) {
    check(typeof value === 'string' && value.length > 0 &&
        value.length <= DETAIL_LIMITS.pathChars && value === value.normalize('NFC'), 'UNSAFE_PATH');
    const parts = value.split('/');
    check(parts.length <= 32, 'UNSAFE_PATH');
    for (const part of parts) {
        check(part && part !== '.' && part !== '..' && part.trim() === part &&
            !part.endsWith('.') && !/[\\<>:"|?*]/.test(part) &&
            !Array.from(part).some(char => char.codePointAt(0) < 32 || char.codePointAt(0) === 127) &&
            part.toLowerCase() !== '.git' &&
            !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part),
        'UNSAFE_PATH');
    }
    return value;
}
function collection(rows, total, maximum, project, identity) {
    check(Array.isArray(rows) && rows.length <= maximum, 'LIMIT_EXCEEDED');
    integer(total);
    check(total >= rows.length && (total === 0 || rows.length > 0));
    const seen = new Set();
    const items = rows.map(row => {
        object(row);
        const result = project(row), key = identity(result);
        check(!seen.has(key), 'DUPLICATE_RECORD');
        seen.add(key);
        return result;
    });
    return { items, total, truncated: total > items.length };
}
function batch(row) {
    const truncated = [];
    check(KINDS.has(row.kind));
    check(Array.isArray(row.files) && row.files.length <= DETAIL_LIMITS.maxBatchFiles,
        'LIMIT_EXCEEDED');
    const files = row.files.map(relativePath);
    check(new Set(files).size === files.length, 'DUPLICATE_RECORD');
    const nodeCount = integer(row.node_count, 1);
    const fileTotal = row.file_total === undefined ? files.length : integer(row.file_total, 1);
    // Preview counts describe unique paths, not edit nodes. Missing totals
    // mean a complete legacy input; explicit totals must cover the preview.
    check(files.length > 0 && files.length <= fileTotal && fileTotal <= nodeCount);
    return {
        id: integer(row.id, 1), kind: row.kind,
        reason: clipped(row.reason, DETAIL_LIMITS.reasonChars, 'reason', truncated),
        maid: clipped(row.maid, DETAIL_LIMITS.authorChars, 'maid', truncated),
        created_at: timestamp(row.created_at),
        node_count: nodeCount, added: integer(row.added), removed: integer(row.removed),
        files, file_total: fileTotal, files_truncated: fileTotal > files.length, truncated,
    };
}
function file(row) {
    return {
        file_path: relativePath(row.file_path), edits: integer(row.edits, 1),
        added: integer(row.added), removed: integer(row.removed),
        last_node: integer(row.last_node, 1),
    };
}
function projectEngineeringDetail(input, options = {}) {
    object(options);
    check(Object.keys(options).every(key => key === 'shared'));
    check(options.shared === undefined || typeof options.shared === 'boolean');
    if (options.shared !== true) return { version: 1, state: 'not-shared' };
    object(input);
    object(input.project);
    const truncated = [];
    const result = {
        version: 1,
        state: 'shared',
        report: {
            text: clipped(input.project.report, DETAIL_LIMITS.reportChars, 'text', truncated),
            by: clipped(input.project.report_by, DETAIL_LIMITS.authorChars, 'by', truncated),
            truncated,
        },
        timeline: collection(input.batches, input.batchTotal, DETAIL_LIMITS.maxBatches, batch, r => r.id),
        files: collection(input.files, input.fileTotal, DETAIL_LIMITS.maxFiles, file, r => r.file_path),
    };
    check(Buffer.byteLength(JSON.stringify(result), 'utf8') <= DETAIL_LIMITS.maxBytes,
        'LIMIT_EXCEEDED');
    return result;
}
module.exports = { projectEngineeringDetail, DETAIL_LIMITS };