"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const manifest = require("../Plugin/VCPChatSyncHub/plugin-manifest.json");
const {
  LEGACY_WIRE_PROTOCOL_VERSION,
  createPhaseAck,
  createVersionAck,
  parseJsonWithoutDuplicateKeys,
  resolveDeleteTimestamp,
} = require("../Plugin/VCPChatSyncHub/protocol");

test("VCPMobileSync 错误契约版本与移动端 1.2.0 对齐", () => {
  assert.equal(manifest.version, "1.2.0");
  assert.deepEqual(
    createVersionAck(
      {
        type: "VERSION_CHECK",
        mobileVersion: "1.1.4",
        protocolVersion: "1.2",
      },
      manifest.version,
    ),
    {
      type: "VERSION_ACK",
      version: "1.2.0",
      pluginVersion: "1.2.0",
      protocolVersion: "1.2",
    },
  );
});
test("官方 VCPMobile 1.1.3 省略 protocolVersion 时保持兼容", () => {
  assert.deepEqual(
    createVersionAck(
      { type: "VERSION_CHECK", mobileVersion: "1.1.3" },
      manifest.version,
    ),
    {
      type: "VERSION_ACK",
      version: "1.0.0",
      pluginVersion: "1.1.0",
      protocolVersion: "1.1",
    },
  );
});

test("显式 Wire 1.1 也协商到 legacy 契约", () => {
  assert.equal(LEGACY_WIRE_PROTOCOL_VERSION, "1.1");
  assert.deepEqual(
    createVersionAck(
      {
        type: "VERSION_CHECK",
        mobileVersion: "vcpchat-desktop-sync-1.1",
        protocolVersion: "1.1",
      },
      manifest.version,
    ),
    {
      type: "VERSION_ACK",
      version: "1.0.0",
      pluginVersion: "1.1.0",
      protocolVersion: "1.1",
    },
  );
});

test("VERSION_CHECK 缺少客户端版本或显式协议漂移时 fail closed", () => {
  assert.throws(
    () => createVersionAck({ type: "VERSION_CHECK" }, manifest.version),
    /mobileVersion/,
  );
  assert.throws(
    () =>
      createVersionAck(
        {
          type: "VERSION_CHECK",
          mobileVersion: "1.1.4",
          protocolVersion: "1.0",
        },
        manifest.version,
      ),
    (error) => error.code === "PROTOCOL_MISMATCH",
  );
});

test("仅 legacy 删除帧可以由服务端补 deletedAt", () => {
  assert.equal(resolveDeleteTimestamp(undefined, "1.1", () => 1234), 1234);
  assert.equal(resolveDeleteTimestamp(0, "1.1"), 0);
  assert.equal(resolveDeleteTimestamp(0, "1.2"), 0);
  assert.throws(
    () => resolveDeleteTimestamp(undefined, "1.2"),
    (error) => error.code === "SYNC_DELETE_INVALID",
  );
});

test("严格 JSON parser 拒绝重复 topic 与嵌套重复字段", () => {
  assert.throws(
    () =>
      parseJsonWithoutDuplicateKeys(
        '{"type":"SYNC_MESSAGE_DIFF_BATCH","topics":{"topic":{"topicHash":"","messages":{}},"topic":{"topicHash":"","messages":{}}}}',
      ),
    (error) => error.code === "PROTOCOL_DUPLICATE_KEY",
  );
  assert.throws(
    () => parseJsonWithoutDuplicateKeys('{"outer":{"id":"a","id":"b"}}'),
    (error) => error.code === "PROTOCOL_DUPLICATE_KEY",
  );
  assert.deepEqual(
    parseJsonWithoutDuplicateKeys('{"text":"\\u4e2d\\n文","values":[1,true,null]}'),
    { text: "中\n文", values: [1, true, null] },
  );
});

test("最终阶段 ACK 原样回显会话、attempt 与 nonce", () => {
  const payload = {
    type: "PHASE_COMPLETED",
    phase: "messages",
    sessionId: 17,
    attemptId: 4,
    nonce: "final-ack-nonce",
  };

  assert.deepEqual(createPhaseAck(payload, { echoFinalIdentity: true }), {
    type: "PHASE_ACK",
    phase: "messages",
    sessionId: 17,
    attemptId: 4,
    nonce: "final-ack-nonce",
  });
});

test("缺失的最终身份字段不会被默认值伪造", () => {
  assert.deepEqual(
    createPhaseAck(
      { type: "PHASE_COMPLETED", phase: "messages", sessionId: 0 },
      { echoFinalIdentity: true },
    ),
    {
      type: "PHASE_ACK",
      phase: "messages",
      sessionId: 0,
    },
  );
});

test("普通阶段 ACK 保持既有 phase-only 协议", () => {
  assert.deepEqual(createPhaseAck({ type: "PHASE_START", phase: "topic_metadata" }), {
    type: "PHASE_ACK",
    phase: "topic_metadata",
  });
});
