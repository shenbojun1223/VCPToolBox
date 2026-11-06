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
  sanitizeLoomManifestForSync,
  refreshDesktopLoomAppIndex,
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
test("LoomApp bundle hash contract matches the VCPChat golden value", () => {
  const fixtureId = "hash-contract-fixture";
  const fixture = {
    manifest: {
      id: "ignored-will-be-overwritten",
      name: "Hash Contract Fixture",
      running: true,
      url: "https://example.com/app",
      injection: { css: "wrong.css", js: "wrong.js", extra: "keep-me" },
      window: { minWidth: 480, minHeight: 320, resizable: true },
      icon: "icon.png",
    },
    css: "body { color: #fff; }\n",
    js: "console.log(\"loom\");\n",
    iconFile: {
      fileName: "icon.png",
      sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    },
  };

  assert.deepEqual(sanitizeLoomManifestForSync(fixture.manifest, fixtureId), {
    id: fixtureId,
    name: "Hash Contract Fixture",
    url: "https://example.com/app",
    injection: { css: "inject.css", js: "inject.js", extra: "keep-me" },
    window: { minWidth: 480, minHeight: 320, resizable: true },
    icon: "icon.png",
  });

  // This hex is duplicated verbatim in VCPChat tests/desktop-sync-protocol.test.js.
  // sanitizeLoomManifestForSync + the bundle hash are reimplemented independently in both
  // repos; if either side drifts, each peer thinks the other is stale and PUSH/PULL
  // oscillates forever -- a failure no single-end test can observe, because each repo's
  // tests only exercise its own implementation. Changing this value requires changing
  // BOTH repos in the same change.
  assert.equal(
    computeDesktopLoomAppHash(fixture, fixtureId),
    "b6441779db437752273b23ad41eae793c62aacb20368edb94f62b5f1f2bc93f3",
  );
});
function loomHubFixture(t, prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    database.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  database.initDb(path.join(tempDir, "sync_state.db"));
  const appDataPath = path.join(tempDir, "AppData");
  fs.mkdirSync(path.join(appDataPath, "LoomApps"), { recursive: true });
  return appDataPath;
}

test("a half-written LoomApp bundle is quarantined instead of republished, and re-uploading repairs it", async (t) => {
  const appDataPath = loomHubFixture(t, "vcp-sync-loom-torn-");
  const manifest = {
    schemaVersion: 1,
    id: "torn-app",
    name: "Torn",
    startUrl: "https://example.com/",
  };

  const upload = await uploadDesktopLoomApps(appDataPath, [
    { id: "torn-app", manifest, css: "a{}", js: "good-js;", ts: 1700000000000 },
  ]);
  assert.equal(upload.items[0].ok, true);
  const indexed = database.getDesktopLoomAppIndex("torn-app");
  assert.equal(indexed.deleted_at, null);

  // Simulate a crash between inject.css and inject.js: the marker survives and the
  // on-disk bundle now hashes to a value matching neither peer.
  const appDir = path.join(appDataPath, "LoomApps", "torn-app");
  fs.writeFileSync(path.join(appDir, ".sync-pending"), "{\"id\":\"torn-app\"}\n");
  fs.writeFileSync(path.join(appDir, "inject.js"), "torn-js;");

  await refreshDesktopLoomAppIndex(appDataPath);
  const afterRefresh = database.getDesktopLoomAppIndex("torn-app");
  // Republishing the torn hash under a fresh mtime is the fleet-wide failure: every
  // client would see remoteTs <= local.updated_at and PULL the damaged bundle.
  assert.equal(afterRefresh.hash, indexed.hash);
  assert.equal(afterRefresh.updated_at, indexed.updated_at);
  assert.equal(afterRefresh.deleted_at, null);

  const refused = await downloadDesktopLoomApps(appDataPath, [{ id: "torn-app" }]);
  assert.equal(refused.items[0].ok, false);
  assert.match(refused.items[0].error, /mid-write/);

  const repaired = await uploadDesktopLoomApps(appDataPath, [
    { id: "torn-app", manifest, css: "a{}", js: "repaired-js;", ts: 1700000001000 },
  ]);
  assert.equal(repaired.items[0].ok, true);
  assert.equal(fs.existsSync(path.join(appDir, ".sync-pending")), false);

  const served = await downloadDesktopLoomApps(appDataPath, [{ id: "torn-app" }]);
  assert.equal(served.items[0].ok, true);
  assert.equal(served.items[0].js, "repaired-js;");
});

test("a transient index failure never tombstones a live LoomApp, but a genuinely removed one still is", async (t) => {
  const appDataPath = loomHubFixture(t, "vcp-sync-loom-transient-");
  const manifest = {
    schemaVersion: 1,
    id: "guarded-app",
    name: "Guarded",
    startUrl: "https://example.com/",
  };

  const upload = await uploadDesktopLoomApps(appDataPath, [
    { id: "guarded-app", manifest, css: "a{}", js: "void 0;", ts: 1700000000000 },
  ]);
  assert.equal(upload.items[0].ok, true);
  const indexed = database.getDesktopLoomAppIndex("guarded-app");

  // An inject file past the byte budget makes readLoomAppBundle throw a non-ENOENT
  // error, standing in for any transient read failure (EBUSY from a virus scanner, a
  // locked file). "Could not read it" must not be treated as "it is gone", because the
  // resulting tombstone is broadcast as DELETE to every PC.
  const appDir = path.join(appDataPath, "LoomApps", "guarded-app");
  fs.writeFileSync(path.join(appDir, "inject.css"), "x".repeat(2 * 1024 * 1024 + 1));

  await refreshDesktopLoomAppIndex(appDataPath);
  assert.equal(database.getDesktopLoomAppIndex("guarded-app").deleted_at, null);

  const compared = await compareDesktopLoomManifest(appDataPath, {
    items: [{ id: "guarded-app", hash: indexed.hash, ts: indexed.updated_at }],
    deletions: [],
  });
  assert.deepEqual(
    compared.actions.filter((action) => action.action === "DELETE"),
    [],
  );

  // A directory that is actually gone must still be tombstoned, as before.
  fs.rmSync(appDir, { recursive: true, force: true });
  await refreshDesktopLoomAppIndex(appDataPath);
  assert.notEqual(database.getDesktopLoomAppIndex("guarded-app").deleted_at, null);
});