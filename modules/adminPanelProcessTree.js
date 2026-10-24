'use strict';

const { spawn: defaultSpawn } = require('node:child_process');
const {
    DEFAULT_FORCE_WAIT_MS,
    DEFAULT_HELPER_KILL_WAIT_MS,
    DEFAULT_TASKKILL_TIMEOUT_MS,
    DEFAULT_TERM_GRACE_MS,
    boundedTimerMs
} = require('./adminPanelBuildProtocol.js');

const DEFAULT_POLL_MS = 40;

function validPid(pid) {
    return Number.isInteger(pid) && pid > 0;
}

function isLive(child) {
    return Boolean(child && child.exitCode == null && child.signalCode == null);
}

function hasProcessGroup(pid, probe = process.kill) {
    if (!validPid(pid)) return false;
    try {
        probe(-pid, 0);
        return true;
    } catch (error) {
        if (error && error.code === 'ESRCH') return false;
        // EPERM and unexpected OS errors cannot prove that the owned group is absent.
        return true;
    }
}

function makeClosePromise(child) {
    if (!child || typeof child.once !== 'function') return Promise.resolve(false);
    return new Promise((resolve) => {
        child.once('close', () => resolve(true));
    });
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForOwnedProcessTreeExit(child, closePromise, options = {}) {
    const platform = options.platform || process.platform;
    const timeoutMs = boundedTimerMs(options.timeoutMs, DEFAULT_FORCE_WAIT_MS);
    const pollMs = boundedTimerMs(options.pollMs, DEFAULT_POLL_MS, 1);
    const pid = child && child.pid;
    let closed = false;
    Promise.resolve(closePromise).then((value) => { closed = value === true; }, () => {});
    const deadline = Date.now() + timeoutMs;

    while (true) {
        if (closed && platform === 'win32') {
            // taskkill /T and direct-child close alone cannot prove descendants are gone.
            if (typeof options.verifyWindowsTreeExit === 'function') {
                try {
                    if (await options.verifyWindowsTreeExit(pid) === true) return true;
                } catch {
                    return false;
                }
            }
            return false;
        }
        if (closed && options.ownedProcessGroup === true && validPid(pid)) {
            const probeGroup = options.hasProcessGroup || hasProcessGroup;
            if (!probeGroup(pid)) return true;
        }
        if (Date.now() >= deadline) return false;
        await wait(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
}

function signalPosixGroup(pid, signal, options = {}) {
    if (options.ownedProcessGroup !== true || !validPid(pid)) return false;
    const probeGroup = options.hasProcessGroup || hasProcessGroup;
    if (!probeGroup(pid)) return false;
    try {
        const signalGroup = options.signalGroup || ((groupPid, value) => process.kill(-groupPid, value));
        signalGroup(pid, signal);
        return true;
    } catch {
        return false;
    }
}

function runTaskkill(child, options = {}) {
    const pid = child && child.pid;
    if (!validPid(pid) || !isLive(child)) {
        return Promise.resolve({ ok: false, unavailable: true });
    }
    const spawnTaskkill = options.spawnTaskkill || defaultSpawn;
    const timeoutMs = boundedTimerMs(options.taskkillTimeoutMs, DEFAULT_TASKKILL_TIMEOUT_MS, 1);
    const helperKillWaitMs = boundedTimerMs(options.helperKillWaitMs, DEFAULT_HELPER_KILL_WAIT_MS);

    return new Promise((resolve) => {
        let task;
        let settled = false;
        let timeoutStarted = false;
        let timer = null;
        let closeResolve;
        const closePromise = new Promise((resolveClose) => { closeResolve = resolveClose; });
        let closeObserved = false;
        let onTaskError;
        let onTaskClose;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (task) {
                task.removeListener?.('error', onTaskError);
                task.removeListener?.('close', onTaskClose);
            }
            resolve(result);
        };

        try {
            task = spawnTaskkill('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true
            });
        } catch {
            finish({ ok: false, unavailable: true });
            return;
        }

        if (!task || typeof task.once !== 'function') {
            finish({ ok: false, unavailable: true });
            return;
        }
        onTaskError = () => finish({ ok: false, spawnFailed: true, helperCleanupConfirmed: false });
        onTaskClose = (code) => {
            closeObserved = true;
            closeResolve(true);
            if (!timeoutStarted) finish({ ok: code === 0, helperCleanupConfirmed: true });
        };
        task.once('error', onTaskError);
        task.once('close', onTaskClose);
        timer = setTimeout(async () => {
            timeoutStarted = true;
            timer = null;
            try {
                if (typeof task.kill === 'function') task.kill('SIGTERM');
            } catch { /* A bounded close wait below determines helper cleanup evidence. */ }
            let helperClosed = closeObserved || await closeObservedWithin(closePromise, helperKillWaitMs);
            if (!helperClosed) {
                try {
                    if (typeof task.kill === 'function') task.kill('SIGKILL');
                } catch { /* Keep cleanup unconfirmed if the helper does not close. */ }
                helperClosed = closeObserved || await closeObservedWithin(closePromise, helperKillWaitMs);
            }
            finish({ ok: false, timedOut: true, helperCleanupConfirmed: helperClosed });
        }, timeoutMs);
    });
}

function closeObservedWithin(closePromise, timeoutMs) {
    const boundedMs = boundedTimerMs(timeoutMs, DEFAULT_HELPER_KILL_WAIT_MS);
    let timer;
    return Promise.race([
        closePromise.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), boundedMs); })
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

async function terminateOwnedProcessTree(child, closePromise, options = {}) {
    const platform = options.platform || process.platform;
    const termGraceMs = boundedTimerMs(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
    const forceWaitMs = boundedTimerMs(options.forceWaitMs, DEFAULT_FORCE_WAIT_MS);
    const pid = child && child.pid;
    const close = closePromise || makeClosePromise(child);
    let signalSent = false;
    let forceSent = false;
    const ownedProcessGroup = platform !== 'win32' && options.ownedProcessGroup === true && validPid(pid);

    if (platform === 'win32') {
        const taskkill = await runTaskkill(child, options);
        signalSent = taskkill.ok;
        if (!taskkill.ok && isLive(child) && typeof child.kill === 'function') {
            try { signalSent = Boolean(child.kill('SIGTERM')); } catch { signalSent = false; }
        }
    } else if (ownedProcessGroup) {
        signalSent = signalPosixGroup(pid, 'SIGTERM', options);
        if (!signalSent && isLive(child) && typeof child.kill === 'function') {
            try { signalSent = Boolean(child.kill('SIGTERM')); } catch { signalSent = false; }
        }
    } else if (isLive(child) && typeof child.kill === 'function') {
        try { signalSent = Boolean(child.kill('SIGTERM')); } catch { signalSent = false; }
    }

    let confirmed = await waitForOwnedProcessTreeExit(child, close, {
        platform,
        ownedProcessGroup,
        hasProcessGroup: options.hasProcessGroup,
        verifyWindowsTreeExit: options.verifyWindowsTreeExit,
        timeoutMs: termGraceMs,
        pollMs: options.pollMs
    });

    if (!confirmed) {
        if (platform === 'win32') {
            const taskkill = await runTaskkill(child, options);
            forceSent = taskkill.ok;
        } else if (ownedProcessGroup && (options.hasProcessGroup || hasProcessGroup)(pid)) {
            forceSent = signalPosixGroup(pid, 'SIGKILL', options);
        } else if (isLive(child) && typeof child.kill === 'function') {
            try { forceSent = Boolean(child.kill('SIGKILL')); } catch { forceSent = false; }
        }
        confirmed = await waitForOwnedProcessTreeExit(child, close, {
            platform,
            ownedProcessGroup,
            hasProcessGroup: options.hasProcessGroup,
            verifyWindowsTreeExit: options.verifyWindowsTreeExit,
            timeoutMs: forceWaitMs,
            pollMs: options.pollMs
        });
    }

    return {
        confirmed,
        signalSent,
        forceSent,
        unavailable: platform === 'win32' && typeof options.verifyWindowsTreeExit !== 'function'
    };
}

module.exports = {
    hasProcessGroup,
    isLive,
    makeClosePromise,
    runTaskkill,
    terminateOwnedProcessTree,
    waitForOwnedProcessTreeExit
};
