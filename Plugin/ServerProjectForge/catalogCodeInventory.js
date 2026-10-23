'use strict';
const crypto = require('node:crypto');
const { check, fields, identifier } = require('./hubNetworkProtocol');
const { MAX_BYTES } = require('./catalogInventory');
const { canonicalEngineeringInventory } = require('./catalogEngineeringInventory');
const { validateCodeSnapshot } = require('./catalogCodeSnapshot');

// Opt-in v3 only. Legacy inventory and engineering bytes remain unchanged.
// No authorization is inferred from this envelope or its digest.
function canonicalCodeInventory(sourceId, records, details, codes) {
    identifier(sourceId);
    const engineering = canonicalEngineeringInventory(sourceId, records, details);
    const base = JSON.parse(engineering.payload);
    check(Array.isArray(codes) && codes.length <= 8192, 'LIMIT_EXCEEDED');
    check(codes.length === base.records.length, 'CONTENT_BINDING');
    const detailById = new Map(base.details.map(row => [row.localProjectId, row.detail]));
    const seen = new Set();
    // Includes envelope overhead; final exact serialization is checked below.
    let bytes = Buffer.byteLength(engineering.payload, 'utf8') + 10;
    const projected = codes.map(entry => {
        fields(entry, ['localProjectId', 'code']);
        identifier(entry.localProjectId);
        check(detailById.has(entry.localProjectId) && !seen.has(entry.localProjectId),
            'CONTENT_BINDING');
        seen.add(entry.localProjectId);
        const row = {
            localProjectId: entry.localProjectId,
            code: validateCodeSnapshot(entry.code, detailById.get(entry.localProjectId)),
        };
        bytes += Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
        check(bytes <= MAX_BYTES, 'LIMIT_EXCEEDED');
        return row;
    }).sort((a, b) => a.localProjectId < b.localProjectId ? -1
        : a.localProjectId > b.localProjectId ? 1 : 0);
    const payload = JSON.stringify({
        version: 3, records: base.records, details: base.details, codes: projected,
    });
    check(Buffer.byteLength(payload, 'utf8') <= MAX_BYTES, 'LIMIT_EXCEEDED');
    return { payload, digest: crypto.createHash('sha256').update(payload).digest('hex') };
}

module.exports = { canonicalCodeInventory };