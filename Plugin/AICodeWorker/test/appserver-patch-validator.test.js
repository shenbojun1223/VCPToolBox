"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, test } = require("node:test");

const {
    MAX_PATCH_BYTES,
    validatePatchSize,
    extractPatchPayload,
    parseUnifiedDiff,
    assertNoSecrets,
    runGit,
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
    sha256
} = require("../appserver/patchValidator");
const {
    pinPatchArtifactDirectory,
    verifyPatchArtifactDirectory,
    createPatchArtifactNonce,
    patchCandidatePath,
    jobPaths
} = require("../appserver/protocol");

const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicodeworker-patch-validator-"));
let nextRepo = 1;

after(() => {
    fs.rmSync(suiteRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    assert.equal(fs.existsSync(suiteRoot), false, "validator suite temp root must be removed");
});

function git(cwd, args, options = {}) {
    const result = spawnSync("git", args, {
        cwd,
        shell: false,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        ...options
    });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed without exposing stderr`);
    return String(result.stdout || "").trim();
}

function createRepo(files = { "tracked.txt": "alpha\nbeta\n" }) {
    const repoRoot = path.join(suiteRoot, `repo-${nextRepo++}`);
    fs.mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, ["init", "--quiet"]);
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(repoRoot, ...relative.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, "utf8");
    }
    git(repoRoot, ["add", "--", "."]);
    git(repoRoot, ["-c", "user.name=AICW Test", "-c", "user.email=aicw@example.invalid", "commit", "--quiet", "-m", "baseline"]);
    return fs.realpathSync.native(repoRoot);
}

function rawPatch(relative = "tracked.txt", replacement = "gamma") {
    return [
        `diff --git a/${relative} b/${relative}`,
        "index fbbee86..0000000 100644",
        `--- a/${relative}`,
        `+++ b/${relative}`,
        "@@ -1,2 +1,2 @@",
        " alpha",
        "-beta",
        `+${replacement}`,
        ""
    ].join("\n");
}

function assertCode(fn, code) {
    assert.throws(fn, error => error?.code === code, `expected ${code}`);
}

function artifactFixture(label) {
    const jobRoot = path.join(suiteRoot, `artifacts-${label}-${nextRepo++}`);
    fs.mkdirSync(jobRoot, { recursive: true });
    const directoryIdentity = pinPatchArtifactDirectory(jobRoot, { create: true });
    return { jobRoot, directoryIdentity };
}

function candidateFixture(fixture, jobId, patchText, instanceId = "instance-a", nonce = createPatchArtifactNonce(), hooks = {}) {
    return {
        instanceId,
        nonce,
        ...createPrivateCandidate({
            jobRoot: fixture.jobRoot,
            jobId,
            sidecarInstanceId: instanceId,
            patchArtifactNonce: nonce,
            patchText,
            patchArtifactDirectoryIdentity: fixture.directoryIdentity
        }, { hooks })
    };
}

function completedPatchMeta(jobId, fixture, patchText, extra = {}) {
    const publicArtifact = inspectPatchArtifactFile(jobPaths(fixture.jobRoot, jobId).patchPath, fixture.directoryIdentity, {
        jobRoot: fixture.jobRoot,
        expectedSha256: sha256(Buffer.from(patchText, "utf8")),
        expectedBytes: Buffer.byteLength(patchText, "utf8")
    });
    return {
        jobId,
        state: "completed",
        executionBackend: "codex-app-server",
        jobKind: "patch",
        patchValidated: true,
        applyCheckPassed: true,
        baselineStable: true,
        patchSha256: sha256(Buffer.from(patchText, "utf8")),
        patchBytes: Buffer.byteLength(patchText, "utf8"),
        patchFileCount: 1,
        patchArtifactDirectoryIdentity: fixture.directoryIdentity,
        patchArtifactPublicIdentity: publicArtifact.identity,
        ...extra
    };
}

function replaceArtifactDirectory(fixture, suffix) {
    const patchesPath = fixture.directoryIdentity.realpath;
    const displaced = `${patchesPath}.${suffix}`;
    fs.renameSync(patchesPath, displaced);
    fs.mkdirSync(patchesPath);
    return displaced;
}

async function assertRejectCode(promise, code) {
    await assert.rejects(promise, error => error?.code === code, `expected ${code}`);
}

test("accepts valid raw single-file and multi-file unified diffs", () => {
    const single = parseUnifiedDiff(extractPatchPayload(rawPatch()));
    assert.equal(single.fileCount, 1);
    const multi = `${rawPatch()}${rawPatch("nested/second.txt", "delta")}`;
    const parsed = parseUnifiedDiff(extractPatchPayload(multi));
    assert.deepEqual(parsed.sections.map(section => section.path), ["tracked.txt", "nested/second.txt"]);
});

test("accepts exactly one fenced diff with only surrounding whitespace", () => {
    const extracted = extractPatchPayload(` \n\`\`\`diff\n${rawPatch()}\`\`\`\n\t`);
    assert.equal(extracted, rawPatch());
    assert.equal(parseUnifiedDiff(extracted).fileCount, 1);
});

test("rejects prose-only, empty patch, and empty fence", () => {
    assertCode(() => extractPatchPayload("  \r\n"), "AICW_PATCH_EMPTY");
    assertCode(() => extractPatchPayload("Here is a patch."), "AICW_PATCH_FORMAT_INVALID");
    assertCode(() => extractPatchPayload("```diff\n\n```"), "AICW_PATCH_EMPTY");
});

test("rejects multiple fences, raw plus fence, fence prose, and unclosed fence", () => {
    assertCode(() => extractPatchPayload(`\`\`\`diff\n${rawPatch()}\`\`\`\n\`\`\`diff\n${rawPatch()}\`\`\``), "AICW_PATCH_MULTIPLE_PAYLOADS");
    assertCode(() => extractPatchPayload(`${rawPatch()}\`\`\`diff\n${rawPatch()}\`\`\``), "AICW_PATCH_MULTIPLE_PAYLOADS");
    assertCode(() => extractPatchPayload(`prose\n\`\`\`diff\n${rawPatch()}\`\`\``), "AICW_PATCH_FORMAT_INVALID");
    assertCode(() => extractPatchPayload(`\`\`\`diff\n${rawPatch()}`), "AICW_PATCH_FORMAT_INVALID");
});

test("rejects truncated/count-mismatched hunks and sections without changes", () => {
    const truncated = rawPatch().replace("+gamma\n", "");
    assertCode(() => parseUnifiedDiff(truncated), "AICW_PATCH_TRUNCATED");
    const overfull = rawPatch().replace("+gamma\n", "+gamma\n+extra\n");
    assertCode(() => parseUnifiedDiff(overfull), "AICW_PATCH_TRUNCATED");
    const contextOnly = rawPatch().replace("@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma", "@@ -1,1 +1,1 @@\n alpha");
    assertCode(() => parseUnifiedDiff(contextOnly), "AICW_PATCH_FORMAT_INVALID");
});

test("rejects traversal, absolute, drive, UNC, URI, backslash, colon, and NUL paths", () => {
    for (const relative of ["../x", "/x", "C:/x", "//server/share", "https://host/x", "dir\\x", "dir:name", "dir//x", "./x"]) {
        assertCode(() => parseUnifiedDiff(rawPatch(relative)), "AICW_PATCH_PATH_INVALID");
    }
    assertCode(() => parseUnifiedDiff(rawPatch(`bad\0name`)), "AICW_PATCH_PATH_INVALID");
});

test("rejects case-insensitive .git and .agents protected segments", () => {
    for (const relative of [".git/config", "src/.GiT/index", ".AGENTS/rules", "src/.Agents/file"]) {
        assertCode(() => parseUnifiedDiff(rawPatch(relative)), "AICW_PATCH_PROTECTED_PATH");
    }
});

test("rejects create, delete, rename, copy, mode, binary, and submodule operations", () => {
    const base = rawPatch();
    const variants = [
        base.replace("index fbbee86..0000000 100644\n", "new file mode 100644\n").replace("--- a/tracked.txt", "--- /dev/null"),
        base.replace("+++ b/tracked.txt", "+++ /dev/null"),
        base.replace("index fbbee86..0000000 100644", "rename from tracked.txt\nrename to moved.txt"),
        base.replace("index fbbee86..0000000 100644", "copy from tracked.txt\ncopy to copied.txt"),
        base.replace("index fbbee86..0000000 100644", "old mode 100644\nnew mode 100755"),
        base.replace("--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma", "GIT binary patch"),
        base.replace(" alpha\n-beta\n+gamma", "-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222")
    ];
    for (const patch of variants) {
        assert.throws(() => parseUnifiedDiff(patch), error => ["AICW_PATCH_OPERATION_UNSUPPORTED", "AICW_PATCH_BINARY_UNSUPPORTED"].includes(error?.code));
    }
});

test("rejects quoted and whitespace-bearing paths", () => {
    for (const relative of ['"space file.txt"', "space file.txt", "tab\tfile.txt", "'quoted.txt'"]) {
        assertCode(() => parseUnifiedDiff(rawPatch(relative)), "AICW_PATCH_PATH_INVALID");
    }
});

test("rejects missing, untracked, directory, symlink, and reparse targets", async t => {
    const repoRoot = createRepo({ "tracked.txt": "alpha\nbeta\n", "target.txt": "alpha\nbeta\n" });
    fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "alpha\nbeta\n", "utf8");
    fs.mkdirSync(path.join(repoRoot, "directory"));
    for (const relative of ["missing.txt", "untracked.txt", "directory"]) {
        const parsed = parseUnifiedDiff(rawPatch(relative));
        await assertRejectCode(validateTrackedPaths(repoRoot, parsed), "AICW_PATCH_PATH_INVALID");
    }
    const linkPath = path.join(repoRoot, "linked.txt");
    try {
        fs.symlinkSync(path.join(repoRoot, "target.txt"), linkPath, "file");
        git(repoRoot, ["add", "--", "linked.txt"]);
        const parsed = parseUnifiedDiff(rawPatch("linked.txt"));
        await assertRejectCode(validateTrackedPaths(repoRoot, parsed), "AICW_PATCH_PATH_INVALID");
    } catch (error) {
        if (!["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) throw error;
        const junctionTarget = path.join(suiteRoot, `junction-target-${nextRepo++}`);
        const junctionPath = path.join(repoRoot, "junction-dir");
        try {
            fs.mkdirSync(junctionTarget, { recursive: true });
            fs.writeFileSync(path.join(junctionTarget, "target.txt"), "alpha\nbeta\n", "utf8");
            fs.symlinkSync(junctionTarget, junctionPath, "junction");
            const parsed = parseUnifiedDiff(rawPatch("junction-dir/target.txt"));
            await assertRejectCode(validateTrackedPaths(repoRoot, parsed), "AICW_PATCH_PATH_INVALID");
        } catch (junctionError) {
            if (!["EPERM", "EACCES", "UNKNOWN"].includes(junctionError?.code)) throw junctionError;
            t.diagnostic(`symlink and junction creation unavailable: ${junctionError.code}`);
        }
    }
});

test("detects high-confidence secrets without rewriting patch content", () => {
    const secret = `sk-${"A".repeat(24)}`;
    const patch = rawPatch("tracked.txt", secret);
    assertCode(() => assertNoSecrets(patch), "AICW_PATCH_SECRET_DETECTED");
    assert.equal(patch.includes(secret), true);
});

test("enforces the exact 512 KiB patch size boundary", () => {
    assert.equal(validatePatchSize("x".repeat(MAX_PATCH_BYTES)), MAX_PATCH_BYTES);
    assertCode(() => validatePatchSize("x".repeat(MAX_PATCH_BYTES + 1)), "AICW_PATCH_TOO_LARGE");
});

test("captures only canonical clean Git roots with an existing HEAD", async () => {
    const repoRoot = createRepo();
    const baseline = await captureGitBaseline(repoRoot);
    assert.equal(baseline.repoRoot, repoRoot);
    assert.match(baseline.baseHead, /^[0-9a-f]{40,64}$/);
    assert.match(baseline.baseTree, /^[0-9a-f]{40,64}$/);
    await assertRejectCode(captureGitBaseline(path.join(repoRoot, ".git")), "AICW_PATCH_NOT_GIT_ROOT");
    const noHead = path.join(suiteRoot, `repo-${nextRepo++}`);
    fs.mkdirSync(noHead);
    git(noHead, ["init", "--quiet"]);
    await assertRejectCode(captureGitBaseline(noHead), "AICW_PATCH_NOT_GIT_ROOT");
});

test("rejects staged, unstaged, and untracked dirty baselines", async () => {
    for (const dirty of [
        repo => fs.appendFileSync(path.join(repo, "tracked.txt"), "unstaged\n"),
        repo => { fs.appendFileSync(path.join(repo, "tracked.txt"), "staged\n"); git(repo, ["add", "--", "tracked.txt"]); },
        repo => fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n")
    ]) {
        const repoRoot = createRepo();
        dirty(repoRoot);
        await assertRejectCode(captureGitBaseline(repoRoot), "AICW_PATCH_BASELINE_DIRTY");
    }
});

test("detects HEAD, tree, and status fingerprint drift", async () => {
    const statusRepo = createRepo();
    const statusBaseline = await captureGitBaseline(statusRepo);
    fs.appendFileSync(path.join(statusRepo, "tracked.txt"), "drift\n");
    await assertRejectCode(assertBaselineStable(statusRepo, statusBaseline), "AICW_PATCH_BASELINE_DRIFT");

    const headRepo = createRepo();
    const headBaseline = await captureGitBaseline(headRepo);
    fs.writeFileSync(path.join(headRepo, "tracked.txt"), "new tree\n", "utf8");
    git(headRepo, ["add", "--", "tracked.txt"]);
    git(headRepo, ["-c", "user.name=AICW Test", "-c", "user.email=aicw@example.invalid", "commit", "--quiet", "-m", "drift"]);
    await assertRejectCode(assertBaselineStable(headRepo, headBaseline), "AICW_PATCH_BASELINE_DRIFT");
});

test("runs git apply --check without applying the candidate", async () => {
    const repoRoot = createRepo();
    const candidate = path.join(suiteRoot, "apply-ok.patch");
    fs.writeFileSync(candidate, rawPatch(), "utf8");
    await applyCheck(repoRoot, candidate);
    assert.equal(fs.readFileSync(path.join(repoRoot, "tracked.txt"), "utf8"), "alpha\nbeta\n");
    fs.writeFileSync(candidate, rawPatch().replace("-beta", "-missing"), "utf8");
    await assertRejectCode(applyCheck(repoRoot, candidate), "AICW_PATCH_APPLY_CHECK_FAILED");
});

test("writes a private candidate and atomically publishes without overwrite", async () => {
    const repoRoot = createRepo();
    const fixture = artifactFixture("publish");
    const jobId = "job_publish";
    const patch = rawPatch();
    const parsed = parseUnifiedDiff(patch);
    const candidate = candidateFixture(fixture, jobId, patch);
    assert.equal(fs.statSync(candidate.candidatePath).isFile(), true);
    await applyCheck(repoRoot, candidate.candidatePath);
    const published = publishCandidateNoOverwrite({
        jobRoot: fixture.jobRoot,
        jobId,
        sidecarInstanceId: candidate.instanceId,
        patchArtifactNonce: candidate.nonce,
        patchArtifactDirectoryIdentity: fixture.directoryIdentity,
        candidateIdentity: candidate.candidateIdentity,
        patchSha256: sha256(Buffer.from(patch)),
        patchBytes: Buffer.byteLength(patch)
    });
    assert.equal(fs.existsSync(candidate.candidatePath), true, "candidate remains until completed meta is durable");
    assert.equal(sha256(fs.readFileSync(published.patchPath)), sha256(Buffer.from(patch)));
    assert.equal(fs.statSync(published.patchPath).size, Buffer.byteLength(patch));
    assert.equal(published.publicIdentity.dev, candidate.candidateIdentity.dev);
    assert.equal(published.publicIdentity.ino, candidate.candidateIdentity.ino);
    assert.equal(parsed.fileCount, 1);
    const second = candidateFixture(fixture, jobId, patch.replace("gamma", "delta"), "instance-a", createPatchArtifactNonce());
    assertCode(() => publishCandidateNoOverwrite({
        jobRoot: fixture.jobRoot,
        jobId,
        sidecarInstanceId: second.instanceId,
        patchArtifactNonce: second.nonce,
        patchArtifactDirectoryIdentity: fixture.directoryIdentity,
        candidateIdentity: second.candidateIdentity,
        patchSha256: sha256(Buffer.from(patch.replace("gamma", "delta"))),
        patchBytes: Buffer.byteLength(patch.replace("gamma", "delta"))
    }), "AICW_PATCH_FILE_WRITE_FAILED");
    assert.equal(fs.readFileSync(published.patchPath, "utf8"), patch);
});

test("rejects outward and inward patches junctions before candidate creation", t => {
    for (const direction of ["outward", "inward"]) {
        const jobRoot = path.join(suiteRoot, `link-root-${direction}-${nextRepo++}`);
        const target = direction === "outward"
            ? path.join(suiteRoot, `link-target-${nextRepo++}`)
            : path.join(jobRoot, "inside-target");
        fs.mkdirSync(jobRoot, { recursive: true });
        fs.mkdirSync(target, { recursive: true });
        try {
            fs.symlinkSync(target, path.join(jobRoot, "patches"), "junction");
        } catch (error) {
            if (["EPERM", "EACCES", "UNKNOWN"].includes(error?.code)) {
                t.diagnostic(`junction creation unavailable: ${error.code}`);
                return;
            }
            throw error;
        }
        assertCode(() => pinPatchArtifactDirectory(jobRoot, { create: true }), "AICW_PATCH_ARTIFACT_DIR_UNSAFE");
    }
});

test("detects pinned directory replacement before candidate create", () => {
    const fixture = artifactFixture("candidate-drift");
    assertCode(() => candidateFixture(fixture, "job_candidate_drift", rawPatch(), "instance-a", createPatchArtifactNonce(), {
        beforeCandidateCreate: () => replaceArtifactDirectory(fixture, "candidate-old")
    }), "AICW_PATCH_ARTIFACT_DIR_DRIFT");
});

test("detects pinned directory replacement before publish", () => {
    const fixture = artifactFixture("publish-drift");
    const patch = rawPatch();
    const candidate = candidateFixture(fixture, "job_publish_drift", patch);
    assertCode(() => publishCandidateNoOverwrite({
        jobRoot: fixture.jobRoot,
        jobId: "job_publish_drift",
        sidecarInstanceId: candidate.instanceId,
        patchArtifactNonce: candidate.nonce,
        patchArtifactDirectoryIdentity: fixture.directoryIdentity,
        candidateIdentity: candidate.candidateIdentity,
        patchSha256: sha256(Buffer.from(patch)),
        patchBytes: Buffer.byteLength(patch)
    }, { hooks: { beforePublish: () => replaceArtifactDirectory(fixture, "publish-old") } }), "AICW_PATCH_ARTIFACT_DIR_DRIFT");
});

test("post-publish authorization verifies regular identity hash and bytes", () => {
    const fixture = artifactFixture("authorize");
    const patch = rawPatch();
    const jobId = "job_authorize";
    const candidate = candidateFixture(fixture, jobId, patch);
    const published = publishCandidateNoOverwrite({
        jobRoot: fixture.jobRoot,
        jobId,
        sidecarInstanceId: candidate.instanceId,
        patchArtifactNonce: candidate.nonce,
        patchArtifactDirectoryIdentity: fixture.directoryIdentity,
        candidateIdentity: candidate.candidateIdentity,
        patchSha256: sha256(Buffer.from(patch)),
        patchBytes: Buffer.byteLength(patch)
    });
    const inspected = inspectPatchArtifactFile(published.patchPath, fixture.directoryIdentity, {
        jobRoot: fixture.jobRoot,
        expectedIdentity: candidate.candidateIdentity,
        expectedSha256: sha256(Buffer.from(patch)),
        expectedBytes: Buffer.byteLength(patch)
    });
    assert.equal(inspected.identity.ino, candidate.candidateIdentity.ino);
    assert.equal(inspectAuthorizedPatchArtifact(fixture.jobRoot, jobId, completedPatchMeta(jobId, fixture, patch)).authorized, true);
});

test("public replacement and completed artifact tamper are never authorized", () => {
    for (const mode of ["replace", "tamper"]) {
        const fixture = artifactFixture(`unauthorized-${mode}`);
        const patch = rawPatch();
        const jobId = `job_unauthorized_${mode}`;
        const candidate = candidateFixture(fixture, jobId, patch);
        publishCandidateNoOverwrite({
            jobRoot: fixture.jobRoot, jobId, sidecarInstanceId: candidate.instanceId,
            patchArtifactNonce: candidate.nonce, patchArtifactDirectoryIdentity: fixture.directoryIdentity,
            candidateIdentity: candidate.candidateIdentity, patchSha256: sha256(Buffer.from(patch)), patchBytes: Buffer.byteLength(patch)
        });
        const meta = completedPatchMeta(jobId, fixture, patch);
        const publicPath = jobPaths(fixture.jobRoot, jobId).patchPath;
        if (mode === "replace") {
            fs.renameSync(publicPath, `${publicPath}.original`);
            fs.writeFileSync(publicPath, patch, "utf8");
        } else {
            fs.writeFileSync(publicPath, patch.replace("gamma", "tampered"), "utf8");
        }
        const result = inspectAuthorizedPatchArtifact(fixture.jobRoot, jobId, meta);
        assert.equal(result.authorized, false);
        assert.equal(result.patchPath, null);
    }
});

test("candidate cleanup is exact to job instance and nonce", () => {
    const fixture = artifactFixture("ownership");
    const patch = rawPatch();
    const owned = candidateFixture(fixture, "job_owned", patch, "dead-instance", "111111111111111111111111");
    const otherInstance = candidateFixture(fixture, "job_owned", patch, "live-instance", "222222222222222222222222");
    const otherNonce = candidateFixture(fixture, "job_owned", patch, "dead-instance", "333333333333333333333333");
    const otherJob = candidateFixture(fixture, "job_other", patch, "dead-instance", "111111111111111111111111");
    assert.equal(removePatchArtifactExact(owned.candidatePath, fixture.directoryIdentity, {
        jobRoot: fixture.jobRoot,
        expectedIdentity: owned.candidateIdentity,
        expectedSha256: sha256(Buffer.from(patch)),
        expectedBytes: Buffer.byteLength(patch)
    }), true);
    assert.equal(fs.existsSync(owned.candidatePath), false);
    for (const candidate of [otherInstance, otherNonce, otherJob]) assert.equal(fs.existsSync(candidate.candidatePath), true);
    assert.equal(path.basename(otherNonce.candidatePath), path.basename(patchCandidatePath(fixture.jobRoot, "job_owned", "dead-instance", otherNonce.nonce)));
});

test("replacement after hash check is preserved and cleanup fails closed", () => {
    const fixture = artifactFixture("cleanup-race");
    const patch = rawPatch();
    const publicPath = jobPaths(fixture.jobRoot, "job_cleanup_race").patchPath;
    fs.writeFileSync(publicPath, patch, { encoding: "utf8", mode: 0o600 });
    let injected = false;
    const removed = removePatchArtifactExact(publicPath, fixture.directoryIdentity, {
        jobRoot: fixture.jobRoot,
        expectedSha256: sha256(Buffer.from(patch)),
        expectedBytes: Buffer.byteLength(patch),
        hooks: {
            afterArtifactHashCheck: () => {
                if (injected) return;
                injected = true;
                fs.renameSync(publicPath, `${publicPath}.verified`);
                fs.writeFileSync(publicPath, "replacement", "utf8");
            }
        }
    });
    assert.equal(removed, false);
    assert.equal(fs.readFileSync(publicPath, "utf8"), "replacement");
});

test("duplicate target sections count once and UTF-8 bytes are exact", () => {
    const duplicate = `${rawPatch()}${rawPatch()}`;
    assert.equal(parseUnifiedDiff(duplicate).fileCount, 1);
    const multibyte = rawPatch("tracked.txt", "多字节-🙂");
    const fixture = artifactFixture("utf8-bytes");
    const candidate = candidateFixture(fixture, "job_utf8", multibyte);
    const inspected = inspectPatchArtifactFile(candidate.candidatePath, fixture.directoryIdentity, {
        jobRoot: fixture.jobRoot,
        expectedSha256: sha256(Buffer.from(multibyte, "utf8")),
        expectedBytes: Buffer.byteLength(multibyte, "utf8")
    });
    assert.equal(inspected.bytes, Buffer.byteLength(multibyte, "utf8"));
    assert.notEqual(inspected.bytes, multibyte.length);
    assert.deepEqual(verifyPatchArtifactDirectory(fixture.jobRoot, fixture.directoryIdentity), fixture.directoryIdentity);
});

test("baseline monitor close rejects drift after the last stable assertion", async () => {
    const repoRoot = createRepo();
    const baseline = await captureGitBaseline(repoRoot);
    const monitor = startGitBaselineMonitor(repoRoot, baseline, {
        intervalMs: 60000,
        watch() {
            return {
                on() { return this; },
                close() {}
            };
        }
    });
    await monitor.assertStable();
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "alpha\ndrifted\n", "utf8");
    await assert.rejects(
        monitor.close(),
        error => error?.code === "AICW_PATCH_BASELINE_DRIFT"
    );
});

test("bounds Git command timeout and output without returning command output", async () => {
    const repoRoot = createRepo();
    await assertRejectCode(runGit(repoRoot, ["-e", "setTimeout(() => {}, 1000)"], {
        gitBin: process.execPath,
        timeoutMs: 50,
        outputLimit: 256
    }), "AICW_PATCH_GIT_TIMEOUT");
    await assertRejectCode(runGit(repoRoot, ["-e", "process.stdout.write('x'.repeat(4096))"], {
        gitBin: process.execPath,
        timeoutMs: 1000,
        outputLimit: 256
    }), "AICW_PATCH_GIT_OUTPUT_LIMIT");
});
