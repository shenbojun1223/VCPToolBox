'use strict';
// Production gate is evaluated in a VM with FAKE fs, process, parser and spawn.
// No sample can reach a real shell, filesystem write or production credential.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const security = require('../Plugin/PowerShellExecutor/commandSecurity');
const pluginDir = path.resolve(__dirname, '../Plugin/PowerShellExecutor');
const source = fs.readFileSync(path.join(pluginDir, 'PowerShellExecutor.js'), 'utf8');
const securitySource = fs.readFileSync(path.join(pluginDir, 'commandSecurity.js'), 'utf8');
const forbidden = ['rm', 'del', 'format', 'rmdir'];
const auth = ['Set-Content', 'Remove-Item'];
const FAKE_CODE = 'unit-test-code-not-a-credential';

function decision(name) {
    return security.evaluateFacts({ version: 1, results: [{
        errors: [], facts: [{
            kind: 'command', name, resolved: name, inlineBlock: false,
            dotSource: false, providerReference: false, automationType: false,
            line: 1, column: 1
        }]
    }] }, forbidden, auth);
}

async function runGate(args, result, expectedCode = FAKE_CODE, execution = {}) {
    const stdin = new EventEmitter();
    const calls = { checks: [], spawns: [], writes: [], exits: [], out: [], err: [] };
    const fakeProcess = {
        stdin, env: { DECRYPTED_AUTH_CODE: expectedCode },
        exit: code => calls.exits.push(code)
    };
    const fakeFs = {
        existsSync: p => path.basename(p) === 'config.env',
        readFileSync: () => 'FORBIDDEN_COMMANDS=rm,del,format,rmdir\nAUTH_REQUIRED_COMMANDS=Set-Content,Remove-Item',
        writeFileSync: (...args) => calls.writes.push(args),
        unlinkSync: () => {},
        promises: {
            stat: async () => ({ size: 10 }),
            readFile: async () => Buffer.from('mock output'),
            unlink: async () => {}
        }
    };
    const fakeSpawn = (...args) => {
        calls.spawns.push(args);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.pid = 999999;
        setImmediate(() => {
            if (execution.stdout) child.stdout.write(execution.stdout);
            if (execution.stderr) child.stderr.write(execution.stderr);
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', execution.exitCode ?? 0);
            child.emit('close', execution.exitCode ?? 0);
        });
        return child;
    };
    const fakeRequire = name => {
        if (name === 'fs') return fakeFs;
        if (name === 'child_process') return {
            spawn: fakeSpawn, execSync: () => { throw new Error('NO_REAL_EXECUTION'); }
        };
        if (name === 'dotenv') return { config: () => {} };
        if (name === 'os') return { platform: () => 'win32', tmpdir: () => 'X:\\fake-tmp' };
        if (name === './commandSecurity') return {
            checkCommands: (...args) => { calls.checks.push(args); return result; }
        };
        return require(name);
    };
    vm.runInNewContext(source, {
        require: fakeRequire, __dirname: pluginDir, process: fakeProcess, Buffer,
        setTimeout, clearTimeout, setInterval, clearInterval,
        console: { log: s => calls.out.push(s), error: s => calls.err.push(s) }
    }, { filename: 'PowerShellExecutor.js', timeout: 2000 });
    stdin.emit('data', JSON.stringify(args));
    await stdin.listeners('end')[0]();
    return calls;
}

for (const name of ['format', 'Remove-Item', 'Invoke-Expression']) {
    const expected = decision(name);
    test(`gate ${expected.decision} rejects before execution without code`, async () => {
        const result = await runGate({ command: name }, expected);
        assert.equal(result.checks.length, 1);
        assert.equal(result.spawns.length, 0);
        assert.equal(result.writes.length, 0);
        assert.deepEqual(result.exits, [1]);
        const error = JSON.parse(result.err.at(-1));
        assert.equal(error.security.decision, expected.decision);
        assert.equal(error.security.canAuthorize, expected.canAuthorize);
    });
}
test('code never overrides forbidden', async () => {
    const result = await runGate({ command: 'format', tool_password: FAKE_CODE }, decision('format'));
    assert.equal(result.spawns.length, 0);
    assert.equal(result.writes.length, 0);
    assert.deepEqual(result.exits, [1]);
    assert.equal(JSON.parse(result.err.at(-1)).security.canAuthorize, false);
});
test('code allows review-required', async () => {
    const result = await runGate({ command: 'Invoke-Expression', tool_password: FAKE_CODE }, decision('Invoke-Expression'));
    assert.equal(result.spawns.length, 1);
    assert.deepEqual(result.exits, []);
});
test('authorized command needs exact code', async () => {
    for (const supplied of ['incorrect', undefined]) {
        const result = await runGate({ command: 'Remove-Item', tool_password: supplied }, decision('Remove-Item'));
        assert.equal(result.spawns.length, 0);
        assert.deepEqual(result.exits, [1]);
    }
});
test('correct code reaches FAKE execution only', async () => {
    const result = await runGate({ command: 'Remove-Item', tool_password: FAKE_CODE }, decision('Remove-Item'));
    assert.equal(result.spawns.length, 1);
    assert.deepEqual(result.exits, []);
});
test('missing expected code rejects', async () => {
    const result = await runGate({ command: 'Remove-Item', tool_password: FAKE_CODE }, decision('Remove-Item'), '');
    assert.equal(result.spawns.length, 0);
});
test('ordinary command works without a code', async () => {
    const result = await runGate({ command: "Write-Output 'format'" }, decision('Write-Output'));
    assert.equal(result.spawns.length, 1);
    assert.deepEqual(result.exits, []);
});
test('batch is checked once before execution; forbidden last stops whole batch', async () => {
    const result = await runGate({
        command1: "Write-Output 'format'", command2: 'format', tool_password: FAKE_CODE
    }, decision('format'));
    assert.deepEqual(Array.from(result.checks[0][0]), ["Write-Output 'format'", 'format']);
    assert.equal(result.checks.length, 1);
    assert.equal(result.spawns.length, 0);
});
test('parser result requiring review without code stops the production gate', async () => {
    const result = await runGate({ command: 'Write-Output ok' },
        security.evaluateFacts(null, forbidden, auth));
    assert.equal(result.spawns.length, 0);
    assert.equal(result.writes.length, 0);
});
test('parser result requiring review with code allows execution', async () => {
    const result = await runGate({ command: 'Write-Output ok', tool_password: FAKE_CODE },
        security.evaluateFacts(null, forbidden, auth));
    assert.equal(result.spawns.length, 1);
    assert.deepEqual(result.exits, []);
});

// Fault injection replaces only the parser process; no sample is executed.
function loadWithParser(stub) {
    const module = { exports: {} };
    vm.runInNewContext(securitySource, {
        module, __dirname: pluginDir, Buffer, process: { env: {} },
        require: name => name === 'node:child_process' ? { spawnSync: stub } : require(name)
    }, { timeout: 2000 });
    return module.exports;
}
for (const [label, child, expected] of [
    ['timeout', { error: { code: 'ETIMEDOUT' } }, 'PARSER_TIMEOUT'],
    ['exit error', { status: 1, stderr: 'SECRET' }, 'PARSER_PROCESS_FAILED'],
    ['output limit', { error: { code: 'ENOBUFS' } }, 'PARSER_PROCESS_FAILED'],
    ['malformed JSON', { status: 0, stdout: 'SECRET' }, 'PARSER_OUTPUT_INVALID'],
    ['wrong result count', { status: 0, stdout: '{"version":1,"results":[]}' }, 'PARSER_SCHEMA']
]) {
    test(`parser fault: ${label}`, () => {
        const checker = loadWithParser(() => child);
        const result = checker.checkCommands(['Write-Output ok'], forbidden, auth);
        assert.equal(result.decision, 'review-required');
        assert.equal(result.matchedKeyword, expected);
        assert.equal(JSON.stringify(result).includes('SECRET'), false);
    });
}
test('parser start exception fails closed', () => {
    const checker = loadWithParser(() => { throw new Error('SECRET'); });
    const result = checker.checkCommands(['Write-Output ok'], forbidden, auth);
    assert.equal(result.matchedKeyword, 'PARSER_START_FAILED');
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
});test('background gate denies forbidden format even with code', async () => {
    const result = await runGate({
        command: 'format', executionType: 'background', tool_password: FAKE_CODE
    }, decision('format'));
    assert.equal(result.spawns.length, 0);
    assert.equal(result.writes.length, 0);
    assert.deepEqual(result.exits, [1]);
});
test('background gate denies review-required Invoke-Expression without code', async () => {
    const result = await runGate({
        command: 'Invoke-Expression', executionType: 'background'
    }, decision('Invoke-Expression'));
    assert.equal(result.spawns.length, 0);
    assert.equal(result.writes.length, 0);
    assert.deepEqual(result.exits, [1]);
});
test('background gate allows review-required Invoke-Expression with code', async () => {
    const result = await runGate({
        command: 'Invoke-Expression', executionType: 'background', tool_password: FAKE_CODE
    }, decision('Invoke-Expression'));
    assert.equal(result.spawns.length, 1);
    assert.deepEqual(result.exits, []);
});

function assertDiagnostic(result, code, stage, omitted = []) {
    assert.deepEqual(result.exits, [1]);
    assert.equal(result.out.length, 1, 'one machine-readable stdout response');
    const diagnostic = JSON.parse(result.out[0]);
    assert.deepEqual(diagnostic, JSON.parse(result.err.at(-1)));
    assert.equal(diagnostic.status, 'error');
    assert.equal(diagnostic.code, code);
    assert.equal(diagnostic.stage, stage);
    assert.equal(typeof diagnostic.error, 'string');
    assert.equal(result.err.some(line => line.includes('请向用户索取当前最新动态验证码')), false);
    const output = JSON.stringify([...result.out, ...result.err]);
    for (const value of [FAKE_CODE, ...omitted]) {
        assert.equal(output.includes(value), false, 'diagnostic leaked private input');
    }
    return diagnostic;
}

for (const [label, supplied, expected, code] of [
    ['missing argument', undefined, FAKE_CODE, 'AUTH_REQUIRED'],
    ['missing host value', FAKE_CODE, '', 'AUTH_UNAVAILABLE'],
    ['mismatched code', 'wrong-unit-code', FAKE_CODE, 'AUTH_INVALID']
]) {
    test(`structured authorization diagnostic: ${label}`, async () => {
        const command = 'Invoke-Expression PRIVATE_COMMAND_MARKER';
        const result = await runGate({ command, tool_password: supplied },
            decision('Invoke-Expression'), expected);
        assert.equal(result.spawns.length, 0);
        assert.equal(result.writes.length, 0);
        const d = assertDiagnostic(result, code, 'authorization',
            ['PRIVATE_COMMAND_MARKER', 'wrong-unit-code']);
        assert.equal(d.security.decision, 'review-required');
        assert.equal(d.security.canAuthorize, true);
    });
}

test('forbidden diagnostic stays forbidden with a valid synthetic code', async () => {
    const fact = {
        ...decision('format'), reason: 'PRIVATE_POLICY_MARKER',
        commandName: 'PRIVATE_COMMAND_MARKER', matchedKeyword: 'PRIVATE_POLICY_MARKER',
        commandIndex: 0, line: 1, column: 2
    };
    const result = await runGate({
        command: 'format PRIVATE_COMMAND_MARKER', tool_password: FAKE_CODE
    }, fact);
    assert.equal(result.spawns.length, 0);
    assert.equal(result.writes.length, 0);
    const d = assertDiagnostic(result, 'COMMAND_FORBIDDEN', 'security',
        ['PRIVATE_POLICY_MARKER', 'PRIVATE_COMMAND_MARKER']);
    assert.equal(d.security.canAuthorize, false);
    assert.equal(d.security.commandIndex, 0);
    assert.equal(d.security.line, 1);
    assert.equal(d.security.column, 2);
    assert.equal(Object.hasOwn(d.security, 'reason'), false);
    assert.equal(Object.hasOwn(d.security, 'commandName'), false);
});

test('authorized fake child failure reports execution stage without raw output', async () => {
    const command = 'Invoke-Expression PRIVATE_COMMAND_MARKER';
    const result = await runGate({ command, tool_password: FAKE_CODE },
        decision('Invoke-Expression'), FAKE_CODE, {
            exitCode: 7,
            stdout: 'PRIVATE_STDOUT_MARKER',
            stderr: 'PRIVATE_STDERR_MARKER ' + FAKE_CODE
        });
    assert.equal(result.spawns.length, 1);
    assert.equal(result.writes.length, 1);
    const d = assertDiagnostic(result, 'EXECUTION_FAILED', 'execution',
        ['PRIVATE_COMMAND_MARKER', 'PRIVATE_STDOUT_MARKER', 'PRIVATE_STDERR_MARKER']);
    assert.equal(Object.hasOwn(d, 'security'), false);
});

test('authorized success has no misleading authorization warning', async () => {
    const result = await runGate({
        command: 'Invoke-Expression', tool_password: FAKE_CODE
    }, decision('Invoke-Expression'));
    assert.equal(result.spawns.length, 1);
    assert.deepEqual(result.exits, []);
    assert.equal(JSON.parse(result.out.at(-1)).status, 'success');
    assert.equal(result.err.some(line => /需要验证码授权|AUTH_/.test(line)), false);
});

test('supplied wrong code on an ordinary command is still rejected', async () => {
    const result = await runGate({
        command: 'Write-Output ok', tool_password: 'wrong-unit-code'
    }, decision('Write-Output'));
    assert.equal(result.spawns.length, 0);
    assertDiagnostic(result, 'AUTH_INVALID', 'authorization', ['wrong-unit-code']);
});

test('requireAdmin legacy credential alias keeps the same authorization semantics', async () => {
    const result = await runGate({
        command: 'Invoke-Expression', requireAdmin: FAKE_CODE
    }, decision('Invoke-Expression'));
    assert.equal(result.spawns.length, 1);
    assert.deepEqual(result.exits, []);
});