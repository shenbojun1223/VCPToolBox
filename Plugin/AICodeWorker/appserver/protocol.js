"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

class SidecarError extends Error {
    constructor(code, message, details) {
        super(String(message || code || "Sidecar error"));
        this.name = "SidecarError";
        this.code = String(code || "SIDECAR_ERROR");
        if (details !== undefined) this.details = details;
    }
}

function normalizeDirectory(value, name) {
    if (typeof value !== "string" || !value.trim()) {
        throw new SidecarError("INVALID_PATH", `${name} is required`);
    }
    return path.resolve(value);
}

function stableHash(pluginDir, jobRoot) {
    const normalized = `${normalizeDirectory(pluginDir, "pluginDir")}\0${normalizeDirectory(jobRoot, "jobRoot")}`;
    return crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

function runtimePaths(pluginDir, jobRoot) {
    const normalizedPluginDir = normalizeDirectory(pluginDir, "pluginDir");
    const normalizedJobRoot = normalizeDirectory(jobRoot, "jobRoot");
    const hash = stableHash(normalizedPluginDir, normalizedJobRoot);
    const runtime = path.join(normalizedJobRoot, "runtime");
    const endpoint = process.platform === "win32"
        ? `\\\\.\\pipe\\vcp-aicodeworker-${hash}`
        : path.join(os.tmpdir(), `vcp-aicodeworker-${hash}.sock`);
    return {
        pluginDir: normalizedPluginDir,
        jobRoot: normalizedJobRoot,
        runtime,
        statePath: path.join(runtime, "sidecar-state.json"),
        lockPath: path.join(runtime, "sidecar.lock"),
        metaLockDir: path.join(runtime, "meta-locks"),
        endpoint
    };
}

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const META_UPDATE_SKIPPED = Symbol("META_UPDATE_SKIPPED");

function assertJobId(jobId) {
    if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
        throw new SidecarError("INVALID_JOB_ID", "jobId contains unsafe characters");
    }
    return jobId;
}

function assertAbsolutePath(value, field) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
        throw new SidecarError("INVALID_PATH", `${field} must be an absolute path`);
    }
    return path.resolve(value);
}

function samePath(left, right) {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function existingRealPath(value) {
    let candidate = path.resolve(value);
    const missing = [];
    while (!fs.existsSync(candidate)) {
        const parent = path.dirname(candidate);
        if (parent === candidate) return path.resolve(value);
        missing.unshift(path.basename(candidate));
        candidate = parent;
    }
    try {
        return path.join(fs.realpathSync.native(candidate), ...missing);
    } catch {
        return path.resolve(value);
    }
}

function isWithinDirectory(target, root) {
    const targetPath = existingRealPath(target);
    const rootPath = existingRealPath(root);
    const relative = path.relative(rootPath, targetPath);
    return relative === "" || (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

function assertWithinDirectory(target, root, field) {
    if (!isWithinDirectory(target, root)) {
        throw new SidecarError("PATH_OUTSIDE_JOB_ROOT", `${field} is outside jobRoot`);
    }
    return path.resolve(target);
}

function jobPaths(jobRoot, jobId) {
    const root = normalizeDirectory(jobRoot, "jobRoot");
    const id = assertJobId(jobId);
    return {
        metaPath: path.join(root, "meta", `${id}.json`),
        outputPath: path.join(root, "output", `${id}.txt`),
        codexOutputPath: path.join(root, "output", `${id}.codex-last.txt`)
    };
}

function validateJobPaths(jobRoot, jobId, supplied = {}) {
    const expected = jobPaths(jobRoot, jobId);
    const result = {};
    for (const [key, field] of [
        ["metaPath", "metaPath"],
        ["outputPath", "outputPath"],
        ["codexOutputPath", "codexOutputPath"]
    ]) {
        const suppliedPath = assertAbsolutePath(supplied[field], field);
        if (!samePath(suppliedPath, expected[key])) {
            throw new SidecarError("INVALID_JOB_PATH", `${field} does not match the fixed job path`);
        }
        result[field] = suppliedPath;
    }
    for (const [field, target] of Object.entries(result)) {
        assertWithinDirectory(target, jobRoot, field);
    }
    return result;
}

function ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true });
}

function atomicWriteFile(filePath, content) {
    ensureDirectory(path.dirname(filePath));
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    let fd;
    try {
        fd = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(fd, content, "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;

        try {
            fs.renameSync(temporary, filePath);
        } catch (error) {
            if (process.platform !== "win32" || !fs.existsSync(filePath)) throw error;
            const backup = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.old`;
            fs.renameSync(filePath, backup);
            try {
                fs.renameSync(temporary, filePath);
                try { fs.unlinkSync(backup); } catch {}
            } catch (replaceError) {
                try { fs.renameSync(backup, filePath); } catch {}
                throw replaceError;
            }
        }
    } catch (error) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch {}
        }
        try { fs.unlinkSync(temporary); } catch {}
        throw error;
    }
}

function writeJsonAtomic(filePath, value) {
    atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createJsonExclusive(filePath, value, options = {}) {
    const serialized = JSON.stringify(value, null, 2);
    if (typeof serialized !== "string") {
        throw new SidecarError("META_INVALID", "JSON value is not serializable");
    }
    ensureDirectory(path.dirname(filePath));
    const hooks = options.hooks || options;
    const openFile = hooks.openSync || fs.openSync;
    const writeFile = hooks.writeFileSync || fs.writeFileSync;
    const syncFile = hooks.fsyncSync || fs.fsyncSync;
    const closeFile = hooks.closeSync || fs.closeSync;
    const linkFile = hooks.linkSync || fs.linkSync;
    const unlinkFile = hooks.unlinkSync || fs.unlinkSync;
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`;
    let fd;
    let stage = "open";
    let primaryError = null;
    let cleanupError = null;
    try {
        fd = openFile(temporary, "wx", 0o600);
        stage = "write";
        writeFile(fd, `${serialized}\n`, "utf8");
        stage = "fsync";
        syncFile(fd);
        closeFile(fd);
        fd = undefined;
        stage = "publish";
        linkFile(temporary, filePath);
    } catch (error) {
        primaryError = error;
    } finally {
        if (fd !== undefined) {
            try { closeFile(fd); } catch {}
        }
        try { unlinkFile(temporary); } catch (error) { cleanupError = error; }
    }
    if (primaryError) {
        if (cleanupError) {
            throw new SidecarError(
                "META_CREATE_FINALIZATION_FAILED",
                "Could not clean up failed Job meta creation",
                { cause: primaryError?.code, cleanupCause: cleanupError?.code, stage }
            );
        }
        if (stage === "publish" && primaryError?.code === "EEXIST") {
            throw new SidecarError("META_ALREADY_EXISTS", "Job meta file already exists");
        }
        throw new SidecarError("META_CREATE_FAILED", "Could not create Job meta file", {
            cause: primaryError?.code,
            stage
        });
    }
    return filePath;
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonOrNull(filePath) {
    try { return readJson(filePath); } catch { return null; }
}

function validateStateRecord(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw new SidecarError("SIDECAR_STATE_INVALID", "Sidecar state must be an object");
    }
    if (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1) {
        throw new SidecarError("SIDECAR_STATE_INVALID", "Sidecar state schemaVersion is invalid");
    }
    for (const field of ["instanceId", "controlToken", "endpoint", "status"]) {
        if (typeof state[field] !== "string" || !state[field].trim()) {
            throw new SidecarError("SIDECAR_STATE_INVALID", `Sidecar state ${field} is missing`);
        }
    }
    if (!Number.isInteger(state.pid) || state.pid <= 0) {
        throw new SidecarError("SIDECAR_STATE_INVALID", "Sidecar state pid is invalid");
    }
    return state;
}

function readStateStrict(filePath) {
    let text;
    try {
        text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw new SidecarError("SIDECAR_STATE_READ_FAILED", "Could not read Sidecar state", { cause: error?.code });
    }
    let state;
    try {
        state = JSON.parse(text);
    } catch {
        throw new SidecarError("SIDECAR_STATE_INVALID", "Sidecar state contains malformed JSON");
    }
    return validateStateRecord(state);
}

function updateJsonAtomic(filePath, updater) {
    const current = readJson(filePath);
    const next = updater(current) || current;
    writeJsonAtomic(filePath, next);
    return next;
}

function isPidAlive(pid) {
    const number = Number(pid);
    if (!Number.isInteger(number) || number <= 0) return false;
    try {
        process.kill(number, 0);
        return true;
    } catch {
        return false;
    }
}

function getProcessIdentity(pid) {
    const number = Number(pid);
    if (!Number.isInteger(number) || number <= 0) return null;
    try {
        if (process.platform === "win32") {
            const script = "$ErrorActionPreference='Stop'; $p=Get-Process -Id " + number + "; [pscustomobject]@{Pid=$p.Id; StartTime=$p.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress";
            const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
                encoding: "utf8", timeout: 1500, windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
            });
            if (result.status !== 0 || !result.stdout) return null;
            const parsed = JSON.parse(result.stdout.trim());
            if (Number(parsed.Pid) !== number || typeof parsed.StartTime !== "string" || !parsed.StartTime) return null;
            return { pid: number, startTime: parsed.StartTime, source: "windows-get-process" };
        }
        if (process.platform === "linux") {
            const stat = fs.readFileSync(`/proc/${number}/stat`, "utf8");
            const end = stat.lastIndexOf(")");
            if (end < 0) return null;
            const fields = stat.slice(end + 2).trim().split(/\s+/);
            const startTimeTicks = fields[19];
            if (!startTimeTicks) return null;
            return { pid: number, startTimeTicks, source: "proc-stat" };
        }
        const result = spawnSync("ps", ["-o", "lstart=", "-p", String(number)], {
            encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"]
        });
        const startTime = String(result.stdout || "").trim();
        if (result.status !== 0 || !startTime) return null;
        return { pid: number, startTime, source: "ps-lstart" };
    } catch {
        return null;
    }
}

let localProcessIdentity = null;

function getLocalProcessIdentity() {
    if (localProcessIdentity) return localProcessIdentity;
    const identity = getProcessIdentity(process.pid);
    if (identity) localProcessIdentity = identity;
    return localProcessIdentity;
}

const localProcessIdentityProviderCache = new WeakMap();

async function getLocalProcessIdentityConfirmed(options = {}) {
    const identityProvider = typeof options.identityProvider === "function"
        ? options.identityProvider
        : getProcessIdentity;
    const cached = identityProvider === getProcessIdentity
        ? localProcessIdentity
        : localProcessIdentityProviderCache.get(identityProvider);
    if (cached) return cached;

    const timeoutMs = Math.min(1500, Math.max(0, Number(options.timeoutMs ?? options.maxWaitMs ?? 1500)));
    const delayMs = Math.min(50, Math.max(25, Number(options.delay ?? 35)));
    const deadline = Date.now() + timeoutMs;
    do {
        let identity = null;
        try { identity = await identityProvider(process.pid); } catch {}
        if (identity && typeof identity === "object") {
            if (identityProvider === getProcessIdentity) localProcessIdentity = identity;
            else localProcessIdentityProviderCache.set(identityProvider, identity);
            return identity;
        }
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now()))));
    } while (Date.now() < deadline);
    throw new SidecarError("LOCAL_PROCESS_IDENTITY_UNAVAILABLE", "Current process identity could not be verified");
}

function sameProcessIdentity(left, right) {
    if (!left || !right || Number(left.pid) !== Number(right.pid)) return false;
    if (left.startTimeTicks && right.startTimeTicks) return String(left.startTimeTicks) === String(right.startTimeTicks);
    if (left.startTime && right.startTime) return String(left.startTime) === String(right.startTime);
    return false;
}

async function terminateOwnedChild(child, options = {}) {
    if (!child || typeof child.kill !== "function") return { terminated: false, confirmed: false };
    const gracefulTimeoutMs = Math.max(0, Number(options.gracefulTimeoutMs ?? 750));
    const forceConfirmationTimeoutMs = Math.min(2000, Math.max(0,
        Number(options.forceConfirmationTimeoutMs ?? 1000)));
    const confirmationPollMs = Math.min(100, Math.max(10,
        Number(options.confirmationPollMs ?? 25)));
    const getIdentity = typeof options.identityProvider === "function"
        ? options.identityProvider
        : getProcessIdentity;
    const isAlive = typeof options.isPidAlive === "function"
        ? options.isPidAlive
        : isPidAlive;
    const identity = Object.prototype.hasOwnProperty.call(options, "identity")
        ? options.identity
        : getIdentity(child.pid);
    const hasExited = () => (child.exitCode !== null && child.exitCode !== undefined) ||
        (child.signalCode !== null && child.signalCode !== undefined);
    const waitForTermination = (timeoutMs, checkPid = true) => new Promise(resolve => {
        let settled = false;
        let timer;
        const finish = confirmed => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            child.removeListener?.("exit", onExit);
            child.removeListener?.("close", onClose);
            resolve(confirmed);
        };
        const onExit = () => finish(true);
        const onClose = () => finish(true);
        const poll = () => {
            if (hasExited()) return finish(true);
            if (checkPid) {
                let alive = true;
                try { alive = isAlive(child.pid) === true; } catch {}
                if (!alive) return finish(true);
            }
            if (Date.now() >= deadline) return finish(false);
            timer = setTimeout(poll, Math.min(confirmationPollMs, Math.max(0, deadline - Date.now())));
        };
        const deadline = Date.now() + timeoutMs;
        child.once?.("exit", onExit);
        child.once?.("close", onClose);
        poll();
    });
    if (hasExited()) return { terminated: false, confirmed: true, alreadyExited: true };
    if (identity) {
        const initialIdentity = getIdentity(child.pid);
        if (initialIdentity && !sameProcessIdentity(identity, initialIdentity)) {
            return { terminated: false, confirmed: false, identityMismatch: true };
        }
    }
    try { child.kill(options.signal || "SIGTERM"); } catch {}
    const exited = await waitForTermination(gracefulTimeoutMs, Boolean(identity));
    if (exited || hasExited()) return { terminated: true, confirmed: true, forced: false };
    const currentIdentity = getIdentity(child.pid);
    if (!identity || !currentIdentity || !sameProcessIdentity(identity, currentIdentity)) {
        return { terminated: false, confirmed: false, identityMismatch: true };
    }
    if (hasExited()) return { terminated: false, confirmed: true, alreadyExited: true };
    let forceSent = false;
    try {
        if (typeof options.forceKill === "function") {
            forceSent = options.forceKill(child) !== false;
        } else if (process.platform === "win32") {
            const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                stdio: "ignore", windowsHide: true
            });
            forceSent = result.status === 0;
        } else {
            forceSent = child.kill(options.forceSignal || "SIGKILL") !== false;
        }
    } catch {
        forceSent = false;
    }
    const confirmed = await waitForTermination(forceConfirmationTimeoutMs);
    return {
        terminated: forceSent || confirmed,
        confirmed,
        forced: true,
        forceSent,
        ...(confirmed ? {} : { stillAlive: true })
    };
}

async function reconcileDeadSidecarJobs(jobRoot, state, options = {}) {
    const hooks = options.hooks || {};
    const readDirectory = hooks.readdirSync || options.readdirSync || ((directory, readOptions) => fs.readdirSync(directory, readOptions));
    const readMeta = hooks.readJson || options.readJson || readJson;
    const updateMeta = options.updateJobMetaLocked || updateJobMetaLocked;
    const failure = (code, jobId) => jobId ? { jobId, code } : { code };
    if (!state || typeof state !== "object" || !state.instanceId) {
        return { reconciled: 0, complete: false, failures: [failure("STATE_INSTANCE_ID_MISSING")] };
    }
    const metaDir = path.join(normalizeDirectory(jobRoot, "jobRoot"), "meta");
    let entries;
    try {
        entries = readDirectory(metaDir, { withFileTypes: true });
    } catch (error) {
        if (error?.code === "ENOENT") return { reconciled: 0, complete: true, failures: [] };
        return { reconciled: 0, complete: false, failures: [failure("META_DIR_READ_FAILED")] };
    }
    const completedAt = options.completedAt || new Date().toISOString();
    let reconciled = 0;
    const failures = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith(".args.json")) continue;
        const metaPath = path.join(metaDir, entry.name);
        const jobId = entry.name.slice(0, -5);
        let initialMeta;
        try {
            initialMeta = readMeta(metaPath);
        } catch (error) {
            failures.push(failure(error instanceof SyntaxError ? "META_MALFORMED" : "META_READ_FAILED", jobId));
            continue;
        }
        if (!initialMeta || typeof initialMeta !== "object" || Array.isArray(initialMeta)) {
            failures.push(failure("META_MALFORMED", jobId));
            continue;
        }
        if (initialMeta.state !== "running" || initialMeta.executionBackend !== "codex-app-server" || initialMeta.sidecarInstanceId !== state.instanceId) continue;
        let updated = false;
        try {
            const result = await updateMeta(jobRoot, jobId, metaPath, meta => {
                if (!meta || typeof meta !== "object" || Array.isArray(meta) ||
                    meta.state !== "running" || meta.executionBackend !== "codex-app-server" ||
                    meta.sidecarInstanceId !== state.instanceId) return META_UPDATE_SKIPPED;
                meta.state = "failed";
                meta.completedAt = completedAt;
                meta.exitCode = 1;
                meta.errorCode = "SIDECAR_PROCESS_EXITED";
                meta.exitReason = "Sidecar process exited before Job completion";
                updated = true;
                return meta;
            }, { ...options, hooks: options.metaHooks || {} });
            if (updated && result?.updated !== false) reconciled++;
        } catch {
            failures.push(failure("META_UPDATE_FAILED", jobId));
        }
    }
    return { reconciled, complete: failures.length === 0, failures };
}

// Unsafe/test-only compatibility helper. Production code must use terminateOwnedChild.
function terminateExactPid(pid, force = true) {
    const number = Number(pid);
    if (!Number.isInteger(number) || number <= 0 || !isPidAlive(number)) return false;
    if (process.platform === "win32") {
        const args = ["/PID", String(number), "/T"];
        if (force) args.push("/F");
        const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
        return result.status === 0;
    }
    try {
        process.kill(number, force ? "SIGKILL" : "SIGTERM");
        return true;
    } catch {
        return false;
    }
}

function removeEndpoint(endpoint) {
    if (process.platform === "win32") return;
    try { fs.unlinkSync(endpoint); } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
}

function metaLockPath(jobRoot, jobId) {
    const root = normalizeDirectory(jobRoot, "jobRoot");
    return path.join(path.join(root, "runtime", "meta-locks"), `${assertJobId(jobId)}.lock`);
}

function parseMetaLockRecord(lockPath) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch (error) {
        if (error?.code === "ENOENT") return null;
        if (error instanceof SyntaxError) {
            throw new SidecarError("SIDECAR_META_LOCK_INVALID", "Meta lock is malformed");
        }
        throw new SidecarError("SIDECAR_META_LOCK_INVALID", "Meta lock could not be read", { cause: error?.code });
    }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        typeof value.ownerToken !== "string" || !value.ownerToken ||
        !Number.isInteger(value.pid) || value.pid <= 0 ||
        !Number.isFinite(value.createdAt) ||
        !value.processIdentity || typeof value.processIdentity !== "object") {
        throw new SidecarError("SIDECAR_META_LOCK_INVALID", "Meta lock record is invalid");
    }
    return value;
}

function openMetaLock(lockPath, processIdentity) {
    const ownerToken = crypto.randomBytes(16).toString("hex");
    const record = {
        ownerToken,
        pid: process.pid,
        processIdentity,
        createdAt: Date.now()
    };
    if (!record.processIdentity) {
        throw new SidecarError("SIDECAR_META_LOCK_INVALID", "Current process identity could not be verified");
    }
    const temporary = `${lockPath}.${process.pid}.${ownerToken}.tmp`;
    let fd;
    let published = false;
    try {
        fd = fs.openSync(temporary, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify(record), "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        try {
            fs.linkSync(temporary, lockPath);
            published = true;
        } catch (error) {
            if (error?.code !== "EEXIST") throw error;
        }
    } catch (error) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch {}
        }
        throw new SidecarError("SIDECAR_META_LOCK_FAILED", "Could not acquire Job meta lock", { cause: error?.code });
    } finally {
        try { fs.unlinkSync(temporary); } catch {}
    }
    return published ? { fd: undefined, ownerToken, record } : null;
}

function releaseMetaLock(lockPath, lock) {
    if (!lock) return false;
    try { fs.closeSync(lock.fd); } catch {}
    let current;
    try { current = parseMetaLockRecord(lockPath); } catch { return false; }
    if (!current || current.ownerToken !== lock.ownerToken ||
        Number(current.pid) !== process.pid || !sameProcessIdentity(current.processIdentity, lock.record.processIdentity)) {
        return false;
    }
    try {
        fs.unlinkSync(lockPath);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw new SidecarError("SIDECAR_META_LOCK_RELEASE_FAILED", "Could not release Job meta lock", { cause: error?.code });
    }
}

async function withJobMetaLock(jobRoot, jobId, operation, options = {}) {
    const normalizedJobRoot = normalizeDirectory(jobRoot, "jobRoot");
    const id = assertJobId(jobId);
    if (typeof operation !== "function") throw new SidecarError("INVALID_OPERATION", "Meta lock operation is required");
    const processIdentity = await getLocalProcessIdentityConfirmed(options);
    const lockPath = metaLockPath(normalizedJobRoot, id);
    ensureDirectory(path.dirname(lockPath));
    const waitMs = Math.max(0, Number(options.waitMs ?? options.metaLockWaitMs ?? 5000));
    const pollMs = Math.max(5, Number(options.pollMs || 25));
    const deadline = Date.now() + waitMs;
    let lock = null;
    while (!lock) {
        lock = openMetaLock(lockPath, processIdentity);
        if (lock) break;
        const existing = parseMetaLockRecord(lockPath);
        if (!existing) continue;
        if (!isPidAlive(existing.pid)) {
            throw new SidecarError("SIDECAR_META_LOCK_STALE", "Job meta lock owner is not alive");
        }
        const currentIdentity = Number(existing.pid) === process.pid
            ? processIdentity
            : getProcessIdentity(existing.pid);
        if (!currentIdentity) {
            throw new SidecarError("SIDECAR_META_LOCK_INVALID", "Job meta lock owner identity cannot be verified");
        }
        if (!sameProcessIdentity(existing.processIdentity, currentIdentity)) {
            throw new SidecarError("SIDECAR_META_LOCK_STALE", "Job meta lock owner identity does not match");
        }
        if (Date.now() >= deadline) throw new SidecarError("SIDECAR_META_LOCK_BUSY", "Job meta lock is held by another owner");
        await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    let operationFailed = false;
    try {
        return await operation({ jobRoot: normalizedJobRoot, jobId: id, lockPath, ownerToken: lock.ownerToken });
    } catch (error) {
        operationFailed = true;
        throw error;
    } finally {
        const released = releaseMetaLock(lockPath, lock);
        if (!released && !operationFailed) throw new SidecarError("SIDECAR_META_LOCK_RELEASE_FAILED", "Could not release Job meta lock");
    }
}

async function updateJobMetaLocked(jobRoot, jobId, suppliedMetaPath, updater, options = {}) {
    const normalizedJobRoot = normalizeDirectory(jobRoot, "jobRoot");
    const id = assertJobId(jobId);
    const expectedMetaPath = jobPaths(normalizedJobRoot, id).metaPath;
    const metaPath = assertAbsolutePath(suppliedMetaPath, "metaPath");
    if (!samePath(metaPath, expectedMetaPath)) throw new SidecarError("INVALID_JOB_PATH", "metaPath does not match the fixed job path");
    assertWithinDirectory(metaPath, normalizedJobRoot, "metaPath");
    if (typeof updater !== "function") throw new SidecarError("INVALID_OPERATION", "Meta updater is required");
    const hooks = options.hooks || {};
    const readMeta = hooks.readJson || readJson;
    const writeMeta = hooks.writeJsonAtomic || writeJsonAtomic;
    return withJobMetaLock(normalizedJobRoot, id, async () => {
        let current;
        try {
            current = readMeta(metaPath);
        } catch (error) {
            if (error instanceof SidecarError) throw error;
            throw new SidecarError(error instanceof SyntaxError ? "META_MALFORMED" : "META_READ_FAILED", "Could not read Job meta", { cause: error?.code });
        }
        if (!current || typeof current !== "object" || Array.isArray(current) || String(current.jobId || "") !== id) {
            throw new SidecarError("META_JOB_MISMATCH", "Job meta does not match jobId");
        }
        const revision = current.metaRevision === undefined ? 0 : Number(current.metaRevision);
        if (!Number.isSafeInteger(revision) || revision < 0) throw new SidecarError("META_INVALID", "Job metaRevision is invalid");
        const candidate = await updater(current);
        if (candidate === META_UPDATE_SKIPPED) return { updated: false, meta: current };
        if (candidate !== undefined && (!candidate || typeof candidate !== "object" || Array.isArray(candidate))) {
            throw new SidecarError("META_INVALID", "Meta updater returned an invalid object");
        }
        const next = { ...current, ...(candidate || {}) };
        if (String(next.jobId || "") !== id) throw new SidecarError("META_JOB_MISMATCH", "Meta updater changed jobId");
        next.metaRevision = revision + 1;
        writeMeta(metaPath, next);
        return { updated: true, meta: next };
    }, options);
}

module.exports = {
    SidecarError,
    runtimePaths,
    assertJobId,
    assertAbsolutePath,
    assertWithinDirectory,
    jobPaths,
    validateJobPaths,
    ensureDirectory,
    atomicWriteFile,
    writeJsonAtomic,
    createJsonExclusive,
    readJson,
    readJsonOrNull,
    readStateStrict,
    validateStateRecord,
    updateJsonAtomic,
    metaLockPath,
    withJobMetaLock,
    updateJobMetaLocked,
    META_UPDATE_SKIPPED,
    isPidAlive,
    getProcessIdentity,
    getLocalProcessIdentity,
    getLocalProcessIdentityConfirmed,
    sameProcessIdentity,
    terminateOwnedChild,
    reconcileDeadSidecarJobs,
    terminateExactPid,
    removeEndpoint,
    samePath
};
