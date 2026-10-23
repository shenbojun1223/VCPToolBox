'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const Database = require('better-sqlite3');
const hubModule = path.resolve(__dirname, '../../Plugin/ServerProjectForge/hubStore.js');
const { HubStore, MIN_TTL_MS, MAX_TTL_MS } = require(hubModule);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const hasCode = code => error => error.code === code;

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-hub-'));
    const dbPath = path.join(root, 'hub.db');
    let now = 100000;
    const stores = [];
    const open = () => {
        const hub = new HubStore(dbPath, { clock: () => now });
        stores.push(hub);
        return hub;
    };
    t.after(() => {
        for (const hub of stores) hub.close();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const hub = open();
    const project = hub.registerProject({ originId: 'desktop-A', localProjectId: 'p1234', name: '工程' });
    return {
        hub, project, root, dbPath, open,
        time: () => now,
        setTime: value => { now = value; },
        advance: delta => { now += delta; },
        acquire: (store = hub, extra = {}) => store.acquireLease({
            projectId: project.id, holder: 'desktop-A', requestId: 'acquire-1', ttlMs: 1000, ...extra,
        }),
    };
}
function publish(hub, lease, extra = {}) {
    return hub.publishRevision({
        ...lease, requestId: 'publish-1', expectedRevision: 0, bundleHash: HASH_A, ...extra,
    });
}

test('registration is global, source-scoped and idempotent', t => {
    const f = fixture(t);
    const again = f.hub.registerProject({ originId: 'desktop-A', localProjectId: 'p1234', name: '工程' });
    assert.equal(again.id, f.project.id);
    const other = f.hub.registerProject({ originId: 'desktop-B', localProjectId: 'p1234', name: '工程' });
    assert.notEqual(other.id, again.id);
    assert.match(again.id, /^g_[0-9a-f-]{36}$/);
    assert.equal(again.revision, 0);
    assert.equal(again.bundleHash, null);
    assert.throws(() => f.hub.registerProject({
        originId: 'desktop-A', localProjectId: 'p1234', name: 'different',
    }), hasCode('REQUEST_CONFLICT'));
});

test('public project view never exposes lease secret', t => {
    const f = fixture(t);
    const lease = f.acquire();
    const view = f.hub.getProject(f.project.id);
    assert.equal(view.lease.holder, lease.holder);
    assert.equal(view.lease.fence, 1);
    assert.ok(!JSON.stringify(view).includes(lease.leaseId));
    assert.equal(Object.hasOwn(view.lease, 'leaseId'), false);
});

test('an active lease blocks all new requests, even with same holder', t => {
    const f = fixture(t);
    f.acquire();
    for (const holder of ['desktop-A', 'desktop-B']) {
        assert.throws(() => f.acquire(f.open(), { holder, requestId: 'acquire-other' }), hasCode('LEASE_BUSY'));
    }
});

test('lost acquire acknowledgement replays same active grant, but changed payload fails', t => {
    const f = fixture(t);
    const lease = f.acquire();
    assert.deepEqual(f.acquire(f.open()), lease);
    assert.throws(() => f.acquire(f.hub, { ttlMs: 2000 }), hasCode('REQUEST_CONFLICT'));
    assert.equal(f.hub.getProject(f.project.id).fence, 1);
});

test('renewal keeps fence and cannot shorten current lease', t => {
    const f = fixture(t);
    const lease = f.acquire();
    f.advance(500);
    const renewed = f.hub.renewLease({ ...lease, ttlMs: 2000 });
    assert.equal(renewed.fence, lease.fence);
    assert.equal(renewed.leaseId, lease.leaseId);
    assert.equal(renewed.expiresAt, f.time() + 2000);
    const shorter = f.hub.renewLease({ ...lease, ttlMs: 1000 });
    assert.equal(shorter.expiresAt, renewed.expiresAt);
    assert.equal(f.acquire().expiresAt, renewed.expiresAt);
});

test('expiration boundary is exclusive and stale request never regrants', t => {
    const f = fixture(t);
    const old = f.acquire();
    f.setTime(old.expiresAt);
    assert.equal(f.hub.getProject(f.project.id).lease, null);
    assert.throws(() => f.hub.renewLease(old), hasCode('LEASE_EXPIRED'));
    assert.throws(() => f.hub.releaseLease(old), hasCode('LEASE_EXPIRED'));
    assert.throws(() => publish(f.hub, old), hasCode('LEASE_EXPIRED'));
    assert.throws(() => f.acquire(), hasCode('STALE_REQUEST'));
    const next = f.acquire(f.hub, { holder: 'desktop-B', requestId: 'acquire-2' });
    assert.equal(next.fence, old.fence + 1);
    assert.notEqual(next.leaseId, old.leaseId);
});

test('old generation cannot renew, release, publish or replay after takeover', t => {
    const f = fixture(t);
    const old = f.acquire();
    publish(f.hub, old);
    f.advance(1000);
    const next = f.acquire(f.open(), { holder: 'desktop-B', requestId: 'acquire-2' });
    for (const action of [() => f.hub.renewLease(old), () => f.hub.releaseLease(old),
        () => publish(f.hub, old)]) assert.throws(action, hasCode('STALE_LEASE'));
    assert.equal(f.hub.getProject(f.project.id).lease.holder, next.holder);
    assert.equal(f.hub.getProject(f.project.id).revision, 1);
});

test('release preserves fencing history and invalidates original grant request', t => {
    const f = fixture(t);
    const first = f.acquire();
    assert.equal(f.hub.releaseLease(first).released, true);
    assert.equal(f.hub.getProject(f.project.id).lease, null);
    assert.throws(() => f.acquire(), hasCode('STALE_REQUEST'));
    const next = f.acquire(f.hub, { requestId: 'acquire-2' });
    assert.equal(next.fence, 2);
    assert.throws(() => f.hub.releaseLease(first), hasCode('STALE_LEASE'));
});

test('holder, secret, fence and project all participate in credential check', t => {
    const f = fixture(t);
    const lease = f.acquire();
    const other = f.hub.registerProject({ originId: 'desktop-A', localProjectId: 'p5678', name: 'other' });
    for (const altered of [
        { holder: 'impostor' }, { leaseId: '0'.repeat(64) }, { fence: lease.fence + 1 },
        { projectId: other.id },
    ]) assert.throws(() => publish(f.hub, { ...lease, ...altered }), hasCode('STALE_LEASE'));
});

test('CAS publish is atomic, exact request replay is idempotent, history immutable', t => {
    const f = fixture(t);
    const lease = f.acquire();
    const one = publish(f.hub, lease);
    assert.equal(one.revision, 1);
    assert.equal(one.baseRevision, 0);
    assert.deepEqual(publish(f.open(), lease), one);
    assert.throws(() => publish(f.hub, lease, { bundleHash: HASH_B }), hasCode('REQUEST_CONFLICT'));
    assert.throws(() => publish(f.hub, lease, { requestId: 'publish-2' }), hasCode('REVISION_CONFLICT'));
    assert.equal(f.hub.getProject(f.project.id).bundleHash, HASH_A);
    const two = publish(f.hub, lease, { requestId: 'publish-2', expectedRevision: 1, bundleHash: HASH_B });
    assert.equal(two.revision, 2);
    assert.deepEqual(f.hub.getRevision(f.project.id, 1), one);
    assert.deepEqual(f.hub.getRevision(f.project.id, 2), two);
    assert.equal(f.hub.getRevision(f.project.id, 3), null);
    assert.ok(!JSON.stringify(one).includes(lease.leaseId));
});

test('a new lease cannot reuse previous publish request even for identical hash', t => {
    const f = fixture(t);
    const lease = f.acquire();
    publish(f.hub, lease);
    f.hub.releaseLease(lease);
    const next = f.acquire(f.hub, { requestId: 'acquire-2' });
    assert.throws(() => publish(f.hub, next), hasCode('REQUEST_CONFLICT'));
});

test('reopening preserves identity, revision, lease and monotonically increasing fence', t => {
    const f = fixture(t);
    const lease = f.acquire();
    publish(f.hub, lease);
    f.hub.close();
    const reopened = f.open();
    assert.equal(reopened.getProject(f.project.id).revision, 1);
    assert.deepEqual(f.acquire(reopened), { ...lease, revision: 1 });
    f.advance(1000);
    const next = f.acquire(reopened, { requestId: 'acquire-2' });
    assert.equal(next.fence, 2);
    assert.equal(next.revision, 1);
});

test('clock rollback fails closed until central clock catches up', t => {
    const f = fixture(t);
    const lease = f.acquire();
    f.advance(500);
    f.hub.renewLease({ ...lease, ttlMs: 1000 });
    f.advance(-1);
    assert.throws(() => f.hub.getProject(f.project.id), hasCode('CLOCK_ROLLBACK'));
    assert.throws(() => publish(f.hub, lease), hasCode('CLOCK_ROLLBACK'));
    f.advance(1);
    assert.equal(publish(f.hub, lease).revision, 1);
});

test('bounds and malformed inputs reject before mutation', t => {
    const f = fixture(t);
    for (const ttlMs of [0, MIN_TTL_MS - 1, MAX_TTL_MS + 1, NaN, Infinity, '1000']) {
        assert.throws(() => f.acquire(f.hub, { ttlMs }), hasCode('INVALID_ARGUMENT'));
    }
    assert.equal(f.hub.getProject(f.project.id).fence, 0);
    assert.throws(() => f.acquire(f.hub, { holder: '../escape' }), hasCode('INVALID_ARGUMENT'));
    const lease = f.acquire();
    for (const extra of [{ expectedRevision: -1 }, { expectedRevision: '0' }, { bundleHash: 'bad' }]) {
        assert.throws(() => publish(f.hub, lease, extra), hasCode('INVALID_ARGUMENT'));
    }
    assert.equal(f.hub.getProject(f.project.id).revision, 0);
    assert.throws(() => f.hub.getProject('missing'), hasCode('NOT_FOUND'));
});

test('unsafe expiry arithmetic does not allocate a fence', t => {
    const f = fixture(t);
    f.setTime(Number.MAX_SAFE_INTEGER - 500);
    assert.throws(() => f.acquire(), hasCode('COUNTER_EXHAUSTED'));
    assert.equal(f.hub.getProject(f.project.id).fence, 0);
});

test('requires dedicated database and refuses to alter unrelated data', t => {
    const f = fixture(t);
    const dbPath = path.join(f.root, 'not-hub.db');
    const other = new Database(dbPath);
    other.exec('CREATE TABLE projects(id TEXT); INSERT INTO projects VALUES (\'untouched\')');
    other.close();
    const before = fs.readFileSync(dbPath);
    assert.throws(() => new HubStore(dbPath), hasCode('WRONG_DATABASE'));
    assert.deepEqual(fs.readFileSync(dbPath), before);
    assert.throws(() => new HubStore(''), hasCode('INVALID_ARGUMENT'));
});

test('unknown Hub schema is rejected without migration', t => {
    const f = fixture(t);
    f.hub.close();
    const db = new Database(f.dbPath);
    db.prepare("UPDATE hub_meta SET value='999' WHERE key='schema_version'").run();
    db.close();
    assert.throws(() => new HubStore(f.dbPath), hasCode('SCHEMA_VERSION'));
});

test('closed connection gives structured error; close is idempotent', t => {
    const f = fixture(t);
    f.hub.close();
    f.hub.close();
    assert.throws(() => f.hub.getProject(f.project.id), hasCode('CLOSED'));
});

// Each worker owns an independent SQLite connection. A ready/go barrier makes
// all contenders race the same state; no shared JS mutex can accidentally pass this test.
async function race(t, f, mode, lease = null) {
    const workers = [];
    t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
    const code = `
        const { parentPort, workerData: d } = require('node:worker_threads');
        const { HubStore } = require(d.module);
        let hub;
        try {
            hub = new HubStore(d.dbPath, { clock: () => d.now, busyTimeoutMs: 10000 });
            parentPort.postMessage({ ready: true });
            parentPort.once('message', () => {
                let result;
                try {
                    const value = d.mode === 'lease'
                        ? hub.acquireLease({ projectId: d.projectId, holder: 'worker-' + d.index,
                            requestId: 'race-acquire', ttlMs: 1000 })
                        : hub.publishRevision({ ...d.lease, requestId: 'race-publish-' + d.index,
                            expectedRevision: 0, bundleHash: 'a'.repeat(64) });
                    result = { ok: true, value };
                } catch (error) { result = { ok: false, code: error.code, message: error.message }; }
                hub.close();
                parentPort.postMessage({ result });
                parentPort.close();
            });
        } catch (error) {
            if (hub) hub.close();
            parentPort.postMessage({ fatal: error.stack });
            parentPort.close();
        }
    `;
    const jobs = Array.from({ length: 6 }, (_, index) => {
        const worker = new Worker(code, { eval: true, workerData: {
            module: hubModule, dbPath: f.dbPath, now: f.time(),
            projectId: f.project.id, index, mode, lease,
        } });
        workers.push(worker);
        let onReady;
        const ready = new Promise(resolve => { onReady = resolve; });
        const done = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Hub concurrency test timed out')), 20000);
            worker.on('message', message => {
                if (message.ready) onReady();
                if (message.fatal) reject(new Error(message.fatal));
                if (message.result) resolve(message.result);
            });
            worker.once('error', reject);
            worker.once('exit', code => {
                clearTimeout(timeout);
                if (code !== 0) reject(new Error('Worker exit ' + code));
            });
        });
        // Attach rejection handling before waiting at the barrier.
        done.catch(() => {});
        return { worker, ready, done };
    });
    await Promise.all(jobs.map(job => Promise.race([
        job.ready, job.done.then(() => { throw new Error('Worker exited before ready'); }),
    ])));
    for (const job of jobs) job.worker.postMessage('go');
    return Promise.all(jobs.map(job => job.done));
}

test('real concurrent independent connections grant exactly one lease', async t => {
    const f = fixture(t);
    const results = await race(t, f, 'lease');
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
    assert.deepEqual(results.filter(result => !result.ok).map(result => result.code),
        Array(5).fill('LEASE_BUSY'));
    assert.equal(f.hub.getProject(f.project.id).fence, 1);
});

test('real concurrent CAS publishers commit exactly one revision', async t => {
    const f = fixture(t);
    const lease = f.acquire();
    const results = await race(t, f, 'publish', lease);
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
    assert.deepEqual(results.filter(result => !result.ok).map(result => result.code),
        Array(5).fill('REVISION_CONFLICT'));
    assert.equal(f.hub.getProject(f.project.id).revision, 1);
});
test('catalog enumeration is empty by default and scoped by origin or explicit project', t => {
    const f = fixture(t);
    const b = f.hub.registerProject({ originId: 'desktop-B', localProjectId: 'p1234', name: 'B' });
    const hidden = f.hub.registerProject({ originId: 'private-C', localProjectId: 'p1234', name: 'private' });
    assert.deepEqual(f.hub.listProjects(), { items: [], next: null });
    assert.deepEqual(f.hub.listProjects({ originIds: ['unknown'] }), { items: [], next: null });
    const page = f.hub.listProjects({
        originIds: ['desktop-A', 'desktop-A'],
        projectIds: [f.project.id, b.id, b.id],
    });
    assert.deepEqual(page.items.map(p => p.id).sort(), [f.project.id, b.id].sort());
    assert.equal(page.next, null);
    assert.equal(JSON.stringify(page).includes(hidden.id), false);
    assert.equal(JSON.stringify(page).includes('private-C'), false);
});

test('catalog enumeration filters before pagination and returns every authorized ID once', t => {
    const f = fixture(t);
    const expected = [f.project.id];
    for (let i = 0; i < 37; i++) {
        expected.push(f.hub.registerProject({
            originId: 'desktop-A', localProjectId: 'visible-' + i, name: 'visible',
        }).id);
        f.hub.registerProject({
            originId: 'hidden', localProjectId: 'hidden-' + i, name: 'hidden',
        });
    }
    const found = [];
    let after = '';
    do {
        const page = f.hub.listProjects({ originIds: ['desktop-A'], after, limit: 7 });
        assert.ok(page.items.length > 0 && page.items.length <= 7);
        assert.ok(page.items.every(p => p.originId === 'desktop-A'));
        if (page.next !== null) {
            assert.equal(page.items.length, 7);
            assert.equal(page.next, page.items.at(-1).id);
        }
        found.push(...page.items.map(p => p.id));
        after = page.next;
    } while (after !== null);
    assert.deepEqual(found, expected.sort());
    assert.equal(new Set(found).size, expected.length);
});

test('catalog enumeration neither exposes lease secrets nor changes Hub records', t => {
    const f = fixture(t), lease = f.acquire();
    const snapshot = () => Object.fromEntries(
        ['hub_meta', 'hub_projects', 'hub_revisions', 'hub_lease_requests'].map(table =>
            [table, f.hub.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();
    const page = f.hub.listProjects({ projectIds: [f.project.id] });
    assert.equal(page.items[0].lease.holder, lease.holder);
    assert.equal(JSON.stringify(page).includes(lease.leaseId), false);
    assert.deepEqual(snapshot(), before);
    f.setTime(lease.expiresAt);
    assert.equal(f.hub.listProjects({ projectIds: [f.project.id] }).items[0].lease, null);
    assert.deepEqual(snapshot(), before);
});

test('catalog enumeration rejects malformed scopes and page bounds', t => {
    const f = fixture(t);
    for (const args of [
        { originIds: '*' }, { projectIds: null },
        { originIds: Array(257).fill('A') },
        { projectIds: Array(257).fill('A') },
        { originIds: ['bad/id'] }, { projectIds: ['bad id'] },
        { after: null }, { after: '../secret' },
        { limit: 0 }, { limit: 201 }, { limit: 1.5 },
    ]) {
        assert.throws(() => f.hub.listProjects(args), hasCode('INVALID_ARGUMENT'));
    }
});