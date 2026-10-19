'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const PREFIX = 'project_writer:';
const gates = new WeakMap(), context = new AsyncLocalStorage();
class WriteGateError extends Error {
    constructor(code) { super(code); this.name = 'WriteGateError'; this.code = code; }
}
const check = (ok, code = 'WRITE_LEASE_REQUIRED') => { if (!ok) throw new WriteGateError(code); };
function overlaps(a, b) {
    const rel = (x, y) => path.relative(path.resolve(x), path.resolve(y));
    const inside = r => !r || (!path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep));
    return inside(rel(a, b)) || inside(rel(b, a));
}
function bindings(store) {
    return store.db.prepare('SELECT value FROM meta WHERE key LIKE ?').all(PREFIX + '%').map(r => JSON.parse(r.value));
}
function binding(store, id) {
    const r = store.db.prepare('SELECT value FROM meta WHERE key=?').get(PREFIX + id);
    return r ? JSON.parse(r.value) : null;
}
function bind(store, localProjectId, { hubId, globalProjectId, mappingId }, gate) {
    const p = store.db.prepare('SELECT * FROM projects WHERE id=?').get(localProjectId);
    check(p && typeof hubId === 'string' && (globalProjectId === null || typeof globalProjectId === 'string') && typeof mappingId === 'string', 'WRITE_BINDING');
    const value = { localProjectId, hubId, globalProjectId, mappingId, root: path.resolve(p.root) };
    store.db.transaction(() => {
        const previous = binding(store, localProjectId);
        check(!previous || JSON.stringify(previous) === JSON.stringify(value) ||
            (previous.globalProjectId === null && JSON.stringify({ ...previous, globalProjectId }) === JSON.stringify(value)), 'WRITE_BINDING');
        if (previous && previous.globalProjectId === null) store.db.prepare('UPDATE meta SET value=? WHERE key=?')
            .run(JSON.stringify(value), PREFIX + localProjectId);
        store.db.prepare("UPDATE meta SET value='5' WHERE key='schema_version' AND value!='6'").run();
        check(!bindings(store).some(b => b.localProjectId !== localProjectId && overlaps(b.root, value.root)), 'WRITE_SCOPE');
        if (!previous) store.db.prepare('INSERT INTO meta VALUES (?,?)').run(PREFIX + localProjectId, JSON.stringify(value));
    }).immediate();
    if (gate) {
        let map = gates.get(store); if (!map) gates.set(store, map = new Map());
        check(!map.has(localProjectId) || map.get(localProjectId) === gate, 'WRITE_BINDING');
        map.set(localProjectId, gate);
    }
    return value;
}
function detach(store, id, gate) {
    if (gates.get(store)?.get(id) === gate) gates.get(store).delete(id);
}
function gateFor(store, id) { return gates.get(store)?.get(id); }
function changed(store, ids) {
    for (const id of new Set(ids)) gateFor(store, id)?.onChanged?.();
}
function assertFilesystem(store, absolute) {
    for (const b of bindings(store)) {
        if (!overlaps(b.root, absolute)) continue;
        const gate = gateFor(store, b.localProjectId), token = context.getStore();
        check(gate && token?.gate === gate && token.live && token.epoch === gate.epoch && token.fence === gate.fence, 'WRITE_SCOPE');
        gate.assert();
    }
}
function assertWrite(store, id) {
    if (!binding(store, id)) return;
    const gate = gateFor(store, id); check(gate); gate.assert();
}
function assertPath(store, projectId, absolute) {
    for (const b of bindings(store)) {
        if (!overlaps(b.root, absolute)) continue;
        check(b.localProjectId === projectId, 'WRITE_SCOPE'); assertWrite(store, b.localProjectId);
    }
}
function assertRootFree(store, root, except = null) {
    check(!bindings(store).some(b => b.localProjectId !== except && overlaps(b.root, root)), 'WRITE_SCOPE');
}
async function run(store, ids, fn) {
    const selected = [...new Set(ids)].filter(id => binding(store, id));
    for (const id of selected) assertWrite(store, id); // Bulk preflight before admitting any mutation.
    const enter = index => index === selected.length ? fn() : gateFor(store, selected[index]).run(() => enter(index + 1));
    return enter(0);
}
class WriterGate {
    constructor({ now = () => performance.now(), safetyMs = 100, drainMs = 15000 } = {}) {
        check(Number.isFinite(safetyMs) && safetyMs >= 0 && Number.isFinite(drainMs) && drainMs > 0, 'INVALID_ARGUMENT');
        this.now = now; this.safetyMs = safetyMs; this.drainMs = drainMs;
        this.phase = 'closed'; this.deadline = 0; this.fence = 0; this.active = 0; this.waiters = new Set();
        this.timer = null; this.abort = new AbortController(); this.epoch = 0;
    }
    grant(lease, began, ttlMs) {
        const deadline = began + ttlMs - this.safetyMs;
        check(Number.isFinite(deadline) && this.now() < deadline && Number.isSafeInteger(lease.fence), 'LEASE_TOO_SHORT');
        const continuing = this.fence === lease.fence && ['open', 'draining', 'frozen'].includes(this.phase);
        if (!continuing) { check(this.active === 0, 'WRITER_ACTIVE'); this.epoch++; this.abort = new AbortController(); this.phase = 'open'; }
        this.fence = lease.fence; this.deadline = deadline;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.lose(), Math.max(1, deadline - this.now()));
        this.timer.unref?.();
    }
    assert() {
        if (this.now() >= this.deadline) this.lose();
        this.verify?.();
        const token = context.getStore();
        check(!token || (token.live && token.gate === this && token.epoch === this.epoch && token.fence === this.fence));
        check(this.phase === 'open' || (this.phase === 'draining' && token?.gate === this && token.fence === this.fence));
    }
    async run(fn) {
        const existing = context.getStore();
        if (existing?.gate === this) { this.assert(); return fn(); }
        check(this.phase === 'open'); this.assert(); this.active++;
        const token = { gate: this, fence: this.fence, epoch: this.epoch, live: true };
        try { return await context.run(token, () => fn(this.abort.signal)); }
        finally { token.live = false; this.active--; if (!this.active) { for (const wake of this.waiters) wake(); this.waiters.clear(); } }
    }
    seal(stopExternal = false) {
        check(this.now() < this.deadline && ['open', 'draining', 'frozen'].includes(this.phase));
        if (this.phase === 'open') this.phase = 'draining';
        if (stopExternal) this.abort.abort();
    }
    async drain({ stopExternal = false } = {}) {
        this.seal(stopExternal);
        if (this.phase === 'frozen') return;
        if (this.active) await new Promise((resolve, reject) => {
            const wake = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { this.waiters.delete(wake); this.lose(); reject(new WriteGateError('WRITER_DRAIN_TIMEOUT')); }, this.drainMs);
            this.waiters.add(wake);
        });
        check(this.now() < this.deadline && this.phase === 'draining'); this.phase = 'frozen';
    }
    reopen() {
        check(this.phase === 'frozen' && this.now() < this.deadline);
        this.abort = new AbortController(); this.phase = 'open';
    }
    lose() {
        clearTimeout(this.timer); this.timer = null; this.phase = 'lost'; this.deadline = 0; this.abort.abort();
    }
    close() { this.lose(); }
    status() { return { phase: this.phase, active: this.active, fence: this.fence, writable: this.phase === 'open' && this.now() < this.deadline }; }
}
module.exports = { WriteGateError, WriterGate, bind, binding, bindings, detach, changed, gateFor, assertWrite, assertPath, assertFilesystem, assertRootFree, run };