'use strict';

const fs = require('fs');
const path = require('path');
const { buildCandidateInput, validateAgentName } = require('../OneRingMemoV2.js');
const { safeAgentFileName } = require('../lib/MemoV2Store.js');

function projectRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function usage() {
    return [
        'Usage: node Plugin/OneRing/scripts/memo-v2-dry-run.js --agent <name> [--timeline-days <n>] [--fallback-count <n>] [--candidate-output <path>]',
        'Default behavior is read-only DB inspection; no model is called and no V1 memo is written.'
    ].join('\n');
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') return { help: true };
        const equalsIndex = argument.indexOf('=');
        const name = equalsIndex >= 0 ? argument.slice(0, equalsIndex) : argument;
        const inlineValue = equalsIndex >= 0 ? argument.slice(equalsIndex + 1) : null;
        if (!['--agent', '--timeline-days', '--fallback-count', '--candidate-output'].includes(name)) {
            throw new Error(`Unknown argument: ${name}`);
        }
        const value = inlineValue == null ? argv[++index] : inlineValue;
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
        if (name === '--agent') options.agentName = value;
        if (name === '--timeline-days') options.timelineDays = parsePositive(value, name);
        if (name === '--fallback-count') options.fallbackCount = parsePositive(value, name);
        if (name === '--candidate-output') options.candidateOutput = value;
    }
    if (!options.agentName) throw new Error('--agent is required');
    options.agentName = validateAgentName(options.agentName);
    return options;
}

function parsePositive(value, name) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
    return number;
}

function isWithin(target, directory) {
    const normalizedTarget = path.resolve(target).toLowerCase();
    const normalizedDirectory = path.resolve(directory).toLowerCase();
    return normalizedTarget === normalizedDirectory || normalizedTarget.startsWith(`${normalizedDirectory}${path.sep}`);
}

function candidateOutputPath(rawOutput, agentName) {
    const root = projectRoot();
    const output = path.resolve(root, rawOutput);
    const oneRingDir = path.join(root, 'Plugin', 'OneRing');
    const memoDir = path.join(oneRingDir, 'memo');
    const dataDir = path.join(oneRingDir, 'data');
    const candidateDir = path.join(oneRingDir, 'memo-v2', 'candidates');
    if (isWithin(output, memoDir) || isWithin(output, dataDir)) {
        const error = new Error('candidate-output may not target Plugin/OneRing/memo or Plugin/OneRing/data');
        error.code = 'MEMO_V2_FORBIDDEN_OUTPUT_PATH';
        throw error;
    }
    if (isWithin(output, candidateDir) && path.extname(output).toLowerCase() === '.json') return output;
    if (isWithin(output, candidateDir) || path.extname(output).toLowerCase() !== '.json') {
        return path.join(output, `${safeAgentFileName(agentName)}.json`);
    }
    return output;
}

function writeCandidateOutput(filePath, delta) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(delta, null, 2)}\n`, 'utf8');
        fs.renameSync(temporary, filePath);
    } catch (error) {
        try {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        } catch (_) {
            // Preserve the original error.
        }
        throw error;
    }
}

function hasUnredactedSensitiveMarker(text) {
    return /(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret)\s*[:=：]\s*(?!\[REDACTED\])[^\s,，;；}\]]+/i.test(String(text || ''))
        || /(?:验证码|授权码|密码)\s*(?:为|是|[:=：])\s*(?!\[REDACTED\])[^\s,，;；}\]]+/i.test(String(text || ''));
}

function metricsForDelta(delta, candidateWritten) {
    const events = Array.isArray(delta.canonicalEvents) ? delta.canonicalEvents : [];
    const unredacted = events.filter(event => hasUnredactedSensitiveMarker(event.text)).length;
    return {
        schemaVersion: 2,
        agentName: delta.agentName,
        dbMaxId: delta.snapshotDbMaxId,
        cursor: delta.previousState?.cursor || { lastMessageId: 0, snapshotDbMaxId: 0 },
        nextCursor: delta.nextCursor,
        bootstrap: delta.bootstrap,
        deltaCount: events.length,
        sourceMessageCount: delta.stats.sourceMessageCount,
        rawChars: delta.stats.rawChars,
        normalizedChars: delta.stats.normalizedChars,
        kindCounts: delta.stats.kindCounts,
        dateRange: delta.stats.dateRange,
        skipped: delta.skipped,
        duplicates: delta.duplicates,
        sensitiveMarkerCheck: {
            passed: unredacted === 0,
            unredactedEventCount: unredacted
        },
        structuredChannel: 'forced_tool_call',
        model: false,
        candidate: Boolean(candidateWritten),
        modelCalled: false,
        candidateWritten
    };
}

function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return;
    }
    const delta = buildCandidateInput({
        agentName: options.agentName,
        timelineDays: options.timelineDays,
        fallbackCount: options.fallbackCount
    });
    let candidateWritten = false;
    if (options.candidateOutput) {
        const outputPath = candidateOutputPath(options.candidateOutput, options.agentName);
        writeCandidateOutput(outputPath, delta);
        candidateWritten = true;
    }
    process.stdout.write(`${JSON.stringify(metricsForDelta(delta, candidateWritten))}\n`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`memo-v2-dry-run failed: ${error.code || 'ERROR'}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    parseArgs,
    candidateOutputPath,
    hasUnredactedSensitiveMarker,
    metricsForDelta,
    main
};
