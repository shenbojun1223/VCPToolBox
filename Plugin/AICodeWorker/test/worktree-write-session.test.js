"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, test } = require("node:test");

const {
    GitWorktreeAdapter,
    GitWorktreeError,
    parseWorktreeListPorcelainZ
} = require("../appserver/gitWorktreeAdapter");
const {
    WorktreeWriteSession,
    WorktreeWriteSessionError
} = require("../appserver/worktreeWriteSession");

const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicodeworker-worktree-session-"));
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

function officialEntries(fixture) {
    return parseWorktreeListPorcelainZ(
        git(fixture.repoRoot, ["worktree", "list", "--porcelain", "-z"]).stdout
    );
}

function officialEntry(fixture, target) {
    return officialEntries(fixture).find(entry => samePath(entry.path, target)) || null;
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
    const fixture = {
        number,
        repoRoot: fs.realpathSync.native(repoRoot),
        workspaceBaseRoot: fs.realpathSync.native(workspaceBaseRoot)
    };
    fixture.adapter = new GitWorktreeAdapter({ workspaceBaseRoot: fixture.workspaceBaseRoot });
    fixtures.push(fixture);
    return fixture;
}

function makeSession(fixture, jobId = `job-${fixture.number}`) {
    return new WorktreeWriteSession({
        adapter: fixture.adapter,
        jobId,
        repoRoot: fixture.repoRoot,
        workspaceBaseRoot: fixture.workspaceBaseRoot
    });
}

function expectedReason(jobId) {
    return `AICodeWorker write session ${jobId}`;
}

function expectedBranch(jobId) {
    return `vcp/aicw/${jobId}`;
}

function expectedTarget(fixture, jobId) {
    return path.join(fixture.workspaceBaseRoot, jobId);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function rejectsCode(operation, code) {
    await assert.rejects(Promise.resolve().then(operation), error => {
        return error?.code === code;
    }, `expected ${code}`);
}

function assertPrimaryClean(fixture) {
    assert.equal(git(fixture.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.length, 0);
}

function assertWithin(root, target) {
    const relative = path.relative(root, target);
    assert.notEqual(relative, "");
    assert.notEqual(relative, "..");
    assert.equal(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), false);
}

async function cleanupFixture(fixture) {
    let entries = await fixture.adapter.list(fixture.repoRoot);
    for (const entry of entries) {
        if (samePath(entry.path, fixture.repoRoot)) continue;
        assertWithin(fixture.workspaceBaseRoot, entry.path);
        assert.deepEqual(officialEntry(fixture, entry.path), entry,
            "cleanup requires the direct Git registration to match Adapter observation");
        if (entry.locked) await fixture.adapter.unlock(fixture.repoRoot, entry.path);
        git(entry.path, ["reset", "--hard", "HEAD"]);
        git(entry.path, ["clean", "-fd"]);
        await fixture.adapter.remove(fixture.repoRoot, entry.path, fixture.workspaceBaseRoot);
    }
    git(fixture.repoRoot, ["reset", "--hard", "HEAD"]);
    git(fixture.repoRoot, ["clean", "-fd"]);
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
        if (allWorktreesGone) fs.rmSync(suiteRoot, { recursive: true, force: false });
    }
    assert.equal(fs.existsSync(suiteRoot), false, "fixture suite root must be removed after cleanup");
});

test("constructor rejects duck-typed adapters and non-absolute roots", () => {
    const fixture = createFixture();
    assert.throws(() => new WorktreeWriteSession({
        adapter: { captureBase() {}, add() {}, inspect() {} },
        jobId: "duck",
        repoRoot: fixture.repoRoot,
        workspaceBaseRoot: fixture.workspaceBaseRoot
    }), error => error instanceof WorktreeWriteSessionError && error.code === "WORKTREE_SESSION_ADAPTER_INVALID");
    assert.throws(() => new WorktreeWriteSession({
        adapter: fixture.adapter,
        jobId: "relative-root",
        repoRoot: ".",
        workspaceBaseRoot: fixture.workspaceBaseRoot
    }), error => error instanceof WorktreeWriteSessionError && error.code === "WORKTREE_SESSION_PATH_INVALID");
    assert.throws(() => new WorktreeWriteSession({
        adapter: fixture.adapter,
        jobId: "../unsafe",
        repoRoot: fixture.repoRoot,
        workspaceBaseRoot: fixture.workspaceBaseRoot
    }), error => error instanceof GitWorktreeError && error.code === "WORKTREE_WORKSPACE_ID_INVALID");
});

test("constructor rejects unpinned, mismatched, and non-canonical workspace roots before add", async t => {
    const fixture = createFixture();
    const otherRoot = path.join(suiteRoot, `constructor-root-${fixture.number}`);
    fs.mkdirSync(otherRoot);
    const canonicalOtherRoot = fs.realpathSync.native(otherRoot);
    const before = officialEntries(fixture);
    const cases = [
        [new GitWorktreeAdapter(), fixture.workspaceBaseRoot, "WORKTREE_WORKSPACE_ROOT_UNPINNED"],
        [new GitWorktreeAdapter({ workspaceBaseRoot: canonicalOtherRoot }), fixture.workspaceBaseRoot,
            "WORKTREE_WORKSPACE_ROOT_MISMATCH"]
    ];

    for (const [adapter, workspaceBaseRoot, code] of cases) {
        const originalAdd = adapter.add.bind(adapter);
        let addCalls = 0;
        adapter.add = (...args) => {
            addCalls += 1;
            return originalAdd(...args);
        };
        assert.throws(() => new WorktreeWriteSession({
            adapter,
            jobId: `root-guard-${code.toLowerCase()}`,
            repoRoot: fixture.repoRoot,
            workspaceBaseRoot
        }), error => error instanceof GitWorktreeError && error.code === code);
        assert.equal(addCalls, 0);
    }

    const alias = path.join(suiteRoot, `constructor-alias-${fixture.number}`);
    try {
        fs.symlinkSync(fixture.workspaceBaseRoot, alias, "junction");
    } catch (error) {
        if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
            t.diagnostic(`junction creation unavailable: ${error.code}`);
            assert.deepEqual(officialEntries(fixture), before);
            return;
        }
        throw error;
    }
    const originalAdd = fixture.adapter.add.bind(fixture.adapter);
    let aliasAddCalls = 0;
    fixture.adapter.add = (...args) => {
        aliasAddCalls += 1;
        return originalAdd(...args);
    };
    assert.throws(() => new WorktreeWriteSession({
        adapter: fixture.adapter,
        jobId: `root-alias-${fixture.number}`,
        repoRoot: fixture.repoRoot,
        workspaceBaseRoot: alias
    }), error => error instanceof GitWorktreeError && error.code === "WORKTREE_PATH_INVALID");
    assert.equal(aliasAddCalls, 0);
    assert.deepEqual(officialEntries(fixture), before);
});

test("clean open binds the job, base, branch, path, and lock without changing primary state", async () => {
    const fixture = createFixture();
    const jobId = `clean-${fixture.number}`;
    const beforeHead = gitText(fixture.repoRoot, ["rev-parse", "HEAD"]);
    const beforeStatus = git(fixture.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
    const session = makeSession(fixture, jobId);
    const handle = await session.open();
    const entry = officialEntry(fixture, handle.worktreePath);

    assert.deepEqual(Object.keys(handle).sort(), [
        "base", "branch", "jobId", "lockReason", "repoRoot", "workspaceId", "worktreePath"
    ]);
    assert.equal(handle.jobId, jobId);
    assert.equal(handle.workspaceId, jobId);
    assert.equal(handle.repoRoot, fixture.repoRoot);
    assert.equal(handle.branch, expectedBranch(jobId));
    assert.equal(handle.lockReason, expectedReason(jobId));
    assertWithin(fixture.workspaceBaseRoot, handle.worktreePath);
    assert.equal(gitText(handle.worktreePath, ["rev-parse", "HEAD"]), handle.base.baseRevision);
    assert.equal(entry.path, path.resolve(handle.worktreePath));
    assert.equal(entry.branch, expectedBranch(jobId));
    assert.equal(entry.head, handle.base.baseRevision);
    assert.equal(entry.locked, true);
    assert.equal(entry.lockReason, expectedReason(jobId));
    assert.equal(gitText(fixture.repoRoot, ["rev-parse", "HEAD"]), beforeHead);
    assert.equal(git(fixture.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.equals(beforeStatus), true);
});

test("open handle and base are deeply frozen and repeated open returns the same handle", async () => {
    const fixture = createFixture();
    const session = makeSession(fixture, `frozen-${fixture.number}`);
    const handle = await session.open();
    assert.equal(Object.isFrozen(handle), true);
    assert.equal(Object.isFrozen(handle.base), true);
    assert.throws(() => { handle.jobId = "changed"; }, TypeError);
    assert.throws(() => { handle.base.baseRevision = "changed"; }, TypeError);
    assert.equal(await session.open(), handle);
    assert.equal((await fixture.adapter.list(fixture.repoRoot)).length, 2);
});

test("concurrent open calls share one Promise and create one registered Worktree", async () => {
    const fixture = createFixture();
    const session = makeSession(fixture, `concurrent-${fixture.number}`);
    const first = session.open();
    const calls = [first, ...Array.from({ length: 7 }, () => session.open())];
    for (const call of calls) assert.strictEqual(call, first);
    const handles = await Promise.all(calls);
    for (const handle of handles) assert.strictEqual(handle, handles[0]);
    assert.equal((await fixture.adapter.list(fixture.repoRoot)).length, 2);
    assert.equal(officialEntries(fixture).filter(entry => entry.branch === handles[0].branch).length, 1);
});

test("independent same-job sessions race after both observe no registration and only the winner owns a handle", async () => {
    const fixture = createFixture();
    const jobId = `same-job-${fixture.number}`;
    const target = expectedTarget(fixture, jobId);
    const adapters = [
        fixture.adapter,
        new GitWorktreeAdapter({ workspaceBaseRoot: fixture.workspaceBaseRoot })
    ];
    const bothObserved = deferred();
    let observations = 0;
    for (const adapter of adapters) {
        const originalInspect = adapter.inspect.bind(adapter);
        let firstTargetInspect = true;
        adapter.inspect = async (...args) => {
            const entry = await originalInspect(...args);
            if (firstTargetInspect && samePath(args[1], target)) {
                firstTargetInspect = false;
                assert.equal(entry, null);
                observations += 1;
                if (observations === adapters.length) bothObserved.resolve();
                await bothObserved.promise;
            }
            return entry;
        };
    }
    const sessions = adapters.map(adapter => new WorktreeWriteSession({
        adapter,
        jobId,
        repoRoot: fixture.repoRoot,
        workspaceBaseRoot: fixture.workspaceBaseRoot
    }));

    const results = await Promise.allSettled(sessions.map(session => session.open()));
    const winnerIndex = results.findIndex(result => result.status === "fulfilled");
    const loserIndex = results.findIndex(result => result.status === "rejected");
    assert.notEqual(winnerIndex, -1);
    assert.notEqual(loserIndex, -1);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.ok(["WORKTREE_TARGET_EXISTS", "WORKTREE_ADD_FAILED"].includes(results[loserIndex].reason?.code));
    const winnerHandle = results[winnerIndex].value;
    const beforeLoserCalls = officialEntry(fixture, winnerHandle.worktreePath);
    assert.ok(beforeLoserCalls);
    assert.equal(beforeLoserCalls.lockReason, expectedReason(jobId));

    await rejectsCode(() => sessions[loserIndex].inspect(), "WORKTREE_SESSION_HANDLE_UNAVAILABLE");
    await rejectsCode(() => sessions[loserIndex].discard(), "WORKTREE_SESSION_DISCARD_NOT_ALLOWED");
    assert.deepEqual(officialEntry(fixture, winnerHandle.worktreePath), beforeLoserCalls);
    await sessions[winnerIndex].discard();
    assert.equal(officialEntry(fixture, winnerHandle.worktreePath), null);
});

test("dirty primary bases reject staged, unstaged, and untracked changes before registration", async () => {
    const cases = [
        ["unstaged", fixture => fs.appendFileSync(path.join(fixture.repoRoot, "tracked.txt"), "unstaged\n")],
        ["staged", fixture => {
            fs.appendFileSync(path.join(fixture.repoRoot, "tracked.txt"), "staged\n");
            git(fixture.repoRoot, ["add", "--", "tracked.txt"]);
        }],
        ["untracked", fixture => fs.writeFileSync(path.join(fixture.repoRoot, "untracked.txt"), "untracked\n", "utf8")]
    ];
    for (const [kind, mutate] of cases) {
        const fixture = createFixture();
        const jobId = `dirty-${kind}-${fixture.number}`;
        mutate(fixture);
        await rejectsCode(() => makeSession(fixture, jobId).open(), "WORKTREE_BASE_DIRTY");
        assert.equal(officialEntries(fixture).length, 1);
        assert.equal(fs.existsSync(expectedTarget(fixture, jobId)), false);
    }
});

test("an existing target directory is preserved and never becomes a registration", async () => {
    const fixture = createFixture();
    const jobId = `existing-target-${fixture.number}`;
    const target = expectedTarget(fixture, jobId);
    fs.mkdirSync(target, { recursive: true });
    const marker = path.join(target, "keep.txt");
    fs.writeFileSync(marker, "keep me\n", "utf8");
    await rejectsCode(() => makeSession(fixture, jobId).open(), "WORKTREE_TARGET_EXISTS");
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.readFileSync(marker, "utf8"), "keep me\n");
    assert.equal(officialEntries(fixture).length, 1);
});

test("an existing candidate branch rejects open without changing the branch or target", async () => {
    const fixture = createFixture();
    const jobId = `existing-branch-${fixture.number}`;
    const branch = expectedBranch(jobId);
    const baseRevision = gitText(fixture.repoRoot, ["rev-parse", "HEAD"]);
    git(fixture.repoRoot, ["branch", branch]);
    await rejectsCode(() => makeSession(fixture, jobId).open(), "WORKTREE_ADD_FAILED");
    assert.equal(gitText(fixture.repoRoot, ["rev-parse", branch]), baseRevision);
    assert.equal(fs.existsSync(expectedTarget(fixture, jobId)), false);
    assert.equal(officialEntries(fixture).length, 1);
});

test("inspect and verify return the frozen official snapshot and original handle", async () => {
    const fixture = createFixture();
    const session = makeSession(fixture, `inspect-${fixture.number}`);
    await rejectsCode(() => session.inspect(), "WORKTREE_SESSION_HANDLE_UNAVAILABLE");
    const handle = await session.open();
    const snapshot = await session.inspect();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.deepEqual(snapshot, officialEntry(fixture, handle.worktreePath));
    assert.strictEqual(await session.verify(), handle);
});

test("base drift rejects verify and retain but still permits explicit discard", async () => {
    const fixture = createFixture();
    const jobId = `drift-${fixture.number}`;
    const session = makeSession(fixture, jobId);
    const handle = await session.open();
    fs.writeFileSync(path.join(fixture.repoRoot, "tracked.txt"), "drifted primary\n", "utf8");
    git(fixture.repoRoot, ["add", "--", "tracked.txt"]);
    git(fixture.repoRoot, [
        "-c", "user.name=AICW Test", "-c", "user.email=aicw@example.invalid",
        "commit", "--quiet", "-m", "base-drift"
    ]);
    await rejectsCode(() => session.verify(), "WORKTREE_BASE_DRIFT");
    await rejectsCode(() => session.retain(), "WORKTREE_BASE_DRIFT");
    const held = officialEntry(fixture, handle.worktreePath);
    assert.equal(held.locked, true);
    assert.equal(held.lockReason, expectedReason(jobId));
    await session.discard();
    assert.equal(officialEntries(fixture).length, 1);
    assert.equal(gitText(fixture.repoRoot, ["rev-parse", expectedBranch(jobId)]), handle.base.baseRevision);
});

test("Worktree HEAD advance or reset rejects verify, retain, and discard while the primary stays unchanged", async () => {
    const cases = [
        {
            name: "advanced",
            prepare() {},
            mutate(handle) {
                fs.appendFileSync(path.join(handle.worktreePath, "tracked.txt"), "candidate advance\n");
                git(handle.worktreePath, ["add", "--", "tracked.txt"]);
                git(handle.worktreePath, [
                    "-c", "user.name=AICW Test", "-c", "user.email=aicw@example.invalid",
                    "commit", "--quiet", "-m", "candidate-advance"
                ]);
            }
        },
        {
            name: "reset",
            prepare(fixture) {
                fs.appendFileSync(path.join(fixture.repoRoot, "tracked.txt"), "second base\n");
                git(fixture.repoRoot, ["add", "--", "tracked.txt"]);
                git(fixture.repoRoot, [
                    "-c", "user.name=AICW Test", "-c", "user.email=aicw@example.invalid",
                    "commit", "--quiet", "-m", "second-base"
                ]);
            },
            mutate(handle) {
                git(handle.worktreePath, ["reset", "--hard", "HEAD^"]);
            }
        }
    ];

    for (const scenario of cases) {
        const fixture = createFixture();
        scenario.prepare(fixture);
        const jobId = `head-${scenario.name}-${fixture.number}`;
        const primaryHead = gitText(fixture.repoRoot, ["rev-parse", "HEAD"]);
        const primaryStatus = git(fixture.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
        const session = makeSession(fixture, jobId);
        const handle = await session.open();
        scenario.mutate(handle);
        const changed = officialEntry(fixture, handle.worktreePath);
        assert.ok(changed);
        assert.notEqual(changed.head, handle.base.baseRevision);

        await rejectsCode(() => session.verify(), "WORKTREE_SESSION_IDENTITY_MISMATCH");
        await rejectsCode(() => session.retain(), "WORKTREE_SESSION_IDENTITY_MISMATCH");
        await rejectsCode(() => session.discard(), "WORKTREE_SESSION_IDENTITY_MISMATCH");
        assert.deepEqual(officialEntry(fixture, handle.worktreePath), changed);
        assert.equal(gitText(fixture.repoRoot, ["rev-parse", "HEAD"]), primaryHead);
        assert.equal(git(fixture.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.equals(primaryStatus), true);

        git(handle.worktreePath, ["reset", "--hard", handle.base.baseRevision]);
        const restored = officialEntry(fixture, handle.worktreePath);
        assert.equal(restored.head, handle.base.baseRevision);
        assert.equal(restored.branch, handle.branch);
        assert.equal(restored.locked, true);
        assert.equal(restored.lockReason, handle.lockReason);
        const parentAdapter = new GitWorktreeAdapter({ workspaceBaseRoot: fixture.workspaceBaseRoot });
        await parentAdapter.discardExpected({
            repoRoot: fixture.repoRoot,
            workspaceBaseRoot: fixture.workspaceBaseRoot,
            expected: {
                path: restored.path,
                head: restored.head,
                branch: restored.branch,
                locked: true,
                lockReason: restored.lockReason
            }
        });
        assert.equal(officialEntry(fixture, handle.worktreePath), null);
    }
});

test("external unlock causes identity mismatch and is not removed until restored", async () => {
    const fixture = createFixture();
    const jobId = `external-unlock-${fixture.number}`;
    const session = makeSession(fixture, jobId);
    const handle = await session.open();
    await fixture.adapter.unlock(fixture.repoRoot, handle.worktreePath);
    await rejectsCode(() => session.verify(), "WORKTREE_SESSION_IDENTITY_MISMATCH");
    await rejectsCode(() => session.retain(), "WORKTREE_SESSION_IDENTITY_MISMATCH");
    await rejectsCode(() => session.discard(), "WORKTREE_SESSION_IDENTITY_MISMATCH");
    const unlocked = officialEntry(fixture, handle.worktreePath);
    assert.equal(unlocked.locked, false);
    assert.equal(officialEntries(fixture).length, 2);
    await fixture.adapter.lock(fixture.repoRoot, handle.worktreePath, handle.lockReason);
    await session.discard();
    assert.equal(officialEntries(fixture).length, 1);
});

test("external lock reason change causes identity mismatch and preserves registration", async () => {
    const fixture = createFixture();
    const jobId = `external-reason-${fixture.number}`;
    const session = makeSession(fixture, jobId);
    const handle = await session.open();
    await fixture.adapter.unlock(fixture.repoRoot, handle.worktreePath);
    await fixture.adapter.lock(fixture.repoRoot, handle.worktreePath, "foreign reason");
    await rejectsCode(() => session.verify(), "WORKTREE_SESSION_IDENTITY_MISMATCH");
    await rejectsCode(() => session.retain(), "WORKTREE_SESSION_IDENTITY_MISMATCH");
    await rejectsCode(() => session.discard(), "WORKTREE_SESSION_IDENTITY_MISMATCH");
    const foreign = officialEntry(fixture, handle.worktreePath);
    assert.equal(foreign.locked, true);
    assert.equal(foreign.lockReason, "foreign reason");
    assert.equal(officialEntries(fixture).length, 2);
    await fixture.adapter.unlock(fixture.repoRoot, handle.worktreePath);
    await fixture.adapter.lock(fixture.repoRoot, handle.worktreePath, handle.lockReason);
    await session.discard();
    assert.equal(officialEntries(fixture).length, 1);
});

test("retain is idempotent and leaves Worktree files and official registration unchanged", async () => {
    const fixture = createFixture();
    const session = makeSession(fixture, `retain-${fixture.number}`);
    const handle = await session.open();
    fs.appendFileSync(path.join(handle.worktreePath, "tracked.txt"), "retained edit\n");
    const beforeText = fs.readFileSync(path.join(handle.worktreePath, "tracked.txt"), "utf8");
    const beforeEntry = officialEntry(fixture, handle.worktreePath);
    assert.strictEqual(await session.retain(), handle);
    assert.strictEqual(await session.retain(), handle);
    assert.equal(fs.readFileSync(path.join(handle.worktreePath, "tracked.txt"), "utf8"), beforeText);
    assert.deepEqual(officialEntry(fixture, handle.worktreePath), beforeEntry);
});

test("retain requested before discard completes first and the final state is discarded", async () => {
    const fixture = createFixture();
    const session = makeSession(fixture, `retain-before-discard-${fixture.number}`);
    const handle = await session.open();
    const enteredInspect = deferred();
    const releaseInspect = deferred();
    const originalInspect = fixture.adapter.inspect.bind(fixture.adapter);
    let holdNextInspect = true;
    fixture.adapter.inspect = async (...args) => {
        if (holdNextInspect) {
            holdNextInspect = false;
            enteredInspect.resolve();
            await releaseInspect.promise;
        }
        return originalInspect(...args);
    };

    const retainPromise = session.retain();
    await enteredInspect.promise;
    const discardPromise = session.discard();
    releaseInspect.resolve();
    assert.strictEqual(await retainPromise, handle);
    await discardPromise;
    assert.equal(officialEntry(fixture, handle.worktreePath), null);
    await rejectsCode(() => session.retain(), "WORKTREE_SESSION_NOT_OPEN");
    await rejectsCode(() => session.verify(), "WORKTREE_SESSION_NOT_OPEN");
});

test("discard requested first closes open, retain, and verify while repeated discard shares one Promise", async () => {
    const fixture = createFixture();
    const session = makeSession(fixture, `discard-first-${fixture.number}`);
    const handle = await session.open();
    const enteredDiscard = deferred();
    const releaseDiscard = deferred();
    const originalDiscardExpected = fixture.adapter.discardExpected.bind(fixture.adapter);
    fixture.adapter.discardExpected = async (...args) => {
        enteredDiscard.resolve();
        await releaseDiscard.promise;
        return originalDiscardExpected(...args);
    };

    const discardPromise = session.discard();
    assert.strictEqual(session.discard(), discardPromise);
    await enteredDiscard.promise;
    await rejectsCode(() => session.retain(), "WORKTREE_SESSION_NOT_OPEN");
    await rejectsCode(() => session.verify(), "WORKTREE_SESSION_NOT_OPEN");
    await rejectsCode(() => session.open(), "WORKTREE_SESSION_OPEN_NOT_ALLOWED");
    assert.ok(officialEntry(fixture, handle.worktreePath));
    releaseDiscard.resolve();
    await discardPromise;
    assert.strictEqual(session.discard(), discardPromise);
    assert.equal(await session.inspect(), null);
    assert.equal(officialEntry(fixture, handle.worktreePath), null);
});

test("clean discard removes only the Worktree, preserves the branch, and is idempotent", async () => {
    const fixture = createFixture();
    const jobId = `clean-discard-${fixture.number}`;
    const session = makeSession(fixture, jobId);
    const handle = await session.open();
    const primaryHead = gitText(fixture.repoRoot, ["rev-parse", "HEAD"]);
    const primaryStatus = git(fixture.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
    const originalDiscardExpected = fixture.adapter.discardExpected.bind(fixture.adapter);
    let discardExpectedCalls = 0;
    fixture.adapter.discardExpected = async (...args) => {
        discardExpectedCalls += 1;
        return originalDiscardExpected(...args);
    };
    const discardPromise = session.discard();
    assert.strictEqual(session.discard(), discardPromise);
    await discardPromise;
    assert.strictEqual(session.discard(), discardPromise);
    assert.equal(discardExpectedCalls, 1);
    assert.equal(officialEntries(fixture).length, 1);
    assert.equal(fs.existsSync(handle.worktreePath), false);
    assert.equal(gitText(fixture.repoRoot, ["rev-parse", expectedBranch(jobId)]), handle.base.baseRevision);
    assert.equal(gitText(fixture.repoRoot, ["rev-parse", "HEAD"]), primaryHead);
    assert.equal(git(fixture.repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.equals(primaryStatus), true);
});

test("dirty discard reports a safe block, relocks, preserves edits, then succeeds after cleaning", async () => {
    const fixture = createFixture();
    const session = makeSession(fixture, `dirty-discard-${fixture.number}`);
    const handle = await session.open();
    const edited = path.join(handle.worktreePath, "tracked.txt");
    fs.appendFileSync(edited, "dirty Worktree edit\n");
    let caught;
    try {
        await session.discard();
    } catch (error) {
        caught = error;
    }
    assert.ok(caught instanceof WorktreeWriteSessionError);
    assert.equal(caught.code, "WORKTREE_SESSION_DISCARD_BLOCKED");
    assert.deepEqual(caught.details, { cause: "WORKTREE_REMOVE_FAILED", relocked: true });
    assert.deepEqual(Object.keys(caught.details).sort(), ["cause", "relocked"]);
    assert.equal(fs.readFileSync(edited, "utf8").endsWith("dirty Worktree edit\n"), true);
    const held = officialEntry(fixture, handle.worktreePath);
    assert.equal(held.locked, true);
    assert.equal(held.lockReason, handle.lockReason);
    git(handle.worktreePath, ["reset", "--hard", "HEAD"]);
    git(handle.worktreePath, ["clean", "-fd"]);
    await session.discard();
    assert.equal(officialEntries(fixture).length, 1);
});

test("shared Adapter mutation gate makes discard and foreign unlock-relock race fail closed", async () => {
    const fixture = createFixture();
    const jobId = `adapter-race-${fixture.number}`;
    const session = makeSession(fixture, jobId);
    const handle = await session.open();
    const foreignAdapter = new GitWorktreeAdapter({ workspaceBaseRoot: fixture.workspaceBaseRoot });
    const start = deferred();
    const discardTask = start.promise.then(() => session.discard());
    const takeoverTask = start.promise.then(async () => {
        await foreignAdapter.unlock(fixture.repoRoot, handle.worktreePath);
        await foreignAdapter.lock(fixture.repoRoot, handle.worktreePath, "foreign race reason");
        return "foreign";
    });
    start.resolve();
    const [discardResult, takeoverResult] = await Promise.allSettled([discardTask, takeoverTask]);
    const observed = officialEntry(fixture, handle.worktreePath);

    if (discardResult.status === "fulfilled") {
        assert.equal(takeoverResult.status, "rejected");
        assert.equal(observed, null);
        assert.ok(["WORKTREE_PATH_INVALID", "WORKTREE_NOT_REGISTERED"].includes(takeoverResult.reason?.code));
    } else {
        assert.equal(discardResult.reason?.code, "WORKTREE_SESSION_IDENTITY_MISMATCH");
        assert.equal(takeoverResult.status, "fulfilled");
        assert.ok(observed);
        assert.equal(observed.locked, true);
        assert.equal(observed.lockReason, "foreign race reason");
        assert.equal(observed.head, handle.base.baseRevision);
        await foreignAdapter.unlock(fixture.repoRoot, handle.worktreePath);
        const unlocked = officialEntry(fixture, handle.worktreePath);
        assert.equal(unlocked.branch, handle.branch);
        assert.equal(unlocked.head, handle.base.baseRevision);
        assert.equal(unlocked.locked, false);
        await foreignAdapter.remove(fixture.repoRoot, handle.worktreePath, fixture.workspaceBaseRoot);
        assert.equal(officialEntry(fixture, handle.worktreePath), null);
    }
});

test("caller crash leaves the official locked registration for explicit parent cleanup", async () => {
    const fixture = createFixture();
    const jobId = `caller-crash-${fixture.number}`;
    const childCode = `
"use strict";
const { GitWorktreeAdapter } = require("./Plugin/AICodeWorker/appserver/gitWorktreeAdapter");
const { WorktreeWriteSession } = require("./Plugin/AICodeWorker/appserver/worktreeWriteSession");
(async () => {
    const adapter = new GitWorktreeAdapter({ workspaceBaseRoot: ${JSON.stringify(fixture.workspaceBaseRoot)} });
    const session = new WorktreeWriteSession({
        adapter,
        jobId: ${JSON.stringify(jobId)},
        repoRoot: ${JSON.stringify(fixture.repoRoot)},
        workspaceBaseRoot: ${JSON.stringify(fixture.workspaceBaseRoot)}
    });
    await session.open();
})().catch(error => {
    console.error(error.code || error.message);
    process.exitCode = 1;
});
`;
    const child = spawnSync(process.execPath, ["-e", childCode], {
        cwd: process.cwd(),
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    });
    assert.equal(child.status, 0, `caller child failed: ${child.stderr}`);
    const parentAdapter = new GitWorktreeAdapter({ workspaceBaseRoot: fixture.workspaceBaseRoot });
    const observed = await parentAdapter.inspect(fixture.repoRoot, expectedTarget(fixture, jobId));
    assert.ok(observed);
    assert.equal(observed.locked, true);
    assert.equal(observed.lockReason, expectedReason(jobId));
    assert.equal(officialEntries(fixture).length, 2);
    await parentAdapter.discardExpected({
        repoRoot: fixture.repoRoot,
        workspaceBaseRoot: fixture.workspaceBaseRoot,
        expected: {
            path: observed.path,
            head: observed.head,
            branch: observed.branch,
            locked: true,
            lockReason: observed.lockReason
        }
    });
    assert.equal(officialEntries(fixture).length, 1);
});

test("post-add failure leaves the official lock but gives the Session no handle", async () => {
    const fixture = createFixture();
    const jobId = `post-add-${fixture.number}`;
    const originalAdd = fixture.adapter.add.bind(fixture.adapter);
    let addedEntry;
    fixture.adapter.add = async (...args) => {
        addedEntry = await originalAdd(...args);
        const error = new Error("simulated post-add observation failure");
        error.code = "TEST_POST_ADD_FAILURE";
        throw error;
    };
    const session = makeSession(fixture, jobId);
    await rejectsCode(() => session.open(), "TEST_POST_ADD_FAILURE");
    await rejectsCode(() => session.inspect(), "WORKTREE_SESSION_HANDLE_UNAVAILABLE");
    await rejectsCode(() => session.discard(), "WORKTREE_SESSION_DISCARD_NOT_ALLOWED");
    const official = officialEntry(fixture, expectedTarget(fixture, jobId));
    assert.ok(official);
    assert.deepEqual(official, addedEntry);
    assert.equal(official.locked, true);
    assert.equal(official.lockReason, expectedReason(jobId));
    const parentAdapter = new GitWorktreeAdapter({ workspaceBaseRoot: fixture.workspaceBaseRoot });
    await parentAdapter.discardExpected({
        repoRoot: fixture.repoRoot,
        workspaceBaseRoot: fixture.workspaceBaseRoot,
        expected: {
            path: official.path,
            head: official.head,
            branch: official.branch,
            locked: true,
            lockReason: official.lockReason
        }
    });
    assert.equal(officialEntries(fixture).length, 1);
});

test("production session source has no direct process, deletion, integration, or lifecycle cleanup", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../appserver/worktreeWriteSession.js"), "utf8").toLowerCase();
    for (const forbidden of [
        "child_process", "spawn(", "fs.rm", "rmsync", "unlink", "rmdir", "process.on", "beforeexit",
        "manifest", "wal", "registry", "perforce", "path lease", "commit", "merge", "push", "cherry-pick",
        "sidecar", "rpc", "aicodeworker/", "config", "jobs", "codex"
    ]) {
        assert.equal(source.includes(forbidden), false, `session source contains ${forbidden}`);
    }
    assert.equal(source.includes("instanceof gitworktreeadapter"), true);
    assert.equal(source.includes("normalizeworktreeid"), true);
    assert.equal(source.includes("adapter.add"), true);
    assert.equal(source.includes("adapter.assertbasestable"), true);
    assert.equal(source.includes("adapter.assertpinnedworkspacebaseroot"), true);
    assert.equal(source.includes("adapter.discardexpected"), true);
    assert.equal(source.includes("recovermatchingregistration"), false);
    assert.equal(source.includes("adapter.unlock"), false);
    assert.equal(source.includes("adapter.remove"), false);
});
