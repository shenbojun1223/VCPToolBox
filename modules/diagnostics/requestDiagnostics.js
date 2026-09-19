'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DEFAULT_QUEUE_LIMIT = 2048;
const DEFAULT_MAX_LINE_BYTES = 4096;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

const ROUTES = new Set([
  'chat',
  'protocol',
  'models',
  'interrupt',
  'admin_api',
  'plugin_callback',
  'static',
  'diagnostics',
  'other'
]);

const PHASES = new Set([
  'request_enter',
  'body_parsed',
  'preprocess_start',
  'preprocess_end',
  'upstream_request_sent',
  'upstream_response_headers',
  'first_output',
  'complete',
  'disconnect',
  'error',
  'local_processing_start',
  'local_processing_end',
  'proxy_request_sent',
  'proxy_response_headers',
  'proxy_timeout',
  'proxy_error',
  'probe_connect',
  'probe_response_headers',
  'probe_complete',
  'probe_timeout',
  'probe_body_stall',
  'probe_error',
  'cpu_segment_saved',
  'cpu_segment_error'
]);

const ERROR_CODES = new Set([
  'invalid_input',
  'body_parse_error',
  'handler_error',
  'aborted',
  'upstream_timeout',
  'upstream_error',
  'proxy_timeout',
  'proxy_error',
  'connect_error',
  'response_headers_timeout',
  'response_body_timeout',
  'response_error',
  'disabled_or_not_found',
  'disk_error',
  'queue_full',
  'unsupported',
  'inspector_timeout',
  'inspector_error',
  'profiler_busy'
]);

const PROBE_ROLES = new Set(['main_direct', 'admin_local', 'admin_proxy']);
const SERVICE_ROLES = new Set(['main', 'admin', 'watchdog']);

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRole(role) {
  const value = typeof role === 'string' ? role : '';
  return SERVICE_ROLES.has(value) ? value : 'other';
}

function safeRoute(route) {
  return ROUTES.has(route) ? route : 'other';
}

function safePhase(phase) {
  return PHASES.has(phase) ? phase : 'error';
}

function safeErrorCode(code) {
  return ERROR_CODES.has(code) ? code : null;
}

function safeStatus(status) {
  try {
    const parsed = Number(status);
    return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
  } catch (_) {
    return null;
  }
}

function safeElapsedMs(value) {
  try {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(24 * 60 * 60 * 1000, Math.max(0, Math.round(parsed * 1000) / 1000));
  } catch (_) {
    return 0;
  }
}

function isStrictClientId(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 96
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function extractCorrelationId(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const [field, prefix] of [['requestId', 'request'], ['messageId', 'message']]) {
    if (isStrictClientId(body[field])) {
      return `${prefix}:${body[field]}`;
    }
  }
  return null;
}

function safeCorrelationId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 110) return null;
  return /^[A-Za-z][A-Za-z0-9._:-]{0,109}$/.test(value) ? value : null;
}

function safeDiagnosticId(value, fallback) {
  if (typeof value === 'string' && value.length >= 1 && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    return value;
  }
  return fallback;
}

function generateDiagnosticId(role, pid, sequence) {
  let randomPart = '00000000';
  try {
    randomPart = crypto.randomBytes(4).toString('hex');
  } catch (_) {
    randomPart = String(sequence).padStart(8, '0').slice(-8);
  }
  return `${role}-${pid}-${Date.now().toString(36)}-${sequence.toString(36)}-${randomPart}`;
}

function resolveDiagnosticsDirectory(rootDir, configuredDirectory) {
  if (typeof configuredDirectory === 'string' && configuredDirectory.trim()) {
    return path.resolve(configuredDirectory.trim());
  }
  return path.join(rootDir || process.cwd(), 'DebugLog', 'diagnostics');
}

function monotonicElapsedMs(start) {
  if (typeof start !== 'bigint') return 0;
  return safeElapsedMs(Number(process.hrtime.bigint() - start) / 1e6);
}

class BoundedJsonlWriter {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.role = normalizeRole(options.role);
    this.pid = Number.isInteger(options.pid) ? options.pid : process.pid;
    this.directory = options.directory || path.join(process.cwd(), 'DebugLog', 'diagnostics');
    this.queueLimit = boundedInteger(options.queueLimit, DEFAULT_QUEUE_LIMIT, 1, 16384);
    this.maxLineBytes = boundedInteger(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, 256, 65536);
    this.maxFileBytes = boundedInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1024, 256 * 1024 * 1024);
    this.maxFiles = boundedInteger(options.maxFiles, DEFAULT_MAX_FILES, 1, 128);
    this.maxTotalBytes = boundedInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, this.maxFileBytes, 1024 * 1024 * 1024);
    this.fsImpl = options.fsImpl || fs.promises;
    this.onInternalFailure = typeof options.onInternalFailure === 'function' ? options.onInternalFailure : null;

    this.queue = [];
    this.waiters = [];
    this.draining = false;
    this.closed = false;
    this.ready = false;
    this.unavailable = false;
    this.currentFilePath = null;
    this.currentFileBytes = 0;
    this.fileSequence = 0;
    this.requestSequence = 0;
    this.stats = {
      droppedCount: 0,
      diskErrorCount: 0,
      queued: 0,
      writtenCount: 0
    };
    this.filePrefix = `vcp-diagnostics-${this.role}-pid${this.pid}`;
  }

  _notifyFailure(code) {
    if (this.onInternalFailure) {
      try {
        this.onInternalFailure(code);
      } catch (_) {
        // Failure reporting must never affect the request path.
      }
    }
  }

  async _ensureReady() {
    if (!this.enabled || this.closed || this.unavailable) return false;
    if (this.ready) return true;
    try {
      await this.fsImpl.mkdir(this.directory, { recursive: true });
      this.ready = true;
      return true;
    } catch (_) {
      this.unavailable = true;
      this.stats.diskErrorCount++;
      this.stats.droppedCount += this.queue.length;
      this.queue.length = 0;
      this.stats.queued = 0;
      this._notifyFailure('disk_error');
      return false;
    }
  }

  _nextFilePath() {
    this.fileSequence++;
    let suffix = '00000000';
    try {
      suffix = crypto.randomBytes(4).toString('hex');
    } catch (_) {
      suffix = String(this.fileSequence).padStart(8, '0').slice(-8);
    }
    const filename = `${this.filePrefix}-${Date.now().toString(36)}-${this.fileSequence}-${suffix}.jsonl`;
    return path.join(this.directory, filename);
  }

  async _ensureCurrentFile(lineBytes) {
    if (this.currentFilePath && this.currentFileBytes > 0 && this.currentFileBytes + lineBytes > this.maxFileBytes) {
      this.currentFilePath = null;
      this.currentFileBytes = 0;
    }
    if (!this.currentFilePath) {
      this.currentFilePath = this._nextFilePath();
      this.currentFileBytes = 0;
    }
  }

  async _enforceRetention() {
    const names = await this.fsImpl.readdir(this.directory);
    const matcher = new RegExp(`^${escapeRegExp(this.filePrefix)}-.*\\.jsonl$`);
    const candidates = [];
    for (const name of names) {
      if (typeof name !== 'string' || !matcher.test(name)) continue;
      const filePath = path.join(this.directory, name);
      try {
        const stat = await this.fsImpl.stat(filePath);
        candidates.push({
          name,
          filePath,
          size: Number.isFinite(stat.size) ? stat.size : 0,
          mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0
        });
      } catch (_) {
        // A concurrent rotation/removal is harmless.
      }
    }

    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    let keptCount = 0;
    let keptBytes = 0;
    for (const candidate of candidates) {
      const keepByCount = keptCount < this.maxFiles;
      const keepByBytes = keptBytes + candidate.size <= this.maxTotalBytes || keptCount === 0;
      if (keepByCount && keepByBytes) {
        keptCount++;
        keptBytes += candidate.size;
        continue;
      }
      if (candidate.filePath === this.currentFilePath) continue;
      try {
        await this.fsImpl.unlink(candidate.filePath);
      } catch (_) {
        // Retention is best-effort and never blocks the caller.
      }
    }
  }

  async _appendLine(line) {
    if (!(await this._ensureReady())) return;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    await this._ensureCurrentFile(lineBytes);
    await this.fsImpl.appendFile(this.currentFilePath, line, 'utf8');
    this.currentFileBytes += lineBytes;
    this.stats.writtenCount++;
    try {
      await this._enforceRetention();
    } catch (_) {
      this.stats.diskErrorCount++;
      this._notifyFailure('disk_error');
    }
  }

  _resolveWaiters() {
    if (this.draining || this.queue.length > 0) return;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  _scheduleDrain() {
    if (!this.enabled || this.closed || this.draining || this.unavailable) return;
    this.draining = true;
    Promise.resolve().then(async () => {
      try {
        while (this.queue.length > 0 && !this.closed && !this.unavailable) {
          const line = this.queue.shift();
          this.stats.queued = this.queue.length;
          try {
            await this._appendLine(line);
          } catch (_) {
            this.unavailable = true;
            this.stats.diskErrorCount++;
            this.stats.droppedCount += this.queue.length + 1;
            this.queue.length = 0;
            this.stats.queued = 0;
            this._notifyFailure('disk_error');
          }
        }
      } finally {
        this.draining = false;
        this._resolveWaiters();
        if (this.queue.length > 0 && !this.unavailable && !this.closed) this._scheduleDrain();
      }
    });
  }

  enqueue(line) {
    if (!this.enabled || this.closed || this.unavailable) return false;
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
      this.stats.droppedCount++;
      return false;
    }
    if (this.queue.length >= this.queueLimit) {
      this.stats.droppedCount++;
      return false;
    }
    this.queue.push(line);
    this.stats.queued = this.queue.length;
    this._scheduleDrain();
    return true;
  }

  writeEvent(event) {
    if (!this.enabled) return false;
    let input = {};
    try {
      if (event && typeof event === 'object') input = event;
    } catch (_) {
      input = {};
    }
    const read = key => {
      try {
        return input[key];
      } catch (_) {
        return undefined;
      }
    };
    const probeRole = read('probeRole');
    const safeEvent = {
      utcTime: new Date().toISOString(),
      serviceRole: this.role,
      pid: this.pid,
      diagnosticId: safeDiagnosticId(read('diagnosticId'), generateDiagnosticId(this.role, this.pid, ++this.requestSequence)),
      correlationId: safeCorrelationId(read('correlationId')),
      route: safeRoute(read('route')),
      probeRole: PROBE_ROLES.has(probeRole) ? probeRole : null,
      phase: safePhase(read('phase')),
      elapsedMs: safeElapsedMs(read('elapsedMs')),
      httpStatus: safeStatus(read('httpStatus')),
      errorCode: safeErrorCode(read('errorCode'))
    };
    let line;
    try {
      line = `${JSON.stringify(safeEvent)}\n`;
    } catch (_) {
      this.stats.droppedCount++;
      return false;
    }
    return this.enqueue(line);
  }

  flush() {
    if (!this.enabled || (!this.draining && this.queue.length === 0)) return Promise.resolve();
    return new Promise(resolve => this.waiters.push(resolve));
  }

  async close() {
    if (!this.enabled) return;
    await this.flush();
    this.closed = true;
  }

  getStats() {
    return Object.freeze({
      droppedCount: this.stats.droppedCount,
      diskErrorCount: this.stats.diskErrorCount,
      queued: this.queue.length,
      writtenCount: this.stats.writtenCount,
      unavailable: this.unavailable
    });
  }
}

class RequestDiagnosticContext {
  constructor(writer, req, res, route) {
    this.writer = writer;
    this.req = req;
    this.res = res;
    this.start = process.hrtime.bigint();
    this.diagnosticId = generateDiagnosticId(writer.role, writer.pid, ++writer.requestSequence);
    this.correlationId = null;
    this.route = safeRoute(route);
    this.onceKeys = new Set();
    this.terminal = false;
    this.proxyStarted = false;
  }

  setRoute(route) {
    this.route = safeRoute(route);
  }

  setCorrelationFromBody(body) {
    const extracted = extractCorrelationId(body);
    if (extracted) this.correlationId = extracted;
  }

  stage(phase, httpStatus = null, errorCode = null, probeRole = null) {
    this.writer.writeEvent({
      utcTime: new Date().toISOString(),
      serviceRole: this.writer.role,
      pid: this.writer.pid,
      diagnosticId: this.diagnosticId,
      correlationId: this.correlationId,
      route: this.route,
      probeRole: PROBE_ROLES.has(probeRole) ? probeRole : null,
      phase: safePhase(phase),
      elapsedMs: monotonicElapsedMs(this.start),
      httpStatus: safeStatus(httpStatus),
      errorCode: safeErrorCode(errorCode)
    });
  }

  stageOnce(key, phase, httpStatus = null, errorCode = null, probeRole = null) {
    if (this.onceKeys.has(key)) return;
    this.onceKeys.add(key);
    this.stage(phase, httpStatus, errorCode, probeRole);
  }

  bodyParsed(body) {
    this.setCorrelationFromBody(body);
    this.stageOnce('body_parsed', 'body_parsed');
  }

  firstOutput(httpStatus = null) {
    this.stageOnce('first_output', 'first_output', httpStatus);
  }

  complete(httpStatus = null) {
    if (this.terminal) return;
    this.terminal = true;
    this.stage('complete', httpStatus);
  }

  disconnect(httpStatus = null) {
    if (this.terminal) return;
    this.terminal = true;
    this.stage('disconnect', httpStatus, 'aborted');
  }

  error(errorCode, httpStatus = null) {
    if (this.onceKeys.has('error')) return;
    this.onceKeys.add('error');
    this.stage('error', httpStatus, ERROR_CODES.has(errorCode) ? errorCode : 'handler_error');
  }

  markProxyStarted() {
    this.proxyStarted = true;
  }
}

class RequestDiagnostics {
  constructor(options = {}) {
    const env = options.env || process.env;
    this.enabled = options.enabled === undefined
      ? parseBoolean(env.VCP_DIAGNOSTICS_ENABLED, false)
      : options.enabled === true;
    this.role = normalizeRole(options.role);
    this.rootDir = options.rootDir || process.cwd();
    this.writer = new BoundedJsonlWriter({
      enabled: this.enabled,
      role: this.role,
      pid: process.pid,
      directory: options.directory || resolveDiagnosticsDirectory(this.rootDir, env.VCP_DIAGNOSTICS_DIR),
      queueLimit: options.queueLimit ?? boundedInteger(env.VCP_DIAGNOSTICS_QUEUE_LIMIT, DEFAULT_QUEUE_LIMIT, 1, 16384),
      maxLineBytes: options.maxLineBytes ?? boundedInteger(env.VCP_DIAGNOSTICS_MAX_LINE_BYTES, DEFAULT_MAX_LINE_BYTES, 256, 65536),
      maxFileBytes: options.maxFileBytes ?? boundedInteger(env.VCP_DIAGNOSTICS_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES, 1024, 256 * 1024 * 1024),
      maxFiles: options.maxFiles ?? boundedInteger(env.VCP_DIAGNOSTICS_MAX_FILES, DEFAULT_MAX_FILES, 1, 128),
      maxTotalBytes: options.maxTotalBytes ?? boundedInteger(env.VCP_DIAGNOSTICS_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES, 1024 * 1024, 1024 * 1024 * 1024),
      fsImpl: options.fsImpl,
      onInternalFailure: options.onInternalFailure
    });
    this.requestSequence = 0;
  }

  middleware(options = {}) {
    const routeClassifier = typeof options.routeClassifier === 'function' ? options.routeClassifier : () => 'other';
    return (req, res, next) => {
      if (!this.enabled) return next();

      let route = 'other';
      try {
        route = routeClassifier(req);
      } catch (_) {
        route = 'other';
      }
      const context = new RequestDiagnosticContext(this.writer, req, res, route);
      req.__vcpDiagnostics = context;
      context.stage('request_enter');

      const originalWrite = res.write;
      const originalEnd = res.end;
      res.write = function diagnosticWrite(chunk, encoding, callback) {
        context.firstOutput(res.statusCode);
        return originalWrite.call(this, chunk, encoding, callback);
      };
      res.end = function diagnosticEnd(chunk, encoding, callback) {
        if (chunk !== undefined && chunk !== null) context.firstOutput(res.statusCode);
        return originalEnd.call(this, chunk, encoding, callback);
      };

      req.once('aborted', () => context.disconnect(res.statusCode));
      res.once('finish', () => context.complete(res.statusCode));
      res.once('close', () => {
        if (!res.writableEnded) context.disconnect(res.statusCode);
      });
      next();
    };
  }

  markBodyParsed(req, body) {
    if (!this.enabled) return;
    const context = req && req.__vcpDiagnostics;
    if (context) context.bodyParsed(body);
  }

  recordSystem({ phase, route = 'diagnostics', errorCode = null, httpStatus = null, probeRole = null } = {}) {
    if (!this.enabled) return;
    const diagnosticId = generateDiagnosticId(this.role, this.writer.pid, ++this.requestSequence);
    this.writer.writeEvent({
      utcTime: new Date().toISOString(),
      serviceRole: this.writer.role,
      pid: this.writer.pid,
      diagnosticId,
      correlationId: null,
      route: safeRoute(route),
      probeRole: PROBE_ROLES.has(probeRole) ? probeRole : null,
      phase: safePhase(phase),
      elapsedMs: 0,
      httpStatus: safeStatus(httpStatus),
      errorCode: safeErrorCode(errorCode)
    });
  }

  flush() {
    return this.writer.flush();
  }

  close() {
    return this.writer.close();
  }

  getStats() {
    return this.writer.getStats();
  }
}

function classifyMainRoute(req) {
  const requestPath = typeof req?.path === 'string' ? req.path : '';
  if (requestPath === '/v1/chat/completions' || requestPath === '/v1/chatvcp/completions') return 'chat';
  if (requestPath === '/v1/interrupt') return 'interrupt';
  if (requestPath === '/v1/models') return 'models';
  if (requestPath.startsWith('/admin_api')) return 'admin_api';
  if (requestPath.startsWith('/plugin-callback/')) return 'plugin_callback';
  if (requestPath.startsWith('/v1/responses') || requestPath.startsWith('/v1/messages') || requestPath.startsWith('/v1beta/')) return 'protocol';
  if (requestPath.startsWith('/__vcp_diag/')) return 'diagnostics';
  return 'other';
}

function classifyAdminRoute(req) {
  const requestPath = typeof req?.path === 'string' ? req.path : '';
  if (requestPath.startsWith('/AdminPanel')) return 'static';
  if (requestPath.startsWith('/admin_api')) return 'admin_api';
  if (requestPath.startsWith('/__vcp_diag/')) return 'diagnostics';
  return 'other';
}

function isLoopbackSocket(req) {
  const remoteAddress = req?.socket?.remoteAddress;
  if (typeof remoteAddress !== 'string') return false;
  const normalized = remoteAddress.toLowerCase().replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1';
}

module.exports = {
  BoundedJsonlWriter,
  RequestDiagnostics,
  classifyAdminRoute,
  classifyMainRoute,
  extractCorrelationId,
  isLoopbackSocket,
  parseBoolean,
  resolveDiagnosticsDirectory,
  safeCorrelationId
};
