"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, test } = require("node:test");

const {
    GitWorktreeAdapter,
    parseWorktreeListPorcelainZ
} = require("../appserver/gitWorktreeAdapter");

const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicodeworker-candidate-"));
const fixtures = [];
let nextFixture = 1;

function samePath(left, right) {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function git(cwd, args, options = {}) {
    const result = spawnSync("git", args, {
        cwd,
        shell: false,
        windowsHide: true,
        encoding: "buffer",
        input: options.input,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    });
    if (options.allowFailure !== true) {
        assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${String(result.stderr || "")}`);
    }
    return result;
}

function gitText(cwd, args, options) {
    return String(git(cwd, args, options).stdout || "").trim();
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
    git(repoRoot, ["config", "core.autocrlf", "false"]);
    fs.writeFileSync(path.join(repoRoot, ".gitignore"), "ignored-only.tmp\n", "utf8");
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "alpha\nbeta\n", "utf8");
    fs.writeFileSync(path.join(repoRoot, "delete-me.txt"), "delete me\n", "utf8");
    fs.writeFileSync(path.join(repoRoot, "rename-me.txt"), "rename content\n", "utf8");
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

async function openCandidate(fixture, label) {
    const jobId = `${label}-${fixture.number}`;
    const base = await fixture.adapter.captureBase(fixture.repoRoot);
    const lockReason = `candidate fixture ${jobId}`;
    const entry = await fixture.adapter.add({
        base,
        workspaceBaseRoot: fixture.workspaceBaseRoot,
        workspaceId: jobId,
        lockReason
    });
    return {
        jobId,
        base,
        entry,
        expected: {
            path: entry.path,
            branch: entry.branch,
            head: entry.head,
            locked: true,
            lockReason
        }
    };
}

function candidateOptions(fixture, opened) {
    return {
        repoRoot: fixture.repoRoot,
        workspaceBaseRoot: fixture.workspaceBaseRoot,
        base: opened.base,
        expected: opened.expected
    };
}

async function commitCandidate(fixture, opened) {
    return fixture.adapter.createCandidateCommitExpected(candidateOptions(fixture, opened));
}

async function rejectsCode(operation, code) {
    await assert.rejects(Promise.resolve().then(operation), error => error?.code === code, `expected ${code}`);
}

async function assertPrimaryStable(fixture, opened) {
    const fingerprint = await fixture.adapter.assertBaseStable(opened.base);
    assert.equal(fingerprint.head, opened.base.baseRevision);
    assert.equal(gitText(fixture.repoRoot, ["rev-parse", "HEAD"]), opened.base.baseRevision);
}

function assertIndexEmpty(worktreePath) {
    assert.equal(git(worktreePath, ["diff", "--cached", "--raw", "-z", "--"]).stdout.length, 0);
}

async function cleanupFixture(fixture) {
    let entries = officialEntries(fixture);
    for (const entry of entries) {
        if (samePath(entry.path, fixture.repoRoot)) continue;
        const relative = path.relative(fixture.workspaceBaseRoot, entry.path);
        assert.equal(relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`), true);
        if (entry.locked) await fixture.adapter.unlock(fixture.repoRoot, entry.path);
        git(entry.path, ["reset", "--hard", "HEAD"]);
        git(entry.path, ["clean", "-ffdx"]);
        await fixture.adapter.remove(fixture.repoRoot, entry.path, fixture.workspaceBaseRoot);
    }
    entries = officialEntries(fixture);
    assert.equal(entries.length, 1);
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
    assert.equal(fs.existsSync(suiteRoot), false, "candidate fixture root must be removed");
});

test("tracked modification creates a frozen candidate result", async () => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "modified");
    fs.appendFileSync(path.join(opened.entry.path, "tracked.txt"), "candidate edit\n", "utf8");

    const result = await commitCandidate(fixture, opened);

    assert.deepEqual(Object.keys(result).sort(), [
        "baseRevision", "branch", "changedFiles", "jobId", "locked", "resultCommit", "resultTree",
        "schemaVersion", "worktreeClean", "worktreePath"
    ]);
    assert.deepEqual(result.changedFiles, [
        { status: "M", score: null, path: "tracked.txt", oldPath: null }
    ]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.changedFiles), true);
    assert.equal(Object.isFrozen(result.changedFiles[0]), true);
    assert.equal(result.baseRevision, opened.base.baseRevision);
    assert.equal(result.resultCommit, gitText(opened.entry.path, ["rev-parse", "HEAD"]));
    assert.notEqual(result.resultCommit, result.baseRevision);
    await assertPrimaryStable(fixture, opened);
});

test("tracked deletion is represented as D", async () => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "deleted");
    fs.unlinkSync(path.join(opened.entry.path, "delete-me.txt"));

    const result = await commitCandidate(fixture, opened);

    assert.deepEqual(result.changedFiles, [
        { status: "D", score: null, path: "delete-me.txt", oldPath: null }
    ]);
    await assertPrimaryStable(fixture, opened);
});

test("untracked files are included as A", async () => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "untracked");
    fs.writeFileSync(path.join(opened.entry.path, "new file.txt"), "new candidate file\n", "utf8");

    const result = await commitCandidate(fixture, opened);

    assert.deepEqual(result.changedFiles, [
        { status: "A", score: null, path: "new file.txt", oldPath: null }
    ]);
    await assertPrimaryStable(fixture, opened);
});

test("rename reports R, score, oldPath, and new path", async () => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "rename");
    fs.renameSync(
        path.join(opened.entry.path, "rename-me.txt"),
        path.join(opened.entry.path, "renamed file.txt")
    );

    const result = await commitCandidate(fixture, opened);

    assert.deepEqual(result.changedFiles, [
        { status: "R", score: 100, path: "renamed file.txt", oldPath: "rename-me.txt" }
    ]);
    await assertPrimaryStable(fixture, opened);
});

test("staged-only input is rejected without losing index or content", async () => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "staged-only");
    const tracked = path.join(opened.entry.path, "tracked.txt");
    fs.appendFileSync(tracked, "staged input\n", "utf8");
    git(opened.entry.path, ["add", "--", "tracked.txt"]);
    const indexBefore = git(opened.entry.path, ["diff", "--cached", "--raw", "-z", "--"]).stdout;
    const contentBefore = fs.readFileSync(tracked);

    await rejectsCode(() => commitCandidate(fixture, opened), "WORKTREE_CANDIDATE_STAGED_INPUT");

    assert.equal(git(opened.entry.path, ["diff", "--cached", "--raw", "-z", "--"]).stdout.equals(indexBefore), true);
    assert.equal(fs.readFileSync(tracked).equals(contentBefore), true);
    await assertPrimaryStable(fixture, opened);
});

test("staged plus unstaged input is rejected without losing either", async () => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "mixed-index");
    const tracked = path.join(opened.entry.path, "tracked.txt");
    fs.appendFileSync(tracked, "staged part\n", "utf8");
    git(opened.entry.path, ["add", "--", "tracked.txt"]);
    fs.appendFileSync(tracked, "unstaged part\n", "utf8");
    const indexBefore = git(opened.entry.path, ["diff", "--cached", "--raw", "-z", "--"]).stdout;
    const statusBefore = git(opened.entry.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
    const contentBefore = fs.readFileSync(tracked);

    await rejectsCode(() => commitCandidate(fixture, opened), "WORKTREE_CANDIDATE_STAGED_INPUT");

    assert.equal(git(opened.entry.path, ["diff", "--cached", "--raw", "-z", "--"]).stdout.equals(indexBefore), true);
    assert.equal(git(opened.entry.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.equals(statusBefore), true);
    assert.equal(fs.readFileSync(tracked).equals(contentBefore), true);
    await assertPrimaryStable(fixture, opened);
});

test("unmerged index entries are rejected before staging", async () => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "unmerged");
    const baseBlob = gitText(opened.entry.path, ["rev-parse", "HEAD:tracked.txt"]);
    const oursBlob = gitText(opened.entry.path, ["hash-object", "-w", "--stdin"], { input: Buffer.from("ours\n") });
    const theirsBlob = gitText(opened.entry.path, ["hash-object", "-w", "--stdin"], { input: Buffer.from("theirs\n") });
    const indexInfo = Buffer.from(
        `100644 ${baseBlob} 1\ttracked.txt\n100644 ${oursBlob} 2\ttracked.txt\n100644 ${theirsBlob} 3\ttracked.txt\n`
    );
    git(opened.entry.path, ["update-index", "--index-info"], { input: indexInfo });
    const unmergedBefore = git(opened.entry.path, ["ls-files", "--unmerged", "-z"]).stdout;
    assert.notEqual(unmergedBefore.length, 0);

    await rejectsCode(() => commitCandidate(fixture, opened), "WORKTREE_CANDIDATE_UNMERGED");

    assert.equal(git(opened.entry.path, ["ls-files", "--unmerged", "-z"]).stdout.equals(unmergedBefore), true);
    await assertPrimaryStable(fixture, opened);
});

test("empty and ignored-only Worktrees are rejected", async () => {
    for (const kind of ["empty", "ignored"]) {
        const fixture = createFixture();
        const opened = await openCandidate(fixture, kind);
        if (kind === "ignored") {
            fs.writeFileSync(path.join(opened.entry.path, "ignored-only.tmp"), "ignored\n", "utf8");
        }

        await rejectsCode(() => commitCandidate(fixture, opened), "WORKTREE_CANDIDATE_EMPTY");

        assertIndexEmpty(opened.entry.path);
        if (kind === "ignored") assert.equal(fs.existsSync(path.join(opened.entry.path, "ignored-only.tmp")), true);
        await assertPrimaryStable(fixture, opened);
    }
});

test("nested repositories are rejected as gitlinks and index rollback preserves files", async () => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "gitlink");
    const nested = path.join(opened.entry.path, "nested");
    fs.mkdirSync(nested);
    git(nested, ["init", "--quiet"]);
    fs.writeFileSync(path.join(nested, "nested.txt"), "nested content\n", "utf8");
    git(nested, ["add", "--", "."]);
    git(nested, [
        "-c", "user.name=Nested Test", "-c", "user.email=nested@example.invalid",
        "commit", "--quiet", "-m", "nested"
    ]);
    const statusBefore = git(opened.entry.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;

    await rejectsCode(() => commitCandidate(fixture, opened), "WORKTREE_CANDIDATE_UNSUPPORTED_ENTRY");

    assertIndexEmpty(opened.entry.path);
    assert.equal(fs.readFileSync(path.join(nested, "nested.txt"), "utf8"), "nested content\n");
    assert.equal(git(opened.entry.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.equals(statusBefore), true);
    await assertPrimaryStable(fixture, opened);
});

test("symlinks are rejected when the platform permits creating one", async t => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "symlink");
    const linkPath = path.join(opened.entry.path, "tracked-link.txt");
    try {
        fs.symlinkSync("tracked.txt", linkPath, "file");
    } catch (error) {
        if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
            t.skip(`symlink creation unavailable: ${error.code}`);
            return;
        }
        throw error;
    }

    await rejectsCode(() => commitCandidate(fixture, opened), "WORKTREE_CANDIDATE_UNSUPPORTED_ENTRY");

    assertIndexEmpty(opened.entry.path);
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
    await assertPrimaryStable(fixture, opened);
});

test("diff-check failure restores an empty index and preserves the edited file", async () => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "diff-check");
    const tracked = path.join(opened.entry.path, "tracked.txt");
    fs.appendFileSync(tracked, "trailing whitespace   \n", "utf8");
    const statusBefore = git(opened.entry.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
    const contentBefore = fs.readFileSync(tracked);

    await rejectsCode(() => commitCandidate(fixture, opened), "WORKTREE_CANDIDATE_DIFF_CHECK_FAILED");

    assertIndexEmpty(opened.entry.path);
    assert.equal(fs.readFileSync(tracked).equals(contentBefore), true);
    assert.equal(git(opened.entry.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.equals(statusBefore), true);
    await assertPrimaryStable(fixture, opened);
});

test("candidate add and commit ignore checkout and ref hooks while preserving fixed proof and user hooks", async t => {
    const fixture = createFixture();
    const marker = path.join(fixture.workspaceBaseRoot, "forbidden-marker.txt");
    const postCheckoutMarker = path.join(fixture.workspaceBaseRoot, "post-checkout-marker.txt");
    const referenceTransactionMarker = path.join(fixture.workspaceBaseRoot, "reference-transaction-marker.txt");
    const executable = path.join(fixture.workspaceBaseRoot, "forbidden-marker.sh");
    const hooks = path.join(fixture.repoRoot, ".git", "candidate-hooks");
    fs.mkdirSync(hooks);
    const rejectingScript = target => {
        const shellPath = target.replace(/\\/g, "/").replace(/'/g, "'\\''");
        return `#!/bin/sh\nprintf invoked >> '${shellPath}'\nexit 97\n`;
    };
    const shellMarker = rejectingScript(marker);
    fs.writeFileSync(executable, shellMarker, "utf8");
    fs.writeFileSync(path.join(hooks, "pre-commit"), shellMarker, "utf8");
    fs.writeFileSync(path.join(hooks, "post-checkout"), rejectingScript(postCheckoutMarker), "utf8");
    fs.writeFileSync(path.join(hooks, "reference-transaction"), rejectingScript(referenceTransactionMarker), "utf8");
    if (process.platform !== "win32") {
        fs.chmodSync(executable, 0o755);
        fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);
        fs.chmodSync(path.join(hooks, "post-checkout"), 0o755);
        fs.chmodSync(path.join(hooks, "reference-transaction"), 0o755);
    }
    git(fixture.repoRoot, ["config", "core.hooksPath", hooks]);
    t.after(() => {
        git(fixture.repoRoot, ["config", "--unset-all", "core.hooksPath"], { allowFailure: true });
    });
    git(fixture.repoRoot, ["config", "commit.gpgSign", "true"]);
    git(fixture.repoRoot, ["config", "gpg.program", executable]);
    git(fixture.repoRoot, ["config", "diff.external", executable]);
    const hooksBefore = new Map(fs.readdirSync(hooks).sort().map(name => [name, fs.readFileSync(path.join(hooks, name))]));
    const opened = await openCandidate(fixture, "proof");
    fs.appendFileSync(path.join(opened.entry.path, "tracked.txt"), "proof edit\n", "utf8");

    const saved = new Map();
    const hostileEnvironment = {
        GIT_DIR: path.join(fixture.repoRoot, "missing-git-dir"),
        GIT_INDEX_FILE: path.join(fixture.repoRoot, "forbidden-index"),
        GIT_NAMESPACE: "forbidden-namespace",
        GIT_EDITOR: executable,
        GIT_EXTERNAL_DIFF: executable,
        VISUAL: executable,
        EDITOR: executable
    };
    for (const [key, value] of Object.entries(hostileEnvironment)) {
        saved.set(key, process.env[key]);
        process.env[key] = value;
    }
    let result;
    try {
        result = await commitCandidate(fixture, opened);
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }

    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(postCheckoutMarker), false);
    assert.equal(fs.existsSync(referenceTransactionMarker), false);
    assert.equal(fs.existsSync(hooks), true);
    assert.equal(gitText(fixture.repoRoot, ["config", "--get", "core.hooksPath"]), hooks);
    assert.deepEqual(fs.readdirSync(hooks).sort(), [...hooksBefore.keys()]);
    for (const [name, content] of hooksBefore) {
        assert.equal(fs.readFileSync(path.join(hooks, name)).equals(content), true, `${name} hook must be preserved`);
    }
    const identity = String(git(fixture.repoRoot, [
        "show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", result.resultCommit
    ]).stdout).split("\0");
    assert.deepEqual(identity.slice(0, 4), [
        "VCP AICodeWorker", "aicodeworker@invalid.example",
        "VCP AICodeWorker", "aicodeworker@invalid.example"
    ]);
    assert.equal(identity[4].trim(), `VCP AICodeWorker candidate ${opened.entry.branch}`);
    assert.equal(gitText(fixture.repoRoot, ["show", "-s", "--format=%P", result.resultCommit]), opened.base.baseRevision);
    assert.equal(gitText(fixture.repoRoot, ["rev-parse", `${result.resultCommit}^{tree}`]), result.resultTree);
    assert.equal(gitText(fixture.repoRoot, ["rev-parse", opened.entry.branch]), result.resultCommit);
    assert.equal(git(opened.entry.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout.length, 0);
    const registration = officialEntry(fixture, opened.entry.path);
    assert.equal(registration.head, result.resultCommit);
    assert.equal(registration.locked, true);
    assert.equal(registration.lockReason, opened.expected.lockReason);
    await assertPrimaryStable(fixture, opened);
});

test("local clean or process filters fail closed before staging", async () => {
    for (const driver of ["clean", "process"]) {
        const fixture = createFixture();
        const opened = await openCandidate(fixture, `filter-${driver}`);
        try {
            if (driver === "clean") {
                const includedConfig = path.join(fixture.repoRoot, ".git", "candidate-filter.inc");
                fs.writeFileSync(includedConfig, '[filter "block"]\n\tclean = forbidden-filter-command\n', "utf8");
                git(fixture.repoRoot, ["config", "include.path", includedConfig]);
            } else {
                git(fixture.repoRoot, ["config", "filter.block.process", "forbidden-filter-command"]);
            }
            const tracked = path.join(opened.entry.path, "tracked.txt");
            fs.appendFileSync(tracked, `${driver} filter edit\n`, "utf8");
            const contentBefore = fs.readFileSync(tracked);

            await rejectsCode(() => commitCandidate(fixture, opened), "WORKTREE_CANDIDATE_FILTER_UNSAFE");

            assertIndexEmpty(opened.entry.path);
            assert.equal(fs.readFileSync(tracked).equals(contentBefore), true);
        } finally {
            const key = driver === "clean" ? "include.path" : "filter.block.process";
            git(fixture.repoRoot, ["config", "--unset-all", key], { allowFailure: true });
        }
        await assertPrimaryStable(fixture, opened);
    }
});

test("primary process filter added after open is rejected before candidate base status", async () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.repoRoot, ".gitattributes"), "tracked.txt filter=block\n", "utf8");
    git(fixture.repoRoot, ["add", "--", ".gitattributes"]);
    git(fixture.repoRoot, [
        "-c", "user.name=AICW Test", "-c", "user.email=aicw@example.invalid",
        "commit", "--quiet", "-m", "candidate process filter baseline"
    ]);
    const opened = await openCandidate(fixture, "primary-process-filter");
    const candidateTracked = path.join(opened.entry.path, "tracked.txt");
    fs.appendFileSync(candidateTracked, "candidate process filter edit\n", "utf8");
    const candidateContentBefore = fs.readFileSync(candidateTracked);
    const candidateStatusBefore = git(
        opened.entry.path,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
    ).stdout;
    const candidateIndexBefore = git(
        opened.entry.path,
        ["diff", "--cached", "--raw", "-z", "--"]
    ).stdout;
    assert.equal(candidateIndexBefore.length, 0);
    const registrationBefore = officialEntry(fixture, opened.entry.path);
    const primaryHeadBefore = gitText(fixture.repoRoot, ["rev-parse", "HEAD"]);
    const primaryStatusBefore = git(
        fixture.repoRoot,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
    ).stdout;
    const marker = path.join(fixture.workspaceBaseRoot, "candidate-primary-process-filter-marker.txt");
    const executable = path.join(fixture.repoRoot, ".git", "candidate-primary-process-filter-driver.sh");
    const shellMarker = `#!/bin/sh\nprintf invoked > '${marker.replace(/'/g, "'\\''")}'\nexit 97\n`;
    fs.writeFileSync(executable, shellMarker, "utf8");
    if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
    const command = `'${executable.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
    git(fixture.repoRoot, ["config", "filter.block.process", command]);
    git(fixture.repoRoot, ["config", "filter.block.required", "true"]);
    const primaryTracked = path.join(fixture.repoRoot, "tracked.txt");
    const primaryContent = fs.readFileSync(primaryTracked);
    fs.writeFileSync(primaryTracked, primaryContent);
    fs.utimesSync(primaryTracked, new Date(), new Date(Date.now() + 10_000));

    try {
        await rejectsCode(() => commitCandidate(fixture, opened), "WORKTREE_CANDIDATE_FILTER_UNSAFE");
        assert.equal(fs.existsSync(marker), false, "primary process filter must be rejected before base status");
    } finally {
        git(fixture.repoRoot, ["config", "--unset-all", "filter.block.required"], { allowFailure: true });
        git(fixture.repoRoot, ["config", "--unset-all", "filter.block.process"], { allowFailure: true });
    }

    assert.equal(fs.existsSync(marker), false);
    assert.equal(git(opened.entry.path, ["diff", "--cached", "--raw", "-z", "--"]).stdout.equals(candidateIndexBefore), true);
    assert.equal(fs.readFileSync(candidateTracked).equals(candidateContentBefore), true);
    assert.equal(git(
        opened.entry.path,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
    ).stdout.equals(candidateStatusBefore), true);
    const registrationAfter = officialEntry(fixture, opened.entry.path);
    assert.deepEqual(registrationAfter, registrationBefore);
    assert.equal(gitText(opened.entry.path, ["rev-parse", "HEAD"]), opened.expected.head);
    assert.equal(registrationAfter.branch, opened.expected.branch);
    assert.equal(registrationAfter.head, opened.expected.head);
    assert.equal(registrationAfter.locked, true);
    assert.equal(registrationAfter.lockReason, opened.expected.lockReason);
    assert.equal(gitText(fixture.repoRoot, ["rev-parse", "HEAD"]), primaryHeadBefore);
    assert.equal(primaryHeadBefore, opened.base.baseRevision);
    assert.equal(git(
        fixture.repoRoot,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
    ).stdout.equals(primaryStatusBefore), true);
    await assertPrimaryStable(fixture, opened);
});

test("external linked HEAD drift fails closed without touching the primary base", async () => {
    const fixture = createFixture();
    const opened = await openCandidate(fixture, "head-drift");
    const otherCommit = gitText(fixture.repoRoot, [
        "-c", "user.name=External Test", "-c", "user.email=external@example.invalid",
        "commit-tree", opened.base.baseTree, "-p", opened.base.baseRevision, "-m", "external drift"
    ]);
    git(fixture.repoRoot, [
        "update-ref", `refs/heads/${opened.entry.branch}`, otherCommit, opened.base.baseRevision
    ]);
    const tracked = path.join(opened.entry.path, "tracked.txt");
    fs.appendFileSync(tracked, "must remain\n", "utf8");
    const contentBefore = fs.readFileSync(tracked);

    await rejectsCode(() => commitCandidate(fixture, opened), "WORKTREE_CANDIDATE_IDENTITY_DRIFT");

    assert.equal(gitText(fixture.repoRoot, ["rev-parse", opened.entry.branch]), otherCommit);
    assert.equal(fs.readFileSync(tracked).equals(contentBefore), true);
    assertIndexEmpty(opened.entry.path);
    await assertPrimaryStable(fixture, opened);
});
