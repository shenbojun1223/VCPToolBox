"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");
const DEFAULT_TIMEOUT_MS = 10000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 128 * 1024;
const MIN_OUTPUT_LIMIT_BYTES = 1024;
const MAX_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const STATUS_SHA_RE = /^[0-9a-f]{64}$/i;
const CANDIDATE_BRANCH_PREFIX = "vcp/aicw/";
const CANDIDATE_IDENTITY_NAME = "VCP AICodeWorker";
const CANDIDATE_IDENTITY_EMAIL = "aicodeworker@invalid.example";
const CANDIDATE_GIT_CONFIG = Object.freeze([
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false"
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const mutationGates = new Map();
class GitWorktreeError extends Error {
    constructor(code, message, details) {
        super(String(message || code || "Git Worktree operation failed"));
        this.name = "GitWorktreeError";
        this.code = String(code || "WORKTREE_ERROR");
        if (details !== undefined) this.details = details;
    }
}
function fail(code, message, details) {
    throw new GitWorktreeError(code, message, details);
}
function samePath(left, right) {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function absolutePath(value, field) {
    if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value)) {
        fail("WORKTREE_PATH_INVALID", `${field} must be an absolute path`);
    }
    if (value.split(/[\\/]+/).includes("..")) fail("WORKTREE_PATH_INVALID", `${field} must not contain parent traversal`);
    return path.resolve(value);
}
function pathPresent(value) {
    try { fs.lstatSync(value); return true; }
    catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
        fail("WORKTREE_PATH_INVALID", "Could not inspect the requested path", { field: value, cause: error?.code });
    }
}
function canonicalExistingDirectory(value, field) {
    const resolved = absolutePath(value, field);
    let canonical;
    let stat;
    try { canonical = fs.realpathSync.native(resolved); stat = fs.statSync(canonical); }
    catch (error) { fail("WORKTREE_PATH_INVALID", `${field} must be an existing directory`, { cause: error?.code }); }
    if (!stat.isDirectory() || !samePath(resolved, canonical)) fail("WORKTREE_PATH_INVALID", `${field} must be a canonical directory`);
    return canonical;
}
function withinDirectory(target, root) {
    const relative = path.relative(root, target);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function trustedWorkspaceRoot(value) { return canonicalExistingDirectory(value, "workspaceBaseRoot"); }

function mutationGateKey(repoRoot) {
    return process.platform === "win32" ? repoRoot.toLowerCase() : repoRoot;
}

function withMutationGate(repoRoot, operation) {
    const key = mutationGateKey(repoRoot);
    const previous = mutationGates.get(key) || Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    mutationGates.set(key, tail);
    return result.finally(() => {
        if (mutationGates.get(key) === tail) mutationGates.delete(key);
    });
}

function safeWorktreePath(value, baseRoot, field, mustExist, mustNotExist) {
    const resolved = absolutePath(value, field);
    if (!withinDirectory(resolved, baseRoot)) {
        fail("WORKTREE_PATH_OUTSIDE_BASE", `${field} is outside workspaceBaseRoot`);
    }
    const parent = canonicalExistingDirectory(path.dirname(resolved), `${field} parent`);
    if (!withinDirectory(parent, baseRoot) && !samePath(parent, baseRoot)) {
        fail("WORKTREE_PATH_OUTSIDE_BASE", `${field} parent is outside workspaceBaseRoot`);
    }
    if (mustNotExist && pathPresent(resolved)) {
        fail("WORKTREE_TARGET_EXISTS", `${field} already exists`);
    }
    if (mustExist) {
        const canonical = canonicalExistingDirectory(resolved, field);
        if (!withinDirectory(canonical, baseRoot)) {
            fail("WORKTREE_PATH_OUTSIDE_BASE", `${field} resolves outside workspaceBaseRoot`);
        }
        return canonical;
    }
    return resolved;
}
function normalizeWorktreeId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        fail("WORKTREE_WORKSPACE_ID_INVALID", "workspaceId must contain only conservative ASCII characters");
    }
    return value;
}
function normalizeLockReason(value) {
    if (typeof value !== "string" || !value || value.includes("\0") || /[\r\n]/.test(value) ||
        Buffer.byteLength(value, "utf8") > 256) {
        fail("WORKTREE_LOCK_REASON_INVALID", "lockReason must be a bounded single-line string");
    }
    return value;
}
function normalizeExpire(value) {
    if (typeof value !== "string" || !value || value.startsWith("-") || value.includes("\0") ||
        /[\r\n]/.test(value) || Buffer.byteLength(value, "utf8") > 128) {
        fail("WORKTREE_EXPIRE_INVALID", "expire must be a bounded Git date expression");
    }
    return value;
}
function normalizeBaseRevision(value) {
    if (typeof value !== "string" || !SHA_RE.test(value)) {
        fail("WORKTREE_BASE_REVISION_INVALID", "baseRevision must be a complete object ID");
    }
    return value.toLowerCase();
}
function normalizeExpectedDiscard(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("WORKTREE_EXPECTED_IDENTITY_INVALID", "expected Worktree identity is invalid");
    }
    if (typeof value.branch !== "string" || !value.branch || value.branch.includes("\0") ||
        /[\r\n]/.test(value.branch) || Buffer.byteLength(value.branch, "utf8") > 256 || value.locked !== true) {
        fail("WORKTREE_EXPECTED_IDENTITY_INVALID", "expected Worktree identity is invalid");
    }
    return Object.freeze({
        path: absolutePath(value.path, "expected.path"),
        head: normalizeBaseRevision(value.head),
        branch: value.branch,
        locked: true,
        lockReason: normalizeLockReason(value.lockReason)
    });
}
function normalizeExpectedCandidate(value) {
    const expected = normalizeExpectedDiscard(value);
    if (!expected.branch.startsWith(CANDIDATE_BRANCH_PREFIX)) {
        fail("WORKTREE_EXPECTED_IDENTITY_INVALID", "expected candidate branch is invalid");
    }
    const jobId = normalizeWorktreeId(expected.branch.slice(CANDIDATE_BRANCH_PREFIX.length));
    if (expected.branch !== `${CANDIDATE_BRANCH_PREFIX}${jobId}`) {
        fail("WORKTREE_EXPECTED_IDENTITY_INVALID", "expected candidate branch is invalid");
    }
    return Object.freeze({ ...expected, jobId });
}
function matchesExpectedIdentity(entry, expected, locked) {
    return Boolean(entry) && samePath(entry.path, expected.path) &&
        entry.branch === expected.branch && typeof entry.head === "string" &&
        entry.head.toLowerCase() === expected.head && entry.locked === locked &&
        (locked ? entry.lockReason === expected.lockReason : entry.lockReason === null);
}
function candidateGitEnvironment() {
    const env = { ...process.env };
    const blocked = new Set([
        "EMAIL", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_ASKPASS", "GIT_AUTHOR_DATE",
        "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_NAME", "GIT_COMMON_DIR", "GIT_CONFIG",
        "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_SYSTEM", "GIT_DIR", "GIT_EDITOR", "GIT_EXTERNAL_DIFF", "GIT_INDEX_FILE",
        "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_QUARANTINE_PATH",
        "GIT_REPLACE_REF_BASE", "GIT_SEQUENCE_EDITOR", "GIT_SHALLOW_FILE", "GIT_SSH", "GIT_SSH_COMMAND",
        "GIT_WORK_TREE", "VISUAL", "EDITOR"
    ]);
    for (const key of Object.keys(env)) {
        const upper = key.toUpperCase();
        if (blocked.has(upper) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper) ||
            upper.startsWith("GIT_COMMITTER_")) {
            delete env[key];
        }
    }
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
    env.GIT_NO_REPLACE_OBJECTS = "1";
    env.GIT_OPTIONAL_LOCKS = "0";
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_AUTHOR_NAME = CANDIDATE_IDENTITY_NAME;
    env.GIT_AUTHOR_EMAIL = CANDIDATE_IDENTITY_EMAIL;
    env.GIT_COMMITTER_NAME = CANDIDATE_IDENTITY_NAME;
    env.GIT_COMMITTER_EMAIL = CANDIDATE_IDENTITY_EMAIL;
    return Object.freeze(env);
}
function strictGitPath(value) {
    const buffer = Buffer.from(value || "");
    let decoded;
    try { decoded = UTF8_DECODER.decode(buffer); }
    catch { fail("WORKTREE_CANDIDATE_PATH_ENCODING_INVALID", "Git path is not strict UTF-8"); }
    if (!decoded || !Buffer.from(decoded, "utf8").equals(buffer)) {
        fail("WORKTREE_CANDIDATE_PATH_ENCODING_INVALID", "Git path is not strict UTF-8");
    }
    return decoded;
}
function nulFields(value) {
    const buffer = Buffer.from(value || "");
    if (buffer.length === 0) return [];
    if (buffer[buffer.length - 1] !== 0) {
        fail("WORKTREE_CANDIDATE_DIFF_INVALID", "Git raw diff was not NUL terminated");
    }
    const fields = [];
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] !== 0) continue;
        fields.push(buffer.subarray(start, index));
        start = index + 1;
    }
    return fields;
}
function parseRawDiffZ(value) {
    const fields = nulFields(value);
    const entries = [];
    for (let index = 0; index < fields.length;) {
        const headerBuffer = fields[index++];
        if (headerBuffer.some(byte => byte > 0x7f)) {
            fail("WORKTREE_CANDIDATE_DIFF_INVALID", "Git raw diff header is invalid");
        }
        const header = headerBuffer.toString("ascii");
        const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d{1,3})?$/.exec(header);
        if (!match) fail("WORKTREE_CANDIDATE_DIFF_INVALID", "Git raw diff header is invalid");
        const renamed = match[5] === "R" || match[5] === "C";
        if (index >= fields.length || (renamed && index + 1 >= fields.length)) {
            fail("WORKTREE_CANDIDATE_DIFF_INVALID", "Git raw diff omitted a path");
        }
        const firstPath = strictGitPath(fields[index++]);
        const secondPath = renamed ? strictGitPath(fields[index++]) : null;
        entries.push(Object.freeze({
            oldMode: match[1],
            newMode: match[2],
            status: match[5],
            score: match[6] == null ? null : Number(match[6]),
            path: renamed ? secondPath : firstPath,
            oldPath: renamed ? firstPath : null
        }));
    }
    return entries;
}
function assertSupportedCandidateEntries(entries) {
    for (const entry of entries) {
        if (entry.oldMode === "160000" || entry.newMode === "160000") {
            fail("WORKTREE_CANDIDATE_UNSUPPORTED_ENTRY", "Candidate changes cannot contain a gitlink");
        }
        if (entry.oldMode === "120000" || entry.newMode === "120000") {
            fail("WORKTREE_CANDIDATE_UNSUPPORTED_ENTRY", "Candidate changes cannot contain a symlink");
        }
    }
}
function candidateChangedFiles(entries) {
    return Object.freeze(entries.map(entry => {
        if (!["A", "M", "D", "R"].includes(entry.status)) {
            fail("WORKTREE_CANDIDATE_DIFF_INVALID", "Candidate diff contained an unsupported status");
        }
        return Object.freeze({
            status: entry.status,
            score: entry.status === "R" ? entry.score : null,
            path: entry.path,
            oldPath: entry.status === "R" ? entry.oldPath : null
        });
    }));
}
function outputText(value) {
    return Buffer.from(value || "").toString("utf8").trim();
}
function boundedText(value, limit) {
    const buffer = Buffer.from(value || "");
    return buffer.subarray(0, limit).toString("utf8");
}
function parseWorktreeListPorcelainZ(value) {
    if (typeof value !== "string" && !Buffer.isBuffer(value)) fail("WORKTREE_LIST_INVALID", "Git Worktree list output must be text");
    const text = Buffer.from(value).toString("utf8");
    const entries = [];
    let current = null;
    const finish = () => {
        if (!current) return;
        if (!current.path) fail("WORKTREE_LIST_INVALID", "Git Worktree list omitted a path");
        entries[entries.length] = { path: path.resolve(current.path), head: current.head, branch: current.branch,
            detached: current.detached, bare: current.bare, locked: current.locked,
            lockReason: current.locked ? current.lockReason : null, prunable: current.prunable,
            pruneReason: current.pruneReason };
        current = null;
    };
    for (const record of text.split("\0")) {
        for (const line of record.split(/\r?\n/)) {
            if (!line) continue;
            if (line.startsWith("worktree ")) {
                finish();
                current = { path: line.slice("worktree ".length), head: null, branch: null,
                    detached: false, bare: false, locked: false, lockReason: null,
                    prunable: false, pruneReason: null };
                continue;
            }
            if (!current) fail("WORKTREE_LIST_INVALID", "Git Worktree list began with an unexpected record");
            if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
            else if (line.startsWith("branch ")) {
                const ref = line.slice("branch ".length);
                current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
            } else if (line === "detached") current.detached = true;
            else if (line === "bare") current.bare = true;
            else if (line === "locked") current.locked = true;
            else if (line.startsWith("locked ")) {
                current.locked = true;
                current.lockReason = line.slice("locked ".length);
            } else if (line.startsWith("reason ")) {
                current.locked = true;
                current.lockReason = line.slice("reason ".length);
            } else if (line === "prunable") current.prunable = true;
            else if (line.startsWith("prunable ")) {
                current.prunable = true;
                current.pruneReason = line.slice("prunable ".length);
            }
        }
    }
    finish();
    return entries;
}
function runBoundedGit(request) {
    return new Promise((resolve, reject) => {
        let child, timer = null, forcedSettleTimer = null, settled = false, failure = null;
        let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (forcedSettleTimer) clearTimeout(forcedSettleTimer);
            error ? reject(error) : resolve(result);
        };
        const stopFor = error => {
            if (settled || failure) return;
            failure = error;
            try { child.kill("SIGKILL"); } catch {}
            forcedSettleTimer = setTimeout(() => finish(failure), 250);
            forcedSettleTimer.unref?.();
        };
        const append = (current, chunk, streamName) => {
            const incoming = Buffer.from(chunk);
            const remaining = request.outputLimitBytes - current.length;
            const kept = incoming.subarray(0, Math.max(0, remaining));
            const next = kept.length ? Buffer.concat([current, kept]) : current;
            if (incoming.length > remaining) {
                stopFor(new GitWorktreeError("WORKTREE_GIT_OUTPUT_LIMIT", `Git ${streamName} exceeded its limit`, { outputLimitBytes: request.outputLimitBytes }));
            }
            return next;
        };
        try {
            child = spawn(request.gitBin, request.args, {
                cwd: request.cwd,
                env: request.env || { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"]
            });
        } catch (error) {
            finish(new GitWorktreeError("WORKTREE_GIT_SPAWN_FAILED", "Could not start Git", { cause: error?.code }));
            return;
        }
        child.stdout?.on("data", chunk => { stdout = append(stdout, chunk, "stdout"); });
        child.stderr?.on("data", chunk => { stderr = append(stderr, chunk, "stderr"); });
        child.once("error", error => finish(new GitWorktreeError("WORKTREE_GIT_SPAWN_FAILED", "Git process failed", { cause: error?.code })));
        child.once("close", (code, signal) => failure ? finish(failure) : finish(null, { code, signal, stdout, stderr }));
        timer = setTimeout(() => stopFor(new GitWorktreeError("WORKTREE_GIT_TIMEOUT", "Git command timed out", {
            timeoutMs: request.timeoutMs
        })), request.timeoutMs);
        timer.unref?.();
    });
}
class GitWorktreeAdapter {
    #timeoutMs;
    #outputLimitBytes;
    #trustedWorkspaceBaseRoot;
    constructor(options = {}) {
        if (Object.prototype.hasOwnProperty.call(options, "gitBin") ||
            Object.prototype.hasOwnProperty.call(options, "_spawnRunner")) {
            fail("WORKTREE_OPTION_INVALID", "gitBin and _spawnRunner overrides are not supported");
        }
        const timeoutMs = options.commandTimeoutMs ?? DEFAULT_TIMEOUT_MS;
        const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
            fail("WORKTREE_OPTION_INVALID", "commandTimeoutMs is outside the fixed safe range");
        }
        if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes < MIN_OUTPUT_LIMIT_BYTES || outputLimitBytes > MAX_OUTPUT_LIMIT_BYTES) {
            fail("WORKTREE_OPTION_INVALID", "outputLimitBytes is outside the fixed safe range");
        }
        this.#timeoutMs = timeoutMs;
        this.#outputLimitBytes = outputLimitBytes;
        this.#trustedWorkspaceBaseRoot = options.workspaceBaseRoot == null
            ? null
            : trustedWorkspaceRoot(options.workspaceBaseRoot);
    }
    async #run(args, cwd, failureCode, failureMessage) {
        const request = Object.freeze({
            gitBin: "git",
            cwd,
            args: Object.freeze([...args]),
            timeoutMs: this.#timeoutMs,
            outputLimitBytes: this.#outputLimitBytes
        });
        const result = await runBoundedGit(request);
        if (!result || !Number.isInteger(result.code)) {
            throw new GitWorktreeError("WORKTREE_GIT_RUNNER_FAILED", "Git returned an invalid result");
        }
        if (result.code !== 0) {
            throw new GitWorktreeError(failureCode, failureMessage, {
                exitCode: result.code,
                signal: result.signal || null,
                stdout: boundedText(result.stdout, this.#outputLimitBytes),
                stderr: boundedText(result.stderr, this.#outputLimitBytes)
            });
        }
        return result;
    }
    async #runCandidate(args, cwd, failureCode, failureMessage, acceptNonZero = false) {
        const request = Object.freeze({
            gitBin: "git",
            cwd,
            args: Object.freeze([...CANDIDATE_GIT_CONFIG, ...args]),
            env: candidateGitEnvironment(),
            timeoutMs: this.#timeoutMs,
            outputLimitBytes: this.#outputLimitBytes
        });
        const result = await runBoundedGit(request);
        if (!result || !Number.isInteger(result.code)) {
            throw new GitWorktreeError("WORKTREE_GIT_RUNNER_FAILED", "Git returned an invalid result");
        }
        if (result.code !== 0 && !acceptNonZero) {
            throw new GitWorktreeError(failureCode, failureMessage, {
                exitCode: result.code,
                signal: result.signal || null
            });
        }
        return result;
    }
    async #repo(repoRoot, candidate = false) {
        const root = canonicalExistingDirectory(repoRoot, "repoRoot");
        const dotGit = path.join(root, ".git");
        let dotGitStat;
        let dotGitCanonical;
        try { dotGitStat = fs.lstatSync(dotGit); dotGitCanonical = fs.realpathSync.native(dotGit); }
        catch (error) { fail("WORKTREE_REPOSITORY_INVALID", "repoRoot must have a canonical .git directory", { cause: error?.code }); }
        if (!dotGitStat.isDirectory() || dotGitStat.isSymbolicLink() || !samePath(dotGit, dotGitCanonical)) fail("WORKTREE_REPOSITORY_INVALID", "repoRoot must be the primary non-bare worktree");
        let topLevel;
        try {
            const result = candidate
                ? await this.#runCandidate(["rev-parse", "--show-toplevel"], root,
                    "WORKTREE_REPOSITORY_INVALID", "Git did not report a repository top level")
                : await this.#run(["rev-parse", "--show-toplevel"], root,
                    "WORKTREE_REPOSITORY_INVALID", "Git did not report a repository top level");
            topLevel = outputText(result.stdout);
            topLevel = canonicalExistingDirectory(path.isAbsolute(topLevel) ? topLevel : path.join(root, topLevel), "Git top level");
        } catch (error) {
            if (error instanceof GitWorktreeError && error.code === "WORKTREE_PATH_INVALID") fail("WORKTREE_REPOSITORY_INVALID", "Git top level is not a canonical directory");
            throw error;
        }
        if (!samePath(root, topLevel)) fail("WORKTREE_REPOSITORY_INVALID", "repoRoot must be the Git top level");
        const bareResult = candidate
            ? await this.#runCandidate(["rev-parse", "--is-bare-repository"], root,
                "WORKTREE_REPOSITORY_INVALID", "Git repository type could not be verified")
            : await this.#run(["rev-parse", "--is-bare-repository"], root,
                "WORKTREE_REPOSITORY_INVALID", "Git repository type could not be verified");
        const bare = outputText(bareResult.stdout);
        if (bare !== "false") fail("WORKTREE_REPOSITORY_INVALID", "bare repositories are not accepted");
        return root;
    }
    async #fingerprint(root, candidate = false) {
        const run = (args, code, message) => candidate
            ? this.#runCandidate(args, root, code, message)
            : this.#run(args, root, code, message);
        const head = outputText((await run(
            ["rev-parse", "--verify", "HEAD"], "WORKTREE_BASE_UNAVAILABLE", "Git HEAD could not be read"
        )).stdout);
        const tree = outputText((await run(
            ["rev-parse", "--verify", "HEAD^{tree}"], "WORKTREE_BASE_UNAVAILABLE", "Git tree could not be read"
        )).stdout);
        const status = (await run(
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            "WORKTREE_BASE_UNAVAILABLE", "Git status could not be read"
        )).stdout;
        if (!SHA_RE.test(head) || !SHA_RE.test(tree)) fail("WORKTREE_BASE_UNAVAILABLE", "Git returned an incomplete base object ID");
        return { head: head.toLowerCase(), tree: tree.toLowerCase(), statusSha256: crypto.createHash("sha256").update(status).digest("hex"), dirty: status.length !== 0 };
    }
    async #listRoot(root, candidate = false) {
        const result = candidate
            ? await this.#runCandidate(
                ["worktree", "list", "--porcelain", "-z"], root,
                "WORKTREE_LIST_FAILED", "Git Worktree list failed"
            )
            : await this.#run(
                ["worktree", "list", "--porcelain", "-z"], root,
                "WORKTREE_LIST_FAILED", "Git Worktree list failed"
            );
        return parseWorktreeListPorcelainZ(result.stdout);
    }
    async #registered(root, target) {
        const entry = (await this.#listRoot(root)).find(item => samePath(item.path, target));
        if (!entry) fail("WORKTREE_NOT_REGISTERED", "The requested path is not a registered Git Worktree");
        return entry;
    }
    async #candidateObjectId(args, cwd, failureCode, failureMessage) {
        const objectId = outputText((await this.#runCandidate(args, cwd, failureCode, failureMessage)).stdout).toLowerCase();
        if (!SHA_RE.test(objectId)) fail(failureCode, failureMessage);
        return objectId;
    }
    async #assertCandidateIdentity(root, target, expected, head) {
        const registration = (await this.#listRoot(root, true)).find(item => samePath(item.path, target)) || null;
        if (!matchesExpectedIdentity(registration, { ...expected, head }, true)) {
            fail("WORKTREE_CANDIDATE_IDENTITY_DRIFT", "Candidate Worktree registration changed");
        }
        const topLevelText = outputText((await this.#runCandidate(
            ["rev-parse", "--show-toplevel"], target,
            "WORKTREE_CANDIDATE_IDENTITY_DRIFT", "Candidate Worktree root could not be verified"
        )).stdout);
        let topLevel;
        try {
            topLevel = canonicalExistingDirectory(
                path.isAbsolute(topLevelText) ? topLevelText : path.join(target, topLevelText),
                "candidate Worktree top level"
            );
        } catch {
            fail("WORKTREE_CANDIDATE_IDENTITY_DRIFT", "Candidate Worktree root changed");
        }
        if (!samePath(topLevel, target)) {
            fail("WORKTREE_CANDIDATE_IDENTITY_DRIFT", "Candidate Worktree root changed");
        }
        const branchRef = outputText((await this.#runCandidate(
            ["symbolic-ref", "--quiet", "HEAD"], target,
            "WORKTREE_CANDIDATE_IDENTITY_DRIFT", "Candidate Worktree branch could not be verified"
        )).stdout);
        const linkedHead = await this.#candidateObjectId(
            ["rev-parse", "--verify", "HEAD"], target,
            "WORKTREE_CANDIDATE_IDENTITY_DRIFT", "Candidate Worktree HEAD could not be verified"
        );
        if (branchRef !== `refs/heads/${expected.branch}` || linkedHead !== head) {
            fail("WORKTREE_CANDIDATE_IDENTITY_DRIFT", "Candidate Worktree HEAD or branch changed");
        }
        return registration;
    }
    async #assertCandidateFiltersClosed(target) {
        const result = await this.#runCandidate(
            ["config", "--includes", "--null", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
            target, "WORKTREE_CANDIDATE_FILTER_UNSAFE", "Candidate filter configuration could not be verified", true
        );
        if (result.code !== 0 && result.code !== 1) {
            fail("WORKTREE_CANDIDATE_FILTER_UNSAFE", "Candidate filter configuration could not be verified");
        }
        if (result.code === 0 || result.stdout.length !== 0) {
            fail("WORKTREE_CANDIDATE_FILTER_UNSAFE", "Candidate clean/smudge/process filters are not allowed");
        }
    }
    async #assertNoCandidateUnmerged(target) {
        const result = await this.#runCandidate(
            ["ls-files", "--unmerged", "-z"], target,
            "WORKTREE_CANDIDATE_UNMERGED", "Candidate unmerged state could not be verified"
        );
        if (result.stdout.length !== 0) {
            fail("WORKTREE_CANDIDATE_UNMERGED", "Candidate Worktree has unmerged entries");
        }
    }
    async #candidateCachedRaw(target) {
        return (await this.#runCandidate(
            ["diff", "--no-ext-diff", "--cached", "--raw", "-z", "--no-abbrev", "--"], target,
            "WORKTREE_CANDIDATE_DIFF_FAILED", "Candidate staged diff could not be read"
        )).stdout;
    }
    async #assertCandidateBaseStable(base, root) {
        if (!base || typeof base !== "object" || Array.isArray(base)) {
            fail("WORKTREE_BASE_INVALID", "base is invalid");
        }
        const expectedRevision = normalizeBaseRevision(base.baseRevision);
        if (typeof base.baseTree !== "string" || !SHA_RE.test(base.baseTree) ||
            typeof base.statusSha256 !== "string" || !STATUS_SHA_RE.test(base.statusSha256)) {
            fail("WORKTREE_BASE_INVALID", "base fingerprint is invalid");
        }
        const recordedRoot = canonicalExistingDirectory(base.repoRoot, "base.repoRoot");
        if (!samePath(root, recordedRoot)) fail("WORKTREE_BASE_INVALID", "base repoRoot does not match repoRoot");
        await this.#assertCandidateFiltersClosed(root);
        const fingerprint = await this.#fingerprint(root, true);
        if (fingerprint.head !== expectedRevision || fingerprint.tree.toLowerCase() !== base.baseTree.toLowerCase() ||
            fingerprint.statusSha256 !== base.statusSha256 || fingerprint.dirty) {
            fail("WORKTREE_BASE_DRIFT", "Git base fingerprint changed");
        }
        return fingerprint;
    }
    async #rollbackCandidateIndex(target, expectedHead, beforeStatus) {
        try {
            await this.#runCandidate(
                ["read-tree", "--reset", expectedHead], target,
                "WORKTREE_CANDIDATE_INDEX_ROLLBACK_UNCONFIRMED", "Candidate index rollback failed"
            );
            const cached = await this.#candidateCachedRaw(target);
            const afterStatus = (await this.#runCandidate(
                ["status", "--porcelain=v1", "-z", "--untracked-files=all"], target,
                "WORKTREE_CANDIDATE_INDEX_ROLLBACK_UNCONFIRMED", "Candidate index rollback could not be verified"
            )).stdout;
            if (cached.length !== 0 || !afterStatus.equals(beforeStatus)) {
                fail("WORKTREE_CANDIDATE_INDEX_ROLLBACK_UNCONFIRMED", "Candidate index rollback was not proven");
            }
        } catch (error) {
            if (error?.code === "WORKTREE_CANDIDATE_INDEX_ROLLBACK_UNCONFIRMED") throw error;
            throw new GitWorktreeError(
                "WORKTREE_CANDIDATE_INDEX_ROLLBACK_UNCONFIRMED",
                "Candidate index rollback was not proven"
            );
        }
    }
    #requirePinnedWorkspaceBaseRoot() {
        if (!this.#trustedWorkspaceBaseRoot) {
            fail("WORKTREE_WORKSPACE_ROOT_UNPINNED", "Git Worktree mutations require a pinned workspaceBaseRoot");
        }
        return this.#trustedWorkspaceBaseRoot;
    }
    assertPinnedWorkspaceBaseRoot(workspaceBaseRoot) {
        const pinned = this.#requirePinnedWorkspaceBaseRoot();
        const candidate = trustedWorkspaceRoot(workspaceBaseRoot);
        if (!samePath(candidate, pinned)) {
            fail("WORKTREE_WORKSPACE_ROOT_MISMATCH", "workspaceBaseRoot does not match the pinned root");
        }
        return pinned;
    }
    async captureBase(repoRoot) {
        const root = await this.#repo(repoRoot, true);
        await this.#assertCandidateFiltersClosed(root);
        const fingerprint = await this.#fingerprint(root, true);
        if (fingerprint.dirty) {
            fail("WORKTREE_BASE_DIRTY", "repoRoot must be clean", { statusSha256: fingerprint.statusSha256 });
        }
        return {
            repoRoot: root,
            baseRevision: fingerprint.head,
            baseTree: fingerprint.tree,
            statusSha256: fingerprint.statusSha256
        };
    }
    async assertBaseStable(base) {
        if (!base || typeof base !== "object" || Array.isArray(base)) fail("WORKTREE_BASE_INVALID", "base is invalid");
        const expectedRevision = normalizeBaseRevision(base.baseRevision);
        if (typeof base.baseTree !== "string" || !SHA_RE.test(base.baseTree)) {
            fail("WORKTREE_BASE_INVALID", "baseTree is invalid");
        }
        if (typeof base.statusSha256 !== "string" || !STATUS_SHA_RE.test(base.statusSha256)) {
            fail("WORKTREE_BASE_INVALID", "statusSha256 is invalid");
        }
        const root = await this.#repo(base.repoRoot, true);
        await this.#assertCandidateFiltersClosed(root);
        const fingerprint = await this.#fingerprint(root, true);
        if (fingerprint.head !== expectedRevision || fingerprint.tree.toLowerCase() !== base.baseTree.toLowerCase() ||
            fingerprint.statusSha256 !== base.statusSha256 || fingerprint.dirty) {
            fail("WORKTREE_BASE_DRIFT", "Git base fingerprint changed");
        }
        return fingerprint;
    }
    async list(repoRoot) {
        return this.#listRoot(await this.#repo(repoRoot));
    }
    async inspect(repoRoot, worktreePath) {
        const root = await this.#repo(repoRoot);
        const resolved = pathPresent(worktreePath)
            ? canonicalExistingDirectory(worktreePath, "worktreePath")
            : absolutePath(worktreePath, "worktreePath");
        return (await this.#listRoot(root)).find(item => samePath(item.path, resolved)) || null;
    }
    async add({ base, workspaceBaseRoot, workspaceId, lockReason }) {
        const baseRoot = this.assertPinnedWorkspaceBaseRoot(workspaceBaseRoot);
        const id = normalizeWorktreeId(workspaceId);
        const reason = normalizeLockReason(lockReason);
        const revision = normalizeBaseRevision(base?.baseRevision);
        const root = await this.#repo(base.repoRoot, true);
        const branch = `vcp/aicw/${id}`;
        return withMutationGate(root, async () => {
            await this.#assertCandidateFiltersClosed(root);
            await this.#assertCandidateBaseStable(base, root);
            const target = safeWorktreePath(path.join(baseRoot, id), baseRoot, "worktreePath", false, true);
            await this.#runCandidate(
                ["worktree", "add", "--lock", "--reason", reason, "-b", branch, target, revision],
                root, "WORKTREE_ADD_FAILED", "Git Worktree add failed"
            );
            await this.#assertCandidateBaseStable(base, root);
            const entry = (await this.#listRoot(root, true)).find(item => samePath(item.path, target));
            if (!entry || entry.head?.toLowerCase() !== revision || entry.branch !== branch ||
                !entry.locked || entry.lockReason !== reason) {
                fail("WORKTREE_ADD_VERIFY_FAILED", "Git Worktree add did not produce the expected registration");
            }
            return entry;
        });
    }
    async lock(repoRoot, worktreePath, reason) {
        const baseRoot = this.#requirePinnedWorkspaceBaseRoot();
        const normalizedReason = normalizeLockReason(reason);
        const root = await this.#repo(repoRoot);
        return withMutationGate(root, async () => {
            const target = safeWorktreePath(worktreePath, baseRoot, "worktreePath", true, false);
            await this.#registered(root, target);
            await this.#run(
                ["worktree", "lock", "--reason", normalizedReason, target], root, "WORKTREE_LOCK_FAILED", "Git Worktree lock failed"
            );
            const entry = await this.#registered(root, target);
            if (!entry.locked || entry.lockReason !== normalizedReason) fail("WORKTREE_LOCK_VERIFY_FAILED", "Git Worktree lock was not verified");
            return entry;
        });
    }
    async unlock(repoRoot, worktreePath) {
        const baseRoot = this.#requirePinnedWorkspaceBaseRoot();
        const root = await this.#repo(repoRoot);
        return withMutationGate(root, async () => {
            const target = safeWorktreePath(worktreePath, baseRoot, "worktreePath", true, false);
            await this.#registered(root, target);
            await this.#run(["worktree", "unlock", target], root, "WORKTREE_UNLOCK_FAILED", "Git Worktree unlock failed");
            const entry = await this.#registered(root, target);
            if (entry.locked || entry.lockReason !== null) fail("WORKTREE_UNLOCK_VERIFY_FAILED", "Git Worktree unlock was not verified");
            return entry;
        });
    }
    async move(repoRoot, oldPath, newPath, workspaceBaseRoot) {
        const baseRoot = this.assertPinnedWorkspaceBaseRoot(workspaceBaseRoot);
        const root = await this.#repo(repoRoot);
        return withMutationGate(root, async () => {
            const oldTarget = safeWorktreePath(oldPath, baseRoot, "oldPath", true, false);
            const newTarget = safeWorktreePath(newPath, baseRoot, "newPath", false, true);
            await this.#registered(root, oldTarget);
            await this.#run(["worktree", "move", oldTarget, newTarget], root, "WORKTREE_MOVE_FAILED", "Git Worktree move failed");
            if ((await this.#listRoot(root)).some(entry => samePath(entry.path, oldTarget))) {
                fail("WORKTREE_MOVE_VERIFY_FAILED", "Old Git Worktree path remains registered");
            }
            const entry = (await this.#listRoot(root)).find(item => samePath(item.path, newTarget));
            if (!entry) fail("WORKTREE_MOVE_VERIFY_FAILED", "New Git Worktree path was not registered");
            return entry;
        });
    }
    async remove(repoRoot, worktreePath, workspaceBaseRoot) {
        const baseRoot = this.assertPinnedWorkspaceBaseRoot(workspaceBaseRoot);
        const root = await this.#repo(repoRoot);
        return withMutationGate(root, async () => {
            const target = safeWorktreePath(worktreePath, baseRoot, "worktreePath", true, false);
            const entry = await this.#registered(root, target);
            if (entry.locked) fail("WORKTREE_LOCKED", "Unlock the Git Worktree before removal");
            await this.#run(["worktree", "remove", target], root, "WORKTREE_REMOVE_FAILED", "Git Worktree remove failed");
            if ((await this.#listRoot(root)).some(item => samePath(item.path, target))) {
                fail("WORKTREE_REMOVE_VERIFY_FAILED", "Git Worktree registration remains after removal");
            }
            return { path: target, removed: true };
        });
    }
    async #bestEffortRelock(root, target, expected) {
        try {
            let entry = (await this.#listRoot(root)).find(item => samePath(item.path, target)) || null;
            if (matchesExpectedIdentity(entry, expected, true)) return true;
            if (!matchesExpectedIdentity(entry, expected, false)) return false;
            await this.#run(
                ["worktree", "lock", "--reason", expected.lockReason, target],
                root, "WORKTREE_LOCK_FAILED", "Git Worktree lock failed"
            );
            entry = (await this.#listRoot(root)).find(item => samePath(item.path, target)) || null;
            return matchesExpectedIdentity(entry, expected, true);
        } catch {
            return false;
        }
    }
    async discardExpected(options = {}) {
        if (!options || typeof options !== "object" || Array.isArray(options)) {
            fail("WORKTREE_OPTION_INVALID", "discardExpected options are invalid");
        }
        const baseRoot = this.assertPinnedWorkspaceBaseRoot(options.workspaceBaseRoot);
        const expected = normalizeExpectedDiscard(options.expected);
        const root = await this.#repo(options.repoRoot);
        return withMutationGate(root, async () => {
            const target = safeWorktreePath(
                expected.path, baseRoot, "expected.path", pathPresent(expected.path), false
            );
            const beforeUnlock = (await this.#listRoot(root)).find(item => samePath(item.path, target)) || null;
            if (!matchesExpectedIdentity(beforeUnlock, expected, true)) {
                fail("WORKTREE_EXPECTED_IDENTITY_MISMATCH", "The registered Git Worktree identity changed");
            }
            await this.#run(
                ["worktree", "unlock", target], root, "WORKTREE_UNLOCK_FAILED", "Git Worktree unlock failed"
            );
            const afterUnlock = (await this.#listRoot(root)).find(item => samePath(item.path, target)) || null;
            if (!matchesExpectedIdentity(afterUnlock, expected, false)) {
                fail("WORKTREE_EXPECTED_IDENTITY_MISMATCH", "The registered Git Worktree identity changed");
            }
            try {
                await this.#run(
                    ["worktree", "remove", target], root, "WORKTREE_REMOVE_FAILED", "Git Worktree remove failed"
                );
            } catch (error) {
                if (error?.code !== "WORKTREE_REMOVE_FAILED") throw error;
                const relocked = await this.#bestEffortRelock(root, target, expected);
                throw new GitWorktreeError(
                    "WORKTREE_DISCARD_BLOCKED",
                    "Git Worktree discard was blocked",
                    { cause: "WORKTREE_REMOVE_FAILED", relocked }
                );
            }
            if ((await this.#listRoot(root)).some(item => samePath(item.path, target))) {
                fail("WORKTREE_REMOVE_VERIFY_FAILED", "Git Worktree registration remains after removal");
            }
            return { path: target, removed: true };
        });
    }
    async createCandidateCommitExpected(options = {}) {
        if (!options || typeof options !== "object" || Array.isArray(options)) {
            fail("WORKTREE_OPTION_INVALID", "createCandidateCommitExpected options are invalid");
        }
        const baseRoot = this.assertPinnedWorkspaceBaseRoot(options.workspaceBaseRoot);
        const expected = normalizeExpectedCandidate(options.expected);
        const baseRevision = normalizeBaseRevision(options.base?.baseRevision);
        if (expected.head !== baseRevision) {
            fail("WORKTREE_CANDIDATE_IDENTITY_DRIFT", "Candidate expected HEAD is not the initial base");
        }
        const root = await this.#repo(options.repoRoot, true);

        return withMutationGate(root, async () => {
            await this.#assertCandidateBaseStable(options.base, root);
            const target = safeWorktreePath(expected.path, baseRoot, "expected.path", true, false);
            await this.#assertCandidateIdentity(root, target, expected, expected.head);
            await this.#assertCandidateFiltersClosed(target);
            await this.#assertNoCandidateUnmerged(target);
            if ((await this.#candidateCachedRaw(target)).length !== 0) {
                fail("WORKTREE_CANDIDATE_STAGED_INPUT", "Candidate Worktree already has staged input");
            }
            const beforeStatus = (await this.#runCandidate(
                ["status", "--porcelain=v1", "-z", "--untracked-files=all"], target,
                "WORKTREE_CANDIDATE_STATUS_FAILED", "Candidate Worktree status could not be read"
            )).stdout;
            let rollbackAllowed = true;

            try {
                await this.#runCandidate(
                    ["add", "-A", "--", "."], target,
                    "WORKTREE_CANDIDATE_STAGE_FAILED", "Candidate changes could not be staged"
                );
                await this.#assertNoCandidateUnmerged(target);
                const stagedRaw = await this.#candidateCachedRaw(target);
                const stagedEntries = parseRawDiffZ(stagedRaw);
                if (stagedEntries.length === 0) {
                    fail("WORKTREE_CANDIDATE_EMPTY", "Candidate Worktree has no committable changes");
                }
                assertSupportedCandidateEntries(stagedEntries);
                await this.#runCandidate(
                    ["diff", "--no-ext-diff", "--cached", "--check", "--"], target,
                    "WORKTREE_CANDIDATE_DIFF_CHECK_FAILED", "Candidate staged diff failed validation"
                );
                const resultTree = await this.#candidateObjectId(
                    ["write-tree"], target,
                    "WORKTREE_CANDIDATE_WRITE_TREE_FAILED", "Candidate tree could not be written"
                );
                const resultCommit = await this.#candidateObjectId(
                    [
                        "commit-tree", resultTree, "-p", expected.head,
                        "-m", `VCP AICodeWorker candidate ${expected.branch}`
                    ],
                    target, "WORKTREE_CANDIDATE_COMMIT_TREE_FAILED", "Candidate commit could not be created"
                );

                await this.#assertCandidateIdentity(root, target, expected, expected.head);
                await this.#assertCandidateBaseStable(options.base, root);
                const branchRef = `refs/heads/${expected.branch}`;
                let updateResult;
                try {
                    updateResult = await this.#runCandidate(
                        ["update-ref", branchRef, resultCommit, expected.head], root,
                        "WORKTREE_CANDIDATE_REF_CAS_FAILED", "Candidate branch compare-and-swap failed", true
                    );
                } catch (error) {
                    rollbackAllowed = false;
                    throw new GitWorktreeError(
                        "WORKTREE_CANDIDATE_OUTCOME_UNKNOWN",
                        "Candidate branch update outcome is unknown",
                        { cause: typeof error?.code === "string" ? error.code : "UNKNOWN" }
                    );
                }
                if (updateResult.code !== 0) {
                    let observedRef;
                    try {
                        observedRef = await this.#candidateObjectId(
                            ["rev-parse", "--verify", branchRef], root,
                            "WORKTREE_CANDIDATE_OUTCOME_UNKNOWN", "Candidate branch state could not be confirmed"
                        );
                    } catch (error) {
                        rollbackAllowed = false;
                        throw new GitWorktreeError(
                            "WORKTREE_CANDIDATE_OUTCOME_UNKNOWN",
                            "Candidate branch update outcome is unknown",
                            { cause: typeof error?.code === "string" ? error.code : "UNKNOWN" }
                        );
                    }
                    if (observedRef !== expected.head) {
                        rollbackAllowed = false;
                        throw new GitWorktreeError(
                            "WORKTREE_CANDIDATE_OUTCOME_UNKNOWN",
                            "Candidate branch update outcome is unknown"
                        );
                    }
                    fail("WORKTREE_CANDIDATE_REF_CAS_FAILED", "Candidate branch compare-and-swap failed");
                }

                rollbackAllowed = false;
                let changedFiles;
                try {
                    const observedRef = await this.#candidateObjectId(
                        ["rev-parse", "--verify", branchRef], root,
                        "WORKTREE_CANDIDATE_POST_VERIFY_FAILED", "Candidate branch could not be verified"
                    );
                    if (observedRef !== resultCommit) {
                        fail("WORKTREE_CANDIDATE_POST_VERIFY_FAILED", "Candidate branch does not identify the result commit");
                    }
                    await this.#assertCandidateIdentity(root, target, expected, resultCommit);
                    const parentLine = outputText((await this.#runCandidate(
                        ["rev-list", "--parents", "-n", "1", resultCommit], root,
                        "WORKTREE_CANDIDATE_POST_VERIFY_FAILED", "Candidate parent could not be verified"
                    )).stdout).toLowerCase().split(/\s+/);
                    if (parentLine.length !== 2 || parentLine[0] !== resultCommit || parentLine[1] !== expected.head) {
                        fail("WORKTREE_CANDIDATE_POST_VERIFY_FAILED", "Candidate parent does not match expected HEAD");
                    }
                    const committedTree = await this.#candidateObjectId(
                        ["rev-parse", "--verify", `${resultCommit}^{tree}`], root,
                        "WORKTREE_CANDIDATE_POST_VERIFY_FAILED", "Candidate tree could not be verified"
                    );
                    if (committedTree !== resultTree) {
                        fail("WORKTREE_CANDIDATE_POST_VERIFY_FAILED", "Candidate tree does not match the written tree");
                    }
                    const cleanStatus = (await this.#runCandidate(
                        ["status", "--porcelain=v1", "-z", "--untracked-files=all"], target,
                        "WORKTREE_CANDIDATE_POST_VERIFY_FAILED", "Candidate Worktree cleanliness could not be verified"
                    )).stdout;
                    if (cleanStatus.length !== 0) {
                        fail("WORKTREE_CANDIDATE_POST_VERIFY_FAILED", "Candidate Worktree is not clean at the result commit");
                    }
                    await this.#assertCandidateBaseStable(options.base, root);
                    const changedRaw = (await this.#runCandidate(
                        [
                            "diff", "--no-ext-diff", "--raw", "-z", "--no-abbrev", "--find-renames",
                            expected.head, resultCommit, "--"
                        ], root,
                        "WORKTREE_CANDIDATE_POST_VERIFY_FAILED", "Candidate changed paths could not be read"
                    )).stdout;
                    const changedEntries = parseRawDiffZ(changedRaw);
                    assertSupportedCandidateEntries(changedEntries);
                    if (changedEntries.length === 0) {
                        fail("WORKTREE_CANDIDATE_POST_VERIFY_FAILED", "Candidate changed path list is empty");
                    }
                    changedFiles = candidateChangedFiles(changedEntries);
                } catch (error) {
                    if (error?.code === "WORKTREE_CANDIDATE_OUTCOME_UNKNOWN") throw error;
                    throw new GitWorktreeError(
                        "WORKTREE_CANDIDATE_OUTCOME_UNKNOWN",
                        "Candidate branch advanced but post-verification was not proven",
                        { cause: typeof error?.code === "string" ? error.code : "UNKNOWN" }
                    );
                }

                return Object.freeze({
                    schemaVersion: 1,
                    jobId: expected.jobId,
                    worktreePath: target,
                    branch: expected.branch,
                    baseRevision,
                    resultCommit,
                    resultTree,
                    changedFiles,
                    worktreeClean: true,
                    locked: true
                });
            } catch (error) {
                if (rollbackAllowed) {
                    await this.#rollbackCandidateIndex(target, expected.head, beforeStatus);
                }
                throw error;
            }
        });
    }
    async repair(repoRoot, paths = [], workspaceBaseRoot) {
        const baseRoot = workspaceBaseRoot === undefined
            ? this.#requirePinnedWorkspaceBaseRoot()
            : this.assertPinnedWorkspaceBaseRoot(workspaceBaseRoot);
        const root = await this.#repo(repoRoot);
        if (!Array.isArray(paths) || paths.some(value => typeof value !== "string")) {
            fail("WORKTREE_PATH_INVALID", "repair paths must be an array of absolute paths");
        }
        return withMutationGate(root, async () => {
            const normalized = paths.map(value => safeWorktreePath(value, baseRoot, "repairPath", true, false));
            const result = await this.#run(
                ["worktree", "repair", ...normalized], root, "WORKTREE_REPAIR_FAILED", "Git Worktree repair failed"
            );
            const entries = await this.#listRoot(root);
            if (normalized.length) {
                const missing = normalized.find(target => !entries.some(entry => samePath(entry.path, target)));
                if (missing) {
                    fail("WORKTREE_REPAIR_VERIFY_FAILED", "Git Worktree repair did not produce the expected registration", {
                        path: missing
                    });
                }
            } else if (!entries.some(entry => samePath(entry.path, root) && !entry.bare)) {
                fail("WORKTREE_REPAIR_VERIFY_FAILED", "Git Worktree repair did not preserve the primary registration");
            }
            return { paths: normalized, stdout: outputText(result.stdout), stderr: outputText(result.stderr) };
        });
    }
    async prune(repoRoot, options = {}) {
        const root = await this.#repo(repoRoot);
        if (!options || typeof options !== "object" || Array.isArray(options)) {
            fail("WORKTREE_OPTION_INVALID", "prune options are invalid");
        }
        const dryRun = options.dryRun ?? true;
        if (dryRun !== true) fail("WORKTREE_DESTRUCTIVE_PRUNE_DISABLED", "Only dry-run Worktree prune is enabled");
        const expire = typeof options.expire === "undefined" ? null : normalizeExpire(options.expire);
        const args = ["worktree", "prune", "--dry-run", "--verbose", ...(expire ? ["--expire", expire] : [])];
        const result = await this.#run(args, root, "WORKTREE_PRUNE_FAILED", "Git prune dry-run failed");
        return { dryRun: true, expire, stdout: outputText(result.stdout), stderr: outputText(result.stderr) };
    }
}
module.exports = {
    GitWorktreeAdapter,
    GitWorktreeError,
    parseWorktreeListPorcelainZ,
    normalizeWorktreeId,
    normalizeLockReason
};
