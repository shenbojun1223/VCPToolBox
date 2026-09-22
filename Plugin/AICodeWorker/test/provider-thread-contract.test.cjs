"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { CodexAppServerProcess } = require("../appserver/codexAppServerProcess");

const PROJECT_PATH = path.resolve(__dirname);
const PROVIDERS = [
    "aicw-deepseek-official",
    "aicw-deepseek-commandcode"
];

function providerThreadResponse(model, modelProvider, id = "thread-provider") {
    return {
        model,
        modelProvider,
        thread: { id, modelProvider, model: null }
    };
}

function createMemoryCodex(handler) {
    const calls = [];
    let stopCalls = 0;
    const codex = new CodexAppServerProcess();
    codex.closed = false;
    codex.connection = {
        request: async (method, params) => {
            calls.push({ method, params });
            return handler(method, params, calls.length);
        }
    };
    codex.stop = async () => { stopCalls++; };
    return {
        codex,
        calls,
        get stopCalls() { return stopCalls; }
    };
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

test("default Luna thread and turn keep the legacy RPC snapshot", async () => {
    const fixture = createMemoryCodex((method) => {
        if (method === "thread/start") return { thread: { id: "thread-luna" } };
        if (method === "turn/start") return { turn: { id: "turn-luna" } };
        throw new Error(`unexpected method ${method}`);
    });

    const thread = await fixture.codex.startThread({
        projectPath: PROJECT_PATH,
        model: "luna-model",
        serviceTier: "default"
    });
    const turn = await fixture.codex.startTurn({
        threadId: thread.id,
        text: "hello",
        effort: "max",
        serviceTier: "default"
    });

    assert.deepEqual(thread, { id: "thread-luna" });
    assert.deepEqual(turn, { id: "turn-luna" });
    assert.deepEqual(fixture.calls, [
        {
            method: "thread/start",
            params: {
                cwd: PROJECT_PATH,
                ephemeral: true,
                sandbox: "read-only",
                approvalPolicy: "never",
                model: "luna-model",
                serviceTier: "default"
            }
        },
        {
            method: "turn/start",
            params: {
                threadId: "thread-luna",
                input: [{ type: "text", text: "hello", text_elements: [] }],
                effort: "max",
                serviceTier: "default"
            }
        }
    ]);
    assert.equal(hasOwn(fixture.calls[0].params, "modelProvider"), false);
    assert.equal(hasOwn(fixture.calls[0].params, "allowProviderModelFallback"), false);
});

test("null modelProvider remains on the legacy path", async () => {
    const fixture = createMemoryCodex(method => {
        if (method === "thread/start") return { thread: { id: "thread-null-provider" } };
        throw new Error(`unexpected method ${method}`);
    });

    const thread = await fixture.codex.startThread({
        projectPath: PROJECT_PATH,
        modelProvider: null
    });

    assert.deepEqual(thread, { id: "thread-null-provider" });
    assert.deepEqual(fixture.calls, [{
        method: "thread/start",
        params: {
            cwd: PROJECT_PATH,
            ephemeral: true,
            sandbox: "read-only",
            approvalPolicy: "never"
        }
    }]);
});

test("each controlled provider is sent exactly for read-only and write threads", async () => {
    for (const modelProvider of PROVIDERS) {
        const fixture = createMemoryCodex((method, params, callNumber) => {
            if (method !== "thread/start") throw new Error(`unexpected method ${method}`);
            return providerThreadResponse(params.model, params.modelProvider, `thread-${callNumber}`);
        });
        const readModel = "deepseek/deepseek-chat";
        const writeModel = "deepseek/deepseek-reasoner";

        const readThread = await fixture.codex.startThread({
            projectPath: PROJECT_PATH,
            model: readModel,
            modelProvider,
            serviceTier: " FAST "
        });
        const writeThread = await fixture.codex.startThread({
            projectPath: PROJECT_PATH,
            model: writeModel,
            modelProvider,
            serviceTier: "default",
            writeMode: true
        });

        assert.equal(readThread.model, null);
        assert.equal(readThread.modelProvider, modelProvider);
        assert.equal(writeThread.model, null);
        assert.equal(writeThread.modelProvider, modelProvider);
        assert.deepEqual(fixture.calls, [
            {
                method: "thread/start",
                params: {
                    cwd: PROJECT_PATH,
                    ephemeral: true,
                    sandbox: "read-only",
                    approvalPolicy: "never",
                    model: readModel,
                    modelProvider,
                    allowProviderModelFallback: false,
                    serviceTier: "fast"
                }
            },
            {
                method: "thread/start",
                params: {
                    cwd: PROJECT_PATH,
                    ephemeral: true,
                    sandbox: "workspace-write",
                    approvalPolicy: "never",
                    model: writeModel,
                    modelProvider,
                    allowProviderModelFallback: false,
                    serviceTier: "default"
                }
            }
        ]);
    }
});

test("invalid providers and provider models are rejected before any RPC", async () => {
    const fixture = createMemoryCodex(() => {
        throw new Error("RPC must not be called");
    });

    for (const modelProvider of ["", " ", "\t", "other-provider", {}, [], 1]) {
        await assert.rejects(
            fixture.codex.startThread({ projectPath: PROJECT_PATH, model: "deepseek/model", modelProvider }),
            error => error?.code === "CODEX_MODEL_PROVIDER_INVALID"
        );
    }
    for (const model of [undefined, null, "", " ", " model", "model ", "\tmodel", "model\t", "model\n", "model\r", "model\0", 1, {}, []]) {
        await assert.rejects(
            fixture.codex.startThread({
                projectPath: PROJECT_PATH,
                model,
                modelProvider: PROVIDERS[0]
            }),
            error => error?.code === "CODEX_PROVIDER_MODEL_REQUIRED"
        );
    }
    assert.equal(fixture.calls.length, 0);
});

test("provider responses require matching top-level and thread identity", async () => {
    const modelProvider = PROVIDERS[0];
    const model = "deepseek/deepseek-chat";
    const validThread = { id: "thread-response", modelProvider, model: null };
    const cases = [
        { label: "missing top-level model", response: { modelProvider, thread: validThread } },
        { label: "wrong top-level model type", response: { model: {}, modelProvider, thread: validThread } },
        { label: "default top-level model", response: { model: "default-model", modelProvider, thread: validThread } },
        { label: "missing top-level provider", response: { model, thread: validThread } },
        { label: "wrong top-level provider type", response: { model, modelProvider: 1, thread: validThread } },
        { label: "mismatched top-level provider", response: { model, modelProvider: PROVIDERS[1], thread: validThread } },
        { label: "missing thread id", response: { model, modelProvider, thread: { modelProvider, model: null } } },
        { label: "missing thread provider", response: { model, modelProvider, thread: { id: validThread.id, model: null } } },
        { label: "wrong thread provider type", response: { model, modelProvider, thread: { id: validThread.id, modelProvider: {}, model: null } } },
        { label: "mismatched thread provider", response: { model, modelProvider, thread: { id: validThread.id, modelProvider: PROVIDERS[1], model: null } } }
    ];

    for (const { label, response } of cases) {
        const fixture = createMemoryCodex(() => response);
        await assert.rejects(
            fixture.codex.startThread({ projectPath: PROJECT_PATH, model, modelProvider }),
            error => error?.code === "CODEX_PROVIDER_ROUTE_UNCONFIRMED",
            label
        );
        assert.deepEqual(fixture.calls.map(call => call.method), ["thread/start"], label);
        assert.equal(fixture.stopCalls, 0, label);
    }
});

test("matching provider identity accepts a null thread.model without substituting it", async () => {
    const modelProvider = PROVIDERS[1];
    const model = "deepseek/deepseek-chat";
    const response = providerThreadResponse(model, modelProvider, "thread-null-model");
    const fixture = createMemoryCodex(() => response);

    const thread = await fixture.codex.startThread({
        projectPath: PROJECT_PATH,
        model,
        modelProvider
    });

    assert.strictEqual(thread, response.thread);
    assert.equal(thread.model, null);
    assert.equal(thread.modelProvider, modelProvider);
});

test("concurrent provider requests validate their own out-of-order responses", async () => {
    const pending = [];
    const fixture = createMemoryCodex((method, params) => {
        assert.equal(method, "thread/start");
        return new Promise(resolve => pending.push({ params, resolve }));
    });
    const first = {
        model: "deepseek/first",
        modelProvider: PROVIDERS[0]
    };
    const second = {
        model: "deepseek/second",
        modelProvider: PROVIDERS[1]
    };

    const firstPromise = fixture.codex.startThread({ ...first, projectPath: PROJECT_PATH });
    const secondPromise = fixture.codex.startThread({ ...second, projectPath: PROJECT_PATH });
    assert.equal(pending.length, 2);
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[0].params.modelProvider, first.modelProvider);
    assert.equal(fixture.calls[1].params.modelProvider, second.modelProvider);

    pending[1].resolve(providerThreadResponse(second.model, second.modelProvider, "thread-second"));
    pending[0].resolve(providerThreadResponse(first.model, first.modelProvider, "thread-first"));
    const [firstThread, secondThread] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(firstThread.id, "thread-first");
    assert.equal(firstThread.modelProvider, first.modelProvider);
    assert.equal(secondThread.id, "thread-second");
    assert.equal(secondThread.modelProvider, second.modelProvider);
});

test("RPC rejection is not retried and does not start a turn or stop the process", async () => {
    const fixture = createMemoryCodex(() => Promise.reject(new Error("synthetic RPC failure")));

    await assert.rejects(
        fixture.codex.startThread({
            projectPath: PROJECT_PATH,
            model: "deepseek/deepseek-chat",
            modelProvider: PROVIDERS[0]
        }),
        /synthetic RPC failure/
    );
    assert.deepEqual(fixture.calls.map(call => call.method), ["thread/start"]);
    assert.equal(fixture.stopCalls, 0);
});
