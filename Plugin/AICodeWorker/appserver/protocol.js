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
        codexOutputPath: path.join(root, "output", `${id}.codex-last.txt`),
        patchPath: path.join(root, "patches", `${id}.patch`)
    };
}

function validatePatchJobPaths(jobRoot, jobId, supplied = {}) {
    const result = validateJobPaths(jobRoot, jobId, supplied);
    const expected = jobPaths(jobRoot, jobId);
    const patchPath = assertAbsolutePath(supplied.patchPath, "patchPath");
    if (!samePath(patchPath, expected.patchPath)) {
        throw new SidecarError("INVALID_JOB_PATH", "patchPath does not match the fixed job path");
    }
    assertWithinDirectory(patchPath, jobRoot, "patchPath");
    return { ...result, patchPath };
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

const PATCH_ARTIFACT_IDENTITY_VERSION = 1;
const PATCH_NONCE_RE = /^[0-9a-f]{24}$/;
const PATCH_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function artifactError(code, message, details) {
    return new SidecarError(code, message, details);
}

function pathIsWithinCanonical(target, root) {
    let targetPath = path.resolve(target);
    let rootPath = path.resolve(root);
    if (process.platform === "win32") {
        targetPath = targetPath.toLowerCase();
        rootPath = rootPath.toLowerCase();
    }
    const relative = path.relative(rootPath, targetPath);
    return relative === "" || (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

function readReliableIdentity(target, expectedType, code, hooks = {}) {
    let stat;
    let realpath;
    try {
        stat = (hooks.lstatSync || fs.lstatSync)(target, { bigint: true });
        if (stat.isSymbolicLink() || (expectedType === "directory" ? !stat.isDirectory() : !stat.isFile())) {
            throw artifactError(code, `Patch artifact ${expectedType} is unsafe`);
        }
        realpath = (hooks.realpathSync || fs.realpathSync.native)(target);
    } catch (error) {
        if (error instanceof SidecarError) throw error;
        throw artifactError(code, `Patch artifact ${expectedType} identity is unavailable`, { cause: error?.code });
    }
    if (typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint" || stat.dev < 0n || stat.ino <= 0n) {
        throw artifactError(code, `Patch artifact ${expectedType} identity is unreliable`);
    }
    return {
        dev: stat.dev.toString(10),
        ino: stat.ino.toString(10),
        realpath: path.resolve(realpath)
    };
}

function assertNoReparseDirectoryComponents(directory, code, hooks = {}) {
    const resolved = path.resolve(directory);
    const parsed = path.parse(resolved);
    let current = parsed.root;
    for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        let stat;
        try { stat = (hooks.lstatSync || fs.lstatSync)(current, { bigint: true }); } catch (error) {
            throw artifactError(code, "Patch artifact directory component is unavailable", { cause: error?.code });
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw artifactError(code, "Patch artifact directory component is unsafe");
        }
    }
}

function sameArtifactIdentity(left, right) {
    return Boolean(left && right &&
        String(left.dev) === String(right.dev) &&
        String(left.ino) === String(right.ino) &&
        samePath(left.realpath, right.realpath));
}

function sameArtifactObjectIdentity(left, right) {
    return Boolean(left && right &&
        String(left.dev) === String(right.dev) &&
        String(left.ino) === String(right.ino));
}

function normalizePatchDirectoryIdentity(identity, code = "AICW_PATCH_ARTIFACT_DIR_DRIFT") {
    if (!identity || typeof identity !== "object" || Array.isArray(identity) ||
        identity.schemaVersion !== PATCH_ARTIFACT_IDENTITY_VERSION ||
        typeof identity.canonicalJobRoot !== "string" ||
        typeof identity.jobRootDev !== "string" || typeof identity.jobRootIno !== "string" ||
        typeof identity.realpath !== "string" || typeof identity.dev !== "string" || typeof identity.ino !== "string" ||
        !/^\d+$/.test(identity.jobRootDev) || !/^\d+$/.test(identity.jobRootIno) ||
        !/^\d+$/.test(identity.dev) || !/^[1-9]\d*$/.test(identity.ino)) {
        throw artifactError(code, "Patch artifact directory identity is invalid");
    }
    return {
        schemaVersion: PATCH_ARTIFACT_IDENTITY_VERSION,
        canonicalJobRoot: path.resolve(identity.canonicalJobRoot),
        jobRootDev: identity.jobRootDev,
        jobRootIno: identity.jobRootIno,
        realpath: path.resolve(identity.realpath),
        dev: identity.dev,
        ino: identity.ino
    };
}

function pinPatchArtifactDirectory(jobRoot, options = {}) {
    const hooks = options.hooks || options;
    const rootPath = normalizeDirectory(jobRoot, "jobRoot");
    assertNoReparseDirectoryComponents(rootPath, "AICW_PATCH_ARTIFACT_DIR_UNSAFE", hooks);
    let rootIdentity = readReliableIdentity(rootPath, "directory", "AICW_PATCH_ARTIFACT_DIR_UNSAFE", hooks);
    const canonicalRootIdentity = readReliableIdentity(rootIdentity.realpath, "directory", "AICW_PATCH_ARTIFACT_DIR_UNSAFE", hooks);
    if (!sameArtifactIdentity(rootIdentity, canonicalRootIdentity)) {
        throw artifactError("AICW_PATCH_ARTIFACT_DIR_UNSAFE", "Patch jobRoot canonical identity is inconsistent");
    }
    const patchesPath = path.join(rootIdentity.realpath, "patches");
    let patchesIdentity;
    try {
        patchesIdentity = readReliableIdentity(patchesPath, "directory", "AICW_PATCH_ARTIFACT_DIR_UNSAFE", hooks);
    } catch (error) {
        if (error?.details?.cause !== "ENOENT" || options.create !== true) throw error;
        const rootBeforeCreate = readReliableIdentity(rootPath, "directory", "AICW_PATCH_ARTIFACT_DIR_UNSAFE", hooks);
        if (!sameArtifactIdentity(rootIdentity, rootBeforeCreate)) {
            throw artifactError("AICW_PATCH_ARTIFACT_DIR_DRIFT", "Patch jobRoot identity changed before directory creation");
        }
        try {
            (hooks.mkdirSync || fs.mkdirSync)(patchesPath, { recursive: false, mode: 0o700 });
        } catch (createError) {
            if (createError?.code !== "EEXIST") {
                throw artifactError("AICW_PATCH_ARTIFACT_DIR_UNSAFE", "Patch artifact directory could not be created", { cause: createError?.code });
            }
        }
        rootIdentity = readReliableIdentity(rootPath, "directory", "AICW_PATCH_ARTIFACT_DIR_DRIFT", hooks);
        patchesIdentity = readReliableIdentity(patchesPath, "directory", "AICW_PATCH_ARTIFACT_DIR_UNSAFE", hooks);
    }
    if (!pathIsWithinCanonical(patchesIdentity.realpath, rootIdentity.realpath) || !samePath(patchesIdentity.realpath, patchesPath)) {
        throw artifactError("AICW_PATCH_ARTIFACT_DIR_UNSAFE", "Patch artifact directory escapes canonical jobRoot");
    }
    const rootAfter = readReliableIdentity(rootPath, "directory", "AICW_PATCH_ARTIFACT_DIR_DRIFT", hooks);
    if (!sameArtifactIdentity(rootIdentity, rootAfter)) {
        throw artifactError("AICW_PATCH_ARTIFACT_DIR_DRIFT", "Patch jobRoot identity changed while pinning directory");
    }
    return Object.freeze({
        schemaVersion: PATCH_ARTIFACT_IDENTITY_VERSION,
        canonicalJobRoot: rootIdentity.realpath,
        jobRootDev: rootIdentity.dev,
        jobRootIno: rootIdentity.ino,
        realpath: patchesIdentity.realpath,
        dev: patchesIdentity.dev,
        ino: patchesIdentity.ino
    });
}

function verifyPatchArtifactDirectory(jobRoot, pinnedIdentity, options = {}) {
    const expected = normalizePatchDirectoryIdentity(pinnedIdentity);
    let current;
    try {
        current = pinPatchArtifactDirectory(jobRoot, { ...(options.hooks ? { hooks: options.hooks } : options), create: false });
    } catch (error) {
        if (error?.code === "AICW_PATCH_ARTIFACT_DIR_UNSAFE") {
            throw artifactError("AICW_PATCH_ARTIFACT_DIR_DRIFT", "Pinned patch artifact directory became unsafe", { cause: error?.details?.cause });
        }
        throw error;
    }
    if (!samePath(expected.canonicalJobRoot, current.canonicalJobRoot) ||
        expected.jobRootDev !== current.jobRootDev || expected.jobRootIno !== current.jobRootIno ||
        !samePath(expected.realpath, current.realpath) || expected.dev !== current.dev || expected.ino !== current.ino) {
        throw artifactError("AICW_PATCH_ARTIFACT_DIR_DRIFT", "Pinned patch artifact directory identity changed");
    }
    return current;
}

function createPatchArtifactNonce(options = {}) {
    const nonce = (options.randomBytes || crypto.randomBytes)(12).toString("hex");
    if (!PATCH_NONCE_RE.test(nonce)) throw artifactError("AICW_PATCH_ARTIFACT_DIR_UNSAFE", "Patch artifact nonce generation failed");
    return nonce;
}

function patchCandidatePath(jobRoot, jobId, sidecarInstanceId, patchArtifactNonce) {
    const id = assertJobId(jobId);
    if (typeof sidecarInstanceId !== "string" || !PATCH_INSTANCE_RE.test(sidecarInstanceId)) {
        throw artifactError("AICW_PATCH_ARTIFACT_DIR_UNSAFE", "Patch Sidecar instance identity is invalid");
    }
    if (typeof patchArtifactNonce !== "string" || !PATCH_NONCE_RE.test(patchArtifactNonce)) {
        throw artifactError("AICW_PATCH_ARTIFACT_DIR_UNSAFE", "Patch artifact nonce is invalid");
    }
    return path.join(normalizeDirectory(jobRoot, "jobRoot"), "patches", `.${id}.${sidecarInstanceId}.${patchArtifactNonce}.candidate`);
}

function inspectPatchArtifactFile(filePath, directoryIdentity, options = {}) {
    const hooks = options.hooks || options;
    const expectedPath = path.resolve(filePath);
    verifyPatchArtifactDirectory(options.jobRoot, directoryIdentity, { hooks });
    const identity = readReliableIdentity(expectedPath, "file", options.failureCode || "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH", hooks);
    const canonicalExpectedPath = path.join(path.resolve(directoryIdentity.realpath), path.basename(expectedPath));
    if (!samePath(identity.realpath, canonicalExpectedPath) || !samePath(path.dirname(identity.realpath), directoryIdentity.realpath)) {
        throw artifactError(options.failureCode || "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH", "Patch artifact file escaped its pinned directory");
    }
    if (options.expectedIdentity && !sameArtifactObjectIdentity(identity, options.expectedIdentity)) {
        throw artifactError(options.failureCode || "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH", "Patch artifact file identity changed");
    }
    let content;
    try { content = (hooks.readFileSync || fs.readFileSync)(expectedPath); } catch (error) {
        throw artifactError(options.failureCode || "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH", "Patch artifact file could not be read", { cause: error?.code });
    }
    const afterRead = readReliableIdentity(expectedPath, "file", options.failureCode || "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH", hooks);
    verifyPatchArtifactDirectory(options.jobRoot, directoryIdentity, { hooks });
    if (!sameArtifactIdentity(identity, afterRead)) {
        throw artifactError(options.failureCode || "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH", "Patch artifact file changed while being read");
    }
    const actualSha256 = crypto.createHash("sha256").update(content).digest("hex");
    if (options.expectedSha256 !== undefined && actualSha256 !== options.expectedSha256) {
        throw artifactError(options.failureCode || "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH", "Patch artifact hash mismatch");
    }
    if (options.expectedBytes !== undefined && content.length !== options.expectedBytes) {
        throw artifactError(options.failureCode || "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH", "Patch artifact byte length mismatch");
    }
    return { identity: afterRead, sha256: actualSha256, bytes: content.length };
}

function removePatchArtifactExact(filePath, directoryIdentity, options = {}) {
    const hooks = options.hooks || options;
    let inspected;
    try {
        inspected = inspectPatchArtifactFile(filePath, directoryIdentity, options);
    } catch (error) {
        if (error?.details?.cause === "ENOENT" && options.missingIsSuccess !== false) return true;
        return false;
    }
    try { hooks.afterArtifactHashCheck?.({ filePath: path.resolve(filePath), identity: inspected.identity }); } catch { return false; }
    try {
        verifyPatchArtifactDirectory(options.jobRoot, directoryIdentity, { hooks });
        inspectPatchArtifactFile(filePath, directoryIdentity, {
            ...options,
            hooks,
            expectedIdentity: inspected.identity,
            expectedSha256: inspected.sha256,
            expectedBytes: inspected.bytes
        });
        (hooks.unlinkSync || fs.unlinkSync)(filePath);
        verifyPatchArtifactDirectory(options.jobRoot, directoryIdentity, { hooks });
        try {
            (hooks.lstatSync || fs.lstatSync)(filePath, { bigint: true });
            return false;
        } catch (error) {
            return error?.code === "ENOENT";
        }
    } catch {
        return false;
    }
}

function inspectAuthorizedPatchArtifact(jobRoot, jobId, meta, options = {}) {
    const unauthorized = code => ({ authorized: false, patchAvailable: false, patchPath: null, code: code || "AICW_PATCH_PUBLIC_ARTIFACT_UNAUTHORIZED" });
    try {
        const id = assertJobId(jobId);
        if (!meta || typeof meta !== "object" || Array.isArray(meta) || String(meta.jobId || "") !== id ||
            meta.executionBackend !== "codex-app-server" || meta.jobKind !== "patch" || meta.state !== "completed" ||
            meta.patchValidated !== true || meta.applyCheckPassed !== true || meta.baselineStable !== true ||
            typeof meta.patchSha256 !== "string" || !/^[0-9a-f]{64}$/.test(meta.patchSha256) ||
            !Number.isSafeInteger(meta.patchBytes) || meta.patchBytes < 0) {
            return unauthorized();
        }
        const expectedPath = jobPaths(jobRoot, id).patchPath;
        if ((meta.patchPath && !samePath(meta.patchPath, expectedPath)) || (meta.patchFile && !samePath(meta.patchFile, expectedPath))) {
            return unauthorized();
        }
        const directoryIdentity = normalizePatchDirectoryIdentity(meta.patchArtifactDirectoryIdentity);
        if (!meta.patchArtifactPublicIdentity || typeof meta.patchArtifactPublicIdentity !== "object" ||
            typeof meta.patchArtifactPublicIdentity.dev !== "string" || typeof meta.patchArtifactPublicIdentity.ino !== "string" ||
            typeof meta.patchArtifactPublicIdentity.realpath !== "string") {
            return unauthorized();
        }
        const inspected = inspectPatchArtifactFile(expectedPath, directoryIdentity, {
            jobRoot,
            hooks: options.hooks || options,
            expectedIdentity: meta.patchArtifactPublicIdentity,
            expectedSha256: meta.patchSha256,
            expectedBytes: meta.patchBytes,
            failureCode: "AICW_PATCH_PUBLIC_ARTIFACT_UNAUTHORIZED"
        });
        return {
            authorized: true,
            patchAvailable: true,
            patchPath: expectedPath,
            patchSha256: inspected.sha256,
            patchBytes: inspected.bytes,
            patchFileCount: Number.isSafeInteger(meta.patchFileCount) ? meta.patchFileCount : null
        };
    } catch {
        return unauthorized();
    }
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
            let artifactFailures = [];
            const result = await updateMeta(jobRoot, jobId, metaPath, meta => {
                if (!meta || typeof meta !== "object" || Array.isArray(meta) ||
                    meta.state !== "running" || meta.executionBackend !== "codex-app-server" ||
                    meta.sidecarInstanceId !== state.instanceId) return META_UPDATE_SKIPPED;
                if (meta.jobKind === "patch") {
                    let directoryIdentity;
                    try {
                        directoryIdentity = verifyPatchArtifactDirectory(jobRoot, meta.patchArtifactDirectoryIdentity, { hooks: options.artifactHooks || {} });
                        options.artifactHooks?.beforeReconcileCleanup?.({ jobRoot, jobId, directoryIdentity });
                        verifyPatchArtifactDirectory(jobRoot, directoryIdentity, { hooks: options.artifactHooks || {} });
                    } catch (error) {
                        artifactFailures.push(failure(error?.code || "AICW_PATCH_ARTIFACT_DIR_DRIFT", jobId));
                    }
                    if (directoryIdentity) {
                        let candidatePath;
                        try {
                            candidatePath = patchCandidatePath(jobRoot, jobId, meta.sidecarInstanceId, meta.patchArtifactNonce);
                        } catch (error) {
                            artifactFailures.push(failure(error?.code || "AICW_PATCH_ARTIFACT_DIR_UNSAFE", jobId));
                        }
                        if (candidatePath && !removePatchArtifactExact(candidatePath, directoryIdentity, {
                            jobRoot,
                            hooks: options.artifactHooks || {},
                            failureCode: "AICW_PATCH_ARTIFACT_CLEANUP_FAILED"
                        })) {
                            artifactFailures.push(failure("AICW_PATCH_ARTIFACT_CLEANUP_FAILED", jobId));
                        }
                    }
                    const publicPatch = jobPaths(jobRoot, jobId).patchPath;
                    if (directoryIdentity && !removePatchArtifactExact(publicPatch, directoryIdentity, {
                        jobRoot,
                        hooks: options.artifactHooks || {},
                        expectedSha256: meta.patchSha256,
                        expectedBytes: meta.patchBytes,
                        failureCode: "AICW_PATCH_ARTIFACT_CLEANUP_FAILED"
                    })) {
                        artifactFailures.push(failure("AICW_PATCH_ARTIFACT_CLEANUP_FAILED", jobId));
                    }
                    if (artifactFailures.length) return META_UPDATE_SKIPPED;
                }
                const crashedDuringPatchFinalize = meta.jobKind === "patch" &&
                    ["validating", "publishing"].includes(meta.jobPhase);
                meta.state = "failed";
                if (meta.jobKind === "patch") meta.jobPhase = "failed";
                meta.completedAt = completedAt;
                meta.exitCode = 1;
                meta.errorCode = crashedDuringPatchFinalize
                    ? "SIDECAR_PROCESS_EXITED_DURING_PATCH_FINALIZE"
                    : "SIDECAR_PROCESS_EXITED";
                meta.exitReason = "Sidecar process exited before Job completion";
                if (meta.jobKind === "patch") {
                    meta.patchValidated = false;
                    meta.applyCheckPassed = false;
                    meta.baselineStable = false;
                }
                updated = true;
                return meta;
            }, { ...options, hooks: options.metaHooks || {} });
            if (artifactFailures.length) {
                failures.push(...artifactFailures);
                continue;
            }
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
    if (!ownsMetaLock(lockPath, lock)) return false;
    try {
        fs.unlinkSync(lockPath);
        return true;
    } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw new SidecarError("SIDECAR_META_LOCK_RELEASE_FAILED", "Could not release Job meta lock", { cause: error?.code });
    }
}

function ownsMetaLock(lockPath, lock) {
    if (!lock) return false;
    let current;
    try { current = parseMetaLockRecord(lockPath); } catch { return false; }
    return Boolean(current && current.ownerToken === lock.ownerToken &&
        Number(current.pid) === process.pid &&
        sameProcessIdentity(current.processIdentity, lock.record.processIdentity));
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
        let released = false;
        let releaseFailure = null;
        try {
            released = typeof options.hooks?.releaseMetaLock === "function"
                ? await options.hooks.releaseMetaLock(lockPath, lock, releaseMetaLock)
                : releaseMetaLock(lockPath, lock);
        } catch (error) {
            releaseFailure = error;
        }
        if (!released && !operationFailed) {
            let rolledBack = false;
            if (typeof options.onMetaLockReleaseFailure === "function") {
                try {
                    rolledBack = await options.onMetaLockReleaseFailure({ lockPath, lock }) === true;
                } catch {}
            }
            if (rolledBack && ownsMetaLock(lockPath, lock)) {
                try { releaseMetaLock(lockPath, lock); } catch {}
            }
            if (releaseFailure instanceof SidecarError) throw releaseFailure;
            throw new SidecarError("SIDECAR_META_LOCK_RELEASE_FAILED", "Could not release Job meta lock", { cause: releaseFailure?.code });
        }
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
    let previousMeta = null;
    let wroteMeta = false;
    const lockOptions = {
        ...options,
        async onMetaLockReleaseFailure({ lockPath, lock }) {
            if (!wroteMeta || !previousMeta || !ownsMetaLock(lockPath, lock)) return false;
            try {
                writeMeta(metaPath, previousMeta);
                wroteMeta = false;
                return true;
            } catch {
                return false;
            }
        }
    };
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
        previousMeta = JSON.parse(JSON.stringify(current));
        const candidate = await updater(current);
        if (candidate === META_UPDATE_SKIPPED) return { updated: false, meta: current };
        if (candidate !== undefined && (!candidate || typeof candidate !== "object" || Array.isArray(candidate))) {
            throw new SidecarError("META_INVALID", "Meta updater returned an invalid object");
        }
        const next = { ...current, ...(candidate || {}) };
        if (String(next.jobId || "") !== id) throw new SidecarError("META_JOB_MISMATCH", "Meta updater changed jobId");
        next.metaRevision = revision + 1;
        writeMeta(metaPath, next);
        wroteMeta = true;
        return { updated: true, meta: next };
    }, lockOptions);
}

module.exports = {
    SidecarError,
    runtimePaths,
    assertJobId,
    assertAbsolutePath,
    assertWithinDirectory,
    jobPaths,
    validateJobPaths,
    validatePatchJobPaths,
    ensureDirectory,
    PATCH_ARTIFACT_IDENTITY_VERSION,
    pinPatchArtifactDirectory,
    verifyPatchArtifactDirectory,
    createPatchArtifactNonce,
    patchCandidatePath,
    sameArtifactIdentity,
    sameArtifactObjectIdentity,
    inspectPatchArtifactFile,
    removePatchArtifactExact,
    inspectAuthorizedPatchArtifact,
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
