'use strict';

// Display-only projection. The host must verify any supplied global mapping.
// Never spread database rows into a network response.
const { check, identifier, integer } = require('./hubNetworkProtocol');
const GLOBAL = /^g_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_STATES = new Set(['active', 'review', 'accepted']);
const TODO_STATES = new Set(['pending', 'doing', 'done', 'blocked']);

function text(value, maximum) {
    check(typeof value === 'string' && value.length <= maximum, 'INVALID_ARGUMENT');
    return value;
}

function timestamp(value, nullable = false) {
    if (nullable && value === null) return null;
    check(typeof value === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
        Number.isFinite(Date.parse(value)), 'INVALID_ARGUMENT');
    const canonical = value.includes('.') ? value : value.slice(0, -1) + '.000Z';
    check(new Date(value).toISOString() === canonical, 'INVALID_ARGUMENT');
    return value;
}

function catalogIdentity({ sourceId, localProjectId, globalProjectId = null }) {
    identifier(sourceId);
    identifier(localProjectId);
    if (globalProjectId !== null) {
        check(typeof globalProjectId === 'string' && GLOBAL.test(globalProjectId), 'INVALID_ARGUMENT');
    }
    // JSON tuple encoding avoids delimiter collisions. A short local ID is not global.
    return {
        key: globalProjectId === null
            ? JSON.stringify(['local', sourceId, localProjectId])
            : JSON.stringify(['global', globalProjectId]),
        sourceId,
        localProjectId,
        globalProjectId,
    };
}

function projectSummary(project, todos, identity) {
    check(project && typeof project === 'object' && !Array.isArray(project), 'INVALID_ARGUMENT');
    const reference = catalogIdentity(identity);
    check(project.id === reference.localProjectId, 'INVALID_ARGUMENT');
    // Do not expose partial imports or a project currently being advanced.
    // The caller additionally uses Store.listProjects(), which excludes update markers.
    check(project.availability === 'ready', 'INVALID_ARGUMENT');
    check(PROJECT_STATES.has(project.status), 'INVALID_ARGUMENT');
    check(Array.isArray(todos), 'INVALID_ARGUMENT');
    const progress = { total: todos.length, pending: 0, doing: 0, done: 0, blocked: 0 };
    const sequences = new Set();
    for (const todo of todos) {
        check(todo && todo.project_id === project.id && TODO_STATES.has(todo.status), 'INVALID_ARGUMENT');
        integer(todo.seq, 1);
        check(!sequences.has(todo.seq), 'INVALID_ARGUMENT');
        sequences.add(todo.seq);
        progress[todo.status]++;
    }
    return {
        ...reference,
        name: text(project.name, 4096),
        status: project.status,
        createdAt: timestamp(project.created_at),
        updatedAt: timestamp(project.updated_at),
        deletedAt: timestamp(project.deleted_at ?? null, true),
        progress,
    };
}

// These are per-field preview limits, not a guarantee of page byte size.
// Paging and transport byte budgets must be enforced by the caller using
// serialized UTF-8 bytes. Never silently truncate the number of todos.
function clipped(value, maximum, field, truncated) {
    if (value === null || value === undefined) return null;
    check(typeof value === 'string', 'INVALID_ARGUMENT');
    if (value.length <= maximum) return value;
    truncated.push(field);
    let end = maximum;
    // Do not split a UTF-16 surrogate pair at the preview boundary.
    if (/[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end--;
    return value.slice(0, end);
}

function todoDetail(todo, localProjectId) {
    identifier(localProjectId);
    check(todo && typeof todo === 'object' && !Array.isArray(todo) &&
        todo.project_id === localProjectId && TODO_STATES.has(todo.status), 'INVALID_ARGUMENT');
    integer(todo.seq, 1);
    check(typeof todo.title === 'string', 'INVALID_ARGUMENT');
    const truncated = [];
    return {
        seq: todo.seq,
        status: todo.status,
        title: clipped(todo.title, 512, 'title', truncated),
        note: clipped(todo.note, 2048, 'note', truncated),
        updatedBy: clipped(todo.updated_by, 100, 'updatedBy', truncated),
        updatedAt: timestamp(todo.updated_at),
        truncated,
    };
}

module.exports = { catalogIdentity, projectSummary, todoDetail };