"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
    FILTER_CONFIG_QUERY_ARGS,
    TRUSTED_GIT_CONFIG_ARGS,
    trustedGitEnvironment,
    unsafeFilterConfigResult
} = require("./trustedGitRuntime");

const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

function run(executable, args, options = {}) {
    const result = spawnSync(executable, args, {
        cwd: process.cwd(),
        env: options.env,
        encoding: "buffer",
        shell: false,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: MAX_GIT_OUTPUT,
        stdio: ["ignore", "pipe", "pipe"]
    });
    const acceptedStatuses = options.acceptedStatuses || [0];
    if (result.error || !acceptedStatuses.includes(result.status)) {
        const code = result.error?.code || `EXIT_${result.status ?? "UNKNOWN"}`;
        throw new Error(`${path.basename(executable)} validation command failed: ${code}`);
    }
    return {
        code: result.status,
        stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "")
    };
}

function nulPaths(buffer) {
    return buffer.toString("utf8").split("\0").filter(Boolean);
}

function readTrustedGitExecutable() {
    if (process.argv.length !== 3) throw new Error("Trusted Git executable argument is missing");
    const executable = process.argv[2];
    if (typeof executable !== "string" || executable.includes("\0") || !path.isAbsolute(executable) ||
        path.resolve(executable) !== executable) {
        throw new Error("Trusted Git executable argument is invalid");
    }
    try {
        const stat = fs.lstatSync(executable);
        const realPath = fs.realpathSync.native(executable);
        if (!stat.isFile() || stat.isSymbolicLink() || realPath !== executable) {
            throw new Error("Trusted Git executable is not canonical");
        }
    } catch (error) {
        if (/^Trusted Git executable/.test(String(error?.message || ""))) throw error;
        throw new Error("Trusted Git executable is unavailable");
    }
    return executable;
}

function main() {
    const gitExecutable = readTrustedGitExecutable();
    const gitEnvironment = trustedGitEnvironment();
    const git = (args, options) => run(
        gitExecutable,
        [...TRUSTED_GIT_CONFIG_ARGS, ...args],
        { ...options, env: gitEnvironment }
    );
    const filterConfig = git(FILTER_CONFIG_QUERY_ARGS, { acceptedStatuses: [0, 1] });
    if (unsafeFilterConfigResult(filterConfig)) {
        throw new Error("Candidate clean/smudge/process filters are not allowed");
    }
    git(["diff", "--no-ext-diff", "--no-textconv", "--check", "HEAD", "--"]);
    const changed = new Set([
        ...nulPaths(git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "HEAD", "--"]).stdout),
        ...nulPaths(git(["ls-files", "--others", "--exclude-standard", "-z", "--"]).stdout)
    ]);

    let jsonFiles = 0;
    let javascriptFiles = 0;
    for (const relativePath of changed) {
        const absolutePath = path.resolve(process.cwd(), relativePath);
        const relative = path.relative(process.cwd(), absolutePath);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error("Changed path escaped the Worktree");
        }
        if (!fs.existsSync(absolutePath)) continue;
        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) throw new Error("Changed symbolic links are not validated by this profile");
        if (!stat.isFile()) continue;
        const extension = path.extname(absolutePath).toLowerCase();
        if (extension === ".json") {
            if (stat.size > MAX_JSON_BYTES) throw new Error("Changed JSON file exceeds the built-in validation limit");
            JSON.parse(fs.readFileSync(absolutePath, "utf8"));
            jsonFiles++;
        } else if ([".js", ".cjs", ".mjs"].includes(extension)) {
            run(process.execPath, ["--check", absolutePath]);
            javascriptFiles++;
        }
    }
    process.stdout.write(`static validation passed: diff-check=1 json=${jsonFiles} javascript=${javascriptFiles}\n`);
}

try {
    main();
} catch (error) {
    process.stderr.write(`${String(error?.message || "static validation failed").slice(0, 500)}\n`);
    process.exitCode = 1;
}
