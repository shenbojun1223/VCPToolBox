"use strict";
// AICodeWorker - VCP 插件主入口 v1.11.0
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const BACKOFF_RUN_WAIT = [2, 3, 5, 10, 15, 20, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const BACKOFF_QUERY    = [5, 10, 15, 20, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const TRACE_MODES = new Set(["summary", "events", "raw"]);
const CODEX_MODELS_CACHE_FILE = "models_cache.json";

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
    };
}

const CFG = loadConfig();
let _ocVersionCache = null;
let _codexVersionCache = null;


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
    const rand = String(Math.floor(Math.random() * 9000) + 1000);
    return `job_${n.getFullYear()}${p(n.getMonth()+1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}_${rand}`;
}

function readMeta(jobId) {
    const mp = jobPaths(jobId).meta;
    if (!fs.existsSync(mp)) return null;
    try { return JSON.parse(fs.readFileSync(mp, "utf8")); } catch { return null; }
}

function saveMeta(jobId, meta) {
    fs.writeFileSync(jobPaths(jobId).meta, JSON.stringify(meta, null, 2), "utf8");
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
        mode:        input.mode || def.mode,
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

// ─── 结果构建 ─────────────────────────────────────────────────────────────────
// v1.5：新增 fileReadList 字段；summary 优先提取【执行结果摘要】固定锚点


function normalizeTraceMode(value, fallback = "summary") {
    const normalized = String(value ?? fallback ?? "summary").trim().toLowerCase();
    return TRACE_MODES.has(normalized) ? normalized : null;
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

function buildTracePayload(jobId, meta, overrideMode = null) {
    const traceMode = normalizeTraceMode(overrideMode, meta?.traceMode || CFG.defaultTraceMode) || "summary";
    const payload = { traceMode };

    if (traceMode === "summary") return payload;

    if (meta?.worker !== "codex") {
        return {
            ...payload,
            traceNote: "结构化执行轨迹目前仅支持 Codex JSONL Worker。"
        };
    }

    const p = jobPaths(jobId);
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

    let output = "";
    // Codex 的 stdout 是 JSONL 事件流，直接从中提取报告会混入转义符和事件外壳。
    // 对 Codex 优先使用 --output-last-message 生成的纯文本最终报告；
    // 原始 JSONL 仍保留在 outputFile 中，供故障排查与完整审计。
    const preferredOutputPath =
        meta?.worker === "codex" && fs.existsSync(p.codexOutput)
            ? p.codexOutput
            : p.output;
    if (fs.existsSync(preferredOutputPath)) {
        const raw = fs.readFileSync(preferredOutputPath, "utf8");
        const masked = redact(raw);
        output = masked.length > 50000
            ? "[输出已截断，仅显示最后 50000 字符]\n" + masked.slice(-50000)
            : masked;
    }

    let logSummary = "";
    if (fs.existsSync(p.log)) {
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
        status:      "success",
        jobId,
        state:       meta.state,
        exitCode:    meta.exitCode,
        startedAt:   meta.startedAt,
        completedAt: meta.completedAt,
        projectPath: meta.projectPath,
        mode:        meta.mode,
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
        fileReadList, // v1.5 新增：opencode 读了哪些文件
        summary,      // 优先锚点提取，比 v1.4 更准确
        output,
        logSummary,
        outputFile: p.output,
        logFile:    p.log,
        patchFile:       fs.existsSync(p.patch) ? p.patch : null,
        codexOutputFile: fs.existsSync(p.codexOutput) ? p.codexOutput : null,
        ...tracePayload,
    };
}

function checkAndMarkDead(meta, jobId, source) {
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
            .sort().reverse()
            .slice(0, 100); // 只看最近100条，避免历史堆积后越来越慢
    }
    catch { return 0; }
    let count = 0;
    for (const file of files) {
        try {
            let m = JSON.parse(fs.readFileSync(path.join(metaDir, file), "utf8"));
            m = checkAndMarkDead(m, m.jobId, "concurrencyGuard");
            if (m.state === "running") count++;
        } catch {}
    }
    return count;
}

/** 清理旧 job 文件：删除超过 retainDays 天且状态非 running 的全部文件。
 *  在 listJobs 和 run 时触发，每次最多清理 50 个，避免阻塞主流程。 */
function cleanupOldJobs(retainDays = 7, maxClean = 50) {
    const metaDir = path.join(CFG.jobRoot, "meta");
    let files = [];
    try { files = fs.readdirSync(metaDir).filter(f => f.endsWith(".json") && !f.endsWith(".args.json")); }
    catch { return; }
    const cutoff = Date.now() - retainDays * 86400 * 1000;
    let cleaned = 0;
    for (const file of files) {
        if (cleaned >= 50) break;
        const metaPath = path.join(metaDir, file);
        try {
            const m = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            if (m.state === "running") continue; // 跑着的绝不清
            // 优先用 meta.startedAt（不受 rsync/cp 刷新 mtime），回落到文件 mtime
            const jobTime = m.startedAt ? new Date(m.startedAt).getTime() : fs.statSync(metaPath).mtimeMs;
            if (jobTime > cutoff) continue;
            // 删 meta、args、output、log、patch 五个关联文件
            const p = jobPaths(m.jobId);
            for (const fp of [metaPath, p.args, p.output, p.log, p.patch, p.codexOutput]) {
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

async function cmdCapabilities(input = {}) {
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

    return {
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
        ]
    };
}

async function cmdRun(input) {
    // v1.6: preset 快捷方式 — 自动生成 task / mode / projectPath
    if (input.preset) {
        const presetResult = applyPreset(input);
        if (presetResult && presetResult.status === "error") return presetResult;
        if (presetResult) input = presetResult;
    }

    const { worker = "opencode", projectPath, task, mode = "analyze",
            sessionId, attachments = [], timeoutSec, summaryHint, model,
            traceMode, reasoningEffort } = input;

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
    const jobId = generateJobId();
    const p = jobPaths(jobId);
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
    fs.writeFileSync(p.args, JSON.stringify(runnerArgs), "utf8");

    const warnings = [...preflightCheck(task, mode), ...checkFileSizes(task)];

    const meta = {
        jobId, worker: normWorker, mode,
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
        startedAt:    new Date().toISOString(),
        state: "running",
        pid: null, exitCode: null, completedAt: null,
        warnings,
        ...p
    };
    saveMeta(jobId, meta);

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
        warnings, outputFile: p.output, logFile: p.log, patchFile: p.patch,
        message: `任务已提交。使用 query 命令查询进度：command=query, jobId=${jobId}`
    };
}

async function cmdRunAndWait(input) {
    const runResult = await cmdRun(input);
    if (runResult.status === "error") return runResult;
    const { jobId } = runResult;

    for (const sec of BACKOFF_RUN_WAIT) {
        await sleep(sec * 1000);
        let meta = readMeta(jobId);
        if (!meta) return { status: "error", error: `Job "${jobId}" 元数据丢失。` };
        meta = checkAndMarkDead(meta, jobId, "run_and_wait");
        if (meta.state !== "running") {
            const result = buildResult(jobId, meta);
            result.warnings = meta.warnings || [];
            return result;
        }
    }

    // 修复：超时后自动取消任务，防止 opencode 进程继续在后台吃内存
    // 旧逻辑：只返回 state=running 提示，Agent 以为失败重新提交 → 旧进程还在跑 → 内存堆积
    const cancelResult = await cmdCancel({ jobId });
    const meta2 = readMeta(jobId);
    return {
        status: "success", jobId, state: "timeout",
        warnings: meta2?.warnings || [],
        startedAt: meta2?.startedAt,
        hint: `任务已超过内置等待时长，已自动取消（${cancelResult.status === "success" ? "进程已终止" : "取消时发生错误: " + cancelResult.error}）。如需重试请重新提交 run。`,
        ...buildTracePayload(jobId, meta2 || {}, input.traceMode)
    };
}

async function cmdQuery(input) {
    const { jobId } = input;
    if (!jobId) return { status: "error", error: "jobId 是必填参数。" };

    const traceModeOverride = input.traceMode === undefined
        ? null
        : normalizeTraceMode(input.traceMode, CFG.defaultTraceMode);
    if (input.traceMode !== undefined && !traceModeOverride)
        return { status: "error", error: "traceMode 不支持。可用: summary, events, raw" };

    let meta = readMeta(jobId);
    if (!meta) return { status: "error", error: `Job "${jobId}" 不存在。` };
    if (meta.state !== "running") return buildResult(jobId, meta, traceModeOverride);

    const waitValue = String(input.wait ?? "true").trim().toLowerCase();
    const shouldWait = !["false", "0", "no", "off"].includes(waitValue);

    if (shouldWait) {
        for (const sec of BACKOFF_QUERY) {
            await sleep(sec * 1000);
            meta = readMeta(jobId);
            if (!meta) break;
            meta = checkAndMarkDead(meta, jobId, "query");
            if (meta.state !== "running") break;
        }
        meta = readMeta(jobId) || meta;
    } else {
        meta = checkAndMarkDead(meta, jobId, "query-nowait");
    }

    if (meta.state === "running") {
        return {
            status: "success", jobId, state: "running",
            warnings: meta.warnings || [],
            startedAt: meta.startedAt, suggestedWaitSec: 0,
            hint: shouldWait
                ? "任务仍在运行，请再调用一次 query；也可用 command=trace 即时查看已有执行轨迹。"
                : "任务仍在运行。本次 wait=false，已立即返回当前状态与已有轨迹。",
            ...buildTracePayload(jobId, meta, traceModeOverride)
        };
    }
    return buildResult(jobId, meta, traceModeOverride);
}

async function cmdTrace(input) {
    const { jobId } = input;
    if (!jobId) return { status: "error", error: "jobId 是必填参数。" };

    const requestedMode = input.traceMode === undefined ? "events" : input.traceMode;
    const traceMode = normalizeTraceMode(requestedMode, "events");
    if (!traceMode)
        return { status: "error", error: "traceMode 不支持。可用: summary, events, raw" };

    let meta = readMeta(jobId);
    if (!meta) return { status: "error", error: `Job "${jobId}" 不存在。` };
    meta = checkAndMarkDead(meta, jobId, "trace");

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
        startedAt: meta.startedAt,
        completedAt: meta.completedAt,
        ...buildTracePayload(jobId, meta, traceMode)
    };
}

async function cmdListJobs(input) {
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
            m = checkAndMarkDead(m, m.jobId, "listJobs");
            jobs.push({
                jobId: m.jobId, state: m.state, worker: m.worker,
                mode: m.mode, projectPath: m.projectPath,
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
                    m.reasoningEffortSupported || []
            });
        } catch {}
    }
    return { status: "success", total: jobs.length, jobs };
}

async function cmdCancel(input) {
    const { jobId } = input;
    if (!jobId) return { status: "error", error: "jobId 是必填参数。" };

    const meta = readMeta(jobId);
    if (!meta) return { status: "error", error: `Job "${jobId}" 不存在。` };
    if (meta.state !== "running")
        return { status: "error", error: `Job "${jobId}" 状态为 "${meta.state}"，不是运行中。` };

    const workerPid = meta.workerPid || meta.opencodePid;
    if (!meta.pid && !workerPid)
        return { status: "error", error: `Job "${jobId}" 无 PID 记录，无法取消。` };

    try {
        // 先请求结束当前 Job 的 Worker 与 runner；只按 Job PID 操作，绝不全局杀同名进程。
        if (workerPid) killProcessTreeSync(workerPid, false);
        if (meta.pid) killProcessTreeSync(meta.pid, false);
        sleepSync(1500);
        if (workerPid) killProcessTreeSync(workerPid, true);
        if (meta.pid) killProcessTreeSync(meta.pid, true);

        meta.state = "cancelled";
        meta.completedAt = new Date().toISOString();
        saveMeta(jobId, meta);
        try {
            fs.appendFileSync(jobPaths(jobId).output, `\n=== 任务已手动取消 (${meta.completedAt}) ===\n`);
        } catch {}

        return {
            status: "success",
            jobId,
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

main().catch(err => {
    process.stdout.write(JSON.stringify({ status: "error", error: `插件崩溃: ${err.message}` }));
});
