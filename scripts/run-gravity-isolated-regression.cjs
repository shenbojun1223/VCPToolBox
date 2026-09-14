'use strict';
// Isolated regression runner. Does not load server.js or production configuration.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests'))
  .filter(name => /^(gravity|embedding).*\.test\.js$/.test(name) ||
    name === 'ragRefreshSystemBoundary.test.js')
  .sort().map(name => 'tests/' + name);
const result = spawnSync(process.execPath,
  ['--test', '--test-concurrency=1', ...files], {
    cwd:root, encoding:'utf8', timeout:20000, maxBuffer:4*1024*1024,
    env:{...process.env,VCP_GRAVITY_ENABLED:'false',
      VCP_GRAVITY_SHADOW:'false',VCP_GRAVITY_METRICS:'false'}
  });
console.log('FILES ' + files.length);
for (const file of files) console.log(file);
const output = (result.stdout || '') + (result.stderr || '');
const lines = output.split(/\r?\n/);
console.log(lines.filter(line =>
  /^(1\.\.|# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b)/.test(line)
).join('\n'));
if (result.status !== 0 || result.error) {
  console.log(output.slice(-24000));
  console.error('RUN_FAILED', result.error?.code || result.signal || result.status);
}
process.exitCode = result.status === 0 && !result.error ? 0 : 1;