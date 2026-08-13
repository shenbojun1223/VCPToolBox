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

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function reservePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPort(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function exchange(port, token, firstFrame, expectedType) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws-sync?token=${encodeURIComponent(token)}`,
    );
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out waiting for ${expectedType}`));
    }, 10_000);

    socket.once("open", () => socket.send(JSON.stringify(firstFrame)));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type !== expectedType) return;
      clearTimeout(timer);
      socket.close(1000, "test complete");
      resolve(message);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("SyncHub serves protocol 1.1 and keeps authenticated desktop routes", { timeout: 15_000 }, async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vcp-sync-hub-"));
  const appDataPath = path.join(tempRoot, "AppData");
  const wsPort = await reservePort();
  const token = "integration-test-token";
  const ownerId = "agent-existing-history";
  const topicId = "topic-existing-history";
  await fs.mkdir(path.join(appDataPath, "Agents", ownerId), { recursive: true });
  await fs.mkdir(
    path.join(appDataPath, "UserData", ownerId, "topics", topicId),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(appDataPath, "Agents", ownerId, "config.json"),
    JSON.stringify({
      id: ownerId,
      name: "Existing Agent",
      topics: [{ id: topicId, name: "Existing Topic", createdAt: 1 }],
    }),
  );
  await fs.writeFile(
    path.join(appDataPath, "UserData", ownerId, "topics", topicId, "history.json"),
    JSON.stringify([{ id: "message-existing", role: "user", content: "hello", timestamp: 1 }]),
  );
  const app = express();
  const httpServer = app.listen();
  const httpPort = await new Promise((resolve, reject) => {
    if (httpServer.listening) return resolve(httpServer.address().port);
    httpServer.once("listening", () => resolve(httpServer.address().port));
    httpServer.once("error", reject);
  });

  t.after(async () => {
    await hub.shutdown();
    await closeServer(httpServer);
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

  const versionAck = await exchange(
    wsPort,
    token,
    {
      type: "VERSION_CHECK",
      mobileVersion: "integration-test",
      protocolVersion: "1.1",
    },
    "VERSION_ACK",
  );
  assert.deepEqual(versionAck, {
    type: "VERSION_ACK",
    version: "1.0.0",
    pluginVersion: "1.1.0",
    protocolVersion: "1.1",
  });

  const mobileVersionAck = await exchange(
    wsPort,
    token,
    {
      type: "VERSION_CHECK",
      mobileVersion: "1.1.3",
    },
    "VERSION_ACK",
  );
  assert.deepEqual(mobileVersionAck, {
    type: "VERSION_ACK",
    version: "1.0.0",
    pluginVersion: "1.1.0",
    protocolVersion: "1.1",
  });

  const protocolError = await exchange(
    wsPort,
    token,
    { type: "PHASE_START", phase: "owner_metadata" },
    "SYNC_ERROR",
  );
  assert.equal(protocolError.error.code, "VERSION_CHECK_REQUIRED");

  const baseUrl = `http://127.0.0.1:${httpPort}/api/mobile-sync`;
  const unauthorized = await fetch(`${baseUrl}/desktop/config-manifest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [] }),
  });
  assert.equal(unauthorized.status, 401);
  await unauthorized.json();

  const authorized = await fetch(`${baseUrl}/desktop/config-manifest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sync-token": token,
    },
    body: JSON.stringify({ items: [] }),
  });
  const authorizedBody = await authorized.text();
  assert.equal(authorized.status, 200, authorizedBody);
  assert.deepEqual(JSON.parse(authorizedBody), {
    actions: [{ id: ownerId, type: "agent", action: "PULL" }],
  });
});
