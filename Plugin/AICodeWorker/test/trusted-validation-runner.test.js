"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const {
    TrustedValidationRunner,
    TrustedValidationError
} = require("../appserver/trustedValidationRunner");
const { getProcessIdentity, isPidAlive, terminateOwnedChild } = require("../appserver/protocol");

const fixtureExecutable = fs.realpathSync.native(process.execPath);
const fixtureScript = fs.realpathSync.native(path.join(__dirname, "fixtures", "fake-trusted-validation-command.js"));
const suiteRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "vcp-aicodeworker-trusted-validation-")));
const observedPids = new Set();
const temporaryMarkers = new Set();
let nextWorktree = 1;

after(async () => {
    for (const pid of observedPids) {
        assert.equal(isPidAlive(pid), false, `fixture child ${pid} must not remain alive`);
    }
    for (const marker of temporaryMarkers) {
        try { fs.rmSync(marker, { force: true }); } catch {}
    }
    assert.equal(
        [...temporaryMarkers].filter(marker => fs.existsSync(marker)).length,
        0,
        "all fixture marker files must be removed"
    );
    fs.rmSync(suiteRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    assert.equal(fs.existsSync(suiteRoot), false, "trusted validation suite temp root must be removed");
});

function createWorktree() {
    const directory = path.join(suiteRoot, `worktree-${nextWorktree++}`);
    fs.mkdirSync(directory, { recursive: true });
    return fs.realpathSync.native(directory);
}

function fixtureStep(name, args, overrides = {}) {
    return {
        name,
        display: overrides.display || `Run ${name}`,
        executable: overrides.executable || fixtureExecutable,
        args: [fixtureScript, ...args],
        timeoutMs: overrides.timeoutMs || 5000
    };
}

function createRunner(steps, options = {}) {
    return new TrustedValidationRunner({
        profiles: { trusted: { steps } },
        ...options
    });
}

async function rejectCode(promise, code) {
    let caught = null;
    try {
        await promise;
    } catch (error) {
        caught = error;
    }
    assert.ok(caught instanceof TrustedValidationError, `expected TrustedValidationError ${code}`);
    assert.equal(caught.code, code);
    return caught;
}

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("timed out waiting for fixture state");
}

async function readObservedPid(marker) {
    temporaryMarkers.add(marker);
    await waitFor(() => fs.existsSync(marker));
    const pid = Number(fs.readFileSync(marker, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    observedPids.add(pid);
    return pid;
}

async function assertConfirmedDead(pid) {
    await waitFor(() => !isPidAlive(pid));
    assert.equal(isPidAlive(pid), false);
}

function removeMarker(marker) {
    fs.rmSync(marker, { force: true });
    temporaryMarkers.delete(marker);
}

function assertMarkersAbsent(...markers) {
    for (const marker of markers) {
        assert.equal(fs.existsSync(marker), false, `${path.basename(marker)} must not be created`);
        temporaryMarkers.delete(marker);
    }
}

test("runs one step and returns only a frozen safe projection", async () => {
    const worktreeRoot = createWorktree();
    const runner = createRunner([fixtureStep("unit", ["emit", "ok", "note"])]);
    const result = await runner.run({ profile: "trusted", worktreeRoot });

    assert.equal(result.schemaVersion, 1);
    assert.equal(result.profile, "trusted");
    assert.equal(result.passed, true);
    assert.equal(result.steps.length, 1);
    assert.deepEqual(result.steps[0], {
        name: "unit",
        display: "Run unit",
        status: "passed",
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdoutBytes: 2,
        stderrBytes: 4,
        stdoutSummary: "ok",
        stderrSummary: "note"
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.steps), true);
    assert.equal(Object.isFrozen(result.steps[0]), true);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(worktreeRoot), false);
    assert.equal(serialized.includes(fixtureExecutable), false);
    assert.equal(serialized.includes(fixtureScript), false);
});

test("runs multiple steps strictly serially", async () => {
    const worktreeRoot = createWorktree();
    const marker = path.join(worktreeRoot, "sequence.marker");
    temporaryMarkers.add(marker);
    const runner = createRunner([
        fixtureStep("first", ["sequence", marker, "first", "120"]),
        fixtureStep("second", ["sequence", marker, "second", "10"])
    ]);

    const result = await runner.run({ profile: "trusted", worktreeRoot });
    assert.deepEqual(result.steps.map(step => step.status), ["passed", "passed"]);
    assert.equal(fs.readFileSync(marker, "utf8"), "start:first\nend:first\nstart:second\nend:second\n");
    removeMarker(marker);
});

test("uses the canonical worktree root as the fixed cwd and redacts it", async () => {
    const worktreeRoot = createWorktree();
    const runner = createRunner([fixtureStep("cwd", ["report", "", "argument"])]);
    const result = await runner.run({ profile: "trusted", worktreeRoot });
    const report = JSON.parse(result.steps[0].stdoutSummary);

    assert.equal(report.cwd, "[REDACTED_PATH]");
    assert.deepEqual(report.argv, ["argument"]);
    assert.equal(result.steps[0].stdoutSummary.includes(worktreeRoot), false);
});

test("deep-copies profiles so later source mutation cannot change execution", async () => {
    const worktreeRoot = createWorktree();
    const source = {
        trusted: {
            steps: [fixtureStep("immutable", ["emit", "original", ""])]
        }
    };
    const runner = new TrustedValidationRunner({ profiles: source });
    source.trusted.steps[0].args[2] = "mutated";
    source.trusted.steps[0].name = "changed";
    source.trusted.steps.push(fixtureStep("extra", ["emit", "extra", ""]));

    const result = await runner.run({ profile: "trusted", worktreeRoot });
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].name, "immutable");
    assert.equal(result.steps[0].stdoutSummary, "original");
});

test("rejects unknown profiles", async () => {
    const worktreeRoot = createWorktree();
    const runner = createRunner([fixtureStep("unit", ["emit", "ok", ""])]);
    await rejectCode(runner.run({ profile: "unknown", worktreeRoot }), "AICW_VALIDATION_PROFILE_UNKNOWN");
});

test("rejects every command-shaped or unsupported run field", async () => {
    const worktreeRoot = createWorktree();
    const runner = createRunner([fixtureStep("unit", ["emit", "ok", ""])]);
    const injected = {
        command: "ignored",
        executable: fixtureExecutable,
        args: [],
        cwd: worktreeRoot,
        env: {},
        shell: false
    };
    for (const [key, value] of Object.entries(injected)) {
        await rejectCode(
            runner.run({ profile: "trusted", worktreeRoot, [key]: value }),
            "AICW_VALIDATION_REQUEST_INVALID"
        );
    }
});

test("rejects non-native AbortSignal lookalikes before spawning", async t => {
    const cases = [
        ["plain object", { aborted: false }],
        ["prototype lookalike", Object.create(AbortSignal.prototype)]
    ];
    for (const [label, signal] of cases) {
        await t.test(label, async () => {
            const worktreeRoot = createWorktree();
            const startMarker = path.join(worktreeRoot, `${label.replaceAll(" ", "-")}.started`);
            const pidMarker = path.join(worktreeRoot, `${label.replaceAll(" ", "-")}.pid`);
            temporaryMarkers.add(startMarker);
            temporaryMarkers.add(pidMarker);
            const runner = createRunner([
                fixtureStep("must-not-start", ["start-markers", startMarker, pidMarker])
            ]);

            await rejectCode(
                runner.run({ profile: "trusted", worktreeRoot, signal }),
                "AICW_VALIDATION_REQUEST_INVALID"
            );
            assertMarkersAbsent(startMarker, pidMarker);
        });
    }
});

test("never calls custom AbortSignal listener methods", async () => {
    const worktreeRoot = createWorktree();
    const startMarker = path.join(worktreeRoot, "custom-signal.started");
    const pidMarker = path.join(worktreeRoot, "custom-signal.pid");
    temporaryMarkers.add(startMarker);
    temporaryMarkers.add(pidMarker);
    let addCalls = 0;
    let removeCalls = 0;
    const signal = {
        aborted: false,
        addEventListener() {
            addCalls++;
            throw new Error("custom add must not run");
        },
        removeEventListener() {
            removeCalls++;
            throw new Error("custom remove must not run");
        }
    };
    const runner = createRunner([
        fixtureStep("must-not-start", ["start-markers", startMarker, pidMarker])
    ]);

    await rejectCode(
        runner.run({ profile: "trusted", worktreeRoot, signal }),
        "AICW_VALIDATION_REQUEST_INVALID"
    );
    assert.equal(addCalls, 0);
    assert.equal(removeCalls, 0);
    assertMarkersAbsent(startMarker, pidMarker);
});

test("normalizes request Proxy reflection traps before spawning", async t => {
    for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) {
        await t.test(trap, async () => {
            const worktreeRoot = createWorktree();
            const startMarker = path.join(worktreeRoot, `${trap}.started`);
            const pidMarker = path.join(worktreeRoot, `${trap}.pid`);
            temporaryMarkers.add(startMarker);
            temporaryMarkers.add(pidMarker);
            const runner = createRunner([
                fixtureStep("must-not-start", ["start-markers", startMarker, pidMarker])
            ]);
            const request = new Proxy(
                { profile: "trusted", worktreeRoot },
                { [trap]: () => { throw new Error(`${trap} trap`); } }
            );

            await rejectCode(runner.run(request), "AICW_VALIDATION_REQUEST_INVALID");
            assertMarkersAbsent(startMarker, pidMarker);
        });
    }
});

test("normalizes profile and dense-array Proxy traps", () => {
    const profileProxy = new Proxy(
        { trusted: { steps: [fixtureStep("unit", ["emit", "ok", ""])] } },
        { ownKeys: () => { throw new Error("profile ownKeys trap"); } }
    );
    assert.throws(
        () => new TrustedValidationRunner({ profiles: profileProxy }),
        error => error instanceof TrustedValidationError && error.code === "AICW_VALIDATION_PROFILE_INVALID"
    );

    const stepsProxy = new Proxy(
        [fixtureStep("unit", ["emit", "ok", ""])],
        { ownKeys: () => { throw new Error("steps ownKeys trap"); } }
    );
    assert.throws(
        () => new TrustedValidationRunner({ profiles: { trusted: { steps: stepsProxy } } }),
        error => error instanceof TrustedValidationError && error.code === "AICW_VALIDATION_PROFILE_INVALID"
    );
});

test("rejects invalid executable paths including symlinks when supported", async t => {
    assert.throws(
        () => createRunner([fixtureStep("relative", ["emit", "", ""], { executable: "node" })]),
        error => error?.code === "AICW_VALIDATION_PROFILE_INVALID"
    );
    assert.throws(
        () => createRunner([fixtureStep("missing", ["emit", "", ""], {
            executable: path.join(suiteRoot, "missing-node.exe")
        })]),
        error => error?.code === "AICW_VALIDATION_PROFILE_INVALID"
    );

    const linkPath = path.join(suiteRoot, `node-link${path.extname(fixtureExecutable)}`);
    try {
        fs.symlinkSync(fixtureExecutable, linkPath, "file");
        temporaryMarkers.add(linkPath);
    } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
            t.skip("file symlink creation is unavailable on this host");
            return;
        }
        throw error;
    }
    assert.throws(
        () => createRunner([fixtureStep("linked", ["emit", "", ""], { executable: linkPath })]),
        error => error?.code === "AICW_VALIDATION_PROFILE_INVALID"
    );
    removeMarker(linkPath);
});

test("rejects non-canonical worktree roots", async () => {
    const worktreeRoot = createWorktree();
    const nonCanonical = `${worktreeRoot}${path.sep}.${path.sep}`;
    const runner = createRunner([fixtureStep("unit", ["emit", "ok", ""])]);
    await rejectCode(
        runner.run({ profile: "trusted", worktreeRoot: nonCanonical }),
        "AICW_VALIDATION_WORKTREE_INVALID"
    );
});

test("passes shell metacharacters as ordinary argv without creating a marker", async () => {
    const worktreeRoot = createWorktree();
    const marker = path.join(worktreeRoot, "shell.marker");
    temporaryMarkers.add(marker);
    const runner = createRunner([fixtureStep("argv", [
        "report", "", "plain", "&&", fixtureExecutable, fixtureScript, "marker", marker
    ])]);

    const result = await runner.run({ profile: "trusted", worktreeRoot });
    const report = JSON.parse(result.steps[0].stdoutSummary);
    assert.equal(report.argv.includes("&&"), true);
    assert.equal(fs.existsSync(marker), false);
    temporaryMarkers.delete(marker);
});

test("passes only the host allowlist plus fixed stable environment", async () => {
    const worktreeRoot = createWorktree();
    const names = [
        "PATH", "CI", "NO_COLOR", "GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS", "LANG", "LC_ALL",
        "NODE_OPTIONS", "PYTHONPATH", "RUBYOPT", "PERL5OPT", "GIT_CONFIG_COUNT", "HTTPS_PROXY",
        "OPENAI_API_KEY", "AICW_SECRET_TOKEN"
    ];
    const previous = new Map(names.map(name => [
        name,
        Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined
    ]));
    const fakeSecret = `not-a-real-secret-${"x".repeat(16)}`;
    try {
        process.env.NODE_OPTIONS = "--definitely-invalid-aicw-option";
        process.env.PYTHONPATH = fakeSecret;
        process.env.RUBYOPT = fakeSecret;
        process.env.PERL5OPT = fakeSecret;
        process.env.GIT_CONFIG_COUNT = "1";
        process.env.HTTPS_PROXY = `http://${fakeSecret}.invalid`;
        process.env.OPENAI_API_KEY = fakeSecret;
        process.env.AICW_SECRET_TOKEN = fakeSecret;
        const runner = createRunner([fixtureStep("env", ["report", names.join(",")])]);
        const result = await runner.run({ profile: "trusted", worktreeRoot });
        const env = JSON.parse(result.steps[0].stdoutSummary).env;

        assert.equal(typeof env.PATH, "string");
        assert.equal(env.PATH.length > 0, true);
        assert.equal(env.CI, "1");
        assert.equal(env.NO_COLOR, "1");
        assert.equal(env.GIT_TERMINAL_PROMPT, "0");
        assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
        assert.equal(env.LANG, "C.UTF-8");
        assert.equal(env.LC_ALL, "C.UTF-8");
        for (const name of names.slice(7)) assert.equal(env[name], null, `${name} must be excluded`);
        assert.equal(result.steps[0].stdoutSummary.includes(fakeSecret), false);
    } finally {
        for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test("counts stdout and stderr bytes and returns bounded redacted summaries", async () => {
    const worktreeRoot = createWorktree();
    const fakeBearer = `Bearer ${"b".repeat(24)}`;
    const fakeSk = `${"sk"}-${"c".repeat(24)}`;
    const fakeGithub = `${"ghp"}_${"d".repeat(24)}`;
    const stdout = `${fakeBearer} ${fakeSk} token=${"e".repeat(20)} ${"界".repeat(80)}`;
    const stderr = `${fakeGithub} password=${"f".repeat(20)} -----BEGIN PRIVATE KEY----- ${"g".repeat(30)}`;
    const runner = createRunner(
        [fixtureStep("redact", ["emit", stdout, stderr])],
        { summaryLimitChars: 160 }
    );
    const result = await runner.run({ profile: "trusted", worktreeRoot });
    const step = result.steps[0];

    assert.equal(step.stdoutBytes, Buffer.byteLength(stdout));
    assert.equal(step.stderrBytes, Buffer.byteLength(stderr));
    assert.ok(step.stdoutSummary.length <= 160);
    assert.ok(step.stderrSummary.length <= 160);
    for (const secret of [fakeBearer, fakeSk, fakeGithub, "e".repeat(20), "f".repeat(20), "BEGIN PRIVATE KEY"]) {
        assert.equal(`${step.stdoutSummary}\n${step.stderrSummary}`.includes(secret), false);
    }
    assert.match(step.stdoutSummary, /REDACTED/);
    assert.match(step.stderrSummary, /REDACTED/);
});

test("reports exact byte counts below the output limit", async () => {
    const worktreeRoot = createWorktree();
    const runner = createRunner([fixtureStep("bytes", ["bytes", "17", "13"])]);
    const result = await runner.run({ profile: "trusted", worktreeRoot });
    assert.equal(result.steps[0].stdoutBytes, 17);
    assert.equal(result.steps[0].stderrBytes, 13);
    assert.equal(result.steps[0].stdoutSummary, "x".repeat(17));
    assert.equal(result.steps[0].stderrSummary, "y".repeat(13));
});

test("non-zero exit fails and prevents later steps", async () => {
    const worktreeRoot = createWorktree();
    const marker = path.join(worktreeRoot, "later.marker");
    temporaryMarkers.add(marker);
    const runner = createRunner([
        fixtureStep("failure", ["exit", "7", "expected failure"]),
        fixtureStep("later", ["marker", marker, "must-not-run"])
    ]);
    const error = await rejectCode(
        runner.run({ profile: "trusted", worktreeRoot }),
        "AICW_VALIDATION_STEP_FAILED"
    );

    assert.equal(error.details.exitCode, 7);
    assert.equal(error.details.status, "failed");
    assert.equal(fs.existsSync(marker), false);
    temporaryMarkers.delete(marker);
});

test("reports a stable spawn failure if a registered executable disappears", async () => {
    const worktreeRoot = createWorktree();
    const copiedExecutable = path.join(suiteRoot, `vanishing-node${path.extname(fixtureExecutable)}`);
    fs.copyFileSync(fixtureExecutable, copiedExecutable);
    const canonicalCopy = fs.realpathSync.native(copiedExecutable);
    const runner = createRunner([
        fixtureStep("vanished", ["emit", "", ""], { executable: canonicalCopy })
    ]);
    fs.rmSync(canonicalCopy, { force: true });

    await rejectCode(
        runner.run({ profile: "trusted", worktreeRoot }),
        "AICW_VALIDATION_SPAWN_FAILED"
    );
});

test("step timeout confirms the owned child has exited", async () => {
    const worktreeRoot = createWorktree();
    const pidMarker = path.join(worktreeRoot, "timeout.pid");
    temporaryMarkers.add(pidMarker);
    const runner = createRunner([
        fixtureStep("timeout", ["hang", pidMarker], { timeoutMs: 300 })
    ]);
    const errorPromise = rejectCode(
        runner.run({ profile: "trusted", worktreeRoot }),
        "AICW_VALIDATION_STEP_TIMEOUT"
    );
    const pid = await readObservedPid(pidMarker);
    const error = await errorPromise;

    assert.equal(error.causeCode, "STEP_TIMEOUT");
    assert.equal(error.details.timedOut, true);
    await assertConfirmedDead(pid);
    removeMarker(pidMarker);
});

test("total timeout is capped independently of the profile step timeout", async () => {
    const worktreeRoot = createWorktree();
    const pidMarker = path.join(worktreeRoot, "total-timeout.pid");
    temporaryMarkers.add(pidMarker);
    const runner = createRunner(
        [fixtureStep("total", ["hang", pidMarker], { timeoutMs: 5000 })],
        { totalTimeoutMs: 250 }
    );
    const errorPromise = rejectCode(
        runner.run({ profile: "trusted", worktreeRoot }),
        "AICW_VALIDATION_STEP_TIMEOUT"
    );
    const pid = await readObservedPid(pidMarker);
    const error = await errorPromise;

    assert.equal(error.causeCode, "TOTAL_TIMEOUT");
    await assertConfirmedDead(pid);
    removeMarker(pidMarker);
});

test("AbortSignal cancellation confirms the owned child has exited", async () => {
    const worktreeRoot = createWorktree();
    const pidMarker = path.join(worktreeRoot, "cancel.pid");
    temporaryMarkers.add(pidMarker);
    const controller = new AbortController();
    const runner = createRunner([
        fixtureStep("cancel", ["hang", pidMarker], { timeoutMs: 5000 })
    ]);
    const errorPromise = rejectCode(
        runner.run({ profile: "trusted", worktreeRoot, signal: controller.signal }),
        "AICW_VALIDATION_CANCELLED"
    );
    const pid = await readObservedPid(pidMarker);
    controller.abort();
    const error = await errorPromise;

    assert.equal(error.causeCode, "ABORT_SIGNAL");
    assert.equal(error.details.timedOut, false);
    await assertConfirmedDead(pid);
    removeMarker(pidMarker);
});

test("stdout and stderr overflow each terminate and confirm the owned child", async t => {
    for (const stream of ["stdout", "stderr"]) {
        await t.test(stream, async () => {
            const worktreeRoot = createWorktree();
            const pidMarker = path.join(worktreeRoot, `${stream}-overflow.pid`);
            temporaryMarkers.add(pidMarker);
            const counts = stream === "stdout" ? ["200000", "0"] : ["0", "200000"];
            const runner = createRunner(
                [fixtureStep(`${stream}-overflow`, ["bytes", ...counts, pidMarker])],
                { outputLimitBytes: 1024 }
            );
            const errorPromise = rejectCode(
                runner.run({ profile: "trusted", worktreeRoot }),
                "AICW_VALIDATION_OUTPUT_LIMIT"
            );
            const pid = await readObservedPid(pidMarker);
            const error = await errorPromise;

            assert.equal(error.causeCode, stream === "stdout" ? "STDOUT_LIMIT" : "STDERR_LIMIT");
            assert.ok(error.details[`${stream}Bytes`] > 1024);
            await assertConfirmedDead(pid);
            removeMarker(pidMarker);
        });
    }
});

test("unconfirmed termination overrides timeout with its stable error", async () => {
    const worktreeRoot = createWorktree();
    const pidMarker = path.join(worktreeRoot, "unconfirmed.pid");
    temporaryMarkers.add(pidMarker);
    const runner = createRunner(
        [fixtureStep("unconfirmed", ["hang", pidMarker], { timeoutMs: 250 })],
        {
            terminationHelper: async (child, options) => {
                const actual = await terminateOwnedChild(child, options);
                assert.equal(actual.confirmed, true);
                return { ...actual, confirmed: false, stillAlive: true };
            }
        }
    );
    const errorPromise = rejectCode(
        runner.run({ profile: "trusted", worktreeRoot }),
        "AICW_VALIDATION_TERMINATION_UNCONFIRMED"
    );
    const pid = await readObservedPid(pidMarker);
    const error = await errorPromise;

    assert.equal(error.causeCode, "PROCESS_STILL_ALIVE");
    assert.equal(error.details.requestedCode, "AICW_VALIDATION_STEP_TIMEOUT");
    await assertConfirmedDead(pid);
    removeMarker(pidMarker);
});

test("strict Windows tree timeout removes the parent and descendant", {
    skip: process.platform !== "win32" && "requires Windows taskkill /T"
}, async () => {
    const worktreeRoot = createWorktree();
    const parentMarker = path.join(worktreeRoot, "tree-timeout-parent.pid");
    const descendantMarker = path.join(worktreeRoot, "tree-timeout-descendant.pid");
    temporaryMarkers.add(parentMarker);
    temporaryMarkers.add(descendantMarker);
    const runner = createRunner([
        fixtureStep("tree-timeout", ["tree-hang", parentMarker, descendantMarker], { timeoutMs: 500 })
    ]);
    const errorPromise = rejectCode(
        runner.run({ profile: "trusted", worktreeRoot }),
        "AICW_VALIDATION_STEP_TIMEOUT"
    );
    const parentPid = await readObservedPid(parentMarker);
    const descendantPid = await readObservedPid(descendantMarker);
    const error = await errorPromise;

    assert.equal(error.causeCode, "STEP_TIMEOUT");
    await assertConfirmedDead(parentPid);
    await assertConfirmedDead(descendantPid);
    removeMarker(parentMarker);
    removeMarker(descendantMarker);
});

test("strict Windows tree cancellation removes the parent and descendant", {
    skip: process.platform !== "win32" && "requires Windows taskkill /T"
}, async () => {
    const worktreeRoot = createWorktree();
    const parentMarker = path.join(worktreeRoot, "tree-cancel-parent.pid");
    const descendantMarker = path.join(worktreeRoot, "tree-cancel-descendant.pid");
    temporaryMarkers.add(parentMarker);
    temporaryMarkers.add(descendantMarker);
    const controller = new AbortController();
    const runner = createRunner([
        fixtureStep("tree-cancel", ["tree-hang", parentMarker, descendantMarker])
    ]);
    const errorPromise = rejectCode(
        runner.run({ profile: "trusted", worktreeRoot, signal: controller.signal }),
        "AICW_VALIDATION_CANCELLED"
    );
    const parentPid = await readObservedPid(parentMarker);
    const descendantPid = await readObservedPid(descendantMarker);
    controller.abort();
    const error = await errorPromise;

    assert.equal(error.causeCode, "ABORT_SIGNAL");
    await assertConfirmedDead(parentPid);
    await assertConfirmedDead(descendantPid);
    removeMarker(parentMarker);
    removeMarker(descendantMarker);
});

test("strict Windows tree termination refuses a missing identity", {
    skip: process.platform !== "win32" && "requires Windows strict process-tree semantics"
}, async () => {
    const worktreeRoot = createWorktree();
    const parentMarker = path.join(worktreeRoot, "tree-identity-parent.pid");
    const descendantMarker = path.join(worktreeRoot, "tree-identity-descendant.pid");
    temporaryMarkers.add(parentMarker);
    temporaryMarkers.add(descendantMarker);
    let strictTreeKillCalls = 0;
    let cleanupOutcome = null;
    const runner = createRunner(
        [fixtureStep("tree-identity", ["tree-hang", parentMarker, descendantMarker], { timeoutMs: 300 })],
        {
            identityProvider: () => null,
            terminationHelper: async (child, options) => {
                const refused = await terminateOwnedChild(child, {
                    ...options,
                    treeKill: () => {
                        strictTreeKillCalls++;
                        return true;
                    }
                });
                const cleanupIdentity = getProcessIdentity(child.pid);
                cleanupOutcome = await terminateOwnedChild(child, {
                    identity: cleanupIdentity,
                    requireProcessTree: true
                });
                return refused;
            }
        }
    );
    const errorPromise = rejectCode(
        runner.run({ profile: "trusted", worktreeRoot }),
        "AICW_VALIDATION_TERMINATION_UNCONFIRMED"
    );
    const parentPid = await readObservedPid(parentMarker);
    const descendantPid = await readObservedPid(descendantMarker);
    const error = await errorPromise;

    assert.equal(error.causeCode, "PROCESS_IDENTITY_UNAVAILABLE");
    assert.equal(error.details.requestedCode, "AICW_VALIDATION_STEP_TIMEOUT");
    assert.equal(strictTreeKillCalls, 0);
    assert.equal(cleanupOutcome?.confirmed, true);
    await assertConfirmedDead(parentPid);
    await assertConfirmedDead(descendantPid);
    removeMarker(parentMarker);
    removeMarker(descendantMarker);
});

test("constructor enforces conservative names, argv, and hard timeout caps", () => {
    assert.throws(
        () => new TrustedValidationRunner({ profiles: "not-an-object" }),
        error => error instanceof TrustedValidationError && error.code === "AICW_VALIDATION_PROFILE_INVALID"
    );
    assert.throws(
        () => new TrustedValidationRunner({ profiles: { "bad\nname": { steps: [] } } }),
        error => error?.code === "AICW_VALIDATION_PROFILE_INVALID"
    );
    assert.throws(
        () => createRunner([fixtureStep("bad-arg", ["emit", "line\nbreak", ""])]),
        error => error?.code === "AICW_VALIDATION_PROFILE_INVALID"
    );
    assert.throws(
        () => createRunner([fixtureStep("too-long", ["emit", "", ""], { timeoutMs: 300001 })]),
        error => error?.code === "AICW_VALIDATION_PROFILE_INVALID"
    );
    assert.throws(
        () => createRunner([fixtureStep("total-cap", ["emit", "", ""])], { totalTimeoutMs: 600001 }),
        error => error?.code === "AICW_VALIDATION_PROFILE_INVALID"
    );
});
