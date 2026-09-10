"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const syncLogTestDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "vcp-chat-sync-lock-test-logs-"),
);
process.env.VCP_MOBILE_SYNC_LOG_DIR = syncLogTestDir;
after(() => {
  delete process.env.VCP_MOBILE_SYNC_LOG_DIR;
  fs.rmSync(syncLogTestDir, { recursive: true, force: true });
});

const databaseModule = require("../Plugin/VCPChatSyncHub/core/db");

test("SQLite connection uses WAL and waits for transient writer locks", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-busy-timeout-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const database = databaseModule.initDb(path.join(directory, "sync_state.db"));
  try {
    assert.equal(database.pragma("busy_timeout", { simple: true }), 2000);
    assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
  } finally {
    databaseModule.closeDb();
  }
});

test("transient or exhausted SQLITE_BUSY does not poison a valid history source", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-busy-retry-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const historyPath = path.join(directory, "history.json");
  fs.writeFileSync(historyPath, "[]", "utf8");

  const originalGetDb = databaseModule.getDb;
  const originalUpsertMessageIndex = databaseModule.upsertMessageIndex;
  const originalUpsertMessageAttachment = databaseModule.upsertMessageAttachment;

  let mode = "transient";
  let attempts = 0;
  const fakeDatabase = {
    prepare(sql) {
      if (sql.includes("SELECT msg_id FROM message_index")) {
        return { all: () => [] };
      }
      if (sql.includes("UPDATE entity_index SET aggregated_hash")) {
        return { run: () => ({ changes: 1 }) };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    transaction(callback) {
      return () => {
        attempts += 1;
        if (mode === "exhausted" || attempts === 1) {
          throw Object.assign(new Error("database is locked"), {
            code: "SQLITE_BUSY",
          });
        }
        return callback();
      };
    },
  };

  databaseModule.getDb = () => fakeDatabase;
  databaseModule.upsertMessageIndex = () => {};
  databaseModule.upsertMessageAttachment = () => {};

  const messagePath = require.resolve("../Plugin/VCPChatSyncHub/sync/message");
  delete require.cache[messagePath];
  const {
    assertHistoryTopicHealthy,
    ingestHistoryToDb,
    markHistoryTopicUnhealthy,
  } = require(messagePath);

  t.after(() => {
    databaseModule.getDb = originalGetDb;
    databaseModule.upsertMessageIndex = originalUpsertMessageIndex;
    databaseModule.upsertMessageAttachment = originalUpsertMessageAttachment;
    delete require.cache[messagePath];
  });

  const topicId = "topic-sqlite-busy-recovery";
  await ingestHistoryToDb(historyPath, topicId, "reconcile");
  assert.equal(attempts, 2);
  assert.doesNotThrow(() => assertHistoryTopicHealthy(topicId));

  mode = "exhausted";
  attempts = 0;
  markHistoryTopicUnhealthy(topicId, new Error("stale source poison"));
  await assert.rejects(
    () => ingestHistoryToDb(historyPath, topicId, "reconcile"),
    /database is locked/,
  );
  assert.equal(attempts, 3);
  assert.doesNotThrow(() => assertHistoryTopicHealthy(topicId));
});