/* Shared read-only codec. Binding validation is not a signature or proof of evidence contents. */
(function (root, factory) {
    'use strict';
    const value = factory();
    if (typeof module === 'object' && module.exports) module.exports = value;
    else root.ForgeDelegationReviewRecord = value;
})(typeof globalThis === 'object' ? globalThis : this, function () {
    'use strict';
    const START = '[[ForgeReview::v1]]\n', END = '\n[[/ForgeReview]]\n';
    const HOST_START = '[[ForgeDelegation::v1]]\n', HOST_END = '\n[[/ForgeDelegation]]\n';
    const STATES = Object.freeze({ queued: 'pending', running: 'working', waiting: 'working',
        cancelling: 'working', completed: 'review', failed: 'unknown', cancelled: 'unknown', stopped: 'unknown' });
    const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stopped']);
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const plain = o => o !== null && typeof o === 'object' && !Array.isArray(o);
    const exact = (o, keys) => plain(o) && Object.keys(o).length === keys.length && keys.every(k => own(o, k));
    const string = (v, max, empty = false) => typeof v === 'string' && (empty || v.trim().length > 0)
        && v.length <= max && !/[\r\n\0]/.test(v);
    const positive = n => Number.isSafeInteger(n) && n > 0;
    const iso = v => {
        try { return typeof v === 'string' && new Date(v).toISOString() === v; } catch { return false; }
    };
    const project = v => typeof v === 'string' && /^p[A-Za-z0-9_-]{1,127}$/.test(v);
    const delegation = v => typeof v === 'string' && /^aa-delegation-\d{10,16}-[a-f0-9]{8}$/.test(v);
    const principal = v => typeof v === 'string'
        ? v.trim().replace(/^@+/, '').split('#')[0].trim().toLowerCase() : '';
    function independent(reviewer, role) {
        const who = principal(reviewer);
        return Boolean(who && who !== principal(role) && !['agentassistant', 'assistant'].includes(who));
    }
    function readRuntime(raw, context = {}) {
        if (typeof raw !== 'string' || !raw.startsWith(HOST_START)) return null;
        const at = raw.indexOf(HOST_END, HOST_START.length);
        if (at < 0 || at > 2048) return null;
        try {
            const d = JSON.parse(raw.slice(HOST_START.length, at));
            if (!exact(d, ['version', 'projectId', 'todoId', 'todoSeq', 'delegationId', 'role',
                'assignedBy', 'sessionId', 'runtimeStatus', 'stage', 'sequence', 'updatedAt'])
                || d.version !== 1 || !project(d.projectId) || !positive(d.todoId) || !positive(d.todoSeq)
                || !delegation(d.delegationId) || !string(d.role, 100) || !string(d.assignedBy, 100)
                || !string(d.sessionId, 256, true) || typeof d.runtimeStatus !== 'string'
                || !own(STATES, d.runtimeStatus) || d.stage !== STATES[d.runtimeStatus]
                || !Number.isSafeInteger(d.sequence) || d.sequence < 0 || !iso(d.updatedAt)) return null;
            for (const key of ['projectId', 'todoId', 'todoSeq']) {
                if (context[key] !== undefined && context[key] !== d[key]) return null;
            }
            return { data: d, end: at + HOST_END.length };
        } catch { return null; }
    }
    function validReview(r, runtime) {
        const d = runtime?.data;
        if (!d || !exact(r, ['version', 'projectId', 'todoId', 'todoSeq', 'delegationId',
            'runtimeSequence', 'runtimeUpdatedAt', 'revision', 'requestId', 'verdict', 'reviewedBy',
            'reviewedAt', 'scope', 'evidence', 'reason'])) return false;
        return r.version === 1 && r.projectId === d.projectId && r.todoId === d.todoId
            && r.todoSeq === d.todoSeq && r.delegationId === d.delegationId
            && r.runtimeSequence === d.sequence && r.runtimeUpdatedAt === d.updatedAt
            && positive(r.revision) && string(r.requestId, 100)
            && ['passed', 'rejected'].includes(r.verdict) && TERMINAL.has(d.runtimeStatus)
            && (r.verdict !== 'passed' || d.runtimeStatus === 'completed')
            && string(r.reviewedBy, 100) && independent(r.reviewedBy, d.role)
            && iso(r.reviewedAt) && Date.parse(r.reviewedAt) >= Date.parse(d.updatedAt)
            && string(r.scope, 180) && string(r.reason, 240)
            && exact(r.evidence, ['ref', 'sha256']) && string(r.evidence.ref, 220)
            && typeof r.evidence.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.evidence.sha256);
    }
    function readReview(raw, runtime) {
        if (!runtime || typeof raw !== 'string' || !raw.startsWith(START, runtime.end)) return null;
        const current = readRuntime(raw);
        if (!current || current.end !== runtime.end
            || JSON.stringify(current.data) !== JSON.stringify(runtime.data)) return null;
        const start = runtime.end + START.length, at = raw.indexOf(END, start);
        // Must be wholly available within the existing 2048-character catalog preview.
        if (at < 0 || at + END.length > 2048) return null;
        try {
            const value = JSON.parse(raw.slice(start, at));
            return validReview(value, runtime) ? value : null;
        } catch { return null; }
    }
    function compose(raw, review) {
        const runtime = readRuntime(raw);
        if (!runtime || (review !== null && !validReview(review, runtime))) throw new Error('REVIEW_RECORD_INVALID');
        // A null prefix prevents untrusted original prose from becoming a synthetic review.
        const head = raw.slice(0, runtime.end) + START + JSON.stringify(review) + END;
        if (head.length > 2048) throw new Error('REVIEW_PREVIEW_LIMIT');
        return head + raw.slice(runtime.end);
    }
    return Object.freeze({ START, END, readRuntime, validReview, readReview, compose, independent });
});