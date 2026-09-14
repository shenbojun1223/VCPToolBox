"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { test } = require("node:test");
const express = require("express");

// Dedicated Node test process. Keep the override active until process exit.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-wire15-push-contract-"));
process.env.VCP_MOBILE_SYNC_LOG_DIR = path.join(dir, "logs");
const pluginDir = path.resolve(__dirname, "../Plugin/VCPChatSyncHub");
const logger = require(path.join(pluginDir, "core/logger"));
assert.equal(logger.getLogger().logDir, path.join(dir, "logs"));
const database = require(path.join(pluginDir, "core/db"));

function loadWireRoutes() {
  // An explicitly saved source snapshot permits red/green checks without
  // reverting or writing any running plugin source.
  const snapshot = process.env.VCP_SYNC_PUSH_SOURCE;
  if (!snapshot) return require(path.join(pluginDir, "wire14.js"));
  const filename = path.join(pluginDir, "wire14.js");
  const isolated = new Module(filename, module);
  isolated.filename = filename;
  isolated.paths = Module._nodeModulePaths(pluginDir);
  isolated._compile(fs.readFileSync(snapshot, "utf8"), filename);
  return isolated.exports;
}
const { registerWire14Routes } = loadWireRoutes();

function exactKeys(value, keys) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function wireError(value) {
  exactKeys(value, ["code", "origin", "stage", "kind", "retry", "message", "failedTopicIds"]);
  for (const key of ["code", "origin", "stage", "kind", "retry", "message"]) {
    assert.equal(typeof value[key], "string", key);
    assert.ok(value[key].length > 0, key);
  }
  assert.ok(Array.isArray(value.failedTopicIds));
  assert.ok(value.failedTopicIds.every(id => typeof id === "string"));
}
function mobileFrame(frame) {
  if (frame.kind === "topic") {
    const keys = ["kind", "ownerType", "ownerId", "topicId", "ok"];
    if (Object.hasOwn(frame, "error")) keys.push("error");
    exactKeys(frame, keys);
    assert.ok(["agent", "group"].includes(frame.ownerType));
    assert.equal(typeof frame.ownerId, "string");
    assert.equal(typeof frame.topicId, "string");
    assert.equal(typeof frame.ok, "boolean");
    if (!frame.ok) wireError(frame.error);
    else if (frame.error != null) wireError(frame.error);
  } else {
    assert.equal(frame.kind, "streamError", "Mobile discriminant must match Rust StreamError");
    exactKeys(frame, ["kind", "error"]);
    wireError(frame.error);
  }
  return frame;
}

test("message push HTTP responses honor mobile strict and desktop legacy contracts",
  { timeout: 15000 }, async t => {
    const appDataPath = path.join(dir, "AppData");
    const ownerId = "push-agent";
    const topicId = "push-topic";
    const otherOwner = "push-second-agent";
    const attachmentHash = "a".repeat(64);
    let server;
    const historyPath = (owner = ownerId, topic = topicId) =>
      path.join(appDataPath, "UserData", owner, "topics", topic, "history.json");
    const message = id => ({ id, role: "user", content: "Synthetic only", timestamp: 100 });
    const frame = (id, owner = ownerId, topic = topicId) => ({
      kind: "topic", ownerType: "agent", ownerId: owner, topicId: topic,
      messages: [message(id)], deletedMessages: [],
    });
    const body = frames => frames.map(item => JSON.stringify(item)).join("\n") + "\n";
    const history = async (owner = ownerId) => JSON.parse(await fsp.readFile(historyPath(owner), "utf8"));
    const exists = async id => (await history()).some(item => item.id === id);
    let base;
    async function post(raw, contract) {
      const response = await fetch(base + "/messages/push", {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          ...(contract === undefined ? {} : { "X-VCP-Sync-Contract": contract }),
        },
        body: raw,
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      const lines = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      return { status: response.status, lines, contentType: response.headers.get("content-type") };
    }
    try {
      for (const owner of [ownerId, otherOwner]) {
        const configPath = path.join(appDataPath, "Agents", owner, "config.json");
        await fsp.mkdir(path.dirname(configPath), { recursive: true });
        await fsp.mkdir(path.dirname(historyPath(owner)), { recursive: true });
        await fsp.writeFile(configPath, JSON.stringify({
          id: owner, name: "Synthetic fixture", topics: [{ id: topicId, name: "Fixture", createdAt: 1 }],
        }));
        await fsp.writeFile(historyPath(owner), "[]");
      }
      await fsp.mkdir(path.join(appDataPath, "UserData", "attachments"), { recursive: true });
      const db = database.initDb(path.join(dir, "sync_state.db"));
      assert.equal(path.resolve(db.name), path.join(dir, "sync_state.db"));
      const app = express();
      const router = express.Router();
      registerWire14Routes(router, { appDataPath });
      app.use("/fixture", router);
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      base = `http://127.0.0.1:${server.address().port}/fixture`;

      await t.test("mobile multi-owner success has exact keys and preserves compound identity", async () => {
        const response = await post(body([frame("first"), frame("second", otherOwner)]));
        assert.equal(response.status, 200);
        assert.match(response.contentType, /application\/x-ndjson/);
        assert.equal(response.lines.length, 2);
        response.lines.forEach(mobileFrame);
        assert.deepEqual(response.lines.map(row => [row.ownerId, row.topicId, row.ok]),
          [[ownerId, topicId, true], [otherOwner, topicId, true]]);
        assert.ok(await exists("first"));
        assert.ok((await history(otherOwner)).some(row => row.id === "second"));
      });

      await t.test("missing attachment metadata does not add fields to mobile success", async () => {
        const request = frame("mobile-attachment");
        request.messages[0].attachments = [{
          hash: attachmentHash, name: "fixture.txt", type: "text/plain", size: 3,
        }];
        const response = await post(body([request]));
        assert.equal(response.status, 200);
        assert.equal(response.lines.length, 1);
        mobileFrame(response.lines[0]);
        assert.equal(response.lines[0].ok, true);
        const saved = (await history()).find(row => row.id === "mobile-attachment");
        assert.equal(saved.attachments.length, 1);
        // This checks projection metadata, not transfer of the attachment binary.
      });

      await t.test("desktop success retains its missing-attachment response field", async () => {
        const request = frame("desktop-attachment");
        request.messages[0].attachments = [{
          hash: attachmentHash, name: "fixture.txt", type: "text/plain", size: 3,
        }];
        const response = await post(body([request]), "desktop-full-v1");
        assert.equal(response.status, 200);
        assert.equal(response.lines.length, 1);
        exactKeys(response.lines[0],
          ["kind", "ownerType", "ownerId", "topicId", "ok", "neededAttachmentHashes"]);
        assert.equal(response.lines[0].ok, true);
        assert.deepEqual(response.lines[0].neededAttachmentHashes, [attachmentHash]);
      });

      await t.test("mixed success and topic error remain strict and preserve successful writes", async () => {
        const response = await post(body([frame("mixed-good"), frame("missing", ownerId, "absent-topic")]));
        assert.equal(response.status, 200);
        assert.equal(response.lines.length, 2);
        response.lines.forEach(mobileFrame);
        assert.deepEqual(response.lines.map(row => row.ok), [true, false]);
        assert.deepEqual(response.lines[1].error.failedTopicIds, ["absent-topic"]);
        assert.ok(await exists("mixed-good"));
      });

      await t.test("mobile malformed suffix emits streamError after an already committed prefix", async () => {
        const response = await post(body([frame("mobile-prefix")]) + "{invalid-json\n");
        assert.equal(response.status, 200);
        assert.equal(response.lines.length, 2);
        response.lines.forEach(mobileFrame);
        assert.equal(response.lines[0].ok, true);
        assert.equal(response.lines[1].kind, "streamError");
        assert.ok(await exists("mobile-prefix"));
      });

      await t.test("desktop malformed suffix retains kind error recognized by its consumer", async () => {
        const response = await post(body([frame("desktop-prefix")]) + "{invalid-json\n", "desktop-full-v1");
        assert.equal(response.status, 200);
        assert.equal(response.lines.length, 2);
        assert.equal(response.lines[0].ok, true);
        assert.equal(response.lines[1].kind, "error");
        exactKeys(response.lines[1], ["kind", "error"]);
        wireError(response.lines[1].error);
        assert.ok(await exists("desktop-prefix"));
      });

      await t.test("malformed first frame returns structured HTTP error without writes", async () => {
        const before = await fsp.readFile(historyPath());
        const response = await post("{invalid-json\n");
        assert.equal(response.status, 400);
        assert.equal(response.lines.length, 1);
        exactKeys(response.lines[0], ["error"]);
        wireError(response.lines[0].error);
        assert.deepEqual(await fsp.readFile(historyPath()), before);
      });

      await t.test("unknown contract is rejected before mutation", async () => {
        const before = await fsp.readFile(historyPath());
        const response = await post(body([frame("invalid-contract-message")]), "invalid-contract");
        assert.equal(response.status, 400);
        exactKeys(response.lines[0], ["error"]);
        wireError(response.lines[0].error);
        assert.deepEqual(await fsp.readFile(historyPath()), before);
      });

      await t.test("replaying a successfully written prefix is idempotent", async () => {
        const request = body([frame("retry-stable")]);
        const first = await post(request);
        first.lines.forEach(mobileFrame);
        const before = await fsp.readFile(historyPath());
        const second = await post(request);
        second.lines.forEach(mobileFrame);
        assert.equal(second.lines[0].ok, true);
        assert.deepEqual(await fsp.readFile(historyPath()), before);
        assert.equal((await history()).filter(row => row.id === "retry-stable").length, 1);
      });

      await t.test("message tombstones still reject resurrection through strict error frames", async () => {
        await post(body([frame("tombstone-target")]));
        const deletion = frame("retained-after-delete");
        deletion.deletedMessages = [{ msgId: "tombstone-target", deletedAt: 1789350000000 }];
        const removed = await post(body([deletion]));
        removed.lines.forEach(mobileFrame);
        assert.equal(removed.lines[0].ok, true);
        assert.equal(await exists("tombstone-target"), false);
        const before = await fsp.readFile(historyPath());
        const stale = await post(body([frame("tombstone-target")]));
        stale.lines.forEach(mobileFrame);
        assert.equal(stale.lines[0].ok, false);
        assert.equal(stale.lines[0].error.code, "SYNC_SNAPSHOT_STALE");
        assert.deepEqual(await fsp.readFile(historyPath()), before);
      });
      assert.equal(logger.getLogger().logDir, path.join(dir, "logs"));
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      database.closeDb();
      logger.getLogger().endSession();
      console.log("PUSH_CONTRACT_FIXTURE=" + dir);
      // Retain synthetic artifacts for audit. No plugin data or production listener is used.
    }
  });