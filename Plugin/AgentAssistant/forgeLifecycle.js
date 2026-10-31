'use strict';
// Same-host ServerProjectForge only. Never infer targets from prompt/session text.
const STATES = new Set(['running', 'waiting', 'cancelling', 'completed', 'failed', 'cancelled', 'stopped']);
const error = code => Object.assign(new Error(code), { code });
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
function parse(args) {
    if (!['forge_project_id', 'forge_todo_seq', 'forge_role'].some(k => own(args, k))) return null;
    if (String(args.task_delegation).toLowerCase() !== 'true' || args.timely_contact ||
        args.query_delegation || args.cancel_delegation) throw error('FORGE_BINDING_MODE');
    const projectId = args.forge_project_id, raw = args.forge_todo_seq;
    if (typeof projectId !== 'string' || !/^p[A-Za-z0-9_-]{1,127}$/.test(projectId) ||
        !(Number.isSafeInteger(raw) || (typeof raw === 'string' && /^[1-9]\d{0,8}$/.test(raw)))) {
        throw error('FORGE_BINDING_ARGUMENT');
    }
    const todoSeq = Number(raw);
    if (!Number.isSafeInteger(todoSeq) || todoSeq < 1) throw error('FORGE_BINDING_ARGUMENT');
    if (args.forge_role !== undefined && (typeof args.forge_role !== 'string' ||
        !args.forge_role.trim() || args.forge_role.length > 100 || /[\r\n\0]/.test(args.forge_role))) {
        throw error('FORGE_BINDING_ARGUMENT');
    }
    return { projectId, todoSeq, role: args.forge_role?.trim() };
}
async function bind(binding, { delegationId, agentName, senderName, sessionId }, resolve) {
    if (!binding) return null;
    const api = resolve()?.delegations;
    if (typeof api?.bind !== 'function' || typeof api?.advance !== 'function') throw error('FORGE_BINDING_UNAVAILABLE');
    await api.bind({ projectId: binding.projectId, todoSeq: binding.todoSeq, delegationId,
        role: binding.role || agentName, assignedBy: senderName, sessionId: String(sessionId || '').trim() });
    return { api, projectId: binding.projectId, todoSeq: binding.todoSeq, delegationId,
        sequence: 0, queue: Promise.resolve(), lastError: null };
}
function advance(tracking, status) {
    if (!tracking) return Promise.resolve();
    if (!STATES.has(status)) return Promise.reject(error('FORGE_LIFECYCLE_ARGUMENT'));
    const sequence = ++tracking.sequence;
    const operation = tracking.queue.then(() => tracking.api.advance({
        projectId: tracking.projectId, todoSeq: tracking.todoSeq,
        delegationId: tracking.delegationId, sequence, status,
    }));
    tracking.queue = operation.catch(e => {
        const safe = new Set(['DELEGATION_STALE', 'DELEGATION_TARGET', 'DELEGATION_BUSY',
            'WRITE_LEASE_REQUIRED', 'WRITE_SCOPE', 'NOT_FOUND']);
        tracking.lastError = safe.has(e?.code) ? e.code : 'FORGE_STATUS_SYNC_FAILED';
    });
    return operation;
}
function snapshot(tracking) {
    return tracking ? { projectId: tracking.projectId, todoSeq: tracking.todoSeq,
        delegationId: tracking.delegationId, sequence: tracking.sequence,
        syncError: tracking.lastError } : null;
}
module.exports = { parse, bind, advance, snapshot };