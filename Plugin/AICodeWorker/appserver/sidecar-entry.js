"use strict";

const { SidecarServer } = require("./sidecarServer");
const { loadWriteRuntimeConfig } = require("./writeRuntimeConfig");

function parseArgs(argv) {
    const result = {
        pluginDir: process.cwd(),
        jobRoot: "",
        codexBin: "codex",
        codexGlobalArgs: [],
        maxConcurrency: 2,
        testStartupDelayMs: 0
    };
    const valueFlags = new Map([
        ["--plugin-dir", "pluginDir"],
        ["--job-root", "jobRoot"],
        ["--codex-bin", "codexBin"],
        ["--codex-global-args", "codexGlobalArgs"],
        ["--max-concurrency", "maxConcurrency"],
        ["--test-startup-delay-ms", "testStartupDelayMs"]
    ]);
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        const key = valueFlags.get(flag);
        if (!key || index + 1 >= argv.length) throw new Error("invalid sidecar arguments");
        result[key] = argv[++index];
    }
    if (!result.jobRoot) throw new Error("jobRoot is required");
    try { result.codexGlobalArgs = JSON.parse(result.codexGlobalArgs); } catch { throw new Error("codexGlobalArgs must be JSON array"); }
    if (!Array.isArray(result.codexGlobalArgs)) throw new Error("codexGlobalArgs must be JSON array");
    result.maxConcurrency = Number(result.maxConcurrency);
    if (!Number.isInteger(result.maxConcurrency) || result.maxConcurrency < 1 || result.maxConcurrency > 32) {
        throw new Error("maxConcurrency is invalid");
    }
    result.testStartupDelayMs = Number(result.testStartupDelayMs);
    if (!Number.isInteger(result.testStartupDelayMs) || result.testStartupDelayMs < 0 || result.testStartupDelayMs > 60000) {
        throw new Error("testStartupDelayMs is invalid");
    }
    return result;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const writeRuntime = loadWriteRuntimeConfig(options.pluginDir);
    const server = new SidecarServer({
        ...options,
        writeEnabled: writeRuntime.enabled,
        writeConfigurationErrorCode: writeRuntime.errorCode,
        writeAllowedProjectRoots: writeRuntime.allowedProjectRoots,
        writeWorkspaceBaseRoot: writeRuntime.workspaceBaseRoot,
        writeValidationRunner: writeRuntime.validationRunner,
        writeValidationProfile: writeRuntime.validationProfile
    });
    let signalPromise = null;
    const onSignal = () => {
        if (!signalPromise) signalPromise = server.shutdown().catch(() => {});
        return signalPromise;
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    await server.start();
    if (signalPromise) await signalPromise;
}

main().catch(error => {
    const code = String(error?.code || "SIDECAR_START_FAILED").replace(/[^A-Z0-9_-]/g, "_").slice(0, 64);
    process.stderr.write(`AICodeWorker Sidecar startup failed: ${code}\n`);
    process.exitCode = 1;
});
