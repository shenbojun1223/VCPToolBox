"use strict";

const path = require("node:path");
const {
    GitWorktreeAdapter,
    normalizeWorktreeId
} = require("./gitWorktreeAdapter");

const BRANCH_PREFIX = "vcp/aicw/";
const LOCK_REASON_PREFIX = "AICodeWorker write session ";

class WorktreeWriteSessionError extends Error {
    constructor(code, message, details) {
        super(String(message || code || "Worktree write session failed"));
        this.name = "WorktreeWriteSessionError";
        this.code = String(code || "WORKTREE_SESSION_ERROR");
        if (details !== undefined) this.details = Object.freeze({ ...details });
    }
}

function fail(code, message, details) {
    throw new WorktreeWriteSessionError(code, message, details);
}

function requireAbsolutePath(value, field) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
        fail("WORKTREE_SESSION_PATH_INVALID", `${field} must be an absolute path`);
    }
    return value;
}

function samePath(left, right) {
    if (typeof left !== "string" || typeof right !== "string") return false;
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function safeCauseCode(value) {
    return typeof value === "string" && /^[A-Z0-9_]+$/.test(value)
        ? value
        : "UNKNOWN";
}

function freezeEntry(entry) {
    if (entry === null) return null;
    return Object.freeze({
        path: entry.path,
        head: entry.head,
        branch: entry.branch,
        detached: entry.detached,
        bare: entry.bare,
        locked: entry.locked,
        lockReason: entry.lockReason,
        prunable: entry.prunable,
        pruneReason: entry.pruneReason
    });
}

class WorktreeWriteSession {
    #adapter;
    #jobId;
    #repoRoot;
    #workspaceBaseRoot;
    #branch;
    #lockReason;
    #state = "new";
    #handle = null;
    #openPromise = null;
    #discardPromise = null;
    #operationTail = Promise.resolve();
    #discardRequested = false;

    constructor(options = {}) {
        if (!options || typeof options !== "object" || Array.isArray(options)) {
            fail("WORKTREE_SESSION_OPTIONS_INVALID", "session options are invalid");
        }
        const { adapter, jobId, repoRoot, workspaceBaseRoot } = options;
        if (!(adapter instanceof GitWorktreeAdapter)) {
            fail("WORKTREE_SESSION_ADAPTER_INVALID", "adapter must be a GitWorktreeAdapter");
        }
        this.#adapter = adapter;
        this.#jobId = normalizeWorktreeId(jobId);
        this.#repoRoot = requireAbsolutePath(repoRoot, "repoRoot");
        const requestedWorkspaceBaseRoot = requireAbsolutePath(workspaceBaseRoot, "workspaceBaseRoot");
        this.#workspaceBaseRoot = adapter.assertPinnedWorkspaceBaseRoot(requestedWorkspaceBaseRoot);
        this.#branch = `${BRANCH_PREFIX}${this.#jobId}`;
        this.#lockReason = `${LOCK_REASON_PREFIX}${this.#jobId}`;
    }

    #targetPath() {
        return path.resolve(path.join(this.#workspaceBaseRoot, this.#jobId));
    }

    #isOpeningEntry(entry, base, targetPath) {
        return Boolean(entry) && samePath(entry.path, targetPath) &&
            entry.branch === this.#branch && entry.locked === true &&
            entry.lockReason === this.#lockReason &&
            typeof entry.head === "string" && typeof base?.baseRevision === "string" &&
            entry.head.toLowerCase() === base.baseRevision.toLowerCase();
    }

    #isLockedIdentity(entry, handle) {
        return Boolean(entry) && samePath(entry.path, handle.worktreePath) &&
            entry.branch === handle.branch && entry.locked === true &&
            entry.lockReason === handle.lockReason && typeof entry.head === "string" &&
            entry.head.toLowerCase() === handle.base.baseRevision.toLowerCase();
    }

    #identityMismatch() {
        return new WorktreeWriteSessionError(
            "WORKTREE_SESSION_IDENTITY_MISMATCH",
            "The registered Worktree does not match this session"
        );
    }

    #handleFrom(base, entry) {
        if (!base || typeof base !== "object" || !entry || typeof entry.path !== "string") {
            fail("WORKTREE_SESSION_OPEN_VERIFY_FAILED", "Worktree session base or registration is invalid");
        }
        const baseSnapshot = Object.freeze({
            repoRoot: base.repoRoot,
            baseRevision: base.baseRevision,
            baseTree: base.baseTree,
            statusSha256: base.statusSha256
        });
        return Object.freeze({
            jobId: this.#jobId,
            workspaceId: this.#jobId,
            repoRoot: base.repoRoot,
            worktreePath: entry.path,
            branch: this.#branch,
            lockReason: this.#lockReason,
            base: baseSnapshot
        });
    }

    #assertOpeningEntry(entry, base, targetPath) {
        if (!this.#isOpeningEntry(entry, base, targetPath)) {
            fail("WORKTREE_SESSION_OPEN_VERIFY_FAILED", "Git Worktree registration did not match the session");
        }
    }

    #enqueue(operation) {
        const queued = this.#operationTail.then(operation, operation);
        this.#operationTail = queued.then(() => undefined, () => undefined);
        return queued;
    }

    async #openOnce() {
        let base;
        try {
            base = await this.#adapter.captureBase(this.#repoRoot);
        } catch (error) {
            this.#state = "failed";
            throw error;
        }

        const targetPath = this.#targetPath();
        try {
            await this.#adapter.inspect(this.#repoRoot, targetPath);
        } catch (error) {
            this.#state = "failed";
            throw error;
        }

        try {
            const addedEntry = await this.#adapter.add({
                base,
                workspaceBaseRoot: this.#workspaceBaseRoot,
                workspaceId: this.#jobId,
                lockReason: this.#lockReason
            });
            this.#assertOpeningEntry(addedEntry, base, targetPath);
            const officialEntry = await this.#adapter.inspect(this.#repoRoot, targetPath);
            this.#assertOpeningEntry(officialEntry, base, targetPath);
            const handle = this.#handleFrom(base, officialEntry);
            this.#handle = handle;
            this.#state = "open";
            return handle;
        } catch (error) {
            this.#state = "failed";
            throw error;
        }
    }

    open() {
        if (this.#discardRequested) {
            return Promise.reject(new WorktreeWriteSessionError(
                "WORKTREE_SESSION_OPEN_NOT_ALLOWED",
                "Worktree write session open is closed by discard"
            ));
        }
        if ((this.#state === "opening" || this.#state === "open" || this.#state === "retained" ||
            (this.#state === "failed" && !this.#handle)) && this.#openPromise) {
            return this.#openPromise;
        }
        if (this.#state !== "new") {
            return Promise.reject(new WorktreeWriteSessionError(
                "WORKTREE_SESSION_OPEN_NOT_ALLOWED",
                "Worktree write session open is only allowed once"
            ));
        }
        this.#state = "opening";
        this.#openPromise = this.#openOnce();
        return this.#openPromise;
    }

    async inspect() {
        if (!this.#handle) {
            fail("WORKTREE_SESSION_HANDLE_UNAVAILABLE", "Worktree write session has no proven Worktree handle");
        }
        const entry = await this.#adapter.inspect(this.#repoRoot, this.#handle.worktreePath);
        return freezeEntry(entry);
    }

    async #verifyOnce() {
        if (!this.#handle || (this.#state !== "open" && this.#state !== "retained")) {
            fail("WORKTREE_SESSION_NOT_OPEN", "Worktree write session is not open");
        }
        const entry = await this.#adapter.inspect(this.#repoRoot, this.#handle.worktreePath);
        if (!this.#isLockedIdentity(entry, this.#handle)) throw this.#identityMismatch();
        await this.#adapter.assertBaseStable(this.#handle.base);
        return this.#handle;
    }

    verify() {
        if (this.#discardRequested) {
            return Promise.reject(new WorktreeWriteSessionError(
                "WORKTREE_SESSION_NOT_OPEN",
                "Worktree write session is closed by discard"
            ));
        }
        if (!this.#handle || (this.#state !== "open" && this.#state !== "retained")) {
            return Promise.reject(new WorktreeWriteSessionError(
                "WORKTREE_SESSION_NOT_OPEN",
                "Worktree write session is not open"
            ));
        }
        return this.#enqueue(() => this.#verifyOnce());
    }

    retain() {
        if (this.#discardRequested) {
            return Promise.reject(new WorktreeWriteSessionError(
                "WORKTREE_SESSION_NOT_OPEN",
                "Worktree write session is closed by discard"
            ));
        }
        if (!this.#handle || (this.#state !== "open" && this.#state !== "retained")) {
            return Promise.reject(new WorktreeWriteSessionError(
                "WORKTREE_SESSION_NOT_OPEN",
                "Worktree write session is not open"
            ));
        }
        return this.#enqueue(async () => {
            const handle = await this.#verifyOnce();
            this.#state = "retained";
            return handle;
        });
    }

    async #discardOnce() {
        const handle = this.#handle;
        try {
            await this.#adapter.discardExpected({
                repoRoot: this.#repoRoot,
                workspaceBaseRoot: this.#workspaceBaseRoot,
                expected: {
                    path: handle.worktreePath,
                    branch: handle.branch,
                    head: handle.base.baseRevision,
                    locked: true,
                    lockReason: handle.lockReason
                }
            });
        } catch (error) {
            if (error?.code === "WORKTREE_EXPECTED_IDENTITY_MISMATCH") {
                throw this.#identityMismatch();
            }
            if (error?.code === "WORKTREE_DISCARD_BLOCKED") {
                throw new WorktreeWriteSessionError(
                    "WORKTREE_SESSION_DISCARD_BLOCKED",
                    "Git Worktree discard was blocked",
                    {
                        cause: safeCauseCode(error.details?.cause),
                        relocked: error.details?.relocked === true
                    }
                );
            }
            if (error?.code === "WORKTREE_REMOVE_VERIFY_FAILED") {
                throw new WorktreeWriteSessionError(
                    "WORKTREE_SESSION_DISCARD_FAILED",
                    "Git Worktree registration remains after discard"
                );
            }
            throw error;
        }
    }

    discard() {
        if (this.#discardPromise) return this.#discardPromise;
        if (this.#state === "discarded") return Promise.resolve();
        if (!this.#handle || (this.#state !== "open" && this.#state !== "retained" && this.#state !== "failed")) {
            return Promise.reject(new WorktreeWriteSessionError(
                "WORKTREE_SESSION_DISCARD_NOT_ALLOWED",
                "Worktree write session cannot be discarded without a proven handle"
            ));
        }

        this.#discardRequested = true;
        const operation = this.#enqueue(() => this.#discardOnce());
        this.#discardPromise = operation.then(
            result => {
                this.#state = "discarded";
                return result;
            },
            error => {
                this.#state = "failed";
                this.#discardRequested = false;
                this.#discardPromise = null;
                throw error;
            }
        );
        return this.#discardPromise;
    }
}

module.exports = {
    WorktreeWriteSession,
    WorktreeWriteSessionError
};
