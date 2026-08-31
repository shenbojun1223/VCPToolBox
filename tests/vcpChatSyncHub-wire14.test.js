"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const {
  aggregateHashes14,
  messageHash14,
} = require("../Plugin/VCPChatSyncHub/wire14");

test("Wire 1.4 message fingerprint covers identity and durable fields", () => {
  const base = {
    id: "message-1",
    role: "user",
    content: "hello",
    timestamp: 123,
  };
  assert.notEqual(messageHash14(base), messageHash14({ ...base, role: "assistant" }));
  assert.notEqual(messageHash14(base), messageHash14({ ...base, timestamp: 124 }));
  assert.equal(
    messageHash14({ ...base, attachments: [{ hash: "b".repeat(64) }, { hash: "a".repeat(64) }] }),
    messageHash14({ ...base, attachments: [{ hash: "a".repeat(64) }, { hash: "b".repeat(64) }] }),
  );
});

test("Wire 1.4 aggregate hash is order independent and hashes the sorted stream", () => {
  const values = ["b".repeat(64), "a".repeat(64)];
  const expected = crypto.createHash("sha256").update(values.slice().sort().join("")).digest("hex");
  assert.equal(aggregateHashes14(values), expected);
  assert.equal(aggregateHashes14(values.slice().reverse()), expected);
  assert.equal(aggregateHashes14([]), "");
});
