'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { buildDeltaFromDb, deriveCandidateState } = require('./lib/MemoDeltaBuilder.js');
const { MemoV2Store, createDefaultState } = require('./lib/MemoV2Store.js');

function projectRoot(projectBasePath) {
    return path.resolve(projectBasePath || path.join(__dirname, '..', '..'));
}

function validateAgentName(agentName) {
    const value = String(agentName || '').trim();
    if (!value || value === '.' || value === '..' || /[\\/\u0000]/.test(value)) {
        const error = new Error('MEMO_V2_INVALID_AGENT: agent name contains an invalid path character');
        error.code = 'MEMO_V2_INVALID_AGENT';
        throw error;
    }
    return value;
}

function dataPath(agentName, projectBasePath) {
    const safeAgent = validateAgentName(agentName);
    const dataDir = path.resolve(projectRoot(projectBasePath), 'Plugin', 'OneRing', 'data');
    const result = path.resolve(dataDir, `${safeAgent}.db`);
    if (path.dirname(result).toLowerCase() !== dataDir.toLowerCase()) {
        throw new Error('MEMO_V2_INVALID_DB_PATH: database path escaped OneRing data directory');
    }
    return result;
}

function openReadOnlyDb(agentName, projectBasePath, DatabaseImpl = Database) {
    const filePath = dataPath(agentName, projectBasePath);
    if (!fs.existsSync(filePath)) {
        const error = new Error('MEMO_V2_DB_NOT_FOUND: OneRing database does not exist');
        error.code = 'MEMO_V2_DB_NOT_FOUND';
        throw error;
    }
    return new DatabaseImpl(filePath, { readonly: true, fileMustExist: true });
}

function defaultStore(projectBasePath) {
    return new MemoV2Store({
        baseDir: path.resolve(projectRoot(projectBasePath), 'Plugin', 'OneRing', 'memo-v2')
    });
}

function buildCandidateInput(options = {}) {
    const agentName = validateAgentName(options.agentName);
    const store = options.store || defaultStore(options.projectBasePath);
    const previousState = options.previousState === undefined
        ? store.readState(agentName)
        : options.previousState || createDefaultState(agentName);
    const database = options.database || openReadOnlyDb(agentName, options.projectBasePath, options.DatabaseImpl);
    const ownsDatabase = !options.database;
    try {
        return buildDeltaFromDb({
            agentName,
            database,
            previousState,
            timelineDays: options.timelineDays,
            fallbackCount: options.fallbackCount,
            now: options.now
        });
    } finally {
        if (ownsDatabase && typeof database.close === 'function') database.close();
    }
}

function deriveCandidate(delta, at = null) {
    return deriveCandidateState(delta, at);
}

module.exports = {
    validateAgentName,
    dataPath,
    openReadOnlyDb,
    buildCandidateInput,
    buildDelta: buildCandidateInput,
    deriveCandidate
};
