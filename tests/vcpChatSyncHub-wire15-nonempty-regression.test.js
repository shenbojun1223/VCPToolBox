"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

// Independent oracle for these fixtures: all hashed objects have flat scalar fields.
function hashObject(value) {
  const sorted = Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]]));
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
function aggregate(hashes) {
  return hashes.length
    ? crypto.createHash("sha256").update([...hashes].sort().join("")).digest("hex")
    : "";
}

test("Wire 1.5 nonempty independent hash oracle and owner write protection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vcp-wire15-nonempty-"));
  const oldLogDir = process.env.VCP_MOBILE_SYNC_LOG_DIR;
  process.env.VCP_MOBILE_SYNC_LOG_DIR = path.join(root, "logs");
  let db;
  try {
    db = require("../Plugin/VCPChatSyncHub/core/db");
    const { handleManifest14, handleTopicDiff14 } =
      require("../Plugin/VCPChatSyncHub/wire14");
    const { refreshDesktopConfigIndex, uploadDesktopConfigs } =
      require("../Plugin/VCPChatSyncHub/sync/desktop-config");
    const appDataPath = path.join(root, "AppData");
    assert.ok(db.initDb(path.join(root, "sync_state.db")));

    await t.test("nonempty message and default Topic leaves converge; wrong roots differ", async () => {
      const ownerId = "fixture-agent";
      const owner = { ownerType: "agent", ownerId };
      const dto = {
        name: "Synthetic", systemPrompt: "Fixture only", model: "fixture",
        temperature: 0.7, contextTokenLimit: 12345,
        maxOutputTokens: 6789, streamOutput: true,
      };
      const topic = {
        id: "default", name: "Fixture topic", createdAt: 1,
        locked: true, unread: false,
      };
      const messages = [
        { id: "m-a", role: "user", content: "Alpha", timestamp: 101 },
        { id: "m-b", role: "assistant", content: "Beta", timestamp: 102 },
      ];
      const configPath = path.join(appDataPath, "Agents", ownerId, "config.json");
      const historyPath = path.join(appDataPath, "UserData", ownerId, "topics", topic.id, "history.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ ...dto, customCss: "fixture", topics: [topic] }));
      await fs.writeFile(historyPath, JSON.stringify(messages));
      const configBefore = await fs.readFile(configPath);
      const historyBefore = await fs.readFile(historyPath);
      const updatedAt = Math.trunc((await fs.stat(configPath)).mtimeMs);
      const configHash = hashObject(dto);
      const topicConfigHash = hashObject(topic);
      const messageHashes = messages.map(hashObject);
      const contentHash = aggregate(messages.map((m, i) =>
        hashObject({ id: m.id, hash: messageHashes[i] })));
      const ownerRoot = aggregate([hashObject({
        topicId: topic.id, configHash: topicConfigHash, contentHash,
      })]);
      const options = { protocolVersion: "1.5" };
      const request = (rootHash) => ({
        type: "SYNC_MANIFEST_REQUEST", manifestType: "owner",
        items: [{ ...owner, configHash, contentHash: rootHash, updatedAt }],
      });
      for (let round = 0; round < 2; round++) {
        const result = await handleManifest14(request(ownerRoot), appDataPath, options);
        assert.deepEqual(result.results, [], "nonempty owner must converge");
      }
      const wrongRoot = await handleManifest14(request(""), appDataPath, options);
      assert.ok(wrongRoot.results.length > 0, "owner content root must not be ignored");

      const topicRequest = {
        type: "SYNC_MANIFEST_REQUEST", manifestType: "topic",
        targetedOwners: [owner],
        // VCPMobile 1.1.6 TopicManifestLive has no contentHash.
        items: [{ ...owner, topicId: topic.id, configHash: topicConfigHash, updatedAt }],
      };
      assert.deepEqual(
        (await handleManifest14(topicRequest, appDataPath, options)).results, [],
        "default Topic must participate in the same hash contract",
      );
      const diffRequest = {
        type: "SYNC_TOPIC_DIFF_REQUEST",
        topics: [{ ...owner, topicId: topic.id, configHash: topicConfigHash, contentHash }],
      };
      assert.deepEqual(
        (await handleTopicDiff14(diffRequest, appDataPath, options)).changedTopics, [],
        "independent message leaf root must match",
      );
      const wrongDiff = await handleTopicDiff14({
        ...diffRequest,
        topics: [{ ...diffRequest.topics[0], contentHash: aggregate(messageHashes) }],
      }, appDataPath, options);
      assert.ok(wrongDiff.changedTopics.length > 0, "legacy root must not match Wire 1.5");
      assert.deepEqual(await fs.readFile(configPath), configBefore);
      assert.deepEqual(await fs.readFile(historyPath), historyBefore);
    });

    await t.test("invalid Group memberTags fails before replacement in both upload paths", async () => {
      const id = "fixture-group";
      const filePath = path.join(appDataPath, "AgentGroups", id, "config.json");
      const config = {
        id, name: "Original", members: ["fixture-agent"], mode: "sequential",
        memberTags: { "fixture-agent": "valid" }, createdAt: 1,
        useUnifiedModel: false, customCss: "preserve me", topics: [],
      };
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(config, null, 2));
      await refreshDesktopConfigIndex(appDataPath);
      const before = await fs.readFile(filePath);
      for (const ownerDto of [true, false]) {
        const result = await uploadDesktopConfigs(appDataPath, [{
          id, type: "group", ts: 123,
          data: { name: "Must not persist", memberTags: { "fixture-agent": ["invalid"] } },
        }], { ownerDto });
        assert.equal(result.items.length, 1);
        assert.equal(result.items[0].success, false);
        assert.match(result.items[0].error, /memberTags/);
        assert.deepEqual(await fs.readFile(filePath), before, "rejected upload changed config");
      }
    });
  } finally {
    if (db) db.closeDb();
    if (oldLogDir === undefined) delete process.env.VCP_MOBILE_SYNC_LOG_DIR;
    else process.env.VCP_MOBILE_SYNC_LOG_DIR = oldLogDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});