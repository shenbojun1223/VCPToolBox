'use strict';
const crypto = require('node:crypto');
const { check, integer, fields } = require('./hubNetworkProtocol');
const { projectSummary, todoDetail } = require('./catalogProjection');

// INTERNAL capability: callers must authorize and read a consistent source
// snapshot BEFORE invoking this module. A snapshot hash is NOT authorization.
// One instance is retained for an entire paginated read; it is never refreshed
// in place. HTTP envelope bytes must be reserved by the transport adapter.
const MAX_PROJECTS = 8192;
const MAX_TODOS = 50000;
const MAX_BYTES = 32 * 1024 * 1024;
const PAGE_BYTES = 48 * 1024;
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

class CatalogSnapshot {
    #projects;
    #details;
    #id;

    constructor(records) {
        check(Array.isArray(records) && records.length <= MAX_PROJECTS, 'LIMIT_EXCEEDED');
        const entries = [];
        const keys = new Set();
        let size = 2, todoCount = 0;
        for (const record of records) {
            fields(record, ['project', 'todos', 'identity']);
            check(Array.isArray(record.todos), 'INVALID_ARGUMENT');
            todoCount += record.todos.length;
            check(todoCount <= MAX_TODOS, 'LIMIT_EXCEEDED');
            const summary = projectSummary(record.project, record.todos, record.identity);
            // Duplicate globals require authority resolution BEFORE projection.
            // Never choose a winner by source timestamp or by array order.
            check(!keys.has(summary.key), 'REQUEST_CONFLICT');
            keys.add(summary.key);
            const todos = record.todos.map(t => todoDetail(t, summary.localProjectId))
                .sort((a, b) => a.seq - b.seq);
            const entry = { summary, todos };
            size += bytes(entry) + 1;
            check(size <= MAX_BYTES, 'LIMIT_EXCEEDED');
            entries.push(entry);
        }
        // Locale-independent order is stable across devices.
        entries.sort((a, b) => a.summary.key < b.summary.key ? -1 : a.summary.key > b.summary.key ? 1 : 0);
        this.#id = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
        this.#projects = entries.map(e => e.summary);
        this.#details = new Map(entries.map(e => [e.summary.key, e.todos]));
    }

    get id() { return this.#id; }

    #page(rows, kind, key, { cursor = null, limit = 50, maxBytes = PAGE_BYTES } = {}) {
        integer(limit, 1, 200);
        integer(maxBytes, 256, PAGE_BYTES);
        let start = 0;
        if (cursor !== null) {
            fields(cursor, ['snapshot', 'kind', 'key', 'offset']);
            check(cursor.snapshot === this.#id && cursor.kind === kind && cursor.key === key,
                'REQUEST_CONFLICT');
            integer(cursor.offset, 1, rows.length);
            start = cursor.offset;
        }
        const next = offset => offset < rows.length
            ? { snapshot: this.#id, kind, key, offset } : null;
        const page = { snapshot: this.#id, kind, key, total: rows.length, items: [], next: next(start) };
        check(bytes(page) <= maxBytes, 'LIMIT_EXCEEDED');
        let offset = start;
        while (offset < rows.length && page.items.length < limit) {
            const candidate = {
                ...page, items: [...page.items, rows[offset]], next: next(offset + 1),
            };
            if (bytes(candidate) > maxBytes) {
                // An oversized single item must not produce an endless empty page.
                check(page.items.length > 0, 'LIMIT_EXCEEDED');
                break;
            }
            page.items = candidate.items;
            page.next = candidate.next;
            offset++;
        }
        // Callers cannot mutate retained state via returned rows or cursors.
        return JSON.parse(JSON.stringify(page));
    }

    list(options) { return this.#page(this.#projects, 'projects', null, options); }

    todos(key, options) {
        check(typeof key === 'string' && this.#details.has(key), 'NOT_FOUND');
        return this.#page(this.#details.get(key), 'todos', key, options);
    }
}

module.exports = { CatalogSnapshot };