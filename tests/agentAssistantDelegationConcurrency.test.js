'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');

const entry = path.resolve(__dirname, '../Plugin/AgentAssistant/AgentAssistant.js');
const localRequire = createRequire(entry);

function harness() {
    const config = {
        maxHistoryRounds: 2,
        contextTtlHours: 1,
        delegationMaxRounds: 2,
        delegationTimeout: 30000,
        agents: [{
            baseName: 'SYNTHETIC', chineseName: 'SyntheticWorker',
            modelId: 'offline-only', systemPrompt: 'Synthetic fixture', temperature: 0.3
        }]
    };
    const files = new Map();
    const chats = [];
    const callbacks = [];
    const warnings = [];
    const timers = new Set();
    const configPath = path.join(path.dirname(entry), 'config.json');
    const fakeFs = {
        existsSync: p => p === configPath || files.has(p),
        readFileSync: p => {
            if (p === configPath) return JSON.stringify(config);
            if (files.has(p)) return files.get(p);
            throw new Error(`Unexpected fixture read: ${p}`);
        },
        writeFileSync: (p, value) => files.set(p, String(value)),
        mkdirSync: () => {},
        readdirSync: () => []
    };
    const axios = {
        isAxiosError: () => false,
        post: (url, payload) => {
            if (url.endsWith('/chat/completions')) {
                return new Promise((resolve, reject) => {
                    chats.push({ payload, resolve, reject });
                });
            }
            if (url.includes('/plugin-callback/AgentAssistant/')) {
                callbacks.push({ url, payload });
                return Promise.resolve({ data: { status: 'success' } });
            }
            throw new Error(`Unexpected offline HTTP route: ${url}`);
        }
    };
    const sandbox = {
        module: { exports: {} }, exports: {},
        __filename: entry, __dirname: path.dirname(entry),
        process: { env: {} },
        console: {
            log() {}, warn: (...args) => warnings.push(args.join(' ')),
            error: (...args) => warnings.push(args.join(' '))
        },
        setInterval: () => 1, clearInterval() {},
        setTimeout: (fn, ms) => {
            const id = setTimeout(() => { timers.delete(id); fn(); }, Math.min(ms, 5));
            timers.add(id);
            return id;
        },
        clearTimeout: id => { timers.delete(id); clearTimeout(id); },
        require: name => {
            if (name === 'fs') return fakeFs;
            if (name === 'path') return path;
            if (name === 'axios') return axios;
            if (name === 'dotenv') return { parse: () => ({}) };
            if (name === 'uuid') return { v4: randomUUID };
            if (name === '../../modules/reasoningContentAdapter.js' ||
                name === './flowlockProtocol.js' ||
                name === '../../modules/vcpLoop/modelOutputGuard') return localRequire(name);
            throw new Error(`Unexpected fixture dependency: ${name}`);
        }
    };
    vm.runInNewContext(
        fs.readFileSync(entry, 'utf8') +
        '\nmodule.exports.__test = { activeSessionLocks, activeDelegations };',
        sandbox,
        { filename: entry, timeout: 5000 }
    );
    const api = sandbox.module.exports;
    api.initialize({ PORT: 1, Key: 'synthetic-not-a-real-key' }, {
        vcpLogFunctions: { pushVcpInfo() {} }
    });
    return {
        api, chats, callbacks, files, warnings,
        async submit(prompt, session) {
            const args = {
                agent_name: 'SyntheticWorker', prompt,
                maid: 'OfflineTest', task_delegation: true
            };
            if (session !== undefined) args.session_id = session;
            const receipt = await api.processToolCall(args);
            const match = JSON.stringify(receipt).match(/aa-delegation-\d+-[a-f0-9]+/);
            assert.ok(match, 'delegation receipt must contain a real generated ID');
            return match[0];
        },
        finish(index, text = 'Synthetic report') {
            chats[index].resolve({
                data: { choices: [{ message: { content: `${text}\n[[Flowlock::Complete]]` } }] }
            });
        },
        close() {
            api.shutdown();
            for (const id of timers) clearTimeout(id);
            timers.clear();
        }
    };
}

async function until(predicate, description) {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, `Timed out: ${description}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

for (const [name, sessions] of [
    ['different explicit keys overlap', ['task-A', 'task-B']],
    ['omitted keys isolate by delegation ID', [undefined, undefined]]
]) {
    test(name, { timeout: 5000 }, async t => {
        const h = harness(); t.after(() => h.close());
        const a = await h.submit('alpha', sessions[0]);
        const b = await h.submit('beta', sessions[1]);
        await until(() => h.chats.length === 2, 'both requests started before either resolved');
        assert.equal(h.api.__test.activeSessionLocks.size, 2);
        assert.notEqual(a, b);
        h.finish(1, 'beta result');
        h.finish(0, 'alpha result');
        await until(() => h.callbacks.length === 2, 'both callbacks');
        assert.equal(h.api.__test.activeSessionLocks.size, 0);
        assert.equal(h.api.__test.activeDelegations.size, 0);
        assert.ok(h.callbacks.find(c => c.url.endsWith(a)).payload.message.includes('alpha result'));
        assert.ok(h.callbacks.find(c => c.url.endsWith(b)).payload.message.includes('beta result'));
    });
}

test('same normalized key serializes but does not share message history', { timeout: 5000 }, async t => {
    const h = harness(); t.after(() => h.close());
    await h.submit('alpha', ' task-shared ');
    await until(() => h.chats.length === 1, 'first request');
    await h.submit('beta', 'task-shared');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.chats.length, 1);
    h.finish(0, 'first private result');
    await until(() => h.chats.length === 2, 'second starts after first releases');
    const messages = h.chats[1].payload.messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[1].content, 'beta');
    assert.ok(!JSON.stringify(messages).includes('first private result'));
    h.finish(1);
    await until(() => h.callbacks.length === 2, 'serialized callbacks');
    assert.equal(h.api.__test.activeSessionLocks.size, 0);
});

test('model error releases key for a later delegation', { timeout: 5000 }, async t => {
    const h = harness(); t.after(() => h.close());
    await h.submit('fails', 'retry-key');
    await until(() => h.chats.length === 1, 'failing request');
    h.chats[0].reject(new Error('synthetic failure'));
    await until(() => h.api.__test.activeDelegations.size === 0, 'failed task removed');
    assert.equal(h.api.__test.activeSessionLocks.size, 0);
    assert.ok(h.callbacks.length >= 1);
    assert.ok(h.callbacks.every(c => c.payload.status === 'Failed'));
    await h.submit('next task', 'retry-key');
    await until(() => h.chats.length === 2, 'later request acquires released key');
    h.finish(1);
    await until(() => h.api.__test.activeDelegations.size === 0, 'later task completes');
    assert.equal(h.api.__test.activeSessionLocks.size, 0);
});

test('cancelled lock waiter does not release another task lock', { timeout: 5000 }, async t => {
    const h = harness(); t.after(() => h.close());
    await h.submit('holder', 'held-key');
    await until(() => h.chats.length === 1, 'holder started');
    const waiter = await h.submit('waiter', 'held-key');
    h.api.cancelDelegation(waiter, 'synthetic cancel');
    await until(() => !h.api.__test.activeDelegations.has(waiter), 'waiter cancellation');
    assert.equal(h.chats.length, 1);
    assert.equal(h.api.__test.activeSessionLocks.size, 1);
    h.finish(0);
    await until(() => h.api.__test.activeDelegations.size === 0, 'holder completed');
    assert.equal(h.api.__test.activeSessionLocks.size, 0);
});

test('active cancellation is cooperative and releases only after response', { timeout: 5000 }, async t => {
    const h = harness(); t.after(() => h.close());
    const id = await h.submit('active', 'active-key');
    await until(() => h.chats.length === 1, 'request started');
    h.api.cancelDelegation(id, 'synthetic cancel');
    assert.equal(h.api.__test.activeSessionLocks.size, 1);
    h.finish(0);
    await until(() => h.callbacks.length === 1, 'cancel callback');
    assert.equal(h.callbacks[0].payload.status, 'Cancelled');
    assert.equal(h.api.__test.activeSessionLocks.size, 0);
    assert.equal(h.api.__test.activeDelegations.size, 0);
});

const { STATUS: HALT_STATUS } = localRequire('../../modules/vcpLoop/modelOutputGuard');
for (const [name, message] of [
    ['Complete cannot override server halt', { content: 'UNTRUSTED_BODY\n[[Flowlock::Complete]]' }],
    ['halt is handled even without a message', undefined]
]) {
    test(name, { timeout: 5000 }, async t => {
        const h = harness(); t.after(() => h.close());
        const id = await h.submit('protocol halt fixture', 'guard-key');
        await until(() => h.chats.length === 1, 'initial request');
        h.chats[0].resolve({ data: {
            choices: message ? [{ message }] : [],
            vcp_status: { code: HALT_STATUS, reason: 'UNTRUSTED_REASON' }
        } });
        await until(() => h.callbacks.length > 0, 'failure callback');
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(h.callbacks.length, 1, 'one terminal callback, not finally plus catch');
        assert.equal(h.callbacks[0].payload.status, 'Failed');
        assert.ok(h.callbacks[0].url.endsWith(id));
        assert.ok(h.callbacks[0].payload.message.includes(HALT_STATUS));
        assert.ok(!h.callbacks[0].payload.message.includes('UNTRUSTED'));
        assert.equal(h.chats.length, 1, 'no continuation HTTP request');
        assert.equal(h.api.__test.activeSessionLocks.size, 0);
        assert.equal(h.api.__test.activeDelegations.size, 0);
        assert.ok(![...h.files.keys()].some(p => p.endsWith('agent_scores.json')), 'no success reward');
        const archives = [...h.files.entries()].filter(([p]) => p.endsWith('.md'));
        assert.equal(archives.length, 1);
        assert.ok(archives[0][1].includes(HALT_STATUS));
        await h.submit('independent later task', 'guard-key');
        await until(() => h.chats.length === 2, 'released key reusable');
        h.finish(1);
        await until(() => h.callbacks.length === 2, 'later task completes');
        assert.equal(h.callbacks[1].payload.status, 'Succeed');
    });
}

test('server halt after a started heartbeat stops before another heartbeat', { timeout: 5000 }, async t => {
    const h = harness(); t.after(() => h.close());
    await h.submit('one valid heartbeat then halt', 'heartbeat-key');
    await until(() => h.chats.length === 1, 'first request');
    h.chats[0].resolve({ data: { choices: [{ message: { content: 'Working\n[[Flowlock::Start]]' } }] } });
    await until(() => h.chats.length === 2, 'one allowed heartbeat');
    h.chats[1].resolve({ data: {
        choices: [{ message: { content: '[[Flowlock::Complete]]' } }],
        vcp_status: { code: HALT_STATUS, reason: 'unsupported_tool_protocol' }
    } });
    await until(() => h.callbacks.length === 1, 'halt callback');
    assert.equal(h.callbacks[0].payload.status, 'Failed');
    assert.equal(h.chats.length, 2);
    assert.equal(h.api.__test.activeSessionLocks.size, 0);
    assert.equal(h.api.__test.activeDelegations.size, 0);
});

test('delegation does not scan assembled trusted tool results for protocol tags', { timeout: 5000 }, async t => {
    const h = harness(); t.after(() => h.close());
    await h.submit('safe returned content', 'data-key');
    await until(() => h.chats.length === 1, 'request');
    const tag = '<' + '｜DSML｜function_calls>';
    const receipt = '[[' + 'VCP调用结果信息汇总:\n' + tag + '\nVCP调用结果结束]]';
    h.finish(0, '示例：`' + tag + '`\n' + receipt + '\n' + HALT_STATUS);
    await until(() => h.callbacks.length === 1, 'normal completion');
    assert.equal(h.callbacks[0].payload.status, 'Succeed');
    assert.equal(h.chats.length, 1);
});