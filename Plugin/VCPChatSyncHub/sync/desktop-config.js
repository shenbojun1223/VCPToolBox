const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");

const {
  getDesktopConfigIndex,
  getDesktopConfigs,
  upsertDesktopConfigIndex,
  upsertEntityIndex,
} = require("../core/db");
const { stableStringify, computeDtoHash } = require("../core/hash");
const { acquireLock } = require("../utils/lock");
const { sanitizeId } = require("./entity");
const {
  extractAgentDTO,
  extractGroupDTO,
  AGENT_SYNC_FIELDS,
  GROUP_SYNC_FIELDS,
} = require("../dto");

const LOCAL_ONLY_KEY = /(?:path|dir|directory|executable)$/i;
const SECRET_KEY = /(?:api[_-]?key|token|secret|password|credential)/i;

function sanitizeDesktopConfigValue(value, key = "") {
  if (key === "topics" || key === "avatarUrl") return undefined;
  if (SECRET_KEY.test(key) || LOCAL_ONLY_KEY.test(key)) return undefined;
  if (typeof value === "string" && /^(?:file:\/\/|[a-z]:[\\/])/i.test(value)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeDesktopConfigValue(item))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const sanitized = sanitizeDesktopConfigValue(childValue, childKey);
      if (sanitized !== undefined) result[childKey] = sanitized;
    }
    return result;
  }
  return value;
}

function sanitizeDesktopConfig(config) {
  return sanitizeDesktopConfigValue(config || {}) || {};
}

function computeDesktopConfigHash(config) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(sanitizeDesktopConfig(config)))
    .digest("hex");
}

function resolveConfigPath(appDataPath, type, id) {
  const folder = type === "group" ? "AgentGroups" : "Agents";
  return path.join(appDataPath, folder, id, "config.json");
}

async function refreshDesktopConfigIndex(appDataPath) {
  for (const type of ["agent", "group"]) {
    const basePath = path.join(
      appDataPath,
      type === "group" ? "AgentGroups" : "Agents",
    );
    let entries = [];
    try {
      entries = await fs.readdir(basePath, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = sanitizeId(entry.name);
      if (!id || id !== entry.name) continue;
      const filePath = path.join(basePath, entry.name, "config.json");
      try {
        const [raw, stats] = await Promise.all([
          fs.readFile(filePath, "utf8"),
          fs.stat(filePath),
        ]);
        const config = JSON.parse(raw);
        const hash = computeDesktopConfigHash(config);
        const current = getDesktopConfigIndex(id, type);
        const updatedAt = current && current.hash === hash
          ? current.updated_at
          : Math.trunc(stats.mtimeMs || Date.now());
        upsertDesktopConfigIndex(id, type, filePath, hash, updatedAt);
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.warn(`[VCPChatSyncHub] Failed to index ${type} ${id}: ${error.message}`);
        }
      }
    }
  }
}

async function compareDesktopConfigManifest(appDataPath, remoteItems) {
  await refreshDesktopConfigIndex(appDataPath);
  const remote = Array.isArray(remoteItems) ? remoteItems : [];
  const localRows = getDesktopConfigs();
  const localMap = new Map(localRows.map((row) => [`${row.type}:${row.id}`, row]));
  const remoteMap = new Map();
  const results = [];

  for (const item of remote) {
    const id = sanitizeId(item?.id);
    const type = item?.type === "group" ? "group" : item?.type === "agent" ? "agent" : "";
    if (!id || !type) continue;
    const key = `${type}:${id}`;
    remoteMap.set(key, item);
    const local = localMap.get(key);
    if (!local) {
      results.push({ id, type, action: "PUSH" });
    } else if (local.deleted_at != null) {
      results.push({
        id,
        type,
        action: "DELETE",
        deletedAt: local.deleted_at,
      });
    } else if (local.hash !== item.hash) {
      const remoteTs = Number(item.ts) || 0;
      results.push({
        id,
        type,
        action: remoteTs > local.updated_at ? "PUSH" : "PULL",
      });
    }
  }

  for (const row of localRows) {
    if (row.deleted_at != null) continue;
    const key = `${row.type}:${row.id}`;
    if (!remoteMap.has(key)) {
      results.push({ id: row.id, type: row.type, action: "PULL" });
    }
  }

  return { actions: results };
}

async function downloadDesktopConfigs(items) {
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = sanitizeId(item?.id);
    const type = item?.type === "group" ? "group" : item?.type === "agent" ? "agent" : "";
    if (!id || !type) continue;
    const row = getDesktopConfigIndex(id, type);
    if (!row || row.deleted_at) continue;
    try {
      const config = JSON.parse(await fs.readFile(row.file_path, "utf8"));
      results.push({
        id,
        type,
        data: sanitizeDesktopConfig(config),
        hash: row.hash,
        ts: row.updated_at,
      });
    } catch (error) {
      results.push({ id, type, error: error.message });
    }
  }
  return { items: results };
}

async function uploadDesktopConfigs(appDataPath, items) {
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = sanitizeId(item?.id);
    const type = item?.type === "group" ? "group" : item?.type === "agent" ? "agent" : "";
    if (!id || !type || !item.data || typeof item.data !== "object") {
      results.push({ id: id || item?.id, type, success: false, error: "Invalid item" });
      continue;
    }
    const current = getDesktopConfigIndex(id, type);
    if (current?.deleted_at != null) {
      results.push({
        id,
        type,
        success: false,
        error: "Desktop config is tombstoned",
      });
      continue;
    }

    const filePath = resolveConfigPath(appDataPath, type, id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const release = await acquireLock(filePath);
    try {
      let existing = {};
      try {
        existing = JSON.parse(await fs.readFile(filePath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const topics = Array.isArray(existing.topics) ? existing.topics : [];
      const incoming = sanitizeDesktopConfig(item.data);
      const merged = { ...existing, ...incoming, topics };
      delete merged.avatarUrl;
      if (type === "group") merged.id = id;

      const tempPath = `${filePath}.tmp_${process.pid}_${Date.now()}`;
      await fs.writeFile(tempPath, JSON.stringify(merged, null, 2), "utf8");
      await fs.rename(tempPath, filePath);

      const hash = computeDesktopConfigHash(merged);
      const updatedAt = Number(item.ts) || Date.now();
      upsertDesktopConfigIndex(id, type, filePath, hash, updatedAt);

      const dto = type === "agent" ? extractAgentDTO(merged) : extractGroupDTO(merged);
      upsertEntityIndex(
        id,
        type,
        filePath,
        computeDtoHash(dto, type === "agent" ? AGENT_SYNC_FIELDS : GROUP_SYNC_FIELDS),
        updatedAt,
      );
      results.push({ id, type, success: true, hash, ts: updatedAt });
    } catch (error) {
      results.push({ id, type, success: false, error: error.message });
    } finally {
      release();
    }
  }
  return { items: results };
}

module.exports = {
  sanitizeDesktopConfig,
  computeDesktopConfigHash,
  compareDesktopConfigManifest,
  downloadDesktopConfigs,
  uploadDesktopConfigs,
};
