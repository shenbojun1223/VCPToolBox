"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const {
    normalizeFastMode,
    appendCodexFastModeArgs
} = require("../AICodeWorker");
const {
    CodexAppServerProcess,
    normalizeServiceTierOverride
} = require("../appserver/codexAppServerProcess");

test("fastMode uses strict tri-state semantics", () => {
    for (const value of [undefined, null, ""]) {
        assert.deepEqual(normalizeFastMode(value), {
            status: "success",
            provided: false,
            value: null,
            serviceTier: null
        });
    }
    for (const value of [true, "true", " TRUE "]) {
        assert.deepEqual(normalizeFastMode(value), {
            status: "success",
            provided: true,
            value: true,
            serviceTier: "fast"
        });
    }
    for (const value of [false, "false", " FALSE "]) {
        assert.deepEqual(normalizeFastMode(value), {
            status: "success",
            provided: true,
            value: false,
            serviceTier: "default"
        });
    }
    for (const value of ["yes", "fast", 1, {}, []]) {
        assert.equal(normalizeFastMode(value).status, "error");
    }
});

test("legacy Codex exec receives exact Fast mode config overrides", () => {
    const inherited = ["exec"];
    appendCodexFastModeArgs(inherited, null, null);
    assert.deepEqual(inherited, ["exec"]);

    const fast = ["exec"];
    appendCodexFastModeArgs(fast, true, "fast");
    assert.deepEqual(fast, [
        "exec",
        "-c", "service_tier=\"fast\"",
        "-c", "features.fast_mode=true"
    ]);

    const standard = ["exec"];
    appendCodexFastModeArgs(standard, false, "default");
    assert.deepEqual(standard, [
        "exec",
        "-c", "service_tier=\"default\""
    ]);
});

test("app-server service tier accepts only fast, default, or omission", () => {
    assert.equal(normalizeServiceTierOverride(undefined), null);
    assert.equal(normalizeServiceTierOverride(""), null);
    assert.equal(normalizeServiceTierOverride(" FAST "), "fast");
    assert.equal(normalizeServiceTierOverride("DEFAULT"), "default");
    assert.throws(
        () => normalizeServiceTierOverride("priority"),
        error => error?.code === "CODEX_SERVICE_TIER_INVALID"
    );
});

test("Codex app-server transport sends serviceTier only when overridden", async () => {
    const requests = [];
    const codex = new CodexAppServerProcess();
    codex.closed = false;
    codex.connection = {
        request: async (method, params) => {
            requests.push({ method, params });
            if (method === "thread/start") return { thread: { id: `thread-${requests.length}` } };
            if (method === "turn/start") return { turn: { id: `turn-${requests.length}` } };
            throw new Error(`unexpected method ${method}`);
        }
    };

    const projectPath = path.resolve(__dirname);
    const fastThread = await codex.startThread({
        projectPath,
        model: "fixture-model",
        serviceTier: "fast"
    });
    await codex.startTurn({
        threadId: fastThread.id,
        text: "fast",
        effort: "high",
        serviceTier: "fast"
    });
    const standardThread = await codex.startThread({
        projectPath,
        serviceTier: "default"
    });
    await codex.startTurn({
        threadId: standardThread.id,
        text: "standard",
        serviceTier: "default"
    });
    const inheritedThread = await codex.startThread({ projectPath });
    await codex.startTurn({
        threadId: inheritedThread.id,
        text: "inherit"
    });

    assert.equal(requests[0].params.serviceTier, "fast");
    assert.equal(requests[1].params.serviceTier, "fast");
    assert.equal(requests[2].params.serviceTier, "default");
    assert.equal(requests[3].params.serviceTier, "default");
    assert.equal(Object.prototype.hasOwnProperty.call(requests[4].params, "serviceTier"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(requests[5].params, "serviceTier"), false);
});