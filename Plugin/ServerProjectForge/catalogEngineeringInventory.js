'use strict';
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { canonicalRecords, MAX_BYTES } = require('./catalogInventory');
const { projectEngineeringDetail, DETAIL_LIMITS } = require('./catalogEngineeringDetail');
const { check, fields, identifier } = require('./hubNetworkProtocol');

function markers(value, allowed) {
    check(Array.isArray(value) && value.length <= allowed.length);
    check(value.every(v => allowed.includes(v)) && new Set(value).size === value.length);
    // Canonical order must survive persistent replay, regardless of caller order.
    return allowed.filter(v => value.includes(v));
}

// Validate a projected, frozen detail. Re-projecting alone would silently strip
// unknown keys, clip malformed input, and lose original truncation provenance.
function validateEngineeringDetail(value) {
    check(value !== null && typeof value === 'object' && !Array.isArray(value));
    if (value.state === 'not-shared') {
        fields(value, ['version', 'state']);
        check(value.version === 1);
        return { version: 1, state: 'not-shared' };
    }
    fields(value, ['version', 'state', 'report', 'timeline', 'files']);
    check(value.version === 1 && value.state === 'shared');
    fields(value.report, ['text', 'by', 'truncated']);
    fields(value.timeline, ['items', 'total', 'truncated']);
    fields(value.files, ['items', 'total', 'truncated']);
    check(Array.isArray(value.timeline.items) &&
        value.timeline.items.length <= DETAIL_LIMITS.maxBatches, 'LIMIT_EXCEEDED');
    check(Array.isArray(value.files.items) &&
        value.files.items.length <= DETAIL_LIMITS.maxFiles, 'LIMIT_EXCEEDED');
    const reportMarks = markers(value.report.truncated, ['text', 'by']);
    for (const key of reportMarks) {
        check(typeof value.report[key] === 'string');
        const maximum = key === 'text' ? DETAIL_LIMITS.reportChars : DETAIL_LIMITS.authorChars;
        check(value.report[key].length >= maximum - 1 && value.report[key].length <= maximum);
    }
    const batchMarks = value.timeline.items.map(row => {
        fields(row, ['id', 'kind', 'reason', 'maid', 'created_at', 'node_count',
            'added', 'removed', 'files', 'file_total', 'files_truncated', 'truncated']);
        const result = markers(row.truncated, ['reason', 'maid']);
        for (const key of result) {
            const maximum = key === 'reason' ? DETAIL_LIMITS.reasonChars : DETAIL_LIMITS.authorChars;
            check(typeof row[key] === 'string' &&
                row[key].length >= maximum - 1 && row[key].length <= maximum);
        }
        return result;
    });
    for (const row of value.files.items) {
        fields(row, ['file_path', 'edits', 'added', 'removed', 'last_node']);
    }
    const projected = projectEngineeringDetail({
        project: { report: value.report.text, report_by: value.report.by },
        batches: value.timeline.items,
        files: value.files.items,
        batchTotal: value.timeline.total,
        fileTotal: value.files.total,
    }, { shared: true });
    // Oversized frozen fields must be rejected, never silently re-clipped.
    check(projected.report.truncated.length === 0);
    check(projected.timeline.items.every(row => row.truncated.length === 0));
    projected.report.truncated = reportMarks;
    projected.timeline.items.forEach((row, i) => { row.truncated = batchMarks[i]; });
    check(isDeepStrictEqual(projected, value));
    check(Buffer.byteLength(JSON.stringify(projected), 'utf8') <= DETAIL_LIMITS.maxBytes,
        'LIMIT_EXCEEDED');
    return projected;
}

function canonicalEngineeringInventory(sourceId, records, details) {
    identifier(sourceId);
    check(Array.isArray(details) && details.length <= 8192, 'LIMIT_EXCEEDED');
    const legacy = canonicalRecords(sourceId, records);
    const clean = JSON.parse(legacy.payload);
    check(details.length === clean.length, 'CONTENT_BINDING');
    const ids = new Set(clean.map(row => row.project.id));
    const seen = new Set();
    let size = Buffer.byteLength(legacy.payload, 'utf8') +
        Buffer.byteLength('{"version":2,"records":,"details":[]}', 'utf8');
    const projected = details.map(entry => {
        fields(entry, ['localProjectId', 'detail']);
        identifier(entry.localProjectId);
        check(ids.has(entry.localProjectId) && !seen.has(entry.localProjectId), 'CONTENT_BINDING');
        seen.add(entry.localProjectId);
        const row = { localProjectId: entry.localProjectId,
            detail: validateEngineeringDetail(entry.detail) };
        size += Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
        check(size <= MAX_BYTES, 'LIMIT_EXCEEDED');
        return row;
    }).sort((a, b) => a.localProjectId < b.localProjectId ? -1 : a.localProjectId > b.localProjectId ? 1 : 0);
    const payload = JSON.stringify({ version: 2, records: clean, details: projected });
    check(Buffer.byteLength(payload, 'utf8') <= MAX_BYTES, 'LIMIT_EXCEEDED');
    return { payload, digest: crypto.createHash('sha256').update(payload).digest('hex') };
}

module.exports = { canonicalEngineeringInventory, validateEngineeringDetail };