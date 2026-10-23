'use strict';
const { check, identifier, integer, hash } = require('./hubNetworkProtocol');
const { readProjectPlanBundle } = require('./projectBundle');
const { projectSummary, todoDetail } = require('./catalogProjection');

const GLOBAL = /^g_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// INTERNAL, synchronous Hub adapter. The caller must authorize the global ID
// before calling. Only trusted HubStore capabilities belong here, never a
// renderer-supplied object. Does not refresh, register, import or acquire leases.
function readPublishedPlan(hub, globalProjectId) {
    check(typeof globalProjectId === 'string' && GLOBAL.test(globalProjectId), 'INVALID_ARGUMENT');
    check(hub && typeof hub.getProject === 'function' &&
        typeof hub.downloadRevision === 'function', 'INVALID_ARGUMENT');
    const head = hub.getProject(globalProjectId);
    check(head && head.id === globalProjectId, 'CONTENT_BINDING');
    identifier(head.originId);
    identifier(head.localProjectId);
    integer(head.revision);
    // Registered but not published is not an empty or deleted plan.
    check(head.revision > 0, 'CONTENT_NOT_FOUND');
    hash(head.bundleHash);
    const downloaded = hub.downloadRevision(globalProjectId, head.revision);
    const r = downloaded?.revision;
    check(r && r.projectId === globalProjectId && r.revision === head.revision &&
        r.bundleHash === head.bundleHash, 'CONTENT_BINDING');
    integer(r.baseRevision);
    check(r.baseRevision + 1 === r.revision, 'CONTENT_BINDING');
    integer(r.publishedAt);
    const plan = readProjectPlanBundle(downloaded.bytes, { expectedHash: head.bundleHash });

    // A received replica has different local primary keys. Hub origin identity
    // is authoritative; the checkpoint's local project ID is not a new source.
    const identity = {
        sourceId: head.originId,
        localProjectId: head.localProjectId,
        globalProjectId,
    };
    const project = {
        ...plan.project,
        id: identity.localProjectId,
        availability: 'ready',
        // Current bundle format cannot publish soft deletion. Do not infer it
        // from missing data; catalog removal requires a separate explicit path.
        deleted_at: null,
    };
    const todos = plan.todos.map(t => ({ ...t, project_id: identity.localProjectId }));
    // Validate presentation compatibility before handing the record onward.
    projectSummary(project, todos, identity);
    todos.forEach(t => todoDetail(t, identity.localProjectId));
    return {
        record: { project, todos, identity },
        publication: {
            globalProjectId,
            revision: r.revision,
            bundleHash: r.bundleHash,
            publishedAt: r.publishedAt,
        },
    };
}

module.exports = { readPublishedPlan };