"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, test } = require("node:test");

const syncLogTestDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "vcp-chat-sync-hub-test-logs-"),
);
process.env.VCP_MOBILE_SYNC_LOG_DIR = syncLogTestDir;
after(() => {
  delete process.env.VCP_MOBILE_SYNC_LOG_DIR;
  fs.rmSync(syncLogTestDir, { recursive: true, force: true });
});

const {
  resolveCentralIndexPreference,
} = require("../Plugin/VCPChatSyncHub/config/defaults");
const entityDatabase = require("../Plugin/VCPChatSyncHub/core/db");
const issue20EntityIndex = new Map();
entityDatabase.getDb = () => ({});
entityDatabase.getEntityIndex = (id, type) =>
  issue20EntityIndex.get(`${type}:${id}`) || null;
entityDatabase.upsertEntityIndex = (id, type, filePath, hash) => {
  issue20EntityIndex.set(`${type}:${id}`, {
    id,
    type,
    file_path: filePath,
    hash,
    deleted_at: null,
  });
};
const {
  handleSyncTopicHashBatch,
  handleSyncTopicHashBatchV2,
  handleSyncMessageDiffBatch,
} = require("../Plugin/VCPChatSyncHub/sync/diff");
const {
  checkIdempotency,
  recordOperation,
} = require("../Plugin/VCPChatSyncHub/core/idempotency");
const {
  readHistoryStrict,
  writeHistoryAtomic,
  markHistoryTopicUnhealthy,
  clearHistoryTopicUnhealthy,
} = require("../Plugin/VCPChatSyncHub/sync/message");
const {
  getLocalManifest,
  handleSyncManifest,
  handleMessageManifest,
} = require("../Plugin/VCPChatSyncHub/sync/manifest");
const {
  uploadEntity,
} = require("../Plugin/VCPChatSyncHub/sync/entity");

function fakeDiffDatabase({
  topics = {},
  messages = {},
  deletedMessages = {},
  attachments = {},
  fail = false,
} = {}) {
  return {
    prepare(sql) {
      if (fail) throw new Error("injected database failure");
      if (sql.includes("FROM entity_index")) {
        return { get: (topicId) => topics[topicId] };
      }
      if (sql.includes("FROM message_index")) {
        if (sql.includes("JOIN message_attachments")) {
          return { all: (topicId) => attachments[topicId] || [] };
        }
        if (sql.includes("deleted_at IS NOT NULL")) {
          return { all: (topicId) => deletedMessages[topicId] || [] };
        }
        return { all: (topicId) => messages[topicId] || [] };
      }
      throw new Error(`unexpected SQL in fake database: ${sql}`);
    },
  };
}

function fakeManifestDatabase({ entities = [], avatars = [], messages = [] } = {}) {
  return {
    prepare(sql) {
      if (sql.includes("FROM avatar_index")) {
        return { all: () => avatars };
      }
      if (sql.includes("FROM entity_index") && sql.includes("type = ?")) {
        return { all: (type) => entities.filter((row) => row.type === type) };
      }
      if (sql.includes("FROM entity_index")) {
        return {
          all: () => entities.filter((row) =>
            ["topic", "agent_topic", "group_topic"].includes(row.type)),
        };
      }
      if (sql.includes("FROM message_index")) {
        return { all: (topicId) => messages.filter((row) => row.topic_id === topicId) };
      }
      throw new Error(`unexpected SQL in fake manifest database: ${sql}`);
    },
  };
}

test("中央索引配置优先级是插件显式值 > Facade > 默认 true", () => {
  assert.equal(
    resolveCentralIndexPreference(
      { MobileSyncUseCentralIndex: false },
      { mobileSyncUseCentralIndex: true },
    ),
    false,
  );
  assert.equal(
    resolveCentralIndexPreference(
      { MobileSyncUseCentralIndex: true },
      { mobileSyncUseCentralIndex: false },
    ),
    true,
  );
  assert.equal(
    resolveCentralIndexPreference({}, { mobileSyncUseCentralIndex: false }),
    false,
  );
  assert.equal(resolveCentralIndexPreference({}, {}), true);
});

test("Phase 3 decision 只返回严格判别联合且不在 diff 中执行删除", () => {
  const remoteHash = "a".repeat(64);
  const result = handleSyncMessageDiffBatch(
    {
      topics: {
        "topic-live": {
          topicHash: "c".repeat(64),
          ownerType: "agent",
          ownerId: "agent-a",
          messages: { "message-1": "DELETED" },
        },
        "topic-missing": {
          topicHash: "",
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {},
        },
      },
    },
    fakeDiffDatabase({
      topics: {
        "topic-live": {
          aggregated_hash: "desktop",
          file_path: "/app/Agents/agent-a/config.json",
        },
      },
      messages: {
        "topic-live": [{ msg_id: "message-1", hash: remoteHash }],
      },
    }),
  );

  assert.deepEqual(result.results["topic-live"], {
    ok: true,
    toPull: [],
    toPush: false,
  });
  assert.deepEqual(result.results["topic-missing"], {
    ok: false,
    error: {
      code: "TOPIC_NOT_FOUND",
      origin: "desktop_plugin",
      stage: "messages",
      kind: "data",
      retry: "manual",
      message: "Topic topic-missing was not found in the desktop index",
      failedTopicIds: ["topic-missing"],
    },
  });
});

test("Wire 1.1 可省略消息 owner，Wire 1.2 对同一载荷仍严格拒绝", () => {
  const topicId = "topic-legacy-owner";
  const hash = "a".repeat(64);
  const payload = {
    topics: {
      [topicId]: {
        topicHash: hash,
        messages: { "message-1": hash },
      },
    },
  };
  const database = fakeDiffDatabase({
    topics: {
      [topicId]: {
        aggregated_hash: hash,
        file_path: "/app/Agents/agent-a/config.json",
      },
    },
  });

  assert.deepEqual(
    handleSyncMessageDiffBatch(payload, database, { protocolVersion: "1.1" })
      .results[topicId],
    { ok: true, toPull: [], toPush: false },
  );
  assert.throws(
    () => handleSyncMessageDiffBatch(payload, database, { protocolVersion: "1.2" }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
});

test("Phase 3 对桌面客户端返回服务端消息墓碑且禁止旧消息回推复活", () => {
  const result = handleSyncMessageDiffBatch(
    {
      topics: {
        "topic-live": {
          topicHash: "c".repeat(64),
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {
            "message-deleted": "a".repeat(64),
            "message-local-only": "b".repeat(64),
          },
        },
      },
    },
    fakeDiffDatabase({
      topics: {
        "topic-live": {
          aggregated_hash: "desktop-content",
          file_path: "/app/Agents/agent-a/config.json",
        },
      },
      messages: { "topic-live": [] },
      deletedMessages: {
        "topic-live": [{ msg_id: "message-deleted" }],
      },
    }),
  );

  assert.deepEqual(result.results["topic-live"], {
    ok: true,
    toPull: [],
    toPush: true,
    toDelete: ["message-deleted"],
  });
});

test("Phase 3 malformed hash 与 DB 查询错误都不能伪装成 no-op 完成", () => {
  assert.throws(
    () =>
      handleSyncMessageDiffBatch(
        {
          topics: {
            topic: {
              topicHash: "",
              ownerType: "agent",
              ownerId: "agent-a",
              messages: { message: "not-a-hash" },
            },
          },
        },
        fakeDiffDatabase(),
      ),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );

  const result = handleSyncMessageDiffBatch(
    {
      topics: {
        topic: {
          topicHash: "",
          ownerType: "agent",
          ownerId: "agent-a",
          messages: {},
        },
      },
    },
    fakeDiffDatabase({ fail: true }),
  );
  assert.equal(result.results.topic.ok, false);
  assert.equal(result.results.topic.error.code, "MESSAGE_DIFF_FAILED");
  assert.match(result.results.topic.error.message, /injected database failure/);
});

test("Phase 3 消息哈希一致时仍会要求补传缺失附件", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-attachment-repair-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const attachmentPath = path.join(directory, "attachment.bin");
  const topicId = "topic-attachment-repair";
  const hash = "a".repeat(64);
  const payload = {
    topics: {
      [topicId]: {
        topicHash: hash,
        ownerType: "agent",
        ownerId: "agent-a",
        messages: { "message-1": hash },
      },
    },
  };
  const database = fakeDiffDatabase({
    topics: {
      [topicId]: {
        aggregated_hash: hash,
        file_path: "/app/Agents/agent-a/config.json",
      },
    },
    messages: { [topicId]: [{ msg_id: "message-1", hash }] },
    attachments: { [topicId]: [{ hash, file_path: attachmentPath }] },
  });

  assert.equal(
    handleSyncMessageDiffBatch(payload, database).results[topicId].toPush,
    true,
  );

  fs.writeFileSync(attachmentPath, "attachment");
  assert.deepEqual(handleSyncMessageDiffBatch(payload, database).results[topicId], {
    ok: true,
    toPull: [],
    toPush: false,
  });

  fs.rmSync(attachmentPath);
  assert.equal(
    handleSyncMessageDiffBatch(payload, database).results[topicId].toPush,
    true,
  );
});

test("Phase 2.5 topic hash 对错误类型和超预算 fail closed", () => {
  assert.throws(
    () => handleSyncTopicHashBatch({ hashes: { topic: null } }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
  assert.throws(
    () =>
      handleSyncTopicHashBatchV2({
        hashes: { topic: { configHash: "bad", contentHash: "" } },
      }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
  const hashes = Object.fromEntries(
    Array.from({ length: 10_001 }, (_, index) => [`topic-${index}`, ""]),
  );
  assert.throws(
    () => handleSyncTopicHashBatch({ hashes }),
    (error) => error.code === "SYNC_BUDGET_EXCEEDED",
  );
});

test("Wire 1.1 可省略 Phase 2.5 compound topics，Wire 1.2 不可省略", () => {
  const topicId = "topic-legacy-phase-25";
  const hash = "a".repeat(64);
  const payload = {
    hashes: {
      [topicId]: { configHash: hash, contentHash: hash },
    },
  };
  const database = fakeDiffDatabase({
    topics: {
      [topicId]: {
        hash,
        aggregated_hash: hash,
        file_path: "/app/Agents/agent-a/config.json",
      },
    },
  });

  assert.deepEqual(
    handleSyncTopicHashBatchV2(payload, database, { protocolVersion: "1.1" }),
    { type: "SYNC_TOPIC_HASH_RESULTS", changedTopics: [] },
  );
  assert.throws(
    () => handleSyncTopicHashBatchV2(payload, database, { protocolVersion: "1.2" }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
});

test("issue #20: 未初始化数据库不会伪装成无变化 topic", () => {
  const hash = "a".repeat(64);
  assert.throws(
    () =>
      handleSyncTopicHashBatchV2(
        {
          hashes: {
            "topic-issue-20": { configHash: hash, contentHash: hash },
          },
          topics: [
            {
              topicId: "topic-issue-20",
              ownerType: "agent",
              ownerId: "agent-issue-20",
              configHash: hash,
              contentHash: hash,
            },
          ],
        },
        null,
      ),
    (error) => error.code === "SYNC_DB_UNAVAILABLE",
  );
});

test("issue #20: 手机新建 Agent/Group 时先创建桌面目标目录", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-issue-20-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  issue20EntityIndex.clear();

  const agentId = "agent_issue_20";
  const groupId = "group_issue_20";
  const agentResult = await uploadEntity({
    id: agentId,
    type: "agent",
    data: { name: "Mobile Agent" },
    appDataPath: directory,
  });
  const groupResult = await uploadEntity({
    id: groupId,
    type: "group",
    data: { name: "Mobile Group", members: [] },
    appDataPath: directory,
  });

  assert.deepEqual(agentResult, { success: true, id: agentId });
  assert.deepEqual(groupResult, { success: true, id: groupId });
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(directory, "Agents", agentId, "config.json"),
        "utf8",
      ),
    ).name,
    "Mobile Agent",
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(directory, "AgentGroups", groupId, "config.json"),
        "utf8",
      ),
    ).name,
    "Mobile Group",
  );
});

test("Topic manifest 使用复合 Owner 身份且不做路径模糊匹配", () => {
  const hash = "a".repeat(64);
  const database = fakeManifestDatabase({
    entities: [
      {
        id: "topic-a",
        type: "topic",
        file_path: "/app/Agents/agent-a/config.json",
        hash,
        aggregated_hash: "",
        updated_at: 1,
        deleted_at: null,
      },
      {
        id: "topic-b",
        type: "topic",
        file_path: "/app/Agents/agent-aa/config.json",
        hash,
        aggregated_hash: "",
        updated_at: 1,
        deleted_at: null,
      },
    ],
  });

  assert.deepEqual(
    getLocalManifest("topic", ["agent-a"], database).map((item) => item.id),
    ["topic-a"],
  );
  const result = handleSyncManifest(
    {
      dataType: "topic",
      phase: 2,
      targetedOwners: ["agent-a"],
      data: [{
        id: "topic-a",
        hash,
        configHash: hash,
        contentHash: "",
        ts: 1,
        ownerType: "agent",
        ownerId: "agent-a",
      }],
    },
    database,
  );
  assert.deepEqual(result.data, []);

  assert.throws(
    () => handleSyncManifest(
      {
        dataType: "topic",
        phase: 2,
        targetedOwners: ["agent-a", "agent-b"],
        data: [{
          id: "topic-a",
          hash,
          configHash: hash,
          contentHash: "",
          ts: 1,
          ownerType: "agent",
          ownerId: "agent-b",
        }],
      },
      database,
    ),
    (error) => error.code === "SYNC_OWNER_CONFLICT",
  );
});

test("Manifest 错型、重复 ID 和 deletedAt=0 均按硬切契约处理", () => {
  const hash = "b".repeat(64);
  const database = fakeManifestDatabase();
  assert.throws(
    () => handleSyncManifest({ dataType: "agent", phase: 1, data: {} }, database),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
  const item = {
    id: "agent-a",
    hash,
    configHash: hash,
    contentHash: "",
    ts: 1,
  };
  assert.throws(
    () => handleSyncManifest(
      { dataType: "agent", phase: 1, data: [item, item] },
      database,
    ),
    /duplicate id/,
  );
  const result = handleSyncManifest(
    {
      dataType: "agent",
      phase: 1,
      data: [{ ...item, deletedAt: 0 }],
    },
    database,
  );
  assert.deepEqual(result.data, [
    { id: "agent-a", action: "DELETE", deletedAt: 0 },
  ]);
});

test("Wire 1.1 topic manifest 可省略 ownerId 和临时空 hash，Wire 1.2 保持严格", () => {
  const localHash = "c".repeat(64);
  const database = fakeManifestDatabase({
    entities: [{
      id: "topic-legacy-manifest",
      type: "topic",
      file_path: "/app/Agents/agent-a/config.json",
      hash: localHash,
      aggregated_hash: localHash,
      updated_at: 1,
      deleted_at: null,
    }],
  });
  const payload = {
    dataType: "topic",
    phase: 2,
    targetedOwners: ["agent-a"],
    data: [{
      id: "topic-legacy-manifest",
      hash: "",
      configHash: "",
      contentHash: "",
      ts: 1,
      ownerType: "agent",
    }],
  };

  assert.deepEqual(
    handleSyncManifest(payload, database, { protocolVersion: "1.1" }).data,
    [{
      id: "topic-legacy-manifest",
      action: "PULL",
      ownerType: "agent",
      ownerId: "agent-a",
    }],
  );
  assert.throws(
    () => handleSyncManifest(payload, database, { protocolVersion: "1.2" }),
    (error) => error.code === "SYNC_PROTOCOL_INVALID",
  );
});

test("损坏 history 的旧索引不能走 topic hash 或消息 manifest 快速成功", () => {
  const topicId = "topic-unhealthy";
  markHistoryTopicUnhealthy(topicId, new Error("invalid JSON"));
  try {
    assert.throws(
      () => handleSyncTopicHashBatch(
        { hashes: { [topicId]: "" } },
        fakeDiffDatabase({ topics: { [topicId]: { aggregated_hash: "" } } }),
      ),
      (error) => error.code === "HISTORY_SOURCE_INVALID",
    );
    assert.throws(
      () => handleMessageManifest(
        { topicId },
        fakeManifestDatabase(),
      ),
      (error) => error.code === "HISTORY_SOURCE_INVALID",
    );
  } finally {
    clearHistoryTopicUnhealthy(topicId);
  }
});

test("幂等失败重放保留原 HTTP 状态", () => {
  const operationId = `failure-${process.pid}-${Date.now()}`;
  recordOperation(operationId, { success: false, error: "durable failure" }, 409);
  assert.deepEqual(checkIdempotency(operationId), {
    duplicate: true,
    result: { success: false, error: "durable failure" },
    statusCode: 409,
  });
});

test("history.json 只有不存在可视为空，损坏内容绝不被覆盖", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const historyPath = path.join(directory, "history.json");

  assert.deepEqual(await readHistoryStrict(historyPath), {
    history: [],
    sourceHash: null,
  });

  fs.writeFileSync(historyPath, "", "utf8");
  await assert.rejects(() => readHistoryStrict(historyPath), /Invalid history JSON/);
  fs.writeFileSync(historyPath, '{"messages":[]}', "utf8");
  await assert.rejects(() => readHistoryStrict(historyPath), /expected an array/);
});

test("history 原子提交在 source hash 变化时保留并发写入", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vcp-sync-cas-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const historyPath = path.join(directory, "history.json");
  fs.writeFileSync(historyPath, '[{"id":"base"}]', "utf8");
  const snapshot = await readHistoryStrict(historyPath);
  fs.writeFileSync(historyPath, '[{"id":"chat-writer"}]', "utf8");

  await assert.rejects(
    () =>
      writeHistoryAtomic(
        historyPath,
        [{ id: "mobile-writer" }],
        snapshot.sourceHash,
      ),
    /changed concurrently/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(historyPath, "utf8")), [
    { id: "chat-writer" },
  ]);
  assert.equal(
    fs.readdirSync(directory).some((name) => name.includes("mobile-sync")),
    false,
  );
});
