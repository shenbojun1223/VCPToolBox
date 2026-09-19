'use strict';

const http = require('http');
const path = require('path');
const {
  RequestDiagnostics,
  parseBoolean,
  resolveDiagnosticsDirectory
} = require('../modules/diagnostics/requestDiagnostics.js');

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_INTERVAL_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 10 * 1000;
const PROBES = Object.freeze([
  { role: 'main_direct', portName: 'mainPort', path: '/__vcp_diag/health' },
  { role: 'admin_local', portName: 'adminPort', path: '/__vcp_diag/health' },
  { role: 'admin_proxy', portName: 'adminPort', path: '/__vcp_diag/proxy-health' }
]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function parseArgs(argv) {
  const args = { once: false, enabled: false, mainPort: null, adminPort: null, intervalMs: null, timeoutMs: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--once') args.once = true;
    else if (arg === '--enabled') args.enabled = true;
    else if (arg === '--main-port') args.mainPort = argv[++index];
    else if (arg === '--admin-port') args.adminPort = argv[++index];
    else if (arg === '--interval-ms') args.intervalMs = argv[++index];
    else if (arg === '--timeout-ms') args.timeoutMs = argv[++index];
  }
  return args;
}

function safePort(value, fallback) {
  return boundedInteger(value, fallback, 1, 65535);
}

function createWatchdog(options = {}) {
  const env = options.env || process.env;
  const args = options.args || {};
  const enabled = options.enabled === true
    || args.enabled === true
    || (parseBoolean(env.VCP_DIAGNOSTICS_ENABLED, false) && parseBoolean(env.VCP_DIAGNOSTICS_WATCHDOG_ENABLED, false));
  const mainPort = safePort(options.mainPort ?? args.mainPort ?? env.PORT, 3000);
  const adminPort = safePort(options.adminPort ?? args.adminPort ?? (mainPort + 1), mainPort + 1);
  const intervalMs = boundedInteger(options.intervalMs ?? args.intervalMs ?? env.VCP_DIAGNOSTICS_WATCHDOG_INTERVAL_MS, DEFAULT_INTERVAL_MS, 1000, MAX_INTERVAL_MS);
  const timeoutMs = boundedInteger(options.timeoutMs ?? args.timeoutMs ?? env.VCP_DIAGNOSTICS_WATCHDOG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 250, MAX_TIMEOUT_MS);
  const diagnostics = options.diagnostics || new RequestDiagnostics({
    role: 'watchdog',
    rootDir: path.join(__dirname, '..'),
    enabled,
    directory: options.directory || resolveDiagnosticsDirectory(path.join(__dirname, '..'), env.VCP_DIAGNOSTICS_DIR),
    env
  });

  let inFlight = false;

  function probe(probeSpec) {
    if (!diagnostics.enabled) return Promise.resolve({ role: probeSpec.role, code: 'disabled_or_not_found' });
    const port = probeSpec.portName === 'mainPort' ? mainPort : adminPort;
    const start = process.hrtime.bigint();
    const diagnosticId = `probe-${probeSpec.role}-${process.pid}-${Date.now().toString(36)}`;
    const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;
    return new Promise(resolve => {
      let settled = false;
      let gotHeaders = false;
      let bodyTimer = null;
      let headerTimer = null;
      let request;
      const finish = result => {
        if (settled) return;
        settled = true;
        if (headerTimer) clearTimeout(headerTimer);
        if (bodyTimer) clearTimeout(bodyTimer);
        resolve({ role: probeSpec.role, ...result });
      };
      const log = (phase, status = null, errorCode = null) => {
        diagnostics.writer.writeEvent({
          utcTime: new Date().toISOString(),
          serviceRole: 'watchdog',
          pid: process.pid,
          diagnosticId,
          correlationId: null,
          route: 'diagnostics',
          probeRole: probeSpec.role,
          phase,
          elapsedMs: Math.round(elapsed() * 1000) / 1000,
          httpStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
          errorCode
        });
      };
      const armBodyTimer = response => {
        if (bodyTimer) clearTimeout(bodyTimer);
        bodyTimer = setTimeout(() => {
          log('probe_body_stall', response.statusCode, 'response_body_timeout');
          response.destroy();
          request?.destroy();
          finish({ phase: 'probe_body_stall', status: response.statusCode, elapsedMs: elapsed(), code: 'response_body_timeout' });
        }, timeoutMs);
      };

      log('probe_connect');
      try {
        request = http.request({
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: probeSpec.path,
          headers: { Accept: 'application/json' }
        }, response => {
          gotHeaders = true;
          if (headerTimer) clearTimeout(headerTimer);
          log('probe_response_headers', response.statusCode);
          armBodyTimer(response);
          response.on('data', () => armBodyTimer(response));
          response.on('end', () => {
            if (bodyTimer) clearTimeout(bodyTimer);
            log('probe_complete', response.statusCode);
            finish({ phase: 'probe_complete', status: response.statusCode, elapsedMs: elapsed() });
          });
          response.on('error', () => {
            log('probe_error', response.statusCode, 'response_error');
            finish({ phase: 'probe_error', status: response.statusCode, elapsedMs: elapsed(), code: 'response_error' });
          });
        });
        request.once('socket', socket => {
          socket.once('connect', () => log('probe_connect'));
        });
        request.once('error', error => {
          const code = gotHeaders ? 'response_error' : 'connect_error';
          log('probe_error', null, code);
          finish({ phase: 'probe_error', elapsedMs: elapsed(), code });
        });
        headerTimer = setTimeout(() => {
          log('probe_timeout', null, 'response_headers_timeout');
          request.destroy();
          finish({ phase: 'probe_timeout', elapsedMs: elapsed(), code: 'response_headers_timeout' });
        }, timeoutMs);
        request.end();
      } catch (_) {
        log('probe_error', null, 'connect_error');
        finish({ phase: 'probe_error', elapsedMs: elapsed(), code: 'connect_error' });
      }
    });
  }

  async function probeOnce() {
    if (!diagnostics.enabled) return { skipped: true, reason: 'disabled' };
    if (inFlight) return { skipped: true, reason: 'overlap' };
    inFlight = true;
    try {
      const results = [];
      for (const probeSpec of PROBES) results.push(await probe(probeSpec));
      return { skipped: false, results };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (!diagnostics.enabled) return { stop: () => undefined, enabled: false };
    const timer = setInterval(() => { void probeOnce(); }, intervalMs);
    timer.unref?.();
    return {
      enabled: true,
      stop: () => clearInterval(timer)
    };
  }

  return { enabled: diagnostics.enabled, diagnostics, probe, probeOnce, start, ports: { mainPort, adminPort }, timeoutMs, intervalMs };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const watchdog = createWatchdog({ args });
  if (!watchdog.enabled) {
    process.stdout.write('diagnostics watchdog disabled\n');
    return;
  }
  if (args.once) {
    await watchdog.probeOnce();
    await watchdog.diagnostics.flush();
    return;
  }
  watchdog.start();
}

if (require.main === module) {
  main().catch(() => process.exitCode = 1);
}

module.exports = {
  PROBES,
  createWatchdog,
  parseArgs
};
