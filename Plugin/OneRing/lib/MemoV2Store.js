'use strict';

const fs = require('fs');
const path = require('path');
const { redactSensitiveValues } = require('./MemoEventNormalizer.js');

const SCHEMA_VERSION = 2;

function safeAgentFileName(agentName) {
    return encodeURIComponent(String(agentName || '').trim()).replace(/%/g, '_');
}

function createDefaultState(agentName) {
    return {
        schemaVersion: SCHEMA_VERSION,
        initialized: false,
        agentName: String(agentName || '').trim(),
        cursor: {
            lastMessageId: 0,
            snapshotDbMaxId: 0
        },
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastError: null,
        timeline: [],
        activeThreads: [],
        threadHistory: [],
        renderedMemo: '',
        stats: {
            sourceMessageCount: 0,
            normalizedEventCount: 0,
            normalizedChars: 0,
            skipped: 0,
            duplicates: 0
        }
    };
}

function normalizeCursor(cursor) {
    const value = cursor && typeof cursor === 'object' ? cursor : {};
    const normalizeId = candidate => {
        const number = Number(candidate);
        return Number.isSafeInteger(number) && number >= 0 ? number : 0;
    };
    return {
        lastMessageId: normalizeId(value.lastMessageId),
        snapshotDbMaxId: normalizeId(value.snapshotDbMaxId)
    };
}

function normalizeState(agentName, candidate) {
    if (!candidate || typeof candidate !== 'object') {
        throw new Error('MEMO_V2_INVALID_STATE: state must be an object');
    }
    if (Number(candidate.schemaVersion) !== SCHEMA_VERSION) {
        throw new Error('MEMO_V2_INVALID_STATE: unsupported schemaVersion');
    }
    const expectedAgent = String(agentName || '').trim();
    if (!expectedAgent) throw new Error('MEMO_V2_INVALID_AGENT: agentName is required');
    if (candidate.agentName != null && String(candidate.agentName) !== expectedAgent) {
        throw new Error('MEMO_V2_INVALID_STATE: agentName mismatch');
    }
    const base = createDefaultState(expectedAgent);
    return {
        ...base,
        ...candidate,
        schemaVersion: SCHEMA_VERSION,
        initialized: candidate.initialized !== false,
        agentName: expectedAgent,
        cursor: normalizeCursor(candidate.cursor),
        lastSuccessAt: candidate.lastSuccessAt == null ? null : String(candidate.lastSuccessAt),
        lastAttemptAt: candidate.lastAttemptAt == null ? null : String(candidate.lastAttemptAt),
        lastError: candidate.lastError == null ? null : String(candidate.lastError).slice(0, 2000),
        timeline: Array.isArray(candidate.timeline) ? candidate.timeline : [],
        activeThreads: Array.isArray(candidate.activeThreads) ? candidate.activeThreads : [],
        threadHistory: Array.isArray(candidate.threadHistory) ? candidate.threadHistory : [],
        renderedMemo: typeof candidate.renderedMemo === 'string' ? candidate.renderedMemo : '',
        stats: candidate.stats && typeof candidate.stats === 'object' ? { ...base.stats, ...candidate.stats } : base.stats
    };
}

function defaultStoreDir() {
    return path.join(__dirname, '..', 'memo-v2');
}

class MemoV2Store {
    constructor(options = {}) {
        this.baseDir = path.resolve(options.baseDir || defaultStoreDir());
        this.fs = options.fsImpl || fs;
    }

    statePath(agentName) {
        return path.join(this.baseDir, `${safeAgentFileName(agentName)}.json`);
    }

    candidatePath(agentName) {
        return path.join(this.baseDir, `${safeAgentFileName(agentName)}.candidate.json`);
    }

    failurePath(agentName) {
        return path.join(this.baseDir, `${safeAgentFileName(agentName)}.failure.json`);
    }

    hasState(agentName) {
        try {
            return this.fs.existsSync(this.statePath(agentName));
        } catch (_) {
            return false;
        }
    }

    readJson(filePath) {
        const content = this.fs.readFileSync(filePath, 'utf8');
        try {
            return JSON.parse(content);
        } catch (_) {
            const error = new Error('MEMO_V2_INVALID_JSON: state file is not valid JSON');
            error.code = 'MEMO_V2_INVALID_JSON';
            throw error;
        }
    }

    readState(agentName) {
        const expectedAgent = String(agentName || '').trim();
        if (!expectedAgent) throw new Error('MEMO_V2_INVALID_AGENT: agentName is required');
        const target = this.statePath(expectedAgent);
        if (!this.fs.existsSync(target)) return createDefaultState(expectedAgent);
        return normalizeState(expectedAgent, this.readJson(target));
    }

    _atomicWriteJson(target, value) {
        this.fs.mkdirSync(this.baseDir, { recursive: true });
        const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        try {
            this.fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
            this.fs.renameSync(temporary, target);
        } catch (error) {
            try {
                if (this.fs.existsSync(temporary)) this.fs.unlinkSync(temporary);
            } catch (_) {
                // Preserve the original write/rename error.
            }
            throw error;
        }
    }

    writeCandidate(agentName, candidate) {
        const expectedAgent = String(agentName || '').trim();
        const source = candidate && candidate.state && candidate.schemaVersion == null ? candidate.state : candidate;
        const normalized = normalizeState(expectedAgent, source);
        this._atomicWriteJson(this.candidatePath(expectedAgent), normalized);
        return normalized;
    }

    promoteCandidate(agentName) {
        const expectedAgent = String(agentName || '').trim();
        const candidateFile = this.candidatePath(expectedAgent);
        if (!this.fs.existsSync(candidateFile)) {
            const error = new Error('MEMO_V2_CANDIDATE_NOT_FOUND: candidate state does not exist');
            error.code = 'MEMO_V2_CANDIDATE_NOT_FOUND';
            throw error;
        }
        const candidate = normalizeState(expectedAgent, this.readJson(candidateFile));
        // Write the new active file through a separate temporary file. If rename fails,
        // the previous active file is never touched and the candidate remains available.
        this._atomicWriteJson(this.statePath(expectedAgent), candidate);
        return candidate;
    }

    recordFailure(agentName, error, at = new Date().toISOString()) {
        const expectedAgent = String(agentName || '').trim();
        if (!this.hasState(expectedAgent)) {
            const message = redactSensitiveValues(String(error?.message || error || 'Unknown V2 failure')).slice(0, 2000);
            const failure = {
                schemaVersion: SCHEMA_VERSION,
                agentName: expectedAgent,
                lastAttemptAt: String(at),
                lastError: message,
                cursor: normalizeCursor(null)
            };
            this._atomicWriteJson(this.failurePath(expectedAgent), failure);
            return { ...createDefaultState(expectedAgent), lastAttemptAt: String(at), lastError: message };
        }
        const current = this.readState(expectedAgent);
        const message = redactSensitiveValues(String(error?.message || error || 'Unknown V2 failure')).slice(0, 2000);
        const next = {
            ...current,
            lastAttemptAt: String(at),
            lastError: message,
            cursor: { ...current.cursor }
        };
        this._atomicWriteJson(this.statePath(expectedAgent), next);
        return next;
    }
}

module.exports = {
    SCHEMA_VERSION,
    safeAgentFileName,
    createDefaultState,
    normalizeState,
    MemoV2Store
};
