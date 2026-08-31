"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs").promises;
const path = require("node:path");
const express = require("express");

const { getDb } = require("./core/db");
const { computeDtoHash } = require("./core/hash");
const {
  normalizeSyncError,
  createHttpErrorBody,
} = require("./error-contract");
const {
  refreshDesktopConfigIndex,
  downloadDesktopConfigs,
  uploadDesktopConfigs,
} = require("./sync/desktop-config");
const {
  downloadAvatar,
  uploadAvatar,
  deleteEntity,
  sanitizeId,
} = require("./sync/entity");
const {
  readHistoryStrict,
  writeHistoryAtomic,
} = require("./sync/message");
const { canonicalizeHistory } = require("./sync/canonical");
const { projectMobileTopic } = require("./sync/projection");
const { acquireLock } = require("./utils/lock");
const {
  AGENT_TOPIC_SYNC_FIELDS,
  GROUP_TOPIC_SYNC_FIELDS,
  extractTopicDTO,
  applyTopicDTO,
} = require("./dto");
const {
  readNdjsonLines,
  decodeNdjsonLine,
} = require("./transport/ndjson");
const { parseJsonWithoutDuplicateKeys } = require("./protocol");
const { getLogger } = require("./core/logger");

const MAX_MANIFEST_ITEMS = 10_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTENT_HASH_PATTERN = /^(?:|[a-f0-9]{64})$/;

function contractError(message, code = "SYNC_PROTOCOL_INVALID") {
  return Object.assign(new Error(message), { code });
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw contractError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireId(value, label) {
  requireString(value, label);
  if (sanitizeId(value) !== value) {
    throw contractError(`${label} contains unsupported characters`);
  }
  return value;
}

function requireOwner(ownerType, ownerId, { avatar = false } = {}) {
  const allowed = avatar ? ["agent", "group", "user"] : ["agent", "group"];
  if (
    !allowed.includes(ownerType) ||
    typeof ownerId !== "string" ||
    sanitizeId(ownerId) !== ownerId ||
    !ownerId ||
    (ownerType === "user" && ownerId !== "user_avatar")
  ) {
    throw contractError(`Invalid owner identity ${ownerType}/${ownerId}`);
  }
  return { ownerType, ownerId };
}

function requireHash(value, label, { empty = false } = {}) {
  if (typeof value !== "string" || !(empty ? CONTENT_HASH_PATTERN : HASH_PATTERN).test(value)) {
    throw contractError(`${label} must be ${empty ? "empty or " : ""}a lowercase SHA-256 hash`);
  }
  return value;
}

function requireTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw contractError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requireExactKeys(value, keys, label) {
  const expected = [...keys].sort().join("\0");
  const actual = Object.keys(value).sort().join("\0");
  if (actual !== expected) {
    throw contractError(`${label} has unexpected or missing fields`);
  }
}

function ownerConfigPath(appDataPath, ownerType, ownerId) {
  return path.join(
    appDataPath,
    ownerType === "group" ? "AgentGroups" : "Agents",
    ownerId,
    "config.json",
  );
}

function topicHistoryPath(appDataPath, ownerId, topicId) {
  return path.join(
    appDataPath,
    "UserData",
    ownerId,
    "topics",
    topicId,
    "history.json",
  );
}

async function readPhysicalTopic(appDataPath, ownerType, ownerId, topicId) {
  requireOwner(ownerType, ownerId);
  requireId(topicId, "topicId");
  const configPath = ownerConfigPath(appDataPath, ownerType, ownerId);
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const config = JSON.parse(raw);
  const topics = Array.isArray(config.topics) ? config.topics : [];
  const topic = topics.find((item) => item?.id === topicId);
  if (!topic) return null;
  return { config, configPath, topic };
}

async function scanPhysicalTopics(appDataPath) {
  const results = [];
  for (const [ownerType, folder] of [["agent", "Agents"], ["group", "AgentGroups"]]) {
    const basePath = path.join(appDataPath, folder);
    let entries = [];
    try {
      entries = await fs.readdir(basePath, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || sanitizeId(entry.name) !== entry.name) continue;
      const ownerId = entry.name;
      const configPath = path.join(basePath, ownerId, "config.json");
      try {
        const [raw, stats] = await Promise.all([
          fs.readFile(configPath, "utf8"),
          fs.stat(configPath),
        ]);
        const config = JSON.parse(raw);
        for (const topic of Array.isArray(config.topics) ? config.topics : []) {
          if (!topic?.id || sanitizeId(topic.id) !== topic.id) continue;
          const dto = extractTopicDTO(topic, ownerId, ownerType);
          results.push({
            ownerType,
            ownerId,
            topicId: topic.id,
            configHash: computeDtoHash(
              dto,
              ownerType === "group"
                ? GROUP_TOPIC_SYNC_FIELDS
                : AGENT_TOPIC_SYNC_FIELDS,
            ),
            contentHash: "",
            updatedAt: Math.trunc(stats.mtimeMs || Date.now()),
            dto,
          });
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          getLogger().logOperation(
            "topic_metadata",
            "wire14_scan",
            `${ownerType}/${ownerId}`,
            "error",
            error.message,
          );
        }
      }
    }
  }
  return results;
}

async function writePhysicalTopic(appDataPath, item) {
  const configPath = ownerConfigPath(
    appDataPath,
    item.ownerType,
    item.ownerId,
  );
  const release = await acquireLock(configPath);
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (!Array.isArray(config.topics)) config.topics = [];
    const index = config.topics.findIndex((topic) => topic?.id === item.topicId);
    const current = index >= 0 ? config.topics[index] : { id: item.topicId };
    const dto = { ...item.data, id: item.topicId };
    const updated = applyTopicDTO(current, dto, item.ownerType);
    if (index >= 0) config.topics[index] = updated;
    else config.topics.push(updated);
    const temporary = `${configPath}.tmp_${process.pid}_${Date.now()}`;
    await fs.writeFile(temporary, JSON.stringify(config, null, 2), "utf8");
    await fs.rename(temporary, configPath);
    return { success: true };
  } finally {
    release();
  }
}

async function deletePhysicalTopic(appDataPath, ownerType, ownerId, topicId) {
  const configPath = ownerConfigPath(appDataPath, ownerType, ownerId);
  const release = await acquireLock(configPath);
  try {
    try {
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      if (Array.isArray(config.topics)) {
        const remaining = config.topics.filter((topic) => topic?.id !== topicId);
        if (remaining.length !== config.topics.length) {
          config.topics = remaining;
          const temporary = `${configPath}.tmp_${process.pid}_${Date.now()}`;
          await fs.writeFile(temporary, JSON.stringify(config, null, 2), "utf8");
          await fs.rename(temporary, configPath);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  } finally {
    release();
  }
  const topicDirectory = path.dirname(topicHistoryPath(appDataPath, ownerId, topicId));
  await fs.rm(topicDirectory, { recursive: true, force: true });
  return { success: true };
}

function ensureWire14Tombstones(db = getDb()) {
  if (!db) throw contractError("Database not initialized", "SYNC_DB_UNAVAILABLE");
  db.exec(`
    CREATE TABLE IF NOT EXISTS wire14_tombstones (
      target_type TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      topic_id TEXT NOT NULL DEFAULT '',
      msg_id TEXT NOT NULL DEFAULT '',
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (target_type, owner_type, owner_id, topic_id, msg_id)
    )
  `);
  return db;
}

function recordWire14Tombstone({
  targetType,
  ownerType,
  ownerId,
  topicId = "",
  msgId = "",
  deletedAt,
}) {
  const db = ensureWire14Tombstones();
  db.prepare(`
    INSERT INTO wire14_tombstones (
      target_type, owner_type, owner_id, topic_id, msg_id, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(target_type, owner_type, owner_id, topic_id, msg_id)
    DO UPDATE SET deleted_at = MIN(wire14_tombstones.deleted_at, excluded.deleted_at)
  `).run(targetType, ownerType, ownerId, topicId, msgId, deletedAt);
}

function wire14Tombstones(targetType) {
  const db = ensureWire14Tombstones();
  return db.prepare(
    "SELECT * FROM wire14_tombstones WHERE target_type = ?",
  ).all(targetType);
}

function identityKey(value, type) {
  return type === "topic"
    ? `${value.ownerType}\0${value.ownerId}\0${value.topicId}`
    : `${value.ownerType}\0${value.ownerId}`;
}

function actionIdentity(value, type) {
  return type === "topic"
    ? {
        ownerType: value.ownerType,
        ownerId: value.ownerId,
        topicId: value.topicId,
      }
    : { ownerType: value.ownerType, ownerId: value.ownerId };
}

function validateTargetedOwners(manifestType, value) {
  if (manifestType !== "topic") {
    if (value !== undefined) {
      throw contractError("targetedOwners is only valid for topic manifests");
    }
    return null;
  }
  if (!Array.isArray(value) || value.length > MAX_MANIFEST_ITEMS) {
    throw contractError("Topic manifest requires at most 10000 targetedOwners");
  }
  const result = new Set();
  for (const [index, owner] of value.entries()) {
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
      throw contractError(`targetedOwners[${index}] must be an owner identity`);
    }
    requireExactKeys(owner, ["ownerType", "ownerId"], `targetedOwners[${index}]`);
    requireOwner(owner.ownerType, owner.ownerId);
    const key = identityKey(owner, "owner");
    if (result.has(key)) throw contractError("targetedOwners contains a duplicate owner identity");
    result.add(key);
  }
  return result;
}

function normalizeManifestItem(item, manifestType, index) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw contractError(`Manifest item ${index} must be an object`);
  }
  requireOwner(item.ownerType, item.ownerId, { avatar: manifestType === "avatar" });
  const identity = { ownerType: item.ownerType, ownerId: item.ownerId };
  if (manifestType === "topic") {
    identity.topicId = requireId(item.topicId, `Manifest item ${index} topicId`);
  }
  if (Object.prototype.hasOwnProperty.call(item, "deletedAt")) {
    requireExactKeys(
      item,
      manifestType === "topic"
        ? ["ownerType", "ownerId", "topicId", "deletedAt"]
        : ["ownerType", "ownerId", "deletedAt"],
      `Manifest item ${index}`,
    );
    return { ...identity, deletedAt: requireTimestamp(item.deletedAt, `Manifest item ${index} deletedAt`) };
  }
  if (manifestType === "avatar") {
    requireExactKeys(item, ["ownerType", "ownerId", "binaryHash", "updatedAt"], `Manifest item ${index}`);
    return {
      ...identity,
      binaryHash: requireHash(item.binaryHash, `Manifest item ${index} binaryHash`),
      updatedAt: requireTimestamp(item.updatedAt, `Manifest item ${index} updatedAt`),
    };
  }
  requireExactKeys(
    item,
    manifestType === "topic"
      ? ["ownerType", "ownerId", "topicId", "configHash", "contentHash", "updatedAt"]
      : ["ownerType", "ownerId", "configHash", "contentHash", "updatedAt"],
    `Manifest item ${index}`,
  );
  return {
    ...identity,
    configHash: requireHash(item.configHash, `Manifest item ${index} configHash`),
    contentHash: requireHash(item.contentHash, `Manifest item ${index} contentHash`, { empty: true }),
    updatedAt: requireTimestamp(item.updatedAt, `Manifest item ${index} updatedAt`),
  };
}

async function localManifest14(manifestType, targetedOwners, appDataPath) {
  const db = ensureWire14Tombstones();

  if (manifestType === "owner") {
    await refreshDesktopConfigIndex(appDataPath);
    const items = db.prepare(
      "SELECT id, type, hash, updated_at, deleted_at FROM desktop_config_index",
    ).all().map((row) => row.deleted_at == null
      ? {
          ownerType: row.type,
          ownerId: row.id,
          configHash: requireHash(row.hash, `Owner ${row.id} configHash`),
          contentHash: "",
          updatedAt: requireTimestamp(row.updated_at, `Owner ${row.id} updatedAt`),
        }
      : { ownerType: row.type, ownerId: row.id, deletedAt: row.deleted_at });
    const byIdentity = new Map(items.map((item) => [identityKey(item, "owner"), item]));
    for (const tombstone of wire14Tombstones("owner")) {
      const item = {
        ownerType: tombstone.owner_type,
        ownerId: tombstone.owner_id,
        deletedAt: tombstone.deleted_at,
      };
      byIdentity.set(identityKey(item, "owner"), item);
    }
    return [...byIdentity.values()];
  }

  if (manifestType === "avatar") {
    const items = db.prepare(
      "SELECT owner_id, owner_type, hash, updated_at, deleted_at FROM avatar_index",
    ).all().map((row) => row.deleted_at == null
      ? {
          ownerType: row.owner_type,
          ownerId: row.owner_id,
          binaryHash: requireHash(row.hash, `Avatar ${row.owner_id} binaryHash`),
          updatedAt: requireTimestamp(row.updated_at, `Avatar ${row.owner_id} updatedAt`),
        }
      : { ownerType: row.owner_type, ownerId: row.owner_id, deletedAt: row.deleted_at });
    const byIdentity = new Map(items.map((item) => [identityKey(item, "avatar"), item]));
    for (const tombstone of wire14Tombstones("avatar")) {
      const item = {
        ownerType: tombstone.owner_type,
        ownerId: tombstone.owner_id,
        deletedAt: tombstone.deleted_at,
      };
      byIdentity.set(identityKey(item, "avatar"), item);
    }
    return [...byIdentity.values()];
  }

  const items = (await scanPhysicalTopics(appDataPath)).filter((item) =>
    !targetedOwners || targetedOwners.has(identityKey(item, "owner"))
  );
  const byIdentity = new Map(items.map((item) => [identityKey(item, "topic"), item]));
  for (const tombstone of wire14Tombstones("topic")) {
    const item = {
      ownerType: tombstone.owner_type,
      ownerId: tombstone.owner_id,
      topicId: tombstone.topic_id,
      deletedAt: tombstone.deleted_at,
    };
    if (!targetedOwners || targetedOwners.has(identityKey(item, "owner"))) {
      byIdentity.set(identityKey(item, "topic"), item);
    }
  }
  return [...byIdentity.values()];
}

async function handleManifest14(payload, appDataPath) {
  const { manifestType, items, targetedOwners } = payload;
  if (!["owner", "topic", "avatar"].includes(manifestType)) {
    throw contractError(`Unsupported manifestType ${manifestType}`);
  }
  if (!Array.isArray(items) || items.length > MAX_MANIFEST_ITEMS) {
    throw contractError(`${manifestType} manifest must contain at most 10000 items`);
  }
  const ownerFilter = validateTargetedOwners(manifestType, targetedOwners);
  const remote = items.map((item, index) => normalizeManifestItem(item, manifestType, index));
  const remoteMap = new Map();
  for (const item of remote) {
    if (manifestType === "topic" && !ownerFilter.has(identityKey(item, "owner"))) {
      throw contractError(`Topic manifest ${item.topicId} has an unexpected owner`);
    }
    const key = identityKey(item, manifestType);
    if (remoteMap.has(key)) throw contractError(`${manifestType} manifest contains a duplicate identity`);
    remoteMap.set(key, item);
  }
  const local = await localManifest14(manifestType, ownerFilter, appDataPath);
  const localMap = new Map(local.map((item) => [identityKey(item, manifestType), item]));
  const results = [];
  const processed = new Set();

  for (const remoteItem of remote) {
    const key = identityKey(remoteItem, manifestType);
    const localItem = localMap.get(key);
    if (remoteItem.deletedAt !== undefined) {
      if (!localItem || localItem.deletedAt === undefined) {
        results.push({ ...actionIdentity(remoteItem, manifestType), action: "PUSH_DELETE", deletedAt: remoteItem.deletedAt });
      }
    } else if (!localItem) {
      results.push({ ...actionIdentity(remoteItem, manifestType), action: "PUSH" });
    } else if (localItem.deletedAt !== undefined) {
      results.push({ ...actionIdentity(localItem, manifestType), action: "PULL_DELETE", deletedAt: localItem.deletedAt });
    } else {
      const remoteHash = manifestType === "avatar" ? remoteItem.binaryHash : remoteItem.configHash;
      const localHash = manifestType === "avatar" ? localItem.binaryHash : localItem.configHash;
      if (remoteHash !== localHash) {
        results.push({
          ...actionIdentity(remoteItem.updatedAt > localItem.updatedAt ? remoteItem : localItem, manifestType),
          action: remoteItem.updatedAt > localItem.updatedAt ? "PUSH" : "PULL",
        });
      }
      if (
        manifestType === "owner" &&
        remoteItem.contentHash !== localItem.contentHash
      ) {
        const existing = results.find((item) => identityKey(item, manifestType) === key);
        if (existing) existing.contentHashMismatch = true;
        else results.push({ ...actionIdentity(remoteItem, manifestType), action: "SKIP", contentHashMismatch: true });
      }
    }
    processed.add(key);
  }

  for (const localItem of local) {
    const key = identityKey(localItem, manifestType);
    if (processed.has(key) || remoteMap.has(key)) continue;
    results.push(localItem.deletedAt !== undefined
      ? { ...actionIdentity(localItem, manifestType), action: "PULL_DELETE", deletedAt: localItem.deletedAt }
      : { ...actionIdentity(localItem, manifestType), action: "PULL" });
  }

  return { type: "SYNC_MANIFEST_RESULT", manifestType, results };
}

async function handleTopicDiff14(payload, appDataPath) {
  if (!Array.isArray(payload.topics) || payload.topics.length > MAX_MANIFEST_ITEMS) {
    throw contractError("SYNC_TOPIC_DIFF_REQUEST.topics must be an array of at most 10000 items");
  }
  const db = getDb();
  if (!db) throw contractError("Database not initialized", "SYNC_DB_UNAVAILABLE");
  const seen = new Set();
  const changedTopics = [];
  for (const state of payload.topics) {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw contractError("Invalid compound topic hash state");
    }
    requireExactKeys(state, ["topicId", "ownerType", "ownerId", "configHash", "contentHash"], "Topic diff state");
    requireId(state.topicId, "Topic diff topicId");
    requireOwner(state.ownerType, state.ownerId);
    requireHash(state.configHash, "Topic diff configHash");
    requireHash(state.contentHash, "Topic diff contentHash", { empty: true });
    const key = identityKey(state, "topic");
    if (seen.has(key)) throw contractError("Duplicate compound topic hash state");
    seen.add(key);
    const physical = await readPhysicalTopic(
      appDataPath,
      state.ownerType,
      state.ownerId,
      state.topicId,
    );
    if (!physical) {
      changedTopics.push(actionIdentity(state, "topic"));
      continue;
    }
    const dto = extractTopicDTO(
      physical.topic,
      state.ownerId,
      state.ownerType,
    );
    const configHash = computeDtoHash(
      dto,
      state.ownerType === "group"
        ? GROUP_TOPIC_SYNC_FIELDS
        : AGENT_TOPIC_SYNC_FIELDS,
    );
    const desktop = await desktopMessageState14(appDataPath, state);
    if (configHash !== state.configHash || desktop.contentHash !== state.contentHash) {
      changedTopics.push(actionIdentity(state, "topic"));
    }
  }
  changedTopics.sort((left, right) => identityKey(left, "topic").localeCompare(identityKey(right, "topic")));
  return { type: "SYNC_TOPIC_DIFF_RESULT", changedTopics };
}

function stableStringify14(value, key = "") {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (key === "temperature" && Number.isInteger(value)) return value.toFixed(1);
    return value.toString();
  }
  if (typeof value === "boolean") return value.toString();
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify14(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
    );
    return `{${keys.map((child) => `${JSON.stringify(child)}:${stableStringify14(value[child], child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function messageHash14(message) {
  const attachmentHashes = (message.attachments || []).map((attachment) =>
    attachment.hash || attachment._fileManagerData?.hash || ""
  ).filter(Boolean).sort();
  const value = {
    id: message.id || "",
    role: message.role || "",
    content: message.content || "",
    timestamp: message.timestamp || 0,
  };
  if (typeof message.name === "string") value.name = message.name;
  if (typeof message.agentId === "string") value.agentId = message.agentId;
  if (attachmentHashes.length) value.attachmentHashes = attachmentHashes;
  return crypto.createHash("sha256").update(stableStringify14(value)).digest("hex");
}

function aggregateHashes14(hashes) {
  if (!hashes.length) return "";
  const hasher = crypto.createHash("sha256");
  for (const hash of [...hashes].sort()) hasher.update(hash);
  return hasher.digest("hex");
}

function validateMessageState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "deletedAt")) {
    return Object.keys(value).length === 1 && Number.isSafeInteger(value.deletedAt) && value.deletedAt >= 0;
  }
  return Object.keys(value).sort().join("\0") === "messageHash\0updatedAt" &&
    HASH_PATTERN.test(value.messageHash) &&
    Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0;
}

async function desktopMessageState14(appDataPath, state) {
  const physical = await readPhysicalTopic(
    appDataPath,
    state.ownerType,
    state.ownerId,
    state.topicId,
  );
  if (!physical) {
    throw Object.assign(
      new Error(`Topic ${state.topicId} was not found for ${state.ownerType}/${state.ownerId}`),
      { code: "TOPIC_NOT_FOUND" },
    );
  }
  const historyPath = topicHistoryPath(appDataPath, state.ownerId, state.topicId);
  const { history } = await readHistoryStrict(historyPath);
  const canonical = canonicalizeHistory(history, state.topicId).frame.messages;
  const messages = new Map();
  for (const message of canonical) {
    messages.set(message.id, {
      hash: messageHash14(message),
      updatedAt: Number.isSafeInteger(message.updatedAt)
        ? message.updatedAt
        : Number.isSafeInteger(message.timestamp)
          ? message.timestamp
          : 0,
      deletedAt: null,
    });
  }
  for (const tombstone of wire14Tombstones("message")) {
    if (
      tombstone.owner_type === state.ownerType &&
      tombstone.owner_id === state.ownerId &&
      tombstone.topic_id === state.topicId
    ) {
      messages.set(tombstone.msg_id, {
        hash: null,
        updatedAt: tombstone.deleted_at,
        deletedAt: tombstone.deleted_at,
      });
    }
  }
  return {
    messages,
    contentHash: aggregateHashes14(
      [...messages.values()].filter((item) => item.deletedAt == null).map((item) => item.hash),
    ),
  };
}

async function handleMessageDiff14(payload, appDataPath) {
  if (!Array.isArray(payload.topics) || payload.topics.length > MAX_MANIFEST_ITEMS) {
    throw contractError("SYNC_MESSAGE_DIFF_REQUEST.topics must be an array of at most 10000 items");
  }
  if (!getDb()) throw contractError("Database not initialized", "SYNC_DB_UNAVAILABLE");
  const results = [];
  const seen = new Set();
  let totalMessages = 0;

  for (const state of payload.topics) {
    const topicId = state?.topicId;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw contractError(`Invalid message diff state for topic ${topicId}`);
    }
    requireExactKeys(state, ["topicId", "ownerType", "ownerId", "contentHash", "messages"], `Message diff ${topicId}`);
    requireId(topicId, "Message diff topicId");
    requireOwner(state.ownerType, state.ownerId);
    requireHash(state.contentHash, "Message diff contentHash", { empty: true });
    if (!state.messages || typeof state.messages !== "object" || Array.isArray(state.messages)) {
      throw contractError(`Invalid message map for topic ${topicId}`);
    }
    const key = identityKey(state, "topic");
    if (seen.has(key)) throw contractError("Duplicate message diff topic identity");
    seen.add(key);
    totalMessages += Object.keys(state.messages).length;
    if (Object.keys(state.messages).length > 10_000 || totalMessages > 100_000) {
      throw contractError("Message diff exceeds its message count budget", "SYNC_BUDGET_EXCEEDED");
    }
    for (const [msgId, messageState] of Object.entries(state.messages)) {
      requireId(msgId, `Message diff ${topicId} messageId`);
      if (!validateMessageState(messageState)) {
        throw contractError(`Invalid message diff entry ${topicId}/${msgId}`);
      }
    }

    const identity = actionIdentity(state, "topic");
    try {
      const desktop = await desktopMessageState14(appDataPath, state);
      const mobileHasTombstones = Object.values(state.messages).some((item) =>
        Object.prototype.hasOwnProperty.call(item, "deletedAt")
      );
      if (desktop.contentHash === state.contentHash && !mobileHasTombstones) {
        results.push({ ...identity, ok: true, pullMessageIds: [], pushTopic: false, deleteMessages: [] });
        continue;
      }
      const pullMessageIds = [];
      const deleteMessages = [];
      let pushTopic = false;
      for (const [msgId, remote] of desktop.messages) {
        const local = state.messages[msgId];
        const localDeleted = local && Object.prototype.hasOwnProperty.call(local, "deletedAt");
        if (remote.deletedAt != null) {
          if (local && !localDeleted) deleteMessages.push({ msgId, deletedAt: remote.deletedAt });
          continue;
        }
        if (localDeleted) {
          pushTopic = true;
          continue;
        }
        if (!local) {
          pullMessageIds.push(msgId);
        } else if (local.messageHash !== remote.hash) {
          if (
            remote.updatedAt > local.updatedAt ||
            (remote.updatedAt === local.updatedAt && remote.hash > local.messageHash)
          ) pullMessageIds.push(msgId);
          else pushTopic = true;
        }
      }
      for (const msgId of Object.keys(state.messages)) {
        if (!desktop.messages.has(msgId)) pushTopic = true;
      }
      pullMessageIds.sort();
      deleteMessages.sort((left, right) => left.msgId.localeCompare(right.msgId));
      results.push({ ...identity, ok: true, pullMessageIds, pushTopic, deleteMessages });
    } catch (error) {
      getLogger().logOperation(
        "messages",
        "wire14_diff",
        `${state.ownerType}/${state.ownerId}/${topicId}`,
        "error",
        error.message,
      );
      results.push({
        ...identity,
        ok: false,
        error: normalizeSyncError(error, {
          code: error.code || "MESSAGE_DIFF_FAILED",
          stage: "messages",
          failedTopicIds: [topicId],
        }),
      });
    }
  }
  return { type: "SYNC_MESSAGE_DIFF_RESULT", results };
}

async function handleDelete14(payload, appDataPath) {
  const { targetType, ownerType, ownerId, topicId, msgId, deletedAt } = payload;
  requireOwner(ownerType, ownerId, { avatar: targetType === "avatar" });
  requireTimestamp(deletedAt, "SYNC_ENTITY_DELETE.deletedAt");
  let result;
  if (targetType === "owner") {
    result = await deleteEntity({ id: ownerId, type: ownerType, deletedAt, appDataPath });
  } else if (targetType === "avatar") {
    result = await deleteEntity({ id: ownerId, type: "avatar", ownerType, deletedAt, appDataPath });
  } else if (targetType === "topic") {
    requireId(topicId, "SYNC_ENTITY_DELETE.topicId");
    result = await deletePhysicalTopic(
      appDataPath,
      ownerType,
      ownerId,
      topicId,
    );
  } else if (targetType === "message") {
    requireId(topicId, "SYNC_ENTITY_DELETE.topicId");
    requireId(msgId, "SYNC_ENTITY_DELETE.msgId");
    const physical = await readPhysicalTopic(
      appDataPath,
      ownerType,
      ownerId,
      topicId,
    );
    if (physical) {
      const historyPath = topicHistoryPath(appDataPath, ownerId, topicId);
      const release = await acquireLock(historyPath);
      try {
        const { history, sourceHash } = await readHistoryStrict(historyPath);
        const filtered = history.filter((message) => message?.id !== msgId);
        if (filtered.length !== history.length) {
          await writeHistoryAtomic(historyPath, filtered, sourceHash);
        }
      } finally {
        release();
      }
    }
    result = { success: true };
  } else {
    throw contractError("Invalid delete targetType", "SYNC_DELETE_INVALID");
  }
  if (!result?.success) {
    throw Object.assign(new Error(result?.error || "Sync deletion failed"), {
      code: "SYNC_DELETE_FAILED",
    });
  }
  recordWire14Tombstone({
    targetType,
    ownerType,
    ownerId,
    topicId,
    msgId,
    deletedAt,
  });
  return { type: "SYNC_ACK", id: msgId || topicId || ownerId };
}

function parseEntityItem(item, { data }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw contractError("Entity item must be an object", "SYNC_REQUEST_INVALID");
  }
  const topic = item.entityType === "topic";
  if (item.entityType !== "owner" && !topic) {
    throw contractError("Entity item requires owner or topic entityType", "SYNC_REQUEST_INVALID");
  }
  requireExactKeys(
    item,
    topic
      ? ["entityType", "ownerType", "ownerId", "topicId", ...(data ? ["data"] : [])]
      : ["entityType", "ownerType", "ownerId", ...(data ? ["data"] : [])],
    "Entity item",
  );
  requireOwner(item.ownerType, item.ownerId);
  if (topic) requireId(item.topicId, "Entity topicId");
  if (data && (!item.data || typeof item.data !== "object" || Array.isArray(item.data))) {
    throw contractError("Entity push data must be an object", "SYNC_REQUEST_INVALID");
  }
  return item;
}

function entityPublic(item) {
  return item.entityType === "topic"
    ? { entityType: "topic", ownerType: item.ownerType, ownerId: item.ownerId, topicId: item.topicId }
    : { entityType: "owner", ownerType: item.ownerType, ownerId: item.ownerId };
}

function resultError(error, fallback) {
  return normalizeSyncError(error, fallback);
}

async function pullEntities14(items, appDataPath) {
  await refreshDesktopConfigIndex(appDataPath);
  const owners = items.filter((item) => item.entityType === "owner");
  const topics = items.filter((item) => item.entityType === "topic");
  const results = [];
  if (owners.length) {
    const response = await downloadDesktopConfigs(owners.map((item) => ({ id: item.ownerId, type: item.ownerType })));
    const found = new Map((response.items || []).map((item) => [`${item.type}\0${item.id}`, item]));
    for (const item of owners) {
      const value = found.get(`${item.ownerType}\0${item.ownerId}`);
      results.push(value
        ? { ...entityPublic(item), ok: true, data: value.data }
        : { ...entityPublic(item), ok: false, error: resultError("entity not found", { code: "SYNC_ENTITY_NOT_FOUND", stage: "owner_metadata" }) });
    }
  }
  if (topics.length) {
    for (const item of topics) {
      try {
        const physical = await readPhysicalTopic(
          appDataPath,
          item.ownerType,
          item.ownerId,
          item.topicId,
        );
        results.push(physical
          ? {
              ...entityPublic(item),
              ok: true,
              data: extractTopicDTO(
                physical.topic,
                item.ownerId,
                item.ownerType,
              ),
            }
          : {
              ...entityPublic(item),
              ok: false,
              error: resultError("entity not found", {
                code: "SYNC_ENTITY_NOT_FOUND",
                stage: "topic_metadata",
                failedTopicIds: [item.topicId],
              }),
            });
      } catch (error) {
        results.push({
          ...entityPublic(item),
          ok: false,
          error: resultError(error, {
            code: "SYNC_ENTITY_READ_FAILED",
            stage: "topic_metadata",
            failedTopicIds: [item.topicId],
          }),
        });
      }
    }
  }
  return results;
}

async function pushEntities14(items, appDataPath) {
  const owners = items.filter((item) => item.entityType === "owner");
  const topics = items.filter((item) => item.entityType === "topic");
  const results = [];
  if (owners.length) {
    const response = await uploadDesktopConfigs(appDataPath, owners.map((item) => ({
      id: item.ownerId,
      type: item.ownerType,
      data: item.data,
      ts: Date.now(),
    })));
    const found = new Map((response.items || []).map((item) => [`${item.type}\0${item.id}`, item]));
    for (const item of owners) {
      const value = found.get(`${item.ownerType}\0${item.ownerId}`);
      results.push(value?.success
        ? { ...entityPublic(item), ok: true }
        : { ...entityPublic(item), ok: false, error: resultError(value?.error || "entity write failed", { code: "SYNC_ENTITY_WRITE_FAILED", stage: "owner_metadata" }) });
    }
  }
  if (topics.length) {
    for (const item of topics) {
      try {
        await writePhysicalTopic(appDataPath, item);
        results.push({ ...entityPublic(item), ok: true });
      } catch (error) {
        getLogger().logOperation(
          "topic_metadata",
          "wire14_push",
          `${item.ownerType}/${item.ownerId}/${item.topicId}`,
          "error",
          error.message,
        );
        results.push({
          ...entityPublic(item),
          ok: false,
          error: resultError(error, {
            code: "SYNC_ENTITY_WRITE_FAILED",
            stage: "topic_metadata",
            failedTopicIds: [item.topicId],
          }),
        });
      }
    }
  }
  return results;
}

async function pullMessages14(topic, appDataPath) {
  const physical = await readPhysicalTopic(
    appDataPath,
    topic.ownerType,
    topic.ownerId,
    topic.topicId,
  );
  if (!physical) {
    throw Object.assign(new Error("topic not found"), {
      code: "TOPIC_NOT_FOUND",
    });
  }
  const historyPath = topicHistoryPath(
    appDataPath,
    topic.ownerId,
    topic.topicId,
  );
  const { history } = await readHistoryStrict(historyPath);
  const canonical = canonicalizeHistory(history, topic.topicId).frame.messages;
  const wanted = new Set(topic.messageIds);
  const selected = wanted.size === 0
    ? canonical
    : canonical.filter((message) => wanted.has(message.id));
  if (
    wanted.size > 0 &&
    (selected.length !== wanted.size ||
      selected.some((message) => !wanted.has(message.id)))
  ) {
    throw Object.assign(new Error("requested message set is incomplete"), {
      code: "SYNC_MESSAGE_READ_FAILED",
    });
  }
  const messages = selected.map((message) => {
    const { contentHash, ...value } = message;
    value.updatedAt = Number.isSafeInteger(value.updatedAt)
      ? value.updatedAt
      : Number.isSafeInteger(value.timestamp)
        ? value.timestamp
        : 0;
    return value;
  });
  return {
    kind: "topic",
    topicId: topic.topicId,
    ownerType: topic.ownerType,
    ownerId: topic.ownerId,
    ok: true,
    messages,
  };
}

async function pushMessages14(frame, appDataPath) {
  const physical = await readPhysicalTopic(
    appDataPath,
    frame.ownerType,
    frame.ownerId,
    frame.topicId,
  );
  if (!physical) {
    throw Object.assign(new Error("topic not found"), {
      code: "TOPIC_NOT_FOUND",
    });
  }
  const historyPath = topicHistoryPath(
    appDataPath,
    frame.ownerId,
    frame.topicId,
  );
  const release = await acquireLock(historyPath);
  try {
    await fs.mkdir(path.dirname(historyPath), { recursive: true });
    const { history, sourceHash } = await readHistoryStrict(historyPath);
    const persistedTombstones = new Set(
      wire14Tombstones("message")
        .filter((item) =>
          item.owner_type === frame.ownerType &&
          item.owner_id === frame.ownerId &&
          item.topic_id === frame.topicId
        )
        .map((item) => item.msg_id),
    );
    const staleLive = frame.messages.find((message) =>
      persistedTombstones.has(message?.id)
    );
    if (staleLive) {
      throw Object.assign(
        new Error(`Mobile push contains tombstoned message ${frame.topicId}/${staleLive.id}`),
        { code: "SYNC_SNAPSHOT_STALE" },
      );
    }
    const projected = await projectMobileTopic({
      topicId: frame.topicId,
      ownerType: frame.ownerType,
      ownerId: frame.ownerId,
      messages: frame.messages,
      db: getDb(),
      appDataPath,
    });
    const messageMap = new Map(
      history
        .filter((message) => !persistedTombstones.has(message?.id))
        .map((message) => [message.id, message]),
    );
    for (const message of projected.messages) messageMap.set(message.id, message);
    for (const tombstone of frame.deletedMessages) {
      messageMap.delete(tombstone.msgId);
      recordWire14Tombstone({
        targetType: "message",
        ownerType: frame.ownerType,
        ownerId: frame.ownerId,
        topicId: frame.topicId,
        msgId: tombstone.msgId,
        deletedAt: tombstone.deletedAt,
      });
    }
    const finalHistory = [...messageMap.values()].sort(
      (left, right) => (left.timestamp || 0) - (right.timestamp || 0),
    );
    await writeHistoryAtomic(historyPath, finalHistory, sourceHash);
    return {
      kind: "topic",
      topicId: frame.topicId,
      ownerType: frame.ownerType,
      ownerId: frame.ownerId,
      ok: true,
      neededAttachmentHashes: projected.neededAttachmentHashes,
    };
  } finally {
    release();
  }
}

async function* validatedMessagePush(input) {
  let topicCount = 0;
  let messageCount = 0;
  const seen = new Set();
  for await (const line of readNdjsonLines(input)) {
    const frame = parseJsonWithoutDuplicateKeys(decodeNdjsonLine(line));
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw contractError("Message push frame must be an object", "SYNC_REQUEST_INVALID");
    }
    requireExactKeys(frame, ["kind", "topicId", "ownerType", "ownerId", "messages", "deletedMessages"], "Message push frame");
    if (frame.kind !== "topic") throw contractError("Message push kind must be topic", "SYNC_REQUEST_INVALID");
    requireId(frame.topicId, "Message push topicId");
    requireOwner(frame.ownerType, frame.ownerId);
    if (!Array.isArray(frame.messages) || !Array.isArray(frame.deletedMessages)) {
      throw contractError("Message push requires messages and deletedMessages arrays", "SYNC_REQUEST_INVALID");
    }
    const key = identityKey(frame, "topic");
    if (seen.has(key)) throw contractError("Message push contains a duplicate topic identity", "SYNC_REQUEST_INVALID");
    seen.add(key);
    topicCount += 1;
    messageCount += frame.messages.length;
    if (topicCount > 10_000 || frame.messages.length > 10_000 || messageCount > 100_000) {
      throw contractError("Message push exceeds topic or message budget", "SYNC_BUDGET_EXCEEDED");
    }
    const deleted = new Set();
    for (const tombstone of frame.deletedMessages) {
      if (!tombstone || typeof tombstone !== "object" || Array.isArray(tombstone)) {
        throw contractError("Invalid message tombstone", "SYNC_REQUEST_INVALID");
      }
      requireExactKeys(tombstone, ["msgId", "deletedAt"], "Message tombstone");
      requireId(tombstone.msgId, "Message tombstone msgId");
      requireTimestamp(tombstone.deletedAt, "Message tombstone deletedAt");
      if (deleted.has(tombstone.msgId)) throw contractError("Duplicate message tombstone", "SYNC_REQUEST_INVALID");
      deleted.add(tombstone.msgId);
    }
    yield frame;
  }
}

function sendRouteError(res, status, error, fallback) {
  return res.status(status).json(createHttpErrorBody(error, fallback));
}

function registerWire14Routes(router, { appDataPath }) {
  router.post("/entities/pull", express.json({ limit: "10mb" }), async (req, res) => {
    try {
      requireExactKeys(req.body || {}, ["items"], "Entity pull request");
      if (!Array.isArray(req.body.items) || req.body.items.length > 1_000) {
        throw contractError("items must be an array of at most 1000 entities", "SYNC_REQUEST_INVALID");
      }
      const items = req.body.items.map((item) => parseEntityItem(item, { data: false }));
      const seen = new Set();
      for (const item of items) {
        const key = item.entityType === "topic" ? identityKey(item, "topic") : identityKey(item, "owner");
        if (seen.has(key)) throw contractError("Entity batch contains a duplicate identity", "SYNC_REQUEST_INVALID");
        seen.add(key);
      }
      res.json({ results: await pullEntities14(items, appDataPath) });
    } catch (error) {
      sendRouteError(res, error.code === "SYNC_REQUEST_INVALID" || error.code === "SYNC_PROTOCOL_INVALID" ? 400 : 500, error, {
        code: error.code || "SYNC_ENTITY_READ_FAILED",
        stage: "owner_metadata",
      });
    }
  });

  router.post("/entities/push", express.json({ limit: "10mb" }), async (req, res) => {
    try {
      requireExactKeys(req.body || {}, ["items"], "Entity push request");
      if (!Array.isArray(req.body.items) || req.body.items.length > 10_000) {
        throw contractError("items must be an array of at most 10000 entities", "SYNC_REQUEST_INVALID");
      }
      const items = req.body.items.map((item) => parseEntityItem(item, { data: true }));
      const seen = new Set();
      for (const item of items) {
        const key = item.entityType === "topic" ? identityKey(item, "topic") : identityKey(item, "owner");
        if (seen.has(key)) throw contractError("Entity batch contains a duplicate identity", "SYNC_REQUEST_INVALID");
        seen.add(key);
      }
      res.json({ results: await pushEntities14(items, appDataPath) });
    } catch (error) {
      sendRouteError(res, error.code === "SYNC_REQUEST_INVALID" || error.code === "SYNC_PROTOCOL_INVALID" ? 400 : 500, error, {
        code: error.code || "SYNC_ENTITY_WRITE_FAILED",
        stage: "owner_metadata",
      });
    }
  });

  router.post("/messages/pull", express.json({ limit: "5mb" }), async (req, res) => {
    try {
      requireExactKeys(req.body || {}, ["topics"], "Message pull request");
      const topics = req.body.topics;
      if (!Array.isArray(topics) || topics.length === 0) {
        throw contractError("topics must be a non-empty array", "SYNC_REQUEST_INVALID");
      }
      for (const topic of topics) {
        requireExactKeys(topic, ["topicId", "ownerType", "ownerId", "messageIds"], "Message pull topic");
        requireId(topic.topicId, "Message pull topicId");
        requireOwner(topic.ownerType, topic.ownerId);
        if (!Array.isArray(topic.messageIds)) throw contractError("messageIds must be an array", "SYNC_REQUEST_INVALID");
      }
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      for (const topic of topics) {
        try {
          res.write(`${JSON.stringify(await pullMessages14(topic, appDataPath))}\n`);
        } catch (error) {
          res.write(`${JSON.stringify({
            kind: "topic",
            topicId: topic.topicId,
            ownerType: topic.ownerType,
            ownerId: topic.ownerId,
            ok: false,
            error: resultError(error, {
              code: error.code || "SYNC_MESSAGE_READ_FAILED",
              stage: "messages",
              failedTopicIds: [topic.topicId],
            }),
          })}\n`);
        }
      }
      res.end();
    } catch (error) {
      sendRouteError(res, error.code === "SYNC_REQUEST_INVALID" || error.code === "SYNC_PROTOCOL_INVALID" ? 400 : 500, error, {
        code: error.code || "SYNC_MESSAGE_READ_FAILED",
        stage: "messages",
      });
    }
  });

  router.post("/messages/push", async (req, res) => {
    try {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      for await (const frame of validatedMessagePush(req)) {
        try {
          res.write(`${JSON.stringify(await pushMessages14(frame, appDataPath))}\n`);
        } catch (error) {
          res.write(`${JSON.stringify({
            kind: "topic",
            topicId: frame.topicId,
            ownerType: frame.ownerType,
            ownerId: frame.ownerId,
            ok: false,
            error: resultError(error, {
              code: error.code || "SYNC_MESSAGE_WRITE_FAILED",
              stage: "messages",
              failedTopicIds: [frame.topicId],
            }),
          })}\n`);
        }
      }
      res.end();
    } catch (error) {
      if (res.headersSent) {
        res.write(`${JSON.stringify({
          kind: "error",
          error: resultError(error, {
            code: error.code || "SYNC_MESSAGE_WRITE_FAILED",
            stage: "messages",
          }),
        })}\n`);
        return res.end();
      }
      sendRouteError(res, error.code === "SYNC_REQUEST_INVALID" || error.code === "SYNC_PROTOCOL_INVALID" ? 400 : 500, error, {
        code: error.code || "SYNC_MESSAGE_WRITE_FAILED",
        stage: "messages",
      });
    }
  });

  router.get("/avatars/pull", async (req, res) => {
    try {
      requireExactKeys(req.query || {}, ["ownerType", "ownerId"], "Avatar pull query");
      requireOwner(req.query.ownerType, req.query.ownerId, { avatar: true });
      const result = await downloadAvatar(req.query.ownerId, req.query.ownerType);
      if (!result) return sendRouteError(res, 404, "Avatar not found", { code: "SYNC_AVATAR_NOT_FOUND", stage: "owner_metadata" });
      res.sendFile(result.filePath);
    } catch (error) {
      sendRouteError(res, error.code === "SYNC_PROTOCOL_INVALID" ? 400 : 500, error, { code: "SYNC_AVATAR_READ_FAILED", stage: "owner_metadata" });
    }
  });

  router.post("/avatars/push", express.raw({ type: "*/*", limit: "20mb" }), async (req, res) => {
    try {
      requireExactKeys(req.query || {}, ["ownerType", "ownerId"], "Avatar push query");
      requireOwner(req.query.ownerType, req.query.ownerId, { avatar: true });
      await uploadAvatar({ id: req.query.ownerId, type: req.query.ownerType, data: req.body, appDataPath });
      res.json({ ownerType: req.query.ownerType, ownerId: req.query.ownerId, ok: true });
    } catch (error) {
      sendRouteError(res, error.code === "SYNC_PROTOCOL_INVALID" ? 400 : 500, error, { code: "SYNC_AVATAR_WRITE_FAILED", stage: "owner_metadata" });
    }
  });
}

module.exports = {
  aggregateHashes14,
  handleDelete14,
  handleManifest14,
  handleMessageDiff14,
  handleTopicDiff14,
  messageHash14,
  registerWire14Routes,
};
