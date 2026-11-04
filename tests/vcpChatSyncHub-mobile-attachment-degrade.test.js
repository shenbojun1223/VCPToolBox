"use strict";

// 回归：手机 Push 路径的坏附件必须降级丢弃，而不是让整条消息被拒收。
// 背景缺陷：projection.js 曾把 canonicalizeAttachment 的软 warning 升级为
// MOBILE_ATTACHMENT_INVALID 硬协议错误，导致含坏附件的消息每轮重试都被连坐，永久无法入库。

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const {
  projectMobileMessage,
  projectMobileTopic,
} = require("../Plugin/VCPChatSyncHub/sync/projection");

const APP_DATA = path.join(__dirname, "__fixture_appdata__");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// 附件索引始终返回空，使 resolveAttachmentPath 走 null 分支，避免触碰真实磁盘。
function makeEmptyDb() {
  return {
    prepare() {
      return { get() { return undefined; } };
    },
  };
}

function baseMessage(overrides = {}) {
  return {
    id: "msg_degrade_user_0001",
    role: "user",
    content: "正文必须保留",
    timestamp: 1793689793486,
    ...overrides,
  };
}

async function project(rawMessage) {
  return projectMobileMessage({
    rawMessage,
    topicId: "topic_degrade",
    parentId: "agent_degrade",
    ownerType: "agent",
    db: makeEmptyDb(),
    appDataPath: APP_DATA,
  });
}

test("附件缺少合法 SHA-256 时丢弃附件并保留消息正文", async () => {
  const result = await project(
    baseMessage({
      attachments: [{ type: "image/png", name: "photo.png", size: 2048 }],
    }),
  );

  assert.equal(result.message.id, "msg_degrade_user_0001");
  assert.equal(result.message.content, "正文必须保留");
  assert.equal(result.message.timestamp, 1793689793486);
  assert.equal(result.message.attachments, undefined);
  assert.equal(result.warningCount, 1);
  assert.deepEqual(result.neededAttachmentHashes, []);
  assert.match(
    result.warningSamples[0],
    /missing, invalid, or conflicting SHA-256/,
  );
});

test("顶层与嵌套 SHA-256 冲突时丢弃附件并保留消息正文", async () => {
  const result = await project(
    baseMessage({
      attachments: [
        {
          type: "image/png",
          name: "photo.png",
          size: 2048,
          hash: HASH_A,
          _fileManagerData: { hash: HASH_B },
        },
      ],
    }),
  );

  assert.equal(result.message.content, "正文必须保留");
  assert.equal(result.message.attachments, undefined);
  assert.equal(result.warningCount, 1);
});

test("_fileManagerData 类型非法时丢弃附件并保留消息正文", async () => {
  const result = await project(
    baseMessage({
      attachments: [
        { type: "image/png", name: "photo.png", hash: HASH_A, _fileManagerData: [] },
      ],
    }),
  );

  assert.equal(result.message.content, "正文必须保留");
  assert.equal(result.message.attachments, undefined);
  assert.equal(result.warningCount, 1);
  assert.match(result.warningSamples[0], /invalid _fileManagerData/);
});

test("合法附件不产生 warning 且登记待取哈希", async () => {
  const result = await project(
    baseMessage({
      attachments: [
        { type: "image/png", name: "photo.png", size: 2048, hash: HASH_A },
      ],
    }),
  );

  assert.equal(result.warningCount, 0);
  assert.deepEqual(result.warningSamples, []);
  assert.equal(result.message.attachments.length, 1);
  // 桌面态附件由 createDesktopAttachment 构造：hash 落在 _fileManagerData 内，顶层不暴露。
  const desktopAttachment = result.message.attachments[0];
  assert.equal(desktopAttachment._fileManagerData.hash, HASH_A);
  assert.equal(desktopAttachment.name, "photo.png");
  assert.equal(desktopAttachment.type, "image/png");
  assert.equal(desktopAttachment.size, 2048);
  assert.deepEqual(result.neededAttachmentHashes, [HASH_A]);
});

test("projectMobileTopic 跨消息聚合 warning 且不丢任何消息", async () => {
  const result = await projectMobileTopic({
    topicId: "topic_degrade",
    ownerType: "agent",
    ownerId: "agent_degrade",
    messages: [
      baseMessage({
        id: "msg_bad_1",
        attachments: [{ type: "image/png", name: "a.png" }],
      }),
      baseMessage({
        id: "msg_good",
        attachments: [{ type: "image/png", name: "b.png", hash: HASH_A }],
      }),
      baseMessage({
        id: "msg_bad_2",
        attachments: [
          { type: "image/png", name: "c.png", hash: HASH_A, _fileManagerData: { hash: HASH_B } },
        ],
      }),
    ],
    db: makeEmptyDb(),
    appDataPath: APP_DATA,
  });

  assert.equal(result.messages.length, 3);
  assert.deepEqual(
    result.messages.map((message) => message.id),
    ["msg_bad_1", "msg_good", "msg_bad_2"],
  );
  assert.equal(result.warningCount, 2);
  assert.equal(result.warningSamples.length, 2);
  assert.deepEqual(result.neededAttachmentHashes, [HASH_A]);
  assert.equal(result.messages[0].attachments, undefined);
  assert.equal(result.messages[1].attachments.length, 1);
  assert.equal(result.messages[2].attachments, undefined);
});