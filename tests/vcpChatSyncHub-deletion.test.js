"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const syncLogTestDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-delete-logs-"));
process.env.VCP_MOBILE_SYNC_LOG_DIR = syncLogTestDir;
after(() => {
  delete process.env.VCP_MOBILE_SYNC_LOG_DIR;
  fs.rmSync(syncLogTestDir, { recursive: true, force: true });
});

const database = require("../Plugin/VCPChatSyncHub/core/db");
const { deleteEntity } = require("../Plugin/VCPChatSyncHub/sync/entity");
const {
  compareDesktopConfigManifest,
  uploadDesktopConfigs,
} = require("../Plugin/VCPChatSyncHub/sync/desktop-config");

test("sync tombstone helpers bind named SQLite parameters and preserve the earliest delete", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-delete-db-"));
  t.after(() => {
    database.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const db = database.initDb(path.join(tempDir, "sync.db"));
  database.upsertEntityIndex("topic-1", "topic", "topic-config.json", "a".repeat(64), 10);
  database.upsertEntityIndex("agent-1", "agent", "agent-config.json", "b".repeat(64), 10);
  database.upsertMessageIndex("message-1", "topic-1", "c".repeat(64), 10);
  database.upsertAvatarIndex("agent-1", "agent", "avatar.png", "d".repeat(64), 10);

  assert.equal(database.softDeleteEntityIndex("topic-1", "agent_topic", 200).changes, 1);
  assert.equal(database.softDeleteEntityIndex("topic-1", "topic", 100).changes, 1);
  assert.equal(database.softDeleteEntityIndex("agent-1", "agent", 120).changes, 1);
  assert.equal(database.softDeleteMessageIndex("message-1", 220, "topic-1").changes, 1);
  assert.equal(database.softDeleteMessageIndex("message-1", 110).changes, 1);
  assert.equal(database.softDeleteAvatarIndex("agent-1", "agent", 130).changes, 1);
  assert.equal(database.softDeleteEntityIndex("topic-missing", "topic", 300).changes, 0);

  assert.equal(db.prepare("SELECT deleted_at FROM entity_index WHERE id = 'topic-1'").get().deleted_at, 100);
  assert.equal(db.prepare("SELECT deleted_at FROM entity_index WHERE id = 'agent-1'").get().deleted_at, 120);
  assert.equal(db.prepare("SELECT deleted_at FROM message_index WHERE msg_id = 'message-1'").get().deleted_at, 110);
  assert.equal(db.prepare("SELECT deleted_at FROM avatar_index WHERE owner_id = 'agent-1'").get().deleted_at, 130);
});

test("owner deletion tombstones child topics without positional binding failures", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-owner-delete-"));
  t.after(() => {
    database.closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const db = database.initDb(path.join(tempDir, "sync.db"));
  const appDataPath = path.join(tempDir, "AppData");
  const configPath = path.join(appDataPath, "Agents", "agent-1", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    id: "agent-1",
    topics: [{ id: "topic-child", name: "child" }],
  }));
  database.upsertEntityIndex("agent-1", "agent", configPath, "a".repeat(64), 10);
  database.upsertEntityIndex("topic-child", "topic", configPath, "b".repeat(64), 10);
  database.upsertDesktopConfigIndex("agent-1", "agent", configPath, "c".repeat(64), 10);

  const result = await deleteEntity({
    id: "agent-1",
    type: "agent",
    deletedAt: 1700000000000,
    appDataPath,
  });

  assert.equal(result.success, true);
  assert.equal(db.prepare("SELECT deleted_at FROM entity_index WHERE id = 'agent-1'").get().deleted_at, 1700000000000);
  assert.equal(db.prepare("SELECT deleted_at FROM entity_index WHERE id = 'topic-child'").get().deleted_at, 1700000000000);
  assert.equal(db.prepare("SELECT deleted_at FROM desktop_config_index WHERE id = 'agent-1'").get().deleted_at, 1700000000000);
  assert.equal(fs.existsSync(path.dirname(configPath)), false);

  assert.deepEqual(
    await compareDesktopConfigManifest(appDataPath, [{
      id: "agent-1",
      type: "agent",
      hash: "c".repeat(64),
      ts: 10,
    }]),
    {
      actions: [{
        id: "agent-1",
        type: "agent",
        action: "DELETE",
        deletedAt: 1700000000000,
      }],
    },
  );
  assert.deepEqual(
    await uploadDesktopConfigs(appDataPath, [{
      id: "agent-1",
      type: "agent",
      data: { name: "stale copy" },
      hash: "d".repeat(64),
      ts: 20,
    }]),
    {
      items: [{
        id: "agent-1",
        type: "agent",
        success: false,
        error: "Desktop config is tombstoned",
      }],
    },
  );
  assert.equal(fs.existsSync(path.dirname(configPath)), false);
});
