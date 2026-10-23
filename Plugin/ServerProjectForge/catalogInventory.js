'use strict';
const crypto = require('node:crypto');
const { check, identifier } = require('./hubNetworkProtocol');
const { CatalogSnapshot } = require('./catalogSnapshot');
const MAX_BYTES = 32 * 1024 * 1024;

// A COMPLETE ordinary-project inventory, never an incomplete scan.
// Shared by publisher and Hub so private row fields never enter transport.
// No DB, credentials, timers or network effects.
function canonicalRecords(sourceId, records) {
    identifier(sourceId);
    check(Array.isArray(records) && records.length <= 8192, 'LIMIT_EXCEEDED');
    new CatalogSnapshot(records);
    const clean = records.map(({ project: p, todos, identity }) => {
        check(identity.sourceId === sourceId &&
            (identity.globalProjectId === undefined || identity.globalProjectId === null),
        'CONTENT_BINDING');
        return {
            identity: { sourceId, localProjectId: p.id, globalProjectId: null },
            project: {
                id: p.id, name: p.name, status: p.status, availability: 'ready',
                created_at: p.created_at, updated_at: p.updated_at, deleted_at: p.deleted_at ?? null,
            },
            todos: todos.map(t => ({
                project_id: p.id, seq: t.seq, status: t.status, title: t.title,
                note: t.note ?? null, updated_by: t.updated_by ?? null, updated_at: t.updated_at,
            })).sort((a, b) => a.seq - b.seq),
        };
    }).sort((a, b) => a.project.id < b.project.id ? -1 : a.project.id > b.project.id ? 1 : 0);
    const payload = JSON.stringify(clean);
    check(Buffer.byteLength(payload, 'utf8') <= MAX_BYTES, 'LIMIT_EXCEEDED');
    return { payload, digest: crypto.createHash('sha256').update(payload).digest('hex') };
}

module.exports = { canonicalRecords, MAX_BYTES };