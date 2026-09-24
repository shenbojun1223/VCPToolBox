'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
const realChildProcess = originalLoad('child_process', module, false);
let fakeMode = 'drained';
let fakePid = 50000;

function makeStream() {
    const stream = new EventEmitter();
    stream.setEncoding = () => {};
    return stream;
}

function makeFakeProcess(stdoutDrains) {
    const child = new EventEmitter();
    child.pid = ++fakePid;
    child.stdout = makeStream();
    child.stderr = makeStream();
    child.stdin = {
        write: () => true,
        end: () => {}
    };

    setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({
            status: 'success',
            result: { stdoutDrains }
        }));
        if (stdoutDrains) child.stdout.emit('end');
        child.stderr.emit('end');
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
    });

    return child;
}

function fakeSpawn(command, args, options) {
    if (command === 'vcp-close-gate-fake') {
        return makeFakeProcess(fakeMode === 'drained');
    }
    return realChildProcess.spawn(command, args, options);
}

Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'child_process' || request === 'node:child_process') {
        return { ...realChildProcess, spawn: fakeSpawn };
    }
    return originalLoad.call(this, request, parent, isMain);
};

let pluginManager;
try {
    pluginManager = require('../Plugin');
} finally {
    Module._load = originalLoad;
}

const initialPlugins = pluginManager.plugins;
const initialDebugMode = pluginManager.debugMode;
const fakeManifest = {
    name: 'StdoutCloseGateFake',
    pluginType: 'synchronous',
    basePath: process.cwd(),
    entryPoint: {
        type: 'nodejs',
        command: 'vcp-close-gate-fake'
    },
    communication: {
        protocol: 'stdio',
        timeout: 500
    }
};

async function executeFake() {
    const previousPlugins = pluginManager.plugins;
    const previousDebugMode = pluginManager.debugMode;
    pluginManager.plugins = new Map([[fakeManifest.name, fakeManifest]]);
    pluginManager.debugMode = false;
    try {
        return await pluginManager.executePlugin(fakeManifest.name, null, null, {});
    } finally {
        pluginManager.plugins = previousPlugins;
        pluginManager.debugMode = previousDebugMode;
    }
}

function withTimeout(promise, timeoutMs) {
    let timeoutId;
    const timeoutPromise = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('close gate test timed out')), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

test('synchronous close gate accepts drained stdout and rejects close before stdout end', async () => {
    fakeMode = 'drained';
    const drained = await withTimeout(executeFake(), 500);
    assert.equal(drained.status, 'success');
    assert.equal(drained.result.stdoutDrains, true);

    fakeMode = 'missing-stdout-end';
    await assert.rejects(
        withTimeout(executeFake(), 500),
        /closed before stdout\/stderr streams drained/
    );
});

test.after(async () => {
    try {
        const approvalManager = pluginManager.toolApprovalManager;
        if (approvalManager?.watcher) {
            const watcher = approvalManager.watcher;
            approvalManager.watcher = null;
            await watcher.close();
        }
    } finally {
        pluginManager.plugins = initialPlugins;
        pluginManager.debugMode = initialDebugMode;
    }
});
