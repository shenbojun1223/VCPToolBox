"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { TrustedValidationRunner } = require("./trustedValidationRunner");
const { resolveTrustedGitExecutable } = require("./trustedGitRuntime");

const APP_SERVER_MAX_CONCURRENCY = 3;
const WRITE_MAX_CONCURRENCY = 2;
const WRITE_PROTOCOL_VERSION = 2;
const WRITE_VALIDATION_PROFILE = "builtin-static-v1";
const WRITE_WORKSPACE_POLICY = "server-generated-locked-git-worktree";
const WRITE_VALIDATION_POLICY = "builtin-diff-json-js-syntax";

function readEnvFile(filePath) {
    const result = Object.create(null);
    if (!fs.existsSync(filePath)) return result;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const separator = trimmed.indexOf("=");
        if (separator < 1) continue;
        const key = trimmed.slice(0, separator).trim();
        const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
        result[key] = value;
    }
    return result;
}

function canonicalDirectory(value) {
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || !path.isAbsolute(value)) {
        return null;
    }
    try {
        const resolved = path.resolve(value);
        const stat = fs.lstatSync(resolved);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        return fs.realpathSync.native(resolved);
    } catch {
        return null;
    }
}

function unavailable(enabled, errorCode = null) {
    return Object.freeze({
        enabled,
        available: false,
        errorCode,
        allowedProjectRoots: Object.freeze([]),
        workspaceBaseRoot: null,
        validationProfile: null,
        validationRunner: null
    });
}

function loadWriteRuntimeConfig(pluginDir) {
    const canonicalPluginDir = canonicalDirectory(path.resolve(pluginDir || process.cwd()));
    if (!canonicalPluginDir) return unavailable(false, "AICW_WRITE_PLUGIN_DIR_INVALID");
    let raw;
    try {
        raw = readEnvFile(path.join(canonicalPluginDir, "config.env"));
    } catch {
        return unavailable(false, "AICW_WRITE_CONFIG_READ_FAILED");
    }
    const enabled = String(raw.ENABLE_CODEX_APP_SERVER_WRITE || "").trim().toLowerCase() === "true";
    if (!enabled) return unavailable(false);

    const workspaceBaseRoot = canonicalDirectory(raw.CODEX_APP_SERVER_WRITE_WORKSPACE_ROOT);
    if (!workspaceBaseRoot) return unavailable(true, "AICW_WRITE_WORKSPACE_ROOT_INVALID");
    const requestedRoots = String(raw.CODEX_APP_SERVER_WRITE_ALLOWED_PROJECT_ROOTS || "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean);
    if (requestedRoots.length === 0) return unavailable(true, "AICW_WRITE_ALLOWED_ROOTS_MISSING");
    const allowedProjectRoots = requestedRoots.map(canonicalDirectory);
    if (allowedProjectRoots.some(value => !value)) {
        return unavailable(true, "AICW_WRITE_ALLOWED_ROOT_INVALID");
    }

    let executable;
    let validationScript;
    let gitExecutable;
    try {
        executable = fs.realpathSync.native(process.execPath);
        validationScript = fs.realpathSync.native(path.join(__dirname, "writeValidation.js"));
        gitExecutable = resolveTrustedGitExecutable();
        if (!fs.lstatSync(executable).isFile() || !fs.lstatSync(validationScript).isFile()) {
            return unavailable(true, "AICW_WRITE_VALIDATION_UNAVAILABLE");
        }
    } catch {
        return unavailable(true, "AICW_WRITE_VALIDATION_UNAVAILABLE");
    }

    try {
        const validationRunner = new TrustedValidationRunner({
            profiles: {
                [WRITE_VALIDATION_PROFILE]: {
                    steps: [{
                        name: "builtin-static",
                        display: "Built-in diff, JSON, and JavaScript syntax checks",
                        executable,
                        args: [validationScript, gitExecutable],
                        timeoutMs: 120_000
                    }]
                }
            },
            totalTimeoutMs: 180_000
        });
        return Object.freeze({
            enabled: true,
            available: true,
            errorCode: null,
            allowedProjectRoots: Object.freeze([...new Set(allowedProjectRoots)]),
            workspaceBaseRoot,
            validationProfile: WRITE_VALIDATION_PROFILE,
            validationRunner
        });
    } catch {
        return unavailable(true, "AICW_WRITE_VALIDATION_UNAVAILABLE");
    }
}

function getWriteProtocolStatus(options = {}) {
    return {
        writeProtocolSupported: true,
        writeProtocolVersion: WRITE_PROTOCOL_VERSION,
        writeConfigured: options.configured === true,
        writeConfigurationErrorCode: typeof options.errorCode === "string" ? options.errorCode.slice(0, 64) : null,
        writeMaxConcurrency: WRITE_MAX_CONCURRENCY,
        writeWorkspacePolicy: WRITE_WORKSPACE_POLICY,
        writeValidationPolicy: WRITE_VALIDATION_POLICY,
        writeValidationProfile: options.configured === true ? WRITE_VALIDATION_PROFILE : null
    };
}

function isWriteProtocolProof(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
        value.writeProtocolSupported === true &&
        value.writeProtocolVersion === WRITE_PROTOCOL_VERSION &&
        value.writeMaxConcurrency === WRITE_MAX_CONCURRENCY &&
        value.writeWorkspacePolicy === WRITE_WORKSPACE_POLICY &&
        value.writeValidationPolicy === WRITE_VALIDATION_POLICY);
}

function projectWriteProtocolStatus(value, missingState = "unknown") {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const supported = isWriteProtocolProof(source)
        ? true
        : source.writeProtocolSupported === false || Object.prototype.hasOwnProperty.call(source, "writeProtocolSupported")
            ? false
            : missingState;
    return {
        writeProtocolSupported: supported,
        writeProtocolVersion: Number.isSafeInteger(source.writeProtocolVersion) ? source.writeProtocolVersion : null,
        writeConfigured: supported === true && source.writeConfigured === true,
        writeConfigurationErrorCode: typeof source.writeConfigurationErrorCode === "string"
            ? source.writeConfigurationErrorCode.slice(0, 64)
            : null,
        writeMaxConcurrency: Number.isSafeInteger(source.writeMaxConcurrency) ? source.writeMaxConcurrency : null,
        writeWorkspacePolicy: typeof source.writeWorkspacePolicy === "string" ? source.writeWorkspacePolicy : null,
        writeValidationPolicy: typeof source.writeValidationPolicy === "string" ? source.writeValidationPolicy : null,
        writeValidationProfile: typeof source.writeValidationProfile === "string" ? source.writeValidationProfile : null
    };
}

module.exports = {
    APP_SERVER_MAX_CONCURRENCY,
    WRITE_MAX_CONCURRENCY,
    WRITE_PROTOCOL_VERSION,
    WRITE_VALIDATION_PROFILE,
    loadWriteRuntimeConfig,
    getWriteProtocolStatus,
    isWriteProtocolProof,
    projectWriteProtocolStatus
};
