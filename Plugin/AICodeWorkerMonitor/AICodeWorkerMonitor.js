// AICodeWorkerMonitor.js
// 监听 AICodeWorker 的 jobs/meta/*.json 文件变更，广播任务状态给 WorkerPanel 前端客户端。
// 设计原则：对 AICodeWorker.js / runner.js 零侵入。detached 子进程无法向主进程发进程内事件，
// 因此以 meta.json（AICodeWorker 自身的状态真相源）为锚，用主进程常驻 chokidar 监听文件变更。

const fs = require('fs');
const path = require('path');

let chokidarWatcher = null;
let pluginManagerRef = null; // 来自 Plugin.js 无条件注入的 dependencies.pluginManager
let pluginConfig = {};
let watchedMetaDir = null;

function debugLog(...args) {
    if (pluginConfig && pluginConfig.DebugMode) {
        console.log('[AICodeWorkerMonitor]', ...args);
    }
}

function resolveMetaDir(config) {
    if (config.AICODEWORKER_JOBS_META_PATH && config.AICODEWORKER_JOBS_META_PATH.trim()) {
        return config.AICODEWORKER_JOBS_META_PATH.trim();
    }
    const base = config.PROJECT_BASE_PATH;
    if (!base) {
        console.error('[AICodeWorkerMonitor] PROJECT_BASE_PATH not provided by PluginManager; cannot resolve meta dir.');
        return null;
    }
    return path.join(base, 'Plugin', 'AICodeWorker', 'jobs', 'meta');
}

function readMetaWithRetry(filePath, attempt = 0) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        // meta.json 写入方式是 fs.writeFileSync 整体覆写（非原子 rename），
        // chokidar 事件可能在写入尚未完成时触发，短暂重试一次即可。
        if (attempt < 1) {
            return new Promise(resolve => {
                setTimeout(() => resolve(readMetaWithRetry(filePath, attempt + 1)), 80);
            });
        }
        debugLog(`Failed to read/parse meta file after retry: ${filePath}`, error.message);
        return null;
    }
}

function buildJobStatusPayload(meta, filePath) {
    return {
        type: 'job_status_update',
        data: {
            jobId: meta.jobId || path.basename(filePath, '.json'),
            state: meta.state || 'unknown',
            worker: meta.worker || null,
            mode: meta.mode || null,
            jobKind: meta.jobKind || null,
            jobPhase: meta.jobPhase || null,
            patchAvailable: meta.patchAvailable === true,
            patchValidated: meta.patchValidated === true,
            applyCheckPassed: meta.applyCheckPassed === true,
            baselineStable: meta.baselineStable === true,
            patchBytes: Number.isSafeInteger(meta.patchBytes) ? meta.patchBytes : null,
            patchFileCount: Number.isSafeInteger(meta.patchFileCount) ? meta.patchFileCount : null,
            pid: meta.workerPid || meta.pid || meta.sidecarPid || null,
            startedAt: meta.startedAt || null,
            completedAt: meta.completedAt || null,
            exitCode: meta.exitCode !== undefined ? meta.exitCode : null,
            exitReason: meta.exitReason || null,
            projectPath: meta.projectPath || null,
            executionBackend: meta.executionBackend || (meta.requestedExecutionBackend ? null : 'legacy-exec'),
            requestedExecutionBackend: meta.requestedExecutionBackend || null,
            submissionState: meta.submissionState || null,
            sidecarInstanceId: meta.sidecarInstanceId || null,
            sidecarPid: meta.sidecarPid || null,
            threadId: meta.threadId || null,
            turnId: meta.turnId || null,
            errorCode: meta.errorCode || null
        }
    };
}

function isJobMetaFile(filePath) {
    const fileName = path.basename(filePath);
    return fileName.endsWith('.json') && !fileName.endsWith('.args.json');
}

function normalizeSnapshotLimit(limit) {
    const parsed = Number.parseInt(limit, 10);
    return Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : 20, 50));
}

async function readRecentJobSnapshot(limit = 20, requestIp = null) {
    if (!pluginManagerRef || typeof pluginManagerRef.processToolCall !== 'function') {
        throw new Error('PluginManager processToolCall is unavailable.');
    }

    const boundedLimit = normalizeSnapshotLimit(limit);
    const result = await pluginManagerRef.processToolCall(
        'AICodeWorker',
        { command: 'listJobs', limit: boundedLimit },
        requestIp,
        'worker-panel-snapshot'
    );
    const jobs = Array.isArray(result && result.jobs) ? result.jobs : [];

    return jobs.slice(0, boundedLimit).map(job => {
        const fallbackPath = path.join(watchedMetaDir || '', `${job.jobId || 'unknown'}.json`);
        return buildJobStatusPayload(job, fallbackPath).data;
    });
}

async function sendSnapshot(ws, limit = 20) {
    if (!ws || typeof ws.send !== 'function' || ws.readyState !== 1) return 0;

    try {
        const jobs = await readRecentJobSnapshot(limit, ws.clientIp || null);
        if (ws.readyState !== 1) return 0;

        ws.send(JSON.stringify({
            type: 'job_status_snapshot',
            data: { jobs }
        }));
        debugLog('Sent job_status_snapshot with', jobs.length, 'jobs to WorkerPanel client.');
        return jobs.length;
    } catch (error) {
        debugLog('Failed to build/send WorkerPanel snapshot:', error.message);
        if (ws.readyState === 1) {
            try {
                ws.send(JSON.stringify({
                    type: 'job_status_snapshot',
                    data: { jobs: [] },
                    error: 'WorkerPanel snapshot unavailable.'
                }));
            } catch (_) {
                // Connection closed between readyState check and send.
            }
        }
        return 0;
    }
}

function broadcastJobStatus(meta, filePath) {
    const wss = pluginManagerRef && pluginManagerRef.webSocketServer;
    if (!wss || typeof wss.broadcast !== 'function') {
        debugLog('WebSocketServer not yet available on pluginManager; skipping broadcast for', filePath);
        return;
    }

    const payload = buildJobStatusPayload(meta, filePath);
    wss.broadcast(payload, 'WorkerPanel');
    debugLog('Broadcasted job_status_update for', payload.data.jobId, 'state=', payload.data.state);
}

function handleMetaFileEvent(filePath) {
    if (!isJobMetaFile(filePath)) return;

    const maybePromise = readMetaWithRetry(filePath);
    if (maybePromise instanceof Promise) {
        maybePromise.then(meta => {
            if (meta) broadcastJobStatus(meta, filePath);
        });
    } else if (maybePromise) {
        broadcastJobStatus(maybePromise, filePath);
    }
}

function startWatcher(metaDir) {
    if (!fs.existsSync(metaDir)) {
        try {
            fs.mkdirSync(metaDir, { recursive: true });
            debugLog('meta dir did not exist, created:', metaDir);
        } catch (error) {
            console.error('[AICodeWorkerMonitor] Failed to ensure meta dir exists:', metaDir, error.message);
            return;
        }
    }

    // chokidar 已是项目依赖（Plugin.js 自身使用），此处直接复用，不新增依赖。
    const chokidar = require('chokidar');
    chokidarWatcher = chokidar.watch(metaDir, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 200,
            pollInterval: 50
        }
    });

    chokidarWatcher
        .on('add', handleMetaFileEvent)
        .on('change', handleMetaFileEvent)
        .on('error', error => console.error('[AICodeWorkerMonitor] Watcher error:', error.message));

    console.log(`[AICodeWorkerMonitor] Watching AICodeWorker meta dir: ${metaDir}`);
}

function initialize(config, dependencies) {
    pluginConfig = config || {};
    pluginManagerRef = dependencies && dependencies.pluginManager ? dependencies.pluginManager : null;

    if (!pluginManagerRef) {
        console.error('[AICodeWorkerMonitor] dependencies.pluginManager not provided; broadcast will be unavailable.');
    }

    watchedMetaDir = resolveMetaDir(pluginConfig);
    if (!watchedMetaDir) {
        console.error('[AICodeWorkerMonitor] Could not resolve meta dir; monitor disabled.');
        return;
    }

    startWatcher(watchedMetaDir);
}

async function shutdown() {
    if (chokidarWatcher) {
        try {
            await chokidarWatcher.close();
            debugLog('Watcher closed.');
        } catch (error) {
            console.error('[AICodeWorkerMonitor] Error closing watcher:', error.message);
        } finally {
            chokidarWatcher = null;
        }
    }
}

module.exports = {
    initialize,
    shutdown,
    sendSnapshot,
    buildJobStatusPayload,
    __testing: {
        buildJobStatusPayload,
        isJobMetaFile,
        normalizeSnapshotLimit,
        readRecentJobSnapshot
    }
};
