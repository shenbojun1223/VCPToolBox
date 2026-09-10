"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("Owner manifest preserves desktop full hash and converges on mobile DTO hash", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vcp-owner-contract-"));
  const oldLogDir = process.env.VCP_MOBILE_SYNC_LOG_DIR;
  process.env.VCP_MOBILE_SYNC_LOG_DIR = path.join(root, "logs");
  let closeDb;
  try {
    const db = require("../Plugin/VCPChatSyncHub/core/db");
    closeDb = db.closeDb;
    const { handleManifest14 } = require("../Plugin/VCPChatSyncHub/wire14");
    const { computeDtoHash } = require("../Plugin/VCPChatSyncHub/core/hash");
    const { extractAgentDTO, AGENT_SYNC_FIELDS } = require("../Plugin/VCPChatSyncHub/dto");
    const { computeDesktopConfigHash } = require("../Plugin/VCPChatSyncHub/sync/desktop-config");

    const appDataPath = path.join(root, "AppData");
    const ownerId = "isolated-owner";
    const dir = path.join(appDataPath, "Agents", ownerId);
    await fs.mkdir(dir, { recursive: true });
    const config = {
      name: "Contract fixture",
      systemPrompt: "Synthetic test only",
      model: "fixture-model",
      temperature: 0.7,
      contextTokenLimit: 12345,
      maxOutputTokens: 6789,
      streamOutput: true,
      customCss: ".fixture { color: blue; }",
      topics: [],
    };
    const configPath = path.join(dir, "config.json");
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    const before = await fs.readFile(configPath, "utf8");
    const updatedAt = Math.trunc((await fs.stat(configPath)).mtimeMs);
    assert.ok(db.initDb(path.join(root, "sync_state.db")));

    const request = (configHash) => ({
      type: "SYNC_MANIFEST_REQUEST",
      manifestType: "owner",
      items: [{
        ownerType: "agent",
        ownerId,
        configHash,
        contentHash: "",
        updatedAt,
      }],
    });

    const desktopHash = computeDesktopConfigHash(config);
    const mobileHash = computeDtoHash(extractAgentDTO(config), AGENT_SYNC_FIELDS);
    assert.notEqual(desktopHash, mobileHash, "fixture must distinguish representations");

    const desktop = await handleManifest14(
      request(desktopHash), appDataPath, { protocolVersion: "1.4" },
    );
    assert.deepEqual(desktop.results, [], "desktop full-config contract must remain unchanged");

    const mobile = await handleManifest14(
      request(mobileHash), appDataPath, { protocolVersion: "1.5" },
    );
    assert.deepEqual(mobile.results, [], "identical mobile DTO must not trigger owner synchronization");
    assert.equal(await fs.readFile(configPath, "utf8"), before, "manifest must not rewrite config");
  } finally {
    if (closeDb) closeDb();
    if (oldLogDir === undefined) delete process.env.VCP_MOBILE_SYNC_LOG_DIR;
    else process.env.VCP_MOBILE_SYNC_LOG_DIR = oldLogDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});