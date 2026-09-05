"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const { resolveTrustedGitExecutable } = require("../appserver/trustedGitRuntime");

const trustedGitExecutable = resolveTrustedGitExecutable();
const validationScript = fs.realpathSync.native(path.resolve(__dirname, "../appserver/writeValidation.js"));
const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";

function git(cwd, args) {
    const result = spawnSync(trustedGitExecutable, args, {
        cwd,
        env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: nullConfig,
            GIT_TERMINAL_PROMPT: "0"
        },
        encoding: "utf8",
        shell: false,
        windowsHide: true
    });
    assert.equal(result.status, 0, `fixture git ${args.join(" ")} failed: ${result.stderr}`);
    return result;
}

function driverCommand(scriptPath) {
    const quote = value => `"${value.replace(/\\/g, "/").replace(/"/g, '\\"')}"`;
    return `${quote(process.execPath)} ${quote(scriptPath)}`;
}

function createFixture(label) {
    const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `vcp-aicw-validation-${label}-`)));
    const repoRoot = path.join(tempRoot, "repo");
    const marker = path.join(tempRoot, "filter-marker.txt");
    const driver = path.join(tempRoot, "filter-driver.js");
    const globalConfig = path.join(tempRoot, "isolated-global.gitconfig");
    fs.mkdirSync(repoRoot);
    fs.writeFileSync(driver, [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(marker)}, "executed");`,
        "process.stdin.pipe(process.stdout);"
    ].join(""), "utf8");
    git(repoRoot, ["init", "--quiet"]);
    fs.writeFileSync(path.join(repoRoot, ".gitattributes"), "tracked.txt filter=marker\n", "utf8");
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "baseline\n", "utf8");
    git(repoRoot, ["add", "--", ".gitattributes", "tracked.txt"]);
    git(repoRoot, [
        "-c", "user.name=AICW Test", "-c", "user.email=aicw@example.invalid",
        "commit", "--quiet", "-m", "baseline"
    ]);
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "changed\n", "utf8");
    return { tempRoot, repoRoot, marker, driver, globalConfig };
}

function runValidation(fixture, extraEnvironment = {}) {
    return spawnSync(process.execPath, [validationScript, trustedGitExecutable], {
        cwd: fixture.repoRoot,
        env: { ...process.env, ...extraEnvironment },
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 10_000
    });
}

function cleanupFixture(fixture) {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    assert.equal(fs.existsSync(fixture.tempRoot), false);
}

test("write validation ignores isolated global filters selected by candidate attributes", () => {
    const fixture = createFixture("global");
    try {
        git(fixture.repoRoot, ["config", "--file", fixture.globalConfig, "filter.marker.clean", driverCommand(fixture.driver)]);
        const result = runValidation(fixture, {
            GIT_CONFIG_GLOBAL: fixture.globalConfig,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "filter.injected.clean",
            GIT_CONFIG_VALUE_0: driverCommand(fixture.driver)
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /static validation passed/);
        assert.equal(fs.existsSync(fixture.marker), false, "global or injected filter must not execute");
    } finally {
        cleanupFixture(fixture);
    }
});

test("write validation rejects a local clean filter before diff can execute it", () => {
    const fixture = createFixture("local");
    try {
        git(fixture.repoRoot, ["config", "filter.marker.clean", driverCommand(fixture.driver)]);
        const result = runValidation(fixture);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /clean\/smudge\/process filters are not allowed/);
        assert.equal(fs.existsSync(fixture.marker), false, "local clean filter must be rejected before diff");
    } finally {
        cleanupFixture(fixture);
    }
});
