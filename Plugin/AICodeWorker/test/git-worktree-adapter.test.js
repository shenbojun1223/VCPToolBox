"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, test } = require("node:test");

const {
    GitWorktreeAdapter,
    GitWorktreeError,
    parseWorktreeListPorcelainZ,
    normalizeWorktreeId,
    normalizeLockReason
} = require("../appserver/gitWorktreeAdapter");

const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicodeworker-worktree-adapter-"));
const fixtures = [];
let nextFixture = 1;

function samePath(left, right) {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function git(cwd, args, allowFailure = false) {
    const result = spawnSync("git", args, {
        cwd,
        shell: false,
        windowsHide: true,
        encoding: "buffer",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    });
    if (!allowFailure) {
        assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${String(result.stderr || "")}`);
    }
    return result;
}

function gitText(cwd, args) {
    return String(git(cwd, args).stdout || "").trim();
}

function officialWorktreeEntry(fixture, target) {
    return parseWorktreeListPorcelainZ(git(fixture.repoRoot, ["worktree", "list", "--porcelain", "-z"]).stdout)
        .find(entry => samePath(entry.path, target)) || null;
}

function createFixture() {
    const number = nextFixture++;
    const repoRoot = path.join(suiteRoot, `repo-${number}`);
    const workspaceBaseRoot = path.join(suiteRoot, `workspace base ${number}`);
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(workspaceBaseRoot, { recursive: true });
    git(repoRoot, ["init", "--quiet"]);
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "alpha\nbeta\n", "utf8");
    git(repoRoot, ["add", "--", "."]);
    git(repoRoot, [
        "-c", "user.name=AICW Test", "-c", "user.email=aicw@example.invalid",
        "commit", "--quiet", "-m", "baseline"
    ]);
    const canonicalWorkspaceBaseRoot = fs.realpathSync.native(workspaceBaseRoot);
    const adapter = new GitWorktreeAdapter({ workspaceBaseRoot: canonicalWorkspaceBaseRoot });
    const fixture = {
        repoRoot: fs.realpathSync.native(repoRoot),
        workspaceBaseRoot: canonicalWorkspaceBaseRoot,
        adapter,
        worktrees: new Set()
    };
    fixtures.push(fixture);
    return fixture;
}

function createBareFixture() {
    const bareRoot = path.join(suiteRoot, `bare-${nextFixture++}`);
    fs.mkdirSync(bareRoot, { recursive: true });
    git(bareRoot, ["init", "--bare", "--quiet"]);
    return fs.realpathSync.native(bareRoot);
}

async function rejectsCode(operation, code) {
    await assert.rejects(Promise.resolve().then(operation), error => {
        return error instanceof GitWorktreeError && error.code === code;
    }, `expected ${code}`);
}

test("constructor rejects a Git executable override", () => {
    assert.throws(() => new GitWorktreeAdapter({ gitBin: "alternate" }), error => {
        return error instanceof GitWorktreeError && error.code === "WORKTREE_OPTION_INVALID";
    });
});

test("constructor rejects an explicitly undefined Git executable override", () => {
    assert.throws(() => new GitWorktreeAdapter({ gitBin: undefined }), error => {
        return error instanceof GitWorktreeError && error.code === "WORKTREE_OPTION_INVALID";
    });
});

test("constructor rejects a spawn runner override", () => {
    assert.throws(() => new GitWorktreeAdapter({ _spawnRunner() {} }), error => {
        return error instanceof GitWorktreeError && error.code === "WORKTREE_OPTION_INVALID";
    });
});

test("constructor rejects an explicitly undefined spawn runner override", () => {
    assert.throws(() => new GitWorktreeAdapter({ _spawnRunner: undefined }), error => {
        return error instanceof GitWorktreeError && error.code === "WORKTREE_OPTION_INVALID";
    });
});

async function addWorktree(fixture, id = `workspace-${nextFixture}`, reason = "slice-4a fixture") {
    const base = await fixture.adapter.captureBase(fixture.repoRoot);
    const target = path.join(fixture.workspaceBaseRoot, id);
    const entry = await fixture.adapter.add({
        base,
        workspaceBaseRoot: fixture.workspaceBaseRoot,
        workspaceId: id,
        lockReason: reason
    });
    fixture.worktrees.add(target);
    return { base, target, entry };
}

function trackMove(fixture, oldPath, newPath) {
    fixture.worktrees.delete(oldPath);
    fixture.worktrees.add(newPath);
}

async function cleanupFixture(fixture) {
    let entries = await fixture.adapter.list(fixture.repoRoot);
    for (const entry of entries) {
        if (samePath(entry.path, fixture.repoRoot)) continue;
        if (entry.locked) await fixture.adapter.unlock(fixture.repoRoot, entry.path);
        git(entry.path, ["reset", "--hard", "HEAD"], true);
        git(entry.path, ["clean", "-fd"], true);
        await fixture.adapter.remove(fixture.repoRoot, entry.path, fixture.workspaceBaseRoot);
    }
    entries = await fixture.adapter.list(fixture.repoRoot);
    assert.equal(entries.length, 1, "fixture must have only its primary Worktree after cleanup");
    assert.equal(samePath(entries[0].path, fixture.repoRoot), true);
}

after(async () => {
    let allWorktreesGone = false;
    try {
        for (const fixture of fixtures) await cleanupFixture(fixture);
        allWorktreesGone = true;
    } finally {
        if (allWorktreesGone) fs.rmSync(suiteRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    assert.equal(fs.existsSync(suiteRoot), false, "fixture suite root must be removed after Worktrees are gone");
});
test("normalizers and the NUL parser preserve branch, state, reasons, and spaces", () => {
    const primaryPath = path.join(suiteRoot, "primary path with spaces");
    const detachedPath = path.join(suiteRoot, "detached path with spaces");
    const barePath = path.join(suiteRoot, "bare path");
    const sha = "a".repeat(40);
    const input = [
        `worktree ${primaryPath}\0HEAD ${sha}\0branch refs/heads/vcp/aicw/demo_id\0locked hold for fixture\0prunable stale metadata\0`,
        `worktree ${detachedPath}\0HEAD ${sha}\0detached\0`,
        `worktree ${barePath}\0HEAD ${sha}\0bare\0`
    ].join("");
    const entries = parseWorktreeListPorcelainZ(input);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].path, path.resolve(primaryPath));
    assert.equal(entries[0].branch, "vcp/aicw/demo_id");
    assert.equal(entries[0].locked, true);
    assert.equal(entries[0].lockReason, "hold for fixture");
    assert.equal(entries[0].prunable, true);
    assert.equal(entries[0].pruneReason, "stale metadata");
    assert.equal(entries[1].detached, true);
    assert.equal(entries[2].bare, true);
    assert.equal(normalizeWorktreeId("demo_id-1"), "demo_id-1");
    assert.equal(normalizeLockReason("single line reason"), "single line reason");
    assert.throws(() => normalizeWorktreeId("../escape"), error => error.code === "WORKTREE_WORKSPACE_ID_INVALID");
    assert.throws(() => normalizeLockReason("line\nfeed"), error => error.code === "WORKTREE_LOCK_REASON_INVALID");
});

test("list uses real porcelain NUL output and reports the fixture primary Worktree", async () => {
    const fixture = createFixture();
    const entries = await fixture.adapter.list(fixture.repoRoot);
    assert.equal(entries.length, 1);
    assert.equal(samePath(entries[0].path, fixture.repoRoot), true);
    assert.equal(entries[0].head, gitText(fixture.repoRoot, ["rev-parse", "HEAD"]));
    assert.equal(entries[0].branch, gitText(fixture.repoRoot, ["branch", "--show-current"]));
});

test("captureBase records the clean HEAD, tree, and status hash", async () => {
    const fixture = createFixture();
    const base = await fixture.adapter.captureBase(fixture.repoRoot);
    const status = git(fixture.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
    assert.equal(base.repoRoot, fixture.repoRoot);
    assert.equal(base.baseRevision, gitText(fixture.repoRoot, ["rev-parse", "HEAD"]));
    assert.equal(base.baseTree, gitText(fixture.repoRoot, ["rev-parse", "HEAD^{tree}"]));
    assert.equal(base.statusSha256, crypto.createHash("sha256").update(status).digest("hex"));
    assert.equal(status.length, 0);
});

test("captureBase rejects staged, unstaged, and untracked changes independently", async () => {
    const cases = [
        fixture => {
            fs.appendFileSync(path.join(fixture.repoRoot, "tracked.txt"), "unstaged\n");
        },
        fixture => {
            fs.appendFileSync(path.join(fixture.repoRoot, "tracked.txt"), "staged\n");
            git(fixture.repoRoot, ["add", "--", "tracked.txt"]);
        },
        fixture => {
            fs.writeFileSync(path.join(fixture.repoRoot, "untracked.txt"), "untracked\n", "utf8");
        }
    ];
    for (const mutate of cases) {
        const fixture = createFixture();
        mutate(fixture);
        await rejectsCode(() => fixture.adapter.captureBase(fixture.repoRoot), "WORKTREE_BASE_DIRTY");
    }
});

test("captureBase rejects subdirectories, bare repositories, and linked Worktrees", async () => {
    const fixture = createFixture();
    const subdirectory = path.join(fixture.repoRoot, "subdirectory");
    fs.mkdirSync(subdirectory);
    await rejectsCode(() => fixture.adapter.captureBase(subdirectory), "WORKTREE_REPOSITORY_INVALID");
    const bareRoot = createBareFixture();
    await rejectsCode(() => fixture.adapter.captureBase(bareRoot), "WORKTREE_REPOSITORY_INVALID");
    const linked = await addWorktree(fixture, "linked-input");
    await rejectsCode(() => fixture.adapter.captureBase(linked.target), "WORKTREE_REPOSITORY_INVALID");
});

test("assertBaseStable rejects status and HEAD/tree fingerprint drift", async () => {
    const statusFixture = createFixture();
    const statusBase = await statusFixture.adapter.captureBase(statusFixture.repoRoot);
    fs.appendFileSync(path.join(statusFixture.repoRoot, "tracked.txt"), "status drift\n");
    await rejectsCode(() => statusFixture.adapter.assertBaseStable(statusBase), "WORKTREE_BASE_DRIFT");

    const headFixture = createFixture();
    const headBase = await headFixture.adapter.captureBase(headFixture.repoRoot);
    fs.writeFileSync(path.join(headFixture.repoRoot, "tracked.txt"), "new committed tree\n", "utf8");
    git(headFixture.repoRoot, ["add", "--", "tracked.txt"]);
    git(headFixture.repoRoot, [
        "-c", "user.name=AICW Test", "-c", "user.email=aicw@example.invalid",
        "commit", "--quiet", "-m", "fingerprint-drift"
    ]);
    await rejectsCode(() => headFixture.adapter.assertBaseStable(headBase), "WORKTREE_BASE_DRIFT");
});

test("add creates a locked branch Worktree under a base containing spaces", async () => {
    const fixture = createFixture();
    const base = await fixture.adapter.captureBase(fixture.repoRoot);
    const id = "space_id-1";
    const reason = "held by Slice 4A fixture";
    const beforeHead = gitText(fixture.repoRoot, ["rev-parse", "HEAD"]);
    const beforeStatus = git(fixture.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
    const result = await fixture.adapter.add({ base, workspaceBaseRoot: fixture.workspaceBaseRoot, workspaceId: id, lockReason: reason });
    const target = path.join(fixture.workspaceBaseRoot, id);
    fixture.worktrees.add(target);
    assert.equal(fs.existsSync(target), true);
    assert.equal(result.path, path.resolve(target));
    assert.equal(result.head, base.baseRevision);
    assert.equal(result.branch, `vcp/aicw/${id}`);
    assert.equal(result.locked, true);
    assert.equal(result.lockReason, reason);
    assert.equal(gitText(fixture.repoRoot, ["rev-parse", "HEAD"]), beforeHead);
    assert.equal(git(fixture.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.equals(beforeStatus), true);
    assert.deepEqual(await fixture.adapter.inspect(fixture.repoRoot, target), result);
});

test("unlock then lock updates the official registration and reason", async () => {
    const fixture = createFixture();
    const created = await addWorktree(fixture, "lock-cycle", "initial reason");
    const unlocked = await fixture.adapter.unlock(fixture.repoRoot, created.target);
    assert.equal(unlocked.locked, false);
    assert.equal(unlocked.lockReason, null);
    const relocked = await fixture.adapter.lock(fixture.repoRoot, created.target, "new reason");
    assert.equal(relocked.locked, true);
    assert.equal(relocked.lockReason, "new reason");
});

test("lock and unlock reject an externally registered Worktree without changing its lock state", async () => {
    const fixture = createFixture();
    const externalPath = path.join(suiteRoot, `external-worktree-${nextFixture++}`);
    const initialReason = "external fixture hold";
    const branch = `vcp/aicw/external-${nextFixture++}`;
    let externallyRegistered = false;
    try {
        git(fixture.repoRoot, [
            "worktree", "add", "--quiet", "--lock", "--reason", initialReason,
            "-b", branch, externalPath, "HEAD"
        ]);
        externallyRegistered = true;
        const canonicalExternalPath = fs.realpathSync.native(externalPath);
        const beforeLock = officialWorktreeEntry(fixture, canonicalExternalPath);
        assert.ok(beforeLock);
        assert.deepEqual({ locked: beforeLock.locked, lockReason: beforeLock.lockReason }, {
            locked: true, lockReason: initialReason
        });
        await rejectsCode(() => fixture.adapter.lock(fixture.repoRoot, canonicalExternalPath, "must not change"), "WORKTREE_PATH_OUTSIDE_BASE");
        const afterLock = officialWorktreeEntry(fixture, canonicalExternalPath);
        assert.deepEqual({ locked: afterLock.locked, lockReason: afterLock.lockReason }, {
            locked: beforeLock.locked, lockReason: beforeLock.lockReason
        });

        const beforeUnlock = officialWorktreeEntry(fixture, canonicalExternalPath);
        await rejectsCode(() => fixture.adapter.unlock(fixture.repoRoot, canonicalExternalPath), "WORKTREE_PATH_OUTSIDE_BASE");
        const afterUnlock = officialWorktreeEntry(fixture, canonicalExternalPath);
        assert.deepEqual({ locked: afterUnlock.locked, lockReason: afterUnlock.lockReason }, {
            locked: beforeUnlock.locked, lockReason: beforeUnlock.lockReason
        });
    } finally {
        if (externallyRegistered) {
            const canonicalExternalPath = fs.realpathSync.native(externalPath);
            git(fixture.repoRoot, ["worktree", "unlock", canonicalExternalPath], true);
            git(fixture.repoRoot, ["worktree", "remove", canonicalExternalPath], true);
        }
    }
});

test("move uses the official command and replaces the registered path", async () => {
    const fixture = createFixture();
    const created = await addWorktree(fixture, "move-old");
    await fixture.adapter.unlock(fixture.repoRoot, created.target);
    const newPath = path.join(fixture.workspaceBaseRoot, "move-new");
    const moved = await fixture.adapter.move(fixture.repoRoot, created.target, newPath, fixture.workspaceBaseRoot);
    trackMove(fixture, created.target, newPath);
    assert.equal(fs.existsSync(created.target), false);
    assert.equal(fs.existsSync(newPath), true);
    assert.equal(await fixture.adapter.inspect(fixture.repoRoot, created.target), null);
    assert.equal(samePath(moved.path, newPath), true);
});

test("remove unlocks clean Worktrees only through the official remove command", async () => {
    const fixture = createFixture();
    const created = await addWorktree(fixture, "clean-remove");
    await fixture.adapter.unlock(fixture.repoRoot, created.target);
    const removed = await fixture.adapter.remove(fixture.repoRoot, created.target, fixture.workspaceBaseRoot);
    assert.deepEqual(removed, { path: path.resolve(created.target), removed: true });
    assert.equal(fs.existsSync(created.target), false);
    assert.equal((await fixture.adapter.list(fixture.repoRoot)).length, 1);
});

test("remove rejects a dirty Worktree, preserves it, then succeeds after it is clean", async () => {
    const fixture = createFixture();
    const created = await addWorktree(fixture, "dirty-remove");
    await fixture.adapter.unlock(fixture.repoRoot, created.target);
    fs.appendFileSync(path.join(created.target, "tracked.txt"), "dirty fixture\n");
    await rejectsCode(() => fixture.adapter.remove(fixture.repoRoot, created.target, fixture.workspaceBaseRoot), "WORKTREE_REMOVE_FAILED");
    assert.equal(fs.existsSync(created.target), true);
    assert.notEqual(await fixture.adapter.inspect(fixture.repoRoot, created.target), null);
    git(created.target, ["reset", "--hard", "HEAD"]);
    await fixture.adapter.remove(fixture.repoRoot, created.target, fixture.workspaceBaseRoot);
    assert.equal(fs.existsSync(created.target), false);
});

test("repair restores a registration after a fixture-only manual directory move", async () => {
    const fixture = createFixture();
    const created = await addWorktree(fixture, "repair-old");
    await fixture.adapter.unlock(fixture.repoRoot, created.target);
    const repairedPath = path.join(fixture.workspaceBaseRoot, "repair-new");
    fs.renameSync(created.target, repairedPath);
    trackMove(fixture, created.target, repairedPath);
    const repairResult = await fixture.adapter.repair(fixture.repoRoot, [repairedPath], fixture.workspaceBaseRoot);
    assert.deepEqual(repairResult.paths, [path.resolve(repairedPath)]);
    assert.equal(fs.existsSync(repairedPath), true);
    assert.equal(await fixture.adapter.inspect(fixture.repoRoot, created.target), null);
    assert.equal(samePath((await fixture.adapter.inspect(fixture.repoRoot, repairedPath)).path, repairedPath), true);
});

test("repair with empty paths verifies the primary Worktree registration", async () => {
    const fixture = createFixture();
    const result = await fixture.adapter.repair(fixture.repoRoot, []);
    assert.deepEqual(result.paths, []);
    const primary = officialWorktreeEntry(fixture, fixture.repoRoot);
    assert.ok(primary);
    assert.equal(primary.bare, false);
});

test("repair rejects a trusted ordinary directory when Git does not register it", async () => {
    const fixture = createFixture();
    const ordinary = path.join(fixture.workspaceBaseRoot, "ordinary-directory");
    fs.mkdirSync(ordinary);

    let caught = null;
    try {
        await fixture.adapter.repair(fixture.repoRoot, [ordinary], fixture.workspaceBaseRoot);
    } catch (error) {
        caught = error;
    }
    assert.ok(caught instanceof GitWorktreeError);
    assert.equal(officialWorktreeEntry(fixture, ordinary), null);
    if (caught.code === "WORKTREE_REPAIR_FAILED") {
        assert.notEqual(caught.details?.exitCode, 0);
    } else {
        assert.equal(caught.code, "WORKTREE_REPAIR_VERIFY_FAILED");
    }
});

test("prune defaults to dry-run and cannot remove a healthy Worktree", async () => {
    const fixture = createFixture();
    const created = await addWorktree(fixture, "prune-healthy");
    const before = await fixture.adapter.list(fixture.repoRoot);
    const result = await fixture.adapter.prune(fixture.repoRoot);
    assert.equal(result.dryRun, true);
    assert.equal(result.expire, null);
    assert.equal((await fixture.adapter.list(fixture.repoRoot)).length, before.length);
    await rejectsCode(() => fixture.adapter.prune(fixture.repoRoot, { dryRun: false }), "WORKTREE_DESTRUCTIVE_PRUNE_DISABLED");
    const withExpire = await fixture.adapter.prune(fixture.repoRoot, { expire: "now" });
    assert.equal(withExpire.dryRun, true);
    assert.equal(fs.existsSync(created.target), true);
});

test("rejects absolute-path, base, identifier, reason, target, and revision violations", async () => {
    const fixture = createFixture();
    const base = await fixture.adapter.captureBase(fixture.repoRoot);
    await rejectsCode(() => fixture.adapter.lock(fixture.repoRoot, "relative/path", "reason"), "WORKTREE_PATH_INVALID");
    await rejectsCode(() => fixture.adapter.add({
        base, workspaceBaseRoot: fixture.workspaceBaseRoot, workspaceId: "../escape", lockReason: "reason"
    }), "WORKTREE_WORKSPACE_ID_INVALID");
    await rejectsCode(() => fixture.adapter.add({
        base, workspaceBaseRoot: fixture.workspaceBaseRoot, workspaceId: "newline", lockReason: "bad\nreason"
    }), "WORKTREE_LOCK_REASON_INVALID");
    await rejectsCode(() => fixture.adapter.add({
        base, workspaceBaseRoot: fixture.workspaceBaseRoot, workspaceId: "nul", lockReason: "bad\0reason"
    }), "WORKTREE_LOCK_REASON_INVALID");
    await rejectsCode(() => fixture.adapter.assertBaseStable({ ...base, baseRevision: "abc" }), "WORKTREE_BASE_REVISION_INVALID");
    await rejectsCode(() => fixture.adapter.assertBaseStable({ ...base, baseRevision: "a".repeat(41) }), "WORKTREE_BASE_REVISION_INVALID");
    const existing = path.join(fixture.workspaceBaseRoot, "already-there");
    fs.mkdirSync(existing);
    await rejectsCode(() => fixture.adapter.add({
        base, workspaceBaseRoot: fixture.workspaceBaseRoot, workspaceId: "already-there", lockReason: "reason"
    }), "WORKTREE_TARGET_EXISTS");
    const outside = path.join(suiteRoot, `outside-${nextFixture++}`);
    fs.mkdirSync(outside);
    const created = await addWorktree(fixture, "scope-check");
    await rejectsCode(() => fixture.adapter.move(fixture.repoRoot, created.target, outside, fixture.workspaceBaseRoot), "WORKTREE_PATH_OUTSIDE_BASE");
    const traversal = `${fixture.workspaceBaseRoot}${path.sep}..${path.sep}escape-target`;
    await rejectsCode(() => fixture.adapter.move(fixture.repoRoot, created.target, traversal, fixture.workspaceBaseRoot), "WORKTREE_PATH_INVALID");
    const unpinnedAdapter = new GitWorktreeAdapter();
    await rejectsCode(() => unpinnedAdapter.repair(fixture.repoRoot, [created.target]), "WORKTREE_PATH_INVALID");
});

test("rejects symlink or junction aliases when the platform permits creating one", async t => {
    const fixture = createFixture();
    const alias = path.join(suiteRoot, `workspace-alias-${nextFixture++}`);
    try {
        fs.symlinkSync(fixture.workspaceBaseRoot, alias, "junction");
    } catch (error) {
        if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
            t.diagnostic(`junction creation unavailable: ${error.code}`);
            return;
        }
        throw error;
    }
    const base = await fixture.adapter.captureBase(fixture.repoRoot);
    await rejectsCode(() => fixture.adapter.add({
        base, workspaceBaseRoot: alias, workspaceId: "alias", lockReason: "reason"
    }), "WORKTREE_PATH_INVALID");
});

test("production adapter source keeps Git execution fixed and passes static safety guards", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../appserver/gitWorktreeAdapter.js"), "utf8").toLowerCase();
    for (const forbidden of [
        "--force", "shell: true", "fs.rm", "rmsync", "unlinksync", "rmdirsync", "renamesync",
        "copyfile", "copysync", "cpsync", "manifest", "wal", "perforce", "path lease", "commit", "merge", "push", "cherry-pick",
        "fallback", "this.#gitbin", "this.#spawnrunner", "options.gitbin", "options._spawnrunner", "options.args",
        "node_env", "module.exports.symbol", "symbol.for", "global."
    ]) {
        assert.equal(source.includes(forbidden), false, `adapter source contains ${forbidden}`);
    }
    assert.equal(source.includes("#gitbin"), false);
    assert.equal(source.includes("#spawnrunner"), false);
    assert.equal(source.includes('gitbin: "git"'), true);
    assert.equal(source.includes("const result = await runboundedgit(request);"), true);
    assert.equal(source.includes("object.freeze({"), true);
    assert.equal(source.includes("args: object.freeze([...args])"), true);
    assert.equal(source.includes("shell: false"), true);
    assert.equal(source.includes("git_terminal_prompt"), true);
    assert.equal(source.includes("--dry-run"), true);
    assert.equal(source.includes("dryrun !== true"), true);
    assert.equal(source.includes('["worktree", "prune", "--dry-run"'), true);
});
