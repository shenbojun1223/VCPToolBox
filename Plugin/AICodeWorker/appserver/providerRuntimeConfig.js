"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CodexAppServerProcess } = require("./codexAppServerProcess");
const { createProviderRouteCatalog } = require("./providerRoutes");

const DEFAULT_ROUTE_DESCRIPTORS = Object.freeze([
    Object.freeze({
        routeId: "deepseek-official",
        revision: "official-v1",
        upstreamModel: "deepseek-flash",
        reasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
        serviceTiers: ["default", "fast"],
        defaultServiceTier: "default"
    }),
    Object.freeze({
        routeId: "deepseek-commandcode",
        revision: "commandcode-v1",
        upstreamModel: "deepseek/deepseek-v4.1-flash",
        reasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
        serviceTiers: ["default", "fast"],
        defaultServiceTier: "fast"
    })
]);

function resolveIsolatedCodexHome(routeId, pluginDir) {
    if (routeId === "deepseek-official") {
        const candidate = path.join(pluginDir, "jobs", "deepseek-isolated-home-smoke");
        if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "config.toml"))) {
            return candidate;
        }
    } else if (routeId === "deepseek-commandcode") {
        const candidate = path.join(pluginDir, "jobs", "commandcode-isolated-home-smoke");
        if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "config.toml"))) {
            return candidate;
        }
    }
    const userCodex = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex");
    return userCodex;
}

function createDefaultProviderCodexFactory(options = {}) {
    const codexBin = options.codexBin || "codex";
    const pluginDir = options.pluginDir || process.cwd();
    const requestTimeoutMs = options.requestTimeoutMs;
    const versionTimeoutMs = options.versionTimeoutMs;
    const maxCodexFrameBytes = options.maxCodexFrameBytes;

    return function providerCodexFactory(details = {}) {
        const plan = details.plan || {};
        const routeId = plan.routeId;
        const isolatedHome = resolveIsolatedCodexHome(routeId, pluginDir);

        const isolatedEnv = {
            ...process.env,
            CODEX_HOME: isolatedHome
        };

        return new CodexAppServerProcess({
            codexBin,
            cwd: details.projectPath || process.cwd(),
            env: isolatedEnv,
            codexGlobalArgs: [],
            requestTimeoutMs,
            versionTimeoutMs,
            maxCodexFrameBytes
        });
    };
}

function loadProviderRuntimeConfig(options = {}) {
    let catalog = [];
    try {
        catalog = createProviderRouteCatalog(DEFAULT_ROUTE_DESCRIPTORS);
    } catch {
        catalog = [];
    }

    const factory = createDefaultProviderCodexFactory(options);

    return {
        catalog,
        factory
    };
}

module.exports = {
    DEFAULT_ROUTE_DESCRIPTORS,
    loadProviderRuntimeConfig,
    createDefaultProviderCodexFactory
};