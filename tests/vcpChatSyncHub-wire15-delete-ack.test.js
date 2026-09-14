"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const WebSocket = require("ws");

// Keep every frame, including unexpected ones. Never silently skip SYNC_ACK.
async function connectObserved(url) {
  const deadline = Date.now() + 8000;
  while (true) {
    const socket = new WebSocket(url);
    const frames = [];
    let waiter = null;
    let failure = null;
    const rejectPending = error => {
      failure = error;
      if (waiter) {
        const pending = waiter;
        waiter = null;
        clearTimeout(pending.timer);
        pending.reject(error);
      }
    };
    socket.on("error", rejectPending);
    socket.on("close", () => rejectPending(new Error("Observed socket closed")));
    socket.on("message", data => {
      let frame;
      try { frame = JSON.parse(data.toString()); }
      catch (error) { rejectPending(error); return; }
      if (waiter) {
        const pending = waiter;
        waiter = null;
        clearTimeout(pending.timer);
        pending.resolve(frame);
      } else {
        frames.push(frame);
      }
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Open timeout")), 3000);
        const onOpen = () => finish();
        const onError = error => finish(error);
        function finish(error) {
          clearTimeout(timer);
          socket.off("open", onOpen);
          socket.off("error", onError);
          error ? reject(error) : resolve();
        }
        socket.once("open", onOpen);
        socket.once("error", onError);
      });
      return {
        socket,
        send(payload) { socket.send(JSON.stringify(payload)); },
        next() {
          if (frames.length) return Promise.resolve(frames.shift());
          if (failure) return Promise.reject(failure);
          assert.equal(waiter, null, "Only one outstanding read is allowed");
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              waiter = null;
              reject(new Error("Response timeout"));
            }, 5000);
            waiter = { resolve, reject, timer };
          });
        },
        queued() { return [...frames]; },
      };
    } catch (error) {
      socket.terminate();
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
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

test("Wire 1.5 delete responses are silent without weakening Wire 1.4 or failures",
  { timeout: 45000 }, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vcp-wire15-delete-ack-"));
    // Dedicated test process: retain this log override until process exit.
    process.env.VCP_MOBILE_SYNC_LOG_DIR = path.join(dir, "logs");
    const appDataPath = path.join(dir, "AppData");
    const ownerId = "delete-agent";
    const mobileTopics = ["mobile-delete-a", "mobile-delete-b", "mobile-delete-c"];
    const desktopTopic = "desktop-delete";
    const guardTopic = "untouched-guard";
    const brokenOwner = "storage-error-agent";
    const brokenTopic = "storage-guard";
    const deletedAt = 1789350000000;
    let hub, server, mobile, desktop;
    let sequence = 0;
    const diagnosticTypes = new Set([
      "SYNC_LOG_EVENT", "DESKTOP_PHASE_START", "DESKTOP_PHASE_COMPLETE",
    ]);
    const observedDiagnostics = [];
    async function nextProtocol(client) {
      for (let count = 0; count < 200; count++) {
        const frame = await client.next();
        if (!diagnosticTypes.has(frame.type)) return frame;
        assert.equal(typeof frame.phase, "string");
        assert.equal(typeof frame.ts, "number");
        if (frame.type === "SYNC_LOG_EVENT") {
          assert.equal(typeof frame.level, "string");
          assert.equal(typeof frame.message, "string");
        }
        observedDiagnostics.push(frame);
      }
      throw new Error("Excessive diagnostic frames without a protocol response");
    }

    const configPath = owner => path.join(appDataPath, "Agents", owner, "config.json");
    const historyPath = (owner, topic) =>
      path.join(appDataPath, "UserData", owner, "topics", topic, "history.json");
    async function seed(owner, ids) {
      const config = {
        name: "Synthetic delete fixture", systemPrompt: "Fixture only",
        model: "fixture", temperature: 0.7, contextTokenLimit: 12345,
        maxOutputTokens: 6789, streamOutput: true,
        topics: ids.map(id => ({ id, name: id, createdAt: 1, locked: false, unread: false })),
      };
      await fs.mkdir(path.dirname(configPath(owner)), { recursive: true });
      await fs.writeFile(configPath(owner), JSON.stringify(config));
      for (const topic of ids) {
        const target = historyPath(owner, topic);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify([
          { id: "fixture-message", role: "user", content: "Synthetic only", timestamp: 10 },
        ]));
      }
    }
    const deletion = (topicId, owner = ownerId, timestamp = deletedAt) => ({
      type: "SYNC_ENTITY_DELETE", targetType: "topic",
      ownerType: "agent", ownerId: owner, topicId, deletedAt: timestamp,
    });
    async function throughBarrier(client, requests, expectedPrefix = []) {
      const identity = { sessionId: 701, attemptId: ++sequence, nonce: `delete-test-${sequence}` };
      for (const request of requests) client.send(request);
      client.send({ type: "PHASE_COMPLETED", phase: "messages", ...identity });
      const finalAck = { type: "PHASE_ACK", phase: "messages", ...identity };
      const received = [];
      while (received.length < 16) {
        const frame = await nextProtocol(client);
        received.push(frame);
        if (frame.type === "PHASE_ACK" && frame.nonce === identity.nonce) break;
      }
      // The server's per-connection message chain makes this a processing barrier.
      assert.deepEqual(received, [...expectedPrefix, finalAck],
        "The complete response sequence must not contain an extra legacy ACK");
    }

    try {
      await seed(ownerId, [...mobileTopics, desktopTopic, guardTopic]);
      await seed(brokenOwner, [brokenTopic]);
      const guardBefore = await fs.readFile(historyPath(ownerId, guardTopic));
      const brokenHistoryBefore = await fs.readFile(historyPath(brokenOwner, brokenTopic));
      const loggerModule = require("../Plugin/VCPChatSyncHub/core/logger");
      assert.equal(loggerModule.getLogger().logDir, path.join(dir, "logs"),
        "Logger must be isolated before loading the hub");
      hub = require("../Plugin/VCPChatSyncHub");
      const app = express();
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const port = await reservePort();
      const token = "synthetic-delete-regression-token";
      await hub.registerRoutes(app, {
        MobileSyncToken: token, MobileSyncPort: port, SyncHubAppDataPath: appDataPath,
      }, path.join(__dirname, ".."));
      // registerRoutes returns void; do not inspect the DB until handshake succeeds.
      const url = `ws://127.0.0.1:${port}/ws-sync?token=${token}`;
      mobile = await connectObserved(url);
      desktop = await connectObserved(url);
      mobile.send({ type: "VERSION_CHECK", versions: [
        { component: "mobile_app", version: "1.1.6" },
        { component: "wire", version: "1.5" },
      ] });
      const mobileVersion = await nextProtocol(mobile);
      assert.equal(mobileVersion.type, "VERSION_ACK");
      assert.ok(mobileVersion.versions.some(v => v.component === "wire" && v.version === "1.5"));
      desktop.send({
        type: "VERSION_CHECK", mobileVersion: "vcpchat-desktop-sync-1.4", protocolVersion: "1.4",
      });
      const desktopVersion = await nextProtocol(desktop);
      assert.equal(desktopVersion.type, "VERSION_ACK");
      assert.equal(desktopVersion.protocolVersion, "1.4");

      const db = require("../Plugin/VCPChatSyncHub/core/db").getDb();
      assert.ok(db, "Fixture DB must be initialized after handshake");
      assert.equal(path.resolve(db.name), path.join(dir, "sync_state.db"),
        "All database operations must use the fixture database");
      assert.equal(loggerModule.getLogger().logDir, path.join(dir, "logs"),
        "Async startup must retain the isolated logger");
      const tombstones = () => db.prepare(
        "SELECT topic_id, deleted_at FROM wire14_tombstones WHERE target_type = ? AND owner_id = ? ORDER BY topic_id"
      ).all("topic", ownerId);

      await t.test("three mobile topic deletes commit without SYNC_ACK before the exact final ACK", async () => {
        await throughBarrier(mobile, mobileTopics.map(id => deletion(id)));
        const config = JSON.parse(await fs.readFile(configPath(ownerId), "utf8"));
        assert.deepEqual(config.topics.map(topic => topic.id), [desktopTopic, guardTopic]);
        for (const id of mobileTopics) {
          await assert.rejects(fs.access(historyPath(ownerId, id)), { code: "ENOENT" });
        }
        assert.deepEqual(tombstones(), mobileTopics.map(topic_id => ({ topic_id, deleted_at: deletedAt })));
        assert.deepEqual(await fs.readFile(historyPath(ownerId, guardTopic)), guardBefore);
      });

      await t.test("a simultaneous desktop Wire 1.4 connection retains its legacy delete ACK", async () => {
        await throughBarrier(desktop, [deletion(desktopTopic)], [
          { type: "SYNC_ACK", id: desktopTopic },
        ]);
        await assert.rejects(fs.access(historyPath(ownerId, desktopTopic)), { code: "ENOENT" });
        assert.equal(tombstones().find(row => row.topic_id === desktopTopic).deleted_at, deletedAt);
      });

      await t.test("mobile retries stay silent and retain the earliest tombstone without duplicates", async () => {
        const before = tombstones();
        await throughBarrier(mobile, mobileTopics.map(id => deletion(id, ownerId, deletedAt + 1000)));
        assert.deepEqual(tombstones(), before);
        assert.deepEqual(
          JSON.parse(await fs.readFile(configPath(ownerId), "utf8")).topics.map(topic => topic.id),
          [guardTopic]
        );
      });

      await t.test("invalid mobile deletion returns an error and preserves the target", async () => {
        const before = await fs.readFile(configPath(ownerId));
        const invalid = deletion(guardTopic);
        delete invalid.topicId;
        mobile.send(invalid);
        const error = await nextProtocol(mobile);
        assert.equal(error.type, "SYNC_ERROR");
        assert.ok(error.error, "The error must not be silently suppressed");
        assert.deepEqual(await fs.readFile(configPath(ownerId)), before);
        assert.deepEqual(await fs.readFile(historyPath(ownerId, guardTopic)), guardBefore);
        assert.ok(!tombstones().some(row => row.topic_id === guardTopic));
      });

      await t.test("a real storage read failure remains visible and creates no successful tombstone", async () => {
        const original = await fs.readFile(configPath(brokenOwner));
        try {
          await fs.writeFile(configPath(brokenOwner), "{invalid-fixture-json");
          // Use a fresh connection in case the invalid-request policy closed the earlier one.
          const failingClient = await connectObserved(url);
          try {
            failingClient.send({ type: "VERSION_CHECK", versions: [
              { component: "mobile_app", version: "1.1.6" },
              { component: "wire", version: "1.5" },
            ] });
            assert.equal((await nextProtocol(failingClient)).type, "VERSION_ACK");
            failingClient.send(deletion(brokenTopic, brokenOwner));
            const error = await nextProtocol(failingClient);
            assert.equal(error.type, "SYNC_ERROR");
            assert.ok(error.error);
            assert.deepEqual(await fs.readFile(historyPath(brokenOwner, brokenTopic)), brokenHistoryBefore);
            assert.equal(db.prepare(
              "SELECT COUNT(*) AS count FROM wire14_tombstones WHERE owner_id = ?"
            ).get(brokenOwner).count, 0);
            assert.ok(failingClient.queued().every(frame => diagnosticTypes.has(frame.type)));
          } finally {
            failingClient.socket.terminate();
          }
        } finally {
          await fs.writeFile(configPath(brokenOwner), original);
        }
      });
      assert.ok(desktop.queued().every(frame => diagnosticTypes.has(frame.type)));
    } finally {
      if (mobile) mobile.socket.terminate();
      if (desktop) desktop.socket.terminate();
      try {
        if (hub) await hub.shutdown();
      } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        // Preserve fixtures for audit and keep log isolation until this process exits.
        console.log("DELETE_ACK_FIXTURE=" + dir);
      }
    }
  });