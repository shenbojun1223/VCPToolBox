"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const syncLogTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-loom-logs-"));
process.env.VCP_MOBILE_SYNC_LOG_DIR = syncLogTestDir;
after(() => {
  delete process.env.VCP_MOBILE_SYNC_LOG_DIR;
  fs.rmSync(syncLogTestDir, { recursive: true, force: true });
});

const express = require("express");
const database = require("../Plugin/VCPChatSyncHub/core/db");
const {
  compareDesktopLoomManifest,
  downloadDesktopLoomApps,
  uploadDesktopLoomApps,
  computeDesktopLoomAppHash,
} = require("../Plugin/VCPChatSyncHub/sync/desktop-loom");
const { registerRoutes } = require("../Plugin/VCPChatSyncHub/transport/routes");
const { handleManifest14 } = require("../Plugin/VCPChatSyncHub/wire14");

test("PC-to-PC LoomApp sync lifecycle (push, pull, update, delete tombstone) and VCPMobile isolation", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-loom-hub-"));
  t.after(() => {
    database.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  database.initDb(path.join(tempDir, "sync_state.db"));
  const appDataPath = path.join(tempDir, "AppData");
  fs.mkdirSync(path.join(appDataPath, "Agents"), { recursive: true });
  fs.mkdirSync(path.join(appDataPath, "AgentGroups"), { recursive: true });
  fs.mkdirSync(path.join(appDataPath, "LoomApps"), { recursive: true });

  const manifest = {
    schemaVersion: 1,
    id: "bilibili-mobile",
    name: "哔哩哔哩",
    description: "移动版 B 站 LoomAPP",
    startUrl: "https://m.bilibili.com/",
    enabled: true,
    exposeInAppDrawer: true,
    exposeManagerInAppDrawer: true,
    icon: "",
    iconSource: null,
    emoji: "📺",
    injection: { css: "inject.css", js: "inject.js" },
  };
  const cssV1 = "m-open-app { display: none !important; }";
  const jsV1 = "console.log('bili v1');";
  const hashV1 = computeDesktopLoomAppHash({ manifest, css: cssV1, js: jsV1 }, "bilibili-mobile");

  // 1. PC-A advertises a new LoomApp -> Hub responds with PUSH.
  const compare1 = await compareDesktopLoomManifest(appDataPath, {
    items: [{ id: "bilibili-mobile", hash: hashV1, ts: 1700000001000 }],
    deletions: [],
  });
  assert.deepEqual(compare1, {
    actions: [{ id: "bilibili-mobile", action: "PUSH" }],
    processedDeletions: [],
  });

  // 2. PC-A uploads the LoomApp to Hub.
  const upload1 = await uploadDesktopLoomApps(appDataPath, [{
    id: "bilibili-mobile",
    manifest,
    css: cssV1,
    js: jsV1,
    iconFile: null,
    ts: 1700000001000,
  }]);
  assert.equal(upload1.items.length, 1);
  assert.equal(upload1.items[0].ok, true);
  assert.equal(upload1.items[0].hash, hashV1);

  // 3. PC-B (empty LoomApps) syncs with Hub -> Hub responds with PULL.
  const comparePcB = await compareDesktopLoomManifest(appDataPath, {
    items: [],
    deletions: [],
  });
  assert.deepEqual(comparePcB, {
    actions: [{ id: "bilibili-mobile", action: "PULL" }],
    processedDeletions: [],
  });

  const downloadPcB = await downloadDesktopLoomApps(appDataPath, [{ id: "bilibili-mobile" }]);
  assert.equal(downloadPcB.items.length, 1);
  assert.equal(downloadPcB.items[0].ok, true);
  assert.equal(downloadPcB.items[0].hash, hashV1);
  assert.equal(downloadPcB.items[0].css, cssV1);
  assert.equal(downloadPcB.items[0].js, jsV1);
  assert.equal(downloadPcB.items[0].manifest.name, "哔哩哔哩");

  // 4. Verify strict isolation from VCPMobile (Wire 1.4/1.5 owner/topic/avatar manifests).
  const mobileOwnerManifest = await handleManifest14(
    { type: "SYNC_MANIFEST_REQUEST", manifestType: "owner", items: [] },
    appDataPath,
    { protocolVersion: "1.5" },
  );
  assert.deepEqual(mobileOwnerManifest.results, []);

  // 5. PC-B updates inject.css with a newer timestamp -> Hub requests PUSH.
  const cssV2 = "m-open-app, .gsl-callapp-dom { display: none !important; }";
  const hashV2 = computeDesktopLoomAppHash({ manifest, css: cssV2, js: jsV1 }, "bilibili-mobile");
  const compareUpdate = await compareDesktopLoomManifest(appDataPath, {
    items: [{ id: "bilibili-mobile", hash: hashV2, ts: 1700000002000 }],
    deletions: [],
  });
  assert.deepEqual(compareUpdate.actions, [{ id: "bilibili-mobile", action: "PUSH" }]);

  await uploadDesktopLoomApps(appDataPath, [{
    id: "bilibili-mobile",
    manifest,
    css: cssV2,
    js: jsV1,
    iconFile: null,
    ts: 1700000002000,
  }]);

  // PC-A still holding hashV1 at older timestamp receives PULL.
  const comparePcAOutdated = await compareDesktopLoomManifest(appDataPath, {
    items: [{ id: "bilibili-mobile", hash: hashV1, ts: 1700000001000 }],
    deletions: [],
  });
  assert.deepEqual(comparePcAOutdated.actions, [{ id: "bilibili-mobile", action: "PULL" }]);

  // 6. PC-A deletes bilibili-mobile at ts=1700000003000 -> Hub deletes directory and records tombstone.
  const compareDelete = await compareDesktopLoomManifest(appDataPath, {
    items: [],
    deletions: [{ id: "bilibili-mobile", deletedAt: 1700000003000 }],
  });
  assert.deepEqual(compareDelete, {
    actions: [],
    processedDeletions: ["bilibili-mobile"],
  });
  assert.equal(fs.existsSync(path.join(appDataPath, "LoomApps", "bilibili-mobile")), false);

  // 7. PC-B still has old local copy (ts=1700000002000) -> Hub tells PC-B to DELETE it.
  const comparePcBAfterDelete = await compareDesktopLoomManifest(appDataPath, {
    items: [{ id: "bilibili-mobile", hash: hashV2, ts: 1700000002000 }],
    deletions: [],
  });
  assert.deepEqual(comparePcBAfterDelete.actions, [{
    id: "bilibili-mobile",
    action: "DELETE",
    deletedAt: 1700000003000,
  }]);
});

test("HTTP /api/mobile-sync/desktop/loom-* routes authenticate and sync LoomApps end-to-end", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-loom-http-"));
  database.initDb(path.join(tempDir, "sync_state.db"));
  const appDataPath = path.join(tempDir, "AppData");
  fs.mkdirSync(path.join(appDataPath, "LoomApps"), { recursive: true });

  const app = express();
  registerRoutes(app, { syncToken: "loom-route-token", appDataPath });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => {
    server.close();
    database.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/mobile-sync`;
  const headers = {
    authorization: "Bearer loom-route-token",
    "content-type": "application/json",
    "X-VCP-Sync-Contract": "desktop-full-v1",
  };

  // Unauthorized request is rejected with 401
  const unauthRes = await fetch(`${baseUrl}/desktop/loom-manifest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [], deletions: [] }),
  });
  assert.equal(unauthRes.status, 401);

  const manifest = {
    schemaVersion: 1,
    id: "example-mobile",
    name: "Bing 搜索",
    startUrl: "https://www.bing.com/",
    enabled: true,
    icon: "bing.png",
  };
  const css = "body { margin: 0; }";
  const js = "console.log('bing');";
  const iconContent = Buffer.from("bing-icon-binary").toString("base64");
  const iconSha = require("node:crypto").createHash("sha256").update(Buffer.from("bing-icon-binary")).digest("hex");
  const hash = computeDesktopLoomAppHash(
    { manifest, css, js, iconFile: { fileName: "bing.png", sha256: iconSha } },
    "example-mobile",
  );

  // PC-A manifest check -> PUSH
  const manifestRes1 = await fetch(`${baseUrl}/desktop/loom-manifest`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      items: [{ id: "example-mobile", hash, ts: 1700000010000 }],
      deletions: [],
    }),
  });
  assert.equal(manifestRes1.status, 200);
  assert.deepEqual(await manifestRes1.json(), {
    actions: [{ id: "example-mobile", action: "PUSH" }],
    processedDeletions: [],
  });

  // PC-A upload -> 200 OK
  const uploadRes = await fetch(`${baseUrl}/desktop/upload-loom-apps`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      items: [{
        id: "example-mobile",
        manifest,
        css,
        js,
        iconFile: { fileName: "bing.png", content: iconContent, sha256: iconSha },
        ts: 1700000010000,
      }],
    }),
  });
  assert.equal(uploadRes.status, 200);
  const uploadJson = await uploadRes.json();
  assert.equal(uploadJson.items[0].ok, true);
  assert.equal(uploadJson.items[0].hash, hash);

  // PC-B manifest check -> PULL
  const manifestRes2 = await fetch(`${baseUrl}/desktop/loom-manifest`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: [], deletions: [] }),
  });
  assert.equal(manifestRes2.status, 200);
  assert.deepEqual(await manifestRes2.json(), {
    actions: [{ id: "example-mobile", action: "PULL" }],
    processedDeletions: [],
  });

  // PC-B download -> 200 OK with full bundle & iconFile
  const downloadRes = await fetch(`${baseUrl}/desktop/download-loom-apps`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: [{ id: "example-mobile" }] }),
  });
  assert.equal(downloadRes.status, 200);
  const downloadJson = await downloadRes.json();
  assert.equal(downloadJson.items.length, 1);
  assert.equal(downloadJson.items[0].ok, true);
  assert.equal(downloadJson.items[0].css, css);
  assert.equal(downloadJson.items[0].js, js);
  assert.equal(downloadJson.items[0].iconFile.fileName, "bing.png");
  assert.equal(downloadJson.items[0].iconFile.content, iconContent);
});