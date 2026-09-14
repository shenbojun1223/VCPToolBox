'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const {
    MemoV2Promotion,
    normalizeAgentName,
    normalizeExpectedHash,
    normalizeExpectedActive,
    normalizeNonNegativeInteger,
    promotionError
} = require('../lib/MemoV2Promotion.js');
const { openReadOnlyDb } = require('../OneRingMemoV2.js');

function usage() {
    return 'Usage: node Plugin/OneRing/scripts/memo-v2-promote-candidate.js --agent <name> [--promote --expected-candidate-sha256 <64hex> --expected-snapshot-db-max-id <n> --expected-active-state absent|<64hex> --expected-db-max-id <n> [--allow-pending-events <n>]]';
}

function takeValue(argv, index, name) {
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw promotionError('MEMO_V2_CLI_MISSING_VALUE', `${name} requires a value`);
    return value;
}

function parseArgs(argv = []) {
    const options = { promote: false };
    const seen = new Set();
    const valueOptions = new Set([
        '--agent',
        '--expected-candidate-sha256',
        '--expected-snapshot-db-max-id',
        '--expected-active-state',
        '--expected-db-max-id',
        '--allow-pending-events'
    ]);
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        if (name === '--help') {
            if (seen.size) throw promotionError('MEMO_V2_CLI_UNKNOWN_ARGUMENT', 'help cannot be combined with other arguments');
            return { help: true, promote: false };
        }
        if (name === '--promote') {
            if (seen.has(name)) throw promotionError('MEMO_V2_CLI_DUPLICATE_ARGUMENT', 'duplicate argument');
            seen.add(name);
            options.promote = true;
            continue;
        }
        if (!valueOptions.has(name)) throw promotionError('MEMO_V2_CLI_UNKNOWN_ARGUMENT', 'unknown argument');
        if (seen.has(name)) throw promotionError('MEMO_V2_CLI_DUPLICATE_ARGUMENT', 'duplicate argument');
        seen.add(name);
        options[name.slice(2).replaceAll('-', '')] = takeValue(argv, index, name);
        index += 1;
    }
    if (!options.agent) throw promotionError('MEMO_V2_CLI_MISSING_AGENT', 'agent is required');
    options.agent = normalizeAgentName(options.agent);
    if (options.expectedcandidatesha256 != null) {
        options.expectedCandidateSha256 = normalizeExpectedHash(options.expectedcandidatesha256);
        delete options.expectedcandidatesha256;
    }
    if (options.expectedsnapshotdbmaxid != null) {
        options.expectedSnapshotDbMaxId = normalizeNonNegativeInteger(options.expectedsnapshotdbmaxid, 'MEMO_V2_INVALID_EXPECTED_SNAPSHOT_DB_MAX_ID');
        delete options.expectedsnapshotdbmaxid;
    }
    if (options.expectedactivestate != null) {
        options.expectedActiveState = normalizeExpectedActive(options.expectedactivestate);
        delete options.expectedactivestate;
    }
    if (options.expecteddbmaxid != null) {
        options.expectedDbMaxId = normalizeNonNegativeInteger(options.expecteddbmaxid, 'MEMO_V2_INVALID_EXPECTED_DB_MAX_ID');
        delete options.expecteddbmaxid;
    }
    if (options.allowpendingevents != null) {
        options.allowPendingEvents = normalizeNonNegativeInteger(options.allowpendingevents, 'MEMO_V2_INVALID_ALLOW_PENDING_EVENTS');
        delete options.allowpendingevents;
    }
    if (options.promote) {
        for (const key of ['expectedCandidateSha256', 'expectedSnapshotDbMaxId', 'expectedActiveState', 'expectedDbMaxId']) {
            if (options[key] == null) throw promotionError('MEMO_V2_CLI_MISSING_PROMOTION_ARGUMENT', `${key} is required for promotion`);
        }
        if (options.allowPendingEvents != null && options.allowPendingEvents < 0) {
            throw promotionError('MEMO_V2_INVALID_ALLOW_PENDING_EVENTS', 'allowance is invalid');
        }
    }
    return options;
}

function projectRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function createPromotion(projectBasePath = projectRoot()) {
    const root = path.resolve(projectBasePath);
    return new MemoV2Promotion({
        baseDir: path.join(root, 'Plugin', 'OneRing', 'memo-v2'),
        readDbMaxId(agentName) {
            const database = openReadOnlyDb(agentName, root, Database);
            try {
                const row = database.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM messages WHERE agentName=?').get(agentName);
                return Number(row?.maxId || 0);
            } finally {
                database.close();
            }
        }
    });
}

function safeFailure(error) {
    return { ok: false, errorCode: String(error?.code || 'MEMO_V2_PROMOTION_FAILED') };
}

function main(argv = process.argv.slice(2), dependencies = {}) {
    let options;
    try {
        options = parseArgs(argv);
        if (options.help) {
            process.stdout.write(`${usage()}\n`);
            return { ok: true, help: true };
        }
        const controller = dependencies.controller || createPromotion(dependencies.projectBasePath);
        const result = options.promote
            ? controller.promote({
                agentName: options.agent,
                expectedCandidateSha256: options.expectedCandidateSha256,
                expectedSnapshotDbMaxId: options.expectedSnapshotDbMaxId,
                expectedActiveState: options.expectedActiveState,
                expectedDbMaxId: options.expectedDbMaxId,
                allowPendingEvents: options.allowPendingEvents
            })
            : controller.inspect({
                agentName: options.agent,
                expectedCandidateSha256: options.expectedCandidateSha256,
                expectedSnapshotDbMaxId: options.expectedSnapshotDbMaxId,
                expectedActiveState: options.expectedActiveState,
                expectedDbMaxId: options.expectedDbMaxId,
                allowPendingEvents: options.allowPendingEvents
            });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return result;
    } catch (error) {
        const result = safeFailure(error);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.stderr.write(`${result.errorCode}\n`);
        process.exitCode = 1;
        return result;
    }
}

if (require.main === module) main();

module.exports = {
    usage,
    parseArgs,
    createPromotion,
    main
};
