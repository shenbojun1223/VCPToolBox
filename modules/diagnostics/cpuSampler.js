'use strict';

const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const DEFAULT_SAMPLING_INTERVAL_MS = 10;
const DEFAULT_SEGMENT_DURATION_MS = 60 * 1000;
const DEFAULT_MAX_SEGMENTS = 8;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const INSPECTOR_REQUEST_TIMEOUT_MS = 5000;
const WORKER_KIND = 'vcp-main-thread-cpu-sampler';

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return String(value).toLowerCase() === 'true';
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function safeRole(role) {
  return role === 'main' || role === 'admin' ? role : 'other';
}

function safeDirectory(rootDir, directory) {
  if (typeof directory === 'string' && directory.trim()) return path.resolve(directory.trim());
  return path.join(rootDir || process.cwd(), 'DebugLog', 'diagnostics');
}

function emitWorkerEvent(phase, errorCode = null) {
  try {
    parentPort?.postMessage({ type: 'event', phase, errorCode });
  } catch (_) {
    // A terminating parent is not an actionable failure.
  }
}

function postInspector(session, method, params, timeoutMs = INSPECTOR_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error('inspector request timed out'), { code: 'INSPECTOR_TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
    try {
      session.post(method, params || {}, (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function writeProfile(directory, role, pid, sequence, profile, metadata) {
  await fs.promises.mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const randomPart = Math.random().toString(16).slice(2, 10);
  const filename = `vcp-cpu-${role}-pid${pid}-target-main-${timestamp}-seg${String(sequence).padStart(4, '0')}-${randomPart}.cpuprofile`;
  const filePath = path.join(directory, filename);
  const tempPath = `${filePath}.tmp`;
  const output = {
    ...profile,
    diagnostics: {
      sampleTarget: 'main-thread',
      targetThreadId: 'main',
      serviceRole: role,
      processPid: pid,
      windowStartUtc: metadata.windowStartUtc,
      windowEndUtc: metadata.windowEndUtc,
      samplingIntervalMs: metadata.samplingIntervalMs,
      segmentSequence: sequence
    }
  };
  try {
    await fs.promises.writeFile(tempPath, JSON.stringify(output), 'utf8');
    await fs.promises.rename(tempPath, filePath);
    return { filePath, filename };
  } catch (error) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (_) {
      // The temporary file is owned by this sampler; cleanup is best-effort.
    }
    throw error;
  }
}

async function enforceRetention(directory, role, maxSegments, maxTotalBytes) {
  const names = await fs.promises.readdir(directory);
  const prefix = `vcp-cpu-${role}-pid`;
  const candidates = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.cpuprofile') || name.includes('.tmp')) continue;
    const filePath = path.join(directory, name);
    try {
      const stat = await fs.promises.stat(filePath);
      candidates.push({ filePath, name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (_) {
      // A concurrent deletion is harmless.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
  let kept = 0;
  let total = 0;
  for (const candidate of candidates) {
    const keep = kept < maxSegments && (total + candidate.size <= maxTotalBytes || kept === 0);
    if (keep) {
      kept++;
      total += candidate.size;
      continue;
    }
    try {
      await fs.promises.unlink(candidate.filePath);
    } catch (_) {
      // Retention must not stop sampling.
    }
  }
}

async function runSamplerWorker(options) {
  if (!workerData || workerData.kind !== WORKER_KIND) return;

  let inspector;
  try {
    inspector = require('inspector');
    if (typeof inspector.Session !== 'function' || typeof inspector.Session.prototype.connectToMainThread !== 'function') {
      emitWorkerEvent('cpu_segment_error', 'unsupported');
      return;
    }
  } catch (_) {
    emitWorkerEvent('cpu_segment_error', 'unsupported');
    return;
  }

  const session = new inspector.Session();
  let connected = false;
  let profilerStarted = false;
  let stopping = false;
  let activeSegment = null;
  let sequence = 0;

  const disconnectSession = () => {
    if (!connected) return;
    try {
      session.disconnect();
    } catch (_) {
      // Session cleanup is best-effort.
    }
    connected = false;
  };

  const stopProfiler = async () => {
    if (!profilerStarted) return null;
    profilerStarted = false;
    return postInspector(session, 'Profiler.stop');
  };

  const saveActiveSegment = async () => {
    if (!activeSegment) return;
    const segment = activeSegment;
    activeSegment = null;
    try {
      const result = await stopProfiler();
      if (!result?.profile) return;
      const windowEndUtc = new Date().toISOString();
      const saved = await writeProfile(options.directory, options.role, options.pid, sequence, result.profile, {
        windowStartUtc: segment.windowStartUtc,
        windowEndUtc,
        samplingIntervalMs: options.samplingIntervalMs
      });
      await enforceRetention(options.directory, options.role, options.maxSegments, options.maxTotalBytes);
      emitWorkerEvent('cpu_segment_saved', null);
      try {
        parentPort?.postMessage({ type: 'saved', filename: saved.filename });
      } catch (_) {
        // Parent may be closing after the profile was safely written.
      }
    } catch (error) {
      const code = error?.code === 'INSPECTOR_TIMEOUT' ? 'inspector_timeout' : 'disk_error';
      emitWorkerEvent('cpu_segment_error', code);
      stopping = true;
      disconnectSession();
    }
  };

  const startProfiler = async () => {
    if (stopping || profilerStarted) return false;
    try {
      await postInspector(session, 'Profiler.enable');
      // Inspector expects microseconds; configuration and profile metadata use milliseconds.
      await postInspector(session, 'Profiler.setSamplingInterval', { interval: options.samplingIntervalMs * 1000 });
      await postInspector(session, 'Profiler.start');
      profilerStarted = true;
      sequence++;
      activeSegment = { windowStartUtc: new Date().toISOString() };
      return true;
    } catch (error) {
      const code = error?.code === 'INSPECTOR_TIMEOUT' ? 'inspector_timeout' : 'profiler_busy';
      emitWorkerEvent('cpu_segment_error', code);
      stopping = true;
      disconnectSession();
      return false;
    }
  };

  try {
    session.connectToMainThread();
    connected = true;
  } catch (_) {
    emitWorkerEvent('cpu_segment_error', 'unsupported');
    disconnectSession();
    return;
  }

  parentPort?.on('message', message => {
    if (message?.type === 'stop') stopping = true;
  });

  if (!(await startProfiler())) return;

  while (!stopping) {
    await new Promise(resolve => setTimeout(resolve, options.segmentDurationMs));
    if (stopping) break;
    await saveActiveSegment();
    if (!stopping) await startProfiler();
  }

  await saveActiveSegment();
  disconnectSession();
}

function createDisabledController(reason = null) {
  return {
    enabled: false,
    reason,
    stop: async () => undefined
  };
}

function createCpuSampler(options = {}) {
  if (!isMainThread) return createDisabledController('unsupported');
  const env = options.env || process.env;
  const enabled = options.enabled === undefined
    ? parseBoolean(env.VCP_DIAGNOSTICS_ENABLED, false) && parseBoolean(env.VCP_DIAGNOSTICS_CPU_ENABLED, false)
    : options.enabled === true;
  if (!enabled) return createDisabledController('disabled');

  const role = safeRole(options.role);
  const samplingIntervalMs = options.samplingIntervalMs ?? boundedInteger(env.VCP_DIAGNOSTICS_CPU_SAMPLING_MS, DEFAULT_SAMPLING_INTERVAL_MS, 2, 1000);
  const segmentDurationMs = options.segmentDurationMs ?? boundedInteger(env.VCP_DIAGNOSTICS_CPU_SEGMENT_MS, DEFAULT_SEGMENT_DURATION_MS, 1000, 15 * 60 * 1000);
  const maxSegments = options.maxSegments ?? boundedInteger(env.VCP_DIAGNOSTICS_CPU_MAX_SEGMENTS, DEFAULT_MAX_SEGMENTS, 1, 64);
  const maxTotalBytes = options.maxTotalBytes ?? boundedInteger(env.VCP_DIAGNOSTICS_CPU_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES, 8 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
  const directory = safeDirectory(options.rootDir || process.cwd(), options.directory || env.VCP_DIAGNOSTICS_DIR);

  let worker;
  try {
    worker = new Worker(__filename, {
      workerData: {
        kind: WORKER_KIND,
        role,
        pid: process.pid,
        directory,
        samplingIntervalMs,
        segmentDurationMs,
        maxSegments,
        maxTotalBytes
      }
    });
  } catch (_) {
    options.eventLogger?.recordSystem({ phase: 'cpu_segment_error', route: 'diagnostics', errorCode: 'unsupported' });
    return createDisabledController('unsupported');
  }

  worker.unref?.();
  let stopped = false;
  let stopPromise = null;
  let resolveExit;
  const exitPromise = new Promise(resolve => { resolveExit = resolve; });
  worker.on('message', message => {
    if (message?.type === 'event') {
      try {
        options.eventLogger?.recordSystem({ phase: message.phase, route: 'diagnostics', errorCode: message.errorCode });
      } catch (_) {
        // Diagnostic event forwarding is best-effort and cannot affect the host.
      }
    }
  });
  worker.once('error', () => {
    try {
      options.eventLogger?.recordSystem({ phase: 'cpu_segment_error', route: 'diagnostics', errorCode: 'inspector_error' });
    } catch (_) {
      // Diagnostic event forwarding is best-effort and cannot affect the host.
    }
    resolveExit();
  });
  worker.once('exit', () => resolveExit());

  return {
    enabled: true,
    role,
    stop: () => {
      if (stopped) return stopPromise || Promise.resolve();
      stopped = true;
      stopPromise = new Promise(resolve => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const timer = setTimeout(async () => {
          try {
            await worker.terminate();
          } catch (_) {
            // Termination is best-effort after the bounded deadline.
          }
          finish();
        }, INSPECTOR_REQUEST_TIMEOUT_MS);
        timer.unref?.();
        try {
          worker.postMessage({ type: 'stop' });
        } catch (_) {
          clearTimeout(timer);
          finish();
          return;
        }
        exitPromise.then(() => {
          clearTimeout(timer);
          finish();
        });
      });
      return stopPromise;
    }
  };
}

if (!isMainThread) {
  runSamplerWorker(workerData).catch(() => {
    emitWorkerEvent('cpu_segment_error', 'inspector_error');
  });
}

module.exports = {
  createCpuSampler,
  DEFAULT_SAMPLING_INTERVAL_MS,
  DEFAULT_SEGMENT_DURATION_MS
};
