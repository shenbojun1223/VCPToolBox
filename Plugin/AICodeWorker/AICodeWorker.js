"use strict";
// AICodeWorker - VCP 插件主入口 v1.13.0
// 让 VCP Agent 可以安全调度本地 opencode、Codex 或 antigravity 执行代码任务。
// 插件类型: synchronous / stdio。
//
// v1.5 核心升级：规范化报告输出
//   - 三种模式前缀末尾加入固定报告规范（文件清单 + 执行结果摘要锚点）
//   - buildResult 优先提取 【执行结果摘要】 锚点，新增 fileReadList 字段
//   - opencode 工作质量与上报质量双保证

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { SidecarClient, hasOwnedChildTerminationProof } = require("./appserver/sidecarClient");
const { isWriteProtocolProof } = require("./appserver/writeRuntimeConfig");
const {
    SidecarError,
    withJobMetaLock,
    updateJobMetaLocked,
    writeJsonAtomic,
    createJsonExclusive,
    inspectAuthorizedPatchArtifact,
    removePatchArtifactExact,
    classifyAppServerArtifactMeta,
    assertJobId,
    isPatchProtocolProof
} = require("./appserver/protocol");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const BACKOFF_RUN_WAIT = [2, 3, 5, 10, 15, 20, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const BACKOFF_QUERY    = [5, 10, 15, 20, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const TRACE_MODES = new Set(["summary", "events", "raw"]);
const RESPONSE_MODES = new Set(["compact", "full"]);
const RUN_MODES = new Set(["analyze", "patch", "write"]);
const CODEX_MODELS_CACHE_FILE = "models_cache.json";
const PATCH_CONTRACT_VERSION = 1;
const PATCH_MAX_BYTES = 524288;
const PATCH_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

// ─── 配置加载 ─────────────────────────────────────────────────────────────────

function loadConfig() {
    const envPath = path.join(__dirname, "config.env");
    const raw = {};
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
            const t = line.trim();
            if (!t || t.startsWith("#")) continue;
            const eq = t.indexOf("=");
            if (eq === -1) continue;
            const k = t.slice(0, eq).trim();
            const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
            raw[k] = v;
        }
    }
    return {
        enableOpencode:   (raw.ENABLE_OPENCODE   || "true")  !== "false",
        enableMimocode:   (raw.ENABLE_MIMOCODE   || "false") !== "false",
        opencodeBin:      raw.OPENCODE_BIN       || "opencode",
        opencodeBaseUrl:  raw.OPENCODE_BASE_URL  || "",
        // 不回退 process.env.ANTHROPIC_API_KEY：留空即走 opencode 免费模型，
        // 避免无意中把宿主的 key 注入、误用付费通道。
        opencodeApiKey:   raw.OPENCODE_API_KEY   || "",
        opencodeModel:    raw.OPENCODE_MODEL      || "",
        enableCodex:      (raw.ENABLE_CODEX        || "false") !== "false",
        enableCodexAppServerAnalyze:
            String(raw.ENABLE_CODEX_APP_SERVER_ANALYZE || "").trim().toLowerCase() === "true",
        enableCodexAppServerPatch:
            String(raw.ENABLE_CODEX_APP_SERVER_PATCH || "").trim().toLowerCase() === "true",
        enableCodexAppServerWrite:
            String(raw.ENABLE_CODEX_APP_SERVER_WRITE || "").trim().toLowerCase() === "true",
        codexBin:          raw.CODEX_BIN            || "codex",
        codexModel:        raw.CODEX_MODEL          || "",
        codexProfile:      raw.CODEX_PROFILE        || "",
        codexHome:         raw.CODEX_HOME           ||
                           process.env.CODEX_HOME    ||
                           path.join(os.homedir(), ".codex"),
        codexModelsCache:  raw.CODEX_MODELS_CACHE   || "",
        enableAntigravity:(raw.ENABLE_ANTIGRAVITY || "false") !== "false",
        agyBin:           raw.AGY_BIN             || "agy",
        agyModel:         raw.AGY_MODEL           || "",
        agyProxy:         raw.AGY_PROXY           || "http://127.0.0.1:7890",
        allowedRoots:     (raw.ALLOWED_PROJECT_ROOTS || "/app/VCPToolBox_new,/app/ZhongZhuan,/app/claud")
                              .split(",").map(s => s.trim()).filter(Boolean),
        jobRoot:          raw.JOB_ROOT           || path.join(__dirname, "jobs"),
        maxTaskChars:     parseInt(raw.MAX_TASK_CHARS      || "20000", 10),
        defaultTimeout:   parseInt(raw.DEFAULT_TIMEOUT_SEC || "600",   10),
        allowDangerSkip:  (raw.ALLOW_DANGEROUS_SKIP_PERMISSIONS || "false") !== "false",
        redactSecrets:    (raw.REDACT_SECRETS    || "true")  !== "false",
        projectContext:   raw.PROJECT_CONTEXT ? raw.PROJECT_CONTEXT.replace(/\\n/g, "\n") : "",
        fileSizeWarnKB:   parseInt(raw.FILE_SIZE_WARN_KB || "200", 10),
        defaultTraceMode: TRACE_MODES.has(String(raw.DEFAULT_TRACE_MODE || "summary").trim().toLowerCase())
                              ? String(raw.DEFAULT_TRACE_MODE || "summary").trim().toLowerCase()
                              : "summary",
        traceMaxEvents:   Math.max(1, parseInt(raw.TRACE_MAX_EVENTS || "60", 10)),
        traceEventTextChars: Math.max(100, parseInt(raw.TRACE_EVENT_TEXT_CHARS || "800", 10)),
        traceRawMaxChars: Math.max(1000, parseInt(raw.TRACE_RAW_MAX_CHARS || "16000", 10)),
        // 2026-06-27崩服务器事故后加的硬保险：opencode/antigravity 共用同一并发上限(不是各自1个)，
        // 默认1=任何时刻全服务器只允许1个 worker 实例在跑。之前只在文档写"严禁并发"靠自觉，没有代码强制。
        maxConcurrentJobs: parseInt(raw.MAX_CONCURRENT_JOBS || "1", 10),
        appServerMaxConcurrentJobs: 2,
    };
}

const CFG = loadConfig();
let _ocVersionCache = null;
let _codexVersionCache = null;

const APP_SERVER_BACKEND = "codex-app-server";
const LEGACY_BACKEND = "legacy-exec";
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "timeout"]);
const LEGACY_CANCEL_GRACE_MS = 1500;
const LEGACY_CANCEL_CONFIRM_TIMEOUT_MS = 1000;
const LEGACY_CANCEL_CONFIRM_POLL_MS = 50;

function createSidecarClient(options = {}) {
    return new SidecarClient({
        pluginDir: __dirname,
        jobRoot: CFG.jobRoot,
        codexBin: CFG.codexBin,
        maxConcurrency: CFG.appServerMaxConcurrentJobs,
        ...options
    });
}

function isAppServerMeta(meta) {
    return classifyAppServerArtifactMeta(meta) !== "legacy";
}

function isCodexAppServerAnalyzeRoute(worker, mode) {
    return CFG.enableCodexAppServerAnalyze &&
        String(worker || "").trim().toLowerCase() === "codex" &&
        String(mode || "").trim().toLowerCase() === "analyze";
}

function isCodexAppServerWriteRoute(worker, mode) {
    return CFG.enableCodexAppServerWrite &&
        String(worker || "").trim().toLowerCase() === "codex" &&
        String(mode || "").trim().toLowerCase() === "write";
}

function safeErrorDetails(error) {
    const details = error?.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
    const result = {};
    for (const key of ["cause", "rpcCode", "kind", "signal"]) {
        if (details[key] !== undefined && ["string", "number", "boolean"].includes(typeof details[key])) {
            result[key] = String(details[key]).slice(0, 128);
        }
    }
    return Object.keys(result).length ? result : undefined;
}

function appServerErrorResult(error, extra = {}) {
    const errorCode = extra.errorCode || error?.code || "AICW_APP_SERVER_ERROR";
    const result = {
        status: "error",
        error: extra.error || "Codex app-server 请求失败。",
        errorCode,
        ...extra
    };
    delete result.errorCodeOverride;
    const details = safeErrorDetails(error);
    if (details) result.details = { ...details, ...(extra.details || {}) };
    else if (extra.details) result.details = extra.details;
    return result;
}

const APP_SERVER_UNKNOWN_SUBMISSION_CODES = new Set([
    "SIDECAR_IPC_TIMEOUT",
    "SIDECAR_IPC_CLOSED",
    "SIDECAR_IPC_ERROR",
    "SIDECAR_IPC_WRITE_FAILED",
    "INVALID_SIDECAR_RESPONSE",
    "SIDECAR_RESPONSE_MISMATCH",
    "SIDECAR_IPC_BUFFER_OVERFLOW"
]);

const APP_SERVER_FALLBACK_CODES = new Set([
    "SIDECAR_SPAWN_FAILED",
    "SIDECAR_START_FAILED",
    "SIDECAR_STARTING_FAILED",
    "CODEX_VERSION_SPAWN_FAILED",
    "CODEX_VERSION_FAILED",
    "CODEX_APP_SERVER_SPAWN_FAILED",
    "CODEX_INITIALIZE_FAILED"
]);

function isAppServerSubmissionUnknown(error) {
    return APP_SERVER_UNKNOWN_SUBMISSION_CODES.has(String(error?.code || ""));
}

const APP_SERVER_PATCH_UNSUPPORTED_CODES = new Set([
    "UNKNOWN_METHOD",
    "METHOD_NOT_FOUND",
    "UNSUPPORTED_METHOD",
    "UNSUPPORTED_PROTOCOL",
    "PROTOCOL_VERSION_MISMATCH",
    "SIDECAR_PROTOCOL_VERSION_MISMATCH",
    "SIDECAR_VERSION_MISMATCH",
    "AICW_PATCH_CODEX_VERSION_UNVERIFIED"
]);
const SERVICE_TIER_OVERRIDE_PROTOCOL_VERSION = 1;
const SERVICE_TIER_SIDECAR_UNSUPPORTED = "AICW_SERVICE_TIER_SIDECAR_UNSUPPORTED";
const APP_SERVER_PATCH_META_CODES = new Set([
    "DUPLICATE_JOB_ID",
    "META_NOT_FOUND",
    "META_INVALID",
    "META_MALFORMED",
    "META_JOB_MISMATCH"
]);

function isAppServerPatchSubmissionUnknown(error) {
    return error?.code === "AICW_APP_SERVER_PATCH_SUBMISSION_UNKNOWN" ||
        isAppServerSubmissionUnknown(error);
}

function mapAppServerPatchSubmissionError(error) {
    const code = String(error?.code || "");
    if (isAppServerPatchSubmissionUnknown(error)) {
        return {
            errorCode: "AICW_APP_SERVER_PATCH_SUBMISSION_UNKNOWN",
            state: "running",
            submissionState: "unknown",
            message: "Codex app-server patch 提交结果未知，已保留原任务；禁止重放或回退。"
        };
    }
    if (code === "CONCURRENCY_LIMIT") {
        return {
            errorCode: "AICW_APP_SERVER_PATCH_CONCURRENCY_LIMIT",
            state: "failed",
            submissionState: "rejected",
            message: "Codex app-server analyze/patch 共享并发额度已满，任务未被接受。"
        };
    }
    if (code === SERVICE_TIER_SIDECAR_UNSUPPORTED) {
        return {
            errorCode: SERVICE_TIER_SIDECAR_UNSUPPORTED,
            state: "failed",
            submissionState: "rejected",
            message: "当前 Sidecar 不支持显式逐任务档位覆盖；任务未提交，请受控更新 Sidecar 实例。"
        };
    }
    if (APP_SERVER_PATCH_UNSUPPORTED_CODES.has(code)) {
        return {
            errorCode: "AICW_APP_SERVER_PATCH_UNSUPPORTED",
            state: "failed",
            submissionState: "rejected",
            message: "当前 Sidecar 或 Codex 版本无法确认支持 patch 协议，已安全拒绝。"
        };
    }
    if (APP_SERVER_PATCH_META_CODES.has(code)) {
        return {
            errorCode: "AICW_APP_SERVER_PATCH_META_FAILED",
            state: "failed",
            submissionState: "rejected",
            message: "Codex app-server patch Job 元数据或唯一性校验失败，已安全拒绝。"
        };
    }
    return {
        errorCode: "AICW_APP_SERVER_PATCH_UNAVAILABLE",
        state: "failed",
        submissionState: "rejected",
        message: "Codex app-server patch 当前不可用，任务未回退到 legacy。"
    };
}

function shouldFallbackToLegacyBeforeJob(error, beforeInspection, afterInspection, context = {}) {
    if (!(error instanceof SidecarError)) return false;
    if (!error || !APP_SERVER_FALLBACK_CODES.has(String(error.code || ""))) return false;
    if (context.jobCreated !== false || context.hasAppServerMeta !== false) return false;
    const uncertainStates = new Set(["starting", "ready", "degraded", "unresponsive", "error", "stale-lock"]);
    if (uncertainStates.has(beforeInspection?.status) || uncertainStates.has(afterInspection?.status)) return false;
    if (!["absent", "dead"].includes(beforeInspection?.status)) return false;
    if (!["absent", "dead"].includes(afterInspection?.status)) return false;
    if (Number(beforeInspection?.activeJobs || 0) > 0 || Number(afterInspection?.activeJobs || 0) > 0) return false;
    if (afterInspection.status === "dead" && afterInspection.reconciled !== true) return false;
    if (beforeInspection?.errorCode || afterInspection?.errorCode) return false;
    if (beforeInspection?.warnings?.length || afterInspection?.warnings?.length) return false;
    if (beforeInspection?.identityUnknown || afterInspection?.identityUnknown) return false;
    if (error.details?.safeToFallback !== true) return false;
    if (error.details?.fallbackEvidence !== "owned-child-termination-confirmed") return false;
    if (!hasOwnedChildTerminationProof(error)) return false;
    return true;
}

function executionMetaPayload(meta) {
    const appServer = isAppServerMeta(meta);
    return {
        executionBackend: meta?.executionBackend || (appServer ? null : LEGACY_BACKEND),
        requestedExecutionBackend: meta?.requestedExecutionBackend || null,
        submissionState: meta?.submissionState || null,
        sidecarInstanceId: meta?.sidecarInstanceId || null,
        sidecarPid: meta?.sidecarPid || null,
        threadId: meta?.threadId || null,
        turnId: meta?.turnId || null,
        metaRevision: Number.isSafeInteger(meta?.metaRevision) ? meta.metaRevision : null,
        errorCode: meta?.errorCode || null
    };
}

async function reconcileAppServerJobsNoStart() {
    const client = createSidecarClient();
    try {
        return await client.reconcileDeadInstance();
    } catch (error) {
        return {
            status: "error",
            activeJobs: 0,
            maxConcurrency: CFG.appServerMaxConcurrentJobs,
            errorCode: error?.code || "SIDECAR_RECONCILIATION_FAILED"
        };
    }
}


function parseTomlStringValue(rawValue) {
    let value = String(rawValue || "").trim();
    if (!value) return "";

    let quote = null;
    let output = "";

    for (let index = 0; index < value.length; index++) {
        const char = value[index];

        if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
            if (quote === char) quote = null;
            else if (!quote) quote = char;
        }

        if (char === "#" && !quote) break;
        output += char;
    }

    value = output.trim();

    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        return value.slice(1, -1);
    }

    return value;
}

function readCodexTopLevelConfig(filePath) {
    const result = {
        path: filePath,
        exists: false,
        model: "",
        modelReasoningEffort: ""
    };

    if (!filePath || !fs.existsSync(filePath)) return result;
    result.exists = true;

    let insideTable = false;
    const content = fs.readFileSync(filePath, "utf8");

    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        if (/^\[.*\]$/.test(trimmed)) {
            insideTable = true;
            continue;
        }

        if (insideTable) continue;

        const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
        if (!match) continue;

        const key = match[1];
        const value = parseTomlStringValue(match[2]);

        if (key === "model") result.model = value;
        if (key === "model_reasoning_effort") {
            result.modelReasoningEffort = value.toLowerCase();
        }
    }

    return result;
}

function normalizeReasoningLevelEntry(entry) {
    if (typeof entry === "string") {
        const effort = entry.trim().toLowerCase();
        return effort ? { effort, description: "" } : null;
    }

    if (!entry || typeof entry !== "object") return null;

    const effort = String(
        entry.effort ??
        entry.value ??
        entry.id ??
        entry.name ??
        entry.slug ??
        ""
    ).trim().toLowerCase();

    if (!effort) return null;

    return {
        effort,
        description: String(entry.description || "").trim()
    };
}

function readCodexModelsCache() {
    const cachePath = CFG.codexModelsCache ||
        path.join(CFG.codexHome, CODEX_MODELS_CACHE_FILE);

    const result = {
        path: cachePath,
        exists: false,
        error: "",
        fetchedAt: null,
        clientVersion: null,
        models: []
    };

    if (!fs.existsSync(cachePath)) return result;
    result.exists = true;

    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        result.fetchedAt = parsed?.fetched_at || null;
        result.clientVersion = parsed?.client_version || null;
        result.models = Array.isArray(parsed?.models)
            ? parsed.models
            : Array.isArray(parsed)
                ? parsed
                : [];
    } catch (error) {
        result.error = error.message || "models_cache.json parse failed";
    }

    return result;
}

function findCodexModelEntry(models, modelName) {
    const target = String(modelName || "").trim().toLowerCase();
    if (!target) return null;

    return (models || []).find(model => {
        for (const key of [
            "slug",
            "id",
            "model",
            "model_id",
            "name"
        ]) {
            if (
                typeof model?.[key] === "string" &&
                model[key].trim().toLowerCase() === target
            ) {
                return true;
            }
        }
        return false;
    }) || null;
}

function resolveCodexModelCapabilities(taskModel = "") {
    const baseConfigPath = path.join(CFG.codexHome, "config.toml");
    const baseConfig = readCodexTopLevelConfig(baseConfigPath);

    const profileConfigPath = CFG.codexProfile
        ? path.join(CFG.codexHome, `${CFG.codexProfile}.config.toml`)
        : "";
    const profileConfig = readCodexTopLevelConfig(profileConfigPath);

    const taskModelValue =
        typeof taskModel === "string" ? taskModel.trim() : "";

    let model = "";
    let modelSource = "unknown";

    if (taskModelValue) {
        model = taskModelValue;
        modelSource = "task_override";
    } else if (CFG.codexModel) {
        model = CFG.codexModel;
        modelSource = "plugin_config";
    } else if (profileConfig.model) {
        model = profileConfig.model;
        modelSource = "profile_config";
    } else if (baseConfig.model) {
        model = baseConfig.model;
        modelSource = "codex_config";
    }

    const cache = readCodexModelsCache();
    const modelEntry = findCodexModelEntry(cache.models, model);

    const supportedReasoningLevels = Array.isArray(
        modelEntry?.supported_reasoning_levels
    )
        ? modelEntry.supported_reasoning_levels
            .map(normalizeReasoningLevelEntry)
            .filter(Boolean)
        : [];

    const seen = new Set();
    const uniqueReasoningLevels = supportedReasoningLevels.filter(level => {
        if (seen.has(level.effort)) return false;
        seen.add(level.effort);
        return true;
    });

    const modelDefaultReasoningEffort = String(
        modelEntry?.default_reasoning_level || ""
    ).trim().toLowerCase();

    const configuredReasoningEffort = String(
        profileConfig.modelReasoningEffort ||
        baseConfig.modelReasoningEffort ||
        ""
    ).trim().toLowerCase();

    let effectiveReasoningEffort = "";
    let effectiveReasoningEffortSource = "unknown";

    if (configuredReasoningEffort) {
        effectiveReasoningEffort = configuredReasoningEffort;
        effectiveReasoningEffortSource =
            profileConfig.modelReasoningEffort
                ? "profile_config"
                : "codex_config";
    } else if (modelDefaultReasoningEffort) {
        effectiveReasoningEffort = modelDefaultReasoningEffort;
        effectiveReasoningEffortSource = "model_default";
    }

    return {
        model: model || null,
        modelSource,
        displayName: modelEntry?.display_name || null,
        description: modelEntry?.description || null,
        reasoningCapabilitiesVerified:
            Boolean(modelEntry) &&
            uniqueReasoningLevels.length > 0,
        supportedReasoningLevels: uniqueReasoningLevels,
        supportedReasoningEfforts:
            uniqueReasoningLevels.map(level => level.effort),
        modelDefaultReasoningEffort:
            modelDefaultReasoningEffort || null,
        configuredReasoningEffort:
            configuredReasoningEffort || null,
        effectiveReasoningEffort:
            effectiveReasoningEffort || null,
        effectiveReasoningEffortSource,
        cache: {
            exists: cache.exists,
            error: cache.error || null,
            fetchedAt: cache.fetchedAt,
            clientVersion: cache.clientVersion
        },
        config: {
            baseConfigExists: baseConfig.exists,
            profile: CFG.codexProfile || null,
            profileConfigExists: profileConfig.exists
        }
    };
}

function buildReasoningMetadata(
    normWorker,
    normalizedReasoningEffort,
    codexCapabilities
) {
    if (normWorker !== "codex") {
        return {
            codexModel: null,
            codexModelSource: null,
            reasoningEffort: null,
            reasoningEffortEffective: null,
            reasoningEffortSource: null,
            reasoningEffortSupported: [],
            modelDefaultReasoningEffort: null,
            configuredReasoningEffort: null
        };
    }

    return {
        codexModel: codexCapabilities?.model || null,
        codexModelSource:
            codexCapabilities?.modelSource || "unknown",
        reasoningEffort:
            normalizedReasoningEffort || null,
        reasoningEffortEffective:
            normalizedReasoningEffort ||
            codexCapabilities?.effectiveReasoningEffort ||
            null,
        reasoningEffortSource:
            normalizedReasoningEffort
                ? "task_override"
                : codexCapabilities?.effectiveReasoningEffortSource ||
                  "unknown",
        reasoningEffortSupported:
            codexCapabilities?.supportedReasoningEfforts || [],
        modelDefaultReasoningEffort:
            codexCapabilities?.modelDefaultReasoningEffort || null,
        configuredReasoningEffort:
            codexCapabilities?.configuredReasoningEffort || null
    };
}

// ─── Job 路径 ─────────────────────────────────────────────────────────────────

function jobPaths(jobId) {
    return {
        output: path.join(CFG.jobRoot, "output",  `${jobId}.txt`),
        log:    path.join(CFG.jobRoot, "logs",    `${jobId}.log`),
        patch:  path.join(CFG.jobRoot, "patches", `${jobId}.patch`),
        meta:   path.join(CFG.jobRoot, "meta",    `${jobId}.json`),
        args:        path.join(CFG.jobRoot, "meta",   `${jobId}.args.json`),
        codexOutput: path.join(CFG.jobRoot, "output", `${jobId}.codex-last.txt`),
    };
}

function ensureJobDirs() {
    for (const sub of ["output", "logs", "patches", "meta"]) {
        const d = path.join(CFG.jobRoot, sub);
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
}

function generateJobId() {
    const n = new Date();
    const p = x => String(x).padStart(2, "0");
    return `job_${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}_${crypto.randomUUID()}`;
}

function readMeta(jobId) {
    const mp = jobPaths(jobId).meta;
    if (!fs.existsSync(mp)) return null;
    try { return JSON.parse(fs.readFileSync(mp, "utf8")); } catch { return null; }
}

function saveMeta(jobId, meta) {
    writeJsonAtomic(jobPaths(jobId).meta, meta);
}

function rebindLegacyRunnerArgs(runnerArgs, previousPaths, nextJobId, nextPaths) {
    runnerArgs.jobId = nextJobId;
    if (runnerArgs.codexOutputFile === previousPaths.codexOutput) {
        runnerArgs.codexOutputFile = nextPaths.codexOutput;
    }
    if (Array.isArray(runnerArgs.codexArgs)) {
        runnerArgs.codexArgs = runnerArgs.codexArgs.map(argument =>
            argument === previousPaths.codexOutput ? nextPaths.codexOutput : argument
        );
    }
}

function isProcessRunning(pid) {
    if (!pid) return false;
    try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {}
}

function killProcessTreeSync(pid, force = false) {
    const target = Number(pid);
    if (!Number.isInteger(target) || target <= 0) return false;

    if (process.platform === "win32") {
        const args = ["/PID", String(target), "/T"];
        if (force) args.push("/F");
        const result = spawnSync("taskkill", args, {
            stdio: "ignore",
            windowsHide: true
        });
        return result.status === 0;
    }

    const signal = force ? "SIGKILL" : "SIGTERM";
    try {
        process.kill(-target, signal);
        return true;
    } catch {
        try {
            process.kill(target, signal);
            return true;
        } catch {
            return false;
        }
    }
}

/** 启动前强制清理残留 opencode 进程，防止僵尸堆积 */
function killResidualOpencode() {
    try {
        const { execSync } = require("child_process");
        const out = execSync("pgrep -x opencode 2>/dev/null || true", { encoding: "utf8" });
        for (const line of out.split("\n")) {
            const pid = line.trim();
            if (!pid) continue;
            try { process.kill(Number(pid), "SIGKILL"); } catch {}
        }
    } catch {}
}

/** 原子文件锁：防止并发竞态导致双开 opencode
 *  修复：锁文件写入时间戳，超龄(>defaultTimeout+60s)自动清理，防止进程崩溃后死锁 */
const LOCK_FILE = path.join(CFG.jobRoot, ".job_lock");
function acquireJobLock() {
    // 先检查锁文件是否超龄（进程崩溃后未释放的残留锁）
    try {
        if (fs.existsSync(LOCK_FILE)) {
            const content = fs.readFileSync(LOCK_FILE, "utf8").trim();
            const [, tsStr] = content.split(":");
            const lockAge = (Date.now() - Number(tsStr)) / 1000;
            const maxLockAge = CFG.defaultTimeout + 60;
            if (lockAge > maxLockAge) {
                fs.unlinkSync(LOCK_FILE); // 超龄锁，强制清理
            }
        }
    } catch {}
    try {
        const fd = fs.openSync(LOCK_FILE, "wx");
        fs.writeSync(fd, `${process.pid}:${Date.now()}`); // 写 PID + 时间戳
        fs.closeSync(fd);
        return true;
    } catch { return false; }
}
function releaseJobLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// ─── 密钥脱敏 ─────────────────────────────────────────────────────────────────

const SECRET_RE = [
    // 要求 key 名后面有 =: 分隔符 + 实际值（≥10字符），避免误伤源码变量名/正则
    /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|x-api-key)\s*[=:]\s*["']?[A-Za-z0-9\-_.+/]{10,}["']?/gi,
    /Authorization\s*:\s*\S{10,}/gi,
    /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /\b(?:password|token|secret)\b\s*[=:]\s*\S{6,}/gi,
];

function redact(text) {
    if (!CFG.redactSecrets || !text) return text || "";
    let out = text;
    for (const re of SECRET_RE) out = out.replace(re, "***MASKED***");
    return out;
}

// ─── 路径白名单验证 ───────────────────────────────────────────────────────────

function isPathWithinRoot(projectPath, root) {
    // 先词法规范化，再用 realpath 解析符号链接(防 symlink 绕过白名单)
    // realpath 失败(路径不存在等)时退回词法规范化结果
    let resolved = path.resolve(projectPath);
    let r = path.resolve(root);
    try { resolved = fs.realpathSync.native(resolved); } catch (e) {}
    try { r = fs.realpathSync.native(r); } catch (e) {}
    const relative = path.relative(r, resolved);
    return relative === "" ||
        (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}


function validatePath(projectPath) {
    if (!projectPath || typeof projectPath !== "string")
        return "projectPath 是必填参数。";
    const resolved = path.resolve(projectPath);
    for (const root of CFG.allowedRoots) {
        if (isPathWithinRoot(resolved, root)) return null;
    }
    return `projectPath "${resolved}" 不在白名单内。允许的路径: ${CFG.allowedRoots.join(", ")}`;
}

// ─── Preset 快捷任务库（v1.6）────────────────────────────────────────────────
// 低算力模型只需传 preset + targetPath（+ 少量附加参数），插件自动生成任务书和 mode。
// projectPath 在未提供时从 targetPath 自动推导。

const PRESETS = {
    index: {
        mode: "analyze",
        required: ["targetPath"],
        desc: "列出文件的所有函数/方法索引（行号·名称·功能）",
        generate: (p) =>
            `请读取 ${p.targetPath}，列出所有函数/方法的完整索引。\n` +
            `每行格式：行号 | 函数名 | 功能描述（≤20字）\n` +
            `不修改任何文件。`,
    },
    read: {
        mode: "analyze",
        required: ["targetPath"],
        desc: "读取文件完整内容并原文输出",
        generate: (p) =>
            `请读取 ${p.targetPath} 的完整内容并原文输出。不修改任何文件。`,
    },
    scan: {
        mode: "analyze",
        required: ["targetPath"],
        desc: "扫描目录结构，列出文件树 + 用途说明",
        generate: (p) =>
            `请扫描 ${p.targetPath}` +
            (p.depth ? `（最多 ${p.depth} 层）` : "") +
            `，列出目录/文件树形结构，每个文件附一句用途说明。不修改任何文件。`,
    },
    bug: {
        mode: "analyze",
        required: ["targetPath", "error"],
        desc: "分析文件中某个错误的根本原因",
        generate: (p) =>
            `请分析 ${p.targetPath} 中以下错误的根本原因：\n` +
            `错误信息：${p.error}\n` +
            (p.detail ? `附加上下文：${p.detail}\n` : "") +
            `只输出分析报告，不修改任何文件。`,
    },
    set: {
        mode: "write",
        required: ["targetPath", "key", "value"],
        desc: "修改文件中某个配置项/变量的值",
        generate: (p) =>
            `请修改 ${p.targetPath}，将 ${p.key} 的值改为 ${p.value}。\n` +
            `约束：只改这一处，禁止修改其他内容或其他文件。\n` +
            `验证：修改后重新读取包含 "${p.key}" 的相关行并在报告中附输出。`,
    },
    append: {
        mode: "write",
        required: ["targetPath", "content"],
        desc: "在文件末尾（或指定位置）追加内容",
        generate: (p) =>
            `请在 ${p.targetPath} 的${p.position || "末尾"}追加以下内容：\n` +
            `${p.content}\n` +
            `约束：只追加，禁止修改已有内容，禁止操作其他文件。\n` +
            `验证：追加后读取文件末尾 20 行并在报告中附输出（使用当前系统可用命令）。`,
    },
    create: {
        mode: "write",
        required: ["targetPath", "what"],
        desc: "创建或覆写一个文件",
        generate: (p) =>
            `请在 ${p.targetPath} 创建（或覆写）文件，内容要求如下：\n` +
            `${p.what}\n` +
            `约束：只操作这一个文件，禁止修改其他文件。\n` +
            `验证：写入完成后读取文件前 30 行并在报告中附输出。`,
    },
};

/**
 * 处理 preset 快捷参数。
 * 成功返回新的 input 对象（task/mode/projectPath 已填充）；
 * 验证失败返回 {status:"error"} 对象；
 * 未传 preset 返回 null。
 */
function applyPreset(input) {
    const preset = (input.preset || "").trim().toLowerCase();
    if (!preset) return null;

    const def = PRESETS[preset];
    if (!def) {
        const list = Object.entries(PRESETS)
            .map(([k, v]) => `  ${k}：${v.desc}`)
            .join("\n");
        return { status: "error", error: `未知预设 "${input.preset}"。可用预设：\n${list}` };
    }

    const missing = def.required.filter(k => !input[k]);
    if (missing.length > 0) {
        return {
            status: "error",
            error: `预设 "${preset}" 缺少必填参数：${missing.join(", ")}。` +
                   `\n该预设说明：${def.desc}` +
                   `\n必填：${def.required.join(", ")}`,
        };
    }

    // projectPath 未提供时从 targetPath 自动推导
    let projectPath = input.projectPath;
    if (!projectPath && input.targetPath) {
        try {
            const stat = fs.statSync(input.targetPath);
            projectPath = stat.isDirectory() ? input.targetPath : path.dirname(input.targetPath);
        } catch {
            projectPath = path.dirname(input.targetPath);
        }
    }

    return {
        ...input,
        task:        def.generate(input),
        mode:        input.mode === undefined ? def.mode : input.mode,
        projectPath: projectPath || input.projectPath,
    };
}

// ─── 报告规范尾部（三种模式共用）─────────────────────────────────────────────
// v1.5 核心：强制 opencode 在报告末尾输出固定格式锚点
// buildResult 优先提取【执行结果摘要】，VCP AI 无需重读全文

const REPORT_FOOTER_ANALYZE = `

【报告输出规范 - 必须严格遵守，这是最后输出的内容】
① 报告正文用 ▍01 · 标题 / ▍02 · 标题 格式分节，每节标题清晰
② 发现关键风险/坑点/异常时用 ⚠️ 明显标出
③ 结论基于推断而非直接读取时，必须注明：「此处基于推断，未直读源文件」
④ 报告最后必须输出以下两行（格式固定，不得省略）：
【读取文件清单】已读：<逗号分隔的文件路径列表> | 跳过/未读：<文件及原因，无则写"无">
【执行结果摘要】<60字以内一句话：做了什么 · 发现了什么 · 结论是什么>`;

const REPORT_FOOTER_PATCH = `

【报告输出规范 - 必须严格遵守，这是最后输出的内容】
① 每个 diff 块前说明：修改原因 + 影响范围
② diff 格式：标准 unified diff，上下文保留 3 行，行号必须准确
③ 若某处修改有风险，用 ⚠️ 标注并说明原因
④ 报告最后必须输出以下三行（格式固定，不得省略）：
【读取文件清单】已读：<文件列表> | 跳过：<文件及原因，无则写"无">
【变更摘要】共 N 处修改 | 涉及文件：<列表> | 风险点：<若有则列出，无则写"无">
【执行结果摘要】<60字以内一句话：生成了什么补丁 · 解决了什么问题 · 是否有风险>`;

const REPORT_FOOTER_WRITE = `

【报告输出规范 - 必须严格遵守，这是最后输出的内容】
① 每次修改文件前说明：修改哪个文件、改了什么、为什么
② 修改完成后必须重新读取文件确认写入成功（使用当前系统可用的文件读取命令或工具）
③ 发现与预期不符时立即停止并说明，不要强行继续
④ 报告最后必须输出以下三行（格式固定，不得省略）：
【读取文件清单】已读：<列表> | 已修改：<列表> | 已新增：<列表> | 已删除：<列表，无则写"无">
【变更摘要】<逐文件一行描述：路径 → 做了什么变更>
【执行结果摘要】<60字以内一句话：改了什么 · 验证结果如何 · 是否完全成功>`;

// ─── 安全前缀 ─────────────────────────────────────────────────────────────────

const PREFIX_ANALYZE = `【VCP AICodeWorker - analyze 模式，安全约束必须严格遵守】
你作为只读代码分析 Worker 执行此任务：
- 只允许读取和分析文件，禁止修改、删除、移动、创建任何文件
- 禁止安装依赖（npm install / pip install 等），禁止重启或停止服务
- 如需提出修改建议，以 diff/patch 格式输出，不得直接落盘
- 禁止在输出中包含 API Key、密码、Token 等敏感信息
【任务内容】
`;

const PREFIX_PATCH = `【VCP AICodeWorker - patch 模式，安全约束必须严格遵守】
你作为 patch 生成 Worker 执行此任务：
- 可以读取文件进行分析
- 必须以 unified diff 格式输出修改建议，每处修改单独一个 diff 块
- 禁止直接写入、修改、删除任何文件，禁止安装依赖、重启服务
- 禁止在输出中包含敏感信息
【任务内容】
`;

const PREFIX_WRITE = `【VCP AICodeWorker - write 模式，安全约束必须严格遵守】
你作为代码修改 Worker 执行此任务：
- 可以读取文件进行分析
- 可以修改/新增文件，但只能操作 task 中明确指定或直接相关的文件
- 禁止删除文件（除非 task 明确要求删除且说明原因）
- 禁止修改配置文件（*.env, config.env, .env.* 等）
- 禁止安装依赖（npm install / pip install 等），禁止重启或停止任何服务
- 禁止在输出或文件内容中写入 API Key、密码、Token 等敏感信息
【任务内容】
`;

// ─── 任务书预检 ───────────────────────────────────────────────────────────────

const VAGUE_VERBS    = /看一下|处理一下|优化一下|整理一下|随便|帮我看看|感觉|好像|试试|弄一下|搞一下|清理一下(?!.{0,30}\/)/;
const HAS_ABS_PATH   = /(?:\/[a-zA-Z0-9_一-龥])|(?:\b[A-Za-z]:[\\/])/;
const HAS_CONSTRAINT = /禁止|只改|不要|仅|只有|排除|不能|不得|不允许/;
const HAS_VERIFY     = /验证|ls |ls$|cat |check|确认|ENOENT|Test-Path|Get-Item|Get-Content|dir |type |\$\?/i;
const DANGER_OPS     = /\brm\b|删除|清空|移动|\bmv\b|truncate|unlink|Remove-Item|\bdel\b|\berase\b|\brmdir\b/i;

function preflightCheck(task, mode) {
    const warnings = [];
    if (VAGUE_VERBS.test(task))
        warnings.push({ level: "warn",  message: "任务描述含模糊动词（看一下/处理一下等），opencode 可能偏离意图；建议改为明确动作动词。" });
    if ((mode === "write" || mode === "patch") && !HAS_ABS_PATH.test(task))
        warnings.push({ level: "error", message: "write/patch 模式未检测到绝对路径（支持 /path 或 C:\\path），建议改用绝对路径防止工作目录歧义。" });
    if (mode === "write" && !HAS_CONSTRAINT.test(task))
        warnings.push({ level: "warn",  message: "write 模式未包含操作约束（禁止/只改/不要等），opencode 可能顺手修改无关文件。" });
    if (mode === "write" && DANGER_OPS.test(task) && !HAS_VERIFY.test(task))
        warnings.push({ level: "error", message: "任务含删除/移动操作但未要求验证步骤，建议加：'操作前后必须 ls -la 验证并在报告中附输出'。" });
    return warnings;
}

// ─── 大文件预检 ───────────────────────────────────────────────────────────────

const FILE_PATH_RE = /(?:^|[\s"'`(（])((?:[A-Za-z]:[\\/]|\/)[^\s"'`)\n）]{3,})/gim;

function checkFileSizes(task) {
    const warnings = [];
    const seen = new Set();
    let m;
    FILE_PATH_RE.lastIndex = 0;
    while ((m = FILE_PATH_RE.exec(task)) !== null) {
        const fp = m[1].replace(/[,。、）)】]+$/, "");
        if (seen.has(fp)) continue;
        seen.add(fp);
        const isAllowed = CFG.allowedRoots.some(r => isPathWithinRoot(fp, r));
        if (!isAllowed) continue;
        try {
            const stat = fs.statSync(fp);
            if (!stat.isFile()) continue;
            const kb = stat.size / 1024;
            if (kb > CFG.fileSizeWarnKB) {
                warnings.push({
                    level: "warn",
                    message: `文件 ${fp} 约 ${Math.round(kb)}KB（超过 ${CFG.fileSizeWarnKB}KB 阈值），opencode 全量读取可能超时或质量下降；建议缩小范围（指定函数名/行号，或先 grep 过滤）。`
                });
            }
        } catch {}
    }
    return warnings;
}

// ─── 危险操作自动补丁 ─────────────────────────────────────────────────────────

const DANGER_VERIFY_PATCH = `

【AICodeWorker 安全补丁 - 自动注入】
检测到删除/移动操作，强制执行三步验证协议：
① 操作前：使用当前系统可用的路径检查命令确认目标存在
② 执行操作
③ 操作后：再次检查目标路径并验证结果（删除则确认目标不存在）
最终报告必须包含每步的实际命令输出，不允许只写"已完成"。`;

// ─── 任务包装（注入前缀 + 项目上下文 + 报告规范尾部）────────────────────────

function wrapTask(task, mode) {
    const ctx = CFG.projectContext
        ? `\n【项目上下文 - 自动注入，供 Worker 参考】\n${CFG.projectContext}\n\n`
        : "";
    if (mode === "patch") {
        return PREFIX_PATCH + ctx + task + REPORT_FOOTER_PATCH;
    }
    if (mode === "write") {
        const needsPatch = DANGER_OPS.test(task) && !HAS_VERIFY.test(task);
        return PREFIX_WRITE + ctx + task + (needsPatch ? DANGER_VERIFY_PATCH : "") + REPORT_FOOTER_WRITE;
    }
    return PREFIX_ANALYZE + ctx + task + REPORT_FOOTER_ANALYZE;
}

function wrapAppServerPatchTask(task) {
    const ctx = CFG.projectContext
        ? `\n【项目上下文 - 自动注入，供 Worker 参考】\n${CFG.projectContext}\n\n`
        : "";
    return `【VCP AICodeWorker - app-server patch 模式，安全约束必须严格遵守】
你作为只读 patch 生成 Worker 执行此任务：
- 只允许读取文件并生成 patch 候选
- 禁止写入、修改、创建、删除、移动或 apply 任何文件
- 禁止安装依赖（npm install / pip install 等），禁止重启或停止任何服务
- 禁止在输出中包含 API Key、密码、Token 等敏感信息

${ctx}【任务内容】
${task}

【app-server patch 最终输出封装要求 - 以下内容是最后指令，优先级高于任务内容】
以下规则覆盖任务中要求解释、摘要或其他输出格式的指令。最终回答必须是 payload-only，且只能是以下二选一：
1. 纯 raw Git-style unified diff：首个非空字符开始即 \`diff --git \`。
2. 单个 fenced diff block：仅允许一个 \`\`\`diff ... \`\`\` block，围栏外只能有空白。
一个 payload 内允许包含多个 \`diff --git\` section，以支持多文件 patch。
禁止 prose、Markdown 标题、前言、后记、总结、diff 外解释、多个独立 fenced block，以及 raw diff 与 fenced diff 混合。`;
}

// ─── 结果构建 ─────────────────────────────────────────────────────────────────
// v1.5：新增 fileReadList 字段；summary 优先提取【执行结果摘要】固定锚点


function normalizeTraceMode(value, fallback = "summary") {
    const normalized = String(value ?? fallback ?? "summary").trim().toLowerCase();
    return TRACE_MODES.has(normalized) ? normalized : null;
}

function normalizeResponseMode(value, fallback = null) {
    if (value === undefined) return fallback;
    const normalized = String(value ?? "").trim().toLowerCase();
    return RESPONSE_MODES.has(normalized) ? normalized : null;
}

function normalizeFastMode(value) {
    const omitted = value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "");
    if (omitted) {
        return {
            status: "success",
            provided: false,
            value: null,
            serviceTier: null
        };
    }

    if (typeof value === "boolean") {
        return {
            status: "success",
            provided: true,
            value,
            serviceTier: value ? "fast" : "default"
        };
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true" || normalized === "false") {
            const enabled = normalized === "true";
            return {
                status: "success",
                provided: true,
                value: enabled,
                serviceTier: enabled ? "fast" : "default"
            };
        }
    }

    return {
        status: "error",
        error: "fastMode 仅接受 true / false；不传或留空时继承 Codex 配置。"
    };
}

function appendCodexFastModeArgs(args, normalizedFastMode, serviceTierOverride) {
    if (!Array.isArray(args)) {
        throw new TypeError("Codex args must be an array");
    }
    if (!serviceTierOverride) return args;
    args.push("-c", `service_tier="${serviceTierOverride}"`);
    if (normalizedFastMode === true) {
        args.push("-c", "features.fast_mode=true");
    }
    return args;
}

function clipTraceText(value, maxChars = CFG.traceEventTextChars) {
    const text = redact(String(value ?? "")).replace(/\r\n/g, "\n").trim();
    if (!text) return "";
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n…[截断 " + (text.length - maxChars) + " 字符]";
}

function stripReasoningFields(value) {
    if (Array.isArray(value)) return value.map(stripReasoningFields);
    if (!value || typeof value !== "object") return value;

    const result = {};
    for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.toLowerCase();
        if (["reasoning", "reasoning_content", "encrypted_content", "thought", "thoughts"].includes(normalizedKey)) {
            continue;
        }
        result[key] = stripReasoningFields(child);
    }
    return result;
}

function isHiddenReasoningEvent(event) {
    const types = [event?.type, event?.item?.type]
        .filter(Boolean)
        .map(value => String(value).toLowerCase());
    return types.some(type => type.includes("reasoning") || type.includes("thought"));
}

function readCodexJsonlEvents(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const events = [];
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
            const event = JSON.parse(trimmed);
            if (!event || typeof event !== "object" || isHiddenReasoningEvent(event)) continue;
            events.push(event);
        } catch {}
    }
    return events;
}

function capTraceEvents(events) {
    const max = CFG.traceMaxEvents;
    if (events.length <= max) return events;
    if (max === 1) {
        return [{
            type: "omitted",
            count: events.length - 1,
            text: "中间轨迹已省略"
        }];
    }

    const headCount = Math.min(5, Math.floor(max / 3));
    const tailCount = Math.max(1, max - headCount - 1);
    return [
        ...events.slice(0, headCount),
        {
            type: "omitted",
            count: events.length - headCount - tailCount,
            text: "中间轨迹已省略"
        },
        ...events.slice(-tailCount)
    ];
}

function parseCodexExecutionTrace(filePath) {
    const sourceEvents = readCodexJsonlEvents(filePath);
    const trace = [];
    const itemIndexes = new Map();

    const add = entry => {
        entry.sequence = trace.length + 1;
        trace.push(entry);
        return trace.length - 1;
    };

    const upsertItem = (id, entry) => {
        if (id && itemIndexes.has(id)) {
            const index = itemIndexes.get(id);
            trace[index] = { ...trace[index], ...entry, sequence: trace[index].sequence };
            return;
        }
        const index = add(entry);
        if (id) itemIndexes.set(id, index);
    };

    for (const event of sourceEvents) {
        const eventType = String(event.type || "");

        if (eventType === "thread.started") {
            add({ type: "thread", threadId: event.thread_id || "" });
            continue;
        }

        if (eventType === "turn.started") {
            add({ type: "turn", status: "started" });
            continue;
        }

        if (eventType === "turn.completed") {
            add({
                type: "usage",
                status: "completed",
                usage: stripReasoningFields(event.usage || {})
            });
            continue;
        }

        if (eventType === "turn.failed" || eventType === "error") {
            add({
                type: "error",
                status: "failed",
                text: clipTraceText(event.error?.message || event.message || JSON.stringify(stripReasoningFields(event)))
            });
            continue;
        }

        const item = event.item;
        if (!item || typeof item !== "object") continue;

        const itemType = String(item.type || "unknown");
        const itemId = item.id || "";
        const status = item.status ||
            (eventType.endsWith(".completed") ? "completed" :
             eventType.endsWith(".started") ? "in_progress" : "");

        if (itemType === "agent_message") {
            if (!eventType.endsWith(".completed")) continue;
            add({
                type: "message",
                itemId,
                status: status || "completed",
                text: clipTraceText(item.text || item.content || "")
            });
            continue;
        }

        if (itemType === "command_execution") {
            upsertItem(itemId, {
                type: "command",
                itemId,
                status,
                command: clipTraceText(item.command || ""),
                exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null,
                output: clipTraceText(item.aggregated_output || "")
            });
            continue;
        }

        if (itemType === "file_change") {
            upsertItem(itemId, {
                type: "file_change",
                itemId,
                status,
                changes: Array.isArray(item.changes)
                    ? item.changes.map(change => ({
                        path: clipTraceText(change?.path || "", 500),
                        kind: String(change?.kind || "unknown")
                    }))
                    : []
            });
            continue;
        }

        if (itemType === "mcp_tool_call" || itemType === "tool_call" || itemType === "web_search") {
            upsertItem(itemId, {
                type: "tool",
                itemId,
                status,
                name: clipTraceText(item.name || item.tool_name || itemType, 200),
                input: clipTraceText(item.arguments || item.input || item.query || ""),
                output: clipTraceText(item.result || item.output || "")
            });
            continue;
        }

        if (eventType.endsWith(".completed")) {
            add({
                type: "event",
                itemId,
                itemType,
                status,
                text: clipTraceText(item.text || item.message || "")
            });
        }
    }

    return capTraceEvents(trace);
}

function indentTraceText(value) {
    return String(value || "").split("\n").map(line => "  " + line).join("\n");
}

function formatExecutionTrace(events) {
    const lines = [];
    for (const event of events) {
        if (event.type === "thread") {
            lines.push("[会话] " + (event.threadId || "Codex thread started"));
        } else if (event.type === "turn") {
            lines.push("[阶段] Codex 回合开始");
        } else if (event.type === "message") {
            lines.push("[说明] " + (event.text || ""));
        } else if (event.type === "command") {
            const exit = event.exitCode === null ? "" : " exit=" + event.exitCode;
            lines.push("[命令:" + (event.status || "unknown") + exit + "] " + (event.command || ""));
            if (event.output) lines.push("[命令输出]\n" + indentTraceText(event.output));
        } else if (event.type === "file_change") {
            const changes = (event.changes || [])
                .map(change => change.kind + ": " + change.path)
                .join("; ");
            lines.push("[文件变更:" + (event.status || "unknown") + "] " + changes);
        } else if (event.type === "tool") {
            lines.push("[工具:" + (event.status || "unknown") + "] " + (event.name || ""));
            if (event.input) lines.push("[工具输入]\n" + indentTraceText(event.input));
            if (event.output) lines.push("[工具输出]\n" + indentTraceText(event.output));
        } else if (event.type === "usage") {
            const usage = event.usage || {};
            lines.push(
                "[用量] input=" + (usage.input_tokens ?? "?") +
                " cached=" + (usage.cached_input_tokens ?? "?") +
                " output=" + (usage.output_tokens ?? "?")
            );
        } else if (event.type === "error") {
            lines.push("[错误] " + (event.text || ""));
        } else if (event.type === "omitted") {
            lines.push("[省略] " + event.count + " 条中间轨迹");
        } else {
            lines.push("[事件:" + (event.itemType || event.type || "unknown") + "] " + (event.text || ""));
        }
    }
    return lines.join("\n");
}

function buildRawCodexTrace(filePath) {
    const lines = readCodexJsonlEvents(filePath)
        .map(event => JSON.stringify(stripReasoningFields(event)));
    let raw = redact(lines.join("\n"));
    if (raw.length > CFG.traceRawMaxChars) {
        raw = "[原始轨迹已截断，仅显示最后 " + CFG.traceRawMaxChars + " 字符]\n" +
            raw.slice(-CFG.traceRawMaxChars);
    }
    return raw;
}

function safeTraceField(value, maxChars = 128) {
    if (value === undefined || value === null) return null;
    return clipTraceText(value, maxChars) || null;
}

function parseAppServerExecutionTrace(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const events = [];
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let entry;
        try { entry = JSON.parse(trimmed); } catch { continue; }
        if (!entry || typeof entry !== "object" || entry.source !== "codex-app-server") continue;
        const params = entry.params && typeof entry.params === "object" ? entry.params : {};
        const event = {
            type: "appserver_event",
            method: safeTraceField(entry.method),
            threadId: safeTraceField(params.threadId),
            turnId: safeTraceField(params.turnId || params.turn?.id),
            itemId: safeTraceField(params.itemId),
            status: safeTraceField(params.status || params.turn?.status),
            length: Number.isFinite(Number(params.length)) ? Number(params.length) : null,
            sequence: events.length + 1
        };
        events.push(event);
    }
    return capTraceEvents(events);
}

function formatAppServerExecutionTrace(events) {
    return events.map(event => {
        const identity = [event.method, event.threadId, event.turnId]
            .filter(Boolean)
            .join(" ");
        const details = [event.status, event.itemId, event.length === null ? "" : `length=${event.length}`]
            .filter(Boolean)
            .join(" ");
        return `[app-server] ${identity}${details ? ` (${details})` : ""}`.trim();
    }).join("\n");
}

function buildRawAppServerTrace(filePath) {
    const raw = parseAppServerExecutionTrace(filePath)
        .map(event => JSON.stringify(event))
        .join("\n");
    if (raw.length <= CFG.traceRawMaxChars) return redact(raw);
    return "[原始轨迹已截断，仅显示最后 " + CFG.traceRawMaxChars + " 字符]\n" +
        redact(raw.slice(-CFG.traceRawMaxChars));
}

function normalizePatchTracePhase(meta) {
    const phase = String(meta?.jobPhase || "").trim().toLowerCase();
    if (["baseline-check", "running", "validating", "publishing", "completed", "failed"].includes(phase)) {
        return phase;
    }
    if (meta?.state === "completed") return "completed";
    if (["failed", "cancelled", "timeout"].includes(meta?.state)) return "failed";
    return "running";
}

function buildAppServerPatchTracePayload(meta, traceMode) {
    const payload = { traceMode };
    if (traceMode === "summary") return payload;
    const event = {
        type: "patch_phase",
        phase: normalizePatchTracePhase(meta),
        errorCode: meta?.errorCode ? String(meta.errorCode).slice(0, 80) : null,
        sequence: 1
    };
    if (traceMode === "raw") {
        return {
            ...payload,
            rawTrace: JSON.stringify(event),
            traceNote: "app-server patch raw 轨迹仅包含安全阶段与错误码。"
        };
    }
    return {
        ...payload,
        executionTrace: [event],
        traceText: `[patch] ${event.phase}${event.errorCode ? ` (${event.errorCode})` : ""}`,
        traceNote: "app-server patch events 轨迹仅包含安全阶段与错误码。"
    };
}

function normalizeSafeArtifactState(meta) {
    const state = String(meta?.state || "").trim().toLowerCase();
    return ["running", ...TERMINAL_STATES].includes(state) ? state : null;
}

function safeArtifactErrorCode(meta) {
    const errorCode = String(meta?.errorCode || "").trim();
    return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(errorCode) ? errorCode : null;
}

function safeArtifactTimestamp(value) {
    const timestamp = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(timestamp)
        ? timestamp
        : null;
}

function buildAmbiguousAppServerTracePayload(meta, traceMode) {
    const payload = { traceMode };
    if (traceMode === "summary") return payload;

    const event = {
        type: "artifact_state",
        state: normalizeSafeArtifactState(meta),
        phase: null,
        errorCode: safeArtifactErrorCode(meta),
        startedAt: safeArtifactTimestamp(meta?.startedAt),
        completedAt: safeArtifactTimestamp(meta?.completedAt),
        sequence: 1
    };
    if (traceMode === "raw") {
        return {
            ...payload,
            rawTrace: JSON.stringify(event),
            traceNote: "app-server 元数据分类不明确，已拒绝读取输出并仅返回安全状态字段。"
        };
    }
    return {
        ...payload,
        executionTrace: [event],
        traceText: `[app-server] state=${event.state || "unknown"}${event.errorCode ? ` (${event.errorCode})` : ""}`,
        traceNote: "app-server 元数据分类不明确，已拒绝读取输出并仅返回安全状态字段。"
    };
}

function buildTracePayload(jobId, meta, overrideMode = null) {
    const traceMode = normalizeTraceMode(overrideMode, meta?.traceMode || CFG.defaultTraceMode) || "summary";
    const payload = { traceMode };
    const artifactClass = classifyAppServerArtifactMeta(meta);

    if (artifactClass === "patch") {
        return buildAppServerPatchTracePayload(meta, traceMode);
    }
    if (artifactClass === "ambiguous") {
        return buildAmbiguousAppServerTracePayload(meta, traceMode);
    }

    if (traceMode === "summary") return payload;

    if (meta?.worker !== "codex") {
        return {
            ...payload,
            traceNote: "结构化执行轨迹目前仅支持 Codex JSONL Worker。"
        };
    }

    const p = jobPaths(jobId);
    if (artifactClass === "analyze") {
        if (traceMode === "raw") {
            return {
                ...payload,
                rawTrace: buildRawAppServerTrace(p.output),
                traceNote: "app-server raw 轨迹仅包含脱敏、限长的安全事件字段，不包含 delta、任务正文或内部推理。"
            };
        }
        const executionTrace = parseAppServerExecutionTrace(p.output);
        return {
            ...payload,
            executionTrace,
            traceText: formatAppServerExecutionTrace(executionTrace),
            traceNote: "app-server events 轨迹仅包含方法、会话/回合标识、状态和长度等安全字段。"
        };
    }
    if (traceMode === "raw") {
        return {
            ...payload,
            rawTrace: buildRawCodexTrace(p.output),
            traceNote: "raw 轨迹已脱敏、限长，并排除模型内部推理字段。"
        };
    }

    const executionTrace = parseCodexExecutionTrace(p.output);
    return {
        ...payload,
        executionTrace,
        traceText: formatExecutionTrace(executionTrace),
        traceNote: "events 轨迹仅包含阶段说明、命令、文件变更、工具结果和用量，不包含模型内部推理。"
    };
}

function buildResult(jobId, meta, traceModeOverride = null) {
    const p = jobPaths(jobId);
    const artifactClass = classifyAppServerArtifactMeta(meta);
    const writeJob = isAppServerWriteMeta(meta);
    const artifactProjection = writeJob
        ? buildWriteResultProjection(jobId, meta)
        : buildPatchArtifactProjection(jobId, meta);
    const canReadOutput = !writeJob && (artifactClass === "legacy" || artifactClass === "analyze");

    let output = "";
    // Codex 的 stdout 是 JSONL 事件流，直接从中提取报告会混入转义符和事件外壳。
    // 对 Codex 优先使用 --output-last-message 生成的纯文本最终报告；
    // 原始 JSONL 仍保留在 outputFile 中，供故障排查与完整审计。
    const preferredOutputPath = canReadOutput
        ? (meta?.worker === "codex" && fs.existsSync(p.codexOutput)
            ? p.codexOutput
            : p.output)
        : null;
    if (preferredOutputPath && fs.existsSync(preferredOutputPath)) {
        const raw = fs.readFileSync(preferredOutputPath, "utf8");
        const masked = redact(raw);
        output = masked.length > 50000
            ? "[输出已截断，仅显示最后 50000 字符]\n" + masked.slice(-50000)
            : masked;
    }

    let logSummary = "";
    if (canReadOutput && fs.existsSync(p.log)) {
        const rawLog = fs.readFileSync(p.log, "utf8");
        const ml = redact(rawLog);
        logSummary = ml.length > 5000 ? "[日志已截断]\n" + ml.slice(-5000) : ml;
    }

    // 提取【读取文件清单】→ fileReadList 字段，让 VCP AI 知道 opencode 读了哪些文件
    let fileReadList = "";
    if (output) {
        const frm = output.match(/【读取文件清单】[^\n]*/);
        if (frm) fileReadList = frm[0].trim();
    }

    // 摘要提取优先级：① summaryHint → ② 【执行结果摘要】锚点 → ③ 变更摘要等关键词 → ④ 尾部截取
    let summary = "";
    if (output) {
        const hint = meta && meta.summaryHint;
        if (hint) {
            const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            // 非贪婪匹配，遇到空行、【新节】或字符串结尾即停，避免截入无关内容
            const hm = output.match(new RegExp(escaped + "[\\s\\S]{0,250}?(?=\\n{2,}|【|$)", "i"));
            if (hm) summary = hm[0].slice(0, 220).trim();
        }
        if (!summary) {
            // 优先提取固定锚点（v1.5 报告规范强制输出）
            const anchor = output.match(/【执行结果摘要】[^\n]{1,200}/);
            if (anchor) summary = anchor[0].trim();
        }
        if (!summary) {
            const summaryMatch = output.match(/(?:变更摘要|执行结果|完成|总结|验证结果)[\s\S]{0,800}/i);
            summary = summaryMatch
                ? summaryMatch[0].slice(0, 400).trim()
                : output.replace(/^[\s\S]*?\n\n/, "").slice(-300).trim();
        }
    }

    const tracePayload = buildTracePayload(jobId, meta, traceModeOverride);

    return {
        status:      writeJob && ["unknown", "finalizationFailed"].includes(meta?.state) ? "error" : "success",
        jobId,
        state:       meta.state,
        exitCode:    meta.exitCode,
        startedAt:   meta.startedAt,
        completedAt: meta.completedAt,
        projectPath: meta.projectPath,
        mode:        meta.mode,
        jobKind:     meta?.jobKind || null,
        codexModel: meta.codexModel || null,
        codexModelSource:
            meta.codexModelSource || null,
        reasoningEffort: meta.reasoningEffort || null,
        reasoningEffortEffective:
            meta.reasoningEffortEffective ||
            meta.reasoningEffort ||
            null,
        reasoningEffortSource:
            meta.reasoningEffortSource ||
            (meta.worker === "codex"
                ? "legacy_unknown"
                : null),
        reasoningEffortSupported:
            meta.reasoningEffortSupported || [],
        modelDefaultReasoningEffort:
            meta.modelDefaultReasoningEffort || null,
        configuredReasoningEffort:
            meta.configuredReasoningEffort || null,
        fastMode:
            typeof meta.fastMode === "boolean" ? meta.fastMode : null,
        serviceTierOverride:
            meta.serviceTierOverride || null,
        fileReadList, // v1.5 新增：opencode 读了哪些文件
        summary,      // 优先锚点提取，比 v1.4 更准确
        output,
        logSummary,
        outputFile: p.output,
        logFile:    p.log,
        ...artifactProjection,
        codexOutputFile: fs.existsSync(p.codexOutput) ? p.codexOutput : null,
        ...executionMetaPayload(meta),
        ...tracePayload,
    };
}

function checkAndMarkDead(meta, jobId, source) {
    if (classifyAppServerArtifactMeta(meta) !== "legacy") return meta;
    if (meta.state === "running" && meta.pid && !isProcessRunning(meta.pid)) {
        const workerPid = meta.workerPid || meta.opencodePid;
        if (workerPid && isProcessRunning(workerPid)) {
            killProcessTreeSync(workerPid, true);
        }
        meta.state = "failed";
        meta.completedAt = new Date().toISOString();
        meta.exitReason = `runner 进程意外退出（${source} 检测）`;
        saveMeta(jobId, meta);
    }
    return meta;
}

/** 全局并发闸门：统计当前真正在跑的任务数，opencode/antigravity共用同一上限(不是各自算)。
 *  优化：只扫最近 100 个文件（按文件名倒序），已完成的旧job不可能再变 running，无需全量扫。
 *  2026-06-27崩服务器事故后加的硬保险——之前只在文档写"严禁并发"靠自觉，没有代码强制。 */
function countActiveJobs() {
    ensureJobDirs();
    const metaDir = path.join(CFG.jobRoot, "meta");
    let files = [];
    try {
        files = fs.readdirSync(metaDir)
            .filter(f => f.endsWith(".json") && !f.endsWith(".args.json"))
            .sort().reverse();
    }
    catch { return 0; }
    let count = 0;
    for (const file of files) {
        try {
            let m = JSON.parse(fs.readFileSync(path.join(metaDir, file), "utf8"));
            m = checkAndMarkDead(m, m.jobId, "concurrencyGuard");
            if (m.state === "running" && classifyAppServerArtifactMeta(m) === "legacy" &&
                (!m.executionBackend || m.executionBackend === LEGACY_BACKEND)) count++;
        } catch {}
    }
    return count;
}

function hasPathEntry(filePath) {
    try {
        fs.lstatSync(filePath);
        return true;
    } catch (error) {
        return error?.code !== "ENOENT";
    }
}

function recordPatchCleanupFailure(jobId, code) {
    const safeJobId = String(jobId || "unknown")
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 128);
    const safeCode = String(code || "AICW_PATCH_ARTIFACT_CLEANUP_FAILED").slice(0, 96);
    console.error(`[AICodeWorker] app-server patch cleanup skipped job=${safeJobId} code=${safeCode}`);
}

function removeAuthorizedAppServerPatch(jobId, meta, patchPath) {
    if (!hasPathEntry(patchPath)) {
        recordPatchCleanupFailure(jobId, "AICW_PATCH_PUBLIC_ARTIFACT_MISSING");
        return false;
    }

    let authorization;
    try {
        authorization = inspectAuthorizedPatchArtifact(CFG.jobRoot, jobId, meta);
    } catch {
        authorization = { authorized: false };
    }
    if (authorization?.authorized !== true) {
        recordPatchCleanupFailure(jobId, authorization?.code || "AICW_PATCH_PUBLIC_ARTIFACT_UNAUTHORIZED");
        return false;
    }

    let removed = false;
    try {
        removed = removePatchArtifactExact(patchPath, meta.patchArtifactDirectoryIdentity, {
            jobRoot: CFG.jobRoot,
            expectedIdentity: meta.patchArtifactPublicIdentity,
            expectedSha256: meta.patchSha256,
            expectedBytes: meta.patchBytes,
            failureCode: "AICW_PATCH_ARTIFACT_CLEANUP_FAILED"
        });
    } catch {}
    if (!removed) recordPatchCleanupFailure(jobId, "AICW_PATCH_ARTIFACT_CLEANUP_FAILED");
    return removed;
}

/** 清理旧 job 文件：删除超过 retainDays 天且状态非 running 的全部文件。
 *  在 listJobs 和 run 时触发，每次最多清理 maxClean 个，避免阻塞主流程。 */
function cleanupOldJobs(retainDays = 7, maxClean = 50) {
    const metaDir = path.join(CFG.jobRoot, "meta");
    let files = [];
    try { files = fs.readdirSync(metaDir).filter(f => f.endsWith(".json") && !f.endsWith(".args.json")); }
    catch { return; }
    const cutoff = Date.now() - retainDays * 86400 * 1000;
    const cleanLimit = Math.max(0, Number.isFinite(Number(maxClean)) ? Math.floor(Number(maxClean)) : 50);
    let cleaned = 0;
    for (const file of files) {
        if (cleaned >= cleanLimit) break;
        const metaPath = path.join(metaDir, file);
        try {
            const m = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            const metaFileJobId = file.slice(0, -".json".length);
            const artifactClass = classifyAppServerArtifactMeta(m);
            if (m?.jobId !== metaFileJobId) {
                if (artifactClass !== "legacy") {
                    recordPatchCleanupFailure(metaFileJobId || file, "AICW_PATCH_JOB_ID_MISMATCH");
                }
                continue;
            }
            if (artifactClass === "ambiguous") continue;
            const jobId = metaFileJobId;
            const appServerPatch = artifactClass === "patch";
            const appServerAnalyze = artifactClass === "analyze";
            if (appServerPatch && !TERMINAL_STATES.has(m.state)) continue;
            if (artifactClass === "legacy" && m.state === "running") continue; // 跑着的绝不清
            // 优先用 meta.startedAt（不受 rsync/cp 刷新 mtime），回落到文件 mtime
            const jobTime = m.startedAt ? new Date(m.startedAt).getTime() : fs.statSync(metaPath).mtimeMs;
            if (!Number.isFinite(jobTime) || jobTime > cutoff) continue;
            let p;
            try { assertJobId(jobId); p = jobPaths(jobId); } catch (error) {
                if (appServerPatch) recordPatchCleanupFailure(jobId || file, error?.code || "AICW_PATCH_JOB_ID_INVALID");
                continue;
            }
            if (appServerPatch && !removeAuthorizedAppServerPatch(jobId, m, p.patch)) continue;
            // app-server patch 的 public artifact 已由共享 verifier 精确删除；legacy 仍沿用原清理集合。
            const relatedFiles = appServerPatch || appServerAnalyze
                ? [metaPath, p.args, p.output, p.log, p.codexOutput]
                : [metaPath, p.args, p.output, p.log, p.patch, p.codexOutput];
            for (const fp of relatedFiles) {
                try { if (fp && fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
            }
            cleaned++;
        } catch {}
    }
}

// ─── 探活缓存 ─────────────────────────────────────────────────────────────────

async function checkOcVersion() {
    if (_ocVersionCache && (Date.now() - _ocVersionCache.ts) < 300000)
        return _ocVersionCache;
    const result = await new Promise(resolve => {
        const p = spawn(CFG.opencodeBin, ["--version"], {
            env: process.env, stdio: ["ignore", "pipe", "ignore"]
        });
        let ver = "";
        p.stdout.on("data", d => { ver += d.toString(); });
        p.on("close", code => resolve({ ok: code === 0, ver: ver.trim() }));
        p.on("error", () => resolve({ ok: false, ver: "" }));
    });
    _ocVersionCache = { ...result, ts: Date.now() };
    return _ocVersionCache;
}

async function checkCodexVersion() {
    if (_codexVersionCache && (Date.now() - _codexVersionCache.ts) < 300000)
        return _codexVersionCache;
    const result = await new Promise(resolve => {
        const p = spawn(CFG.codexBin, ["--version"], {
            env: process.env,
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true
        });
        let ver = "";
        p.stdout.on("data", d => { ver += d.toString(); });
        p.on("close", code => resolve({ ok: code === 0, ver: ver.trim() }));
        p.on("error", () => resolve({ ok: false, ver: "" }));
    });
    _codexVersionCache = { ...result, ts: Date.now() };
    return _codexVersionCache;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

let _agyVersionCache = null;
async function checkAgyVersion() {
    if (_agyVersionCache && (Date.now() - _agyVersionCache.ts) < 300000)
        return _agyVersionCache;
    const result = await new Promise(resolve => {
        const ap = spawn(CFG.agyBin, ["--version"], {
            env: { ...process.env, PATH: `${process.env.HOME || ""}/.local/bin:${process.env.PATH || ""}` },
            stdio: ["ignore", "pipe", "ignore"]
        });
        let ver = "";
        ap.stdout.on("data", d => { ver += d.toString(); });
        ap.on("close", code => resolve({ ok: code === 0, ver: ver.trim() }));
        ap.on("error", () => resolve({ ok: false, ver: "" }));
    });
    _agyVersionCache = { ...result, ts: Date.now() };
    return _agyVersionCache;
}

function compactWarnings(warnings) {
    if (!Array.isArray(warnings)) return [];
    return warnings.slice(0, 12).map(warning => {
        if (!warning || typeof warning !== "object") return { message: String(warning).slice(0, 300) };
        return {
            ...(warning.level ? { level: String(warning.level).slice(0, 32) } : {}),
            message: String(warning.message || "").slice(0, 300)
        };
    });
}

function compactStateSummary(meta) {
    const errorCode = String(meta?.errorCode || "").trim().slice(0, 80);
    if (meta?.state === "running") return "任务仍在运行；如需轨迹请调用 command=trace。";
    if (meta?.state === "timeout") return "任务等待超时，完整结果见 outputFile。";
    if (meta?.state === "cancelled") return "任务已取消，完整结果见 outputFile。";
    if (meta?.state === "failed") {
        return errorCode
            ? `任务执行失败（${errorCode}），完整结果见 outputFile。`
            : "任务执行失败，完整结果见 outputFile。";
    }
    if (meta?.state === "completed") return "任务已完成，完整结果见 outputFile。";
    return "任务状态未知，请查看 outputFile 或调用 command=trace。";
}

function isMachineCompactSummaryLine(line) {
    const text = String(line || "").trim();
    if (!text) return true;
    if (text.startsWith("【执行结果摘要】")) return true;
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") return true;
    } catch {}
    if (/^[\[{]/.test(text) || /[\]}],?$/.test(text)) return true;
    if (/"(?:type|item|command|aggregated_output|exit_code|status|sequence|requestId)"\s*:/.test(text)) return true;
    if (/(?:\\[rn"]){2,}|\\u001b|===\s*任务(?:超时|已手动取消)/i.test(text)) return true;
    return false;
}

function readCompactSummary(jobId, meta) {
    const artifactClass = classifyAppServerArtifactMeta(meta);
    if (artifactClass !== "legacy" && artifactClass !== "analyze") {
        return compactStateSummary(meta);
    }
    const p = jobPaths(jobId);
    const preferredOutputPath = meta?.worker === "codex" && fs.existsSync(p.codexOutput)
        ? p.codexOutput
        : p.output;
    if (!fs.existsSync(preferredOutputPath)) return compactStateSummary(meta);
    let output;
    try {
        const stat = fs.statSync(preferredOutputPath);
        const maxBytes = 12000;
        if (stat.size <= maxBytes) {
            output = fs.readFileSync(preferredOutputPath, "utf8");
        } else {
            const fd = fs.openSync(preferredOutputPath, "r");
            try {
                const buffer = Buffer.alloc(maxBytes);
                fs.readSync(fd, buffer, 0, maxBytes, Math.max(0, stat.size - maxBytes));
                output = buffer.toString("utf8");
            } finally {
                fs.closeSync(fd);
            }
        }
    } catch {
        return compactStateSummary(meta);
    }
    const masked = redact(output);
    const hint = meta?.summaryHint;
    if (hint) {
        const escaped = String(hint).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const hinted = masked.match(new RegExp(escaped + "[^\\n]{0,400}", "i"));
        if (hinted) return hinted[0].slice(0, 240).trim();
    }
    const anchors = [...masked.matchAll(/【执行结果摘要】[^\n]{1,500}/g)];
    for (let index = anchors.length - 1; index >= 0; index--) {
        const candidate = anchors[index][0].slice(0, 240).trim();
        const body = candidate.replace(/^【执行结果摘要】/, "");
        const meaningfulCharacters = body.match(/[\p{L}\p{N}]/gu) || [];
        if (meaningfulCharacters.length >= 4) return candidate;
    }

    if (meta?.state !== "completed") return compactStateSummary(meta);

    const readableLines = masked
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => !isMachineCompactSummaryLine(line));
    if (readableLines.length > 0) {
        return readableLines[readableLines.length - 1].slice(0, 240).trim();
    }
    return compactStateSummary(meta);
}

function isCodexAppServerPatchRoute(worker, mode) {
    return CFG.enableCodexAppServerPatch &&
        String(worker || "").trim().toLowerCase() === "codex" &&
        String(mode || "").trim().toLowerCase() === "patch";
}

function isAppServerPatchMeta(meta) {
    return classifyAppServerArtifactMeta(meta) === "patch";
}

function isAppServerWriteMeta(meta) {
    return Boolean(meta && typeof meta === "object" && !Array.isArray(meta) &&
        meta.mode === "write" && meta.jobKind === "write" &&
        (meta.executionBackend === APP_SERVER_BACKEND || meta.requestedExecutionBackend === APP_SERVER_BACKEND));
}

function safeWriteHash(value) {
    return /^[0-9a-f]{40,64}$/.test(String(value || "")) ? String(value) : null;
}

function safeWriteChangedFiles(value) {
    if (!Array.isArray(value)) return [];
    const allowedStatus = new Set(["A", "C", "D", "M", "R", "T", "U", "X", "B"]);
    const safePath = candidate => {
        if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 4096 ||
            candidate.includes("\0") || path.isAbsolute(candidate)) return null;
        const normalized = candidate.replace(/\\/g, "/");
        if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
        return normalized;
    };
    return value.slice(0, 256).map(entry => {
        const changedPath = safePath(entry?.path);
        const oldPath = entry?.oldPath === null || entry?.oldPath === undefined ? null : safePath(entry.oldPath);
        const status = allowedStatus.has(entry?.status) ? entry.status : null;
        if (!changedPath || !status || (entry?.oldPath != null && !oldPath)) return null;
        return {
            status,
            score: Number.isInteger(entry?.score) && entry.score >= 0 && entry.score <= 100 ? entry.score : null,
            path: changedPath,
            oldPath
        };
    }).filter(Boolean);
}

function buildWriteResultProjection(jobId, meta) {
    if (!isAppServerWriteMeta(meta)) return {};
    const worktreePath = typeof meta.worktreePath === "string" && path.isAbsolute(meta.worktreePath) &&
        path.basename(path.resolve(meta.worktreePath)) === jobId
        ? path.resolve(meta.worktreePath)
        : null;
    const worktreeBranch = meta.worktreeBranch === `vcp/aicw/${jobId}` ? meta.worktreeBranch : null;
    const worktreeRetained = Boolean(worktreePath && worktreeBranch && meta.worktreeLocked === true);
    const baseRevision = safeWriteHash(meta.baseHead);
    const resultCommit = safeWriteHash(meta.resultCommit);
    const candidateAvailable = Boolean(meta.state === "completed" && meta.validationPassed === true &&
        meta.candidateAvailable === true && baseRevision && resultCommit && worktreeRetained);
    const validationSteps = Array.isArray(meta.validationSteps)
        ? meta.validationSteps.slice(0, 64).map(step => ({
            name: typeof step?.name === "string" ? step.name.slice(0, 64) : "unknown",
            status: typeof step?.status === "string" ? step.status.slice(0, 32) : "unknown",
            exitCode: Number.isInteger(step?.exitCode) ? step.exitCode : null,
            timedOut: step?.timedOut === true
        }))
        : [];
    return {
        candidateAvailable,
        baseRevision,
        resultCommit: candidateAvailable ? resultCommit : null,
        changedFiles: candidateAvailable ? safeWriteChangedFiles(meta.changedFiles) : [],
        validation: {
            profile: typeof meta.validationProfile === "string" ? meta.validationProfile.slice(0, 64) : null,
            passed: meta.validationPassed === true,
            steps: validationSteps
        },
        worktreeRetained,
        worktreePath: worktreeRetained ? worktreePath : null,
        worktreeBranch: worktreeRetained ? worktreeBranch : null,
        worktreeLocked: worktreeRetained,
        writeErrorCode: typeof meta.errorCode === "string" && /^[A-Z0-9_-]{1,64}$/.test(meta.errorCode)
            ? meta.errorCode
            : null
    };
}

function buildPatchArtifactProjection(jobId, meta) {
    const artifactClass = classifyAppServerArtifactMeta(meta);
    if (artifactClass === "patch") {
        const p = jobPaths(jobId);
        let inspected = { authorized: false };
        try {
            inspected = inspectAuthorizedPatchArtifact(CFG.jobRoot, jobId, meta);
        } catch {}
        const authorized = inspected.authorized === true &&
            Number(meta?.patchContractVersion) === PATCH_CONTRACT_VERSION;
        const baseHead = authorized && /^[0-9a-f]{40,64}$/.test(String(meta?.baseHead || ""))
            ? String(meta.baseHead)
            : null;
        return {
            patchFile: authorized ? p.patch : null,
            patchAvailable: authorized,
            patchSha256: authorized ? inspected.patchSha256 : null,
            patchBytes: authorized ? inspected.patchBytes : null,
            patchFileCount: authorized ? inspected.patchFileCount : null,
            patchContractVersion: authorized ? PATCH_CONTRACT_VERSION : null,
            baseHead,
            baselineStable: authorized && meta.baselineStable === true,
            applyCheckPassed: authorized && meta.applyCheckPassed === true,
            patchValidated: authorized && meta.patchValidated === true,
            jobPhase: normalizePatchTracePhase(meta)
        };
    }
    if (artifactClass === "analyze" || artifactClass === "ambiguous") {
        return {
            patchFile: null,
            patchAvailable: false,
            patchSha256: null,
            patchBytes: null,
            patchFileCount: null,
            patchContractVersion: null,
            baseHead: null,
            baselineStable: false,
            applyCheckPassed: false,
            patchValidated: false,
            jobPhase: null
        };
    }
    const p = jobPaths(jobId);
    const patchFile = fs.existsSync(p.patch) ? p.patch : null;
    return { patchFile, patchAvailable: Boolean(patchFile) };
}

function buildCompactQueryResult(jobId, meta, options = {}) {
    const p = jobPaths(jobId);
    const artifactClass = classifyAppServerArtifactMeta(meta);
    const terminal = TERMINAL_STATES.has(meta?.state);
    let summary = options.summary;
    if (summary === undefined) summary = readCompactSummary(jobId, meta);
    const result = {
        status: isAppServerWriteMeta(meta) && ["unknown", "finalizationFailed"].includes(meta?.state)
            ? "error"
            : "success",
        jobId,
        state: meta?.state || "unknown",
        exitCode: meta?.exitCode ?? null,
        startedAt: meta?.startedAt || null,
        completedAt: meta?.completedAt || null,
        worker: meta?.worker || null,
        mode: meta?.mode || null,
        jobKind: meta?.jobKind || null,
        codexModel: meta?.codexModel || null,
        reasoningEffortEffective:
            meta?.reasoningEffortEffective || meta?.reasoningEffort || null,
        fastMode:
            typeof meta?.fastMode === "boolean" ? meta.fastMode : null,
        serviceTierOverride: meta?.serviceTierOverride || null,
        warnings: artifactClass === "legacy" ? compactWarnings(meta?.warnings) : [],
        summary: String(summary || "").slice(0, 240),
        outputFile: p.output,
        codexOutputFile: fs.existsSync(p.codexOutput) ? p.codexOutput : null,
        logFile: p.log,
        ...(isAppServerWriteMeta(meta)
            ? buildWriteResultProjection(jobId, meta)
            : buildPatchArtifactProjection(jobId, meta)),
        ...executionMetaPayload(meta),
        traceAvailable: fs.existsSync(p.output)
    };
    if (options.hint) result.hint = options.hint;
    return result;
}

function compactCapabilitiesResult(full) {
    const workers = Array.isArray(full.workers) ? full.workers : [];
    const codex = workers.find(worker => worker?.name === "codex") || {};
    return {
        status: "success",
        workers: workers.map(worker => worker?.name === "codex"
            ? {
                name: "codex",
                available: Boolean(worker.available),
                version: worker.version || "unknown",
                model: worker.model || null,
                modelSource: worker.modelSource || null,
                reasoningEfforts: Array.isArray(worker.reasoningEfforts)
                    ? worker.reasoningEfforts
                    : [],
                configuredReasoningEffort: worker.configuredReasoningEffort || null,
                reasoningEffortEffective: worker.reasoningEffortDefault || null,
                supportsPerTaskFastMode: worker.supportsPerTaskFastMode === true,
                fastModeOmittedBehavior: worker.fastModeOmittedBehavior || "inherit_codex_config",
                supportsAppServerPatch: worker.supportsAppServerPatch === true,
                supportsAppServerWrite: worker.supportsAppServerWrite === true
            }
            : { name: worker?.name || "unknown", available: Boolean(worker?.available) }),
        codexAppServerAnalyzeEnabled: Boolean(full.codexAppServerAnalyzeEnabled),
        codexAppServerPatchEnabled: Boolean(full.codexAppServerPatchEnabled),
        codexAppServerWriteEnabled: Boolean(full.codexAppServerWriteEnabled),
        codexAppServerWriteConfigured: Boolean(full.codexAppServerWriteConfigured),
        codexAppServerWriteRuntimeAvailable: Boolean(full.codexAppServerWriteRuntimeAvailable),
        legacyMaxConcurrentJobs: full.legacyMaxConcurrentJobs,
        appServerMaxConcurrentJobs: full.appServerMaxConcurrentJobs,
        appServerConcurrencyScope: "shared-analyze-patch-write",
        codexAppServerStatus: full.codexAppServerStatus || "unknown",
        codexAppServerActiveJobs: Number(full.codexAppServerActiveJobs || 0),
        codexAppServerErrorCode: full.codexAppServerErrorCode || null,
        codexAppServerPatchProtocolSupport:
            full.codexAppServerPatchProtocolSupport === true
                ? true
                : full.codexAppServerPatchProtocolSupport || false,
        codexAppServerWriteProtocolSupport:
            full.codexAppServerWriteProtocolSupport === true
                ? true
                : full.codexAppServerWriteProtocolSupport || false,
        codexAppServerWriteConfigurationErrorCode: full.codexAppServerWriteConfigurationErrorCode || null,
        codexAppServerWriteMaxConcurrency: 1,
        codexAppServerWriteValidationPolicy: full.codexAppServerWriteValidationPolicy || null,
        patchContractVersion: PATCH_CONTRACT_VERSION,
        patchMaxBytes: PATCH_MAX_BYTES,
        patchRepositoryPolicy: "clean-git-root",
        patchOperations: ["modify-existing-tracked-file"],
        configuredReasoningEffort: codex.configuredReasoningEffort || null,
        reasoningEffortEffective: codex.reasoningEffortDefault || null
    };
}

function inspectPatchProtocolSupport(inspection, patchRouteEnabled = true) {
    if (isPatchProtocolProof(inspection)) return true;
    if (inspection?.patchProtocolSupported === false) return false;
    return patchRouteEnabled ? "unknown" : false;
}

async function cmdCapabilities(input = {}) {
    const responseMode = normalizeResponseMode(input.responseMode, "full");
    if (!responseMode) {
        return { status: "error", error: "responseMode 不支持。可用: compact, full" };
    }
    let appServerInspection = {
        status: "disabled",
        activeJobs: 0,
        maxConcurrency: CFG.appServerMaxConcurrentJobs,
        instanceId: null,
        pid: null,
        errorCode: null,
        patchProtocolSupported: false,
        writeProtocolSupported: false,
        writeConfigured: false,
        writeConfigurationErrorCode: null,
        writeValidationPolicy: null
    };
    const appServerConfigured = CFG.enableCodexAppServerAnalyze || CFG.enableCodexAppServerPatch ||
        CFG.enableCodexAppServerWrite;
    if (appServerConfigured) {
        try {
            appServerInspection = await createSidecarClient().inspectNoStart();
        } catch (error) {
            appServerInspection = {
                status: "error",
                activeJobs: 0,
                maxConcurrency: CFG.appServerMaxConcurrentJobs,
                instanceId: null,
                pid: null,
                errorCode: error?.code || "SIDECAR_INSPECTION_FAILED",
                patchProtocolSupported: "unknown",
                writeProtocolSupported: "unknown",
                writeConfigured: false,
                writeConfigurationErrorCode: null,
                writeValidationPolicy: null
            };
        }
    }
    const ocOk = CFG.enableOpencode
        ? await checkOcVersion()
        : { ok: false, ver: "" };
    const codexOk = CFG.enableCodex
        ? await checkCodexVersion()
        : { ok: false, ver: "" };
    const agyOk = CFG.enableAntigravity
        ? await checkAgyVersion()
        : { ok: false, ver: "" };

    const requestedModel =
        typeof input?.model === "string"
            ? input.model.trim()
            : "";
    const codexCapabilities =
        resolveCodexModelCapabilities(requestedModel);
    const patchProtocolSupport = inspectPatchProtocolSupport(
        appServerInspection,
        CFG.enableCodexAppServerPatch
    );
    const writeProtocolSupport = isWriteProtocolProof(appServerInspection)
        ? true
        : appServerInspection?.writeProtocolSupported === false
            ? false
            : CFG.enableCodexAppServerWrite ? "unknown" : false;
    const writeConfigured = CFG.enableCodexAppServerWrite && writeProtocolSupport === true &&
        appServerInspection.writeConfigured === true;
    const writeRuntimeAvailable = writeConfigured && appServerInspection.status === "ready";

    const result = {
        status: "success",
        workers: [
            {
                name: "opencode",
                available: CFG.enableOpencode && ocOk.ok,
                version: ocOk.ver || "unknown",
                supportsRun: true,
                supportsJson: true,
                supportsSession: true,
                supportsAttachments: true,
                dangerousSkipEnabled: true,
                note: "auto-approve 恒启用(三种模式都加--dangerously-skip-permissions)：AICodeWorker是无人值守后台进程，没有交互通道，不加此参数遇到权限提示会卡死到超时。安全边界靠mode=write门槛+ALLOWED_PROJECT_ROOTS白名单把住，与此参数无关。"
            },
            {
                name: "codex",
                available: CFG.enableCodex && codexOk.ok,
                version: codexOk.ver || "unknown",
                supportsRun: true,
                supportsJson: true,
                supportsSession: false,
                supportsAttachments: true,
                supportsPerTaskModel: true,
                supportsPerTaskFastMode: true,
                fastModeOmittedBehavior: "inherit_codex_config",
                supportsLegacyExec: true,
                supportsAppServerAnalyze: CFG.enableCodexAppServerAnalyze,
                supportsAppServerPatch: CFG.enableCodexAppServerPatch && patchProtocolSupport === true,
                supportsAppServerWrite: writeRuntimeAvailable,
                legacyMaxConcurrentJobs: CFG.maxConcurrentJobs,
                appServerMaxConcurrentJobs: CFG.appServerMaxConcurrentJobs,
                sandboxModes: [
                    "read-only",
                    "workspace-write"
                ],
                model: codexCapabilities.model,
                modelSource: codexCapabilities.modelSource,
                modelDisplayName:
                    codexCapabilities.displayName,
                reasoningCapabilitiesVerified:
                    codexCapabilities.reasoningCapabilitiesVerified,
                reasoningEfforts:
                    codexCapabilities.supportedReasoningEfforts,
                reasoningEffortDetails:
                    codexCapabilities.supportedReasoningLevels,
                modelDefaultReasoningEffort:
                    codexCapabilities.modelDefaultReasoningEffort,
                configuredReasoningEffort:
                    codexCapabilities.configuredReasoningEffort,
                reasoningEffortDefault:
                    codexCapabilities.effectiveReasoningEffort,
                reasoningEffortDefaultSource:
                    codexCapabilities.effectiveReasoningEffortSource,
                reasoningCapabilitiesSource:
                    "Codex models_cache.json",
                modelsCacheClientVersion:
                    codexCapabilities.cache.clientVersion,
                modelsCacheFetchedAt:
                    codexCapabilities.cache.fetchedAt,
                note: CFG.enableCodex
                    ? (
                        "Codex CLI：推理档位按实际模型从 models_cache.json 动态读取；" +
                        "analyze/patch 使用 read-only，write 使用 workspace-write；" +
                        "不会绕过原生沙箱。ultra 可能启用自动任务委托并显著增加使用量。"
                    )
                    : "未启用（ENABLE_CODEX=false）。"
            },
            {
                name: "antigravity",
                available:
                    CFG.enableAntigravity && agyOk.ok,
                version: agyOk.ver || "unknown",
                note: CFG.enableAntigravity
                    ? "复杂/严谨任务专用 · Gemini Pro 配额(约1500/天) · worker:antigravity 调用"
                    : "未启用(ENABLE_ANTIGRAVITY=false),复杂任务需在 config.env 开启"
            },
            {
                name: "mimocode",
                available: false,
                note: "adapter 预留，暂未实现"
            }
        ],
        codexAppServerAnalyzeEnabled: CFG.enableCodexAppServerAnalyze,
        codexAppServerPatchEnabled: CFG.enableCodexAppServerPatch,
        codexAppServerWriteEnabled: CFG.enableCodexAppServerWrite,
        codexAppServerWriteConfigured: writeConfigured,
        codexAppServerWriteRuntimeAvailable: writeRuntimeAvailable,
        legacyMaxConcurrentJobs: CFG.maxConcurrentJobs,
        appServerMaxConcurrentJobs: CFG.appServerMaxConcurrentJobs,
        appServerConcurrencyScope: "shared-analyze-patch-write",
        patchContractVersion: PATCH_CONTRACT_VERSION,
        patchMaxBytes: PATCH_MAX_BYTES,
        patchRepositoryPolicy: "clean-git-root",
        patchOperations: ["modify-existing-tracked-file"],
        codexAppServerPatchProtocolSupport: patchProtocolSupport,
        codexAppServerWriteProtocolSupport: writeProtocolSupport,
        codexAppServerWriteConfigurationErrorCode: appServerInspection.writeConfigurationErrorCode || null,
        codexAppServerWriteMaxConcurrency: 1,
        codexAppServerWriteWorkspacePolicy: appServerInspection.writeWorkspacePolicy || null,
        codexAppServerWriteValidationPolicy: appServerInspection.writeValidationPolicy || null,
        codexAppServerStatus: appServerConfigured
            ? (appServerInspection.status || "error")
            : "disabled",
        codexAppServerObservedState: appServerConfigured
            ? (appServerInspection.status || "error")
            : "disabled",
        codexAppServerActiveJobs: Number(appServerInspection.activeJobs || 0),
        codexAppServerInstanceId: appServerInspection.instanceId || null,
        codexAppServerPid: appServerInspection.pid || null,
        codexAppServerErrorCode: appServerInspection.errorCode || null
    };
    return responseMode === "compact" ? compactCapabilitiesResult(result) : result;
}

function normalizeRunRequest(input = {}) {
    if (!input || typeof input !== "object") {
        return { status: "error", error: "请求必须是 JSON 对象。" };
    }
    let prepared = input;
    if (input.preset) {
        const presetResult = applyPreset(input);
        if (presetResult && presetResult.status === "error") return presetResult;
        if (presetResult) prepared = presetResult;
    }

    const {
        worker = "opencode",
        projectPath,
        task,
        mode = "analyze",
        attachments = [],
        timeoutSec,
        summaryHint,
        model,
        traceMode,
        reasoningEffort,
        fastMode
    } = prepared;
    if (!task) {
        return { status: "error", error: "task 是必填参数。若要快速上手可使用 preset 参数，例如：preset=index, targetPath=/path/to/file.js" };
    }
    if (task.length > CFG.maxTaskChars) {
        return { status: "error", error: `task 超出最大长度 ${CFG.maxTaskChars} 字符。` };
    }
    const normalizedTraceMode = normalizeTraceMode(traceMode, CFG.defaultTraceMode);
    if (!normalizedTraceMode) {
        return { status: "error", error: "traceMode 不支持。可用: summary, events, raw" };
    }
    const pathErr = validatePath(projectPath);
    if (pathErr) return { status: "error", error: pathErr };

    const requestedWorker = String(worker || "opencode").trim().toLowerCase();
    const normWorker = requestedWorker === "agy" ? "antigravity" : requestedWorker;
    if (!["opencode", "codex", "antigravity"].includes(normWorker)) {
        return { status: "error", error: `worker "${worker}" 不支持。可用: opencode, codex, antigravity` };
    }
    const normalizedMode = String(mode).trim().toLowerCase();
    if (!RUN_MODES.has(normalizedMode)) {
        return {
            status: "error",
            error: `mode "${String(mode)}" 不支持。可用: analyze, patch, write`,
            errorCode: "AICW_INVALID_MODE"
        };
    }
    const normalizedAttachments = attachments === undefined ? [] : attachments;
    if (!Array.isArray(normalizedAttachments)) {
        return { status: "error", error: "attachments 必须是数组。" };
    }

    const fastModeResult = normalizeFastMode(fastMode);
    if (fastModeResult.status === "error") return fastModeResult;
    if (fastModeResult.provided && normWorker !== "codex") {
        return {
            status: "error",
            error: "fastMode 仅支持 worker=codex；其他 Worker 请移除此参数。"
        };
    }

    const reasoningEffortProvided = reasoningEffort !== undefined &&
        reasoningEffort !== null && String(reasoningEffort).trim() !== "";
    const normalizedReasoningEffort = reasoningEffortProvided
        ? String(reasoningEffort).trim().toLowerCase()
        : null;
    if (normalizedReasoningEffort && normWorker !== "codex") {
        return {
            status: "error",
            error: "reasoningEffort 仅支持 worker=codex；其他 Worker 请移除此参数。"
        };
    }

    const codexCapabilities = normWorker === "codex"
        ? resolveCodexModelCapabilities(model)
        : null;
    if (normalizedReasoningEffort) {
        if (!codexCapabilities?.model) {
            return {
                status: "error",
                error: "无法确定本次 Codex 实际模型，不能安全覆盖 reasoningEffort。请指定 model，或检查 Codex 配置。"
            };
        }
        if (!codexCapabilities.reasoningCapabilitiesVerified) {
            return {
                status: "error",
                error: `无法从 Codex models_cache.json 验证模型 "${codexCapabilities.model}" 的推理档位，已拒绝盲传 reasoningEffort。请先刷新 Codex 模型缓存，或移除此参数。`
            };
        }
        if (!codexCapabilities.supportedReasoningEfforts.includes(normalizedReasoningEffort)) {
            return {
                status: "error",
                error: `模型 "${codexCapabilities.model}" 不支持 reasoningEffort="${normalizedReasoningEffort}"。可用: ${codexCapabilities.supportedReasoningEfforts.join(", ")}`
            };
        }
    }

    const result = {
        status: "success",
        prepared: {
            ...prepared,
            worker: normWorker,
            mode: normalizedMode,
            attachments: normalizedAttachments,
            timeoutSec,
            summaryHint,
            model,
            normalizedTraceMode,
            normalizedReasoningEffort,
            normalizedFastMode: fastModeResult.value,
            serviceTierOverride: fastModeResult.serviceTier,
            codexCapabilities,
            reasoningMetadata: buildReasoningMetadata(
                normWorker,
                normalizedReasoningEffort,
                codexCapabilities
            )
        }
    };
    return result;
}

function appServerSubmissionResult(jobId, meta) {
    const artifactClass = classifyAppServerArtifactMeta(meta);
    if (TERMINAL_STATES.has(meta?.state)) {
        const result = buildResult(jobId, meta);
        result.warnings = artifactClass === "legacy" ? (meta.warnings || []) : [];
        return result;
    }
    const p = jobPaths(jobId);
    return {
        status: "success",
        jobId,
        state: meta?.state || "running",
        pid: meta?.pid || null,
        traceMode: meta?.traceMode || CFG.defaultTraceMode,
        codexModel: meta?.codexModel || null,
        codexModelSource: meta?.codexModelSource || null,
        reasoningEffort: meta?.reasoningEffort || null,
        reasoningEffortEffective: meta?.reasoningEffortEffective || null,
        reasoningEffortSource: meta?.reasoningEffortSource || null,
        reasoningEffortSupported: meta?.reasoningEffortSupported || [],
        modelDefaultReasoningEffort: meta?.modelDefaultReasoningEffort || null,
        configuredReasoningEffort: meta?.configuredReasoningEffort || null,
        fastMode:
            typeof meta?.fastMode === "boolean" ? meta.fastMode : null,
        serviceTierOverride: meta?.serviceTierOverride || null,
        warnings: artifactClass === "legacy" ? (meta?.warnings || []) : [],
        outputFile: p.output,
        logFile: p.log,
        ...(isAppServerWriteMeta(meta)
            ? buildWriteResultProjection(jobId, meta)
            : artifactClass === "legacy"
                ? { patchFile: null }
                : buildPatchArtifactProjection(jobId, meta)),
        codexOutputFile: fs.existsSync(p.codexOutput) ? p.codexOutput : null,
        ...executionMetaPayload(meta),
        message: `任务已提交。使用 query 命令查询进度：command=query, jobId=${jobId}`
    };
}

function isAppServerSubmissionConfirmed(meta) {
    return meta?.submissionState === "accepted" ||
        meta?.executionBackend === APP_SERVER_BACKEND ||
        Boolean(meta?.turnId) ||
        TERMINAL_STATES.has(meta?.state);
}

async function updateAppServerMeta(jobId, metaPath, fallbackMeta, updater) {
    try {
        const update = await updateJobMetaLocked(CFG.jobRoot, jobId, metaPath, updater);
        return update.meta || readMeta(jobId) || fallbackMeta;
    } catch {
        return readMeta(jobId) || fallbackMeta;
    }
}

function buildAppServerMeta(jobId, p, prepared, projectPath, timeoutS) {
    return {
        jobId,
        state: "running",
        pid: null,
        workerPid: null,
        worker: "codex",
        mode: "analyze",
        projectPath,
        startedAt: new Date().toISOString(),
        timeoutSec: timeoutS,
        traceMode: prepared.normalizedTraceMode,
        summaryHint: prepared.summaryHint || null,
        warnings: [...preflightCheck(prepared.task, "analyze"), ...checkFileSizes(prepared.task)],
        requestedExecutionBackend: APP_SERVER_BACKEND,
        submissionState: "prepared",
        metaRevision: 0,
        exitCode: null,
        completedAt: null,
        codexModel: prepared.reasoningMetadata.codexModel,
        codexModelSource: prepared.reasoningMetadata.codexModelSource,
        reasoningEffort: prepared.reasoningMetadata.reasoningEffort,
        reasoningEffortEffective: prepared.reasoningMetadata.reasoningEffortEffective,
        reasoningEffortSource: prepared.reasoningMetadata.reasoningEffortSource,
        reasoningEffortSupported: prepared.reasoningMetadata.reasoningEffortSupported,
        modelDefaultReasoningEffort: prepared.reasoningMetadata.modelDefaultReasoningEffort,
        configuredReasoningEffort: prepared.reasoningMetadata.configuredReasoningEffort,
        fastMode: prepared.normalizedFastMode,
        serviceTierOverride: prepared.serviceTierOverride,
        output: p.output,
        log: p.log,
        patch: p.patch,
        codexOutput: p.codexOutput
    };
}

function buildAppServerPatchMeta(jobId, p, prepared, projectPath, timeoutS) {
    return {
        jobId,
        state: "running",
        pid: null,
        workerPid: null,
        worker: "codex",
        mode: "patch",
        jobKind: "patch",
        patchContractVersion: PATCH_CONTRACT_VERSION,
        jobPhase: "prepared",
        projectPath,
        startedAt: new Date().toISOString(),
        timeoutSec: timeoutS,
        traceMode: prepared.normalizedTraceMode,
        summaryHint: prepared.summaryHint || null,
        warnings: [...preflightCheck(prepared.task, "patch"), ...checkFileSizes(prepared.task)],
        requestedExecutionBackend: APP_SERVER_BACKEND,
        submissionState: "prepared",
        patchValidated: false,
        applyCheckPassed: false,
        baselineStable: false,
        patchAvailable: false,
        metaRevision: 0,
        exitCode: null,
        completedAt: null,
        codexModel: prepared.reasoningMetadata.codexModel,
        codexModelSource: prepared.reasoningMetadata.codexModelSource,
        reasoningEffort: prepared.reasoningMetadata.reasoningEffort,
        reasoningEffortEffective: prepared.reasoningMetadata.reasoningEffortEffective,
        reasoningEffortSource: prepared.reasoningMetadata.reasoningEffortSource,
        reasoningEffortSupported: prepared.reasoningMetadata.reasoningEffortSupported,
        modelDefaultReasoningEffort: prepared.reasoningMetadata.modelDefaultReasoningEffort,
        configuredReasoningEffort: prepared.reasoningMetadata.configuredReasoningEffort,
        fastMode: prepared.normalizedFastMode,
        serviceTierOverride: prepared.serviceTierOverride,
        output: p.output,
        log: p.log,
        patch: p.patch,
        codexOutput: p.codexOutput
    };
}

function buildAppServerWriteMeta(jobId, p, prepared, projectPath, timeoutS) {
    return {
        jobId,
        state: "running",
        pid: null,
        workerPid: null,
        worker: "codex",
        mode: "write",
        jobKind: "write",
        jobPhase: "prepared",
        projectPath,
        startedAt: new Date().toISOString(),
        timeoutSec: timeoutS,
        traceMode: prepared.normalizedTraceMode,
        summaryHint: prepared.summaryHint || null,
        warnings: [...preflightCheck(prepared.task, "write"), ...checkFileSizes(prepared.task)],
        requestedExecutionBackend: APP_SERVER_BACKEND,
        submissionState: "prepared",
        validationPassed: false,
        candidateAvailable: false,
        metaRevision: 0,
        exitCode: null,
        completedAt: null,
        codexModel: prepared.reasoningMetadata.codexModel,
        codexModelSource: prepared.reasoningMetadata.codexModelSource,
        reasoningEffort: prepared.reasoningMetadata.reasoningEffort,
        reasoningEffortEffective: prepared.reasoningMetadata.reasoningEffortEffective,
        reasoningEffortSource: prepared.reasoningMetadata.reasoningEffortSource,
        reasoningEffortSupported: prepared.reasoningMetadata.reasoningEffortSupported,
        modelDefaultReasoningEffort: prepared.reasoningMetadata.modelDefaultReasoningEffort,
        configuredReasoningEffort: prepared.reasoningMetadata.configuredReasoningEffort,
        fastMode: prepared.normalizedFastMode,
        serviceTierOverride: prepared.serviceTierOverride,
        output: p.output,
        log: p.log,
        codexOutput: p.codexOutput
    };
}

function bestEffortRemoveAppServerInitFiles(paths, unlink = fs.unlinkSync) {
    for (const filePath of [paths.output, paths.log, paths.codexOutput]) {
        try { unlink(filePath); } catch {}
    }
}

async function initializeAppServerJob(jobId, paths, meta, dependencies = {}) {
    const lock = dependencies.withJobMetaLock || withJobMetaLock;
    const createExclusive = dependencies.createJsonExclusive || createJsonExclusive;
    const writeFile = dependencies.writeFileSync || ((filePath, contents) => {
        fs.writeFileSync(filePath, contents, "utf8");
    });
    const writeMeta = dependencies.writeJsonAtomic || writeJsonAtomic;
    const unlink = dependencies.unlinkSync || fs.unlinkSync;
    const patchJob = meta?.jobKind === "patch";
    const writeJob = meta?.jobKind === "write";
    const initErrorCode = patchJob
        ? "AICW_APP_SERVER_PATCH_META_FAILED"
        : writeJob
            ? "AICW_APP_SERVER_WRITE_META_FAILED"
            : "AICW_APP_SERVER_META_INIT_FAILED";
    const finalizationErrorCode = patchJob
        ? "AICW_APP_SERVER_PATCH_META_FINALIZATION_FAILED"
        : writeJob
            ? "AICW_APP_SERVER_WRITE_META_FINALIZATION_FAILED"
            : "AICW_APP_SERVER_META_FINALIZATION_FAILED";

    return lock(CFG.jobRoot, jobId, async () => {
        createExclusive(paths.meta, meta);
        let persistedMeta = meta;
        try {
            writeFile(paths.output, "");
            writeFile(paths.log, "");
            writeFile(paths.codexOutput, "");
            const submittingMeta = {
                ...persistedMeta,
                submissionState: "submitting",
                metaRevision: Number(persistedMeta.metaRevision || 0) + 1
            };
            writeMeta(paths.meta, submittingMeta);
            persistedMeta = submittingMeta;
            return { status: "ready", meta: persistedMeta };
        } catch (error) {
            const terminalMeta = {
                ...persistedMeta,
                state: "failed",
                submissionState: "rejected",
                completedAt: new Date().toISOString(),
                exitCode: 1,
                errorCode: initErrorCode,
                metaRevision: Number(persistedMeta.metaRevision || 0) + 1
            };
            let terminalPersisted = false;
            try {
                writeMeta(paths.meta, terminalMeta);
                terminalPersisted = true;
            } catch (terminalError) {
                let metaDeleted = false;
                try {
                    unlink(paths.meta);
                    metaDeleted = !fs.existsSync(paths.meta);
                } catch {}
                bestEffortRemoveAppServerInitFiles(paths, unlink);
                return {
                    status: "finalization-failed",
                    error,
                    terminalError,
                    metaDeleted,
                    errorCode: finalizationErrorCode
                };
            }
            if (terminalPersisted) bestEffortRemoveAppServerInitFiles(paths, unlink);
            return { status: "failed", error, meta: terminalMeta };
        }
    });
}

async function cmdRunAppServerAnalyze(prepared, dependencies = {}) {
    if (!CFG.enableCodex) {
        return { status: "error", error: "Codex 已被禁用（ENABLE_CODEX=false）。" };
    }
    if (prepared.sessionId) {
        return { status: "error", error: "Codex app-server 第一版不接受 sessionId；长期上下文应由 VCP/RAG 注入任务书。" };
    }
    if (prepared.attachments.length > 0) {
        return appServerErrorResult(null, {
            error: "Codex app-server analyze 第一版不支持附件。",
            errorCode: "AICW_APPSERVER_ATTACHMENTS_UNSUPPORTED"
        });
    }

    const client = dependencies.client || createSidecarClient();
    let beforeInspection;
    try {
        beforeInspection = await client.inspectNoStart();
    } catch (error) {
        beforeInspection = { status: "error", errorCode: error?.code || "SIDECAR_INSPECTION_FAILED" };
    }

    let sidecarState;
    try {
        sidecarState = await client.ensure();
    } catch (error) {
        let afterInspection;
        try {
            afterInspection = await client.reconcileDeadInstance();
        } catch (reconcileError) {
            afterInspection = {
                status: "error",
                errorCode: reconcileError?.code || "SIDECAR_RECONCILIATION_FAILED"
            };
        }
        if (shouldFallbackToLegacyBeforeJob(error, beforeInspection, afterInspection, {
            jobCreated: false,
            hasAppServerMeta: false
        })) {
            return cmdRunLegacy(prepared, String(error.code));
        }
        return appServerErrorResult(error, {
            error: "Codex app-server 当前不可用，未创建任务。",
            errorCode: "AICW_APP_SERVER_UNAVAILABLE",
            state: afterInspection?.status || beforeInspection?.status || "error"
        });
    }

    if (prepared.serviceTierOverride &&
        sidecarState?.serviceTierOverrideProtocolVersion !== SERVICE_TIER_OVERRIDE_PROTOCOL_VERSION) {
        return appServerErrorResult(null, {
            error: "当前 Sidecar 不支持显式逐任务档位覆盖，未创建 Job；请受控更新 Sidecar 实例后重试。",
            errorCode: SERVICE_TIER_SIDECAR_UNSUPPORTED
        });
    }

    ensureJobDirs();
    const timeoutS = Number(prepared.timeoutSec) || CFG.defaultTimeout;
    const projectPath = path.resolve(prepared.projectPath);
    let jobId;
    let p;
    let meta;
    let initialized;

    for (let attempt = 0; attempt < 8 && !initialized; attempt++) {
        jobId = generateJobId();
        p = jobPaths(jobId);
        meta = buildAppServerMeta(jobId, p, prepared, projectPath, timeoutS);
        try {
            initialized = await initializeAppServerJob(jobId, p, meta, dependencies);
            if (initialized.status === "failed" || initialized.status === "finalization-failed") break;
        } catch (error) {
            if (error?.code === "META_ALREADY_EXISTS" && attempt < 7) continue;
            if (error?.code === "META_CREATE_FINALIZATION_FAILED") {
                return appServerErrorResult(error, {
                    error: "Codex app-server 任务元数据创建失败，临时文件无法可靠清理。",
                    errorCode: "AICW_APP_SERVER_META_FINALIZATION_FAILED",
                    jobId,
                    state: "unknown",
                    metaDeleted: !fs.existsSync(p.meta),
                    finalizationError: error.code
                });
            }
            return appServerErrorResult(error, {
                error: "Codex app-server 任务元数据初始化失败。",
                errorCode: error?.code === "META_ALREADY_EXISTS"
                    ? "AICW_APP_SERVER_META_COLLISION"
                    : "AICW_APP_SERVER_META_FAILED",
                jobId,
                state: "failed"
            });
        }
    }

    if (!initialized || initialized.status === "failed" || initialized.status === "finalization-failed") {
        if (initialized?.status === "finalization-failed") {
            return appServerErrorResult(initialized.terminalError || initialized.error, {
                error: "Codex app-server 任务元数据初始化失败，终态无法可靠落盘。",
                errorCode: initialized.errorCode,
                jobId,
                state: "unknown",
                metaDeleted: initialized.metaDeleted,
                finalizationError: initialized.errorCode
            });
        }
        return appServerErrorResult(initialized?.error, {
            error: "Codex app-server 任务元数据初始化失败。",
            errorCode: "AICW_APP_SERVER_META_INIT_FAILED",
            jobId,
            state: "failed",
            submissionState: "rejected",
            completedAt: initialized?.meta?.completedAt || null
        });
    }
    meta = initialized.meta;

    let submitted;
    try {
        submitted = await client.submitAnalyzeJob({
            jobId,
            projectPath,
            text: wrapTask(prepared.task, "analyze"),
            metaPath: p.meta,
            outputPath: p.output,
            codexOutputPath: p.codexOutput,
            timeoutSec: timeoutS,
            model: prepared.codexCapabilities?.model || undefined,
            effort: prepared.normalizedReasoningEffort || undefined,
            ...(prepared.serviceTierOverride
                ? { serviceTier: prepared.serviceTierOverride }
                : {})
        });
    } catch (error) {
        let current = readMeta(jobId) || meta;
        if (isAppServerSubmissionUnknown(error)) {
            if (isAppServerSubmissionConfirmed(current)) return appServerSubmissionResult(jobId, current);
            current = await updateAppServerMeta(jobId, p.meta, current, value => {
                if (isAppServerSubmissionConfirmed(value)) return undefined;
                value.submissionState = "unknown";
                value.state = "running";
                value.errorCode = "AICW_APP_SERVER_SUBMISSION_UNKNOWN";
                return value;
            });
            return appServerErrorResult(error, {
                error: "Codex app-server 提交结果未知，已保留原任务。",
                errorCode: "AICW_APP_SERVER_SUBMISSION_UNKNOWN",
                jobId,
                state: current.state || "running"
            });
        }

        const mappedCode = error?.code === "CONCURRENCY_LIMIT"
            ? "AICW_APP_SERVER_CONCURRENCY_LIMIT"
            : error?.code === SERVICE_TIER_SIDECAR_UNSUPPORTED
                ? SERVICE_TIER_SIDECAR_UNSUPPORTED
                : "AICW_APP_SERVER_SUBMISSION_REJECTED";
        current = await updateAppServerMeta(jobId, p.meta, current, value => {
            if (isAppServerSubmissionConfirmed(value)) return undefined;
            value.state = "failed";
            value.submissionState = "rejected";
            value.completedAt = new Date().toISOString();
            value.exitCode = 1;
            value.errorCode = mappedCode;
            return value;
        });
        return appServerErrorResult(error, {
            error: mappedCode === SERVICE_TIER_SIDECAR_UNSUPPORTED
                ? "提交前检测到 Sidecar 实例不支持显式逐任务档位覆盖；已有 Job 已确定失败，请受控更新 Sidecar 实例。"
                : "Codex app-server 提交被拒绝。",
            errorCode: mappedCode,
            jobId,
            state: current.state || "failed"
        });
    }

    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted) ||
        typeof submitted.accepted !== "boolean") {
        const invalidSubmission = new SidecarError(
            "INVALID_SIDECAR_RESPONSE",
            "Sidecar submit response is missing a boolean accepted field"
        );
        let current = readMeta(jobId) || meta;
        if (isAppServerSubmissionConfirmed(current)) return appServerSubmissionResult(jobId, current);
        current = await updateAppServerMeta(jobId, p.meta, current, value => {
            if (isAppServerSubmissionConfirmed(value)) return undefined;
            value.submissionState = "unknown";
            value.state = "running";
            value.errorCode = "AICW_APP_SERVER_SUBMISSION_UNKNOWN";
            return value;
        });
        return appServerErrorResult(invalidSubmission, {
            error: "Codex app-server 提交响应畸形，结果未知，已保留原任务。",
            errorCode: "AICW_APP_SERVER_SUBMISSION_UNKNOWN",
            jobId,
            state: current.state || "running"
        });
    }

    let current = readMeta(jobId) || meta;
    if (submitted?.accepted === false) {
        if (isAppServerSubmissionConfirmed(current)) return appServerSubmissionResult(jobId, current);
        const mappedCode = submitted.errorCode === "CONCURRENCY_LIMIT"
            ? "AICW_APP_SERVER_CONCURRENCY_LIMIT"
            : "AICW_APP_SERVER_SUBMISSION_REJECTED";
        current = await updateAppServerMeta(jobId, p.meta, current, value => {
            if (isAppServerSubmissionConfirmed(value)) return undefined;
            value.state = "failed";
            value.submissionState = "rejected";
            value.completedAt = new Date().toISOString();
            value.exitCode = 1;
            value.errorCode = mappedCode;
            return value;
        });
        return appServerErrorResult(null, {
            error: "Codex app-server 提交被拒绝。",
            errorCode: mappedCode,
            jobId,
            state: current.state || "failed"
        });
    }
    return appServerSubmissionResult(jobId, current);
}

async function persistAppServerPatchSubmissionOutcome(jobId, metaPath, fallbackMeta, outcome, dependencies = {}) {
    const update = dependencies.updateJobMetaLocked || updateJobMetaLocked;
    let confirmedBeforeUpdate = false;
    try {
        const result = await update(CFG.jobRoot, jobId, metaPath, value => {
            if (isAppServerSubmissionConfirmed(value)) {
                confirmedBeforeUpdate = true;
                return {};
            }
            value.submissionState = outcome.submissionState;
            value.errorCode = outcome.errorCode;
            value.jobPhase = outcome.state === "running" ? "running" : "failed";
            value.patchAvailable = false;
            value.patchValidated = false;
            value.applyCheckPassed = false;
            value.baselineStable = false;
            if (outcome.state !== "running") {
                value.state = "failed";
                value.completedAt = new Date().toISOString();
                value.exitCode = 1;
            }
            return value;
        });
        return {
            status: "success",
            meta: result?.meta || readMeta(jobId) || fallbackMeta,
            confirmedBeforeUpdate
        };
    } catch (error) {
        return {
            status: "error",
            error,
            meta: readMeta(jobId) || fallbackMeta
        };
    }
}

async function cmdRunAppServerPatch(prepared, dependencies = {}) {
    if (!CFG.enableCodexAppServerPatch) {
        return appServerErrorResult(null, {
            error: "Codex app-server patch 未启用。",
            errorCode: "AICW_APP_SERVER_PATCH_UNAVAILABLE"
        });
    }
    if (!CFG.enableCodex) {
        return appServerErrorResult(null, {
            error: "Codex 已被禁用（ENABLE_CODEX=false）。",
            errorCode: "AICW_APP_SERVER_PATCH_UNAVAILABLE"
        });
    }
    if (prepared.sessionId) {
        return appServerErrorResult(null, {
            error: "Codex app-server patch 第一版不接受 sessionId。",
            errorCode: "AICW_APP_SERVER_PATCH_SESSION_UNSUPPORTED"
        });
    }
    if (prepared.attachments.length > 0) {
        return appServerErrorResult(null, {
            error: "Codex app-server patch 第一版不支持附件。",
            errorCode: "AICW_APP_SERVER_PATCH_ATTACHMENTS_UNSUPPORTED"
        });
    }

    const patchModel = prepared.reasoningMetadata.codexModel;
    const patchEffort = prepared.reasoningMetadata.reasoningEffortEffective;
    if (!patchModel || !patchEffort || !PATCH_REASONING_EFFORTS.has(patchEffort)) {
        return appServerErrorResult(null, {
            error: "Codex app-server patch 需要可验证的 model 与 minimal/low/medium/high/xhigh reasoning effort。",
            errorCode: "AICW_APP_SERVER_PATCH_UNSUPPORTED"
        });
    }

    const client = dependencies.client || createSidecarClient();
    let sidecarState;
    try {
        sidecarState = await client.ensure();
    } catch (error) {
        return appServerErrorResult(error, {
            error: "Codex app-server patch 当前不可用，未创建任务且未回退到 legacy。",
            errorCode: APP_SERVER_PATCH_UNSUPPORTED_CODES.has(String(error?.code || ""))
                ? "AICW_APP_SERVER_PATCH_UNSUPPORTED"
                : "AICW_APP_SERVER_PATCH_UNAVAILABLE"
        });
    }

    if (prepared.serviceTierOverride &&
        sidecarState?.serviceTierOverrideProtocolVersion !== SERVICE_TIER_OVERRIDE_PROTOCOL_VERSION) {
        return appServerErrorResult(null, {
            error: "当前 Sidecar 不支持显式逐任务档位覆盖，未创建 Job；请受控更新 Sidecar 实例后重试。",
            errorCode: SERVICE_TIER_SIDECAR_UNSUPPORTED
        });
    }
    if (!isPatchProtocolProof(sidecarState)) {
        return appServerErrorResult(null, {
            error: "Codex app-server patch 协议未得到完整 Sidecar status proof，已安全拒绝。",
            errorCode: "AICW_APP_SERVER_PATCH_UNSUPPORTED"
        });
    }

    ensureJobDirs();
    const timeoutS = Number(prepared.timeoutSec) || CFG.defaultTimeout;
    const projectPath = path.resolve(prepared.projectPath);
    let jobId;
    let p;
    let meta;
    let initialized;

    for (let attempt = 0; attempt < 8 && !initialized; attempt++) {
        jobId = generateJobId();
        p = jobPaths(jobId);
        meta = buildAppServerPatchMeta(jobId, p, prepared, projectPath, timeoutS);
        try {
            initialized = await initializeAppServerJob(jobId, p, meta, dependencies);
            if (initialized.status === "failed" || initialized.status === "finalization-failed") break;
        } catch (error) {
            if (error?.code === "META_ALREADY_EXISTS" && attempt < 7) continue;
            if (error?.code === "META_CREATE_FINALIZATION_FAILED") {
                return appServerErrorResult(error, {
                    error: "Codex app-server patch 元数据创建失败，临时文件无法可靠清理。",
                    errorCode: "AICW_APP_SERVER_PATCH_META_FINALIZATION_FAILED",
                    jobId,
                    state: "unknown",
                    metaDeleted: !fs.existsSync(p.meta),
                    finalizationError: error.code
                });
            }
            return appServerErrorResult(error, {
                error: "Codex app-server patch 元数据创建失败。",
                errorCode: "AICW_APP_SERVER_PATCH_META_FAILED",
                jobId,
                state: "failed"
            });
        }
    }

    if (!initialized || initialized.status === "failed" || initialized.status === "finalization-failed") {
        if (initialized?.status === "finalization-failed") {
            return appServerErrorResult(initialized.terminalError || initialized.error, {
                error: "Codex app-server patch 元数据初始化失败，终态无法可靠落盘。",
                errorCode: "AICW_APP_SERVER_PATCH_META_FINALIZATION_FAILED",
                jobId,
                state: "unknown",
                metaDeleted: initialized.metaDeleted,
                finalizationError: initialized.errorCode
            });
        }
        return appServerErrorResult(initialized?.error, {
            error: "Codex app-server patch 元数据初始化失败。",
            errorCode: "AICW_APP_SERVER_PATCH_META_FAILED",
            jobId,
            state: "failed",
            submissionState: "rejected",
            completedAt: initialized?.meta?.completedAt || null
        });
    }
    meta = initialized.meta;

    const finalizeSubmissionError = async (error, explicitCode = null) => {
        const outcome = mapAppServerPatchSubmissionError(
            explicitCode ? new SidecarError(explicitCode, "Patch submission was rejected") : error
        );
        const persisted = await persistAppServerPatchSubmissionOutcome(
            jobId,
            p.meta,
            readMeta(jobId) || meta,
            outcome,
            dependencies
        );
        if (persisted.confirmedBeforeUpdate) {
            return appServerSubmissionResult(jobId, persisted.meta);
        }
        if (persisted.status === "error") {
            return appServerErrorResult(persisted.error, {
                error: "Codex app-server patch 提交状态无法可靠落盘；保留原 jobId，禁止重放或回退。",
                errorCode: "AICW_APP_SERVER_PATCH_META_FINALIZATION_FAILED",
                submissionErrorCode: outcome.errorCode,
                jobId,
                state: "unknown"
            });
        }
        return appServerErrorResult(error, {
            error: outcome.message,
            errorCode: outcome.errorCode,
            jobId,
            state: persisted.meta?.state || outcome.state,
            submissionState: persisted.meta?.submissionState || outcome.submissionState
        });
    };

    let submitted;
    try {
        submitted = await client.submitPatchJob({
            jobId,
            projectPath,
            text: wrapAppServerPatchTask(prepared.task),
            metaPath: p.meta,
            outputPath: p.output,
            codexOutputPath: p.codexOutput,
            patchPath: p.patch,
            timeoutSec: timeoutS,
            model: patchModel,
            effort: patchEffort,
            ...(prepared.serviceTierOverride
                ? { serviceTier: prepared.serviceTierOverride }
                : {}),
            patchContractVersion: PATCH_CONTRACT_VERSION
        });
    } catch (error) {
        return finalizeSubmissionError(error);
    }

    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted) ||
        typeof submitted.accepted !== "boolean") {
        return finalizeSubmissionError(new SidecarError(
            "INVALID_SIDECAR_RESPONSE",
            "Sidecar patch response is missing a boolean accepted field"
        ));
    }
    if (submitted.accepted === false) {
        return finalizeSubmissionError(
            new SidecarError(submitted.errorCode || "SIDECAR_NOT_READY", "Patch submission was rejected")
        );
    }
    return appServerSubmissionResult(jobId, readMeta(jobId) || meta);
}

function mapAppServerWriteSubmissionError(error) {
    const code = String(error?.code || "");
    if (code === "AICW_APP_SERVER_WRITE_SUBMISSION_UNKNOWN" || APP_SERVER_UNKNOWN_SUBMISSION_CODES.has(code)) {
        return {
            errorCode: "AICW_APP_SERVER_WRITE_SUBMISSION_UNKNOWN",
            state: "running",
            submissionState: "unknown",
            message: "Codex app-server write 提交结果未知；已保留原 jobId，禁止回退或重放。"
        };
    }
    const mapped = new Map([
        ["AICW_APP_SERVER_WRITE_SIDECAR_UNSUPPORTED", "AICW_APP_SERVER_WRITE_SIDECAR_UNSUPPORTED"],
        ["AICW_APP_SERVER_WRITE_NOT_CONFIGURED", "AICW_APP_SERVER_WRITE_NOT_CONFIGURED"],
        ["AICW_WRITE_NOT_CONFIGURED", "AICW_APP_SERVER_WRITE_NOT_CONFIGURED"],
        ["AICW_WRITE_CONCURRENCY_LIMIT", "AICW_APP_SERVER_WRITE_CONCURRENCY_LIMIT"],
        ["CONCURRENCY_LIMIT", "AICW_APP_SERVER_WRITE_CONCURRENCY_LIMIT"],
        ["AICW_WRITE_PROJECT_NOT_ALLOWED", "AICW_APP_SERVER_WRITE_PROJECT_NOT_ALLOWED"],
        ["AICW_WRITE_REQUEST_INVALID", "AICW_APP_SERVER_WRITE_REQUEST_INVALID"],
        ["AICW_SERVICE_TIER_SIDECAR_UNSUPPORTED", "AICW_SERVICE_TIER_SIDECAR_UNSUPPORTED"]
    ]).get(code) || "AICW_APP_SERVER_WRITE_SUBMISSION_REJECTED";
    return {
        errorCode: mapped,
        state: "failed",
        submissionState: "rejected",
        message: "Codex app-server write 被拒绝；未修改主工作区，也未回退到 legacy。"
    };
}

async function cmdRunAppServerWrite(prepared, dependencies = {}) {
    if (!CFG.enableCodexAppServerWrite) {
        return appServerErrorResult(null, {
            error: "Codex app-server write 未启用。",
            errorCode: "AICW_APP_SERVER_WRITE_UNAVAILABLE"
        });
    }
    if (!CFG.enableCodex) {
        return appServerErrorResult(null, {
            error: "Codex 已被禁用（ENABLE_CODEX=false）。",
            errorCode: "AICW_APP_SERVER_WRITE_UNAVAILABLE"
        });
    }
    if (prepared.sessionId) {
        return appServerErrorResult(null, {
            error: "Codex app-server write 不接受 sessionId。",
            errorCode: "AICW_APP_SERVER_WRITE_SESSION_UNSUPPORTED"
        });
    }
    if (prepared.attachments.length > 0) {
        return appServerErrorResult(null, {
            error: "Codex app-server write 不支持附件。",
            errorCode: "AICW_APP_SERVER_WRITE_ATTACHMENTS_UNSUPPORTED"
        });
    }

    const client = dependencies.client || createSidecarClient();
    ensureJobDirs();
    const timeoutS = Number(prepared.timeoutSec) || CFG.defaultTimeout;
    const projectPath = path.resolve(prepared.projectPath);
    let jobId;
    let p;
    let meta;
    let initialized;

    for (let attempt = 0; attempt < 8 && !initialized; attempt++) {
        jobId = generateJobId();
        p = jobPaths(jobId);
        meta = buildAppServerWriteMeta(jobId, p, prepared, projectPath, timeoutS);
        try {
            initialized = await initializeAppServerJob(jobId, p, meta, dependencies);
            if (initialized.status === "failed" || initialized.status === "finalization-failed") break;
        } catch (error) {
            if (error?.code === "META_ALREADY_EXISTS" && attempt < 7) continue;
            return appServerErrorResult(error, {
                error: "Codex app-server write 元数据创建失败。",
                errorCode: error?.code === "META_CREATE_FINALIZATION_FAILED"
                    ? "AICW_APP_SERVER_WRITE_META_FINALIZATION_FAILED"
                    : "AICW_APP_SERVER_WRITE_META_FAILED",
                jobId,
                state: error?.code === "META_CREATE_FINALIZATION_FAILED" ? "unknown" : "failed"
            });
        }
    }

    if (!initialized || initialized.status === "failed" || initialized.status === "finalization-failed") {
        return appServerErrorResult(initialized?.terminalError || initialized?.error, {
            error: initialized?.status === "finalization-failed"
                ? "Codex app-server write 元数据终态无法可靠落盘。"
                : "Codex app-server write 元数据初始化失败。",
            errorCode: initialized?.status === "finalization-failed"
                ? "AICW_APP_SERVER_WRITE_META_FINALIZATION_FAILED"
                : "AICW_APP_SERVER_WRITE_META_FAILED",
            jobId,
            state: initialized?.status === "finalization-failed" ? "unknown" : "failed",
            submissionState: "rejected"
        });
    }
    meta = initialized.meta;

    const submissionAlreadyConfirmed = value => TERMINAL_STATES.has(value?.state) ||
        (value?.submissionState === "accepted" && value?.state === "running");
    const persistOutcome = async outcome => updateAppServerMeta(jobId, p.meta, readMeta(jobId) || meta, value => {
        if (submissionAlreadyConfirmed(value)) return undefined;
        value.state = outcome.state;
        value.jobPhase = outcome.state;
        value.submissionState = outcome.submissionState;
        value.validationPassed = false;
        value.candidateAvailable = false;
        value.errorCode = outcome.errorCode;
        value.exitCode = outcome.state === "failed" ? 1 : null;
        if (outcome.state === "failed") value.completedAt = new Date().toISOString();
        return value;
    });

    let submitted;
    try {
        submitted = await client.submitWriteJob({
            jobId,
            projectPath,
            text: wrapTask(prepared.task, "write"),
            timeoutSec: timeoutS,
            model: prepared.codexCapabilities?.model || undefined,
            effort: prepared.normalizedReasoningEffort || undefined,
            ...(prepared.serviceTierOverride ? { serviceTier: prepared.serviceTierOverride } : {})
        });
    } catch (error) {
        const current = readMeta(jobId) || meta;
        if (submissionAlreadyConfirmed(current)) {
            return appServerSubmissionResult(jobId, current);
        }
        const outcome = mapAppServerWriteSubmissionError(error);
        const persisted = await persistOutcome(outcome);
        if (outcome.state === "running" && submissionAlreadyConfirmed(persisted)) {
            return appServerSubmissionResult(jobId, persisted);
        }
        return appServerErrorResult(error, {
            error: outcome.message,
            errorCode: outcome.errorCode,
            jobId,
            state: persisted?.state || outcome.state,
            submissionState: persisted?.submissionState || outcome.submissionState
        });
    }

    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted) || submitted.accepted !== true) {
        const invalid = new SidecarError("INVALID_SIDECAR_RESPONSE", "Sidecar write response is not a confirmed acceptance");
        const current = readMeta(jobId) || meta;
        if (submissionAlreadyConfirmed(current)) return appServerSubmissionResult(jobId, current);
        const outcome = mapAppServerWriteSubmissionError(invalid);
        const persisted = await persistOutcome(outcome);
        if (outcome.state === "running" && submissionAlreadyConfirmed(persisted)) {
            return appServerSubmissionResult(jobId, persisted);
        }
        return appServerErrorResult(invalid, {
            error: outcome.message,
            errorCode: outcome.errorCode,
            jobId,
            state: persisted?.state || outcome.state,
            submissionState: persisted?.submissionState || outcome.submissionState
        });
    }
    return appServerSubmissionResult(jobId, readMeta(jobId) || meta);
}

async function cmdRun(input) {
    const normalized = normalizeRunRequest(input);
    if (normalized.status === "error") return normalized;
    const prepared = normalized.prepared;
    if (isCodexAppServerAnalyzeRoute(prepared.worker, prepared.mode)) {
        if (prepared.attachments.length > 0) {
            return appServerErrorResult(null, {
                error: "Codex app-server analyze 第一版不支持附件。",
                errorCode: "AICW_APPSERVER_ATTACHMENTS_UNSUPPORTED"
            });
        }
        return cmdRunAppServerAnalyze(prepared);
    }
    if (isCodexAppServerPatchRoute(prepared.worker, prepared.mode)) {
        return cmdRunAppServerPatch(prepared);
    }
    if (isCodexAppServerWriteRoute(prepared.worker, prepared.mode)) {
        return cmdRunAppServerWrite(prepared);
    }
    return cmdRunLegacy(prepared);
}

async function cmdRunLegacy(input, fallbackReason = null) {
    // v1.6: preset 快捷方式 — 自动生成 task / mode / projectPath
    if (input.preset) {
        const presetResult = applyPreset(input);
        if (presetResult && presetResult.status === "error") return presetResult;
        if (presetResult) input = presetResult;
    }

    const { worker = "opencode", projectPath, task, mode = "analyze",
            sessionId, attachments = [], timeoutSec, summaryHint, model,
            traceMode, reasoningEffort, fastMode } = input;

    if (!task)
        return { status: "error", error: "task 是必填参数。若要快速上手可使用 preset 参数，例如：preset=index, targetPath=/path/to/file.js" };
    if (task.length > CFG.maxTaskChars)
        return { status: "error", error: `task 超出最大长度 ${CFG.maxTaskChars} 字符。` };

    const normalizedTraceMode = normalizeTraceMode(traceMode, CFG.defaultTraceMode);
    if (!normalizedTraceMode)
        return { status: "error", error: "traceMode 不支持。可用: summary, events, raw" };

    const pathErr = validatePath(projectPath);
    if (pathErr) return { status: "error", error: pathErr };

    const requestedWorker = String(worker || "opencode").trim().toLowerCase();
    const normWorker = requestedWorker === "agy" ? "antigravity" : requestedWorker;
    if (!["opencode", "codex", "antigravity"].includes(normWorker))
        return { status: "error", error: `worker "${worker}" 不支持。可用: opencode, codex, antigravity` };

    const fastModeResult = normalizeFastMode(fastMode);
    if (fastModeResult.status === "error") return fastModeResult;
    if (fastModeResult.provided && normWorker !== "codex") {
        return {
            status: "error",
            error: "fastMode 仅支持 worker=codex；其他 Worker 请移除此参数。"
        };
    }
    const normalizedFastMode = fastModeResult.value;
    const serviceTierOverride = fastModeResult.serviceTier;

    const reasoningEffortProvided =
        reasoningEffort !== undefined &&
        reasoningEffort !== null &&
        String(reasoningEffort).trim() !== "";
    const normalizedReasoningEffort = reasoningEffortProvided
        ? String(reasoningEffort).trim().toLowerCase()
        : null;

    if (normalizedReasoningEffort && normWorker !== "codex") {
        return {
            status: "error",
            error: "reasoningEffort 仅支持 worker=codex；其他 Worker 请移除此参数。"
        };
    }

    const codexCapabilities = normWorker === "codex"
        ? resolveCodexModelCapabilities(model)
        : null;

    if (normalizedReasoningEffort) {
        if (!codexCapabilities?.model) {
            return {
                status: "error",
                error: "无法确定本次 Codex 实际模型，不能安全覆盖 reasoningEffort。请指定 model，或检查 Codex 配置。"
            };
        }

        if (!codexCapabilities.reasoningCapabilitiesVerified) {
            return {
                status: "error",
                error:
                    `无法从 Codex models_cache.json 验证模型 "${codexCapabilities.model}" 的推理档位，已拒绝盲传 reasoningEffort。请先刷新 Codex 模型缓存，或移除此参数。`
            };
        }

        if (
            !codexCapabilities.supportedReasoningEfforts.includes(
                normalizedReasoningEffort
            )
        ) {
            return {
                status: "error",
                error:
                    `模型 "${codexCapabilities.model}" 不支持 reasoningEffort="${normalizedReasoningEffort}"。可用: ${codexCapabilities.supportedReasoningEfforts.join(", ")}`
            };
        }
    }

    const reasoningMetadata = buildReasoningMetadata(
        normWorker,
        normalizedReasoningEffort,
        codexCapabilities
    );

    // 只对 opencode 执行历史兼容的残留清理。禁止全局杀 Codex，避免误伤 VS Code/其他会话。
    if (normWorker === "opencode") killResidualOpencode();

    // 首次运行时 JOB_ROOT 可能尚不存在。必须在创建锁文件前初始化目录，
    // 否则 fs.openSync(LOCK_FILE, "wx") 会因父目录不存在而被误报为“系统正忙”。
    ensureJobDirs();

    // 顺手清理超龄 job 文件（非阻塞，最多清50条）
    cleanupOldJobs();

    // 原子文件锁：防止并发竞态（两请求同时读到 0 → 双开）
    if (!acquireJobLock()) {
        return { status: "error", error: "系统正忙，另一任务正在启动中。请稍后再试。" };
    }

    // 并发硬闸门：在创建任何job文件/spawn任何进程之前拒绝，零资源开销。
    // opencode 和 antigravity 共用同一计数(谁先到占住名额，不是各自1个)。
    const activeCount = countActiveJobs();
    if (activeCount >= CFG.maxConcurrentJobs) {
        releaseJobLock();
        return { status: "error", error: `已有 ${activeCount} 个任务在运行(上限 ${CFG.maxConcurrentJobs})。本服务器内存有限，严禁同时跑多个 opencode/antigravity/codex 实例——2026-06-27 曾因并发任务堆积僵尸进程拖垮整机。请用 listJobs 查看进度，等当前任务完成(或先 cancel)后再提交新任务。` };
    }

    ensureJobDirs();
    let jobId = generateJobId();
    let p = jobPaths(jobId);
    const finalTask = wrapTask(task, mode);
    // 三种模式恒为 true：AICodeWorker 是无人值守后台进程(stdio stdin=ignore，没有交互通道)，
    // opencode/agy 遇到工具调用确认时若不加 --dangerously-skip-permissions 会卡死等输入直到超时
    // （实测：不加参数时 timeout+日志0字节；这不是analyze模式"更安全"，是直接卡死，没有中间态）。
    // 安全边界仍由 mode=write 门槛 + ALLOWED_PROJECT_ROOTS 白名单 + 任务约束词三层把住，与此参数无关。
    const wantSkip = true;
    const timeoutS = Number(timeoutSec) || CFG.defaultTimeout;

    let runnerArgs;
    if (normWorker === "opencode") {
        if (!CFG.enableOpencode) {
            releaseJobLock();
            return { status: "error", error: "opencode 已被禁用（ENABLE_OPENCODE=false）。" };
        }
        const ocOk = await checkOcVersion();
        if (!ocOk.ok) {
            releaseJobLock();
            return { status: "error", error: `找不到 opencode（OPENCODE_BIN=${CFG.opencodeBin}），请确认已安装。` };
        }
        const ocArgs = ["run", "--format", "json"];
        if (CFG.opencodeModel) ocArgs.push("-m", CFG.opencodeModel);
        if (sessionId) ocArgs.push("--session", String(sessionId));
        for (const f of attachments) {
            if (typeof f === "string" && f.trim()) ocArgs.push("-f", f.trim());
        }
        if (wantSkip) ocArgs.push("--dangerously-skip-permissions");
        ocArgs.push(finalTask);
        runnerArgs = {
            jobId, jobRoot: CFG.jobRoot, worker: "opencode",
            opencodeBin: CFG.opencodeBin, opencodeBaseUrl: CFG.opencodeBaseUrl,
            projectPath: path.resolve(projectPath),
            ocArgs,
            timeoutSec: timeoutS,
            redactSecrets: CFG.redactSecrets,
        };
    } else if (normWorker === "codex") {
        if (!CFG.enableCodex) {
            releaseJobLock();
            return { status: "error", error: "Codex 已被禁用（ENABLE_CODEX=false）。" };
        }
        const codexOk = await checkCodexVersion();
        if (!codexOk.ok) {
            releaseJobLock();
            return { status: "error", error: `找不到 Codex（CODEX_BIN=${CFG.codexBin}），请检查可执行文件路径。` };
        }
        if (sessionId) {
            releaseJobLock();
            return { status: "error", error: "Codex Adapter 第一版使用 --ephemeral 隔离会话，不接受 sessionId；长期上下文应由 VCP/RAG 注入任务书。" };
        }

        const codexSandbox = mode === "write"
            ? "workspace-write"
            : "read-only";
        const codexModelOverride =
            typeof model === "string" && model.trim()
                ? model.trim()
                : CFG.codexModel;
        const codexArgs = [
            "exec",
            "--json",
            "--color", "never",
            "--sandbox", codexSandbox,
            "--cd", path.resolve(projectPath),
            "--skip-git-repo-check",
            "--ephemeral",
            "--output-last-message", p.codexOutput
        ];
        if (CFG.codexProfile) {
            codexArgs.push("--profile", CFG.codexProfile);
        }
        if (codexModelOverride) {
            codexArgs.push("--model", codexModelOverride);
        }
        if (normalizedReasoningEffort) {
            codexArgs.push(
                "-c",
                `model_reasoning_effort="${normalizedReasoningEffort}"`
            );
        }
        appendCodexFastModeArgs(
            codexArgs,
            normalizedFastMode,
            serviceTierOverride
        );
        for (const f of attachments) {
            if (typeof f === "string" && f.trim()) codexArgs.push("--image", f.trim());
        }
        codexArgs.push(finalTask);

        runnerArgs = {
            jobId, jobRoot: CFG.jobRoot, worker: "codex",
            codexBin: CFG.codexBin,
            codexArgs,
            codexModel: reasoningMetadata.codexModel,
            codexModelSource:
                reasoningMetadata.codexModelSource,
            reasoningEffort:
                reasoningMetadata.reasoningEffort,
            reasoningEffortEffective:
                reasoningMetadata.reasoningEffortEffective,
            reasoningEffortSource:
                reasoningMetadata.reasoningEffortSource,
            reasoningEffortSupported:
                reasoningMetadata.reasoningEffortSupported,
            modelDefaultReasoningEffort:
                reasoningMetadata.modelDefaultReasoningEffort,
            configuredReasoningEffort:
                reasoningMetadata.configuredReasoningEffort,
            fastMode: normalizedFastMode,
            serviceTierOverride,
            codexOutputFile: p.codexOutput,
            projectPath: path.resolve(projectPath),
            timeoutSec: timeoutS,
            redactSecrets: CFG.redactSecrets,
        };
    } else {
        if (!CFG.enableAntigravity) {
            releaseJobLock();
            return { status: "error", error: "Antigravity 未启用（ENABLE_ANTIGRAVITY=false）。请改用 worker=opencode/codex 或在 config.env 开启。" };
        }
        const agyOk = await checkAgyVersion();
        if (!agyOk.ok) {
            releaseJobLock();
            return { status: "error", error: `找不到 agy（AGY_BIN=${CFG.agyBin}），请确认 Antigravity CLI 已安装。` };
        }
        const agyModel = (typeof model === "string" && model.trim()) ? model.trim() : CFG.agyModel;
        const agyArgs = ["--print", finalTask, "--print-timeout", `${timeoutS}s`];
        if (agyModel) agyArgs.push("--model", agyModel);
        if (wantSkip) agyArgs.push("--dangerously-skip-permissions");
        runnerArgs = {
            jobId, jobRoot: CFG.jobRoot, worker: "antigravity",
            agyBin: CFG.agyBin, agyProxy: CFG.agyProxy,
            projectPath: path.resolve(projectPath),
            agyArgs,
            timeoutSec: timeoutS,
            redactSecrets: CFG.redactSecrets,
        };
    }
    const warnings = [...preflightCheck(task, mode), ...checkFileSizes(task)];

    let meta = {
        jobId, worker: normWorker, mode,
        executionBackend: LEGACY_BACKEND,
        ...(fallbackReason ? {
            fallbackFrom: APP_SERVER_BACKEND,
            fallbackReason: String(fallbackReason).slice(0, 64)
        } : {}),
        projectPath:  path.resolve(projectPath),
        sessionId:    sessionId || null,
        summaryHint:  summaryHint || null,
        traceMode:    normalizedTraceMode,
        codexModel: reasoningMetadata.codexModel,
        codexModelSource:
            reasoningMetadata.codexModelSource,
        reasoningEffort:
            reasoningMetadata.reasoningEffort,
        reasoningEffortEffective:
            reasoningMetadata.reasoningEffortEffective,
        reasoningEffortSource:
            reasoningMetadata.reasoningEffortSource,
        reasoningEffortSupported:
            reasoningMetadata.reasoningEffortSupported,
        modelDefaultReasoningEffort:
            reasoningMetadata.modelDefaultReasoningEffort,
        configuredReasoningEffort:
            reasoningMetadata.configuredReasoningEffort,
        fastMode: normalizedFastMode,
        serviceTierOverride,
        startedAt:    new Date().toISOString(),
        state: "running",
        pid: null, exitCode: null, completedAt: null,
        warnings,
        ...p
    };
    let metaCreated = false;
    for (let attempt = 0; attempt < 8 && !metaCreated; attempt++) {
        try {
            createJsonExclusive(p.meta, meta);
            metaCreated = true;
        } catch (error) {
            if (error?.code !== "META_ALREADY_EXISTS" || attempt >= 7) {
                releaseJobLock();
                return {
                    status: "error",
                    error: error?.code === "META_ALREADY_EXISTS"
                        ? "无法分配唯一 Job ID，任务已安全拒绝。"
                        : `Job 元数据创建失败: ${error.message}`,
                    errorCode: error?.code === "META_ALREADY_EXISTS"
                        ? "AICW_META_COLLISION"
                        : "AICW_META_CREATE_FAILED"
                };
            }
            const previousPaths = p;
            jobId = generateJobId();
            p = jobPaths(jobId);
            rebindLegacyRunnerArgs(runnerArgs, previousPaths, jobId, p);
            meta = { ...meta, jobId, ...p };
        }
    }

    fs.writeFileSync(p.args, JSON.stringify(runnerArgs), "utf8");

    fs.writeFileSync(p.output, [
        "=== AICodeWorker Job ===",
        `Job ID   : ${jobId}`,
        `Worker   : ${normWorker}`,
        `Project  : ${meta.projectPath}`,
        `Mode     : ${mode}`,
        `Model    : ${reasoningMetadata.codexModel || "n/a"}`,
        `Reasoning: ${normWorker === "codex"
            ? (
                reasoningMetadata.reasoningEffortEffective ||
                "unknown"
            ) + " (" +
              (reasoningMetadata.reasoningEffortSource ||
               "unknown") + ")"
            : "n/a"}`,
        `Fast Mode: ${normWorker === "codex"
            ? (normalizedFastMode === null
                ? "inherit"
                : normalizedFastMode
                    ? "fast"
                    : "standard")
            : "n/a"}`,
        `Trace    : ${normalizedTraceMode}`,
        `Started  : ${meta.startedAt}`,
        "==================="
    ].join("\n") + "\n\n", "utf8");

    const runner = spawn(process.execPath, [path.join(__dirname, "runner.js"), p.args], {
        detached: true, stdio: "ignore", env: process.env
    });
    meta.pid = runner.pid;
    saveMeta(jobId, meta);
    runner.unref();

    releaseJobLock();
    return {
        status: "success", jobId, state: "running", pid: runner.pid,
        traceMode: normalizedTraceMode,
        codexModel: reasoningMetadata.codexModel,
        codexModelSource:
            reasoningMetadata.codexModelSource,
        reasoningEffort:
            reasoningMetadata.reasoningEffort,
        reasoningEffortEffective:
            reasoningMetadata.reasoningEffortEffective,
        reasoningEffortSource:
            reasoningMetadata.reasoningEffortSource,
        reasoningEffortSupported:
            reasoningMetadata.reasoningEffortSupported,
        modelDefaultReasoningEffort:
            reasoningMetadata.modelDefaultReasoningEffort,
        configuredReasoningEffort:
            reasoningMetadata.configuredReasoningEffort,
        fastMode: normalizedFastMode,
        serviceTierOverride,
        warnings, outputFile: p.output, logFile: p.log, patchFile: p.patch,
        message: `任务已提交。使用 query 命令查询进度：command=query, jobId=${jobId}`
    };
}

async function resolveRunAndWaitAfterWait(jobId, input = {}, dependencies = {}) {
    const read = dependencies.readMeta || readMeta;
    const cancel = dependencies.cancel || (id => cmdCancel({ jobId: id }));
    const reconcile = dependencies.reconcile || reconcileAppServerJobsNoStart;
    const build = dependencies.buildResult || buildResult;
    const buildTrace = dependencies.buildTracePayload || buildTracePayload;
    const initialMeta = read(jobId);
    const appServerJob = isAppServerMeta(initialMeta);
    let cancelResult;
    try {
        cancelResult = await cancel(jobId);
    } catch (error) {
        cancelResult = { status: "error", errorCode: error?.code || "CANCEL_FAILED" };
    }

    let meta = read(jobId);
    if (appServerJob || isAppServerMeta(meta) || isAppServerMeta(cancelResult)) {
        try { await reconcile(); } catch {}
        meta = read(jobId);
    }
    if (meta && TERMINAL_STATES.has(meta.state)) {
        const result = build(jobId, meta);
        result.warnings = classifyAppServerArtifactMeta(meta) === "legacy" ? (meta.warnings || []) : [];
        return result;
    }
    return {
        status: "error",
        jobId,
        state: meta?.state || "unknown",
        errorCode: "AICW_RUN_AND_WAIT_CANCEL_UNCONFIRMED",
        warnings: classifyAppServerArtifactMeta(meta) === "legacy" ? (meta?.warnings || []) : [],
        ...(meta?.startedAt ? { startedAt: meta.startedAt } : {}),
        hint: cancelResult?.error
            ? `任务等待耗尽，取消未确认：${String(cancelResult.error).slice(0, 200)}；未生成第二个 Job。`
            : "任务等待耗尽，但取消结果未确认；请使用 query/cancel 继续核实，未生成第二个 Job。",
        ...buildTrace(jobId, meta || {}, input.traceMode)
    };
}

async function cmdRunAndWait(input) {
    const runResult = await cmdRun(input);
    if (runResult.status === "error") return runResult;
    const { jobId } = runResult;
    if (runResult.state && runResult.state !== "running") return runResult;

    for (const sec of BACKOFF_RUN_WAIT) {
        await sleep(sec * 1000);
        let meta = readMeta(jobId);
        if (!meta) return { status: "error", error: `Job "${jobId}" 元数据丢失。` };
        if (isAppServerMeta(meta)) await reconcileAppServerJobsNoStart();
        meta = readMeta(jobId) || meta;
        meta = checkAndMarkDead(meta, jobId, "run_and_wait");
        if (meta.state !== "running") {
            const result = buildResult(jobId, meta);
            result.warnings = classifyAppServerArtifactMeta(meta) === "legacy" ? (meta.warnings || []) : [];
            return result;
        }
    }

    // 修复：超时后自动取消任务，防止 opencode 进程继续在后台吃内存
    // 旧逻辑：只返回 state=running 提示，Agent 以为失败重新提交 → 旧进程还在跑 → 内存堆积
    return resolveRunAndWaitAfterWait(jobId, input);
}

async function cmdQuery(input) {
    const { jobId } = input;
    if (!jobId) return { status: "error", error: "jobId 是必填参数。" };

    const waitValue = String(input.wait ?? "true").trim().toLowerCase();
    const shouldWait = !["false", "0", "no", "off"].includes(waitValue);
    const responseMode = normalizeResponseMode(
        input.responseMode,
        shouldWait ? "full" : "compact"
    );
    if (!responseMode)
        return { status: "error", error: "responseMode 不支持。可用: compact, full" };

    const traceModeOverride = input.traceMode === undefined
        ? null
        : normalizeTraceMode(input.traceMode, CFG.defaultTraceMode);
    if (input.traceMode !== undefined && !traceModeOverride)
        return { status: "error", error: "traceMode 不支持。可用: summary, events, raw" };

    await reconcileAppServerJobsNoStart();
    let meta = readMeta(jobId);
    if (!meta) return { status: "error", error: `Job "${jobId}" 不存在。` };
    if (meta.state !== "running") {
        return responseMode === "compact"
            ? buildCompactQueryResult(jobId, meta)
            : buildResult(jobId, meta, traceModeOverride);
    }

    if (shouldWait) {
        for (const sec of BACKOFF_QUERY) {
            await sleep(sec * 1000);
            meta = readMeta(jobId);
            if (!meta) break;
            if (isAppServerMeta(meta)) {
                await reconcileAppServerJobsNoStart();
                meta = readMeta(jobId) || meta;
            }
            meta = checkAndMarkDead(meta, jobId, "query");
            if (meta.state !== "running") break;
        }
        meta = readMeta(jobId) || meta;
    } else {
        meta = checkAndMarkDead(meta, jobId, "query-nowait");
    }

    if (meta.state === "running") {
        if (responseMode === "compact") {
            return buildCompactQueryResult(jobId, meta, {
                hint: shouldWait
                    ? "任务仍在运行，请再调用一次 query；如需轨迹请调用 command=trace。"
                    : "任务仍在运行。本次 wait=false，仅返回紧凑状态；如需轨迹请调用 command=trace。"
            });
        }
        return {
            status: "success", jobId, state: "running",
            fastMode:
                typeof meta.fastMode === "boolean" ? meta.fastMode : null,
            serviceTierOverride:
                meta.serviceTierOverride || null,
            warnings: classifyAppServerArtifactMeta(meta) === "legacy" ? (meta.warnings || []) : [],
            startedAt: meta.startedAt, suggestedWaitSec: 0,
            hint: shouldWait
                ? "任务仍在运行，请再调用一次 query；也可用 command=trace 即时查看已有执行轨迹。"
                : "任务仍在运行。本次 wait=false，已立即返回当前状态与已有轨迹。",
            ...(isAppServerWriteMeta(meta)
                ? buildWriteResultProjection(jobId, meta)
                : classifyAppServerArtifactMeta(meta) === "legacy"
                    ? {}
                    : buildPatchArtifactProjection(jobId, meta)),
            ...executionMetaPayload(meta),
            ...buildTracePayload(jobId, meta, traceModeOverride)
        };
    }
    return responseMode === "compact"
        ? buildCompactQueryResult(jobId, meta)
        : buildResult(jobId, meta, traceModeOverride);
}

async function cmdTrace(input) {
    const { jobId } = input;
    if (!jobId) return { status: "error", error: "jobId 是必填参数。" };

    const requestedMode = input.traceMode === undefined ? "events" : input.traceMode;
    const traceMode = normalizeTraceMode(requestedMode, "events");
    if (!traceMode)
        return { status: "error", error: "traceMode 不支持。可用: summary, events, raw" };

    await reconcileAppServerJobsNoStart();
    let meta = readMeta(jobId);
    if (!meta) return { status: "error", error: `Job "${jobId}" 不存在。` };
    meta = checkAndMarkDead(meta, jobId, "trace");
    const artifactClass = classifyAppServerArtifactMeta(meta);

    if (artifactClass === "patch") {
        return {
            status: "success",
            jobId,
            state: meta.state,
            worker: "codex",
            mode: "patch",
            jobKind: "patch",
            jobPhase: normalizePatchTracePhase(meta),
            errorCode: meta.errorCode || null,
            startedAt: meta.startedAt || null,
            completedAt: meta.completedAt || null,
            ...buildTracePayload(jobId, meta, traceMode)
        };
    }
    if (artifactClass === "ambiguous") {
        return {
            status: "success",
            jobId,
            state: normalizeSafeArtifactState(meta),
            jobPhase: null,
            errorCode: safeArtifactErrorCode(meta),
            startedAt: safeArtifactTimestamp(meta?.startedAt),
            completedAt: safeArtifactTimestamp(meta?.completedAt),
            patchFile: null,
            patchAvailable: false,
            ...buildTracePayload(jobId, meta, traceMode)
        };
    }

    return {
        status: "success",
        jobId,
        state: meta.state,
        worker: meta.worker,
        mode: meta.mode,
        codexModel: meta.codexModel || null,
        codexModelSource:
            meta.codexModelSource || null,
        reasoningEffort: meta.reasoningEffort || null,
        reasoningEffortEffective:
            meta.reasoningEffortEffective ||
            meta.reasoningEffort ||
            null,
        reasoningEffortSource:
            meta.reasoningEffortSource ||
            (meta.worker === "codex"
                ? "legacy_unknown"
                : null),
        reasoningEffortSupported:
            meta.reasoningEffortSupported || [],
        modelDefaultReasoningEffort:
            meta.modelDefaultReasoningEffort || null,
        configuredReasoningEffort:
            meta.configuredReasoningEffort || null,
        fastMode:
            typeof meta.fastMode === "boolean" ? meta.fastMode : null,
        serviceTierOverride:
            meta.serviceTierOverride || null,
        ...executionMetaPayload(meta),
        startedAt: meta.startedAt,
        completedAt: meta.completedAt,
        ...buildTracePayload(jobId, meta, traceMode)
    };
}

async function cmdListJobs(input) {
    await reconcileAppServerJobsNoStart();
    ensureJobDirs();
    cleanupOldJobs(); // 顺手清理超龄任务文件，防止 jobs 目录无限膨胀
    const metaDir = path.join(CFG.jobRoot, "meta");
    const limit = Math.min(parseInt(input.limit || "10", 10), 50);
    const files = fs.readdirSync(metaDir)
        .filter(f => f.endsWith(".json") && !f.endsWith(".args.json"))
        .sort().reverse().slice(0, limit);
    const jobs = [];
    for (const file of files) {
        try {
            let m = JSON.parse(fs.readFileSync(path.join(metaDir, file), "utf8"));
            const metaFileJobId = file.slice(0, -".json".length);
            const artifactClass = classifyAppServerArtifactMeta(m);
            if (m?.jobId !== metaFileJobId) continue;
            m = checkAndMarkDead(m, metaFileJobId, "listJobs");
            const writeProjection = isAppServerWriteMeta(m)
                ? buildWriteResultProjection(metaFileJobId, m)
                : null;
            const patchProjection = (writeProjection || artifactClass === "legacy")
                ? null
                : buildPatchArtifactProjection(metaFileJobId, m);
            jobs.push({
                jobId: metaFileJobId, state: m.state, worker: m.worker,
                mode: m.mode, projectPath: m.projectPath,
                jobKind: m.jobKind || null,
                ...(patchProjection ? {
                    jobPhase: patchProjection.jobPhase,
                    patchAvailable: patchProjection.patchAvailable,
                    patchValidated: patchProjection.patchValidated,
                    applyCheckPassed: patchProjection.applyCheckPassed,
                    baselineStable: patchProjection.baselineStable,
                    patchBytes: patchProjection.patchBytes,
                    patchFileCount: patchProjection.patchFileCount
                } : {}),
                ...(writeProjection || {}),
                startedAt: m.startedAt, completedAt: m.completedAt, exitCode: m.exitCode,
                traceMode: m.traceMode || CFG.defaultTraceMode,
                codexModel: m.codexModel || null,
                codexModelSource:
                    m.codexModelSource || null,
                reasoningEffort:
                    m.reasoningEffort || null,
                reasoningEffortEffective:
                    m.reasoningEffortEffective ||
                    m.reasoningEffort ||
                    null,
                reasoningEffortSource:
                    m.reasoningEffortSource ||
                    (m.worker === "codex"
                        ? "legacy_unknown"
                        : null),
                reasoningEffortSupported:
                    m.reasoningEffortSupported || [],
                fastMode:
                    typeof m.fastMode === "boolean" ? m.fastMode : null,
                serviceTierOverride:
                    m.serviceTierOverride || null
                , ...executionMetaPayload(m)
            });
        } catch {}
    }
    return { status: "success", total: jobs.length, jobs };
}

async function cmdCancel(input, dependencies = {}) {
    const { jobId } = input;
    if (!jobId) return { status: "error", error: "jobId 是必填参数。" };

    const read = dependencies.readMeta || readMeta;
    const save = dependencies.saveMeta || saveMeta;
    const isRunning = dependencies.isProcessRunning || isProcessRunning;
    const kill = dependencies.kill || killProcessTreeSync;
    const wait = dependencies.sleep || sleepSync;
    const reconcile = dependencies.reconcile || reconcileAppServerJobsNoStart;
    const appendOutput = dependencies.appendOutput || ((id, current) => {
        try {
            fs.appendFileSync(jobPaths(id).output, `\n=== 任务已手动取消 (${current.completedAt}) ===\n`);
        } catch {}
    });
    const duration = (value, fallback) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
    };
    const gracefulWaitMs = duration(dependencies.gracefulWaitMs, LEGACY_CANCEL_GRACE_MS);
    const confirmationTimeoutMs = duration(dependencies.confirmationTimeoutMs, LEGACY_CANCEL_CONFIRM_TIMEOUT_MS);
    const confirmationPollMs = duration(dependencies.confirmationPollMs, LEGACY_CANCEL_CONFIRM_POLL_MS);
    const terminalResult = (current, alreadyTerminal = false) => ({
        status: "success",
        jobId,
        state: current.state,
        ...(alreadyTerminal ? { alreadyTerminal: true } : {}),
        ...executionMetaPayload(current),
        message: `Job "${jobId}" ${alreadyTerminal ? "已经是终态" : "已进入终态"}。`
    });
    const processAlive = pid => {
        try { return isRunning(pid) === true; } catch { return true; }
    };

    await reconcile();
    let meta = read(jobId);
    if (!meta) return { status: "error", error: `Job "${jobId}" 不存在。` };

    if (isAppServerMeta(meta)) {
        if (TERMINAL_STATES.has(meta.state)) return terminalResult(meta, true);
        const client = createSidecarClient();
        try {
            await client.cancel({ jobId });
        } catch (error) {
            meta = read(jobId) || meta;
            if (TERMINAL_STATES.has(meta.state)) return terminalResult(meta, true);
            return appServerErrorResult(error, {
                error: "Codex app-server 取消失败。",
                errorCode: error?.code === "JOB_NOT_ACTIVE"
                    ? "AICW_APP_SERVER_NOT_ACTIVE"
                    : "AICW_APP_SERVER_CANCEL_FAILED",
                jobId,
                state: meta.state || "running"
            });
        }
        meta = read(jobId) || meta;
        return {
            status: "success",
            jobId,
            state: meta.state,
            ...executionMetaPayload(meta),
            message: `Job "${jobId}" 已请求取消当前 app-server 回合。`
        };
    }

    if (meta.state !== "running")
        return { status: "error", error: `Job "${jobId}" 状态为 "${meta.state}"，不是运行中。` };

    const targetPids = [...new Set([meta.workerPid, meta.opencodePid, meta.pid]
        .map(Number)
        .filter(pid => Number.isInteger(pid) && pid > 0))];
    if (targetPids.length === 0)
        return { status: "error", error: `Job "${jobId}" 无 PID 记录，无法取消。` };

    try {
        // 只按该 Job 记录的 PID 操作，绝不全局杀同名进程。
        for (const pid of targetPids) {
            if (processAlive(pid)) kill(pid, false);
        }
        await Promise.resolve(wait(gracefulWaitMs));

        meta = read(jobId) || meta;
        if (TERMINAL_STATES.has(meta.state)) return terminalResult(meta);
        if (meta.state !== "running")
            return { status: "error", error: `Job "${jobId}" 状态为 "${meta.state}"，取消未完成。`, state: meta.state };

        for (const pid of targetPids) {
            if (processAlive(pid)) kill(pid, true);
        }

        let alivePids = targetPids.filter(processAlive);
        const confirmationDeadline = Date.now() + confirmationTimeoutMs;
        while (alivePids.length > 0 && Date.now() < confirmationDeadline) {
            await Promise.resolve(wait(confirmationPollMs));
            alivePids = targetPids.filter(processAlive);
        }

        // 取消确认与写入之间再次读取，避免覆盖自然完成/失败的终态。
        meta = read(jobId) || meta;
        if (TERMINAL_STATES.has(meta.state)) return terminalResult(meta);
        if (meta.state !== "running")
            return { status: "error", error: `Job "${jobId}" 状态为 "${meta.state}"，取消未完成。`, state: meta.state };
        if (alivePids.length > 0) {
            return {
                status: "error",
                jobId,
                state: "running",
                errorCode: "AICW_CANCEL_UNCONFIRMED",
                error: `Job "${jobId}" 取消未确认，仍有进程存活。`
            };
        }

        meta.state = "cancelled";
        meta.completedAt = new Date().toISOString();
        await Promise.resolve(save(jobId, meta));
        try { appendOutput(jobId, meta); } catch {}

        return {
            status: "success",
            jobId,
            state: "cancelled",
            message: `Job "${jobId}" 已终止（当前 Worker 进程树 + runner）。`
        };
    } catch (err) {
        return { status: "error", error: `终止 Job "${jobId}" 失败: ${err.message}` };
    }
}

// ─── Main// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    let raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) raw += chunk;
    let input;
    try {
        input = JSON.parse(raw.replace(/^﻿/, ""));
    } catch {
        process.stdout.write(JSON.stringify({ status: "error", error: "stdin 不是合法 JSON。" }));
        return;
    }
    const cmd = (input.command || "").trim().toLowerCase();
    let result;
    try {
        switch (cmd) {
            case "capabilities":  result = await cmdCapabilities(input); break;
            case "run":           result = await cmdRun(input);        break;
            case "run_and_wait":  result = await cmdRunAndWait(input); break;
            case "query":         result = await cmdQuery(input);      break;
            case "trace":         result = await cmdTrace(input);      break;
            case "listjobs":      result = await cmdListJobs(input);   break;
            case "cancel":        result = await cmdCancel(input);     break;
            default:
                result = { status: "error", error: `未知命令 "${cmd}"。支持: capabilities, run, run_and_wait, query, trace, listJobs, cancel` };
        }
    } catch (err) {
        result = { status: "error", error: `插件内部错误: ${err.message}` };
    }
    if (result.status === "error") {
        process.stdout.write(JSON.stringify(result));
    } else {
        const { status, ...payload } = result;
        process.stdout.write(JSON.stringify({ status, result: payload }));
    }
}

if (require.main === module) {
    main().catch(err => {
        process.stdout.write(JSON.stringify({ status: "error", error: `插件崩溃: ${err.message}` }));
    });
}

module.exports = {
    generateJobId,
    normalizeRunRequest,
    normalizeResponseMode,
    normalizeFastMode,
    appendCodexFastModeArgs,
    isAppServerMeta,
    isAppServerPatchMeta,
    isCodexAppServerAnalyzeRoute,
    isCodexAppServerPatchRoute,
    isCodexAppServerWriteRoute,
    isAppServerWriteMeta,
    shouldFallbackToLegacyBeforeJob,
    parseAppServerExecutionTrace,
    buildTracePayload,
    buildResult,
    compactStateSummary,
    isMachineCompactSummaryLine,
    readCompactSummary,
    buildPatchArtifactProjection,
    buildWriteResultProjection,
    buildCompactQueryResult,
    compactCapabilitiesResult,
    cleanupOldJobs,
    executionMetaPayload,
    capTraceEvents,
    resolveRunAndWaitAfterWait,
    initializeAppServerJob,
    cmdRunAppServerAnalyze,
    cmdRunAppServerPatch,
    cmdRunAppServerWrite,
    cmdCapabilities,
    cmdRun,
    cmdRunAndWait,
    cmdQuery,
    cmdTrace,
    cmdListJobs,
    cmdCancel
};
