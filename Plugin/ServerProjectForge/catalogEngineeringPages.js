'use strict';
const crypto = require('node:crypto');
const { check, fields, identifier, integer, hash } = require('./hubNetworkProtocol');
const { validateEngineeringDetail } = require('./catalogEngineeringInventory');
const PAGE_BYTES = 32 * 1024;
const REPORT_CHARS = 1024;
const SECTIONS = new Set(['report', 'timeline', 'files']);
const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));

function reportChunks(text) {
    if (text === null || text === '') return [];
    const rows = [];
    let offset = 0;
    while (offset < text.length) {
        let end = Math.min(offset + REPORT_CHARS, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
        rows.push({ offset, text: text.slice(offset, end) });
        offset = end;
    }
    return rows;
}

// Consistency capability only: callers must authorize the source/project before
// construction. A snapshot digest is never a credential or proof of freshness.
class EngineeringSnapshot {
    #snapshot;
    #state;
    #sections;

    constructor(detail, binding) {
        fields(binding, ['sourceId', 'localProjectId', 'version', 'digest']);
        identifier(binding.sourceId);
        identifier(binding.localProjectId);
        integer(binding.version, 1);
        hash(binding.digest);
        const pinned = {
            sourceId: binding.sourceId, localProjectId: binding.localProjectId,
            version: binding.version, digest: binding.digest,
        };
        const value = validateEngineeringDetail(detail);
        this.#snapshot = crypto.createHash('sha256')
            .update(JSON.stringify({ binding: pinned, detail: value })).digest('hex');
        this.#state = value.state;
        if (value.state === 'not-shared') {
            this.#sections = Object.fromEntries([...SECTIONS].map(section =>
                [section, { metadata: null, rows: [] }]));
            return;
        }
        this.#sections = {
            report: {
                metadata: {
                    present: value.report.text !== null,
                    by: value.report.by,
                    truncated: [...value.report.truncated],
                },
                rows: reportChunks(value.report.text),
            },
            timeline: {
                metadata: { total: value.timeline.total, truncated: value.timeline.truncated },
                rows: value.timeline.items,
            },
            files: {
                metadata: { total: value.files.total, truncated: value.files.truncated },
                rows: value.files.items,
            },
        };
    }

    page(section, options = {}) {
        check(SECTIONS.has(section), 'INVALID_ARGUMENT');
        fields(options, [], ['cursor', 'limit', 'maxBytes']);
        const { cursor = null, limit = 50, maxBytes = PAGE_BYTES } = options;
        integer(limit, 1, 200);
        integer(maxBytes, 256, PAGE_BYTES);
        const { rows, metadata } = this.#sections[section];
        let start = 0;
        if (cursor !== null) {
            fields(cursor, ['snapshot', 'section', 'offset']);
            check(cursor.snapshot === this.#snapshot && cursor.section === section,
                'REQUEST_CONFLICT');
            integer(cursor.offset, 1);
            check(cursor.offset < rows.length, 'INVALID_ARGUMENT');
            start = cursor.offset;
        }
        const next = offset => offset < rows.length
            ? { snapshot: this.#snapshot, section, offset } : null;
        let result = {
            snapshot: this.#snapshot, section, state: this.#state,
            metadata, total: rows.length, items: [], next: next(start),
        };
        check(size(result) <= maxBytes, 'LIMIT_EXCEEDED');
        let offset = start;
        while (offset < rows.length && result.items.length < limit) {
            const candidate = {
                ...result, items: [...result.items, rows[offset]], next: next(offset + 1),
            };
            if (size(candidate) > maxBytes) {
                check(result.items.length > 0, 'LIMIT_EXCEEDED');
                break;
            }
            result = candidate;
            offset++;
        }
        return clone(result);
    }
}

module.exports = { EngineeringSnapshot };