"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FILTER_CONFIG_QUERY_ARGS = Object.freeze([
    "config", "--includes", "--null", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"
]);
const TRUSTED_GIT_CONFIG_ARGS = Object.freeze([
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "commit.gpgSign=false",
    "-c", "tag.gpgSign=false"
]);
let trustedGitExecutable = null;

class TrustedGitRuntimeError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "TrustedGitRuntimeError";
        this.code = code;
    }
}

function hostPathValue() {
    if (process.platform !== "win32") return process.env.PATH || "";
    const key = Object.keys(process.env).find(name => name.toLowerCase() === "path");
    return key ? process.env[key] || "" : "";
}

function resolveTrustedGitExecutable() {
    if (trustedGitExecutable) return trustedGitExecutable;
    const executableNames = process.platform === "win32" ? ["git.exe", "git.com"] : ["git"];
    for (const rawEntry of hostPathValue().split(path.delimiter)) {
        const entry = rawEntry.trim().replace(/^"(.*)"$/, "$1");
        if (!entry || entry.includes("\0") || !path.isAbsolute(entry)) continue;
        for (const executableName of executableNames) {
            const candidate = path.join(path.resolve(entry), executableName);
            try {
                const realPath = fs.realpathSync.native(candidate);
                if (!path.isAbsolute(realPath) || !fs.statSync(realPath).isFile()) continue;
                trustedGitExecutable = realPath;
                return trustedGitExecutable;
            } catch {}
        }
    }
    throw new TrustedGitRuntimeError(
        "AICW_TRUSTED_GIT_UNAVAILABLE",
        "A trusted absolute Git executable could not be resolved from host PATH"
    );
}

function trustedGitEnvironment(options = {}) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^GIT_/i.test(key) || ["EMAIL", "VISUAL", "EDITOR", "PAGER"].includes(key.toUpperCase())) {
            delete env[key];
        }
    }
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
    env.GIT_ATTR_NOSYSTEM = "1";
    env.GIT_NO_REPLACE_OBJECTS = "1";
    env.GIT_OPTIONAL_LOCKS = "0";
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_PAGER = "cat";
    env.GCM_INTERACTIVE = "Never";
    if (options.candidateIdentity === true) {
        env.GIT_AUTHOR_NAME = "VCP AICodeWorker";
        env.GIT_AUTHOR_EMAIL = "aicodeworker@invalid.example";
        env.GIT_COMMITTER_NAME = "VCP AICodeWorker";
        env.GIT_COMMITTER_EMAIL = "aicodeworker@invalid.example";
    }
    return Object.freeze(env);
}

function unsafeFilterConfigResult(result) {
    return Boolean(result && (result.code === 0 || Buffer.from(result.stdout || "").length !== 0));
}

module.exports = {
    FILTER_CONFIG_QUERY_ARGS,
    TRUSTED_GIT_CONFIG_ARGS,
    TrustedGitRuntimeError,
    resolveTrustedGitExecutable,
    trustedGitEnvironment,
    unsafeFilterConfigResult
};
