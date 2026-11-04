"use strict";

// 回归：同步层对 VCPChat 自身合法的非字符串 content 形态必须展平而非整帧硬失败。
// 背景缺陷：群聊乐观消息在渲染器内存中为 { text } 对象，一旦被整份回写落盘，
// canonicalizeMessage 的 content 硬抛会让整个话题帧永久无法同步（11 条消息实例）。

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  canonicalizeMessage,
  canonicalizeTopicFrame,
  flattenMessageContent,
} = require("../Plugin/VCPChatSyncHub/sync/canonical");

function message(content, overrides = {}) {
  return {
    id: "msg_flatten_user_0001",
    role: "user",
    content,
    timestamp: 1793692122045,
    ...overrides,
  };
}

test("flattenMessageContent 只接受可确定语义的形态", () => {
  assert.equal(flattenMessageContent({ text: "群聊正文" }), "群聊正文");
  assert.equal(flattenMessageContent({ text: "" }), "");
  assert.equal(
    flattenMessageContent([
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ]),
    "第一段\n第二段",
  );
  assert.equal(flattenMessageContent([]), "");
  // 无法确定语义的形态必须返回 null，由调用方拒绝，不得猜测
  assert.equal(flattenMessageContent({ caption: "无 text 字段" }), null);
  assert.equal(flattenMessageContent({ text: 42 }), null);
  assert.equal(flattenMessageContent([{ type: "image_url", url: "x" }]), null);
  assert.equal(flattenMessageContent(["裸字符串"]), null);
  assert.equal(flattenMessageContent(42), null);
});

test("object{text} content 被展平且不再抛错", () => {
  const result = canonicalizeMessage(
    message({ text: "等等等等，你们太发散了" }),
    "group_topic_flatten",
  );
  assert.equal(result.content, "等等等等，你们太发散了");
  assert.equal(typeof result.content, "string");
});

test("数组 content 按换行拼接展平", () => {
  const result = canonicalizeMessage(
    message([
      { type: "text", text: "行一" },
      { type: "text", text: "行二" },
    ]),
    "group_topic_flatten",
  );
  assert.equal(result.content, "行一\n行二");
});

test("无法确定语义的 content 仍然硬失败", () => {
  assert.throws(
    () => canonicalizeMessage(message({ caption: "x" }), "group_topic_flatten"),
    /content must be a string/,
  );
  assert.throws(
    () => canonicalizeMessage(message(42), "group_topic_flatten"),
    /content must be a string/,
  );
});

test("字符串与缺省 content 行为不变", () => {
  assert.equal(
    canonicalizeMessage(message("原本就是字符串"), "group_topic_flatten").content,
    "原本就是字符串",
  );
  assert.equal(canonicalizeMessage(message(null), "group_topic_flatten").content, "");
  const absent = message("x");
  delete absent.content;
  assert.equal(canonicalizeMessage(absent, "group_topic_flatten").content, "");
});

test("展平计数独立统计，不混入附件 warnings", () => {
  const frame = canonicalizeTopicFrame(
    {
      topicId: "group_topic_flatten",
      messages: [
        message({ text: "对象态" }, { id: "msg_a" }),
        message("字符串态", { id: "msg_b" }),
        message([{ type: "text", text: "数组态" }], { id: "msg_c" }),
      ],
    },
    { includeContentHash: false },
  );

  assert.equal(frame.frame.messages.length, 3);
  assert.deepEqual(
    frame.frame.messages.map((item) => item.content),
    ["对象态", "字符串态", "数组态"],
  );
  assert.equal(frame.contentRewriteCount, 2);
  assert.equal(frame.contentRewriteSamples.length, 2);
  assert.match(frame.contentRewriteSamples[0], /non-string content flattened \(object\)/);
  assert.match(frame.contentRewriteSamples[1], /non-string content flattened \(array\)/);
  // 附件 warning 通道必须保持干净：展平不是附件问题
  assert.equal(frame.warningCount, 0);
  assert.deepEqual(frame.warningSamples, []);
  // Mobile 拒绝未知响应字段：展平计数不得写入 frame
  assert.equal(frame.frame.contentRewriteCount, undefined);
  assert.equal(frame.frame.contentRewriteSamples, undefined);
});

test("整帧不再因单条非字符串 content 失败", () => {
  assert.doesNotThrow(() =>
    canonicalizeTopicFrame(
      {
        topicId: "group_topic_flatten",
        messages: [
          message("正常一", { id: "msg_1" }),
          message({ text: "曾经导致整帧失败的那条" }, { id: "msg_2" }),
          message("正常二", { id: "msg_3" }),
        ],
      },
      { includeContentHash: false },
    ),
  );
});