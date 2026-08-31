"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const DEFAULT_TIMEOUT_MS = 10000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 60000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 128 * 1024;
const MIN_OUTPUT_LIMIT_BYTES = 1024;
const MAX_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const STATUS_SHA_RE = /^[0-9a-f]{64}$/i;
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
                env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
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
    async #repo(repoRoot) {
        const root = canonicalExistingDirectory(repoRoot, "repoRoot");
        const dotGit = path.join(root, ".git");
        let dotGitStat;
        let dotGitCanonical;
        try { dotGitStat = fs.lstatSync(dotGit); dotGitCanonical = fs.realpathSync.native(dotGit); }
        catch (error) { fail("WORKTREE_REPOSITORY_INVALID", "repoRoot must have a canonical .git directory", { cause: error?.code }); }
        if (!dotGitStat.isDirectory() || dotGitStat.isSymbolicLink() || !samePath(dotGit, dotGitCanonical)) fail("WORKTREE_REPOSITORY_INVALID", "repoRoot must be the primary non-bare worktree");
        let topLevel;
        try {
            topLevel = outputText((await this.#run(["rev-parse", "--show-toplevel"], root, "WORKTREE_REPOSITORY_INVALID", "Git did not report a repository top level")).stdout);
            topLevel = canonicalExistingDirectory(path.isAbsolute(topLevel) ? topLevel : path.join(root, topLevel), "Git top level");
        } catch (error) {
            if (error instanceof GitWorktreeError && error.code === "WORKTREE_PATH_INVALID") fail("WORKTREE_REPOSITORY_INVALID", "Git top level is not a canonical directory");
            throw error;
        }
        if (!samePath(root, topLevel)) fail("WORKTREE_REPOSITORY_INVALID", "repoRoot must be the Git top level");
        const bare = outputText((await this.#run(["rev-parse", "--is-bare-repository"], root, "WORKTREE_REPOSITORY_INVALID", "Git repository type could not be verified")).stdout);
        if (bare !== "false") fail("WORKTREE_REPOSITORY_INVALID", "bare repositories are not accepted");
        return root;
    }
    async #fingerprint(root) {
        const head = outputText((await this.#run(["rev-parse", "--verify", "HEAD"], root, "WORKTREE_BASE_UNAVAILABLE", "Git HEAD could not be read")).stdout);
        const tree = outputText((await this.#run(["rev-parse", "--verify", "HEAD^{tree}"], root, "WORKTREE_BASE_UNAVAILABLE", "Git tree could not be read")).stdout);
        const status = (await this.#run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, "WORKTREE_BASE_UNAVAILABLE", "Git status could not be read")).stdout;
        if (!SHA_RE.test(head) || !SHA_RE.test(tree)) fail("WORKTREE_BASE_UNAVAILABLE", "Git returned an incomplete base object ID");
        return { head: head.toLowerCase(), tree: tree.toLowerCase(), statusSha256: crypto.createHash("sha256").update(status).digest("hex"), dirty: status.length !== 0 };
    }
    async #listRoot(root) {
        const result = await this.#run(
            ["worktree", "list", "--porcelain", "-z"], root, "WORKTREE_LIST_FAILED", "Git Worktree list failed"
        );
        return parseWorktreeListPorcelainZ(result.stdout);
    }
    async #registered(root, target) {
        const entry = (await this.#listRoot(root)).find(item => samePath(item.path, target));
        if (!entry) fail("WORKTREE_NOT_REGISTERED", "The requested path is not a registered Git Worktree");
        return entry;
    }
    #workspaceBaseRoot(workspaceBaseRoot) {
        const candidate = this.#trustedWorkspaceBaseRoot || workspaceBaseRoot;
        if (!candidate) fail("WORKTREE_PATH_INVALID", "workspaceBaseRoot is required");
        return trustedWorkspaceRoot(candidate);
    }
    async captureBase(repoRoot) {
        const root = await this.#repo(repoRoot);
        const fingerprint = await this.#fingerprint(root);
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
        const root = await this.#repo(base.repoRoot);
        const fingerprint = await this.#fingerprint(root);
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
        await this.assertBaseStable(base);
        const root = await this.#repo(base.repoRoot);
        const baseRoot = trustedWorkspaceRoot(workspaceBaseRoot);
        const id = normalizeWorktreeId(workspaceId);
        const reason = normalizeLockReason(lockReason);
        const target = safeWorktreePath(path.join(baseRoot, id), baseRoot, "worktreePath", false, true);
        const branch = `vcp/aicw/${id}`;
        await this.#run(
            ["worktree", "add", "--lock", "--reason", reason, "-b", branch, target, normalizeBaseRevision(base.baseRevision)],
            root, "WORKTREE_ADD_FAILED", "Git Worktree add failed"
        );
        await this.assertBaseStable(base);
        const entry = (await this.#listRoot(root)).find(item => samePath(item.path, target));
        if (!entry || entry.head?.toLowerCase() !== base.baseRevision.toLowerCase() || entry.branch !== branch ||
            !entry.locked || entry.lockReason !== reason) {
            fail("WORKTREE_ADD_VERIFY_FAILED", "Git Worktree add did not produce the expected registration");
        }
        return entry;
    }
    async lock(repoRoot, worktreePath, reason) {
        const baseRoot = this.#workspaceBaseRoot();
        const target = safeWorktreePath(worktreePath, baseRoot, "worktreePath", true, false);
        const normalizedReason = normalizeLockReason(reason);
        const root = await this.#repo(repoRoot);
        await this.#registered(root, target);
        await this.#run(
            ["worktree", "lock", "--reason", normalizedReason, target], root, "WORKTREE_LOCK_FAILED", "Git Worktree lock failed"
        );
        const entry = await this.#registered(root, target);
        if (!entry.locked || entry.lockReason !== normalizedReason) fail("WORKTREE_LOCK_VERIFY_FAILED", "Git Worktree lock was not verified");
        return entry;
    }
    async unlock(repoRoot, worktreePath) {
        const baseRoot = this.#workspaceBaseRoot();
        const target = safeWorktreePath(worktreePath, baseRoot, "worktreePath", true, false);
        const root = await this.#repo(repoRoot);
        await this.#registered(root, target);
        await this.#run(["worktree", "unlock", target], root, "WORKTREE_UNLOCK_FAILED", "Git Worktree unlock failed");
        const entry = await this.#registered(root, target);
        if (entry.locked || entry.lockReason !== null) fail("WORKTREE_UNLOCK_VERIFY_FAILED", "Git Worktree unlock was not verified");
        return entry;
    }
    async move(repoRoot, oldPath, newPath, workspaceBaseRoot) {
        const root = await this.#repo(repoRoot);
        const baseRoot = trustedWorkspaceRoot(workspaceBaseRoot);
        const oldTarget = safeWorktreePath(oldPath, baseRoot, "oldPath", true, false);
        const newTarget = safeWorktreePath(newPath, baseRoot, "newPath", false, true);
        await this.#registered(root, oldTarget);
        await this.#run(["worktree", "move", oldTarget, newTarget], root, "WORKTREE_MOVE_FAILED", "Git Worktree move failed");
        if (await this.inspect(root, oldTarget)) fail("WORKTREE_MOVE_VERIFY_FAILED", "Old Git Worktree path remains registered");
        const entry = await this.inspect(root, newTarget);
        if (!entry) fail("WORKTREE_MOVE_VERIFY_FAILED", "New Git Worktree path was not registered");
        return entry;
    }
    async remove(repoRoot, worktreePath, workspaceBaseRoot) {
        const root = await this.#repo(repoRoot);
        const baseRoot = trustedWorkspaceRoot(workspaceBaseRoot);
        const target = safeWorktreePath(worktreePath, baseRoot, "worktreePath", true, false);
        const entry = await this.#registered(root, target);
        if (entry.locked) fail("WORKTREE_LOCKED", "Unlock the Git Worktree before removal");
        await this.#run(["worktree", "remove", target], root, "WORKTREE_REMOVE_FAILED", "Git Worktree remove failed");
        if (await this.inspect(root, target)) fail("WORKTREE_REMOVE_VERIFY_FAILED", "Git Worktree registration remains after removal");
        return { path: target, removed: true };
    }
    async repair(repoRoot, paths = [], workspaceBaseRoot) {
        const root = await this.#repo(repoRoot);
        if (!Array.isArray(paths) || paths.some(value => typeof value !== "string")) {
            fail("WORKTREE_PATH_INVALID", "repair paths must be an array of absolute paths");
        }
        let normalized = [];
        if (paths.length) {
            const baseRoot = this.#workspaceBaseRoot(workspaceBaseRoot);
            normalized = paths.map(value => safeWorktreePath(value, baseRoot, "repairPath", true, false));
        }
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
