'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ensureAdmin = require('../scripts/ensure_admin_panel.js');
const {
    createAdminPanelReadinessMiddleware,
    createAdminPanelBuildController,
    renderMissingAssetsPage
} = require('../modules/adminPanelBootstrap.js');
const {
    createReceipt,
    getControllerCleanupBudgets,
    getProcessTreeCleanupBudgetMs
} = require('../modules/adminPanelBuildProtocol.js');
const {
    hasProcessGroup,
    runTaskkill,
    terminateOwnedProcessTree
} = require('../modules/adminPanelProcessTree.js');

function makeChild(pid = 40001) {
    const child = new EventEmitter();
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => false;
    child.connected = true;
    child.send = (_message, callback) => {
        if (callback) callback(null);
        return true;
    };
    return child;
}

function fakeCleanupOptions() {
    return {
        platform: 'linux',
        cleanupGraceMs: 1,
        hasProcessGroup: () => false,
        signalGroup() { throw new Error('the fake process has no OS process group'); },
        termGraceMs: 2,
        forceWaitMs: 2,
        pollMs: 1
    };
}

function makeFixture(t, indexHtml) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-admin-panel-safety-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dist = path.join(root, 'AdminPanel-Vue', 'dist');
    const assets = path.join(dist, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    if (indexHtml !== undefined) fs.writeFileSync(path.join(dist, 'index.html'), indexHtml);
    return { root, dist, assets };
}

function writeValidAssets(fixture) {
    fs.writeFileSync(path.join(fixture.assets, 'app.js'), 'globalThis.app = true;');
    fs.writeFileSync(path.join(fixture.dist, 'index.html'),
        '<script type="module" src="./assets/app.js"></script>');
}

function snapshotTree(root) {
    const rows = [];
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const fullPath = path.join(directory, entry.name);
            const relative = path.relative(root, fullPath);
            if (entry.isDirectory()) {
                rows.push(['directory', relative]);
                visit(fullPath);
            } else {
                const stat = fs.statSync(fullPath);
                rows.push(['file', relative, stat.size, stat.mtimeMs, fs.readFileSync(fullPath).toString('hex')]);
            }
        }
    }
    visit(root);
    return rows;
}

function quietLogger() {
    return { log() {}, warn() {}, error() {} };
}

function createLinkedBuildRun(t, options = {}) {
    const fixture = makeFixture(t);
    const binDir = path.join(fixture.root, 'AdminPanel-Vue', 'node_modules', '.bin');
    if (!options.missingVite) {
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'vite'), 'synthetic executable marker');
        fs.writeFileSync(path.join(binDir, 'vite.cmd'), 'synthetic executable marker');
    }

    const helperChild = makeChild(42001);
    const buildChild = makeChild(42002);
    const helperIpc = new EventEmitter();
    helperIpc.connected = true;
    let helperTask = null;
    let outerGroupAlive = true;
    let innerGroupAlive = true;
    let invocationId = null;
    let innerAliveAtOuterTermination = null;
    const outerSignals = [];
    let helperExitCount = 0;
    let receiptCount = 0;

    function closeHelper(code, signal) {
        helperExitCount += 1;
        if (helperExitCount > 1 && !options.allowDuplicateClose) return;
        outerGroupAlive = false;
        helperChild.exitCode = Number.isInteger(code) ? code : null;
        helperChild.signalCode = signal || null;
        helperChild.emit('exit', code, signal || null);
        helperChild.emit('close', code, signal || null);
        helperIpc.connected = false;
        helperChild.emit('disconnect');
        if (helperIpc.listenerCount('message') > 0) helperIpc.emit('disconnect');
    }

    helperChild.send = (message, callback) => {
        if (options.cancelSendFailure) {
            if (callback) callback(new Error('synthetic IPC send failure'));
            return false;
        }
        if (helperIpc.connected) helperIpc.emit('message', message);
        if (callback) callback(null);
        return true;
    };

    helperIpc.send = (message, callback) => {
        if (!helperIpc.connected || options.receiptSendFailure || options.disconnectBeforeReceipt) {
            if (options.disconnectBeforeReceipt) helperChild.emit('disconnect');
            if (callback) callback(new Error('synthetic IPC receipt failure'));
            return false;
        }
        let delivered = message;
        receiptCount += 1;
        if (options.receiptTransform) delivered = options.receiptTransform(message);
        if (options.closeBeforeReceipt) {
            setImmediate(() => {
                closeHelper(1, null);
                setTimeout(() => helperChild.emit('message', delivered), 10);
            });
            return true;
        }
        if (Array.isArray(delivered)) {
            for (const item of delivered) helperChild.emit('message', item);
        } else if (delivered !== null) {
            helperChild.emit('message', delivered);
        }
        if (callback) callback(null);
        return true;
    };

    const controller = createAdminPanelBuildController({
        scriptPath: 'ensure_admin_panel.js',
        cwd: fixture.root,
        enabled: true,
        validateOutput: () => false,
        platform: 'linux',
        timeoutMs: options.controllerTimeoutMs ?? 8,
        cleanupGraceMs: options.cleanupGraceMs ?? 45,
        ipcSendTimeoutMs: options.ipcSendTimeoutMs ?? 5,
        termGraceMs: options.outerTermGraceMs ?? 2,
        forceWaitMs: options.outerForceWaitMs ?? 2,
        pollMs: 1,
        hasProcessGroup(pid) {
            return pid === helperChild.pid && outerGroupAlive;
        },
        signalGroup(pid, signal) {
            if (pid !== helperChild.pid) throw new Error('unexpected outer group');
            outerSignals.push(signal);
            if (signal === 'SIGTERM' && options.outerTermNoClose) return;
            if (signal === 'SIGTERM' || signal === 'SIGKILL') {
                innerAliveAtOuterTermination = innerGroupAlive;
                outerGroupAlive = false;
                closeHelper(null, signal);
            }
        },
        spawn(_command, _args, spawnOptions) {
            invocationId = spawnOptions.env.VCP_ADMIN_PANEL_BUILD_INVOCATION_ID;
            if (options.earlyHelperExit) {
                setImmediate(() => closeHelper(1, null));
                return helperChild;
            }
            const startHelper = () => {
                helperTask = ensureAdmin.main({
                    args: ['--build'],
                    root: fixture.root,
                    logger: quietLogger(),
                    invocationId,
                    ipcProcess: helperIpc,
                    platform: 'linux',
                    buildTimeoutMs: options.innerTimeoutMs ?? 500,
                    termGraceMs: options.innerTermGraceMs ?? 35,
                    forceWaitMs: options.innerForceWaitMs ?? 10,
                    pollMs: 1,
                    hasProcessGroup(pid) {
                        return pid === buildChild.pid && innerGroupAlive;
                    },
                    signalGroup(pid, signal) {
                        if (pid !== buildChild.pid) throw new Error('unexpected inner group');
                        if (options.innerCleanupUnconfirmed) {
                            if (signal === 'SIGTERM') {
                                buildChild.signalCode = 'SIGTERM';
                                buildChild.emit('exit', null, 'SIGTERM');
                                buildChild.emit('close', null, 'SIGTERM');
                            }
                            return;
                        }
                        if (signal === 'SIGTERM' && (options.innerDelayMs || 0) > 0) {
                            setTimeout(() => {
                                innerGroupAlive = false;
                                buildChild.signalCode = 'SIGTERM';
                                buildChild.emit('exit', null, 'SIGTERM');
                                buildChild.emit('close', null, 'SIGTERM');
                            }, options.innerDelayMs);
                            return;
                        }
                        innerGroupAlive = false;
                        buildChild.signalCode = signal;
                        buildChild.emit('exit', null, signal);
                        buildChild.emit('close', null, signal);
                    },
                    spawn(_commandName, _buildArgs, spawnOptionsForInner) {
                        assert.equal(spawnOptionsForInner.detached, true);
                        if (options.innerBuildFailure) {
                            setImmediate(() => buildChild.emit('close', 1, null));
                        }
                        return buildChild;
                    }
                });
                Promise.resolve(helperTask).then((code) => {
                    if (outerGroupAlive) closeHelper(code, null);
                }, () => closeHelper(1, null));
            };
            if (options.missingVite) setImmediate(startHelper);
            else startHelper();
            return helperChild;
        }
    });

    return {
        controller,
        fixture,
        helperChild,
        helperIpc,
        get helperTask() { return helperTask; },
        get innerAliveAtOuterTermination() { return innerAliveAtOuterTermination; },
        get innerGroupAlive() { return innerGroupAlive; },
        get outerSignals() { return outerSignals; },
        get receiptCount() { return receiptCount; },
        get invocationId() { return invocationId; }
    };
}

test('derived cleanup budgets include inner cleanup, bounded IPC delivery, and outer reap', () => {
    const linuxTree = getProcessTreeCleanupBudgetMs({ platform: 'linux' });
    const windowsTree = getProcessTreeCleanupBudgetMs({ platform: 'win32' });
    const linux = getControllerCleanupBudgets({ platform: 'linux' });
    const windows = getControllerCleanupBudgets({ platform: 'win32' });

    assert.equal(linuxTree, 4200);
    assert.deepEqual(linux, {
        innerCleanupMs: 4200,
        outerReapMs: 4200,
        ipcSendMs: 250,
        receiptDeliveryMs: 250,
        helperReapMs: 500,
        cooperativeWaitMs: 5200
    });
    assert.equal(windowsTree, 11200);
    assert.equal(windows.cooperativeWaitMs, 12200);
});

test('outer group disappearance without the linked helper inner receipt stays unconfirmed', async (t) => {
    const linked = createLinkedBuildRun(t, {
        cleanupGraceMs: 5,
        controllerTimeoutMs: 5,
        innerDelayMs: 45,
        outerTermNoClose: true,
        innerTermGraceMs: 45,
        innerForceWaitMs: 10
    });
    assert.equal(linked.controller.startIfEnabled(), true);
    await new Promise(resolve => setTimeout(resolve, 12));
    await linked.controller.waitForCleanup();

    assert.equal(linked.innerAliveAtOuterTermination, true);
    assert.deepEqual(linked.outerSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(linked.controller.getStatus().status, 'failed');
    assert.equal(linked.controller.getStatus().errorCode, 'timeout');
    assert.equal(linked.controller.getStatus().cleanupStatus, 'unconfirmed');
    assert.equal(linked.controller.isReady(), false);
    assert.equal(linked.receiptCount, 0);

    await linked.helperTask;
    await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(linked.controller.getStatus().cleanupStatus, 'unconfirmed');
    assert.equal(linked.helperChild.listenerCount('message'), 0);
    assert.equal(linked.helperIpc.listenerCount('message'), 0);
});

test('linked helper receipt plus inner and outer absence confirms composition only', async (t) => {
    const linked = createLinkedBuildRun(t, {
        cleanupGraceMs: 100,
        controllerTimeoutMs: 5,
        innerDelayMs: 14,
        innerTermGraceMs: 50,
        innerForceWaitMs: 10
    });
    assert.equal(linked.controller.startIfEnabled(), true);
    await new Promise(resolve => setTimeout(resolve, 10));
    await linked.controller.waitForCleanup();
    await linked.helperTask;

    assert.equal(linked.innerGroupAlive, false);
    assert.equal(linked.controller.getStatus().status, 'failed');
    assert.equal(linked.controller.getStatus().errorCode, 'timeout');
    assert.equal(linked.controller.getStatus().cleanupStatus, 'confirmed');
    assert.equal(linked.controller.isReady(), false);
    assert.equal(linked.helperChild.listenerCount('message'), 0);
    assert.equal(linked.helperIpc.listenerCount('message'), 0);
});

test('inner unconfirmed cleanup cannot be upgraded by successful outer cleanup', async (t) => {
    const linked = createLinkedBuildRun(t, {
        cleanupGraceMs: 100,
        controllerTimeoutMs: 5,
        innerCleanupUnconfirmed: true,
        innerTermGraceMs: 8,
        innerForceWaitMs: 8
    });
    linked.controller.startIfEnabled();
    await new Promise(resolve => setTimeout(resolve, 10));
    await linked.controller.waitForCleanup();
    await linked.helperTask;

    assert.equal(linked.innerGroupAlive, true);
    assert.equal(linked.controller.getStatus().cleanupStatus, 'unconfirmed');
    assert.equal(linked.controller.getStatus().status, 'failed');
    assert.equal(linked.controller.isReady(), false);
});

test('helper self-timeout and inner build error report cleanup without becoming ready', async (t) => {
    const timeoutRun = createLinkedBuildRun(t, {
        controllerTimeoutMs: 150,
        cleanupGraceMs: 100,
        innerTimeoutMs: 8
    });
    timeoutRun.controller.startIfEnabled();
    await timeoutRun.helperTask;
    await timeoutRun.controller.waitForCleanup();
    assert.equal(timeoutRun.controller.getStatus().errorCode, 'build_failed');
    assert.equal(timeoutRun.controller.getStatus().cleanupStatus, 'confirmed');
    assert.equal(timeoutRun.controller.isReady(), false);

    const buildErrorRun = createLinkedBuildRun(t, {
        controllerTimeoutMs: 150,
        cleanupGraceMs: 100,
        innerBuildFailure: true
    });
    buildErrorRun.controller.startIfEnabled();
    await buildErrorRun.helperTask;
    await buildErrorRun.controller.waitForCleanup();
    assert.equal(buildErrorRun.controller.getStatus().errorCode, 'build_failed');
    assert.equal(buildErrorRun.controller.getStatus().cleanupStatus, 'confirmed');
    assert.equal(buildErrorRun.controller.isReady(), false);
});

test('linked protocol fails closed for premature exit, absent or invalid receipts, and IPC faults', async (t) => {
    const invalidCases = [
        ['early helper exit', { earlyHelperExit: true }],
        ['missing receipt', { receiptSendFailure: true }],
        ['malformed receipt', { receiptTransform: receipt => ({ ...receipt, extra: true }) }],
        ['foreign receipt', { receiptTransform: receipt => ({
            ...receipt, invocationId: '00000000-0000-4000-8000-000000000001'
        }) }],
        ['duplicate receipt', { receiptTransform: receipt => [receipt, receipt] }],
        ['conflicting receipt', { receiptTransform: receipt => [receipt, {
            ...receipt, cleanup: 'unconfirmed'
        }] }],
        ['receipt contradicts helper exit', { receiptTransform: receipt => ({
            ...receipt, outcome: 'completed'
        }) }],
        ['receipt after helper close', { closeBeforeReceipt: true }],
        ['IPC disconnect', { disconnectBeforeReceipt: true }],
        ['cancel send callback error', { cancelSendFailure: true, innerTimeoutMs: 18 }]
    ];

    for (const [name, options] of invalidCases) {
        await t.test(name, async (subtest) => {
            const linked = createLinkedBuildRun(subtest, {
                cleanupGraceMs: 12,
                controllerTimeoutMs: 4,
                innerTermGraceMs: 4,
                innerForceWaitMs: 4,
                ...options
            });
            linked.controller.startIfEnabled();
            await new Promise(resolve => setTimeout(resolve, 8));
            await linked.controller.waitForCleanup();
            if (linked.helperTask) await linked.helperTask;
            await new Promise(resolve => setTimeout(resolve, 12));
            assert.equal(linked.controller.getStatus().status, 'failed');
            assert.equal(linked.controller.getStatus().cleanupStatus, 'unconfirmed');
            assert.equal(linked.controller.isReady(), false);
            for (const event of ['error', 'exit', 'close', 'message', 'disconnect']) {
                assert.equal(linked.helperChild.listenerCount(event), 0, event + ' listener leak');
            }
            assert.equal(linked.helperChild.stdout.listenerCount('data'), 0);
            assert.equal(linked.helperChild.stderr.listenerCount('data'), 0);
            assert.equal(linked.helperIpc.listenerCount('message'), 0);
        });
    }
});

test('a helper with no build started sends explicit lifecycle evidence', async (t) => {
    const linked = createLinkedBuildRun(t, { missingVite: true });
    linked.controller.startIfEnabled();
    await new Promise(resolve => setImmediate(resolve));
    await linked.helperTask;
    await linked.controller.waitForCleanup();

    assert.equal(linked.controller.getStatus().status, 'failed');
    assert.equal(linked.controller.getStatus().errorCode, 'build_failed');
    assert.equal(linked.controller.getStatus().cleanupStatus, 'confirmed');
    assert.equal(linked.controller.isReady(), false);
});

test('asset references are checked and cannot escape dist', (t) => {
    const fixture = makeFixture(t);
    writeValidAssets(fixture);
    assert.equal(ensureAdmin.verifyDistIntegrity(fixture.root).ok, true);

    fs.writeFileSync(path.join(fixture.dist, 'index.html'),
        '<script src="./assets/../../outside.js"></script>');
    assert.equal(ensureAdmin.verifyDistIntegrity(fixture.root).ok, false);

    fs.writeFileSync(path.join(fixture.dist, 'index.html'),
        '<script src="./assets/%2e%2e/outside.js"></script>');
    assert.equal(ensureAdmin.verifyDistIntegrity(fixture.root).ok, false);
});

test('asset references preserve supported URL prefixes and reject missing or malformed files', (t) => {
    const fixture = makeFixture(t);
    fs.writeFileSync(path.join(fixture.assets, 'app.js'), 'globalThis.app = true;');

    for (const prefix of ['./assets/', 'assets/', '/assets/', '/AdminPanel/assets/']) {
        fs.writeFileSync(path.join(fixture.dist, 'index.html'),
            `<script src="${prefix}app.js?v=1#entry"></script>`);
        assert.equal(ensureAdmin.verifyDistIntegrity(fixture.root).ok, true, prefix);
    }

    fs.writeFileSync(path.join(fixture.dist, 'index.html'),
        '<script src="./assets/missing.js"></script>');
    assert.equal(ensureAdmin.verifyDistIntegrity(fixture.root).ok, false);

    for (const reference of [
        './assets/../app.js',
        './assets/%2e%2e/app.js',
        './assets//app.js',
        './assets/app\\..\\secret.js'
    ]) {
        fs.writeFileSync(path.join(fixture.dist, 'index.html'),
            `<script src="${reference}"></script>`);
        assert.equal(ensureAdmin.verifyDistIntegrity(fixture.root).ok, false, reference);
    }
});

test('asset directory junctions and individual file links cannot escape canonical dist', (t) => {
    const fixture = makeFixture(t);
    writeValidAssets(fixture);

    const outsideDir = path.join(fixture.root, 'outside-assets');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'app.js'), 'outside');
    fs.rmSync(fixture.assets, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, fixture.assets, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(ensureAdmin.verifyDistIntegrity(fixture.root).ok, false);

    fs.rmSync(fixture.assets, { recursive: true, force: true });
    fs.mkdirSync(fixture.assets);
    const outsideFile = path.join(fixture.root, 'outside.js');
    fs.writeFileSync(outsideFile, 'outside');
    try {
        fs.symlinkSync(outsideFile, path.join(fixture.assets, 'app.js'), 'file');
    } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
            t.skip('host does not permit creating a file symlink');
            return;
        }
        throw error;
    }
    fs.writeFileSync(path.join(fixture.dist, 'index.html'),
        '<script src="./assets/app.js"></script>');
    assert.equal(ensureAdmin.verifyDistIntegrity(fixture.root).ok, false);
});

test('--check-only reads missing assets without spawning or writing', (t) => {
    const fixture = makeFixture(t);
    fs.writeFileSync(path.join(fixture.root, 'sentinel.txt'), 'keep');
    const before = snapshotTree(fixture.root);
    let buildCalls = 0;

    const result = ensureAdmin.main({
        root: fixture.root,
        args: ['--check-only'],
        logger: quietLogger(),
        runBuild() { buildCalls += 1; return { status: 0 }; }
    });

    assert.equal(result, 1);
    assert.equal(buildCalls, 0);
    assert.deepEqual(snapshotTree(fixture.root), before);

    const defaultResult = ensureAdmin.main({
        root: fixture.root,
        args: [],
        logger: quietLogger(),
        runBuild() { buildCalls += 1; return { status: 0 }; }
    });
    assert.equal(defaultResult, 1);
    assert.equal(buildCalls, 0);
    assert.deepEqual(snapshotTree(fixture.root), before);
});

test('explicit build is bounded to the build command and never installs dependencies', (t) => {
    const fixture = makeFixture(t);
    writeValidAssets(fixture);
    const binDir = path.join(fixture.root, 'AdminPanel-Vue', 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'vite.cmd' : 'vite'), '');

    const calls = [];
    const result = ensureAdmin.main({
        root: fixture.root,
        args: ['--build', '--force'],
        logger: quietLogger(),
        runBuild(_cwd, args) {
            calls.push(args);
            return { status: 0 };
        }
    });

    assert.equal(result, 0);
    assert.deepEqual(calls, [['run', 'build:no-type-check']]);
});

test('missing assets do not build by default and auto-build is opt-in and one-shot', () => {
    const child = makeChild();
    let spawnCalls = 0;

    const disabled = createAdminPanelBuildController({
        scriptPath: 'ensure_admin_panel.js',
        cwd: '.',
        enabled: false,
        validateOutput: () => false,
        ...fakeCleanupOptions(),
        spawn() { spawnCalls += 1; return child; }
    });
    assert.equal(disabled.startIfEnabled(), false);
    assert.equal(spawnCalls, 0);

    const enabled = createAdminPanelBuildController({
        scriptPath: 'ensure_admin_panel.js',
        cwd: '.',
        enabled: true,
        validateOutput: () => false,
        ...fakeCleanupOptions(),
        spawn() { spawnCalls += 1; return child; }
    });
    assert.equal(enabled.startIfEnabled(), true);
    assert.equal(enabled.startIfEnabled(), false);
    assert.equal(spawnCalls, 1);

    const secretText = '<script>do-not-render-this</script>';
    child.stderr.emit('data', Buffer.from(secretText.repeat(400)));
    child.stdout.emit('data', Buffer.from('output'.repeat(400)));
    assert.ok(enabled.getStatus().outputChars <= 8192);

    child.emit('close', 1, null);
    assert.equal(enabled.getStatus().status, 'failed');
    assert.equal(enabled.startIfEnabled(), false);
    assert.equal(spawnCalls, 1);

    const html = renderMissingAssetsPage(enabled.getStatus(), true);
    assert.equal(html.includes('do-not-render-this'), false);
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('build_failed'), false);
});

test('spawn errors and build deadlines reach terminal states without retry', async () => {
    let spawnCalls = 0;
    const erroredChild = makeChild();
    const spawnFailure = createAdminPanelBuildController({
        scriptPath: 'ensure_admin_panel.js',
        cwd: '.',
        enabled: true,
        validateOutput: () => false,
        cleanupGraceMs: 1,
        ...fakeCleanupOptions(),
        spawn() {
            spawnCalls += 1;
            setImmediate(() => erroredChild.emit('error', new Error('synthetic spawn failure')));
            return erroredChild;
        }
    });
    assert.equal(spawnFailure.startIfEnabled(), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(spawnFailure.getStatus().errorCode, 'spawn_failed');
    assert.equal(spawnFailure.startIfEnabled(), false);

    const timedChild = makeChild();
    let killed = false;
    const timeoutController = createAdminPanelBuildController({
        scriptPath: 'ensure_admin_panel.js',
        cwd: '.',
        enabled: true,
        validateOutput: () => false,
        timeoutMs: 20,
        cleanupGraceMs: 1,
        ...fakeCleanupOptions(),
        spawn() {
            spawnCalls += 1;
            return timedChild;
        }
    });
    timedChild.kill = () => { killed = true; return true; };
    assert.equal(timeoutController.startIfEnabled(), true);
    await new Promise(resolve => setTimeout(resolve, 60));
    await timeoutController.waitForCleanup();
    assert.equal(timeoutController.getStatus().errorCode, 'timeout');
    assert.equal(killed, true);
    assert.equal(timeoutController.startIfEnabled(), false);
    assert.equal(spawnCalls, 2);
});

test('a timed out or unclosed build cannot become ready from a late index file', async (t) => {
    const fixture = makeFixture(t);
    const child = makeChild();
    child.kill = () => false;
    let spawnCalls = 0;
    let outputValid = false;
    const controller = createAdminPanelBuildController({
        scriptPath: 'ensure_admin_panel.js',
        cwd: '.',
        enabled: true,
        validateOutput: () => outputValid && ensureAdmin.verifyDistIntegrity(fixture.root).ok,
        timeoutMs: 15,
        cleanupGraceMs: 10,
        ...fakeCleanupOptions(),
        spawn() { spawnCalls += 1; return child; }
    });

    assert.equal(controller.startIfEnabled(), true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(controller.getStatus().status, 'failed');
    await controller.waitForCleanup();
    writeValidAssets(fixture);
    outputValid = true;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    assert.equal(controller.isReady(), false);
    assert.equal(controller.startIfEnabled(), false);
    assert.equal(controller.getStatus().status, 'failed');
    assert.equal(controller.getStatus().errorCode, 'timeout');
    assert.equal(controller.getStatus().cleanupStatus, 'unconfirmed');
    assert.equal(controller.startIfEnabled(), false);
    assert.equal(spawnCalls, 1);
});

test('a complete existing deployment is ready at initialization without spawning', () => {
    let spawnCalls = 0;
    const controller = createAdminPanelBuildController({
        enabled: true,
        validateOutput: () => ({ ok: true }),
        ...fakeCleanupOptions(),
        spawn() { spawnCalls += 1; return makeChild(); }
    });
    assert.equal(controller.getStatus().status, 'ready');
    assert.equal(controller.isReady(), true);
    assert.equal(controller.startIfEnabled(), false);
    assert.equal(spawnCalls, 0);
});

test('a build is ready only after close code zero and complete output validation', async (t) => {
    const fixture = makeFixture(t);
    const child = makeChild();
    let outputValid = false;
    let invocationId;
    const controller = createAdminPanelBuildController({
        enabled: true,
        validateOutput: () => outputValid && ensureAdmin.verifyDistIntegrity(fixture.root).ok,
        ...fakeCleanupOptions(),
        spawn(_command, _args, spawnOptions) {
            invocationId = spawnOptions.env.VCP_ADMIN_PANEL_BUILD_INVOCATION_ID;
            return child;
        }
    });

    assert.equal(controller.startIfEnabled(), true);
    writeValidAssets(fixture);
    outputValid = true;
    child.emit('exit', 0, null);
    assert.equal(controller.getStatus().status, 'building');
    child.emit('message', createReceipt(invocationId, 'completed', 'started', 'not_required'));
    child.emit('close', 0, null);
    assert.equal(controller.getStatus().status, 'ready');
    assert.equal(controller.isReady(), true);
    assert.equal(controller.getStatus().cleanupStatus, 'not_requested');
    assert.equal(controller.startIfEnabled(), false);
    await controller.waitForCleanup();
});

test('exit zero with incomplete or escaping assets stays failed', async (t) => {
    const fixture = makeFixture(t);
    writeValidAssets(fixture);
    fs.writeFileSync(path.join(fixture.dist, 'index.html'),
        '<script src="./assets/../../outside.js"></script>');
    const child = makeChild();
    let invocationId;
    const controller = createAdminPanelBuildController({
        enabled: true,
        validateOutput: () => ensureAdmin.verifyDistIntegrity(fixture.root),
        ...fakeCleanupOptions(),
        spawn(_command, _args, spawnOptions) {
            invocationId = spawnOptions.env.VCP_ADMIN_PANEL_BUILD_INVOCATION_ID;
            return child;
        }
    });

    assert.equal(controller.startIfEnabled(), true);
    child.emit('exit', 0, null);
    child.emit('message', createReceipt(invocationId, 'failed', 'started', 'confirmed'));
    child.emit('close', 0, null);
    await controller.waitForCleanup();
    assert.equal(controller.getStatus().status, 'failed');
    assert.equal(controller.getStatus().errorCode, 'missing_output');
    assert.equal(controller.isReady(), false);
});

test('the same readiness middleware gates static and placeholder paths without adminServer startup', () => {
    let ready = false;
    let starts = 0;
    let nextCalls = 0;
    let placeholderCalls = 0;
    const controller = {
        isReady: () => ready,
        startIfEnabled() { starts += 1; return true; }
    };
    const middleware = createAdminPanelReadinessMiddleware(controller, () => {
        placeholderCalls += 1;
        return 'placeholder';
    });

    assert.equal(middleware({}, {}, () => { nextCalls += 1; }), 'placeholder');
    assert.equal(starts, 1);
    assert.equal(placeholderCalls, 1);
    assert.equal(nextCalls, 0);
    ready = true;
    assert.equal(middleware({}, {}, () => { nextCalls += 1; }), undefined);
    assert.equal(nextCalls, 1);
    assert.equal(placeholderCalls, 1);
});

test('owned POSIX cleanup escalates only against the detached operation group', async () => {
    const child = makeChild(41001);
    let groupAlive = true;
    const signals = [];
    const result = await terminateOwnedProcessTree(child, Promise.resolve(true), {
        platform: 'linux',
        ownedProcessGroup: true,
        hasProcessGroup: () => groupAlive,
        signalGroup(pid, signal) {
            signals.push([pid, signal]);
            if (signal === 'SIGKILL') groupAlive = false;
        },
        termGraceMs: 3,
        forceWaitMs: 10,
        pollMs: 1
    });

    assert.deepEqual(signals, [[41001, 'SIGTERM'], [41001, 'SIGKILL']]);
    assert.equal(result.confirmed, true);
    assert.equal(result.forceSent, true);
});

test('POSIX group absence requires ESRCH; unexpected probe errors fail closed', () => {
    assert.equal(hasProcessGroup(41007, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); }), false);
    assert.equal(hasProcessGroup(41007, () => { throw Object.assign(new Error(), { code: 'EIO' }); }), true);
});

test('unowned POSIX children are never signalled as a process group', async () => {
    const child = makeChild(41002);
    let groupSignals = 0;
    let directKills = 0;
    child.kill = () => { directKills += 1; return true; };
    const result = await terminateOwnedProcessTree(child, Promise.resolve(true), {
        platform: 'linux',
        ownedProcessGroup: false,
        hasProcessGroup: () => true,
        signalGroup() { groupSignals += 1; },
        termGraceMs: 1,
        forceWaitMs: 1,
        pollMs: 1
    });

    assert.equal(groupSignals, 0);
    assert.ok(directKills >= 1);
    assert.equal(result.confirmed, false);
});

test('Windows taskkill success alone does not prove descendant absence', async () => {
    const child = makeChild(41003);
    let taskkillCalls = 0;
    const result = await terminateOwnedProcessTree(child, Promise.resolve(true), {
        platform: 'win32',
        spawnTaskkill() {
            taskkillCalls += 1;
            const task = new EventEmitter();
            setImmediate(() => task.emit('close', 0));
            return task;
        },
        termGraceMs: 1,
        forceWaitMs: 1
    });

    assert.equal(taskkillCalls, 2);
    assert.equal(result.signalSent, true);
    assert.equal(result.confirmed, false);
    assert.equal(result.unavailable, true);
});

test('a timed out cleanup helper is killed and remains unconfirmed when it will not close', async () => {
    const child = makeChild(41004);
    let helperKills = 0;
    let task;
    const result = await runTaskkill(child, {
        taskkillTimeoutMs: 5,
        helperKillWaitMs: 3,
        spawnTaskkill() {
            task = new EventEmitter();
            task.kill = () => { helperKills += 1; return false; };
            return task;
        }
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.helperCleanupConfirmed, false);
    assert.ok(helperKills >= 2);
    assert.equal(task.listenerCount('error'), 0);
    assert.equal(task.listenerCount('close'), 0);
});

test('an explicit cancellation lets the build helper settle its owned group cleanup', async () => {
    const child = makeChild(41006);
    const abortController = new AbortController();
    let groupAlive = true;
    const signals = [];
    const resultPromise = ensureAdmin.runBuild('.', ['run', 'build:no-type-check'], {
        platform: 'linux',
        signal: abortController.signal,
        timeoutMs: 100,
        hasProcessGroup: () => groupAlive,
        signalGroup(pid, signal) {
            signals.push([pid, signal]);
            groupAlive = false;
        },
        spawn(_command, _args, options) {
            assert.equal(options.detached, true);
            return child;
        }
    });

    abortController.abort();
    setImmediate(() => child.emit('close', null, 'SIGTERM'));
    const result = await resultPromise;

    assert.deepEqual(signals, [[41006, 'SIGTERM']]);
    assert.equal(result.error.code, 'ECANCELED');
    assert.equal(result.cleanupStatus, 'confirmed');
});

test('build runner uses only the explicit build command and waits for close', async () => {
    const child = makeChild(41005);
    let invocation;
    const buildPromise = ensureAdmin.runBuild('.', ['run', 'build:no-type-check'], {
        timeoutMs: 50,
        spawn(command, args, options) {
            invocation = { command, args, options };
            setImmediate(() => child.emit('close', 0, null));
            return child;
        }
    });
    const result = await buildPromise;

    assert.deepEqual(invocation.args, ['run', 'build:no-type-check']);
    assert.doesNotMatch(invocation.args.join(' '), /install/i);
    assert.equal(invocation.options.detached, process.platform !== 'win32');
    assert.equal(result.status, 0);
    assert.equal(result.cleanupStatus, 'not_required');
});

test('spawn throw, missing PID, async error and duplicate callbacks settle once', async () => {
    const thrown = createAdminPanelBuildController({
        enabled: true,
        validateOutput: () => false,
        ...fakeCleanupOptions(),
        spawn() { throw new Error('synthetic synchronous spawn failure'); }
    });
    assert.equal(thrown.startIfEnabled(), false);
    assert.equal(thrown.getStatus().errorCode, 'spawn_failed');
    assert.equal(thrown.isReady(), false);

    const missingPidChild = makeChild();
    missingPidChild.pid = undefined;
    const missingPid = createAdminPanelBuildController({
        enabled: true,
        validateOutput: () => false,
        cleanupGraceMs: 1,
        ...fakeCleanupOptions(),
        spawn: () => missingPidChild
    });
    assert.equal(missingPid.startIfEnabled(), true);
    await missingPid.waitForCleanup();
    assert.equal(missingPid.getStatus().errorCode, 'spawn_failed');
    assert.equal(missingPid.isReady(), false);

    const child = makeChild();
    const controller = createAdminPanelBuildController({
        enabled: true,
        validateOutput: () => false,
        cleanupGraceMs: 1,
        ...fakeCleanupOptions(),
        spawn: () => child
    });
    assert.equal(controller.startIfEnabled(), true);
    child.emit('error', new Error('synthetic asynchronous spawn error'));
    child.emit('close', 0, null);
    child.emit('close', 0, null);
    await controller.waitForCleanup();
    assert.equal(controller.getStatus().status, 'failed');
    assert.equal(controller.getStatus().errorCode, 'spawn_failed');
    assert.equal(controller.isReady(), false);
    assert.equal(controller.startIfEnabled(), false);
    assert.equal(child.stdout.listenerCount('data'), 0);
});

test('startup and updater entry points do not discard dist or install/build implicitly', () => {
    const root = path.resolve(__dirname, '..');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const updater = fs.readFileSync(path.join(root, 'update.sh'), 'utf8');
    const starter = fs.readFileSync(path.join(root, '一键启动服务器start_server.bat'), 'utf8');
    const adminServer = fs.readFileSync(path.join(root, 'adminServer.js'), 'utf8');

    assert.match(packageJson.scripts['ensure:admin'], /--check-only/);
    assert.match(packageJson.scripts['build:admin'], /--build/);
    assert.doesNotMatch(updater, /git\s+(?:checkout|reset|clean)\b/i);
    assert.doesNotMatch(starter, /^\s*(?:call\s+)?npm\s+(?:install|run\s+build\b)/im);
    assert.match(starter, /npm run ensure:admin/);
    assert.doesNotMatch(adminServer, /triggerAdminPanelAutoBuild/);
    assert.match(adminServer, /validateOutput: \(\) => verifyDistIntegrity\(__dirname\)/);
    assert.match(adminServer, /if \(adminPanelBuildController\.isReady\(\)\)/);
    assert.ok(adminServer.indexOf('app.use("/AdminPanel", adminPanelReadinessMiddleware)') <
        adminServer.indexOf('app.use("/AdminPanel", express.static(VUE_ADMIN_PANEL_ROOT))'));
    assert.ok(adminServer.indexOf('app.use("/AdminPanelLegacy", adminPanelReadinessMiddleware)') <
        adminServer.indexOf('app.use("/AdminPanelLegacy", express.static(VUE_ADMIN_PANEL_ROOT))'));
    assert.doesNotMatch(adminServer, /existsSync\(VUE_ADMIN_PANEL_INDEX\)/);
    assert.match(adminServer, /agentAssistant 同时包含/);
    assert.match(adminServer, /RequestDiagnostics/);
});
