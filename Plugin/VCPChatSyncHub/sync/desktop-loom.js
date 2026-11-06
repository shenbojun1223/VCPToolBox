"use strict";

const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");

const {
  getDesktopLoomAppIndex,
  getDesktopLoomApps,
  upsertDesktopLoomAppIndex,
  softDeleteDesktopLoomAppIndex,
} = require("../core/db");
const { stableStringify, computeBinaryHash } = require("../core/hash");
const { acquireLock } = require("../utils/lock");

const MANIFEST_FILE = "loom.json";
const INJECT_CSS_FILE = "inject.css";
const INJECT_JS_FILE = "inject.js";
const SIDE_BROWSER_APP_ID = "vcpchat-browser";
const SAFE_LOOM_APP_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MAX_LOOM_INJECT_BYTES = 2 * 1024 * 1024;
const MAX_LOOM_MANIFEST_BYTES = 256 * 1024;
const MAX_LOOM_ICON_FILE_BYTES = 5 * 1024 * 1024;
const LOOM_SYNC_PENDING_FILE = ".sync-pending";

function normalizeLoomAppId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SAFE_LOOM_APP_ID.test(id) || id === SIDE_BROWSER_APP_ID) return "";
  return id;
}

function isExternalOrInlineIcon(icon) {
  return /^(?:data:|https?:|file:)/i.test(String(icon || "").trim());
}

function isReservedLoomFileName(fileName) {
  return [
    MANIFEST_FILE,
    INJECT_CSS_FILE,
    INJECT_JS_FILE,
    LOOM_SYNC_PENDING_FILE,
  ].includes(fileName);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeLoomManifestForSync(manifest, id) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Loom manifest must be a JSON object");
  }
  const normalized = JSON.parse(JSON.stringify(manifest));
  delete normalized.running;
  normalized.id = id;
  if (normalized.injection && typeof normalized.injection === "object" && !Array.isArray(normalized.injection)) {
    normalized.injection = {
      ...normalized.injection,
      css: INJECT_CSS_FILE,
      js: INJECT_JS_FILE,
    };
  } else {
    normalized.injection = {
      css: INJECT_CSS_FILE,
      js: INJECT_JS_FILE,
    };
  }
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOOM_MANIFEST_BYTES) {
    throw new Error("Loom manifest exceeds byte budget");
  }
  return normalized;
}

function normalizeLoomIconFileMeta(iconFile) {
  if (!iconFile || typeof iconFile !== "object" || Array.isArray(iconFile)) return null;
  const fileName = path.basename(String(iconFile.fileName || "").trim());
  const sha256 = String(iconFile.sha256 || "").trim().toLowerCase();
  if (!fileName || fileName !== String(iconFile.fileName || "").trim()) return null;
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
  return { fileName, sha256 };
}

function computeDesktopLoomAppHash({ manifest, css = "", js = "", iconFile = null }, id) {
  const normalizedManifest = sanitizeLoomManifestForSync(manifest, id);
  const payload = {
    manifest: normalizedManifest,
    css: String(css ?? ""),
    js: String(js ?? ""),
    iconFile: normalizeLoomIconFileMeta(iconFile),
  };
  return crypto
    .createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
}

function resolveLoomAppsRoot(appDataPath) {
  return path.join(appDataPath, "LoomApps");
}

function resolveLoomAppDir(appDataPath, id) {
  return path.join(resolveLoomAppsRoot(appDataPath), id);
}

async function readLocalIconFile(appDir, manifest) {
  const icon = typeof manifest?.icon === "string" ? manifest.icon.trim() : "";
  if (!icon || isExternalOrInlineIcon(icon)) return null;
  const fileName = path.basename(icon);
  if (!fileName || fileName !== icon || isReservedLoomFileName(fileName)) {
    return null;
  }
  const filePath = path.resolve(appDir, fileName);
  const relative = path.relative(appDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const [buffer, stats] = await Promise.all([
      fs.readFile(filePath),
      fs.stat(filePath),
    ]);
    if (!stats.isFile() || stats.size > MAX_LOOM_ICON_FILE_BYTES) return null;
    return {
      fileName,
      content: buffer.toString("base64"),
      sha256: computeBinaryHash(buffer),
      mtimeMs: Math.trunc(stats.mtimeMs || 0),
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readTextOptional(filePath) {
  try {
    const [content, stats] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      fs.stat(filePath),
    ]);
    if (Buffer.byteLength(content, "utf8") > MAX_LOOM_INJECT_BYTES) {
      throw new Error(`${path.basename(filePath)} exceeds ${Math.round(MAX_LOOM_INJECT_BYTES / 1024)} KB limit`);
    }
    return { content, mtimeMs: Math.trunc(stats.mtimeMs || 0) };
  } catch (error) {
    if (error.code === "ENOENT") return { content: "", mtimeMs: 0 };
    throw error;
  }
}

async function readLoomAppBundle(appDir, id) {
  const manifestPath = path.join(appDir, MANIFEST_FILE);
  const [rawManifest, manifestStats, cssResult, jsResult] = await Promise.all([
    fs.readFile(manifestPath, "utf8"),
    fs.stat(manifestPath),
    readTextOptional(path.join(appDir, INJECT_CSS_FILE)),
    readTextOptional(path.join(appDir, INJECT_JS_FILE)),
  ]);
  const parsedManifest = JSON.parse(rawManifest);
  const manifest = sanitizeLoomManifestForSync(parsedManifest, id);
  const iconResult = await readLocalIconFile(appDir, manifest);
  const iconFile = iconResult
    ? {
        fileName: iconResult.fileName,
        content: iconResult.content,
        sha256: iconResult.sha256,
      }
    : null;
  const hash = computeDesktopLoomAppHash(
    { manifest, css: cssResult.content, js: jsResult.content, iconFile },
    id,
  );
  const maxMtimeMs = Math.max(
    Math.trunc(manifestStats.mtimeMs || 0),
    cssResult.mtimeMs,
    jsResult.mtimeMs,
    iconResult?.mtimeMs || 0,
  );
  return {
    id,
    manifest,
    css: cssResult.content,
    js: jsResult.content,
    iconFile,
    hash,
    mtimeMs: maxMtimeMs || Date.now(),
  };
}

async function refreshDesktopLoomAppIndex(appDataPath) {
  const basePath = resolveLoomAppsRoot(appDataPath);
  let entries = [];
  try {
    entries = await fs.readdir(basePath, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // "Could not index it" must never be conflated with "it is gone". A tombstone written
  // here is broadcast as DELETE to every PC, so a transient read failure (EBUSY from a
  // virus scanner, a locked file, an oversized inject file) previously escalated a local
  // hiccup into fleet-wide data loss. Only a directory that is genuinely absent -- or
  // whose manifest is really missing -- may reach the purge loop below.
  const presentOnDisk = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = normalizeLoomAppId(entry.name);
    if (!id || id !== entry.name) continue;
    const appDir = path.join(basePath, id);
    presentOnDisk.add(id);

    if (await pathExists(path.join(appDir, LOOM_SYNC_PENDING_FILE))) {
      // An upload died mid-bundle, or one is in flight right now (this function does not
      // take the upload lock). Re-indexing would publish a hash matching neither peer
      // under a brand new mtime, and every client would then PULL the torn bundle. Keep
      // the last indexed revision instead: the client owning the newer version is told
      // to PUSH again and repairs the hub.
      console.warn(`[VCPChatSyncHub] LoomApp ${id} has an unfinished bundle write; keeping the last indexed revision until it is re-uploaded.`);
      continue;
    }

    try {
      const bundle = await readLoomAppBundle(appDir, id);
      const current = getDesktopLoomAppIndex(id);
      if (current && current.deleted_at != null && bundle.mtimeMs <= current.deleted_at) {
        await fs.rm(appDir, { recursive: true, force: true });
        presentOnDisk.delete(id);
        continue;
      }
      const updatedAt = current && current.deleted_at == null && current.hash === bundle.hash
        ? current.updated_at
        : bundle.mtimeMs;
      upsertDesktopLoomAppIndex(id, appDir, bundle.hash, updatedAt);
    } catch (error) {
      if (error.code === "ENOENT") {
        // No manifest and no pending marker: this is not a LoomApp any more, so the
        // purge loop may tombstone it (unchanged from the original behaviour).
        presentOnDisk.delete(id);
      } else {
        console.warn(`[VCPChatSyncHub] Failed to index LoomApp ${id}: ${error.message}`);
      }
    }
  }

  for (const row of getDesktopLoomApps()) {
    if (row.deleted_at != null) continue;
    if (!presentOnDisk.has(row.id)) {
      softDeleteDesktopLoomAppIndex(row.id, Date.now(), row.dir_path);
    }
  }
}

async function applyDesktopLoomDeletions(appDataPath, deletions) {
  const processedDeletions = [];
  for (const raw of Array.isArray(deletions) ? deletions : []) {
    const id = normalizeLoomAppId(raw?.id);
    const deletedAt = Number(raw?.deletedAt);
    if (!id || !Number.isSafeInteger(deletedAt) || deletedAt < 0) continue;

    const appDir = resolveLoomAppDir(appDataPath, id);
    const release = await acquireLock(path.join(appDir, MANIFEST_FILE));
    try {
      const current = getDesktopLoomAppIndex(id);
      if (current && current.deleted_at == null && current.updated_at > deletedAt) {
        // A newer live version exists on the hub; keep it and acknowledge the tombstone so the client pulls the newer app.
        processedDeletions.push(id);
        continue;
      }
      await fs.rm(appDir, { recursive: true, force: true });
      softDeleteDesktopLoomAppIndex(id, deletedAt, appDir);
      processedDeletions.push(id);
    } finally {
      release();
    }
  }
  return processedDeletions;
}

async function compareDesktopLoomManifest(appDataPath, payload = {}) {
  const remoteItems = Array.isArray(payload) ? payload : payload?.items;
  const deletions = Array.isArray(payload) ? [] : payload?.deletions;

  await refreshDesktopLoomAppIndex(appDataPath);
  const processedDeletions = await applyDesktopLoomDeletions(appDataPath, deletions);

  const remote = Array.isArray(remoteItems) ? remoteItems : [];
  const localRows = getDesktopLoomApps();
  const localMap = new Map(localRows.map((row) => [row.id, row]));
  const remoteMap = new Map();
  const results = [];

  for (const item of remote) {
    const id = normalizeLoomAppId(item?.id);
    const hash = typeof item?.hash === "string" ? item.hash.trim().toLowerCase() : "";
    const remoteTs = Number(item?.ts) || 0;
    if (!id || !/^[a-f0-9]{64}$/.test(hash)) continue;
    remoteMap.set(id, { id, hash, ts: remoteTs });
    const local = localMap.get(id);
    if (!local) {
      results.push({ id, action: "PUSH" });
    } else if (local.deleted_at != null) {
      if (remoteTs > local.deleted_at) {
        results.push({ id, action: "PUSH" });
      } else {
        results.push({ id, action: "DELETE", deletedAt: local.deleted_at });
      }
    } else if (local.hash !== hash) {
      results.push({
        id,
        action: remoteTs > local.updated_at ? "PUSH" : "PULL",
      });
    }
  }

  for (const row of localRows) {
    if (row.deleted_at != null) continue;
    if (!remoteMap.has(row.id)) {
      results.push({ id: row.id, action: "PULL" });
    }
  }

  return {
    actions: results,
    processedDeletions,
  };
}

async function downloadDesktopLoomApps(appDataPath, items) {
  await refreshDesktopLoomAppIndex(appDataPath);
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = normalizeLoomAppId(item?.id ?? item);
    if (!id) continue;
    const row = getDesktopLoomAppIndex(id);
    if (!row || row.deleted_at != null) {
      results.push({ id, ok: false, error: "LoomApp not found" });
      continue;
    }
    const appDir = row.dir_path || resolveLoomAppDir(appDataPath, id);
    if (await pathExists(path.join(appDir, LOOM_SYNC_PENDING_FILE))) {
      // Refuse rather than hand out a torn bundle. The client treats ok=false as a hard
      // sync failure and retries, by which time the owner's PUSH has repaired the hub.
      results.push({
        id,
        ok: false,
        error: "LoomApp bundle is mid-write on the hub; retry after the owner re-uploads it",
      });
      continue;
    }
    try {
      const bundle = await readLoomAppBundle(appDir, id);
      results.push({
        id,
        ok: true,
        manifest: bundle.manifest,
        css: bundle.css,
        js: bundle.js,
        iconFile: bundle.iconFile,
        hash: bundle.hash,
        ts: row.updated_at,
      });
    } catch (error) {
      results.push({ id, ok: false, error: error.message });
    }
  }
  return { items: results };
}

async function writeAtomicFile(filePath, content, encoding = "utf8") {
  const tempPath = `${filePath}.tmp_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    if (Buffer.isBuffer(content)) {
      await fs.writeFile(tempPath, content);
    } else {
      await fs.writeFile(tempPath, String(content ?? ""), encoding);
    }
    await fs.rename(tempPath, filePath);
  } finally {
    // A failed rename would otherwise leave .tmp_* litter inside the app directory,
    // where readLoomAppBundle and the icon resolver have to step around it.
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function applySyncedMtime(filePaths, ts) {
  const mtimeDate = new Date(Number(ts) || Date.now());
  const failures = [];
  await Promise.all(
    filePaths.map((filePath) =>
      fs.utimes(filePath, mtimeDate, mtimeDate).catch((error) => {
        failures.push(`${path.basename(filePath)}: ${error.message}`);
      })
    ),
  );
  return failures;
}

async function uploadDesktopLoomApps(appDataPath, items) {
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = normalizeLoomAppId(item?.id || item?.manifest?.id);
    if (!id || !item?.manifest || typeof item.manifest !== "object" || Array.isArray(item.manifest)) {
      results.push({ id: id || item?.id, ok: false, error: "Invalid LoomApp item" });
      continue;
    }

    const updatedAt = Number.isSafeInteger(Number(item.ts)) && Number(item.ts) > 0
      ? Number(item.ts)
      : Date.now();
    const current = getDesktopLoomAppIndex(id);
    if (current?.deleted_at != null && updatedAt <= current.deleted_at) {
      results.push({
        id,
        ok: false,
        error: "LoomApp is tombstoned",
      });
      continue;
    }

    // Validate the entire payload before touching the filesystem, so a malformed item
    // cannot create a directory or strand a pending marker that quarantines an
    // otherwise healthy bundle.
    let manifest;
    let css;
    let js;
    let normalizedIconFile = null;
    let iconBuffer = null;
    try {
      manifest = sanitizeLoomManifestForSync(item.manifest, id);
      css = String(item.css ?? "");
      js = String(item.js ?? "");
      if (Buffer.byteLength(css, "utf8") > MAX_LOOM_INJECT_BYTES) {
        throw new Error("inject.css exceeds 2 MB limit");
      }
      if (Buffer.byteLength(js, "utf8") > MAX_LOOM_INJECT_BYTES) {
        throw new Error("inject.js exceeds 2 MB limit");
      }
      if (item.iconFile && typeof item.iconFile === "object" && !Array.isArray(item.iconFile)) {
        const iconName = path.basename(String(item.iconFile.fileName || "").trim());
        if (!iconName || iconName !== String(item.iconFile.fileName || "").trim() || isReservedLoomFileName(iconName)) {
          throw new Error("Invalid LoomApp icon file name");
        }
        iconBuffer = Buffer.from(String(item.iconFile.content || ""), "base64");
        if (iconBuffer.length > MAX_LOOM_ICON_FILE_BYTES) {
          throw new Error("LoomApp icon exceeds 5 MB limit");
        }
        normalizedIconFile = {
          fileName: iconName,
          sha256: computeBinaryHash(iconBuffer),
        };
        manifest.icon = iconName;
      }
    } catch (error) {
      results.push({ id, ok: false, success: false, error: error.message });
      continue;
    }

    const appDir = resolveLoomAppDir(appDataPath, id);
    const manifestPath = path.join(appDir, MANIFEST_FILE);
    const pendingPath = path.join(appDir, LOOM_SYNC_PENDING_FILE);
    await fs.mkdir(appDir, { recursive: true });
    const release = await acquireLock(manifestPath);
    try {
      const cssPath = path.join(appDir, INJECT_CSS_FILE);
      const jsPath = path.join(appDir, INJECT_JS_FILE);
      const touchedPaths = [manifestPath, cssPath, jsPath];

      // The bundle hash spans loom.json + inject.css + inject.js + icon, so per-file
      // atomicity is not enough. If a crash lands between two files, upsert never runs,
      // the DB keeps the old hash, and the next refreshDesktopLoomAppIndex recomputes a
      // hash matching neither peer -- under a brand new mtime. Every client then sees
      // remoteTs <= local.updated_at and PULLs the torn bundle, making the hub a poison
      // source for the whole fleet. The marker is cleared only after the index row lands;
      // a failed write deliberately leaves it behind so the bundle stays quarantined
      // until the owner re-uploads. It also shields concurrent readers, because
      // refreshDesktopLoomAppIndex does not take this lock.
      await fs.writeFile(pendingPath, `${JSON.stringify({ id, ts: Date.now() })}\n`, "utf8");

      await writeAtomicFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await writeAtomicFile(cssPath, css, "utf8");
      await writeAtomicFile(jsPath, js, "utf8");

      if (normalizedIconFile && iconBuffer) {
        const iconPath = path.join(appDir, normalizedIconFile.fileName);
        await writeAtomicFile(iconPath, iconBuffer);
        touchedPaths.push(iconPath);
      }

      const mtimeFailures = await applySyncedMtime(touchedPaths, updatedAt);
      if (mtimeFailures.length) {
        // mtime feeds refreshDesktopLoomAppIndex's updated_at, the only clock behind
        // every PUSH/PULL verdict; swallowing this makes later conflicts unexplainable.
        console.warn(`[VCPChatSyncHub] Could not stamp synced mtime on LoomApp ${id} (${mtimeFailures.join("; ")}).`);
      }

      const hash = computeDesktopLoomAppHash(
        { manifest, css, js, iconFile: normalizedIconFile },
        id,
      );
      upsertDesktopLoomAppIndex(id, appDir, hash, updatedAt);
      await fs.rm(pendingPath, { force: true });
      results.push({ id, ok: true, success: true, hash, ts: updatedAt });
    } catch (error) {
      results.push({ id, ok: false, success: false, error: error.message });
    } finally {
      release();
    }
  }
  return { items: results };
}

module.exports = {
  SAFE_LOOM_APP_ID,
  SIDE_BROWSER_APP_ID,
  normalizeLoomAppId,
  sanitizeLoomManifestForSync,
  computeDesktopLoomAppHash,
  readLoomAppBundle,
  refreshDesktopLoomAppIndex,
  applyDesktopLoomDeletions,
  compareDesktopLoomManifest,
  downloadDesktopLoomApps,
  uploadDesktopLoomApps,
};