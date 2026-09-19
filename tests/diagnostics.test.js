'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const {
  BoundedJsonlWriter,
  RequestDiagnostics,
  extractCorrelationId,
  isLoopbackSocket
} = require(path.join(__dirname, '..', 'modules', 'diagnostics', 'requestDiagnostics.js'));
const { PROBES, createWatchdog } = require(path.join(__dirname, '..', 'scripts', 'diagnostics-watchdog.js'));

const fsp = fs.promises;
const repoRoot = path.join(__dirname, '..');

async function withTempDirectory(prefix, callback) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(directory);
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

async function readJsonl(directory) {
  const names = await fsp.readdir(directory).catch(() => []);
  const files = names.filter(name => name.endsWith('.jsonl'));
  const lines = [];
  for (const name of files) {
    const text = await fsp.readFile(path.join(directory, name), 'utf8');
    for (const line of text.split(/\r?\n/).filter(Boolean)) lines.push(JSON.parse(line));
  }
  return lines;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
}

function httpRequest(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: requestPath, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function testDisabledAndSanitizedLogging() {
  await withTempDirectory('vcp-diagnostics-disabled-', async directory => {
    const disabledDirectory = path.join(directory, 'disabled-output');
    const disabled = new RequestDiagnostics({ enabled: false, role: 'main', directory: disabledDirectory });
    disabled.recordSystem({ phase: 'request_enter', route: 'chat' });
    await disabled.flush();
    assert.strictEqual(fs.existsSync(disabledDirectory), false, 'disabled diagnostics must not create a directory');
  });

  assert.strictEqual(extractCorrelationId({ requestId: 'abc-123._:ok' }), 'request:abc-123._:ok');
  assert.strictEqual(extractCorrelationId({ requestId: 'Bearer secret token' }), null);
  assert.strictEqual(extractCorrelationId({ requestId: 'x'.repeat(97), messageId: 'valid' }), 'message:valid');
  assert.strictEqual(extractCorrelationId({ requestId: { prompt: 'secret' }, messageId: '\nsecret' }), null);

  await withTempDirectory('vcp-diagnostics-fields-', async directory => {
    const diagnostics = new RequestDiagnostics({
      enabled: true,
      role: 'main',
      directory,
      maxFileBytes: 1024,
      maxFiles: 4,
      maxTotalBytes: 4096
    });
    diagnostics.writer.writeEvent({
      diagnosticId: 'main-safe-1',
      correlationId: 'request:client-1',
      route: '/sensitive?token=secret',
      phase: 'complete',
      httpStatus: 200,
      errorCode: 'raw-secret-code',
      prompt: 'DO_NOT_WRITE_PROMPT',
      stack: 'Bearer API_KEY_DO_NOT_WRITE'
    });
    diagnostics.recordSystem({ phase: 'probe_complete', route: 'diagnostics', probeRole: 'admin_local', httpStatus: 200 });
    await diagnostics.flush();
    const events = await readJsonl(directory);
    assert.ok(events.length >= 2);
    const allowed = new Set([
      'utcTime', 'serviceRole', 'pid', 'diagnosticId', 'correlationId', 'route',
      'probeRole', 'phase', 'elapsedMs', 'httpStatus', 'errorCode'
    ]);
    for (const event of events) {
      assert.deepStrictEqual(Object.keys(event).sort(), [...allowed].sort());
      assert.doesNotMatch(JSON.stringify(event), /DO_NOT_WRITE_PROMPT|API_KEY_DO_NOT_WRITE|token=secret/);
    }
    assert.strictEqual(events[0].route, 'other');
    assert.strictEqual(events[0].errorCode, null);
  });
}

async function testConcurrentLifecycleAndBounds() {
  await withTempDirectory('vcp-diagnostics-lifecycle-', async directory => {
    const diagnostics = new RequestDiagnostics({
      enabled: true,
      role: 'main',
      directory,
      maxFileBytes: 1024,
      maxFiles: 64,
      maxTotalBytes: 1024 * 1024
    });
    const middleware = diagnostics.middleware({ routeClassifier: () => 'chat' });
    const server = http.createServer((req, res) => {
      middleware(req, res, () => {
        const index = req.headers['x-test-id'];
        diagnostics.markBodyParsed(req, {
          requestId: `request-${index}`,
          prompt: 'sensitive prompt must not be logged'
        });
        if (index === 'idempotent') {
          req.__vcpDiagnostics.complete(200);
          req.__vcpDiagnostics.complete(500);
          req.__vcpDiagnostics.disconnect(500);
        }
        if (index === 'disconnect') {
          req.__vcpDiagnostics.disconnect(499);
          req.__vcpDiagnostics.disconnect(500);
        }
        return setImmediate(() => res.end('ok'));
      });
    });
    const port = await listen(server);
    try {
      await Promise.all(Array.from({ length: 18 }, (_, index) => httpRequest(port, '/', { 'x-test-id': String(index) })));
      await httpRequest(port, '/', { 'x-test-id': 'idempotent' });
      await httpRequest(port, '/', { 'x-test-id': 'disconnect' });
      await diagnostics.flush();
    } finally {
      await closeServer(server);
    }

    const events = await readJsonl(directory);
    const byDiagnosticId = new Map();
    for (const event of events) {
      if (!byDiagnosticId.has(event.diagnosticId)) byDiagnosticId.set(event.diagnosticId, []);
      byDiagnosticId.get(event.diagnosticId).push(event);
    }
    assert.ok([...byDiagnosticId.values()].some(items => items.some(event => event.phase === 'complete')));
    for (const items of byDiagnosticId.values()) {
      const correlations = new Set(items.map(event => event.correlationId).filter(Boolean));
      assert.ok(correlations.size <= 1, 'concurrent requests must not share a correlation ID');
      assert.ok(items.every(event => !JSON.stringify(event).includes('sensitive prompt')));
    }
    const idempotentItems = [...byDiagnosticId.values()].find(items => items.some(event => event.correlationId === 'request:request-idempotent'));
    assert.ok(idempotentItems);
    assert.strictEqual(idempotentItems.filter(event => event.phase === 'complete').length, 1);
    assert.strictEqual(idempotentItems.filter(event => event.phase === 'disconnect').length, 0);
    const disconnectItems = [...byDiagnosticId.values()].find(items => items.some(event => event.correlationId === 'request:request-disconnect'));
    assert.ok(disconnectItems);
    assert.strictEqual(disconnectItems.filter(event => event.phase === 'disconnect').length, 1);
  });

  await withTempDirectory('vcp-diagnostics-bounds-', async directory => {
    const writer = new BoundedJsonlWriter({
      enabled: true,
      role: 'watchdog',
      directory,
      queueLimit: 2,
      maxFileBytes: 1024,
      maxFiles: 2,
      maxTotalBytes: 4096
    });
    for (let index = 0; index < 40; index++) {
      writer.writeEvent({ phase: 'probe_complete', route: 'diagnostics', diagnosticId: `probe-${index}` });
    }
    await writer.flush();
    assert.ok(writer.getStats().droppedCount > 0, 'bounded queue must count dropped records');
    const files = (await fsp.readdir(directory)).filter(name => name.endsWith('.jsonl'));
    assert.ok(files.length <= 2, 'rotation must keep the configured file count');

    const broken = new BoundedJsonlWriter({
      enabled: true,
      role: 'main',
      directory: path.join(directory, 'broken'),
      fsImpl: { mkdir: async () => { throw new Error('fixture disk failure'); } }
    });
    assert.doesNotThrow(() => broken.writeEvent({ phase: 'complete', route: 'chat' }));
    await broken.flush();
    assert.ok(broken.getStats().diskErrorCount >= 1);
  });
}

async function testWatchdogAndLoopback() {
  assert.strictEqual(isLoopbackSocket({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '10.0.0.1' } }), true);
  assert.strictEqual(isLoopbackSocket({ socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': '127.0.0.1' } }), false);

  await withTempDirectory('vcp-diagnostics-watchdog-', async directory => {
    const mainServer = http.createServer(() => {
      // Deliberately no response headers: isolated main-thread stall fixture.
    });
    const adminServer = http.createServer((req, res) => {
      if (req.url === '/__vcp_diag/health') return res.end(JSON.stringify({ status: 'ok' }));
      // Deliberately no response for the fixed Admin→main proxy fixture.
      return undefined;
    });
    const mainPort = await listen(mainServer);
    const adminPort = await listen(adminServer);
    const watchdog = createWatchdog({ enabled: true, mainPort, adminPort, timeoutMs: 300, intervalMs: 1000, directory });
    try {
      const firstProbe = watchdog.probeOnce();
      const overlap = await watchdog.probeOnce();
      assert.deepStrictEqual(overlap, { skipped: true, reason: 'overlap' });
      const result = await firstProbe;
      assert.strictEqual(result.skipped, false);
      const byRole = new Map(result.results.map(item => [item.role, item]));
      assert.strictEqual(byRole.get('admin_local').phase, 'probe_complete');
      assert.strictEqual(byRole.get('main_direct').phase, 'probe_timeout');
      assert.strictEqual(byRole.get('main_direct').code, 'response_headers_timeout');
      assert.strictEqual(byRole.get('admin_proxy').phase, 'probe_timeout');
      assert.strictEqual(byRole.get('admin_proxy').code, 'response_headers_timeout');
      await watchdog.diagnostics.flush();
      const events = await readJsonl(directory);
      assert.ok(events.some(event => event.probeRole === 'main_direct' && event.phase === 'probe_timeout'));
      assert.ok(events.some(event => event.probeRole === 'admin_local' && event.phase === 'probe_complete'));
    } finally {
      await closeServer(adminServer);
      await closeServer(mainServer);
    }
  });

  await withTempDirectory('vcp-diagnostics-body-stall-', async directory => {
    const stallServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"status":"');
    });
    const port = await listen(stallServer);
    const watchdog = createWatchdog({ enabled: true, mainPort: port, adminPort: port, timeoutMs: 300, directory });
    try {
      const result = await watchdog.probe(PROBES[0]);
      assert.strictEqual(result.phase, 'probe_body_stall');
      assert.strictEqual(result.code, 'response_body_timeout');
    } finally {
      await closeServer(stallServer);
    }
  });
}

function runCpuFixture(directory) {
  const samplerPath = path.join(repoRoot, 'modules', 'diagnostics', 'cpuSampler.js');
  const code = `
    const { createCpuSampler } = require(${JSON.stringify(samplerPath)});
    function diagnosticMainThreadBusyLoop() {
      const deadline = Date.now() + 220;
      let value = 0;
      while (Date.now() < deadline) value = (value + 1) % 1000003;
      return value;
    }
    (async () => {
      const sampler = createCpuSampler({ enabled: true, role: 'main', directory: ${JSON.stringify(directory)}, samplingIntervalMs: 5, segmentDurationMs: 1000, maxSegments: 4, maxTotalBytes: 16 * 1024 * 1024 });
      setTimeout(diagnosticMainThreadBusyLoop, 150);
      await new Promise(resolve => setTimeout(resolve, 2350));
      await sampler.stop();
    })().catch(() => { process.exitCode = 1; });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = chunk => {
      output += chunk.toString();
      if (output.length > 12000) output = output.slice(-12000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CPU fixture timed out: ${output}`));
    }, 15000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`CPU fixture failed code=${code} signal=${signal}: ${output}`));
      resolve();
    });
  });
}

async function testCpuSampler() {
  await withTempDirectory('vcp-diagnostics-cpu-', async directory => {
    await runCpuFixture(directory);
    const names = (await fsp.readdir(directory)).filter(name => name.endsWith('.cpuprofile'));
    assert.ok(names.length >= 1, 'CPU sampler must periodically persist at least one segment');
    assert.strictEqual(new Set(names).size, names.length, 'CPU segment names must not overwrite one another');
    let foundBusyLoop = false;
    for (const name of names) {
      const profile = JSON.parse(await fsp.readFile(path.join(directory, name), 'utf8'));
      assert.strictEqual(profile.diagnostics.sampleTarget, 'main-thread');
      assert.strictEqual(profile.diagnostics.targetThreadId, 'main');
      assert.strictEqual(profile.diagnostics.serviceRole, 'main');
      assert.strictEqual(profile.diagnostics.processPid > 0, true);
      if (profile.nodes.some(node => String(node.callFrame?.functionName || '').includes('diagnosticMainThreadBusyLoop'))) {
        foundBusyLoop = true;
      }
    }
    assert.strictEqual(foundBusyLoop, true, 'profile must show the named main-thread busy loop, not the diagnostic Worker');
  });
}

async function main() {
  await testDisabledAndSanitizedLogging();
  await testConcurrentLifecycleAndBounds();
  await testWatchdogAndLoopback();
  await testCpuSampler();
  console.log('diagnostics acceptance test: PASS');
}

main().catch(error => {
  console.error(`diagnostics acceptance test: FAIL ${error.message}`);
  process.exitCode = 1;
});
