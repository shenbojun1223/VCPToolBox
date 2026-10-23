'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function section(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, 'production function anchors must exist');
    return source.slice(a, b);
}
const functions = section('function destroyIdleSockets()', '// 新增：定时清理 activeRequests') +
    section('async function gracefulShutdown(', "process.on('SIGINT'");

async function scenario(mode, repeated = false) {
    const natural = mode === 'natural' || mode === 'natural-untracked';
    const trackedSockets = new Set(), activeHttpRequests = new Set(), activeRequests = new Map();
    const events = [], logs = [], exits = [], timers = new Set();
    let resolveExit;
    const exited = new Promise(resolve => { resolveExit = resolve; });
    let response, requestContext;
    const server = http.createServer((req, res) => {
        response = res;
        activeHttpRequests.add(req.socket);
        res.on('finish', () => { activeHttpRequests.delete(req.socket); activeRequests.delete('fixture'); });
        res.on('close', () => { activeHttpRequests.delete(req.socket); activeRequests.delete('fixture'); });
        if (mode !== 'untracked' && mode !== 'natural-untracked') {
            requestContext = { req, res, aborted: false, abortController: new AbortController() };
            req.body = { stream: true };
            activeRequests.set('fixture', requestContext);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ready\n\n');
    });
    server.on('connection', socket => {
        trackedSockets.add(socket);
        socket.on('close', () => { trackedSockets.delete(socket); activeHttpRequests.delete(socket); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let client, clientResponse;
    await new Promise((resolve, reject) => {
        client = http.get({ host: '127.0.0.1', port: server.address().port, agent: false }, res => {
            clientResponse = res;
            res.on('error', () => {});
            res.resume();
            resolve();
        });
        client.on('error', reject);
    });
    // Scale only the lifecycle clock/timers, not HTTP implementation or function ordering.
    class Clock extends Date { static now() { return Date.now() * 50; } }
    const context = vm.createContext({
        server, trackedSockets, activeHttpRequests, activeRequests,
        Date: Clock,
        setTimeout(fn, ms) {
            const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms / 50);
            timers.add(timer); return timer;
        },
        clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
        console: {
            log: (...args) => logs.push(args.join(' ')),
            warn: (...args) => logs.push(args.join(' ')),
            error: (...args) => logs.push(args.join(' '))
        },
        process: { exit(code) { exits.push(code); resolveExit(); } },
        SERVER_LIFECYCLE: { RUNNING: 'running', DRAINING: 'draining', SHUTTING_DOWN: 'shutdown', EXITING: 'exiting' },
        serverLifecycleState: 'running', shutdownPromise: null, shutdownStartedAt: null,
        shutdownReason: null, lastShutdownExitCode: 0, forceShutdownTimer: null,
        webSocketServer: {
            async beginDrain() { events.push('ws-drain'); },
            async shutdown() { events.push('ws-stop'); }
        },
        taskScheduler: { shutdown() { events.push('scheduler-stop'); } },
        pluginManager: {
            async shutdownAllPlugins() {
                events.push('plugin-stop');
                assert.equal(server.listening, false);
                assert.equal(response.writableEnded || response.destroyed, true,
                    'HTTP response must finish or close before plugin teardown');
                if (natural) assert.equal(response.writableEnded, true,
                    'normal response must finish without being destroyed early');
            }
        },
        toolCallRecordStore: { shutdown() { events.push('records-stop'); } },
        tdbKnowledgeManager: null, knowledgeBaseManager: null, mainCpuSampler: null,
        logger: { getLogWriteStream() { return null; } }
    });
    vm.runInContext(functions, context, { filename: 'server-shutdown-extracted.js' });
    let run;
    try {
        run = vm.runInContext("gracefulShutdown(1, 'test')", context);
        if (repeated) {
            const second = vm.runInContext("gracefulShutdown(1, 'duplicate-test')", context);
            second.catch(() => {});
        }
        if (natural) setTimeout(() => response.end('data: finished\n\n'), 40);
        await Promise.race([exited, delay(2500).then(() => { throw Error('TEST_EXIT_TIMEOUT'); })]);
        assert.equal(logs.some(l => l.includes('Graceful shutdown timed out.')), false,
            'must finish without the global force-exit timer');
        assert.equal(events.filter(e => e === 'plugin-stop').length, 1, 'plugin cleanup must run once');
        assert.ok(events.indexOf('plugin-stop') < events.indexOf('records-stop'));
        assert.deepEqual(exits, [1]);
        if (mode === 'natural') assert.equal(requestContext.aborted, false);
        if (mode === 'active') assert.equal(requestContext.abortController.signal.aborted, true);
        assert.equal(server.listening, false);
    } finally {
        clientResponse?.destroy(); client?.destroy();
        for (const socket of trackedSockets) socket.destroy();
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(() => resolve()));
        if (run) await Promise.race([run, delay(1000)]);
        for (const timer of timers) clearTimeout(timer);
    }
}
test('normal HTTP response drains before plugin cleanup', { timeout: 5000 }, () => scenario('natural'));
test('hanging chat stream is aborted before plugin cleanup, not global forced exit', { timeout: 5000 }, () => scenario('active'));
test('non-chat HTTP stream cannot prevent plugin cleanup', { timeout: 5000 }, () => scenario('untracked'));

test('normal non-chat HTTP response is allowed to finish before teardown', { timeout: 5000 },
    () => scenario('natural-untracked'));
test('duplicate shutdown requests perform plugin cleanup and exit only once', { timeout: 5000 },
    () => scenario('active', true));