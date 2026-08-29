"use strict";

const fs = require("fs");
const readline = require("readline");

const versionArgument = process.argv.find(argument => argument.startsWith("--fake-version="));
const recordArgument = process.argv.find(argument => argument.startsWith("--fake-record-base64="));
const VERSION = versionArgument ? versionArgument.slice("--fake-version=".length) : "codex-cli 0.144.5";
const RECORD_PATH = recordArgument
    ? Buffer.from(recordArgument.slice("--fake-record-base64=".length), "base64").toString("utf8")
    : null;

if (process.argv.includes("--version") && !process.argv.includes("app-server")) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
}
if (!(process.argv.includes("app-server") && process.argv.includes("--stdio"))) {
    process.stderr.write("fake codex requires app-server --stdio\n");
    process.exit(2);
}

let nextThread = 1;
let nextTurn = 1;
const turns = new Map();

function record(value) {
    if (!RECORD_PATH) return;
    try { fs.appendFileSync(RECORD_PATH, `${JSON.stringify(value)}\n`, "utf8"); } catch {}
}

function send(message, omitJsonRpc = false) {
    const value = { ...message };
    if (omitJsonRpc) delete value.jsonrpc;
    process.stdout.write(`${JSON.stringify(value)}\n`);
}

function has(text, name) {
    return String(text || "").includes(`[[${name}]]`);
}

function control(text, name) {
    const match = String(text || "").match(new RegExp(`\\[\\[${name}=(\\d+)\\]\\]`));
    return match ? Number(match[1]) : null;
}

function finalText(text) {
    const encoded = String(text || "").match(/\[\[FINAL_BASE64=([A-Za-z0-9+/=]+)\]\]/);
    if (encoded) return Buffer.from(encoded[1], "base64").toString("utf8");
    const match = String(text || "").match(/\[\[FINAL=([^\]]*)\]\]/);
    return match ? match[1] : `fake-final:${String(text || "")}`;
}

function finishTurn(turn, status, omitJsonRpc = false) {
    if (turn.finished) return;
    turn.finished = true;
    for (const timer of turn.timers) clearTimeout(timer);
    turns.delete(turn.id);
    send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: turn.threadId, turn: { id: turn.id, status } }
    }, omitJsonRpc);
}

function emitStarted(turn) {
    if (turn.startedSent) return;
    turn.startedSent = true;
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: turn.threadId, turn: { id: turn.id, status: "inProgress" } } }, turn.noJsonRpc);
}

function emitDelta(turn) {
    if (turn.deltaSent || turn.failed) return;
    turn.deltaSent = true;
    for (let index = 0; index < turn.deltaCount; index++) {
        send({
            jsonrpc: "2.0",
            method: "item/agentMessage/delta",
            params: { threadId: turn.threadId, turnId: turn.id, itemId: `item-${turn.id}-${index}`, delta: turn.delta }
        }, turn.noJsonRpc);
    }
}

function emitResult(turn) {
    if (turn.finished) return;
    if (turn.failed) finishTurn(turn, "failed", turn.noJsonRpc);
    else {
        emitDelta(turn);
        finishTurn(turn, "completed", turn.noJsonRpc);
        const crashAfterCompleted = control(turn.text, "CRASH_AFTER_COMPLETED_MS");
        if (crashAfterCompleted !== null) setTimeout(() => process.exit(18), crashAfterCompleted);
        if (turn.deltaAfterCompleted) {
            send({
                jsonrpc: "2.0",
                method: "item/agentMessage/delta",
                params: { threadId: turn.threadId, turnId: turn.id, itemId: `late-${turn.id}`, delta: "late-delta" }
            }, turn.noJsonRpc);
        }
    }
}

function startTurn(request) {
    const text = request.params?.input?.[0]?.text || "";
    const threadId = request.params?.threadId;
    const turnId = `turn-${nextTurn++}`;
    if (String(threadId).includes("fake-thread-fail")) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "fake thread turn failure" } });
        return;
    }
    const turn = {
        id: turnId,
        threadId,
        text,
        delta: finalText(text),
        timers: [],
        finished: false,
        failed: has(text, "FAIL") || has(text, "FAILED_BEFORE_RESPONSE"),
        noJsonRpc: has(text, "NO_JSONRPC"),
        deltaCount: control(text, "DELTA_COUNT") || 1,
        conflictWhileActive: has(text, "CONFLICT_NOTIFICATION_WHILE_ACTIVE"),
        deltaAfterCompleted: has(text, "DELTA_AFTER_COMPLETED")
    };
    turns.set(turnId, turn);
    record({
        method: "turn/start",
        params: {
            threadId: request.params?.threadId,
            cwd: request.params?.cwd,
            sandboxPolicy: request.params?.sandboxPolicy,
            approvalPolicy: request.params?.approvalPolicy,
            model: request.params?.model,
            effort: request.params?.effort,
            inputTypes: Array.isArray(request.params?.input) ? request.params.input.map(item => item?.type) : []
        }
    });
    if (has(text, "NO_TURN_RESPONSE")) return;
    if (has(text, "INVALID_JSON")) process.stdout.write("{not-json\n");

    const responseError = has(text, "TURN_RESPONSE_ERROR_AFTER_EVENTS");
    const eventsBeforeResponse = has(text, "EVENTS_BEFORE_RESPONSE") || has(text, "TURN_RESPONSE_ERROR_AFTER_EVENTS");
    const deltaBeforeResponse = has(text, "DELTA_BEFORE_RESPONSE");
    const completedBeforeResponse = has(text, "COMPLETED_BEFORE_RESPONSE") || has(text, "FAILED_BEFORE_RESPONSE");
    const responseDelay = control(text, "TURN_RESPONSE_DELAY_MS") || 0;
    const workDelay = control(text, "DELAY_MS") || 0;

    if (eventsBeforeResponse || deltaBeforeResponse || completedBeforeResponse) {
        emitStarted(turn);
        if (deltaBeforeResponse || completedBeforeResponse || eventsBeforeResponse) emitDelta(turn);
        if (completedBeforeResponse || eventsBeforeResponse) emitResult(turn);
    }

    const sendResponse = () => {
        if (responseError) {
            send({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "fake turn response failed after events" } });
        } else {
            send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: has(text, "CONFLICT_TURN_ID") ? `conflict-${turnId}` : turnId, status: "inProgress" } } });
        }
        if (turn.conflictWhileActive) {
            turn.timers.push(setTimeout(() => send({
                jsonrpc: "2.0",
                method: "turn/started",
                params: { threadId: turn.threadId, turn: { id: `conflict-${turn.id}`, status: "inProgress" } }
            }, turn.noJsonRpc), 5));
        }
        if (has(text, "SERVER_REQUEST")) {
            send({
                jsonrpc: "2.0",
                id: `fake-server-request-${turn.id}`,
                method: "item/commandExecution/requestApproval",
                params: { threadId: turn.threadId, turnId: turn.id }
            });
        }
        if (!turn.finished && !(eventsBeforeResponse || completedBeforeResponse)) {
            turn.timers.push(setTimeout(() => {
                if (turn.finished) return;
                emitStarted(turn);
                turn.timers.push(setTimeout(() => emitResult(turn), workDelay));
            }, workDelay));
        }
    };
    if (eventsBeforeResponse || deltaBeforeResponse || completedBeforeResponse) {
        turn.timers.push(setTimeout(sendResponse, responseDelay));
    } else {
        turn.timers.push(setTimeout(sendResponse, responseDelay));
    }
    const crashAfter = control(text, "CRASH_AFTER_MS");
    if (crashAfter !== null) turn.timers.push(setTimeout(() => process.exit(17), crashAfter));
}

function handle(request) {
    if (request.id !== undefined && String(request.id).startsWith("fake-server-request-")) {
        const turnId = String(request.id).replace(/^fake-server-request-/, "");
        const turn = turns.get(turnId);
        send({ jsonrpc: "2.0", method: "fake/serverRequestHandled", params: {
            requestId: request.id, errorCode: request.error?.code ?? null, threadId: turn?.threadId, turnId
        }});
        return;
    }
    if (request.method === "initialize") {
        const info = request.params?.clientInfo;
        const capabilities = request.params?.capabilities;
        if (!info?.name || !info?.title || !info?.version || capabilities?.experimentalApi !== true || capabilities?.requestAttestation !== false) {
            send({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "initialize fields missing" } });
            return;
        }
        send({ jsonrpc: "2.0", id: request.id, result: { serverInfo: { name: "fake-codex", version: VERSION } } });
        send({ jsonrpc: "2.0", method: "fake/initializeValidated", params: { valid: true } });
        return;
    }
    if (request.method === "thread/start") {
        const cwd = String(request.params?.cwd || "");
        if (cwd.includes("fake-thread-fail")) {
            send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fake thread failure" } });
            return;
        }
        record({
            method: "thread/start",
            params: {
                cwd: request.params?.cwd,
                ephemeral: request.params?.ephemeral,
                sandbox: request.params?.sandbox,
                approvalPolicy: request.params?.approvalPolicy,
                model: request.params?.model
            }
        });
        const id = `thread-${nextThread++}`;
        send({ jsonrpc: "2.0", id: request.id, result: { thread: { id, cwd, status: "active" } } });
        return;
    }
    if (request.method === "turn/start") {
        startTurn(request);
        return;
    }
    if (request.method === "turn/interrupt") {
        const turn = turns.get(request.params?.turnId);
        send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: request.params?.turnId, status: "interrupted" } } });
        if (turn && !has(turn.text, "IGNORE_INTERRUPT")) {
            if (has(turn.text, "INTERRUPT_RACE_COMPLETE")) finishTurn(turn, "completed", turn.noJsonRpc);
            else finishTurn(turn, "interrupted", turn.noJsonRpc);
        }
        return;
    }
    if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "fake method not found" } });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line); } catch { return; }
    handle(request);
});
