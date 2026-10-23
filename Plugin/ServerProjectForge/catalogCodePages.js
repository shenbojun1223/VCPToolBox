'use strict';
const crypto = require('node:crypto');
const { check, fields, identifier, integer, hash } = require('./hubNetworkProtocol');
const MAX_CODE_BYTES = 256 * 1024;
const CHUNK_BYTES = 4096;

function codeBinding(value) {
    fields(value, ['sourceId', 'localProjectId', 'version', 'digest', 'node']);
    identifier(value.sourceId); identifier(value.localProjectId);
    integer(value.version, 1); hash(value.digest); integer(value.node, 1);
    return { sourceId: value.sourceId, localProjectId: value.localProjectId,
        version: value.version, digest: value.digest, node: value.node };
}
function codeDigest(binding, bytes) {
    return crypto.createHash('sha256').update(JSON.stringify(codeBinding(binding)))
        .update('\n').update(bytes).digest('hex');
}

// Internal input is already validated by CatalogSourceStore. No authorization
// is derived from a cursor. Bytes are JSON UTF8, transported in bounded base64.
class CodeSnapshot {
    constructor(value, binding) {
        this.binding = codeBinding(binding);
        this.bytes = Buffer.from(JSON.stringify(value), 'utf8');
        check(this.bytes.length > 0 && this.bytes.length <= MAX_CODE_BYTES, 'LIMIT_EXCEEDED');
        this.snapshot = codeDigest(this.binding, this.bytes);
    }

    page({ cursor = null, maxBytes = 16 * 1024 } = {}) {
        integer(maxBytes, 256, 32 * 1024);
        let offset = 0;
        if (cursor !== null) {
            fields(cursor, ['snapshot', 'offset']);
            hash(cursor.snapshot); integer(cursor.offset, 1, this.bytes.length - 1);
            check(cursor.snapshot === this.snapshot, 'REQUEST_CONFLICT');
            offset = cursor.offset;
        }
        const make = length => {
            const end = offset + length;
            return {
                snapshot: this.snapshot, total: this.bytes.length, offset,
                data: this.bytes.subarray(offset, end).toString('base64'),
                next: end < this.bytes.length ? { snapshot: this.snapshot, offset: end } : null,
            };
        };
        let length = Math.min(CHUNK_BYTES, this.bytes.length - offset);
        let result = make(length);
        while (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes && length > 1) {
            length = Math.floor(length / 2);
            result = make(length);
        }
        check(Buffer.byteLength(JSON.stringify(result), 'utf8') <= maxBytes, 'LIMIT_EXCEEDED');
        return result;
    }
}

// Shared transport validator. Full digest and UTF8 validation follow assembly.
function validateCodePage(page, cursor = null) {
    fields(page, ['snapshot', 'total', 'offset', 'data', 'next']);
    hash(page.snapshot); integer(page.total, 1, MAX_CODE_BYTES);
    integer(page.offset, 0, page.total - 1);
    check(page.offset === (cursor?.offset ?? 0), 'INVALID_RESPONSE');
    if (cursor !== null) {
        fields(cursor, ['snapshot', 'offset']);
        check(page.snapshot === cursor.snapshot, 'REQUEST_CONFLICT');
    }
    check(typeof page.data === 'string' && page.data.length > 0 &&
        page.data.length <= 4 * Math.ceil(CHUNK_BYTES / 3), 'INVALID_RESPONSE');
    const bytes = Buffer.from(page.data, 'base64');
    check(bytes.length > 0 && bytes.length <= CHUNK_BYTES &&
        bytes.toString('base64') === page.data, 'INVALID_RESPONSE');
    const end = page.offset + bytes.length;
    check(end <= page.total, 'INVALID_RESPONSE');
    if (page.next === null) check(end === page.total, 'INVALID_RESPONSE');
    else {
        fields(page.next, ['snapshot', 'offset']);
        check(end < page.total && page.next.snapshot === page.snapshot &&
            page.next.offset === end, 'INVALID_RESPONSE');
    }
    return bytes;
}
module.exports = { CodeSnapshot, codeBinding, codeDigest, validateCodePage, MAX_CODE_BYTES };