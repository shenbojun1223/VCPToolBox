'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const tests=fs.readdirSync(__dirname).filter(n=>/\.test\.(?:cjs|js)$/.test(n)).sort();
if(!tests.length)throw Error('NO_TEST_FILES');
const r=spawnSync(process.execPath,['--unhandled-rejections=strict','--test','--test-reporter=spec',...tests.map(n=>path.join(__dirname,n))],
 {encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);
if(r.error)console.error('TEST_RUNNER_'+r.error.code);
process.exitCode=r.error?1:(r.status??1);
