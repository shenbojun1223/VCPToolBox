const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const gitOperator = require('../Plugin/GitOperator/GitOperator');
const fileOperator = require('../Plugin/DistributeFileOperator/FileOperator');

test('GitOperator work-path whitelist rejects sibling-prefix escapes', () => {
  const allowed = path.resolve('C:/vcp-security-test/allowed');
  const envConfig = { PLUGIN_WORK_PATHS: allowed };

  assert.equal(gitOperator.validateWorkPath(allowed, envConfig), true);
  assert.equal(gitOperator.validateWorkPath(path.join(allowed, 'child'), envConfig), true);
  assert.equal(gitOperator.validateWorkPath(`${allowed}-escape`, envConfig), false);
  assert.equal(gitOperator.validateWorkPath(path.dirname(allowed), envConfig), false);
});

test('GitOperator rejects option-like and control-character user values', () => {
  assert.equal(gitOperator.requireSafeGitValue('feature/safe', 'branch'), 'feature/safe');
  assert.throws(() => gitOperator.requireSafeGitValue('--upload-pack=cmd', 'branch'));
  assert.throws(() => gitOperator.requireSafeGitValue('main\nmalicious', 'branch'));
  assert.deepEqual(
    gitOperator.parseGitPathArguments('"docs/file with spaces.md" src/index.js'),
    ['docs/file with spaces.md', 'src/index.js']
  );
});

test('GitOperator redacts credentials and admin codes from debug arguments', () => {
  assert.deepEqual(
    gitOperator.sanitizeArgsForLog({ token: 'secret-token', requireAdmin: '123456', nested: { apiKey: 'secret-key', branch: 'main' } }),
    { token: '[REDACTED]', requireAdmin: '[REDACTED]', nested: { apiKey: '[REDACTED]', branch: 'main' } }
  );
});

test('GitOperator executes Git without a command shell', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-git-operator-'));
  try {
    const init = spawnSync('git', ['init'], { cwd: tempRoot, encoding: 'utf8', shell: false });
    assert.equal(init.status, 0, init.stderr);

    const status = gitOperator.execGit(['status', '--short'], tempRoot, null);
    assert.equal(status.ok, true, status.output);
    assert.throws(() => gitOperator.execGit('git status', tempRoot, null), /参数数组/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('DistributeFileOperator whitelist enforces path boundaries', () => {
  const allowed = path.resolve('C:/vcp-security-test/project');

  assert.equal(fileOperator.isPathWithin(allowed, allowed), true);
  assert.equal(fileOperator.isPathWithin(allowed, path.join(allowed, 'nested', 'file.txt')), true);
  assert.equal(fileOperator.isPathWithin(allowed, `${allowed}-escape/file.txt`), false);
  assert.equal(fileOperator.isPathWithin(allowed, path.dirname(allowed)), false);
});
