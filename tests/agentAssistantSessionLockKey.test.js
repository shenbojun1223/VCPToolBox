'use strict';

// 会话占线锁键回归单测。
// 背景：普通持久会话曾用 `${agent_name}::${userSessionId}`，异步委托用
// `${agentConfig.baseName}::${userSessionId}`，同一显式 session_id 下两把锁互不相干，
// 导致同一会话可被并发进入。本文件锁定归一化后的锁键契约与互斥/释放行为。

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
        agents: [
            { baseName: 'WHALE', chineseName: '鲸鱼娘', modelId: 'offline-only', systemPrompt: 'Synthetic fixture', temperature: 0.3 },
            { baseName: 'WHALE', chineseName: '折枝', modelId: 'offline-only', systemPrompt: 'Synthetic fixture', temperature: 0.3 },
            { baseName: 'OTHER', chineseName: 'SyntheticWorker', modelId: 'offline-only', systemPrompt: 'Synthetic fixture', temperature: 0.3 }
        ]
    };
    const files = new Map();
    const chats = [];
    const callbacks = [];
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
                return Promise.resolve({ status: 200, data: { status: 'success' } });
            }
            throw new Error(`Unexpected offline HTTP route: ${url}`);
        }
    };
    const sandbox = {
        module: { exports: {} }, exports: {},
        __filename: entry, __dirname: path.dirname(entry),
        process: { env: {} },
        console: { log() {}, warn() {}, error() {} },
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
            if (name === '../../Plugin.js') return { getServiceModule: () => null };
            if (name === './forgeLifecycle.js') return localRequire(name);
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
        api, chats, callbacks, files,
        chat(prompt, agentName, sessionId) {
            const args = { agent_name: agentName, prompt, maid: 'OfflineTest' };
            if (sessionId !== undefined) args.session_id = sessionId;
            return api.processToolCall(args);
        },
        async submit(prompt, agentName, sessionId) {
            const args = { agent_name: agentName, prompt, maid: 'OfflineTest', task_delegation: true };
            if (sessionId !== undefined) args.session_id = sessionId;
            const receipt = await api.processToolCall(args);
            const match = JSON.stringify(receipt).match(/aa-delegation-\d+-[a-f0-9]+/);
            assert.ok(match, 'delegation receipt must contain a real generated ID');
            return match[0];
        },
        complete(index, text = 'Synthetic report') {
            chats[index].resolve({
                data: { choices: [{ message: { content: `${text}\n[[Flowlock::Complete]]` } }] }
            });
        },
        async close() {
            await api.shutdown();
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

test('buildSessionLockKey 只按 baseName 归一化，忽略中文名与别名变体', async () => {
    const h = harness();
    try {
        const key = h.api.buildSessionLockKey;
        assert.equal(typeof key, 'function', 'buildSessionLockKey must be exported as a test hook');

        const whale = key({ baseName: 'WHALE', name: '鲸鱼娘', chineseName: '鲸鱼娘' }, 'sess-1');
        const branch = key({ baseName: 'WHALE', name: '折枝', chineseName: '折枝' }, 'sess-1');
        const bare = key({ baseName: 'WHALE' }, 'sess-1');

        assert.equal(whale, 'WHALE::sess-1');
        assert.equal(branch, whale, '不同别名只要 baseName 相同就必须同键');
        assert.equal(bare, whale);
        assert.ok(!whale.includes('鲸鱼娘'), '锁键不得包含中文别名');
        assert.ok(!whale.includes('折枝'));

        // 显式 session_id 首尾空白不影响归一化结果
        assert.equal(key({ baseName: 'WHALE' }, '  sess-1  '), whale);
        // 不同 session 必须是不同的锁
        assert.notEqual(key({ baseName: 'WHALE' }, 'sess-2'), whale);
        // baseName 不同即不同 Agent 的锁
        assert.notEqual(key({ baseName: 'OTHER' }, 'sess-1'), whale);
        // 缺失 baseName 直接报错，禁止退化成别名锁
        assert.throws(() => key({}, 'sess-1'), /baseName/);
        assert.throws(() => key(null, 'sess-1'), /baseName/);
        // 空 session 不允许静默共享
        assert.throws(() => key({ baseName: 'WHALE' }, '   '), /userSessionId/);
    } finally {
        await h.close();
    }
});


test('普通会话与异步委托在同一显式 session_id 上共用一把锁并互斥', { timeout: 8000 }, async t => {
    const h = harness();
    t.after(() => h.close());

    const pending = h.chat('普通会话请求', '鲸鱼娘', 'shared-session');
    await until(() => h.chats.length === 1, 'ordinary chat request started');
    assert.equal(h.api.__test.activeSessionLocks.size, 1);

    // 不同中文名的异步委托，相同显式 session_id
    await h.submit('异步委托请求', '折枝', 'shared-session');
    await new Promise(resolve => setTimeout(resolve, 120));

    assert.equal(h.chats.length, 1, 'delegation must wait on the same lock');
    assert.equal(h.api.__test.activeSessionLocks.size, 1, 'only one lock may exist');

    h.complete(0, '普通会话回复');
    const ordinaryResult = await pending;
    assert.ok(JSON.stringify(ordinaryResult).includes('普通会话回复'));

    await until(() => h.chats.length === 2, 'delegation proceeds after release');
    assert.ok(JSON.stringify(h.chats[1].payload.messages).includes('异步委托请求'));
    assert.ok(JSON.stringify(h.chats[1].payload.messages).includes('[异步委托模式]'));
    assert.equal(h.api.__test.activeSessionLocks.size, 1);

    h.complete(1, '委托完成');
    await until(() => h.callbacks.length === 1, 'delegation callback');
    assert.equal(h.callbacks[0].payload.status, 'Succeed');
    assert.equal(h.api.__test.activeSessionLocks.size, 0, 'lock released in finally');
    await until(() => h.api.__test.activeDelegations.size === 0, 'durable delegation finalizer completed');
    assert.equal(h.api.__test.activeDelegations.size, 0);
});

test('普通会话失败时 finally 仍释放共享锁，委托可立即接锁', { timeout: 8000 }, async t => {
    const h = harness();
    t.after(() => h.close());

    const pending = h.chat('会失败的请求', '鲸鱼娘', 'retry-session');
    await until(() => h.chats.length === 1, 'ordinary chat request started');
    h.chats[0].reject(new Error('synthetic failure'));
    await assert.rejects(pending);

    assert.equal(h.api.__test.activeSessionLocks.size, 0, 'failed ordinary chat must not leak the lock');

    await h.submit('后续委托', '折枝', 'retry-session');
    await until(() => h.chats.length === 2, 'delegation acquires the released lock');

    h.complete(1, '委托完成');
    await until(() => h.callbacks.length === 1, 'delegation callback');
    assert.equal(h.api.__test.activeSessionLocks.size, 0);
});

test('不同显式 session_id 不被误合并为同一把锁', { timeout: 8000 }, async t => {
    const h = harness();
    t.after(() => h.close());

    const pending = h.chat('会话 A', '鲸鱼娘', 'sess-A');
    await until(() => h.chats.length === 1, 'first session request');
    await h.submit('会话 B 委托', '折枝', 'sess-B');

    await until(() => h.chats.length === 2, 'different session must not block');
    assert.equal(h.api.__test.activeSessionLocks.size, 2);

    h.complete(0, 'A 回复');
    h.complete(1, 'B 回复');
    await pending;
    await until(() => h.callbacks.length === 1, 'delegation callback');
    await until(() => h.api.__test.activeSessionLocks.size === 0, 'all locks released');
});