"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { getProcessIdentity, isPidAlive, terminateOwnedChild } = require("./protocol");

const INTRINSIC_APPLY = Reflect.apply;
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype, "aborted"
).get;
const EVENT_TARGET_ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const EVENT_TARGET_REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;

const SCHEMA_VERSION = 1;
const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const MAX_STEP_TIMEOUT_MS = 300_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 600_000;
const MAX_TOTAL_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 256 * 1024;
const MAX_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_SUMMARY_LIMIT_CHARS = 2048;
const MAX_SUMMARY_LIMIT_CHARS = 8192;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_PROFILE_STEPS = 64;
const MAX_ARG_COUNT = 256;
const MAX_ARG_BYTES = 4096;
const MAX_TOTAL_ARG_BYTES = 32 * 1024;
const IDENTITY_ACQUISITION_TIMEOUT_MS = 750;
const IDENTITY_ATTEMPT_TIMEOUT_MS = 300;
const IDENTITY_RETRY_DELAY_MS = 25;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_DISPLAY = /^[\x20-\x7e]{1,128}$/;

// This is deliberate environment minimization, not OS-level network isolation.
// Profiles are trusted, locally audited administrator code, not untrusted sandbox input.
const ENV_ALLOWLIST = Object.freeze([
    "SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE",
    "HOME", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)",
    "ProgramW6432", "LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE"
]);
const FIXED_ENV = Object.freeze({
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8"
});

class TrustedValidationError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "TrustedValidationError";
        this.code = code;
        this.details = Object.freeze({ ...details });
        if (details.causeCode) this.causeCode = details.causeCode;
    }
}

function validationError(code, message, details) {
    return new TrustedValidationError(code, message, details);
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    try {
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function readExactDataObject(value, allowedKeys, requiredKeys, code, message) {
    if (!isPlainObject(value)) throw validationError(code, message);
    let descriptors;
    let ownKeys;
    try {
        ownKeys = Reflect.ownKeys(value);
        descriptors = Object.create(null);
        for (const key of ownKeys) descriptors[key] = Object.getOwnPropertyDescriptor(value, key);
    } catch {
        throw validationError(code, message);
    }
    for (const key of ownKeys) {
        if (typeof key !== "string" || (allowedKeys && !allowedKeys.has(key))) {
            throw validationError(code, message);
        }
        if (!descriptors[key] || !("value" in descriptors[key])) throw validationError(code, message);
    }
    for (const key of requiredKeys) {
        if (!Object.prototype.hasOwnProperty.call(descriptors, key)) throw validationError(code, message);
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function readDenseArray(value, maxLength, code, message) {
    try {
        if (!Array.isArray(value) || value.length > maxLength) throw validationError(code, message);
        for (const key of Reflect.ownKeys(value)) {
            if (key === "length") continue;
            if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
                throw validationError(code, message);
            }
        }
        const result = [];
        for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (!descriptor || !("value" in descriptor)) throw validationError(code, message);
            result.push(descriptor.value);
        }
        return result;
    } catch {
        throw validationError(code, message);
    }
}

function assertSafeName(value, code, message) {
    if (typeof value !== "string" || !SAFE_NAME.test(value)) throw validationError(code, message);
    return value;
}

function assertCanonicalPath(value, kind, code, message) {
    if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
        throw validationError(code, message);
    }
    let stat;
    let realPath;
    try {
        stat = fs.lstatSync(value);
        realPath = fs.realpathSync.native(value);
    } catch {
        throw validationError(code, message);
    }
    if (stat.isSymbolicLink() || realPath !== value) throw validationError(code, message);
    if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) throw validationError(code, message);
    return realPath;
}

function cloneArgs(args) {
    const values = readDenseArray(
        args, MAX_ARG_COUNT, "AICW_VALIDATION_PROFILE_INVALID", "Validation profile arguments are invalid"
    );
    let totalBytes = 0;
    const clone = values.map(argument => {
        if (typeof argument !== "string" || /[\0\r\n]/.test(argument)) {
            throw validationError("AICW_VALIDATION_PROFILE_INVALID", "Validation profile arguments are invalid");
        }
        const bytes = Buffer.byteLength(argument, "utf8");
        if (bytes > MAX_ARG_BYTES) {
            throw validationError("AICW_VALIDATION_PROFILE_INVALID", "Validation profile arguments are invalid");
        }
        totalBytes += bytes;
        return argument;
    });
    if (totalBytes > MAX_TOTAL_ARG_BYTES) {
        throw validationError("AICW_VALIDATION_PROFILE_INVALID", "Validation profile arguments are invalid");
    }
    return Object.freeze(clone);
}

function boundedInteger(value, fallback, minimum, maximum, code, message) {
    const candidate = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
        throw validationError(code, message);
    }
    return candidate;
}

function cloneProfiles(profiles) {
    if (!isPlainObject(profiles)) {
        throw validationError("AICW_VALIDATION_PROFILE_INVALID", "Validation profiles are invalid");
    }
    const source = readExactDataObject(
        profiles,
        null,
        [],
        "AICW_VALIDATION_PROFILE_INVALID",
        "Validation profiles are invalid"
    );
    const clone = Object.create(null);
    for (const [profileName, profileValue] of Object.entries(source)) {
        assertSafeName(profileName, "AICW_VALIDATION_PROFILE_INVALID", "Validation profile name is invalid");
        const profile = readExactDataObject(
            profileValue,
            new Set(["steps"]),
            ["steps"],
            "AICW_VALIDATION_PROFILE_INVALID",
            "Validation profile is invalid"
        );
        const sourceSteps = readDenseArray(
            profile.steps,
            MAX_PROFILE_STEPS,
            "AICW_VALIDATION_PROFILE_INVALID",
            "Validation profile steps are invalid"
        );
        if (sourceSteps.length === 0) {
            throw validationError("AICW_VALIDATION_PROFILE_INVALID", "Validation profile steps are invalid");
        }
        const names = new Set();
        const steps = sourceSteps.map(stepValue => {
            const step = readExactDataObject(
                stepValue,
                new Set(["name", "display", "executable", "args", "timeoutMs"]),
                ["name", "display", "executable", "args", "timeoutMs"],
                "AICW_VALIDATION_PROFILE_INVALID",
                "Validation profile step is invalid"
            );
            const name = assertSafeName(
                step.name, "AICW_VALIDATION_PROFILE_INVALID", "Validation step name is invalid"
            );
            if (names.has(name)) {
                throw validationError("AICW_VALIDATION_PROFILE_INVALID", "Validation step names must be unique");
            }
            names.add(name);
            if (typeof step.display !== "string" || !SAFE_DISPLAY.test(step.display)) {
                throw validationError("AICW_VALIDATION_PROFILE_INVALID", "Validation step display is invalid");
            }
            const executable = assertCanonicalPath(
                step.executable,
                "file",
                "AICW_VALIDATION_PROFILE_INVALID",
                "Validation executable is not a canonical regular file"
            );
            const timeoutMs = boundedInteger(
                step.timeoutMs,
                DEFAULT_STEP_TIMEOUT_MS,
                25,
                MAX_STEP_TIMEOUT_MS,
                "AICW_VALIDATION_PROFILE_INVALID",
                "Validation step timeout is invalid"
            );
            return Object.freeze({
                name,
                display: step.display,
                executable,
                args: cloneArgs(step.args),
                timeoutMs
            });
        });
        clone[profileName] = Object.freeze({ steps: Object.freeze(steps) });
    }
    return Object.freeze(clone);
}

function buildTrustedEnvironment(hostEnvironment) {
    const result = Object.create(null);
    const hostKeys = Object.keys(hostEnvironment);
    for (const allowedName of ENV_ALLOWLIST) {
        const actualName = process.platform === "win32"
            ? hostKeys.find(name => name.toLowerCase() === allowedName.toLowerCase())
            : allowedName;
        if (actualName && typeof hostEnvironment[actualName] === "string") {
            result[allowedName] = hostEnvironment[actualName];
        }
    }
    return { ...result, ...FIXED_ENV };
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactSummary(buffer, limit, sensitiveValues) {
    let text = buffer.toString("utf8");
    const privateKeyBlock = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi;
    text = text.replace(privateKeyBlock, "[REDACTED_PRIVATE_KEY]");
    text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [REDACTED]");
    text = text.replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[REDACTED_API_KEY]");
    text = text.replace(/\bgh[pousr]_[A-Za-z0-9]{10,}\b/gi, "[REDACTED_GITHUB_TOKEN]");
    text = text.replace(/\bgithub_pat_[A-Za-z0-9_]{10,}\b/gi, "[REDACTED_GITHUB_TOKEN]");
    text = text.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_ACCESS_KEY]");
    text = text.replace(
        /\b(api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|client[_-]?secret)\b\s*[:=]\s*(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|[^\s,;]{4,})/gi,
        "$1=[REDACTED]"
    );
    const replacements = new Set();
    for (const value of sensitiveValues) {
        if (typeof value !== "string" || value.length < 2) continue;
        replacements.add(value);
        replacements.add(JSON.stringify(value).slice(1, -1));
    }
    for (const value of [...replacements].sort((left, right) => right.length - left.length)) {
        text = text.replace(new RegExp(escapeRegExp(value), process.platform === "win32" ? "gi" : "g"), "[REDACTED_PATH]");
    }
    text = text
        .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?");
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function safeCauseCode(value, fallback) {
    const candidate = typeof value === "string" ? value.toUpperCase() : "";
    return /^[A-Z0-9_]{1,64}$/.test(candidate) ? candidate : fallback;
}

function terminationCauseCode(outcome) {
    if (outcome?.identityMismatch) return "PROCESS_IDENTITY_MISMATCH";
    if (outcome?.identityMissing) return "PROCESS_IDENTITY_UNAVAILABLE";
    if (outcome?.stillAlive) return "PROCESS_STILL_ALIVE";
    if (outcome?.treeKillAttempted && outcome?.treeKillSucceeded === false) {
        return "PROCESS_TREE_TERMINATION_FAILED";
    }
    if (outcome?.forceSent === false) return "PROCESS_FORCE_TERMINATION_FAILED";
    return "PROCESS_TERMINATION_NOT_CONFIRMED";
}

function readTrustedAbortState(signal) {
    if (signal === undefined) return false;
    try {
        const aborted = INTRINSIC_APPLY(ABORT_SIGNAL_ABORTED_GETTER, signal, []);
        if (typeof aborted !== "boolean") throw new TypeError("Invalid AbortSignal state");
        return aborted;
    } catch {
        throw validationError("AICW_VALIDATION_REQUEST_INVALID", "Validation signal is invalid");
    }
}

function childHasExited(child) {
    return (child?.exitCode !== null && child?.exitCode !== undefined) ||
        (child?.signalCode !== null && child?.signalCode !== undefined);
}

function isUsableProcessIdentity(identity, pid) {
    return Boolean(identity && typeof identity === "object" && Number(identity.pid) === pid &&
        (identity.startTimeTicks || identity.startTime));
}

async function acquireChildIdentity(child, identityProvider, shouldStop) {
    const pid = Number(child?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const deadline = Date.now() + IDENTITY_ACQUISITION_TIMEOUT_MS;
    while (!shouldStop() && !childHasExited(child)) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        let identity = null;
        try {
            identity = identityProvider(pid, {
                timeoutMs: Math.min(IDENTITY_ATTEMPT_TIMEOUT_MS, Math.max(50, remainingMs))
            });
        } catch {}
        if (shouldStop() || childHasExited(child)) return null;
        if (isUsableProcessIdentity(identity, pid)) return identity;
        let alive = false;
        try { alive = isPidAlive(pid); } catch {}
        if (!alive) return null;
        const delayMs = Math.min(IDENTITY_RETRY_DELAY_MS, Math.max(0, deadline - Date.now()));
        if (delayMs <= 0) break;
        await new Promise(resolve => {
            setTimeout(resolve, delayMs);
        });
    }
    return null;
}

class TrustedValidationRunner {
    #profiles;
    #totalTimeoutMs;
    #outputLimitBytes;
    #summaryLimitChars;
    #terminationHelper;
    #identityProvider;

    constructor(options = {}) {
        const parsed = readExactDataObject(
            options,
            new Set([
                "profiles", "totalTimeoutMs", "outputLimitBytes", "summaryLimitChars",
                "terminationHelper", "identityProvider"
            ]),
            ["profiles"],
            "AICW_VALIDATION_PROFILE_INVALID",
            "Validation runner options are invalid"
        );
        this.#profiles = cloneProfiles(parsed.profiles);
        this.#totalTimeoutMs = boundedInteger(
            parsed.totalTimeoutMs,
            DEFAULT_TOTAL_TIMEOUT_MS,
            25,
            MAX_TOTAL_TIMEOUT_MS,
            "AICW_VALIDATION_PROFILE_INVALID",
            "Validation total timeout is invalid"
        );
        this.#outputLimitBytes = boundedInteger(
            parsed.outputLimitBytes,
            DEFAULT_OUTPUT_LIMIT_BYTES,
            16,
            MAX_OUTPUT_LIMIT_BYTES,
            "AICW_VALIDATION_PROFILE_INVALID",
            "Validation output limit is invalid"
        );
        this.#summaryLimitChars = boundedInteger(
            parsed.summaryLimitChars,
            DEFAULT_SUMMARY_LIMIT_CHARS,
            16,
            MAX_SUMMARY_LIMIT_CHARS,
            "AICW_VALIDATION_PROFILE_INVALID",
            "Validation summary limit is invalid"
        );
        if (parsed.terminationHelper !== undefined && typeof parsed.terminationHelper !== "function") {
            throw validationError("AICW_VALIDATION_PROFILE_INVALID", "Validation termination helper is invalid");
        }
        if (parsed.identityProvider !== undefined && typeof parsed.identityProvider !== "function") {
            throw validationError("AICW_VALIDATION_PROFILE_INVALID", "Validation identity provider is invalid");
        }
        // Test seams only: process spawning itself is intentionally not injectable.
        this.#terminationHelper = parsed.terminationHelper || terminateOwnedChild;
        this.#identityProvider = parsed.identityProvider || getProcessIdentity;
    }

    async run(request) {
        const parsed = readExactDataObject(
            request,
            new Set(["profile", "worktreeRoot", "signal"]),
            ["profile", "worktreeRoot"],
            "AICW_VALIDATION_REQUEST_INVALID",
            "Validation request contains unsupported or missing fields"
        );
        assertSafeName(parsed.profile, "AICW_VALIDATION_REQUEST_INVALID", "Validation profile name is invalid");
        const initiallyAborted = readTrustedAbortState(parsed.signal);
        const profile = this.#profiles[parsed.profile];
        if (!profile) throw validationError("AICW_VALIDATION_PROFILE_UNKNOWN", "Validation profile is not registered");
        const worktreeRoot = assertCanonicalPath(
            parsed.worktreeRoot,
            "directory",
            "AICW_VALIDATION_WORKTREE_INVALID",
            "Validation worktree root is not a canonical directory"
        );
        if (initiallyAborted) {
            throw validationError("AICW_VALIDATION_CANCELLED", "Validation was cancelled", { causeCode: "ABORTED_BEFORE_START" });
        }

        const started = Date.now();
        const deadline = started + this.#totalTimeoutMs;
        const steps = [];
        for (const step of profile.steps) {
            if (readTrustedAbortState(parsed.signal)) {
                throw validationError("AICW_VALIDATION_CANCELLED", "Validation was cancelled", {
                    causeCode: "ABORTED_BETWEEN_STEPS",
                    step: step.name
                });
            }
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                throw validationError("AICW_VALIDATION_STEP_TIMEOUT", "Validation total timeout was exceeded", {
                    causeCode: "TOTAL_TIMEOUT",
                    step: step.name,
                    timedOut: true
                });
            }
            assertCanonicalPath(
                step.executable,
                "file",
                "AICW_VALIDATION_SPAWN_FAILED",
                "Validation executable is no longer an available canonical regular file"
            );
            steps.push(await this.#runStep(step, worktreeRoot, parsed.signal, remainingMs));
        }
        return Object.freeze({
            schemaVersion: SCHEMA_VERSION,
            profile: parsed.profile,
            passed: true,
            startedAt: new Date(started).toISOString(),
            completedAt: new Date().toISOString(),
            steps: Object.freeze(steps)
        });
    }

    #runStep(step, worktreeRoot, signal, remainingMs) {
        const effectiveTimeoutMs = Math.max(1, Math.min(step.timeoutMs, remainingMs));
        const timeoutCause = remainingMs <= step.timeoutMs ? "TOTAL_TIMEOUT" : "STEP_TIMEOUT";
        const environment = buildTrustedEnvironment(process.env);
        return new Promise((resolve, reject) => {
            let child;
            let identityPromise = null;
            let timer = null;
            let abortListenerRegistered = false;
            let settled = false;
            let stopping = null;
            let stdoutBytes = 0;
            let stderrBytes = 0;
            const stdoutChunks = [];
            const stderrChunks = [];
            let stdoutCaptured = 0;
            let stderrCaptured = 0;

            const summaries = () => ({
                stdoutSummary: redactSummary(Buffer.concat(stdoutChunks), this.#summaryLimitChars, [worktreeRoot, step.executable]),
                stderrSummary: redactSummary(Buffer.concat(stderrChunks), this.#summaryLimitChars, [worktreeRoot, step.executable])
            });
            const projection = (status, exitCode, processSignal, timedOut) => Object.freeze({
                name: step.name,
                display: step.display,
                status,
                exitCode: Number.isInteger(exitCode) ? exitCode : null,
                signal: typeof processSignal === "string" ? processSignal : null,
                timedOut,
                stdoutBytes,
                stderrBytes,
                ...summaries()
            });
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                timer = null;
                if (abortListenerRegistered) {
                    try {
                        INTRINSIC_APPLY(EVENT_TARGET_REMOVE_EVENT_LISTENER, signal, ["abort", onAbort]);
                    } catch {}
                    abortListenerRegistered = false;
                }
                try { child?.removeListener("error", onError); } catch {}
                try { child?.removeListener("close", onClose); } catch {}
                try { child?.stdout?.removeListener("data", onStdout); } catch {}
                try { child?.stderr?.removeListener("data", onStderr); } catch {}
            };
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error); else resolve(value);
            };
            const stopError = reason => {
                const status = reason.status || (reason.code === "AICW_VALIDATION_CANCELLED"
                    ? "cancelled"
                    : reason.code === "AICW_VALIDATION_OUTPUT_LIMIT" ? "output_limit" : "timed_out");
                return validationError(reason.code, reason.message, {
                    causeCode: reason.causeCode,
                    ...projection(status, child?.exitCode, child?.signalCode, reason.code === "AICW_VALIDATION_STEP_TIMEOUT")
                });
            };
            const requestStop = reason => {
                if (settled || stopping) return;
                stopping = reason;
                if (timer) clearTimeout(timer);
                timer = null;
                Promise.resolve(identityPromise)
                    .catch(() => null)
                    .then(identity => this.#terminationHelper(child, {
                        identity,
                        requireProcessTree: true
                    }))
                    .then(outcome => {
                        if (outcome?.confirmed !== true) {
                            const causeCode = terminationCauseCode(outcome);
                            finish(validationError(
                                "AICW_VALIDATION_TERMINATION_UNCONFIRMED",
                                "Validation child termination could not be confirmed",
                                {
                                    causeCode,
                                    requestedCode: reason.code,
                                    ...projection("termination_unconfirmed", child?.exitCode, child?.signalCode, reason.code === "AICW_VALIDATION_STEP_TIMEOUT")
                                }
                            ));
                            return;
                        }
                        finish(stopError(reason));
                    })
                    .catch(error => {
                        const causeCode = safeCauseCode(error?.code, "TERMINATION_HELPER_FAILED");
                        finish(validationError(
                            "AICW_VALIDATION_TERMINATION_UNCONFIRMED",
                            "Validation child termination could not be confirmed",
                            {
                                causeCode,
                                requestedCode: reason.code,
                                ...projection("termination_unconfirmed", child?.exitCode, child?.signalCode, reason.code === "AICW_VALIDATION_STEP_TIMEOUT")
                            }
                        ));
                    });
            };
            const append = (streamName, chunk) => {
                const bytes = Buffer.from(chunk);
                if (streamName === "stdout") {
                    stdoutBytes = Math.min(Number.MAX_SAFE_INTEGER, stdoutBytes + bytes.length);
                    const available = Math.max(0, MAX_CAPTURE_BYTES - stdoutCaptured);
                    if (available > 0) {
                        const captured = bytes.subarray(0, available);
                        stdoutChunks.push(captured);
                        stdoutCaptured += captured.length;
                    }
                    if (stdoutBytes > this.#outputLimitBytes) requestStop({
                        code: "AICW_VALIDATION_OUTPUT_LIMIT",
                        message: "Validation stdout exceeded its byte limit",
                        causeCode: "STDOUT_LIMIT"
                    });
                } else {
                    stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + bytes.length);
                    const available = Math.max(0, MAX_CAPTURE_BYTES - stderrCaptured);
                    if (available > 0) {
                        const captured = bytes.subarray(0, available);
                        stderrChunks.push(captured);
                        stderrCaptured += captured.length;
                    }
                    if (stderrBytes > this.#outputLimitBytes) requestStop({
                        code: "AICW_VALIDATION_OUTPUT_LIMIT",
                        message: "Validation stderr exceeded its byte limit",
                        causeCode: "STDERR_LIMIT"
                    });
                }
            };
            const onStdout = chunk => append("stdout", chunk);
            const onStderr = chunk => append("stderr", chunk);
            const onAbort = () => requestStop({
                code: "AICW_VALIDATION_CANCELLED",
                message: "Validation was cancelled",
                causeCode: "ABORT_SIGNAL"
            });
            const onError = error => {
                if (stopping) return;
                finish(validationError("AICW_VALIDATION_SPAWN_FAILED", "Validation process could not be started", {
                    causeCode: safeCauseCode(error?.code, "SPAWN_ERROR"),
                    ...projection("spawn_failed", null, null, false)
                }));
            };
            const onClose = (code, processSignal) => {
                if (stopping) return;
                const result = projection(code === 0 ? "passed" : "failed", code, processSignal, false);
                if (code === 0) finish(null, result);
                else finish(validationError("AICW_VALIDATION_STEP_FAILED", "Validation step failed", result));
            };

            if (signal !== undefined) {
                try {
                    INTRINSIC_APPLY(EVENT_TARGET_ADD_EVENT_LISTENER, signal, ["abort", onAbort, { once: true }]);
                    abortListenerRegistered = true;
                    if (readTrustedAbortState(signal)) {
                        finish(validationError("AICW_VALIDATION_CANCELLED", "Validation was cancelled", {
                            causeCode: "ABORTED_BEFORE_SPAWN"
                        }));
                        return;
                    }
                } catch {
                    finish(validationError(
                        "AICW_VALIDATION_REQUEST_INVALID",
                        "Validation signal listener could not be registered",
                        { causeCode: "SIGNAL_LISTENER_REGISTRATION_FAILED" }
                    ));
                    return;
                }
            }

            try {
                child = spawn(step.executable, step.args, {
                    cwd: worktreeRoot,
                    env: environment,
                    shell: false,
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "pipe"]
                });
            } catch (error) {
                finish(validationError("AICW_VALIDATION_SPAWN_FAILED", "Validation process could not be started", {
                    causeCode: safeCauseCode(error?.code, "SPAWN_THROW")
                }));
                return;
            }
            identityPromise = Promise.resolve().then(() => acquireChildIdentity(
                child,
                this.#identityProvider,
                () => settled
            ));
            try {
                child.once("error", onError);
                child.once("close", onClose);
                child.stdout?.on("data", onStdout);
                child.stderr?.on("data", onStderr);
            } catch {
                requestStop({
                    code: "AICW_VALIDATION_SPAWN_FAILED",
                    message: "Validation process listener setup failed",
                    causeCode: "PROCESS_LISTENER_REGISTRATION_FAILED",
                    status: "spawn_failed"
                });
                return;
            }
            timer = setTimeout(() => requestStop({
                code: "AICW_VALIDATION_STEP_TIMEOUT",
                message: timeoutCause === "TOTAL_TIMEOUT"
                    ? "Validation total timeout was exceeded"
                    : "Validation step timed out",
                causeCode: timeoutCause
            }), effectiveTimeoutMs);
            timer.unref?.();
            try {
                if (readTrustedAbortState(signal)) onAbort();
            } catch {
                requestStop({
                    code: "AICW_VALIDATION_REQUEST_INVALID",
                    message: "Validation signal became invalid",
                    causeCode: "SIGNAL_STATE_READ_FAILED",
                    status: "invalid_signal"
                });
            }
        });
    }
}

module.exports = {
    TrustedValidationRunner,
    TrustedValidationError
};
