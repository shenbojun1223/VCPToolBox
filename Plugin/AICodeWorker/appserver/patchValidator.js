"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
    SidecarError,
    assertJobId,
    jobPaths,
    samePath,
    verifyPatchArtifactDirectory,
    patchCandidatePath,
    sameArtifactIdentity,
    inspectPatchArtifactFile,
    removePatchArtifactExact,
    inspectAuthorizedPatchArtifact
} = require("./protocol");

const MAX_PATCH_BYTES = 512 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 5000;
const DEFAULT_GIT_OUTPUT_LIMIT = 64 * 1024;
const FORBIDDEN_GIT_FLAGS = new Set(["--unsafe-paths", "--recount", "--3way", "--index"]);
const PATCH_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function patchError(code, message, details) {
    return new SidecarError(code, message, details);
}

function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function validatePatchModel(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
        throw patchError("AICW_PATCH_FORMAT_INVALID", "Patch model is invalid");
    }
    return value;
}

function validatePatchEffort(value) {
    if (typeof value !== "string" || !PATCH_EFFORTS.has(value)) {
        throw patchError("AICW_PATCH_FORMAT_INVALID", "Patch effort is invalid");
    }
    return value;
}

function validatePatchSize(value) {
    const bytes = Buffer.byteLength(String(value || ""), "utf8");
    if (bytes > MAX_PATCH_BYTES) {
        throw patchError("AICW_PATCH_TOO_LARGE", "Patch exceeds the 512 KiB limit", { maxBytes: MAX_PATCH_BYTES, bytes });
    }
    return bytes;
}

function extractPatchPayload(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw patchError("AICW_PATCH_EMPTY", "Patch is empty");
    }
    const text = value.replace(/^\uFEFF/, "");
    const first = text.search(/\S/);
    const startsRaw = first >= 0 && text.slice(first).startsWith("diff --git ");
    const fenceTokens = text.match(/```/g) || [];
    const diffFences = text.match(/```diff\b/g) || [];

    if (fenceTokens.length > 0) {
        if (startsRaw || diffFences.length > 1 || fenceTokens.length > 2) {
            throw patchError("AICW_PATCH_MULTIPLE_PAYLOADS", "Patch contains multiple or mixed payloads");
        }
        const match = text.match(/^\s*```diff[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/);
        if (!match) {
            throw patchError("AICW_PATCH_FORMAT_INVALID", "Patch fence is malformed or has non-whitespace content outside it");
        }
        if (!match[1].trim()) throw patchError("AICW_PATCH_EMPTY", "Patch fence is empty");
        const payload = `${match[1].replace(/[ \t\r\n]+$/, "")}\n`;
        if (!payload.startsWith("diff --git ")) {
            throw patchError("AICW_PATCH_FORMAT_INVALID", "Fenced patch must begin with a Git diff header");
        }
        validatePatchSize(payload);
        return payload;
    }

    if (!startsRaw) throw patchError("AICW_PATCH_FORMAT_INVALID", "Raw patch must begin with a Git diff header");
    const payload = `${text.slice(first).replace(/[ \t\r\n]+$/, "")}\n`;
    validatePatchSize(payload);
    return payload;
}

function validateRelativePath(relativePath) {
    if (typeof relativePath !== "string" || !relativePath ||
        relativePath.includes("\0") || relativePath.includes("\\") || relativePath.includes(":") ||
        relativePath.startsWith("/") || relativePath.startsWith("//") || /^[A-Za-z]:/.test(relativePath) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(relativePath) || relativePath.includes('"') ||
        relativePath.includes("'") || /\s/.test(relativePath)) {
        throw patchError("AICW_PATCH_PATH_INVALID", "Patch path is not a simple relative path");
    }
    const segments = relativePath.split("/");
    if (segments.some(segment => !segment || segment === "." || segment === "..")) {
        throw patchError("AICW_PATCH_PATH_INVALID", "Patch path contains an invalid segment");
    }
    if (segments.some(segment => [".git", ".agents"].includes(segment.toLowerCase()))) {
        throw patchError("AICW_PATCH_PROTECTED_PATH", "Patch targets a protected path");
    }
    return relativePath;
}

function parseDiffPath(token, prefix) {
    if (typeof token !== "string" || !token.startsWith(prefix) || token.length <= prefix.length) {
        throw patchError("AICW_PATCH_PATH_INVALID", "Patch path prefix is invalid");
    }
    return validateRelativePath(token.slice(prefix.length));
}

function parseUnifiedDiff(patchText) {
    if (typeof patchText !== "string" || !patchText) throw patchError("AICW_PATCH_EMPTY", "Patch is empty");
    validatePatchSize(patchText);
    if (patchText.includes("\0")) throw patchError("AICW_PATCH_PATH_INVALID", "Patch contains NUL");
    if (!patchText.startsWith("diff --git ")) throw patchError("AICW_PATCH_FORMAT_INVALID", "Patch does not begin with a Git diff header");
    if (!patchText.endsWith("\n")) throw patchError("AICW_PATCH_TRUNCATED", "Patch is missing its final newline");

    const lines = patchText.split("\n");
    lines.pop();
    const sections = [];
    let index = 0;
    while (index < lines.length) {
        while (index < lines.length && lines[index].trim() === "") index++;
        if (index >= lines.length) break;
        const header = lines[index].replace(/\r$/, "");
        const headerMatch = header.match(/^diff --git ([^ ]+) ([^ ]+)$/);
        if (!headerMatch) {
            if (header.startsWith("diff --git ")) {
                throw patchError("AICW_PATCH_PATH_INVALID", "Patch diff header contains a quoted or whitespace-bearing path");
            }
            throw patchError("AICW_PATCH_FORMAT_INVALID", "Patch contains content outside a diff section");
        }
        const oldPath = parseDiffPath(headerMatch[1], "a/");
        const newPath = parseDiffPath(headerMatch[2], "b/");
        if (oldPath !== newPath) throw patchError("AICW_PATCH_OPERATION_UNSUPPORTED", "Rename or cross-path patch is unsupported");
        const section = { path: oldPath, additions: 0, deletions: 0, hunks: 0 };
        sections.push(section);
        index++;
        let oldHeaderSeen = false;
        let newHeaderSeen = false;

        while (index < lines.length) {
            const line = lines[index].replace(/\r$/, "");
            if (line.startsWith("diff --git ")) break;
            if (!line.trim()) { index++; continue; }
            if (line === "GIT binary patch" || /^Binary files .* differ$/.test(line)) {
                throw patchError("AICW_PATCH_BINARY_UNSUPPORTED", "Binary patches are unsupported");
            }
            if (/^(new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to)\b/.test(line) ||
                /^Subproject commit\b/.test(line)) {
                throw patchError("AICW_PATCH_OPERATION_UNSUPPORTED", "Patch operation is unsupported");
            }
            if (/^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+(?: [0-7]{6})?$/.test(line)) { index++; continue; }
            if (line.startsWith("--- ")) {
                if (line === "--- /dev/null") throw patchError("AICW_PATCH_OPERATION_UNSUPPORTED", "File creation is unsupported");
                if (parseDiffPath(line.slice(4), "a/") !== section.path) {
                    throw patchError("AICW_PATCH_PATH_INVALID", "Old patch header path does not match its section");
                }
                oldHeaderSeen = true;
                index++;
                continue;
            }
            if (line.startsWith("+++ ")) {
                if (line === "+++ /dev/null") throw patchError("AICW_PATCH_OPERATION_UNSUPPORTED", "File deletion is unsupported");
                if (parseDiffPath(line.slice(4), "b/") !== section.path) {
                    throw patchError("AICW_PATCH_PATH_INVALID", "New patch header path does not match its section");
                }
                newHeaderSeen = true;
                index++;
                continue;
            }
            const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
            if (!hunk) throw patchError("AICW_PATCH_FORMAT_INVALID", "Patch section contains malformed content");
            if (!oldHeaderSeen || !newHeaderSeen) throw patchError("AICW_PATCH_FORMAT_INVALID", "Patch hunk is missing file headers");
            const expectedOld = hunk[2] === undefined ? 1 : Number(hunk[2]);
            const expectedNew = hunk[4] === undefined ? 1 : Number(hunk[4]);
            let actualOld = 0;
            let actualNew = 0;
            section.hunks++;
            index++;
            while (actualOld < expectedOld || actualNew < expectedNew) {
                if (index >= lines.length || lines[index].startsWith("diff --git ") || lines[index].startsWith("@@ ")) {
                    throw patchError("AICW_PATCH_TRUNCATED", "Patch hunk ended before its declared line counts");
                }
                const body = lines[index].replace(/\r$/, "");
                const marker = body[0];
                if ([" ", "-", "+"].includes(marker) && /^Subproject commit\b/.test(body.slice(1))) {
                    throw patchError("AICW_PATCH_OPERATION_UNSUPPORTED", "Submodule patches are unsupported");
                }
                if (marker === " ") { actualOld++; actualNew++; }
                else if (marker === "-") { actualOld++; section.deletions++; }
                else if (marker === "+") { actualNew++; section.additions++; }
                else throw patchError("AICW_PATCH_TRUNCATED", "Patch hunk body is malformed");
                if (actualOld > expectedOld || actualNew > expectedNew) {
                    throw patchError("AICW_PATCH_TRUNCATED", "Patch hunk line counts do not match its header");
                }
                index++;
            }
            while (index < lines.length && lines[index].replace(/\r$/, "") === "\\ No newline at end of file") index++;
            if (index < lines.length && /^[ +\-]/.test(lines[index]) && !lines[index].startsWith("--- ") && !lines[index].startsWith("+++ ")) {
                throw patchError("AICW_PATCH_TRUNCATED", "Patch hunk contains more lines than declared");
            }
        }
        if (!section.hunks) throw patchError("AICW_PATCH_FORMAT_INVALID", "Patch section has no hunks");
        if (!section.additions && !section.deletions) throw patchError("AICW_PATCH_FORMAT_INVALID", "Patch section has no actual changes");
    }
    if (!sections.length) throw patchError("AICW_PATCH_EMPTY", "Patch has no diff sections");
    return { sections, fileCount: new Set(sections.map(section => section.path)).size };
}

const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_+\/=.-]{12,}/i
];

function assertNoSecrets(patchText) {
    if (SECRET_PATTERNS.some(pattern => pattern.test(patchText))) {
        throw patchError("AICW_PATCH_SECRET_DETECTED", "Patch contains a high-confidence secret");
    }
}

function runGit(repoRoot, args, options = {}) {
    if (!Array.isArray(args) || args.some(argument => typeof argument !== "string")) {
        return Promise.reject(patchError("AICW_PATCH_FORMAT_INVALID", "Git arguments are invalid"));
    }
    if (args.some(argument => FORBIDDEN_GIT_FLAGS.has(argument))) {
        return Promise.reject(patchError("AICW_PATCH_OPERATION_UNSUPPORTED", "Forbidden git apply option"));
    }
    const cwd = path.resolve(repoRoot);
    const timeoutMs = Math.max(50, Number(options.timeoutMs || DEFAULT_GIT_TIMEOUT_MS));
    const outputLimit = Math.max(128, Number(options.outputLimit || DEFAULT_GIT_OUTPUT_LIMIT));
    return new Promise((resolve, reject) => {
        let child;
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let settled = false;
        let failure = null;
        let forcedSettleTimer = null;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (forcedSettleTimer) clearTimeout(forcedSettleTimer);
            options.childSet?.delete(child);
            try { options.onChildEnd?.(child); } catch {}
            if (error) reject(error); else resolve(value);
        };
        try {
            child = spawn(options.gitBin || "git", args, {
                cwd,
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"]
            });
            options.childSet?.add(child);
            options.onChildStart?.(child);
        } catch (error) {
            reject(patchError("AICW_PATCH_GIT_SPAWN_FAILED", "Could not start Git", { cause: error.code }));
            return;
        }
        const stopFor = error => {
            if (failure) return;
            failure = error;
            try { child.kill("SIGKILL"); } catch {}
            forcedSettleTimer = setTimeout(() => finish(error), 250);
            forcedSettleTimer.unref?.();
        };
        const append = (current, chunk) => {
            const next = Buffer.concat([current, Buffer.from(chunk)]);
            if (next.length > outputLimit) {
                stopFor(patchError("AICW_PATCH_GIT_OUTPUT_LIMIT", "Git output exceeded its limit", { outputLimit }));
                return next.subarray(0, outputLimit);
            }
            return next;
        };
        child.stdout?.on("data", chunk => { stdout = append(stdout, chunk); });
        child.stderr?.on("data", chunk => { stderr = append(stderr, chunk); });
        child.once("error", error => finish(patchError("AICW_PATCH_GIT_SPAWN_FAILED", "Git process failed", { cause: error.code })));
        child.once("close", (code, signal) => {
            if (failure) return finish(failure);
            const result = { code, signal, stdout, stderr };
            if (code === 0 || options.allowFailure) return finish(null, result);
            finish(patchError(options.errorCode || "AICW_PATCH_GIT_COMMAND_FAILED", options.errorMessage || "Git command failed", {
                exitCode: code,
                signal: signal || null,
                stdoutBytes: stdout.length,
                stderrBytes: stderr.length
            }));
        });
        const timer = setTimeout(() => {
            stopFor(patchError("AICW_PATCH_GIT_TIMEOUT", "Git command timed out", { timeoutMs }));
        }, timeoutMs);
        timer.unref?.();
    });
}

function outputText(result) {
    return result.stdout.toString("utf8").trim();
}

async function readGitFingerprint(repoRoot, options = {}) {
    const gitOptions = options.gitOptions || options;
    const [headResult, treeResult, statusResult] = await Promise.all([
        runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], gitOptions),
        runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{tree}"], gitOptions),
        runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], gitOptions)
    ]);
    return {
        head: outputText(headResult),
        tree: outputText(treeResult),
        statusSha256: sha256(statusResult.stdout),
        dirty: statusResult.stdout.length !== 0
    };
}

async function captureGitBaseline(projectPath, options = {}) {
    let canonicalRoot;
    try {
        const resolved = path.resolve(projectPath);
        canonicalRoot = fs.realpathSync.native(resolved);
        if (!fs.statSync(canonicalRoot).isDirectory() || !samePath(resolved, canonicalRoot)) {
            throw new Error("not canonical");
        }
    } catch {
        throw patchError("AICW_PATCH_NOT_GIT_ROOT", "projectPath must be an existing canonical Git root");
    }
    let topLevel;
    try {
        topLevel = outputText(await runGit(canonicalRoot, ["rev-parse", "--show-toplevel"], options.gitOptions || options));
        topLevel = fs.realpathSync.native(path.resolve(topLevel));
    } catch {
        throw patchError("AICW_PATCH_NOT_GIT_ROOT", "projectPath is not a Git repository root");
    }
    if (!samePath(canonicalRoot, topLevel)) {
        throw patchError("AICW_PATCH_NOT_GIT_ROOT", "projectPath must be the Git top-level, not a subdirectory");
    }
    let fingerprint;
    try {
        fingerprint = await readGitFingerprint(canonicalRoot, options);
    } catch (error) {
        if (error?.code === "AICW_PATCH_GIT_COMMAND_FAILED") {
            throw patchError("AICW_PATCH_NOT_GIT_ROOT", "Git repository must have an existing HEAD");
        }
        throw error;
    }
    if (!fingerprint.head || !fingerprint.tree) {
        throw patchError("AICW_PATCH_NOT_GIT_ROOT", "Git repository must have an existing HEAD");
    }
    const baseline = {
        repoRoot: canonicalRoot,
        baseHead: fingerprint.head,
        baseTree: fingerprint.tree,
        baseStatusSha256: fingerprint.statusSha256,
        baseDirty: fingerprint.dirty,
        baselineCapturedAt: new Date().toISOString()
    };
    if (fingerprint.dirty) throw patchError("AICW_PATCH_BASELINE_DIRTY", "Git repository must be clean", { baseline });
    return baseline;
}

async function assertBaselineStable(repoRoot, baseline, options = {}) {
    const fingerprint = await readGitFingerprint(repoRoot, options);
    if (fingerprint.head !== baseline.baseHead || fingerprint.tree !== baseline.baseTree ||
        fingerprint.statusSha256 !== baseline.baseStatusSha256 || fingerprint.dirty !== baseline.baseDirty) {
        throw patchError("AICW_PATCH_BASELINE_DRIFT", "Git baseline changed while the patch was generated");
    }
    return fingerprint;
}

function startGitBaselineMonitor(repoRoot, baseline, options = {}) {
    const intervalMs = Math.max(50, Number(options.intervalMs || 500));
    let watcher;
    let timer;
    let closed = false;
    let latch = null;
    let refresh = Promise.resolve();
    const trip = () => {
        if (!latch) latch = patchError("AICW_PATCH_BASELINE_DRIFT", "Git baseline watcher detected repository activity");
    };
    try {
        watcher = (options.watch || fs.watch)(repoRoot, { recursive: true }, trip);
        watcher.on("error", trip);
    } catch {
        throw patchError("AICW_PATCH_BASELINE_DRIFT", "Git baseline watcher is unavailable");
    }
    const refreshOnce = () => {
        refresh = refresh.then(() => assertBaselineStable(repoRoot, baseline, options)).catch(() => { trip(); });
        return refresh;
    };
    timer = setInterval(refreshOnce, intervalMs);
    timer.unref?.();
    return {
        async assertStable() {
            if (latch) throw latch;
            await refresh;
            if (latch) throw latch;
            await assertBaselineStable(repoRoot, baseline, options);
            if (latch) throw latch;
        },
        get drifted() { return Boolean(latch); },
        async close(closeOptions = {}) {
            if (closed) return true;
            closed = true;
            if (timer) clearInterval(timer);
            timer = null;
            let closeFailed = false;
            try { watcher?.close(); } catch { closeFailed = true; }
            watcher = null;
            await refresh;
            if (closeOptions.verifyBaseline !== false) {
                if (latch) throw latch;
                await assertBaselineStable(repoRoot, baseline, options);
                if (latch) throw latch;
            }
            if (closeFailed) throw patchError("AICW_PATCH_ARTIFACT_CLEANUP_FAILED", "Git baseline watcher could not be closed");
            return true;
        }
    };
}

function assertNoReparseComponents(repoRoot, relativePath) {
    let current = repoRoot;
    for (const segment of relativePath.split("/")) {
        current = path.join(current, segment);
        let stat;
        try { stat = fs.lstatSync(current); } catch {
            throw patchError("AICW_PATCH_PATH_INVALID", "Patch target is missing");
        }
        if (stat.isSymbolicLink()) throw patchError("AICW_PATCH_PATH_INVALID", "Symlink or reparse targets are unsupported");
    }
    return current;
}

async function validateTrackedPaths(repoRoot, parsed, options = {}) {
    for (const section of parsed.sections) {
        const relativePath = validateRelativePath(section.path);
        const target = assertNoReparseComponents(repoRoot, relativePath);
        let stat;
        try { stat = fs.lstatSync(target); } catch {
            throw patchError("AICW_PATCH_PATH_INVALID", "Patch target is missing");
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw patchError("AICW_PATCH_PATH_INVALID", "Patch target must be a regular file");
        }
        const realTarget = fs.realpathSync.native(target);
        const relativeReal = path.relative(repoRoot, realTarget);
        if (relativeReal.startsWith(`..${path.sep}`) || relativeReal === ".." || path.isAbsolute(relativeReal)) {
            throw patchError("AICW_PATCH_PATH_INVALID", "Patch target resolves outside the Git root");
        }
        let result;
        try {
            result = await runGit(repoRoot, ["ls-files", "--stage", "-z", "--", relativePath], options.gitOptions || options);
        } catch {
            throw patchError("AICW_PATCH_PATH_INVALID", "Patch target is not tracked");
        }
        const records = result.stdout.toString("utf8").split("\0").filter(Boolean);
        if (records.length !== 1) throw patchError("AICW_PATCH_PATH_INVALID", "Patch target is not a single tracked file");
        const match = records[0].match(/^(\d{6}) [0-9a-f]+ (\d)\t(.+)$/);
        if (!match || match[2] !== "0" || match[3] !== relativePath) {
            throw patchError("AICW_PATCH_PATH_INVALID", "Patch target tracking record is invalid");
        }
        if (!["100644", "100755"].includes(match[1])) {
            throw patchError("AICW_PATCH_OPERATION_UNSUPPORTED", "Symlink or submodule targets are unsupported");
        }
    }
    return parsed;
}

async function applyCheck(repoRoot, candidatePath, options = {}) {
    try {
        await runGit(repoRoot, ["apply", "--check", path.resolve(candidatePath)], {
            ...(options.gitOptions || options),
            errorCode: "AICW_PATCH_APPLY_CHECK_FAILED",
            errorMessage: "Patch failed git apply --check"
        });
    } catch (error) {
        if (error?.code === "AICW_PATCH_GIT_COMMAND_FAILED") {
            throw patchError("AICW_PATCH_APPLY_CHECK_FAILED", "Patch failed git apply --check");
        }
        throw error;
    }
    return true;
}

function createPrivateCandidate(params, options = {}) {
    const {
        jobRoot,
        jobId,
        sidecarInstanceId,
        patchArtifactNonce,
        patchText,
        patchArtifactDirectoryIdentity
    } = params || {};
    assertJobId(jobId);
    const hooks = options.hooks || options;
    const candidatePath = patchCandidatePath(jobRoot, jobId, sidecarInstanceId, patchArtifactNonce);
    const expectedSha256 = sha256(Buffer.from(String(patchText || ""), "utf8"));
    const expectedBytes = Buffer.byteLength(String(patchText || ""), "utf8");
    let fd;
    let created = false;
    let createdIdentity = null;
    try {
        verifyPatchArtifactDirectory(jobRoot, patchArtifactDirectoryIdentity, { hooks });
        hooks.beforeCandidateCreate?.({ jobRoot, jobId, candidatePath, patchArtifactDirectoryIdentity });
        verifyPatchArtifactDirectory(jobRoot, patchArtifactDirectoryIdentity, { hooks });
        fd = (hooks.openSync || fs.openSync)(candidatePath, "wx", 0o600);
        created = true;
        const fdStat = (hooks.fstatSync || fs.fstatSync)(fd, { bigint: true });
        if (typeof fdStat.dev !== "bigint" || typeof fdStat.ino !== "bigint" || fdStat.dev < 0n || fdStat.ino <= 0n || !fdStat.isFile()) {
            throw patchError("AICW_PATCH_FILE_WRITE_FAILED", "Private patch candidate identity is unreliable");
        }
        createdIdentity = {
            dev: fdStat.dev.toString(10),
            ino: fdStat.ino.toString(10),
            realpath: path.join(patchArtifactDirectoryIdentity.realpath, path.basename(candidatePath))
        };
        (hooks.writeFileSync || fs.writeFileSync)(fd, patchText, "utf8");
        (hooks.fsyncSync || fs.fsyncSync)(fd);
        (hooks.closeSync || fs.closeSync)(fd);
        fd = undefined;
        verifyPatchArtifactDirectory(jobRoot, patchArtifactDirectoryIdentity, { hooks });
        const inspected = inspectPatchArtifactFile(candidatePath, patchArtifactDirectoryIdentity, {
            jobRoot,
            hooks,
            expectedIdentity: createdIdentity,
            expectedSha256,
            expectedBytes,
            failureCode: "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH"
        });
        return { candidatePath, candidateIdentity: inspected.identity };
    } catch (error) {
        if (fd !== undefined) { try { (hooks.closeSync || fs.closeSync)(fd); } catch {} }
        if (created) {
            const cleaned = removePatchArtifactExact(candidatePath, patchArtifactDirectoryIdentity, {
                jobRoot,
                hooks,
                expectedIdentity: createdIdentity || undefined,
                failureCode: "AICW_PATCH_ARTIFACT_CLEANUP_FAILED"
            });
            if (!cleaned) {
                throw patchError("AICW_PATCH_ARTIFACT_CLEANUP_FAILED", "Private patch candidate cleanup failed", { cause: error?.code });
            }
        }
        if (["AICW_PATCH_ARTIFACT_DIR_UNSAFE", "AICW_PATCH_ARTIFACT_DIR_DRIFT"].includes(error?.code)) throw error;
        throw patchError("AICW_PATCH_FILE_WRITE_FAILED", "Could not write private patch candidate", { cause: error.code });
    }
}

function publishCandidateNoOverwrite(params, options = {}) {
    const {
        jobRoot,
        jobId,
        sidecarInstanceId,
        patchArtifactNonce,
        patchArtifactDirectoryIdentity,
        candidateIdentity,
        patchSha256,
        patchBytes
    } = params || {};
    const hooks = options.hooks || options;
    const candidatePath = patchCandidatePath(jobRoot, jobId, sidecarInstanceId, patchArtifactNonce);
    const patchPath = jobPaths(jobRoot, jobId).patchPath;
    let published = false;
    try {
        verifyPatchArtifactDirectory(jobRoot, patchArtifactDirectoryIdentity, { hooks });
        hooks.beforePublish?.({ jobRoot, jobId, candidatePath, patchPath, patchArtifactDirectoryIdentity });
        verifyPatchArtifactDirectory(jobRoot, patchArtifactDirectoryIdentity, { hooks });
        inspectPatchArtifactFile(candidatePath, patchArtifactDirectoryIdentity, {
            jobRoot,
            hooks,
            expectedIdentity: candidateIdentity,
            expectedSha256: patchSha256,
            expectedBytes: patchBytes,
            failureCode: "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH"
        });
        (hooks.linkSync || fs.linkSync)(candidatePath, patchPath);
        published = true;
        hooks.afterPublicLink?.({ jobRoot, jobId, candidatePath, patchPath, patchArtifactDirectoryIdentity });
        const inspected = inspectPatchArtifactFile(patchPath, patchArtifactDirectoryIdentity, {
            jobRoot,
            hooks,
            expectedIdentity: candidateIdentity,
            expectedSha256: patchSha256,
            expectedBytes: patchBytes,
            failureCode: "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH"
        });
        return { patchPath, publicIdentity: inspected.identity };
    } catch (error) {
        let rollbackFailed = false;
        if (published) {
            rollbackFailed = !removePatchArtifactExact(patchPath, patchArtifactDirectoryIdentity, {
                jobRoot,
                hooks,
                expectedIdentity: candidateIdentity,
                expectedSha256: patchSha256,
                expectedBytes: patchBytes,
                failureCode: "AICW_PATCH_ARTIFACT_CLEANUP_FAILED"
            });
        }
        if (["AICW_PATCH_ARTIFACT_DIR_UNSAFE", "AICW_PATCH_ARTIFACT_DIR_DRIFT", "AICW_PATCH_PUBLIC_ARTIFACT_MISMATCH"].includes(error?.code)) {
            error.details = { ...(error.details || {}), published, rollbackFailed };
            throw error;
        }
        throw patchError(rollbackFailed ? "AICW_PATCH_ARTIFACT_CLEANUP_FAILED" : "AICW_PATCH_FILE_WRITE_FAILED", "Could not publish validated patch", {
            cause: error.code,
            published,
            rollbackFailed
        });
    }
}

async function validatePatchCandidate({ patchInput, repoRoot, candidatePath, options = {} }) {
    const patchText = extractPatchPayload(patchInput);
    assertNoSecrets(patchText);
    const parsed = parseUnifiedDiff(patchText);
    await validateTrackedPaths(repoRoot, parsed, options);
    fs.writeFileSync(candidatePath, patchText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const fd = fs.openSync(candidatePath, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    await applyCheck(repoRoot, candidatePath, options);
    return {
        patchText,
        parsed,
        patchSha256: sha256(Buffer.from(patchText, "utf8")),
        patchBytes: Buffer.byteLength(patchText, "utf8"),
        patchFileCount: parsed.fileCount
    };
}

module.exports = {
    MAX_PATCH_BYTES,
    validatePatchModel,
    validatePatchEffort,
    validatePatchSize,
    extractPatchPayload,
    validateRelativePath,
    parseUnifiedDiff,
    assertNoSecrets,
    runGit,
    readGitFingerprint,
    captureGitBaseline,
    assertBaselineStable,
    startGitBaselineMonitor,
    validateTrackedPaths,
    applyCheck,
    createPrivateCandidate,
    publishCandidateNoOverwrite,
    inspectAuthorizedPatchArtifact,
    inspectPatchArtifactFile,
    removePatchArtifactExact,
    sameArtifactIdentity,
    validatePatchCandidate,
    sha256
};
