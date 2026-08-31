"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const express = require("express");
const WebSocket = require("ws");

const hub = require("../Plugin/VCPChatSyncHub");
const { getEntityIndex } = require("../Plugin/VCPChatSyncHub/core/db");
const {
  aggregateHashes14,
  messageHash14,
} = require("../Plugin/VCPChatSyncHub/wire14");

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPort(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

function wsRequest(socket, payload, expectedType) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}`)), 10_000);
    const onMessage = (data) => {
      const response = JSON.parse(data.toString("utf8"));
      if (response.type !== expectedType) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(response);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify(payload), (error) => {
      if (!error) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      reject(error);
    });
  });
}

test("Wire 1.4 handshake, compound manifest, diff and unified HTTP routes", { timeout: 20_000 }, async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vcp-sync-14-"));
  const appDataPath = path.join(tempRoot, "AppData");
  const ownerId = "agent-wire14";
  const topicId = "topic-wire14";
  const message = {
    id: "message-wire14",
    role: "user",
    content: "wire 1.4",
    timestamp: 123,
  };
  await fs.mkdir(path.join(appDataPath, "Agents", ownerId), { recursive: true });
  await fs.mkdir(path.join(appDataPath, "UserData", ownerId, "topics", topicId), { recursive: true });
  await fs.writeFile(
    path.join(appDataPath, "Agents", ownerId, "config.json"),
    JSON.stringify({ id: ownerId, name: "Wire 14", topics: [{ id: topicId, name: "Topic", createdAt: 1 }] }),
  );
  await fs.writeFile(
    path.join(appDataPath, "UserData", ownerId, "topics", topicId, "history.json"),
    JSON.stringify([message]),
  );

  const app = express();
  const httpServer = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => httpServer.once("listening", resolve));
  const httpPort = httpServer.address().port;
  const wsPort = await reservePort();
  const token = "wire-14-integration-token";

  t.after(async () => {
    await hub.shutdown();
    await new Promise((resolve) => httpServer.close(resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  hub.registerRoutes(
    app,
    {
      MobileSyncToken: token,
      MobileSyncPort: wsPort,
      SyncHubAppDataPath: appDataPath,
    },
    path.join(__dirname, ".."),
  );
  await waitForPort(wsPort);

  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws-sync?token=${token}`);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  t.after(() => socket.terminate());

  const version = await wsRequest(socket, {
    type: "VERSION_CHECK",
    mobileVersion: "vcpchat-desktop-sync-1.4",
    protocolVersion: "1.4",
  }, "VERSION_ACK");
  assert.deepEqual(version, {
    type: "VERSION_ACK",
    pluginVersion: "1.4.0",
    protocolVersion: "1.4",
  });

  const phase = await wsRequest(socket, {
    type: "PHASE_START",
    phase: "owner_metadata",
  }, "PHASE_ACK");
  assert.equal(phase.phase, "owner_metadata");

  const ownerManifest = await wsRequest(socket, {
    type: "SYNC_MANIFEST_REQUEST",
    manifestType: "owner",
    items: [],
  }, "SYNC_MANIFEST_RESULT");
  assert.deepEqual(ownerManifest.results.map((item) => item.ownerId), [ownerId]);
  assert.equal(ownerManifest.results[0].action, "PULL");

  const topicManifest = await wsRequest(socket, {
    type: "SYNC_MANIFEST_REQUEST",
    manifestType: "topic",
    targetedOwners: [{ ownerType: "agent", ownerId }],
    items: [],
  }, "SYNC_MANIFEST_RESULT");
  assert.equal(topicManifest.results[0].topicId, topicId);
  assert.equal(topicManifest.results[0].action, "PULL");

  const missingTopicId = "topic-wire14-deleted-before-seen";
  await wsRequest(socket, {
    type: "SYNC_ENTITY_DELETE",
    targetType: "topic",
    ownerType: "agent",
    ownerId,
    topicId: missingTopicId,
    deletedAt: 100,
  }, "SYNC_ACK");
  const tombstoneManifest = await wsRequest(socket, {
    type: "SYNC_MANIFEST_REQUEST",
    manifestType: "topic",
    targetedOwners: [{ ownerType: "agent", ownerId }],
    items: [],
  }, "SYNC_MANIFEST_RESULT");
  assert.deepEqual(
    tombstoneManifest.results.find((item) => item.topicId === missingTopicId),
    {
      ownerType: "agent",
      ownerId,
      topicId: missingTopicId,
      action: "PULL_DELETE",
      deletedAt: 100,
    },
  );

  const messageHash = messageHash14(message);
  const topicDiff = await wsRequest(socket, {
    type: "SYNC_TOPIC_DIFF_REQUEST",
    topics: [{
      topicId,
      ownerType: "agent",
      ownerId,
      configHash: getEntityIndex(topicId, "topic").hash,
      contentHash: aggregateHashes14([messageHash]),
    }],
  }, "SYNC_TOPIC_DIFF_RESULT");
  assert.deepEqual(topicDiff.changedTopics, []);

  const messageDiff = await wsRequest(socket, {
    type: "SYNC_MESSAGE_DIFF_REQUEST",
    topics: [{
      topicId,
      ownerType: "agent",
      ownerId,
      contentHash: aggregateHashes14([messageHash]),
      messages: {
        [message.id]: { messageHash, updatedAt: message.timestamp },
      },
    }],
  }, "SYNC_MESSAGE_DIFF_RESULT");
  assert.deepEqual(messageDiff.results[0], {
    topicId,
    ownerType: "agent",
    ownerId,
    ok: true,
    pullMessageIds: [],
    pushTopic: false,
    deleteMessages: [],
  });

  const baseUrl = `http://127.0.0.1:${httpPort}/api/mobile-sync`;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const ownerPull = await fetch(`${baseUrl}/entities/pull`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: [{ entityType: "owner", ownerType: "agent", ownerId }] }),
  });
  assert.equal(ownerPull.status, 200);
  const ownerBody = await ownerPull.json();
  assert.equal(ownerBody.results[0].ok, true);
  assert.equal(ownerBody.results[0].data.name, "Wire 14");
  assert.equal(ownerBody.results[0].data.topics, undefined);

  const topicPull = await fetch(`${baseUrl}/entities/pull`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: [{ entityType: "topic", ownerType: "agent", ownerId, topicId }] }),
  });
  assert.equal(topicPull.status, 200);
  const topicBody = await topicPull.json();
  assert.equal(topicBody.results[0].ok, true);
  assert.equal(topicBody.results[0].topicId, topicId);

  const messagePull = await fetch(`${baseUrl}/messages/pull`, {
    method: "POST",
    headers,
    body: JSON.stringify({ topics: [{ topicId, ownerType: "agent", ownerId, messageIds: [message.id] }] }),
  });
  assert.equal(messagePull.status, 200);
  const messageFrame = JSON.parse((await messagePull.text()).trim());
  assert.equal(messageFrame.kind, "topic");
  assert.equal(messageFrame.ok, true);
  assert.equal(messageFrame.messages[0].id, message.id);
  assert.equal(Number.isSafeInteger(messageFrame.messages[0].updatedAt), true);

  const pushedMessage = {
    id: "message-wire14-pushed",
    role: "assistant",
    content: "pushed",
    timestamp: 124,
  };
  const messagePush = await fetch(`${baseUrl}/messages/push`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-ndjson",
    },
    body: `${JSON.stringify({
      kind: "topic",
      topicId,
      ownerType: "agent",
      ownerId,
      messages: [pushedMessage],
      deletedMessages: [],
    })}\n`,
  });
  assert.equal(messagePush.status, 200);
  const pushFrame = JSON.parse((await messagePush.text()).trim());
  assert.equal(pushFrame.kind, "topic");
  assert.equal(pushFrame.ok, true);
  const persisted = JSON.parse(await fs.readFile(
    path.join(appDataPath, "UserData", ownerId, "topics", topicId, "history.json"),
    "utf8",
  ));
  assert.equal(persisted.some((item) => item.id === pushedMessage.id), true);
});
