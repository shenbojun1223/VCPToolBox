"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const {
    AICW_PROVIDER_FINALIZATION_UNCONFIRMED,
    DEFAULT_PROVIDER_STOP_TIMEOUT_MS,
    ProviderExecutionLifecycle,
    createProviderExecutionLifecycle
} = require("../appserver/providerExecutionLifecycle");
const { SidecarError } = require("../appserver/protocol");

function fakeExecution(stop) {
    const execution = new EventEmitter();
    execution.stop = stop;
    return execution;
}

function assertUnconfirmed(promise) {
    return assert.rejects(promise, error => {
        assert.ok(error instanceof SidecarError);
        assert.equal(error.code, AICW_PROVIDER_FINALIZATION_UNCONFIRMED);
        return true;
    });
}

test("first stop passes suppressClosed and confirms only confirmed:true", async () => {
    const calls = [];
    const execution = fakeExecution(options => {
        calls.push(options);
        return Promise.resolve({ confirmed: true, source: "fake" });
    });
    const lifecycle = createProviderExecutionLifecycle(execution);

    const result = await lifecycle.stop();

    assert.deepEqual(calls, [{ suppressClosed: true }]);
    assert.deepEqual(result, { confirmed: true, source: "fake" });
    assert.equal(lifecycle.status, "stopped");
    assert.equal(lifecycle.stopped, true);
    assert.equal(lifecycle.confirmed, true);
    assert.equal(lifecycle.stopTimeoutMs, DEFAULT_PROVIDER_STOP_TIMEOUT_MS);
});

test("concurrent stop calls share one Promise and invoke execution.stop once", async () => {
    let resolveStop;
    let stopCalls = 0;
    const stopResult = new Promise(resolve => { resolveStop = resolve; });
    const execution = fakeExecution(options => {
        stopCalls++;
        assert.deepEqual(options, { suppressClosed: true });
        return stopResult;
    });
    const lifecycle = new ProviderExecutionLifecycle(execution, { stopTimeoutMs: 1000 });

    const first = lifecycle.stop();
    const second = lifecycle.stop();

    assert.strictEqual(first, second);
    assert.equal(stopCalls, 1);
    resolveStop({ confirmed: true });
    await first;
    assert.equal(lifecycle.confirmed, true);
});

test("a repeated stop after confirmation reuses the same settled Promise", async () => {
    const execution = fakeExecution(() => Promise.resolve({ confirmed: true }));
    const lifecycle = new ProviderExecutionLifecycle(execution);

    const first = lifecycle.stop();
    await first;
    const second = lifecycle.stop();

    assert.strictEqual(first, second);
    assert.equal(lifecycle.confirmed, true);
});

test("confirmed:false and other non-confirming results stay unconfirmed", async () => {
    for (const result of [{ confirmed: false }, undefined, true, null]) {
        let stopCalls = 0;
        const execution = fakeExecution(() => {
            stopCalls++;
            return Promise.resolve(result);
        });
        const lifecycle = new ProviderExecutionLifecycle(execution);
        const first = lifecycle.stop();

        await assertUnconfirmed(first);
        await assertUnconfirmed(lifecycle.stop());
        assert.equal(stopCalls, 1);
        assert.equal(lifecycle.status, "unconfirmed");
        assert.equal(lifecycle.stopped, false);
        assert.equal(lifecycle.confirmed, false);
    }
});

test("stop rejection is mapped to the stable unconfirmed error code", async () => {
    const execution = fakeExecution(() => Promise.reject(new Error("private lower-level detail")));
    const lifecycle = new ProviderExecutionLifecycle(execution);
    const first = lifecycle.stop();

    await assertUnconfirmed(first);
    await assertUnconfirmed(lifecycle.stop());
    assert.equal(lifecycle.confirmed, false);
});

test("stop timeout is bounded, unconfirmed, and ignores a late confirmation", async () => {
    let resolveStop;
    const stopResult = new Promise(resolve => { resolveStop = resolve; });
    const execution = fakeExecution(() => stopResult);
    const lifecycle = new ProviderExecutionLifecycle(execution, { stopTimeoutMs: 10 });
    const first = lifecycle.stop();
    const keepTestProcessAlive = setTimeout(() => {}, 100);

    try {
        await assertUnconfirmed(first);
        resolveStop({ confirmed: true });
        await Promise.resolve();

        assert.equal(lifecycle.status, "unconfirmed");
        assert.equal(lifecycle.stopped, false);
        assert.equal(lifecycle.confirmed, false);
        assert.strictEqual(lifecycle.stop(), first);
    } finally {
        clearTimeout(keepTestProcessAlive);
    }
});

test("attach forwards event arguments once and duplicate attach does not duplicate callbacks", () => {
    const execution = fakeExecution(() => Promise.resolve({ confirmed: true }));
    const lifecycle = new ProviderExecutionLifecycle(execution);
    const received = [];
    const listener = (...args) => received.push(args);

    lifecycle.attach("notification", listener);
    lifecycle.attach("notification", listener);
    assert.equal(execution.listenerCount("notification"), 1);

    const payload = { value: 7 };
    execution.emit("notification", "event-name", payload);

    assert.deepEqual(received, [["event-name", payload]]);
});

test("detach is idempotent and does not remove an unrelated listener", () => {
    const execution = fakeExecution(() => Promise.resolve({ confirmed: true }));
    const lifecycle = new ProviderExecutionLifecycle(execution);
    let forwarded = 0;
    let unrelated = 0;
    const listener = () => { forwarded++; };
    const otherListener = () => { unrelated++; };

    execution.on("event", otherListener);
    lifecycle.attach("event", listener);
    lifecycle.detach("event", listener);
    lifecycle.detach("event", listener);
    execution.emit("event");

    assert.equal(forwarded, 0);
    assert.equal(unrelated, 1);
    assert.equal(execution.listenerCount("event"), 1);
});

test("listener state is isolated per execution instance", () => {
    const firstExecution = fakeExecution(() => Promise.resolve({ confirmed: true }));
    const secondExecution = fakeExecution(() => Promise.resolve({ confirmed: true }));
    const first = new ProviderExecutionLifecycle(firstExecution);
    const second = new ProviderExecutionLifecycle(secondExecution);
    let firstEvents = 0;
    let secondEvents = 0;
    const listener = () => { firstEvents++; secondEvents++; };

    first.attach("event", listener);
    second.attach("event", listener);
    first.detach("event", listener);
    firstExecution.emit("event");
    secondExecution.emit("event");

    assert.equal(firstEvents, 1);
    assert.equal(secondEvents, 1);
});

test("lifecycle never starts a process or reads execution credentials", async () => {
    let startCalls = 0;
    let credentialReads = 0;
    const execution = fakeExecution(() => Promise.resolve({ confirmed: true }));
    execution.start = () => {
        startCalls++;
        throw new Error("real process start is forbidden in this test");
    };
    Object.defineProperty(execution, "credentials", {
        get() {
            credentialReads++;
            throw new Error("credential access is forbidden in this test");
        }
    });

    await createProviderExecutionLifecycle(execution).stop();

    assert.equal(startCalls, 0);
    assert.equal(credentialReads, 0);
});
