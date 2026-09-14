'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
    SCHEMA_VERSION,
    safeAgentFileName,
    normalizeState,
    MemoV2Store
} = require('./MemoV2Store.js');

const HEX_64 = /^[0-9a-f]{64}$/iu;
const SAFE_AGENT = /[\\/\u0000\r\n]/u;

function promotionError(code, message) {
    const error = new Error(message || code);
    error.code = code;
    return error;
}

function normalizeAgentName(agentName) {
    const value = String(agentName == null ? '' : agentName).trim();
    if (!value || value === '.' || value === '..' || SAFE_AGENT.test(value) || value.length > 160) {
        throw promotionError('MEMO_V2_INVALID_AGENT', 'agent name is invalid');
    }
    return value;
}

function normalizeExpectedHash(value, code = 'MEMO_V2_INVALID_EXPECTED_HASH') {
    const normalized = String(value == null ? '' : value).trim().toLowerCase();
    if (!HEX_64.test(normalized)) throw promotionError(code, 'expected hash is invalid');
    return normalized;
}

function normalizeExpectedActive(value) {
    if (value === 'absent') return 'absent';
    return normalizeExpectedHash(value, 'MEMO_V2_INVALID_EXPECTED_ACTIVE_STATE');
}

function normalizeNonNegativeInteger(value, code) {
    const text = String(value == null ? '' : value);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) throw promotionError(code, 'integer is invalid');
    const number = Number(text);
    if (!Number.isSafeInteger(number) || number < 0) throw promotionError(code, 'integer is invalid');
    return number;
}

function normalizeRuntimeInteger(value, code = 'MEMO_V2_DB_READ_FAILED') {
    const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value.maxId : value;
    const number = Number(candidate);
    if (!Number.isSafeInteger(number) || number < 0) throw promotionError(code, 'database max id is invalid');
    return number;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function isoDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw promotionError('MEMO_V2_CLOCK_INVALID', 'clock returned an invalid date');
    return date.toISOString();
}

function safeTimestamp(iso) {
    return iso.replace(/[^0-9TZ]/gu, '').replace(/Z$/u, 'Z');
}

function relativePath(base, target) {
    return path.relative(base, target).split(path.sep).join('/');
}

class MemoV2Promotion {
    constructor(options = {}) {
        this.fs = options.fsImpl || fs;
        this.crypto = options.cryptoImpl || crypto;
        this.store = options.store || new MemoV2Store({ baseDir: options.baseDir });
        this.baseDir = path.resolve(options.baseDir || this.store.baseDir);
        this.lockPath = path.resolve(options.lockPath || path.join(this.baseDir, '..', 'tmp', 'memo-v2-shadow.lock'));
        this.backupDir = path.resolve(options.backupDir || path.join(this.baseDir, 'promotion-backups'));
        this.receiptDir = path.resolve(options.receiptDir || path.join(this.baseDir, 'promotion-receipts'));
        this.clock = options.clock || (() => new Date());
        this.tokenFactory = options.tokenFactory || (() => this.crypto.randomBytes(24).toString('hex'));
        this.readDbMaxId = options.readDbMaxId;
        this.hooks = options.hooks || {};
    }

    candidatePath(agentName) {
        return this.store.candidatePath(normalizeAgentName(agentName));
    }

    activePath(agentName) {
        return this.store.statePath(normalizeAgentName(agentName));
    }

    failurePath(agentName) {
        return this.store.failurePath(normalizeAgentName(agentName));
    }

    cursorPath(agentName) {
        return path.join(this.baseDir, `${safeAgentFileName(normalizeAgentName(agentName))}.cursor.json`);
    }

    _exists(filePath) {
        try { return this.fs.existsSync(filePath); } catch (_) { return false; }
    }

    _readCandidate(agentName) {
        const expectedAgent = normalizeAgentName(agentName);
        const filePath = this.candidatePath(expectedAgent);
        let bytes;
        try {
            bytes = this.fs.readFileSync(filePath);
        } catch (error) {
            if (error && error.code === 'ENOENT') throw promotionError('MEMO_V2_CANDIDATE_NOT_FOUND', 'candidate state does not exist');
            throw promotionError('MEMO_V2_CANDIDATE_READ_FAILED', 'candidate state could not be read');
        }
        const hash = sha256(bytes);
        let value;
        try {
            value = JSON.parse(bytes.toString('utf8'));
        } catch (_) {
            throw promotionError('MEMO_V2_CANDIDATE_INVALID_JSON', 'candidate state is not valid JSON');
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw promotionError('MEMO_V2_SCHEMA_MISMATCH', 'candidate root is invalid');
        }
        if (Number(value.schemaVersion) !== SCHEMA_VERSION) {
            throw promotionError('MEMO_V2_SCHEMA_MISMATCH', 'candidate schema is not supported');
        }
        if (String(value.agentName || '').trim() !== expectedAgent) {
            throw promotionError('MEMO_V2_AGENT_MISMATCH', 'candidate agent does not match');
        }
        if (!value.cursor || typeof value.cursor !== 'object' || Array.isArray(value.cursor)) {
            throw promotionError('MEMO_V2_CURSOR_MISMATCH', 'candidate cursor is invalid');
        }
        for (const key of ['lastMessageId', 'snapshotDbMaxId']) {
            const candidate = value.cursor[key];
            if (!Number.isSafeInteger(candidate) || candidate < 0) {
                throw promotionError('MEMO_V2_CURSOR_MISMATCH', 'candidate cursor is invalid');
            }
        }
        let normalized;
        try {
            normalized = normalizeState(expectedAgent, value);
        } catch (_) {
            throw promotionError('MEMO_V2_SCHEMA_MISMATCH', 'candidate state failed normalization');
        }
        return { filePath, bytes, hash, normalized };
    }

    _readHash(filePath) {
        try {
            const bytes = this.fs.readFileSync(filePath);
            return { exists: true, bytes, hash: sha256(bytes) };
        } catch (error) {
            if (error && error.code === 'ENOENT') return { exists: false, bytes: null, hash: null };
            throw promotionError('MEMO_V2_ACTIVE_READ_FAILED', 'active state could not be read');
        }
    }

    _readDbMaxId(agentName) {
        if (typeof this.readDbMaxId !== 'function') throw promotionError('MEMO_V2_DB_READER_REQUIRED', 'database reader is required');
        try {
            return normalizeRuntimeInteger(this.readDbMaxId(agentName));
        } catch (error) {
            if (error && error.code && String(error.code).startsWith('MEMO_V2_')) throw error;
            throw promotionError('MEMO_V2_DB_READ_FAILED', 'database max id could not be read');
        }
    }

    _checkExpectedCandidate(candidate, options) {
        const expectedHash = normalizeExpectedHash(options.expectedCandidateSha256);
        if (candidate.hash !== expectedHash) throw promotionError('MEMO_V2_CANDIDATE_HASH_MISMATCH', 'candidate hash does not match');
        const expectedSnapshot = normalizeRuntimeInteger(options.expectedSnapshotDbMaxId, 'MEMO_V2_INVALID_EXPECTED_SNAPSHOT_DB_MAX_ID');
        if (candidate.normalized.cursor.lastMessageId !== expectedSnapshot
            || candidate.normalized.cursor.snapshotDbMaxId !== expectedSnapshot) {
            throw promotionError('MEMO_V2_CURSOR_MISMATCH', 'candidate cursor does not match expected snapshot');
        }
    }

    _checkPending(candidate, dbMaxId, options) {
        const lastMessageId = candidate.normalized.cursor.lastMessageId;
        if (dbMaxId < lastMessageId) throw promotionError('MEMO_V2_DB_BEHIND_CANDIDATE', 'database is behind candidate cursor');
        const pending = dbMaxId - lastMessageId;
        const allow = options.allowPendingEvents == null
            ? null
            : normalizeRuntimeInteger(options.allowPendingEvents, 'MEMO_V2_INVALID_ALLOW_PENDING_EVENTS');
        if (pending > 0 && allow !== pending) {
            throw promotionError('MEMO_V2_PENDING_EVENTS', 'pending events require an exact explicit allowance');
        }
        if (pending === 0 && allow != null && allow !== 0) {
            throw promotionError('MEMO_V2_PENDING_COUNT_MISMATCH', 'allowance does not match pending events');
        }
        return pending;
    }

    _ensureExpectedActive(agentName, expectedActiveState) {
        const expected = normalizeExpectedActive(expectedActiveState);
        const active = this._readHash(this.activePath(agentName));
        if (expected === 'absent') {
            if (active.exists) throw promotionError('MEMO_V2_ACTIVE_MISMATCH', 'active state was expected to be absent');
        } else if (!active.exists || active.hash !== expected) {
            throw promotionError('MEMO_V2_ACTIVE_MISMATCH', 'active state hash does not match');
        }
        return active;
    }

    _acquireLock(agentName, expectedCandidateSha256) {
        const token = String(this.tokenFactory());
        if (!token || /[\u0000\r\n]/u.test(token)) throw promotionError('MEMO_V2_LOCK_TOKEN_INVALID', 'lock token is invalid');
        const startedAt = isoDate(this.clock());
        const record = {
            version: 1,
            operation: 'promotion',
            agentName,
            ownershipToken: token,
            pid: process.pid,
            startedAt,
            expectedCandidateSha256
        };
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
        this.fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
        let fd;
        try {
            fd = this.fs.openSync(this.lockPath, 'wx', 0o600);
            this.fs.writeSync(fd, bytes, 0, bytes.length);
            this.fs.fsyncSync(fd);
            this.fs.closeSync(fd);
            fd = null;
        } catch (error) {
            if (fd != null) {
                try { this.fs.closeSync(fd); } catch (_) { /* preserve original error */ }
            }
            if (error && error.code === 'EEXIST') throw promotionError('MEMO_V2_PROMOTION_LOCKED', 'promotion lock already exists');
            throw promotionError('MEMO_V2_LOCK_CREATE_FAILED', 'promotion lock could not be created');
        }
        return { token, tokenHash: sha256(Buffer.from(token, 'utf8')), record };
    }

    _releaseLock(lock) {
        let value;
        try {
            value = JSON.parse(this.fs.readFileSync(this.lockPath, 'utf8'));
        } catch (_) {
            throw promotionError('MEMO_V2_LOCK_OWNERSHIP_LOST', 'promotion lock could not be verified');
        }
        if (value.ownershipToken !== lock.token) {
            throw promotionError('MEMO_V2_LOCK_OWNERSHIP_LOST', 'promotion lock ownership changed');
        }
        try {
            this.fs.unlinkSync(this.lockPath);
        } catch (error) {
            if (error && error.code === 'ENOENT') return;
            throw promotionError('MEMO_V2_LOCK_RELEASE_FAILED', 'promotion lock could not be released');
        }
    }

    _fsyncDirectory(directory) {
        let fd;
        try {
            fd = this.fs.openSync(directory, 'r');
            this.fs.fsyncSync(fd);
            this.fs.closeSync(fd);
            return true;
        } catch (_) {
            if (fd != null) {
                try { this.fs.closeSync(fd); } catch (_) { /* best effort */ }
            }
            return false;
        }
    }

    _writeAtomicActive(target, bytes) {
        this.fs.mkdirSync(path.dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.${Date.now()}.${this.tokenFactory()}.tmp`;
        let fd;
        try {
            fd = this.fs.openSync(temporary, 'wx', 0o600);
            this.fs.writeSync(fd, bytes, 0, bytes.length);
            this.fs.fsyncSync(fd);
            this.fs.closeSync(fd);
            fd = null;
            this.fs.renameSync(temporary, target);
            const directoryFsync = this._fsyncDirectory(path.dirname(target));
            return { directoryFsync };
        } catch (error) {
            if (fd != null) {
                try { this.fs.closeSync(fd); } catch (_) { /* preserve original error */ }
            }
            try { if (this._exists(temporary)) this.fs.unlinkSync(temporary); } catch (_) { /* preserve original error */ }
            throw error;
        }
    }

    _writeExclusiveDurable(target, bytes) {
        this.fs.mkdirSync(path.dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.${Date.now()}.${this.tokenFactory()}.tmp`;
        let fd;
        try {
            fd = this.fs.openSync(temporary, 'wx', 0o600);
            this.fs.writeSync(fd, bytes, 0, bytes.length);
            this.fs.fsyncSync(fd);
            this.fs.closeSync(fd);
            fd = null;
            this.fs.linkSync(temporary, target);
            this.fs.unlinkSync(temporary);
            return { directoryFsync: this._fsyncDirectory(path.dirname(target)) };
        } catch (error) {
            if (fd != null) {
                try { this.fs.closeSync(fd); } catch (_) { /* preserve original error */ }
            }
            try { if (this._exists(temporary)) this.fs.unlinkSync(temporary); } catch (_) { /* preserve original error */ }
            throw error;
        }
    }

    _makeBackup(agentName, active, promotedAt, lock) {
        if (!active.exists) return { path: null, hash: null, directoryFsync: null };
        const fileName = `${safeAgentFileName(agentName)}-${safeTimestamp(promotedAt)}-${active.hash}-${lock.tokenHash.slice(0, 16)}.json`;
        const target = path.join(this.backupDir, fileName);
        try {
            const result = this._writeExclusiveDurable(target, active.bytes);
            const verified = this._readHash(target);
            if (!verified.exists || verified.hash !== active.hash) throw new Error('backup hash mismatch');
            return { path: relativePath(this.baseDir, target), hash: active.hash, directoryFsync: result.directoryFsync };
        } catch (_) {
            throw promotionError('MEMO_V2_BACKUP_FAILED', 'active backup could not be durably created');
        }
    }

    _rollbackActive(active, promotedHash, backupInfo, agentName) {
        try {
            if (active.exists) {
                const backupPath = path.resolve(this.baseDir, backupInfo.path);
                const backup = this._readHash(backupPath);
                if (!backup.exists || backup.hash !== active.hash) throw new Error('backup verification failed');
                this._writeAtomicActive(this.activePath(agentName), backup.bytes);
            } else {
                const current = this._readHash(this.activePath(agentName));
                if (current.exists) {
                    if (current.hash !== promotedHash) throw new Error('active ownership changed');
                    this.fs.unlinkSync(this.activePath(agentName));
                    this._fsyncDirectory(path.dirname(this.activePath(agentName)));
                }
            }
        } catch (_) {
            throw promotionError('MEMO_V2_ROLLBACK_FAILED', 'active state rollback failed');
        }
    }

    inspect(options = {}) {
        const agentName = normalizeAgentName(options.agentName);
        const candidatePath = this.candidatePath(agentName);
        const activePath = this.activePath(agentName);
        const candidateExists = this._exists(candidatePath);
        const active = this._readHash(activePath);
        let candidate = null;
        let candidateErrorCode = null;
        if (candidateExists) {
            try { candidate = this._readCandidate(agentName); } catch (error) { candidateErrorCode = error.code || 'MEMO_V2_CANDIDATE_INVALID'; }
        }
        let dbMaxId = null;
        let dbErrorCode = null;
        try { dbMaxId = this._readDbMaxId(agentName); } catch (error) { dbErrorCode = error.code || 'MEMO_V2_DB_READ_FAILED'; }
        const pendingEventCount = candidate && dbMaxId != null
            ? dbMaxId >= candidate.normalized.cursor.lastMessageId ? dbMaxId - candidate.normalized.cursor.lastMessageId : null
            : null;
        const expectedReady = options.expectedCandidateSha256 && options.expectedSnapshotDbMaxId != null && options.expectedActiveState;
        let readinessCode = 'PROMOTION_FLAG_REQUIRED';
        if (!candidateExists) readinessCode = 'MEMO_V2_CANDIDATE_NOT_FOUND';
        else if (candidateErrorCode) readinessCode = candidateErrorCode;
        else if (dbErrorCode) readinessCode = dbErrorCode;
        else if (expectedReady) {
            try {
                this._checkExpectedCandidate(candidate, options);
                if (options.expectedDbMaxId == null) throw promotionError('MEMO_V2_INVALID_EXPECTED_DB_MAX_ID', 'expected db max id is required');
                if (dbMaxId !== normalizeRuntimeInteger(options.expectedDbMaxId, 'MEMO_V2_INVALID_EXPECTED_DB_MAX_ID')) throw promotionError('MEMO_V2_DB_DRIFT', 'database max id differs');
                this._checkPending(candidate, dbMaxId, options);
                this._ensureExpectedActive(agentName, options.expectedActiveState);
                if (this._exists(this.lockPath)) throw promotionError('MEMO_V2_PROMOTION_LOCKED', 'promotion lock already exists');
                readinessCode = 'READY';
            } catch (error) { readinessCode = error.code || 'MEMO_V2_NOT_READY'; }
        }
        return {
            ok: true,
            mode: 'inspect',
            agentName,
            candidatePath,
            candidateExists,
            candidateSize: candidateExists ? this.fs.statSync(candidatePath).size : null,
            candidateMtimeUtc: candidateExists ? this.fs.statSync(candidatePath).mtime.toISOString() : null,
            candidateHash: candidate?.hash || (candidateExists ? sha256(this.fs.readFileSync(candidatePath)) : null),
            cursor: candidate?.normalized.cursor || null,
            dbMaxId,
            pendingEventCount,
            activeStateExists: active.exists,
            activeStateHash: active.hash,
            failureArtifactExists: this._exists(this.failurePath(agentName)),
            cursorArtifactExists: this._exists(this.cursorPath(agentName)),
            lockExists: this._exists(this.lockPath),
            promotionReady: readinessCode === 'READY',
            canPromote: false,
            reasonCode: readinessCode
        };
    }

    promote(options = {}) {
        const agentName = normalizeAgentName(options.agentName);
        const expectedHash = normalizeExpectedHash(options.expectedCandidateSha256);
        const expectedSnapshot = normalizeRuntimeInteger(options.expectedSnapshotDbMaxId, 'MEMO_V2_INVALID_EXPECTED_SNAPSHOT_DB_MAX_ID');
        const expectedDbMax = normalizeRuntimeInteger(options.expectedDbMaxId, 'MEMO_V2_INVALID_EXPECTED_DB_MAX_ID');
        const expectedActive = normalizeExpectedActive(options.expectedActiveState);
        const outsideCandidate = this._readCandidate(agentName);
        this._checkExpectedCandidate(outsideCandidate, { expectedCandidateSha256: expectedHash, expectedSnapshotDbMaxId: expectedSnapshot });
        if (this._exists(this.lockPath)) throw promotionError('MEMO_V2_PROMOTION_LOCKED', 'promotion lock already exists');
        const outsideDbMax = this._readDbMaxId(agentName);
        if (outsideDbMax !== expectedDbMax) throw promotionError('MEMO_V2_DB_DRIFT', 'database max id differs before lock');
        const outsidePending = this._checkPending(outsideCandidate, outsideDbMax, options);
        const lock = this._acquireLock(agentName, expectedHash);
        let activeBefore = null;
        let backupInfo = null;
        let promotedHash = null;
        let mutationStarted = false;
        let operationError = null;
        try {
            if (typeof this.hooks.beforeLockedCandidateRead === 'function') this.hooks.beforeLockedCandidateRead({ agentName, lockPath: this.lockPath });
            const lockedCandidate = this._readCandidate(agentName);
            if (lockedCandidate.hash !== expectedHash) throw promotionError('MEMO_V2_CANDIDATE_CHANGED_DURING_PROMOTION', 'candidate changed after lock acquisition');
            this._checkExpectedCandidate(lockedCandidate, { expectedCandidateSha256: expectedHash, expectedSnapshotDbMaxId: expectedSnapshot });
            if (typeof this.hooks.beforeLockedDbRead === 'function') this.hooks.beforeLockedDbRead({ agentName, lockPath: this.lockPath });
            const lockedDbMax = this._readDbMaxId(agentName);
            if (lockedDbMax !== expectedDbMax) throw promotionError('MEMO_V2_DB_DRIFT', 'database max id differs under lock');
            const pendingEventCount = this._checkPending(lockedCandidate, lockedDbMax, options);
            activeBefore = this._ensureExpectedActive(agentName, expectedActive);
            if (typeof this.hooks.beforeActiveWrite === 'function') this.hooks.beforeActiveWrite({ agentName, lockPath: this.lockPath });
            const promotedState = normalizeState(agentName, lockedCandidate.normalized);
            const promotedBytes = Buffer.from(`${JSON.stringify(promotedState, null, 2)}\n`, 'utf8');
            const promotedAt = isoDate(this.clock());
            backupInfo = this._makeBackup(agentName, activeBefore, promotedAt, lock);
            let activeDirectoryFsync = null;
            try {
                const result = this._writeAtomicActive(this.activePath(agentName), promotedBytes);
                activeDirectoryFsync = result.directoryFsync;
            } catch (_) {
                throw promotionError('MEMO_V2_ACTIVE_WRITE_FAILED', 'active state could not be written');
            }
            mutationStarted = true;
            promotedHash = sha256(promotedBytes);
            if (typeof this.hooks.afterActiveWrite === 'function') this.hooks.afterActiveWrite({ agentName, activePath: this.activePath(agentName), promotedHash });
            const activeAfter = this._readHash(this.activePath(agentName));
            if (!activeAfter.exists || activeAfter.hash !== promotedHash) throw promotionError('MEMO_V2_ACTIVE_VERIFY_FAILED', 'active state hash verification failed');
            let normalizedAfter;
            try { normalizedAfter = normalizeState(agentName, JSON.parse(activeAfter.bytes.toString('utf8'))); } catch (_) { throw promotionError('MEMO_V2_ACTIVE_VERIFY_FAILED', 'active state normalization failed'); }
            if (JSON.stringify(normalizedAfter) !== JSON.stringify(promotedState)) throw promotionError('MEMO_V2_ACTIVE_VERIFY_FAILED', 'active state content verification failed');
            const candidateAfter = this._readCandidate(agentName);
            if (candidateAfter.hash !== expectedHash) throw promotionError('MEMO_V2_CANDIDATE_CHANGED_AFTER_PROMOTION', 'candidate changed after active verification');
            const receipt = {
                schemaVersion: SCHEMA_VERSION,
                operation: 'promotion',
                agentName,
                promotedAt,
                candidateHash: expectedHash,
                previousActiveHash: activeBefore.hash,
                activeHash: promotedHash,
                cursor: cloneJson(promotedState.cursor),
                dbMaxIdAtPromotion: lockedDbMax,
                pendingEventCount,
                candidatePreserved: candidateAfter.hash === expectedHash,
                productionIntegrated: false,
                backupPath: backupInfo.path,
                lockTokenHash: lock.tokenHash,
                durability: {
                    backupDirectoryFsync: backupInfo.directoryFsync,
                    activeDirectoryFsync,
                    receiptDirectoryFsync: false
                }
            };
            if (!receipt.candidatePreserved) throw promotionError('MEMO_V2_CANDIDATE_NOT_PRESERVED', 'candidate was not preserved');
            if (typeof this.hooks.beforeReceiptWrite === 'function') this.hooks.beforeReceiptWrite({ agentName, receipt });
            const receiptName = `${safeAgentFileName(agentName)}-${safeTimestamp(promotedAt)}-${promotedHash}-${lock.tokenHash.slice(0, 16)}.json`;
            const receiptPath = path.join(this.receiptDir, receiptName);
            this.fs.mkdirSync(this.receiptDir, { recursive: true });
            const receiptDirectoryFsync = this._fsyncDirectory(this.receiptDir);
            receipt.durability.receiptDirectoryFsync = receiptDirectoryFsync;
            try {
                this._writeExclusiveDurable(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8'));
            } catch (_) {
                throw promotionError('MEMO_V2_RECEIPT_WRITE_FAILED', 'promotion receipt could not be written');
            }
            return { ...receipt, receiptPath: relativePath(this.baseDir, receiptPath), outsidePendingEventCount: outsidePending };
        } catch (error) {
            operationError = error && error.code ? error : promotionError('MEMO_V2_PROMOTION_FAILED', 'promotion failed');
            if (mutationStarted) {
                try { this._rollbackActive(activeBefore, promotedHash, backupInfo, agentName); } catch (rollbackError) { operationError = rollbackError; }
            }
            throw operationError;
        } finally {
            try {
                if (typeof this.hooks.beforeLockRelease === 'function') this.hooks.beforeLockRelease({ agentName, lockPath: this.lockPath, lock });
                this._releaseLock(lock);
            } catch (releaseError) {
                if (!operationError) throw releaseError;
            }
        }
    }
}

module.exports = {
    HEX_64,
    promotionError,
    normalizeAgentName,
    normalizeExpectedHash,
    normalizeExpectedActive,
    normalizeNonNegativeInteger,
    MemoV2Promotion
};
