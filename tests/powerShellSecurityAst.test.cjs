'use strict';
// All risky samples below are DATA sent only to the native parser.
// This file never imports/runs PowerShellExecutor.js or evaluates sample source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const security = require('../Plugin/PowerShellExecutor/commandSecurity');
const helper = path.resolve(__dirname, '../Plugin/PowerShellExecutor/inspect-command-ast.ps1');
const forbidden = ['rm', 'del', 'format', 'rmdir'];
const auth = ['net', 'shutdown', 'restart', 'Set-Item', 'Remove-Item', 'Set-Content', 'Add-Content', 'Clear-Content'];
const cases = [
    ['report string', "Write-Output 'Original strict-format failure remains a failure'", 'allow'],
    ['literal output', "Write-Output 'format'", 'allow'],
    ['table display', "Get-Date | Format-Table", 'allow'],
    ['list display', "Get-Date | Format-List", 'allow'],
    ['display aliases', "Get-Date | ft; Get-Date | fl", 'allow'],
    ['comment only', "# format del rm", 'allow'],
    ['block comment', "<# format #> Write-Output ok", 'allow'],
    ['arguments are data', "Write-Output rm del format rmdir net", 'allow'],
    ['hashtable data', "$x=@{format='del'; net='rm'}; Write-Output $x", 'allow'],
    ['here string data', "$x=@'\nformat rm del\n'@\nWrite-Output $x", 'allow'],
    ['ordinary member', "'strict-format'.ToUpperInvariant()", 'allow'],
    ['path argument', "Get-Item -LiteralPath 'C:\\work\\format\\report.txt'", 'allow'],
    ['format exe', "format.exe X:", 'forbidden'],
    ['format cmdlet', "Format-Volume -DriveLetter X", 'forbidden'],
    ['quoted full execution target', "& 'C:\\Windows\\System32\\format.com' X:", 'forbidden'],
    ['module-qualified target', "Storage\\Format-Volume -DriveLetter X", 'forbidden'],
    ['literal rm', "rm -LiteralPath 'X:\\not-real'", 'forbidden'],
    ['literal del', "del -LiteralPath 'X:\\not-real'", 'forbidden'],
    ['literal rmdir', "rmdir -LiteralPath 'X:\\not-real'", 'forbidden'],
    ['module qualified remove', "Microsoft.PowerShell.Management\\Remove-Item -LiteralPath 'X:\\not-real'", 'auth-required'],
    ['canonical remove stays auth', "Remove-Item -LiteralPath 'X:\\not-real'", 'auth-required'],
    ['native authorized target', "net.exe user", 'auth-required'],
    ['restart family', "Restart-Computer", 'auth-required'],
    ['content writer', "Set-Content -LiteralPath 'X:\\not-real' -Value ok", 'auth-required'],
    ['content alias', "ac -LiteralPath 'X:\\not-real' -Value ok", 'auth-required'],
    ['nested subexpression', 'Write-Output "$(format.exe X:)"', 'forbidden'],
    ['scriptblock invocation', "& { format.exe X: }", 'forbidden'],
    ['uninvoked scriptblock conservative', "$x = { format.exe X: }", 'forbidden'],
    ['inline safe block', "& { Write-Output 'format' }", 'allow'],
    ['file redirect', "Write-Output ok > 'X:\\not-real'", 'auth-required'],
    ['append redirect', "Write-Output ok >> 'X:\\not-real'", 'auth-required'],
    ['merge streams only', "Write-Output ok 2>&1", 'allow'],
    ['dynamic target', "$x='Write-Output'; & $x ok", 'review-required'],
    ['dynamic eval alias', "iex 'Write-Output ok'", 'review-required'],
    ['scriptblock creation', "[scriptblock]::Create('Write-Output ok')", 'review-required'],
    ['dynamic invocation member', "$x.Invoke()", 'review-required'],
    ['external PS script', "& 'C:\\not-real\\script.ps1'", 'review-required'],
    ['external PS module', "& 'C:\\not-real\\module.psm1'", 'review-required'],
    ['dot source', ". 'C:\\not-real\\script.ps1'", 'review-required'],
    ['nested shell', "pwsh -NoProfile -Command 'Write-Output ok'", 'review-required'],
    ['alias mutation', "Set-Alias example Write-Output", 'review-required'],
    ['provider mutation', "Set-Item Alias:example Write-Output", 'review-required'],
    ['parse failure', "Write-Output 'unfinished", 'review-required'],
    ['formatting names not prefixes', "Write-Output 'formatted'; Get-Date | Format-Wide", 'allow'],
    ['non-ASCII data', "Write-Output '\u683c\u5f0f format'", 'allow'],
    ['external runtime boundary', "node --version", 'allow']
];
const shells = [
    ['PS7', path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')],
    ['PS5.1', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
];

for (const [label, shell] of shells) {
    test(`${label}: parse-only integration matrix`, { skip: !fs.existsSync(shell) }, async t => {
        const child = spawnSync(shell, [
            '-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', helper
        ], {
            input: JSON.stringify({ commands: cases.map(c => c[1]) }),
            encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true
        });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 0, child.stderr);
        const parsed = JSON.parse(child.stdout.replace(/^\uFEFF/, ''));
        assert.equal(parsed.version, 1);
        assert.equal(parsed.results.length, cases.length);
        for (let i = 0; i < cases.length; i++) {
            const [name, , expected] = cases[i];
            await t.test(name, () => {
                const result = security.evaluateFacts({ version: 1, results: [parsed.results[i]] }, forbidden, auth);
                assert.equal(result.decision, expected, result.reason || name);
                assert.equal(result.canAuthorize, expected === 'auth-required' || expected === 'review-required');
                if (expected !== 'allow') {
                    assert.ok(result.diagnostics.length);
                    assert.ok(result.diagnostics.some(d => d.line > 0));
                }
            });
        }
        await t.test('batch forbidden priority', () => {
            const result = security.evaluateFacts(parsed, forbidden, auth);
            assert.equal(result.decision, 'forbidden');
            assert.equal(result.canAuthorize, false);
        });
        await t.test('checker wrapper never runs samples', () => {
            const result = security.checkCommands(
                ["Write-Output 'format'", "format.exe X:"], forbidden, auth, { shell }
            );
            assert.equal(result.decision, 'forbidden');
            assert.equal(result.diagnostics[0].commandIndex, 1);
        });
    });
}

test('invalid parser output is never allow', () => {
    for (const parsed of [null, {}, { version: 1, results: [null] },
        { version: 1, results: [{ errors: [], facts: [{ kind: 'unknown', line: 1, column: 1 }] }] }]) {
        assert.equal(security.evaluateFacts(parsed, forbidden, auth).decision, 'review-required');
    }
});
test('missing parser fails closed', () => {
    assert.equal(security.checkCommands(['Write-Output ok'], forbidden, auth,
        { shell: path.join(__dirname, 'not-a-real-shell.exe') }).decision, 'review-required');
});
test('empty and invalid input fail closed', () => {
    for (const commands of [[], null, [42], [''], ['   ']]) {
        assert.equal(security.checkCommands(commands, forbidden, auth).decision, 'review-required');
    }
});
test('oversized input fails closed before process creation', () => {
    assert.equal(security.checkCommands(['#' + 'x'.repeat(600000)], forbidden, auth).decision, 'review-required');
});
test('policy target normalization', () => {
    assert.equal(security.commandIdentity('C:\\Windows\\System32\\FORMAT.COM'), 'format');
    assert.equal(security.commandIdentity('Storage\\Format-Volume'), 'format-volume');
    assert.equal(security.commandIdentity('Format-Table'), 'format-table');
});