"use strict";
// runner.js - AICodeWorker 后台任务执行器
// 由 AICodeWorker.js 以 detached 方式启动，负责运行 opencode / Codex / antigravity。

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function loadConfig(pluginDir) {
    const envPath = path.join(pluginDir, "config.env");
    const result = {};
    if (!fs.existsSync(envPath)) return result;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        result[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    }
    return result;
}

function killProcessTree(pid, force = false) {
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

function updateMeta(metaPath, updater) {
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        updater(meta);
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    } catch {}
}

async function run() {
    const argsFile = process.argv[2];
    if (!argsFile || !fs.existsSync(argsFile)) process.exit(1);

    let runArgs;
    try {
        runArgs = JSON.parse(fs.readFileSync(argsFile, "utf8"));
    } catch {
        process.exit(1);
    }

    const {
        jobId,
        jobRoot,
        worker = "opencode",
        projectPath,
        timeoutSec,
        opencodeBin,
        ocArgs,
        agyBin,
        agyArgs,
        agyProxy,
        codexBin,
        codexArgs,
        codexOutputFile
    } = runArgs;

    const metaPath = path.join(jobRoot, "meta", `${jobId}.json`);
    const outputPath = path.join(jobRoot, "output", `${jobId}.txt`);
    const logPath = path.join(jobRoot, "logs", `${jobId}.log`);

    const pluginDir = path.resolve(jobRoot, "..");
    const cfg = loadConfig(pluginDir);
    const baseEnv = {
        ...process.env,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        no_proxy: "localhost,127.0.0.1",
        NO_PROXY: "localhost,127.0.0.1"
    };

    let spawnBin;
    let spawnArgs;
    let spawnEnv;

    if (worker === "opencode") {
        const model = cfg.OPENCODE_MODEL || "";
        const useVCPRouting = !!(cfg.OPENCODE_BASE_URL && cfg.OPENCODE_API_KEY);
        spawnBin = opencodeBin;
        spawnArgs = Array.isArray(ocArgs) ? [...ocArgs] : [];
        spawnEnv = {
            ...baseEnv,
            ...(useVCPRouting ? {
                OPENAI_API_KEY: cfg.OPENCODE_API_KEY,
                OPENAI_BASE_URL: cfg.OPENCODE_BASE_URL.replace(/\/v1\/?$/, "") + "/v1",
                ANTHROPIC_API_KEY: "",
                ANTHROPIC_BASE_URL: ""
            } : {
                OPENAI_API_KEY: "",
                OPENAI_BASE_URL: "",
                ANTHROPIC_API_KEY: "",
                ANTHROPIC_BASE_URL: ""
            })
        };
        if (model && !spawnArgs.includes("--model") && !spawnArgs.includes("-m")) {
            spawnArgs.splice(1, 0, "-m", model);
        }
    } else if (worker === "codex") {
        spawnBin = codexBin;
        spawnArgs = Array.isArray(codexArgs) ? [...codexArgs] : [];
        // Codex 登录态与自定义 Provider 依赖当前用户环境；不得套用 opencode 的清空 Key 逻辑。
        spawnEnv = baseEnv;
    } else if (worker === "antigravity") {
        spawnBin = agyBin;
        spawnArgs = Array.isArray(agyArgs) ? [...agyArgs] : [];
        spawnEnv = {
            ...baseEnv,
            https_proxy: agyProxy || "http://127.0.0.1:7890",
            http_proxy: agyProxy || "http://127.0.0.1:7890",
            PATH: `${process.env.HOME || ""}/.local/bin:${process.env.PATH || ""}`
        };
    } else {
        updateMeta(metaPath, meta => {
            meta.state = "failed";
            meta.exitCode = 1;
            meta.completedAt = new Date().toISOString();
            meta.exitReason = `runner 不支持 worker "${worker}"`;
        });
        process.exit(1);
    }

    const outFd = fs.openSync(outputPath, "a");
    const logFd = fs.openSync(logPath, "a");
    let child;
    let spawnError = null;

    try {
        child = spawn(spawnBin, spawnArgs, {
            cwd: projectPath,
            env: spawnEnv,
            stdio: ["ignore", outFd, logFd],
            detached: true,
            windowsHide: true
        });
    } catch (error) {
        spawnError = error;
    }

    if (!child) {
        fs.closeSync(outFd);
        fs.closeSync(logFd);
        const message = spawnError?.message || "无法启动 Worker";
        try { fs.appendFileSync(outputPath, `\n=== 启动失败: ${message} ===\n`); } catch {}
        updateMeta(metaPath, meta => {
            meta.state = "failed";
            meta.exitCode = 1;
            meta.completedAt = new Date().toISOString();
            meta.exitReason = message;
        });
        process.exit(1);
    }

    updateMeta(metaPath, meta => {
        meta.workerPid = child.pid;
        if (worker === "opencode") meta.opencodePid = child.pid;
    });

    let timedOut = false;
    let killTimer = null;
    const timeoutHandle = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid, false);
        killTimer = setTimeout(() => killProcessTree(child.pid, true), 5000);
    }, (timeoutSec || 600) * 1000);

    const exitCode = await new Promise(resolve => {
        let settled = false;
        const finish = code => {
            if (settled) return;
            settled = true;
            resolve(Number.isInteger(code) ? code : 1);
        };
        child.once("error", error => {
            spawnError = error;
            finish(1);
        });
        child.once("close", finish);
    });

    clearTimeout(timeoutHandle);
    if (killTimer) clearTimeout(killTimer);
    fs.closeSync(outFd);
    fs.closeSync(logFd);

    if (worker === "codex" && codexOutputFile && fs.existsSync(codexOutputFile)) {
        try {
            const finalMessage = fs.readFileSync(codexOutputFile, "utf8").trim();
            if (finalMessage) {
                fs.appendFileSync(
                    outputPath,
                    `\n=== Codex Final Message ===\n${finalMessage}\n`,
                    "utf8"
                );
            }
        } catch {}
    }

    const suffix = timedOut
        ? `\n=== 任务超时 (${timeoutSec}s) 已终止 (${new Date().toISOString()}) ===\n`
        : spawnError
            ? `\n=== Worker 错误: ${spawnError.message} (${new Date().toISOString()}) ===\n`
            : `\n=== 完成 (退出码: ${exitCode}, 时间: ${new Date().toISOString()}) ===\n`;
    try { fs.appendFileSync(outputPath, suffix); } catch {}

    updateMeta(metaPath, meta => {
        if (meta.state === "running") {
            meta.state = timedOut ? "timeout" : exitCode === 0 ? "completed" : "failed";
            meta.exitCode = exitCode;
            meta.completedAt = new Date().toISOString();
            if (spawnError) meta.exitReason = spawnError.message;
        }
    });
}

run().catch(error => {
    try { process.stderr.write(String(error?.stack || error)); } catch {}
    process.exit(1);
});
