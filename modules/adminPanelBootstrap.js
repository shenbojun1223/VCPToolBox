'use strict';

const { spawn: defaultSpawn } = require('child_process');
const {
    terminateOwnedProcessTree
} = require('./adminPanelProcessTree.js');
const {
    CANCEL_TYPE,
    PROTOCOL_VERSION,
    boundedTimerMs,
    createInvocationId,
    getControllerCleanupBudgets,
    validateReceipt
} = require('./adminPanelBuildProtocol.js');

const MAX_CAPTURE_CHARS = 4096;
const DEFAULT_TIMEOUT_MS = 11 * 60 * 1000;

function appendBounded(current, chunk) {
    const next = current + Buffer.from(chunk).toString('utf8');
    return next.length > MAX_CAPTURE_CHARS ? next.slice(-MAX_CAPTURE_CHARS) : next;
}

function createAdminPanelBuildController(options = {}) {
    const scriptPath = options.scriptPath;
    const cwd = options.cwd;
    const enabled = options.enabled === true;
    const spawn = options.spawn || defaultSpawn;
    const timeoutMs = boundedTimerMs(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1);
    const processTreePlatform = options.platform || process.platform;
    const processTreeOptions = {
        platform: processTreePlatform,
        ownedProcessGroup: processTreePlatform !== 'win32',
        hasProcessGroup: options.hasProcessGroup,
        signalGroup: options.signalGroup,
        termGraceMs: options.termGraceMs,
        forceWaitMs: options.forceWaitMs,
        pollMs: options.pollMs,
        spawnTaskkill: options.spawnTaskkill,
        taskkillTimeoutMs: options.taskkillTimeoutMs,
        helperKillWaitMs: options.helperKillWaitMs,
        verifyWindowsTreeExit: options.verifyWindowsTreeExit
    };
    const cleanupBudgets = getControllerCleanupBudgets({
        innerProcessTreeOptions: { platform: processTreePlatform },
        outerProcessTreeOptions: processTreeOptions,
        ipcSendTimeoutMs: options.ipcSendTimeoutMs,
        receiptDeliveryMs: options.receiptDeliveryMs,
        helperReapAllowanceMs: options.helperReapAllowanceMs
    });
    const cleanupGraceMs = boundedTimerMs(
        options.cleanupGraceMs, cleanupBudgets.cooperativeWaitMs);
    const ipcSendTimeoutMs = cleanupBudgets.ipcSendMs;
    const validateOutput = typeof options.validateOutput === 'function'
        ? options.validateOutput
        : () => false;

    function outputIsValid() {
        try {
            const result = validateOutput();
            return result === true || Boolean(result && result.ok === true);
        } catch {
            return false;
        }
    }

    let state = {
        status: outputIsValid() ? 'ready' : 'idle',
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        cleanupStatus: 'not_requested'
    };
    let attempted = false;
    let child = null;
    let timeout = null;
    let settled = false;
    let cleanupPromise = null;
    let closePromise = null;
    let resolveClose = null;
    let closeSeen = false;
    let exitSeen = false;
    let invocationId = null;
    let receipt = null;
    let receiptSeen = false;
    let receiptInvalid = false;
    let ipcDisconnectedBeforeReceipt = false;
    let cleanupSendFailed = false;
    let cleanupWaiter = null;
    let listenerBindings = [];
    let streamBindings = [];
    let stdoutTail = '';
    let stderrTail = '';

    function clearTimer() {
        if (timeout) clearTimeout(timeout);
        timeout = null;
    }

    function detachListeners() {
        for (const [emitter, event, listener] of listenerBindings) {
            emitter.removeListener?.(event, listener);
        }
        for (const [emitter, event, listener] of streamBindings) {
            emitter.removeListener?.(event, listener);
        }
        listenerBindings = [];
        streamBindings = [];
    }

    function hasInnerCleanupProof() {
        if (!receipt || receiptInvalid || ipcDisconnectedBeforeReceipt || cleanupSendFailed) return false;
        if (receipt.work === 'not_started') return receipt.cleanup === 'not_required';
        return receipt.cleanup === 'confirmed';
    }

    function hasSuccessfulReceipt() {
        return Boolean(receipt && !receiptInvalid && !ipcDisconnectedBeforeReceipt &&
            receipt.outcome === 'completed' &&
            (receipt.cleanup === 'confirmed' || receipt.cleanup === 'not_required'));
    }

    function notifyCleanupWaiter() {
        if (cleanupWaiter) cleanupWaiter();
    }

    function finish(status, errorCode = null) {
        if (settled) return;
        settled = true;
        clearTimer();
        state = { ...state, status, errorCode, finishedAt: Date.now() };
        if (status === 'ready') {
            detachListeners();
            child = null;
        }
    }

    function waitForCleanupEvidence(ms) {
        if (receiptInvalid || ipcDisconnectedBeforeReceipt || cleanupSendFailed ||
            (receipt && closeSeen)) return Promise.resolve(true);
        let timerId;
        return new Promise((resolve) => {
            let done = false;
            const finishWait = (value) => {
                if (done) return;
                done = true;
                if (timerId) clearTimeout(timerId);
                cleanupWaiter = null;
                resolve(value);
            };
            cleanupWaiter = () => {
                if (receiptInvalid || ipcDisconnectedBeforeReceipt || cleanupSendFailed ||
                    (receipt && closeSeen)) finishWait(true);
            };
            timerId = setTimeout(() => finishWait(false), ms);
            cleanupWaiter();
        });
    }

    function sendCancelBounded(ownedChild, id) {
        if (typeof ownedChild.send !== 'function' || ownedChild.connected === false) {
            return Promise.resolve(false);
        }
        return new Promise((resolve) => {
            let done = false;
            const timerId = setTimeout(() => finishSend(false), ipcSendTimeoutMs);
            function finishSend(ok) {
                if (done) return;
                done = true;
                clearTimeout(timerId);
                resolve(ok);
            }
            try {
                ownedChild.send({ type: CANCEL_TYPE, version: PROTOCOL_VERSION, invocationId: id },
                    (error) => finishSend(!error));
            } catch {
                finishSend(false);
            }
        });
    }

    function beginCleanup() {
        if (cleanupPromise) return cleanupPromise;
        if (!child) {
            state = { ...state, cleanupStatus: 'not_requested' };
            cleanupPromise = Promise.resolve();
            return cleanupPromise;
        }

        state = { ...state, cleanupStatus: 'requested' };
        const ownedChild = child;
        cleanupPromise = (async () => {
            try {
                const cleanupDeadline = Date.now() + cleanupGraceMs;
                if (!closeSeen && !exitSeen) {
                    cleanupSendFailed = !(await sendCancelBounded(ownedChild, invocationId));
                    notifyCleanupWaiter();
                }
                const remainingCooperativeMs = Math.max(0, cleanupDeadline - Date.now());
                if (!cleanupSendFailed) await waitForCleanupEvidence(remainingCooperativeMs);
                const result = await terminateOwnedProcessTree(ownedChild, closePromise, processTreeOptions);
                state = {
                    ...state,
                    cleanupStatus: result.confirmed && closeSeen && hasInnerCleanupProof()
                        ? 'confirmed' : 'unconfirmed'
                };
            } catch {
                state = { ...state, cleanupStatus: 'unconfirmed' };
            } finally {
                cleanupWaiter = null;
                detachListeners();
                if (child === ownedChild) child = null;
            }
        })();
        return cleanupPromise;
    }

    function fail(errorCode, requestCleanup = true) {
        if (!settled) finish('failed', errorCode);
        if (requestCleanup) beginCleanup();
    }

    function isReady() {
        if (state.status === 'building' || state.status === 'failed') return false;
        if (!outputIsValid()) {
            if (state.status === 'ready') finish('failed', 'output_invalid');
            return false;
        }
        if (state.status === 'idle') state = { ...state, status: 'ready', errorCode: null };
        return state.status === 'ready';
    }

    function startIfEnabled() {
        if (state.status === 'ready' || state.status === 'building' || state.status === 'failed' || attempted) return false;
        if (isReady()) return false;
        if (!enabled) return false;

        attempted = true;
        settled = false;
        stdoutTail = '';
        stderrTail = '';
        state = {
            status: 'building',
            errorCode: null,
            startedAt: Date.now(),
            finishedAt: null,
            cleanupStatus: 'not_requested'
        };

        try {
            invocationId = createInvocationId();
            child = spawn(process.execPath, [scriptPath, '--build'], {
                cwd,
                env: {
                    ...process.env,
                    NODE_ENV: 'development',
                    VCP_ADMIN_PANEL_BUILD_INVOCATION_ID: invocationId
                },
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                detached: processTreePlatform !== 'win32',
                windowsHide: true
            });
        } catch {
            fail('spawn_failed', false);
            return false;
        }

        if (!child || typeof child.once !== 'function') {
            fail('spawn_failed', false);
            return false;
        }

        closePromise = new Promise((resolve) => { resolveClose = resolve; });
        closeSeen = false;

        const bind = (emitter, event, listener, collection) => {
            emitter.on(event, listener);
            collection.push([emitter, event, listener]);
        };

        if (child.stdout && typeof child.stdout.on === 'function') {
            bind(child.stdout, 'data', (chunk) => { stdoutTail = appendBounded(stdoutTail, chunk); }, streamBindings);
        }
        if (child.stderr && typeof child.stderr.on === 'function') {
            bind(child.stderr, 'data', (chunk) => { stderrTail = appendBounded(stderrTail, chunk); }, streamBindings);
        }
        bind(child, 'error', () => fail('spawn_failed'), listenerBindings);
        bind(child, 'exit', (code, signal) => {
            exitSeen = true;
            notifyCleanupWaiter();
            if (code !== 0 || signal) fail('build_failed');
        }, listenerBindings);
        bind(child, 'message', (message) => {
            if (receiptSeen) {
                receiptInvalid = true;
                receipt = null;
            } else {
                receiptSeen = true;
                if (closeSeen || !validateReceipt(message, invocationId)) receiptInvalid = true;
                else receipt = message;
            }
            notifyCleanupWaiter();
        }, listenerBindings);
        bind(child, 'disconnect', () => {
            if (!receiptSeen) {
                ipcDisconnectedBeforeReceipt = true;
                receiptInvalid = true;
            }
            notifyCleanupWaiter();
        }, listenerBindings);
        bind(child, 'close', (code, signal) => {
            closeSeen = true;
            if (receipt && ((code === 0 && !signal && receipt.outcome !== 'completed') ||
                ((code !== 0 || signal) && receipt.outcome === 'completed'))) {
                receiptInvalid = true;
            }
            if (!receiptSeen) receiptInvalid = true;
            resolveClose(true);
            notifyCleanupWaiter();
            if (settled) return;
            const validOutput = code === 0 && !signal && outputIsValid();
            if (validOutput && hasSuccessfulReceipt()) {
                finish('ready');
                return;
            }
            fail(code === 0 && !signal && !validOutput ? 'missing_output' :
                (!receipt || receiptInvalid ? 'helper_protocol' :
                (code === 0 ? 'missing_output' : 'build_failed')));
        }, listenerBindings);

        if (!Number.isInteger(child.pid) || child.pid <= 0) {
            fail('spawn_failed');
            return true;
        }

        timeout = setTimeout(() => {
            if (settled) return;
            fail('timeout');
        }, timeoutMs);
        timeout.unref?.();
        return true;
    }

    function getStatus() {
        return {
            ...state,
            outputChars: stdoutTail.length + stderrTail.length
        };
    }

    return {
        getStatus,
        isEnabled: () => enabled,
        isReady,
        startIfEnabled,
        waitForCleanup: () => cleanupPromise || Promise.resolve()
    };
}

function createAdminPanelReadinessMiddleware(controller, renderPlaceholder) {
    return function adminPanelReadinessMiddleware(req, res, next) {
        if (controller.isReady()) return next();
        controller.startIfEnabled();
        return renderPlaceholder(req, res);
    };
}

function renderMissingAssetsPage(status, autoBuildEnabled) {
    const messages = {
        idle: autoBuildEnabled
            ? '静态资源缺失，自动构建尚未启动。'
            : '静态资源缺失；自动构建默认关闭。',
        building: '静态资源构建正在运行。页面不会自动重复触发构建。',
        failed: '静态资源构建未完成。请检查服务日志，或手动运行下方命令。',
        ready: '静态资源已就绪，请重新加载页面。'
    };
    const message = messages[status && status.status] || messages.failed;
    return '<!DOCTYPE html>\n' +
        '<html lang="zh-CN"><head><meta charset="UTF-8">' +
        '<title>VCP 管理面板资源不可用</title>' +
        '<style>body{background:#0d1117;color:#e6edf3;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0}' +
        '.box{max-width:560px;padding:32px;border:1px solid #30363d;border-radius:12px;background:#161b22;text-align:center}' +
        'p{line-height:1.6;color:#8b949e}code{color:#7ee787}</style></head><body><main class="box">' +
        '<h2>VCP 管理面板暂不可用</h2><p>' + message + '</p>' +
        '<p>确认依赖已就绪后，可手动运行 <code>node scripts/ensure_admin_panel.js --build</code>。</p>' +
        '<button type="button" onclick="location.reload()">重新检查</button>' +
        '</main></body></html>';
}

module.exports = {
    createAdminPanelReadinessMiddleware,
    createAdminPanelBuildController,
    renderMissingAssetsPage
};
