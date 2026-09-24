'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const pluginManager = require('../Plugin');
const { IncrementalJsonObjectParser } = require('../modules/incrementalJsonObjectParser');
const toolCallRecordStore = require('../modules/toolCallRecordStore');

const fixturePath = path.resolve(__dirname, 'fixtures', 'plugin-stdout-child.js');
const fixtureCommandPath = fixturePath.replace(/\\/g, '/');
let executionNumber = 0;
const initialPlugins = pluginManager.plugins;
const initialDebugMode = pluginManager.debugMode;

function splitIntoChunks(text, chunkSize) {
    const chunks = [];
    for (let offset = 0; offset < text.length; offset += chunkSize) {
        chunks.push(text.slice(offset, offset + chunkSize));
    }
    return chunks;
}

function makeManifest(action, options = {}) {
    const name = `StdoutFixture_${++executionNumber}`;
    const markerPath = options.markerPath || '';
    return {
        name,
        pluginType: options.pluginType || 'synchronous',
        basePath: options.basePath || path.dirname(fixturePath),
        entryPoint: {
            type: 'nodejs',
            command: `node ${fixtureCommandPath} ${action}`
        },
        communication: {
            protocol: 'stdio',
            timeout: options.timeout || 1000
        },
        configSchema: {
            STDOUT_TEST_MARKER: 'string'
        },
        pluginSpecificEnvConfig: markerPath ? { STDOUT_TEST_MARKER: markerPath } : {}
    };
}

async function executeFixture(action, options = {}) {
    const manifest = makeManifest(action, options);
    const originalPlugins = pluginManager.plugins;
    const originalDebugMode = pluginManager.debugMode;
    pluginManager.plugins = new Map([[manifest.name, manifest]]);
    pluginManager.debugMode = false;

    try {
        return await pluginManager.executePlugin(
            manifest.name,
            null,
            null,
            options.executionOptions || {}
        );
    } finally {
        pluginManager.plugins = originalPlugins;
        pluginManager.debugMode = originalDebugMode;
    }
}

async function withMarker(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-plugin-stdout-'));
    const markerPath = path.join(directory, 'closed.marker');
    try {
        return await callback(markerPath);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function waitForFile(filePath, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!fs.existsSync(filePath) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(filePath), true, `fixture did not close within ${timeoutMs}ms`);
}

async function waitForProcessExit(pidPath, timeoutMs = 1000) {
    await waitForFile(pidPath, timeoutMs);
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    assert.equal(Number.isInteger(pid) && pid > 0, true, `invalid fixture PID in ${pidPath}`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch (_) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`fixture process ${pid} did not exit within ${timeoutMs}ms`);
}

async function forceTerminateFixtureProcess(pidPath, timeoutMs = 1000) {
    await waitForFile(pidPath, timeoutMs);
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    assert.equal(Number.isInteger(pid) && pid > 0, true, `invalid fixture PID in ${pidPath}`);
    try {
        process.kill(pid, 'SIGKILL');
    } catch (_) {
        // The plugin timeout may have already terminated the fixture.
    }
    await waitForProcessExit(pidPath, timeoutMs);
}

async function executeAsyncFixtureAndWait(action, options = {}) {
    return withMarker(async markerPath => {
        const result = await executeFixture(action, {
            ...options,
            pluginType: 'asynchronous',
            markerPath
        });
        await waitForFile(markerPath, options.childExitTimeoutMs || 1500);
        return result;
    });
}

function parseWithChunks(input, chunkSize) {
    const parser = new IncrementalJsonObjectParser();
    let actual = null;
    for (const chunk of splitIntoChunks(input, chunkSize)) {
        actual = parser.push(chunk) || actual;
    }
    actual = parser.end() || actual;
    return { actual, stats: parser.getStats() };
}

test.after(async () => {
    try {
        const approvalManager = pluginManager.toolApprovalManager;
        if (approvalManager?.watcher) {
            const watcher = approvalManager.watcher;
            approvalManager.watcher = null;
            await watcher.close();
        }

        if (toolCallRecordStore.getStatus().initialized) {
            toolCallRecordStore.shutdown();
        }
    } finally {
        pluginManager.plugins = initialPlugins;
        pluginManager.debugMode = initialDebugMode;
    }
});

test('incremental parser handles every split point and JSON string state', () => {
    const expected = {
        status: 'success',
        result: {
            nested: [{ value: 1 }, { value: '花括号 {} \\"' }],
            unicode: '界面 🚀'
        }
    };
    const serialized = JSON.stringify(expected);

    for (let split = 0; split <= serialized.length; split++) {
        const parser = new IncrementalJsonObjectParser();
        parser.push(serialized.slice(0, split));
        const actual = parser.push(serialized.slice(split));
        assert.deepEqual(actual, expected, `split=${split}`);
    }
});

test('incremental parser keeps root boundaries across split points and chunk sizes', () => {
    const inner = { status: 'success', result: 'inner' };
    const outer = { status: 'success', result: { outer: true } };
    const cases = [
        {
            name: 'array root followed by response',
            input: `[${JSON.stringify(inner)}]${JSON.stringify(outer)}`,
            expected: outer,
            jsonParseAttempts: 1
        },
        {
            name: 'malformed outer followed by response',
            input: `{oops:${JSON.stringify(inner)}}${JSON.stringify(outer)}`,
            expected: outer,
            jsonParseAttempts: 1,
            discardedCandidates: 1
        },
        {
            name: 'nested object and array followed by response',
            input: `${JSON.stringify({
                meta: {
                    items: [inner, { text: '字符串里的花括号 {} [] \\"' }]
                }
            })}${JSON.stringify(outer)}`,
            expected: outer,
            jsonParseAttempts: 2
        },
        {
            name: 'complete response with a large brace string',
            input: JSON.stringify({
                status: 'success',
                result: { text: `${'{'.repeat(1024)}结束${'}'.repeat(1024)}` }
            }),
            expected: {
                status: 'success',
                result: { text: `${'{'.repeat(1024)}结束${'}'.repeat(1024)}` }
            },
            jsonParseAttempts: 1
        },
        {
            name: 'malformed outer without a boundary is rejected',
            input: `{oops:${JSON.stringify(inner)}}`,
            expected: null,
            jsonParseAttempts: 0,
            discardedCandidates: 1
        }
    ];

    for (const scenario of cases) {
        for (let split = 0; split <= scenario.input.length; split++) {
            const parser = new IncrementalJsonObjectParser();
            let actual = parser.push(scenario.input.slice(0, split)) || null;
            actual = parser.push(scenario.input.slice(split)) || actual;
            actual = parser.end() || actual;

            assert.deepEqual(actual, scenario.expected, `${scenario.name}, split=${split}`);
            const stats = parser.getStats();
            assert.equal(stats.scannedChars, scenario.input.length, `${scenario.name}, split=${split}`);
            assert.equal(stats.jsonParseAttempts, scenario.jsonParseAttempts, `${scenario.name}, split=${split}`);
            if (scenario.discardedCandidates) {
                assert.ok(stats.discardedCandidates >= scenario.discardedCandidates, `${scenario.name}, split=${split}`);
            }
        }

        for (const chunkSize of [1, 2, 3, 7, 31, scenario.input.length]) {
            const { actual, stats } = parseWithChunks(scenario.input, chunkSize);
            assert.deepEqual(actual, scenario.expected, `${scenario.name}, chunkSize=${chunkSize}`);
            assert.equal(stats.scannedChars, scenario.input.length, `${scenario.name}, chunkSize=${chunkSize}`);
            assert.equal(stats.jsonParseAttempts, scenario.jsonParseAttempts, `${scenario.name}, chunkSize=${chunkSize}`);
        }
    }
});

test('incremental parser skips prefixes, unrelated objects and closed malformed objects', () => {
    const parser = new IncrementalJsonObjectParser();
    const stream = [
        '\uFEFFINFO: starting\n',
        '{not-json}',
        '{"status":"maybe","result":"unrelated"}',
        '{"status":}',
        '{"meta":{"status":"success","result":{"inner":true}}}',
        '{"status":"success","result":{"outer":true}}'
    ].join('');

    let actual = null;
    for (const chunk of splitIntoChunks(stream, 5)) {
        actual = parser.push(chunk) || actual;
    }

    assert.deepEqual(actual, { status: 'success', result: { outer: true } });
    const stats = parser.getStats();
    assert.equal(stats.completedCandidates, 4);
    assert.equal(stats.jsonParseAttempts, 4);
    assert.ok(stats.discardedCandidates >= 1);
});

test('incremental parser preserves UTF-8 across Buffer boundaries', () => {
    const expected = { status: 'success', result: { text: '跨字节界面 🚀' } };
    const bytes = Buffer.from(JSON.stringify(expected), 'utf8');
    const parser = new IncrementalJsonObjectParser();

    for (let offset = 0; offset < bytes.length; offset++) {
        parser.push(bytes.subarray(offset, offset + 1));
    }
    assert.deepEqual(parser.end(), expected);
});

test('incremental parser scans large input once and handles an unclosed string prefix', () => {
    const largeText = '{'.repeat(256 * 1024);
    const largeSerialized = JSON.stringify({
        status: 'success',
        result: { text: largeText, tail: '完整' }
    });

    for (const chunkSize of [1, 17, 4096, 65536]) {
        const parser = new IncrementalJsonObjectParser();
        let scannedInput = 0;
        let actual = null;
        for (const chunk of splitIntoChunks(largeSerialized, chunkSize)) {
            actual = parser.push(chunk) || actual;
            scannedInput += chunk.length;
            assert.equal(parser.getStats().scannedChars, scannedInput);
        }
        assert.deepEqual(actual, {
            status: 'success',
            result: { text: largeText, tail: '完整' }
        });
        assert.equal(parser.getStats().jsonParseAttempts, 1);
    }

    const unclosedPrefix = `{"status":"success","result":{"text":"${'{'.repeat(65536)}`;
    const parser = new IncrementalJsonObjectParser();
    let scannedInput = 0;
    for (const chunk of splitIntoChunks(unclosedPrefix, 13)) {
        parser.push(chunk);
        scannedInput += chunk.length;
        assert.equal(parser.getStats().scannedChars, scannedInput);
    }
    assert.equal(parser.getStats().jsonParseAttempts, 0);
    assert.equal(parser.push('"}}').status, 'success');
    assert.equal(parser.getStats().scannedChars, unclosedPrefix.length + 3);
});

test('synchronous execution waits for close and preserves JSON, stderr and exit semantics', async () => {
    const success = await executeFixture('sync-success');
    assert.equal(success.status, 'success');
    assert.equal(success.result.nested.values[1].ok, true);
    assert.match(success.pluginStderr, /sync stderr/);

    const error = await executeFixture('sync-error');
    assert.equal(error.status, 'error');
    assert.match(error.pluginStderr, /sync error stderr/);

    const nonzero = await executeFixture('sync-nonzero');
    assert.equal(nonzero.status, 'error');
    assert.match(nonzero.pluginStderr, /nonzero stderr/);

    await assert.rejects(executeFixture('sync-empty'), /valid initial JSON response/);
    await assert.rejects(executeFixture('sync-malformed'), /valid initial JSON response/);
});

test('synchronous large stdout is fully drained before final parse', async () => {
    const result = await executeFixture('sync-large', { timeout: 5000 });
    assert.equal(result.status, 'success');
    assert.equal(result.result.text.length, 256 * 1024);
    assert.equal(result.result.tail, '完整排空');
});

test('asynchronous success resolves before exit and ignores later stdout/exit failure', async () => {
    await withMarker(async markerPath => {
        const result = await executeFixture('async-success-background', {
            pluginType: 'asynchronous',
            markerPath,
            timeout: 1000
        });
        assert.equal(result.status, 'success');
        assert.equal(result.result.phase, 'first');
        assert.equal(fs.existsSync(markerPath), false);
        await waitForFile(markerPath);
    });
});

test('asynchronous initial error is delivered before process exit', async () => {
    const result = await executeAsyncFixtureAndWait('async-error-background', {
        timeout: 1000
    });
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'initial async error');
});

test('asynchronous parser handles log prefix, malformed object, nested response and UTF-8 child chunks', async () => {
    const prefix = await executeAsyncFixtureAndWait('async-prefix-invalid');
    assert.equal(prefix.result.recovered, true);

    const malformed = await executeAsyncFixtureAndWait('async-malformed-then-success');
    assert.equal(malformed.result.recovered, true);

    const nested = await executeAsyncFixtureAndWait('async-unrelated-inner');
    assert.equal(nested.result.outer, true);

    const array = await executeAsyncFixtureAndWait('async-array-then-success');
    assert.equal(array.result.outer, true);

    const badOuter = await executeAsyncFixtureAndWait('async-bad-outer-then-success');
    assert.equal(badOuter.result.outer, true);

    const nestedContainers = await executeAsyncFixtureAndWait('async-nested-containers-then-success');
    assert.equal(nestedContainers.result.outer, true);

    const utf8 = await executeAsyncFixtureAndWait('async-utf8');
    assert.equal(utf8.result.text, '跨字节界面 🚀 {}');
});

test('asynchronous no-reply grace and clean exit settle silently', async () => {
    await withMarker(async markerPath => {
        const result = await executeFixture('async-no-reply-grace', {
            pluginType: 'asynchronous',
            markerPath,
            timeout: 1000,
            executionOptions: { archeryNoReply: true, archeryNoReplyGraceMs: 20 }
        });
        assert.equal(result.__vcpArcheryNoReplySilent, true);
        assert.equal(result.result.noReply, true);
        assert.equal(fs.existsSync(markerPath), false);
        await waitForFile(markerPath);
    });

    const exitResult = await executeAsyncFixtureAndWait('async-no-reply-exit', {
        executionOptions: { archeryNoReply: true, archeryNoReplyGraceMs: 500 }
    });
    assert.equal(exitResult.__vcpArcheryNoReplySilent, true);
    assert.equal(exitResult.result.noReply, true);

    const immediateSuccess = await executeAsyncFixtureAndWait('async-no-reply-success', {
        executionOptions: { archeryNoReply: true, archeryNoReplyGraceMs: 500 }
    });
    assert.equal(immediateSuccess.__vcpArcheryNoReplySilent, true);
    assert.equal(immediateSuccess.result.noReply, true);

    const immediateError = await executeAsyncFixtureAndWait('async-no-reply-error', {
        executionOptions: { archeryNoReply: true, archeryNoReplyGraceMs: 500 }
    });
    assert.equal(immediateError.status, 'error');
    assert.equal(immediateError.error, 'initial no-reply error');
    assert.equal(immediateError.__vcpArcheryNoReplySilent, undefined);

    await assert.rejects(
        executeFixture('async-no-reply-exit', { pluginType: 'asynchronous' }),
        /valid initial JSON response/
    );
});

test('asynchronous timeout and spawn error settle and clean timers', async () => {
    await withMarker(async markerPath => {
        await assert.rejects(
            executeFixture('async-hang', {
                pluginType: 'asynchronous',
                markerPath,
                timeout: 40
            }),
            /timed out/
        );
        await forceTerminateFixtureProcess(`${markerPath}.pid`);
    });

    const missingCwd = path.join(os.tmpdir(), `vcp-plugin-stdout-missing-${process.pid}-${Date.now()}`);
    await assert.rejects(
        executeFixture('sync-success', { basePath: missingCwd, timeout: 500 }),
        /Failed to start plugin|exited with code/
    );
});
