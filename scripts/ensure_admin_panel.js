'use strict';

const fs = require('fs');
const path = require('path');
const { spawn: defaultSpawn } = require('node:child_process');
const {
    terminateOwnedProcessTree
} = require('../modules/adminPanelProcessTree.js');
const {
    CANCEL_TYPE,
    IPC_RECEIPT_DELIVERY_MS,
    PROTOCOL_VERSION,
    boundedTimerMs,
    createReceipt,
    isInvocationId
} = require('../modules/adminPanelBuildProtocol.js');

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const NODE_HEAP_LIMIT = '--max-old-space-size=1024';

function isWithin(parent, candidate) {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' ||
        (relative !== '..' &&
            !relative.startsWith('..' + path.sep) &&
            !path.isAbsolute(relative));
}

function resolveAssetReference(value, distDir, distAssets) {
    const clean = String(value || '').split(/[?#]/, 1)[0];
    const looksLikeAssetsPath = /(^|[./\\])assets(?:[\\/]|$)/i.test(clean);
    let relativeAsset = null;

    if (clean.startsWith('./assets/')) {
        relativeAsset = clean.slice('./assets/'.length);
    } else if (clean.startsWith('assets/')) {
        relativeAsset = clean.slice('assets/'.length);
    } else if (clean.startsWith('/assets/')) {
        relativeAsset = clean.slice('/assets/'.length);
    } else if (clean.startsWith('/AdminPanel/assets/')) {
        relativeAsset = clean.slice('/AdminPanel/assets/'.length);
    }

    if (relativeAsset === null) {
        return looksLikeAssetsPath ? { invalid: true } : { recognized: false };
    }
    if (!relativeAsset || /[\\%:\u0000-\u001f]/.test(relativeAsset)) {
        return { invalid: true };
    }

    const segments = relativeAsset.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        return { invalid: true };
    }

    const assetPath = path.resolve(distAssets, ...segments);
    if (!isWithin(distAssets, assetPath) || !isWithin(distDir, assetPath)) {
        return { invalid: true };
    }
    return { recognized: true, assetPath };
}

function verifyDistIntegrity(projectRoot) {
    const root = path.resolve(projectRoot);
    const distDir = path.join(root, 'AdminPanel-Vue', 'dist');
    const distAssets = path.join(distDir, 'assets');
    const distIndex = path.join(distDir, 'index.html');

    try {
        if (!fs.existsSync(distIndex) || !fs.statSync(distIndex).isFile()) {
            return { ok: false, reason: 'dist/index.html does not exist' };
        }
        if (!fs.existsSync(distAssets) || !fs.statSync(distAssets).isDirectory()) {
            return { ok: false, reason: 'dist/assets does not exist' };
        }

        const realDist = fs.realpathSync(distDir);
        const realIndex = fs.realpathSync(distIndex);
        if (!isWithin(realDist, realIndex)) {
            return { ok: false, reason: 'dist/index.html resolves outside dist' };
        }
        const realAssets = fs.realpathSync(distAssets);
        if (!isWithin(realDist, realAssets)) {
            return { ok: false, reason: 'dist/assets resolves outside dist' };
        }

        const html = fs.readFileSync(distIndex, 'utf8');
        const attributePattern = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi;
        const requiredAssets = [];
        let match;
        while ((match = attributePattern.exec(html)) !== null) {
            const result = resolveAssetReference(match[2], distDir, distAssets);
            if (result.invalid) {
                return { ok: false, reason: 'invalid or escaping asset reference' };
            }
            if (result.recognized) requiredAssets.push(result.assetPath);
        }

        if (requiredAssets.length === 0) {
            return { ok: false, reason: 'dist/index.html contains no local assets references' };
        }

        for (const assetPath of requiredAssets) {
            if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
                return { ok: false, reason: 'a referenced dist asset is missing' };
            }
            const realAsset = fs.realpathSync(assetPath);
            if (!isWithin(realAssets, realAsset) || !isWithin(realDist, realAsset)) {
                return { ok: false, reason: 'a referenced asset resolves outside dist/assets' };
            }
        }

        return { ok: true, distMtime: fs.statSync(distIndex).mtimeMs };
    } catch {
        return { ok: false, reason: 'unable to inspect AdminPanel-Vue assets' };
    }
}

function getMaxMtime(dirPath) {
    let max = 0;
    if (!fs.existsSync(dirPath)) return max;

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
            max = Math.max(max, getMaxMtime(fullPath));
        } else if (entry.isFile()) {
            max = Math.max(max, fs.statSync(fullPath).mtimeMs);
        }
    }
    return max;
}

function isSourceNewer(projectRoot, distMtime) {
    const root = path.resolve(projectRoot);
    const vueDir = path.join(root, 'AdminPanel-Vue');
    const keyTargets = [
        path.join(vueDir, 'package.json'),
        path.join(vueDir, 'vite.config.ts'),
        path.join(vueDir, 'index.html')
    ];

    for (const target of keyTargets) {
        if (fs.existsSync(target) && fs.statSync(target).mtimeMs > distMtime) {
            return { newer: true, file: path.relative(root, target) };
        }
    }

    if (getMaxMtime(path.join(vueDir, 'src')) > distMtime) {
        return { newer: true, file: 'AdminPanel-Vue/src' };
    }
    if (getMaxMtime(path.join(vueDir, 'public')) > distMtime) {
        return { newer: true, file: 'AdminPanel-Vue/public' };
    }
    return { newer: false };
}

function inspectAssets(projectRoot) {
    const root = path.resolve(projectRoot);
    const vueDir = path.join(root, 'AdminPanel-Vue');
    if (!fs.existsSync(vueDir) || !fs.statSync(vueDir).isDirectory()) {
        return { ok: false, reason: 'AdminPanel-Vue directory does not exist' };
    }

    const integrity = verifyDistIntegrity(root);
    if (!integrity.ok) return integrity;

    const sourceCheck = isSourceNewer(root, integrity.distMtime);
    if (sourceCheck.newer) {
        return { ok: false, reason: 'AdminPanel-Vue source is newer than dist' };
    }
    return { ok: true };
}

function runBuild(vueDir, args, options = {}) {
    const platform = options.platform || process.platform;
    const isWindows = platform === 'win32';
    const command = isWindows ? 'npm.cmd' : 'npm';
    const spawn = options.spawn || defaultSpawn;
    const currentNodeOptions = process.env.NODE_OPTIONS || '';
    const env = {
        ...process.env,
        NODE_ENV: 'development',
        NODE_OPTIONS: (currentNodeOptions + ' ' + NODE_HEAP_LIMIT).trim()
    };

    return new Promise((resolve) => {
        let child;
        let buildStarted = false;
        let settled = false;
        let stopping = false;
        let timeout = null;
        let stopError = null;
        let closeResolve;
        const closePromise = new Promise((resolveClose) => { closeResolve = resolveClose; });
        const treeOptions = {
            platform,
            ownedProcessGroup: !isWindows,
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

        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            options.signal?.removeEventListener('abort', onAbort);
            if (child) {
                child.removeListener?.('error', onError);
                child.removeListener?.('close', onClose);
            }
            resolve({ ...result, workStarted: buildStarted });
        };

        const stop = (error) => {
            if (settled || stopping) return;
            stopping = true;
            stopError = error;
            if (timeout) clearTimeout(timeout);
            timeout = null;
            terminateOwnedProcessTree(child, closePromise, treeOptions)
                .then((cleanup) => finish({
                    status: null,
                    signal: null,
                    error: stopError,
                    cleanupStatus: cleanup.confirmed ? 'confirmed' : 'unconfirmed'
                }))
                .catch(() => finish({
                    status: null,
                    signal: null,
                    error: stopError,
                    cleanupStatus: 'unconfirmed'
                }));
        };

        function onAbort() {
            const error = new Error('build cancelled');
            error.code = 'ECANCELED';
            stop(error);
        }

        function onError(error) {
            if (stopping) return;
            stop(error);
        }

        function onClose(code, signal) {
            closeResolve(true);
            if (stopping || settled) return;
            if (code === 0 && !signal) {
                finish({ status: code, signal: null, error: null, cleanupStatus: 'not_required' });
                return;
            }
            const error = new Error('build failed');
            error.code = 'EBUILD';
            stop(error);
        }

        try {
            child = spawn(command, args, {
                cwd: vueDir,
                env,
                stdio: 'inherit',
                shell: isWindows,
                detached: !isWindows,
                windowsHide: true
            });
        } catch (error) {
            finish({ status: null, signal: null, error, cleanupStatus: 'not_required' });
            return;
        }

        if (!child || typeof child.once !== 'function') {
            buildStarted = Boolean(child);
            finish({ status: null, signal: null, error: new Error('build process could not be started'),
                cleanupStatus: buildStarted ? 'unconfirmed' : 'not_required' });
            return;
        }

        buildStarted = true;
        child.once('error', onError);
        child.once('close', onClose);
        if (!Number.isInteger(child.pid) || child.pid <= 0) {
            const error = new Error('build process PID is unavailable');
            error.code = 'ESRCH';
            stop(error);
            return;
        }
        if (options.signal) {
            if (options.signal.aborted) onAbort();
            else options.signal.addEventListener('abort', onAbort, { once: true });
        }
        if (!stopping) {
            timeout = setTimeout(() => {
                const error = new Error('build timed out');
                error.code = 'ETIMEDOUT';
                stop(error);
            }, boundedTimerMs(options.timeoutMs, BUILD_TIMEOUT_MS, 1));
        }
    });
}

function log(logger, method, message) {
    if (logger && typeof logger[method] === 'function') logger[method]('[ensure-admin-panel] ' + message);
}

function sendReceiptBounded(ipcProcess, receipt, timeoutMs = IPC_RECEIPT_DELIVERY_MS) {
    if (!ipcProcess || typeof ipcProcess.send !== 'function' || ipcProcess.connected === false) {
        return Promise.resolve(false);
    }
    const boundedMs = boundedTimerMs(timeoutMs, IPC_RECEIPT_DELIVERY_MS, 1);
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => finish(false), boundedMs);
        function finish(ok) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(ok);
        }
        try {
            ipcProcess.send(receipt, (error) => finish(!error));
        } catch {
            finish(false);
        }
    });
}

function main(options = {}) {
    const args = options.args || process.argv.slice(2);
    const root = path.resolve(options.root || path.resolve(__dirname, '..'));
    const logger = options.logger || console;
    const runner = options.runBuild || runBuild;
    const ipcProcess = options.ipcProcess || process;
    const invocationId = options.invocationId ||
        (options.env && options.env.VCP_ADMIN_PANEL_BUILD_INVOCATION_ID) ||
        process.env.VCP_ADMIN_PANEL_BUILD_INVOCATION_ID;
    const useReceiptProtocol = isInvocationId(invocationId) &&
        typeof ipcProcess.send === 'function';
    let onCancelMessage;
    let abortController;

    const complete = (result) => {
        if (onCancelMessage) ipcProcess.removeListener?.('message', onCancelMessage);
        if (!useReceiptProtocol) return result.code;
        const receipt = createReceipt(invocationId, result.outcome, result.work, result.cleanup);
        return sendReceiptBounded(ipcProcess, receipt,
            options.receiptSendTimeoutMs).then((sent) => sent ? result.code : 1);
    };

    const noBuildResult = (code, outcome) => complete({
        code, outcome, work: 'not_started', cleanup: 'not_required'
    });
    const allowedArgs = new Set(['--check-only', '--build', '--force']);
    const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
    const checkOnly = args.includes('--check-only');
    const build = args.includes('--build');
    const force = args.includes('--force');

    if (unknownArgs.length || (checkOnly && (build || force)) || (force && !build)) {
        log(logger, 'error', 'Use --check-only to inspect, or --build [--force] for an explicit build.');
        return noBuildResult(2, 'failed');
    }

    let inspection;
    try {
        inspection = inspectAssets(root);
    } catch {
        inspection = { ok: false, reason: 'unable to inspect AdminPanel-Vue assets' };
    }

    if (inspection.ok && !force) {
        log(logger, 'log', 'AdminPanel-Vue assets are verified and up to date.');
        return noBuildResult(0, 'completed');
    }

    if (!build) {
        log(logger, 'error', 'Assets are missing or stale (' + inspection.reason + '). Run node scripts/ensure_admin_panel.js --build explicitly to build.');
        return noBuildResult(1, 'failed');
    }

    const vueDir = path.join(root, 'AdminPanel-Vue');
    const viteBin = path.join(vueDir, 'node_modules', '.bin',
        process.platform === 'win32' ? 'vite.cmd' : 'vite');
    if (!fs.existsSync(viteBin)) {
        log(logger, 'error', 'Vite is unavailable. Install AdminPanel-Vue dependencies manually, then retry the explicit build.');
        return noBuildResult(1, 'failed');
    }

    log(logger, 'log', 'Building bundles with build:no-type-check; this does not perform full TypeScript validation.');
    const finishBuild = (result) => {
        if (!result || typeof result !== 'object') {
            result = { status: null, error: true, cleanupStatus: 'unconfirmed', workStarted: true };
        }
        const work = result && result.workStarted === true ? 'started' : 'not_started';
        let cleanup = 'not_required';
        if (result.error || result.status !== 0) {
            const timedOut = result.error && result.error.code === 'ETIMEDOUT';
            const cleanupUnconfirmed = result.cleanupStatus === 'unconfirmed';
            log(logger, 'error', timedOut
                ? 'AdminPanel-Vue build exceeded the time limit.'
                : 'AdminPanel-Vue build failed.');
            if (cleanupUnconfirmed) {
                log(logger, 'error', 'Build cleanup could not be independently verified; output remains failed.');
            }
            cleanup = work === 'started'
                ? (result.cleanupStatus === 'confirmed' ? 'confirmed' : 'unconfirmed')
                : 'not_required';
            return {
                code: 1,
                outcome: result.error && result.error.code === 'ECANCELED' ? 'cancelled' : 'failed',
                work,
                cleanup
            };
        }

        const postCheck = verifyDistIntegrity(root);
        if (!postCheck.ok) {
            log(logger, 'error', 'Build finished, but static asset verification failed: ' + postCheck.reason + '.');
            return { code: 1, outcome: 'failed', work,
                cleanup: work === 'started' && result.cleanupStatus === 'confirmed'
                    ? 'confirmed' : (work === 'started' ? 'unconfirmed' : 'not_required') };
        }

        log(logger, 'log', 'AdminPanel-Vue assets passed post-build integrity checks.');
        return { code: 0, outcome: 'completed', work,
            cleanup: work === 'started' && result.cleanupStatus === 'confirmed'
                ? 'confirmed' : 'not_required' };
    };

    abortController = new AbortController();
    const signal = options.signal || abortController.signal;
    if (!options.signal && useReceiptProtocol && typeof ipcProcess.on === 'function') {
        onCancelMessage = (message) => {
            if (message && Object.keys(message).sort().join(',') === 'invocationId,type,version' &&
                message.type === CANCEL_TYPE && message.version === PROTOCOL_VERSION &&
                message.invocationId === invocationId) abortController.abort();
        };
        ipcProcess.on('message', onCancelMessage);
    }

    let result;
    try {
        result = runner(vueDir, ['run', 'build:no-type-check'], {
            signal,
            spawn: options.spawn,
            timeoutMs: options.buildTimeoutMs,
            termGraceMs: options.termGraceMs,
            forceWaitMs: options.forceWaitMs,
            platform: options.platform,
            hasProcessGroup: options.hasProcessGroup,
            signalGroup: options.signalGroup,
            pollMs: options.pollMs,
            spawnTaskkill: options.spawnTaskkill,
            taskkillTimeoutMs: options.taskkillTimeoutMs,
            helperKillWaitMs: options.helperKillWaitMs,
            verifyWindowsTreeExit: options.verifyWindowsTreeExit,
            receiptSendTimeoutMs: options.receiptSendTimeoutMs
        });
    } catch {
        if (onCancelMessage) ipcProcess.removeListener?.('message', onCancelMessage);
        return complete({ code: 1, outcome: 'failed', work: 'not_started', cleanup: 'not_required' });
    }

    if (result && typeof result.then === 'function') {
        return result.then(finishBuild, () => ({
            code: 1, outcome: 'failed', work: 'started', cleanup: 'unconfirmed'
        })).then(complete);
    }
    return complete(finishBuild(result));
}

if (require.main === module) {
    const result = main();
    if (result && typeof result.then === 'function') {
        result.then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
    } else {
        process.exitCode = result;
    }
}

module.exports = {
    getMaxMtime,
    inspectAssets,
    isSourceNewer,
    main,
    resolveAssetReference,
    runBuild,
    sendReceiptBounded,
    verifyDistIntegrity
};
