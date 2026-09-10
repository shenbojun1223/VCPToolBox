"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const WebSocket = require("ws");

function hash(value) {
  const sorted = Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]]));
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
function root(hashes) {
  return hashes.length
    ? crypto.createHash("sha256").update([...hashes].sort().join("")).digest("hex")
    : "";
}
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function connect(url) {
  const deadline = Date.now() + 8000;
  while (true) {
    const socket = new WebSocket(url);
    try {
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      return socket;
    } catch (error) {
      socket.terminate();
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
}
function request(socket, payload, expectedType) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    const fail = error => { cleanup(); reject(error); };
    const onClose = () => fail(new Error("Socket closed before " + expectedType));
    const onMessage = data => {
      let result;
      try { result = JSON.parse(data.toString()); }
      catch (error) { fail(error); return; }
      if (result.type === "SYNC_ERROR") {
        fail(new Error(JSON.stringify(result)));
      } else if (result.type === expectedType) {
        cleanup();
        resolve(result);
      }
    };
    const timer = setTimeout(() => fail(new Error("Timeout: " + expectedType)), 8000);
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.send(JSON.stringify(payload), error => { if (error) fail(error); });
  });
}

test("Wire 1.5 handshake and mobile HTTP contract coexist with desktop Wire 1.4",
  { timeout: 25000 }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vcp-wire15-session-"));
    const previousLogDir = process.env.VCP_MOBILE_SYNC_LOG_DIR;
    process.env.VCP_MOBILE_SYNC_LOG_DIR = path.join(dir, "logs");
    let hub, server, mobile, desktop;
    try {
      hub = require("../Plugin/VCPChatSyncHub");
      const appDataPath = path.join(dir, "AppData");
      const ownerId = "session-agent";
      const topicId = "default";
      const identity = { ownerType: "agent", ownerId };
      const dto = {
        name: "Synthetic session", systemPrompt: "Fixture only", model: "fixture",
        temperature: 0.7, contextTokenLimit: 12345,
        maxOutputTokens: 6789, streamOutput: true,
      };
      const topic = { id: topicId, name: "Topic", createdAt: 1, locked: true, unread: false };
      const message = { id: "session-message", role: "user", content: "Synthetic", timestamp: 10 };
      const configPath = path.join(appDataPath, "Agents", ownerId, "config.json");
      const historyPath = path.join(appDataPath, "UserData", ownerId, "topics", topicId, "history.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ ...dto, customCss: "fixture", topics: [topic] }));
      await fs.writeFile(historyPath, JSON.stringify([message]));
      const beforeConfig = await fs.readFile(configPath);
      const beforeHistory = await fs.readFile(historyPath);
      const updatedAt = Math.trunc((await fs.stat(configPath)).mtimeMs);
      const app = express();
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const port = await reservePort();
      const token = "synthetic-wire15-session-token";
      await hub.registerRoutes(app, {
        MobileSyncToken: token, MobileSyncPort: port, SyncHubAppDataPath: appDataPath,
      }, path.join(__dirname, ".."));
      const wsUrl = `ws://127.0.0.1:${port}/ws-sync?token=${token}`;
      mobile = await connect(wsUrl);
      const ack = await request(mobile, {
        type: "VERSION_CHECK",
        versions: [
          { component: "mobile_app", version: "1.1.6" },
          { component: "wire", version: "1.5" },
        ],
      }, "VERSION_ACK");
      assert.deepEqual(ack, {
        type: "VERSION_ACK",
        versions: [
          { component: "desktop_plugin", version: "2.0.0" },
          { component: "wire", version: "1.5" },
        ],
        backendMode: "legacy",
      });
      desktop = await connect(wsUrl);
      const desktopAck = await request(desktop, {
        type: "VERSION_CHECK", mobileVersion: "vcpchat-desktop-sync-1.4",
        protocolVersion: "1.4",
      }, "VERSION_ACK");
      assert.equal(desktopAck.protocolVersion, "1.4");
      assert.equal(desktopAck.pluginVersion, "1.4.0");

      const base = `http://127.0.0.1:${server.address().port}/api/mobile-sync`;
      async function post(route, body, desktopContract = false) {
        const response = await fetch(base + route, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`, "content-type": "application/json",
            ...(desktopContract ? { "X-VCP-Sync-Contract": "desktop-full-v1" } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        return text;
      }
      const selector = { entityType: "owner", ...identity };
      const mobilePull = JSON.parse(await post("/entities/pull", { items: [selector] }));
      assert.equal(mobilePull.results[0].ok, true);
      assert.deepEqual(mobilePull.results[0].data, dto);
      const desktopPull = JSON.parse(await post("/entities/pull", { items: [selector] }, true));
      assert.equal(desktopPull.results[0].ok, true);
      const full = desktopPull.results[0].data;
      assert.equal(full.customCss, "fixture");
      assert.equal(full.topics, undefined);

      const topicPull = JSON.parse(await post("/entities/pull", {
        items: [{ entityType: "topic", ...identity, topicId }],
      }));
      assert.equal(topicPull.results[0].ok, true);
      const wireTopic = topicPull.results[0].data;
      assert.deepEqual(Object.keys(wireTopic).sort(),
        [...Object.keys(topic), "ownerId", "configHash", "updatedAt"].sort());
      assert.equal(wireTopic.ownerId, ownerId);
      assert.equal(wireTopic.configHash, hash(topic));
      assert.ok(Number.isSafeInteger(wireTopic.updatedAt) && wireTopic.updatedAt >= 0);
      const frames = (await post("/messages/pull", {
        topics: [{ ...identity, topicId, messageIds: [message.id] }],
      })).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(frames.length, 1);
      assert.equal(frames[0].ok, true);
      assert.equal(frames[0].kind, "topic");
      assert.equal(frames[0].ownerId, ownerId);
      assert.equal(frames[0].messages.length, 1);
      assert.equal(frames[0].messages[0].contentHash, hash(message));

      // Match Rust TopicManifestLive exactly: metadata only, no contentHash.
      const mobileTopicManifest = {
        type: "SYNC_MANIFEST_REQUEST",
        manifestType: "topic",
        targetedOwners: [identity],
        items: [{
          ...identity, topicId,
          configHash: hash(topic), updatedAt: wireTopic.updatedAt,
        }],
      };
      for (let round = 0; round < 2; round++) {
        assert.deepEqual(
          (await request(mobile, mobileTopicManifest, "SYNC_MANIFEST_RESULT")).results,
          [],
          "a nonempty mobile Topic manifest must succeed on repeated sync",
        );
      }

      const topicRoot = root([hash({ id: message.id, hash: hash(message) })]);
      const ownerRoot = root([hash({
        topicId, configHash: hash(topic), contentHash: topicRoot,
      })]);
      const manifest = (configHash, contentHash) => ({
        type: "SYNC_MANIFEST_REQUEST", manifestType: "owner",
        items: [{ ...identity, configHash, contentHash, updatedAt }],
      });
      assert.deepEqual((await request(mobile,
        manifest(hash(dto), ownerRoot), "SYNC_MANIFEST_RESULT")).results, []);
      assert.deepEqual((await request(desktop,
        manifest(hash(full), ""), "SYNC_MANIFEST_RESULT")).results, []);
      assert.deepEqual((await request(mobile,
        manifest(hash(dto), ownerRoot), "SYNC_MANIFEST_RESULT")).results, []);
      assert.deepEqual(await fs.readFile(configPath), beforeConfig);
      assert.deepEqual(await fs.readFile(historyPath), beforeHistory);
    } finally {
      if (mobile) mobile.terminate();
      if (desktop) desktop.terminate();
      try {
        if (hub) await hub.shutdown();
      } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (previousLogDir === undefined) delete process.env.VCP_MOBILE_SYNC_LOG_DIR;
        else process.env.VCP_MOBILE_SYNC_LOG_DIR = previousLogDir;
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  });