const { spawn } = require('child_process');

const targetHome = 'C:/Users/Administrator/.codex_deepseek';
const codexBin = 'C:/Users/Administrator/.vscode/extensions/openai.chatgpt-26.903.61454-win32-x64/bin/windows-x86_64/codex.exe';
const env = { ...process.env, CODEX_HOME: targetHome };

const child = spawn(codexBin, [
  'exec',
  '--skip-git-repo-check',
  '--ephemeral',
  '--sandbox', 'read-only',
  '请只回复：连接成功'
], {
  cwd: 'C:/VCP/VCPToolBox',
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});

let stdout = '';
let stderr = '';
child.stdout.on('data', d => stdout += d.toString());
child.stderr.on('data', d => stderr += d.toString());

const timer = setTimeout(() => {
  console.log('Timeout reached (40s), killing child...');
  child.kill('SIGKILL');
}, 40000);

child.on('close', (code, signal) => {
  clearTimeout(timer);
  console.log('ExitCode:', code);
  console.log('STDOUT:\n', stdout);
  if (stderr) console.log('STDERR:\n', stderr);
});
child.on('error', err => {
  clearTimeout(timer);
  console.error('Spawn error:', err);
});