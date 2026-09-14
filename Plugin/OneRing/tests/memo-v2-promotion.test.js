'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const test = require('node:test');

const { MemoV2Store } = require('../lib/MemoV2Store.js');
const { MemoV2Promotion, promotionError } = require('../lib/MemoV2Promotion.js');
const { main: cliMain, parseArgs } = require('../scripts/memo-v2-promote-candidate.js');

const AGENT = 'fixture-agent';
const CANDIDATE_TEXT = 'fixture candidate body must never appear in CLI output';
const FIXED_TIME = '2026-08-25T12:34:56.000Z';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function makeSandbox(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onering-memo-v2-promotion-'));
    const baseDir = path.join(root, 'Plugin', 'OneRing', 'memo-v2');
    const dataDir = path.join(root, 'Plugin', 'OneRing', 'data');
    fs.mkdirSync(baseDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, `${AGENT}.db`);
    const database = new Database(dbPath);
    database.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, agentName TEXT NOT NULL)');
    const dbMaxId = options.dbMaxId == null ? 226 : options.dbMaxId;
    if (dbMaxId > 0) {
        const insert = database.prepare('INSERT INTO messages (id, agentName) VALUES (?, ?)');
        for (let id = 1; id <= dbMaxId; id += 1) insert.run(id, AGENT);
    }
    database.close();
    const store = new MemoV2Store({ baseDir });
    let tokenIndex = 0;
    const controllerOptions = {
        baseDir,
        store,
        clock: () => FIXED_TIME,
        tokenFactory: () => `fixture-token-${++tokenIndex}`,
        readDbMaxId: () => {
            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            try {
                return db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM messages WHERE agentName=?').get(AGENT).maxId;
            } finally {
                db.close();
            }
        },
        ...options.controllerOptions
    };
    const controller = new MemoV2Promotion(controllerOptions);
    return { root, baseDir, dbPath, store, controller };
}

function candidateValue(cursor = 226, agentName = AGENT, text = CANDIDATE_TEXT) {
    return {
        schemaVersion: 2,
        initialized: true,
        agentName,
        cursor: { lastMessageId: cursor, snapshotDbMaxId: cursor },
        lastSuccessAt: FIXED_TIME,
        timeline: [{ date: '2026-08-25', text, sourceMessageIds: ['226'] }],
        activeThreads: [],
        threadHistory: [],
        renderedMemo: text,
        stats: { sourceMessageCount: 1, normalizedEventCount: 1, normalizedChars: text.length }
    };
}

function writeCandidate(sandbox, value = candidateValue()) {
    sandbox.store.writeCandidate(AGENT, value);
    const bytes = fs.readFileSync(sandbox.store.candidatePath(AGENT));
    return { bytes, hash: sha256(bytes) };
}

function promotionOptions(sandbox, candidate = writeCandidate(sandbox), extra = {}) {
    return {
        agentName: AGENT,
        expectedCandidateSha256: candidate.hash,
        expectedSnapshotDbMaxId: extra.expectedSnapshotDbMaxId ?? 226,
        expectedDbMaxId: extra.expectedDbMaxId ?? 226,
        expectedActiveState: extra.expectedActiveState ?? 'absent',
        ...(extra.allowPendingEvents == null ? {} : { allowPendingEvents: extra.allowPendingEvents })
    };
}

function activeHash(sandbox) {
    const filePath = sandbox.store.statePath(AGENT);
    if (!fs.existsSync(filePath)) return null;
    return sha256(fs.readFileSync(filePath));
}

function listFiles(directory) {
    return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

function closeSandbox(sandbox) {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
}

test('inspect is read-only and exposes only safe metadata', () => {
    const sandbox = makeSandbox({ dbMaxId: 233 });
    try {
        const candidate = writeCandidate(sandbox);
        const before = fs.statSync(sandbox.store.candidatePath(AGENT));
        const result = sandbox.controller.inspect({ agentName: AGENT });
        assert.equal(result.mode, 'inspect');
        assert.equal(result.candidateHash, candidate.hash);
        assert.deepEqual(result.cursor, { lastMessageId: 226, snapshotDbMaxId: 226 });
        assert.equal(result.dbMaxId, 233);
        assert.equal(result.pendingEventCount, 7);
        assert.equal(result.activeStateExists, false);
        assert.equal(result.lockExists, false);
        assert.equal(result.canPromote, false);
        assert.equal(result.reasonCode, 'PROMOTION_FLAG_REQUIRED');
        assert.doesNotMatch(JSON.stringify(result), /fixture candidate body/iu);
        const after = fs.statSync(sandbox.store.candidatePath(AGENT));
        assert.equal(after.size, before.size);
        assert.equal(after.mtimeMs, before.mtimeMs);
        assert.deepEqual(listFiles(sandbox.baseDir), ['fixture-agent.candidate.json']);
    } finally { closeSandbox(sandbox); }
});

test('CLI parser rejects unknown, missing, invalid, and incomplete promotion arguments', () => {
    assert.throws(() => parseArgs(['--agent', AGENT, '--unknown']), error => error.code === 'MEMO_V2_CLI_UNKNOWN_ARGUMENT');
    assert.throws(() => parseArgs(['--agent']), error => error.code === 'MEMO_V2_CLI_MISSING_VALUE');
    assert.throws(() => parseArgs(['--agent', 'a/b']), error => error.code === 'MEMO_V2_INVALID_AGENT');
    assert.throws(() => parseArgs(['--agent', AGENT, '--expected-db-max-id', '-1']), error => error.code === 'MEMO_V2_INVALID_EXPECTED_DB_MAX_ID');
    assert.throws(() => parseArgs(['--agent', AGENT, '--expected-candidate-sha256', 'nope']), error => error.code === 'MEMO_V2_INVALID_EXPECTED_HASH');
    assert.throws(() => parseArgs(['--agent', AGENT, '--promote']), error => error.code === 'MEMO_V2_CLI_MISSING_PROMOTION_ARGUMENT');
});

test('candidate hash pin and schema, agent, and cursor mismatches reject before mutation', () => {
    const cases = [
        {
            name: 'hash',
            mutate: value => value,
            expected: () => ({ ...promotionOptions.current, expectedCandidateSha256: 'a'.repeat(64) }),
            code: 'MEMO_V2_CANDIDATE_HASH_MISMATCH'
        },
        { name: 'schema', mutate: value => ({ ...value, schemaVersion: 99 }), code: 'MEMO_V2_SCHEMA_MISMATCH' },
        { name: 'agent', mutate: value => ({ ...value, agentName: 'other-agent' }), code: 'MEMO_V2_AGENT_MISMATCH' },
        { name: 'cursor', mutate: value => ({ ...value, cursor: { lastMessageId: 225, snapshotDbMaxId: 225 } }), code: 'MEMO_V2_CURSOR_MISMATCH' }
    ];
    for (const item of cases) {
        const sandbox = makeSandbox();
        try {
            const original = writeCandidate(sandbox);
            if (item.name === 'hash') {
                assert.throws(() => sandbox.controller.promote({ ...promotionOptions(sandbox, original), expectedCandidateSha256: 'a'.repeat(64) }), error => error.code === item.code);
            } else {
                fs.writeFileSync(sandbox.store.candidatePath(AGENT), `${JSON.stringify(item.mutate(candidateValue()))}\n`);
                const current = { hash: sha256(fs.readFileSync(sandbox.store.candidatePath(AGENT))) };
                assert.throws(() => sandbox.controller.promote({ ...promotionOptions(sandbox, current), expectedSnapshotDbMaxId: 226 }), error => error.code === item.code);
            }
            assert.equal(fs.existsSync(sandbox.controller.lockPath), false, item.name);
            assert.equal(fs.existsSync(sandbox.store.statePath(AGENT)), false, item.name);
        } finally { closeSandbox(sandbox); }
    }
});

test('DB drift is rejected both outside and inside the lock', () => {
    const outside = makeSandbox();
    try {
        const candidate = writeCandidate(outside);
        assert.throws(() => outside.controller.promote({ ...promotionOptions(outside, candidate), expectedDbMaxId: 225 }), error => error.code === 'MEMO_V2_DB_DRIFT');
        assert.equal(fs.existsSync(outside.controller.lockPath), false);
    } finally { closeSandbox(outside); }

    const inside = makeSandbox({ controllerOptions: { readDbMaxId: (() => { let calls = 0; return () => (++calls === 1 ? 226 : 227); })() } });
    try {
        const candidate = writeCandidate(inside);
        assert.throws(() => inside.controller.promote(promotionOptions(inside, candidate)), error => error.code === 'MEMO_V2_DB_DRIFT');
        assert.equal(fs.existsSync(inside.controller.lockPath), false);
        assert.equal(fs.existsSync(inside.store.statePath(AGENT)), false);
    } finally { closeSandbox(inside); }
});

test('pending events require an exact allowance and successful promotion keeps candidate cursor', () => {
    const denied = makeSandbox({ dbMaxId: 228 });
    try {
        const candidate = writeCandidate(denied);
        assert.throws(() => denied.controller.promote(promotionOptions(denied, candidate, { expectedDbMaxId: 228 })), error => error.code === 'MEMO_V2_PENDING_EVENTS');
        assert.throws(() => denied.controller.promote(promotionOptions(denied, candidate, { expectedDbMaxId: 228, allowPendingEvents: 1 })), error => error.code === 'MEMO_V2_PENDING_EVENTS' || error.code === 'MEMO_V2_PENDING_COUNT_MISMATCH');
        assert.equal(fs.existsSync(denied.controller.lockPath), false);
    } finally { closeSandbox(denied); }

    const allowed = makeSandbox({ dbMaxId: 228 });
    try {
        const candidate = writeCandidate(allowed);
        const receipt = allowed.controller.promote(promotionOptions(allowed, candidate, { expectedDbMaxId: 228, allowPendingEvents: 2 }));
        assert.equal(receipt.pendingEventCount, 2);
        assert.equal(JSON.parse(fs.readFileSync(allowed.store.statePath(AGENT))).cursor.lastMessageId, 226);
        assert.equal(receipt.productionIntegrated, false);
        assert.equal(fs.existsSync(allowed.controller.lockPath), false);
    } finally { closeSandbox(allowed); }
});

test('existing operation lock is refused and never removed', () => {
    const sandbox = makeSandbox();
    try {
        const candidate = writeCandidate(sandbox);
        fs.mkdirSync(path.dirname(sandbox.controller.lockPath), { recursive: true });
        const lockBytes = Buffer.from(JSON.stringify({ version: 1, operation: 'shadow', agentName: AGENT, ownershipToken: 'other-token', pid: 7, startedAt: FIXED_TIME, expectedCandidateSha256: candidate.hash }) + '\n');
        fs.writeFileSync(sandbox.controller.lockPath, lockBytes, { flag: 'wx' });
        assert.throws(() => sandbox.controller.promote(promotionOptions(sandbox, candidate)), error => error.code === 'MEMO_V2_PROMOTION_LOCKED');
        assert.deepEqual(fs.readFileSync(sandbox.controller.lockPath), lockBytes);
    } finally { closeSandbox(sandbox); }
});

test('candidate replacement after lock acquisition is detected and lock is released', () => {
    const sandbox = makeSandbox({ controllerOptions: { hooks: { beforeLockedCandidateRead: () => { sandbox.store.writeCandidate(AGENT, candidateValue(226, AGENT, 'replacement')); } } } });
    try {
        const candidate = writeCandidate(sandbox);
        assert.throws(() => sandbox.controller.promote(promotionOptions(sandbox, candidate)), error => error.code === 'MEMO_V2_CANDIDATE_CHANGED_DURING_PROMOTION');
        assert.equal(fs.existsSync(sandbox.controller.lockPath), false);
        assert.equal(fs.existsSync(sandbox.store.statePath(AGENT)), false);
    } finally { closeSandbox(sandbox); }
});

test('candidate hash is rechecked after active write before receipt', () => {
    const sandbox = makeSandbox();
    try {
        const candidate = writeCandidate(sandbox);
        const controller = new MemoV2Promotion({
            baseDir: sandbox.baseDir,
            store: sandbox.store,
            clock: () => FIXED_TIME,
            tokenFactory: (() => { let n = 0; return () => `after-token-${++n}`; })(),
            readDbMaxId: () => 226,
            hooks: { afterActiveWrite: () => { sandbox.store.writeCandidate(AGENT, candidateValue(226, AGENT, 'post-write replacement')); } }
        });
        assert.throws(() => controller.promote(promotionOptions(sandbox, candidate)), error => error.code === 'MEMO_V2_CANDIDATE_CHANGED_AFTER_PROMOTION');
        assert.equal(fs.existsSync(sandbox.store.statePath(AGENT)), false);
        assert.equal(fs.existsSync(controller.lockPath), false);
        assert.equal(listFiles(path.join(sandbox.baseDir, 'promotion-receipts')).length, 0);
    } finally { closeSandbox(sandbox); }
});

test('expected active absent and expected active hash mismatch are refused under lock', () => {
    const sandbox = makeSandbox();
    try {
        const candidate = writeCandidate(sandbox);
        fs.writeFileSync(sandbox.store.statePath(AGENT), JSON.stringify({ schemaVersion: 2, agentName: AGENT, cursor: { lastMessageId: 1, snapshotDbMaxId: 1 } }));
        assert.throws(() => sandbox.controller.promote(promotionOptions(sandbox, candidate)), error => error.code === 'MEMO_V2_ACTIVE_MISMATCH');
        assert.throws(() => sandbox.controller.promote({ ...promotionOptions(sandbox, candidate, { expectedActiveState: 'b'.repeat(64) }) }), error => error.code === 'MEMO_V2_ACTIVE_MISMATCH');
        assert.equal(fs.existsSync(sandbox.controller.lockPath), false);
    } finally { closeSandbox(sandbox); }
});

test('first promotion creates active, preserves candidate, writes safe receipt, and does not integrate production', () => {
    const sandbox = makeSandbox();
    try {
        const candidate = writeCandidate(sandbox);
        const receipt = sandbox.controller.promote(promotionOptions(sandbox, candidate));
        assert.equal(receipt.previousActiveHash, null);
        assert.equal(receipt.backupPath, null);
        assert.equal(receipt.candidatePreserved, true);
        assert.equal(receipt.productionIntegrated, false);
        assert.deepEqual(receipt.cursor, { lastMessageId: 226, snapshotDbMaxId: 226 });
        assert.equal(receipt.pendingEventCount, 0);
        assert.equal(activeHash(sandbox), receipt.activeHash);
        assert.deepEqual(fs.readFileSync(sandbox.store.candidatePath(AGENT)), candidate.bytes);
        assert.equal(listFiles(path.join(sandbox.baseDir, 'promotion-receipts')).length, 1);
        assert.equal(listFiles(path.join(sandbox.baseDir, 'promotion-backups')).length, 0);
        assert.equal(fs.existsSync(sandbox.controller.lockPath), false);
        assert.equal(JSON.parse(fs.readFileSync(sandbox.store.statePath(AGENT))).cursor.lastMessageId, 226);
    } finally { closeSandbox(sandbox); }
});

test('update promotion backs up old active without overwriting receipt or backup history', () => {
    const sandbox = makeSandbox({ dbMaxId: 227 });
    try {
        const firstCandidate = writeCandidate(sandbox);
        const first = sandbox.controller.promote(promotionOptions(sandbox, firstCandidate, { expectedDbMaxId: 227, allowPendingEvents: 1 }));
        const oldActiveBytes = fs.readFileSync(sandbox.store.statePath(AGENT));
        const secondCandidate = writeCandidate(sandbox, candidateValue(227));
        const second = sandbox.controller.promote(promotionOptions(sandbox, secondCandidate, { expectedSnapshotDbMaxId: 227, expectedDbMaxId: 227, expectedActiveState: first.activeHash }));
        assert.equal(second.previousActiveHash, first.activeHash);
        assert.equal(second.backupPath.startsWith('promotion-backups/'), true);
        assert.equal(listFiles(path.join(sandbox.baseDir, 'promotion-backups')).length, 1);
        assert.equal(listFiles(path.join(sandbox.baseDir, 'promotion-receipts')).length, 2);
        assert.equal(sha256(oldActiveBytes), second.previousActiveHash);
        assert.equal(JSON.parse(fs.readFileSync(sandbox.store.statePath(AGENT))).cursor.lastMessageId, 227);
        assert.equal(fs.existsSync(sandbox.store.candidatePath(AGENT)), true);
    } finally { closeSandbox(sandbox); }
});

test('active write failure, post-verification failure, and receipt failure leave safe rollback evidence', () => {
    const writeFailure = makeSandbox();
    try {
        const candidate = writeCandidate(writeFailure);
        const originalRename = fs.renameSync;
        const fsImpl = { ...fs, renameSync(source, target) { if (target === writeFailure.store.statePath(AGENT)) throw new Error('rename failure'); return originalRename(source, target); } };
        const controller = new MemoV2Promotion({ ...writeFailure.controller, fsImpl });
        assert.throws(() => controller.promote(promotionOptions(writeFailure, candidate)), error => error.code === 'MEMO_V2_ACTIVE_WRITE_FAILED');
        assert.equal(fs.existsSync(writeFailure.store.statePath(AGENT)), false);
        assert.equal(fs.existsSync(writeFailure.controller.lockPath), false);
        assert.equal(fs.readdirSync(writeFailure.baseDir).some(name => name.endsWith('.tmp')), false);
    } finally { closeSandbox(writeFailure); }

    const verifyFailure = makeSandbox();
    try {
        const candidate = writeCandidate(verifyFailure);
        const controller = new MemoV2Promotion({
            baseDir: verifyFailure.baseDir,
            store: verifyFailure.store,
            clock: () => FIXED_TIME,
            tokenFactory: (() => { let n = 0; return () => `verify-token-${++n}`; })(),
            readDbMaxId: () => 226,
            hooks: { afterActiveWrite: () => { throw promotionError('MEMO_V2_ACTIVE_VERIFY_FAILED', 'test verification failure'); } }
        });
        assert.throws(() => controller.promote(promotionOptions(verifyFailure, candidate)), error => error.code === 'MEMO_V2_ACTIVE_VERIFY_FAILED');
        assert.equal(fs.existsSync(verifyFailure.store.statePath(AGENT)), false);
        assert.equal(fs.existsSync(controller.lockPath), false);
    } finally { closeSandbox(verifyFailure); }

    const receiptFailure = makeSandbox();
    try {
        const firstCandidate = writeCandidate(receiptFailure);
        const first = receiptFailure.controller.promote(promotionOptions(receiptFailure, firstCandidate));
        const oldActiveBytes = fs.readFileSync(receiptFailure.store.statePath(AGENT));
        const secondCandidate = writeCandidate(receiptFailure, candidateValue(226, AGENT, 'second candidate'));
        const controller = new MemoV2Promotion({
            baseDir: receiptFailure.baseDir,
            store: receiptFailure.store,
            clock: () => FIXED_TIME,
            tokenFactory: (() => { let n = 0; return () => `receipt-token-${++n}`; })(),
            readDbMaxId: () => 226,
            hooks: { beforeReceiptWrite: () => { throw promotionError('MEMO_V2_RECEIPT_WRITE_FAILED', 'test receipt failure'); } }
        });
        assert.throws(() => controller.promote(promotionOptions(receiptFailure, secondCandidate, { expectedActiveState: first.activeHash })), error => error.code === 'MEMO_V2_RECEIPT_WRITE_FAILED');
        assert.deepEqual(fs.readFileSync(receiptFailure.store.statePath(AGENT)), oldActiveBytes);
        assert.equal(fs.existsSync(controller.lockPath), false);
        assert.equal(listFiles(path.join(receiptFailure.baseDir, 'promotion-receipts')).length, 1);
        assert.equal(listFiles(path.join(receiptFailure.baseDir, 'promotion-backups')).length, 1);
    } finally { closeSandbox(receiptFailure); }
});

test('lock release checks ownership and never deletes a replacement lock', () => {
    const sandbox = makeSandbox();
    try {
        const candidate = writeCandidate(sandbox);
        const controller = new MemoV2Promotion({
            baseDir: sandbox.baseDir,
            store: sandbox.store,
            clock: () => FIXED_TIME,
            tokenFactory: (() => { let n = 0; return () => `ownership-token-${++n}`; })(),
            readDbMaxId: () => 226,
            hooks: {
                beforeLockRelease: ({ lockPath }) => {
                    fs.writeFileSync(lockPath, JSON.stringify({ ownershipToken: 'other-owner' }));
                }
            }
        });
        assert.throws(() => controller.promote(promotionOptions(sandbox, candidate)), error => error.code === 'MEMO_V2_LOCK_OWNERSHIP_LOST');
        assert.equal(JSON.parse(fs.readFileSync(controller.lockPath)).ownershipToken, 'other-owner');
    } finally { closeSandbox(sandbox); }
});

test('CLI inspect is read-only and stdout contains no candidate body, stack, or credentials', () => {
    const sandbox = makeSandbox();
    try {
        const candidate = writeCandidate(sandbox);
        const candidatePath = sandbox.store.candidatePath(AGENT);
        const before = fs.statSync(candidatePath);
        const outputWrites = [];
        const originalStdoutWrite = process.stdout.write;
        try {
            process.stdout.write = chunk => { outputWrites.push(String(chunk)); return true; };
            cliMain(['--agent', AGENT], { controller: sandbox.controller });
        } finally {
            process.stdout.write = originalStdoutWrite;
        }
        const stdout = outputWrites.join('');
        const output = JSON.parse(stdout);
        assert.equal(output.mode, 'inspect');
        assert.equal(output.candidateHash, candidate.hash);
        assert.doesNotMatch(stdout, /fixture candidate body|stack|api[_ -]?key|password|token/iu);
        assert.equal(fs.statSync(candidatePath).size, before.size);
        assert.equal(fs.existsSync(sandbox.store.statePath(AGENT)), false);
        assert.equal(fs.existsSync(path.join(sandbox.root, 'Plugin', 'OneRing', 'tmp', 'memo-v2-shadow.lock')), false);
    } finally { closeSandbox(sandbox); }
});
