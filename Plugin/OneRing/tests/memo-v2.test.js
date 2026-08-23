'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Database = require('better-sqlite3');

const {
    normalizeMessageRow,
    dedupeCanonicalEvents,
    MAX_EVENT_TEXT_CHARS
} = require('../lib/MemoEventNormalizer.js');
const { InternalModelClient } = require('../lib/InternalModelClient.js');
const { REDUCTION_TOOL_NAME } = require('../lib/MemoV2ToolContract.js');
const { MemoV2Store, safeAgentFileName } = require('../lib/MemoV2Store.js');
const { buildDeltaFromDb } = require('../lib/MemoDeltaBuilder.js');
const { candidateOutputPath, metricsForDelta } = require('../scripts/memo-v2-dry-run.js');

function response(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload)
    };
}

function modelRequest() {
    return { model: 'offline-test-model', messages: [{ role: 'user', content: 'offline request' }] };
}

function dbTimestamp(date) {
    const value = new Date(date);
    const pad = number => String(number).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function fixtureDb(t, rows = []) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onering-v2-db-'));
    const filePath = path.join(directory, 'fixture.db');
    const database = new Database(filePath);
    database.exec(`CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agentName TEXT NOT NULL,
        role TEXT NOT NULL,
        senderName TEXT,
        frontendSource TEXT,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        postContextHash TEXT
    )`);
    const insert = database.prepare(`INSERT INTO messages
        (agentName, role, senderName, frontendSource, content, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`);
    for (const row of rows) insert.run('fixture-agent', row.role || 'user', row.senderName || null, row.frontendSource || null, row.content, row.timestamp);
    t.after(() => {
        try { database.close(); } catch (_) { /* already closed */ }
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return database;
}

test('normalizer uses only outer timestamp and stable hashes', () => {
    const row = {
        id: 17,
        role: 'user',
        senderName: '测试用户',
        frontendSource: 'unit-test',
        timestamp: '2026-08-21 10:20:30',
        content: '正文提到 2020-01-01，但事件外层时间是唯一时间。'
    };
    const first = normalizeMessageRow(row);
    const second = normalizeMessageRow({ ...row });
    assert.equal(first.occurredAt, row.timestamp);
    assert.equal(first.eventUid, second.eventUid);
    assert.equal(first.contentHash, second.contentHash);
    assert.equal(first.schemaVersion, 2);
    assert.equal(first.eventId, '17');
});

test('normalizer removes context wrappers and preserves structured tool meaning', () => {
    const raw = [
        '<p>可见语义</p><script>hidden script</script><style>.hidden{}</style>',
        '普通正文中的孤立字段示例：name=「始」示例值「末」',
        '<!-- VCP_RAG_BLOCK_START -->RAG hidden context<!-- VCP_RAG_BLOCK_END -->',
        '近期客观时间线（OneRingMemo：旧摘要正文）以上是过往记忆区',
        '————VCP元思维模块————内部推理正文————VCP元思考加载结束—————',
        'VCP系统工具列表：系统工具百科，不是事件',
        '<<<[TOOL_REQUEST]>>>tool_name: 「始」Search「末」\npurpose: 「始」查找公开资料「末」<<<[END_TOOL_REQUEST]>>>',
        '[[VCP调用结果信息汇总:\n工具名称: Search\n执行状态: success\n退出码: 0\n关键结论: 找到结果\nartifact_path: /tmp/result.txt\nVCP调用结果结束]]',
        'data:image/png;base64,AAAA1111BBBB2222'
    ].join('\n');
    const event = normalizeMessageRow({
        id: 1,
        role: 'assistant',
        senderName: 'assistant',
        frontendSource: 'test',
        timestamp: '2026-08-21 11:00:00',
        content: raw
    });
    assert.match(event.text, /可见语义/);
    assert.match(event.text, /工具请求：工具=Search/);
    assert.match(event.text, /工具结果：工具=Search/);
    assert.match(event.text, /退出码=0/);
    assert.doesNotMatch(event.text, /RAG hidden|旧摘要正文|内部推理正文|系统工具百科|AAAA1111/);
    assert.doesNotMatch(event.text, /「始(?:ESCAPE)?」|「末(?:ESCAPE)?」/);
    assert.match(event.text, /示例值/);
    assert.deepEqual(event.artifactRefs, [{ type: 'path', path: '/tmp/result.txt' }]);
    assert.equal(event.kind, 'tool_exchange');
});

test('normalizer redacts credentials, deduplicates repeated wrappers, and records semantic truncation', () => {
    const constructedCredential = ['alpha', 'unit', 'value'].join('-');
    const longParagraphs = Array.from({ length: 12 }, (_, index) => `${index === 6 ? '关键结论：' : '普通记录：'}${'语义内容'.repeat(500)}`);
    const event = normalizeMessageRow({
        id: 2,
        role: 'assistant',
        senderName: 'assistant',
        frontendSource: 'test',
        timestamp: '2026-08-21 11:01:00',
        content: `密码=${constructedCredential}\nAuthorization: Bearer ${constructedCredential}\n${longParagraphs.join('\n\n')}`
    });
    assert.ok(event.text.length <= MAX_EVENT_TEXT_CHARS);
    assert.ok(event.truncation);
    assert.equal(event.truncation.strategy, 'semantic-paragraph-selection');
    assert.doesNotMatch(event.text, new RegExp(constructedCredential));
    const duplicateA = normalizeMessageRow({ id: 3, role: 'user', senderName: 'u', frontendSource: 'x', timestamp: '2026-08-21 11:02:00', content: '同一事件' });
    const duplicateB = normalizeMessageRow({ id: 4, role: 'user', senderName: 'u', frontendSource: 'x', timestamp: '2026-08-21 11:02:00', content: '同一事件' });
    assert.equal(dedupeCanonicalEvents([duplicateA, duplicateB]).length, 1);
});

test('InternalModelClient returns standard result without logging sensitive request data', async () => {
    const logs = [];
    const client = new InternalModelClient({
        baseUrl: 'https://model.invalid',
        apiKey: ['unit', 'injected', 'credential'].join('-'),
        fetchImpl: async (url, options) => {
            assert.equal(url, 'https://model.invalid/v1/chat/completions');
            assert.equal(options.method, 'POST');
            return response({ id: 'request-1', choices: [{ message: { content: '摘要结果' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } });
        },
        logger: entry => logs.push(entry),
        retries: 0
    });
    const result = await client.complete(modelRequest());
    assert.deepEqual(result, {
        content: '摘要结果',
        toolCalls: [],
        finishReason: 'stop',
        usage: { total_tokens: 3 },
        attempts: 1,
        requestId: 'request-1'
    });
    assert.doesNotMatch(JSON.stringify(logs), /摘要结果|Authorization|injected/);
});

test('InternalModelClient maps a JSON-compatible responseFormat without logging its content', async () => {
    const logs = [];
    let requestBody;
    const client = new InternalModelClient({
        baseUrl: 'https://model.invalid',
        apiKey: 'unit-key',
        retries: 0,
        logger: entry => logs.push(entry),
        fetchImpl: async (_url, options) => {
            requestBody = JSON.parse(options.body);
            return response({ choices: [{ message: { content: '{"facts":[],"threadUpdates":[]}' }, finish_reason: 'stop' }] });
        }
    });
    await client.complete({ ...modelRequest(), responseFormat: { type: 'json_object' } });
    assert.deepEqual(requestBody.response_format, { type: 'json_object' });
    assert.doesNotMatch(JSON.stringify(logs), /json_object|response_format|offline request/);

    await assert.rejects(
        client.complete({ ...modelRequest(), responseFormat: [] }),
        error => error.code === 'INTERNAL_MODEL_INVALID_RESPONSE_FORMAT'
    );
    const cyclic = {};
    cyclic.self = cyclic;
    await assert.rejects(
        client.complete({ ...modelRequest(), responseFormat: cyclic }),
        error => error.code === 'INTERNAL_MODEL_INVALID_RESPONSE_FORMAT'
    );
});

test('InternalModelClient maps modern forced tool call fields and preserves only normalized tool data', async () => {
    const logs = [];
    let requestBody;
    const tool = {
        type: 'function',
        function: {
            name: REDUCTION_TOOL_NAME,
            parameters: { type: 'object', additionalProperties: false }
        }
    };
    const client = new InternalModelClient({
        baseUrl: 'https://model.invalid',
        apiKey: 'unit-key',
        retries: 0,
        logger: entry => logs.push(entry),
        fetchImpl: async (_url, options) => {
            requestBody = JSON.parse(options.body);
            return response({
                id: 'tool-request-1',
                choices: [{
                    message: {
                        content: 'model analysis that must be ignored',
                        tool_calls: [{
                            id: 'call-1',
                            type: 'function',
                            function: { name: REDUCTION_TOOL_NAME, arguments: '{"facts":[],"threadUpdates":[]}' },
                            ignored: 'not retained'
                        }]
                    },
                    finish_reason: 'tool_calls'
                }]
            });
        }
    });
    const result = await client.complete({
        ...modelRequest(),
        tools: [tool],
        toolChoice: { type: 'function', function: { name: REDUCTION_TOOL_NAME } },
        parallelToolCalls: false
    });
    assert.deepEqual(requestBody.tools, [tool]);
    assert.deepEqual(requestBody.tool_choice, { type: 'function', function: { name: REDUCTION_TOOL_NAME } });
    assert.equal(requestBody.parallel_tool_calls, false);
    assert.equal(result.content, 'model analysis that must be ignored');
    assert.deepEqual(result.toolCalls, [{
        id: 'call-1',
        type: 'function',
        function: { name: REDUCTION_TOOL_NAME, arguments: '{"facts":[],"threadUpdates":[]}' }
    }]);
    assert.doesNotMatch(JSON.stringify(logs), /model analysis|facts|arguments|parameters|tool_choice|unit-key/);
});

test('InternalModelClient accepts null content with a valid tool call and rejects empty results', async () => {
    const toolCall = {
        id: 'call-1',
        type: 'function',
        function: { name: REDUCTION_TOOL_NAME, arguments: '{"facts":[],"threadUpdates":[]}' }
    };
    const client = new InternalModelClient({
        baseUrl: 'https://model.invalid',
        apiKey: 'unit-key',
        retries: 0,
        fetchImpl: async () => response({ choices: [{ message: { content: null, tool_calls: [toolCall] }, finish_reason: 'tool_calls' }] })
    });
    const result = await client.complete(modelRequest());
    assert.equal(result.content, null);
    assert.deepEqual(result.toolCalls, [toolCall]);

    const emptyClient = new InternalModelClient({
        baseUrl: 'https://model.invalid',
        apiKey: 'unit-key',
        retries: 0,
        fetchImpl: async () => response({ choices: [{ message: { content: null }, finish_reason: 'stop' }] })
    });
    await assert.rejects(emptyClient.complete(modelRequest()), error => error.code === 'INTERNAL_MODEL_EMPTY_RESULT');
});

test('InternalModelClient rejects unsafe tool configuration with stable errors', async () => {
    const client = new InternalModelClient({
        baseUrl: 'https://model.invalid',
        apiKey: 'unit-key',
        retries: 0,
        fetchImpl: async () => response({ choices: [{ message: { content: 'unused' }, finish_reason: 'stop' }] })
    });
    const validTool = { type: 'function', function: { name: 'safe_tool', parameters: { type: 'object' } } };
    await assert.rejects(client.complete({ ...modelRequest(), tools: [{ type: 'custom', function: validTool.function }] }), error => error.code === 'INTERNAL_MODEL_INVALID_TOOLS');
    await assert.rejects(client.complete({ ...modelRequest(), tools: [validTool], toolChoice: { type: 'function', function: { name: 'missing_tool' } } }), error => error.code === 'INTERNAL_MODEL_INVALID_TOOL_CHOICE');
    const cyclic = { type: 'function', function: { name: 'cyclic_tool', parameters: {} } };
    cyclic.function.parameters.self = cyclic;
    await assert.rejects(client.complete({ ...modelRequest(), tools: [cyclic] }), error => error.code === 'INTERNAL_MODEL_INVALID_TOOLS');
    const polluted = JSON.parse('{"type":"function","function":{"name":"polluted","parameters":{"__proto__":{}}}}');
    await assert.rejects(client.complete({ ...modelRequest(), tools: [polluted] }), error => error.code === 'INTERNAL_MODEL_INVALID_TOOLS');
});

test('InternalModelClient rejects invalid messages', async () => {
    const client = new InternalModelClient({ baseUrl: 'https://model.invalid', apiKey: 'unit-key', retries: 0, fetchImpl: async () => response({}) });
    await assert.rejects(client.complete({ model: 'm', messages: [] }), error => error.code === 'INTERNAL_MODEL_INVALID_MESSAGES');
    await assert.rejects(client.complete({ model: 'm', messages: [{ role: 'user', content: '' }] }), error => error.code === 'INTERNAL_MODEL_INVALID_MESSAGES');
});

test('InternalModelClient retries 429 and returns attempt count', async () => {
    let calls = 0;
    const client = new InternalModelClient({
        baseUrl: 'https://model.invalid',
        apiKey: 'unit-key',
        retries: 1,
        backoffMs: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => ++calls === 1 ? response('busy', 429) : response({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
    });
    const result = await client.complete(modelRequest());
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
});

test('InternalModelClient opt-in retries only the exact generic invalid request 400', async () => {
    let calls = 0;
    const logs = [];
    const client = new InternalModelClient({
        baseUrl: 'https://model.invalid',
        apiKey: 'unit-key',
        retries: 1,
        backoffMs: 0,
        sleepImpl: async () => {},
        logger: entry => logs.push(entry),
        fetchImpl: async () => ++calls === 1
            ? response({ error: { type: 'invalid_request_error', message: ' Invalid request ', code: null, body: 'do not log' } }, 400)
            : response({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
    });
    const result = await client.complete({ ...modelRequest(), retryGenericInvalidRequest: true });
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.genericInvalidRequestRetryCount, 1);
    assert.match(JSON.stringify(logs), /INTERNAL_MODEL_HTTP_400_GENERIC_INVALID_REQUEST/);
    assert.doesNotMatch(JSON.stringify(logs), /Invalid request|do not log|body|messages|tools|unit-key/);
});

test('InternalModelClient does not retry non-opt-in, detailed, codeful, unauthorized, or forbidden 400s', async () => {
    const cases = [
        { request: {}, payload: { error: { type: 'invalid_request_error', message: 'Invalid request', code: null } }, code: 'INTERNAL_MODEL_HTTP_ERROR' },
        { request: { retryGenericInvalidRequest: true }, payload: { error: { type: 'invalid_request_error', message: 'Invalid request details', code: null } }, code: 'INTERNAL_MODEL_HTTP_ERROR' },
        { request: { retryGenericInvalidRequest: true }, payload: { error: { type: 'invalid_request_error', message: 'Invalid request', code: 'invalid_schema' } }, code: 'INTERNAL_MODEL_HTTP_ERROR' },
        { request: { retryGenericInvalidRequest: true }, payload: { error: { type: 'invalid_request_error', message: 'Invalid request', code: 0 } }, code: 'INTERNAL_MODEL_HTTP_ERROR' },
        { request: { retryGenericInvalidRequest: true }, payload: { error: { type: 'auth_error', message: 'Invalid request', code: null } }, status: 401, code: 'INTERNAL_MODEL_HTTP_ERROR' },
        { request: { retryGenericInvalidRequest: true }, payload: { error: { type: 'auth_error', message: 'Invalid request', code: null } }, status: 403, code: 'INTERNAL_MODEL_HTTP_ERROR' }
    ];
    for (const expected of cases) {
        let calls = 0;
        const client = new InternalModelClient({
            baseUrl: 'https://model.invalid',
            apiKey: 'unit-key',
            retries: 1,
            backoffMs: 0,
            sleepImpl: async () => {},
            fetchImpl: async () => {
                calls++;
                return response(expected.payload, expected.status || 400);
            }
        });
        await assert.rejects(
            client.complete({ ...modelRequest(), ...expected.request }),
            error => error.code === expected.code && error.attempts === 1
        );
        assert.equal(calls, 1);
    }
});

test('InternalModelClient keeps bounded 5xx and network retries', async () => {
    let serverCalls = 0;
    const serverClient = new InternalModelClient({
        baseUrl: 'https://model.invalid',
        apiKey: 'unit-key',
        retries: 1,
        backoffMs: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => ++serverCalls === 1 ? response('server busy', 503) : response({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
    });
    assert.equal((await serverClient.complete(modelRequest())).attempts, 2);
    assert.equal(serverCalls, 2);

    let networkCalls = 0;
    const networkClient = new InternalModelClient({
        baseUrl: 'https://model.invalid',
        apiKey: 'unit-key',
        retries: 1,
        backoffMs: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => {
            networkCalls++;
            if (networkCalls === 1) throw new Error('offline network fixture');
            return response({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
        }
    });
    assert.equal((await networkClient.complete(modelRequest())).attempts, 2);
    assert.equal(networkCalls, 2);
});

test('InternalModelClient classifies timeout and external abort', async () => {
    const waitingFetch = async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
        }, { once: true });
    });
    const timeoutClient = new InternalModelClient({ baseUrl: 'https://model.invalid', apiKey: 'unit-key', timeoutMs: 5, retries: 0, fetchImpl: waitingFetch });
    await assert.rejects(timeoutClient.complete(modelRequest()), error => error.code === 'INTERNAL_MODEL_TIMEOUT');
    const controller = new AbortController();
    const abortClient = new InternalModelClient({ baseUrl: 'https://model.invalid', apiKey: 'unit-key', timeoutMs: 1000, retries: 0, fetchImpl: waitingFetch });
    const request = abortClient.complete({ ...modelRequest(), signal: controller.signal });
    controller.abort();
    await assert.rejects(request, error => error.code === 'INTERNAL_MODEL_ABORTED');
});

test('InternalModelClient classifies empty choices, invalid JSON, truncation, and safety stop', async () => {
    for (const [payload, code] of [
        [{ choices: [] }, 'INTERNAL_MODEL_EMPTY_CHOICES'],
        ['not-json', 'INTERNAL_MODEL_INVALID_JSON'],
        [{ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }, 'INTERNAL_MODEL_TRUNCATED'],
        [{ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }, 'INTERNAL_MODEL_SAFETY_BLOCKED']
    ]) {
        const client = new InternalModelClient({ baseUrl: 'https://model.invalid', apiKey: 'unit-key', retries: 0, fetchImpl: async () => response(payload) });
        await assert.rejects(client.complete(modelRequest()), error => error.code === code);
    }
});

test('MemoV2Store writes atomic candidates, promotes, preserves active state on failure, and records failure without moving cursor', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onering-v2-store-'));
    try {
        const store = new MemoV2Store({ baseDir: directory });
        const initial = {
            schemaVersion: 2,
            initialized: true,
            agentName: '微明',
            cursor: { lastMessageId: 2, snapshotDbMaxId: 2 },
            lastSuccessAt: '2026-08-21T00:00:00.000Z',
            timeline: [],
            activeThreads: [],
            stats: {}
        };
        store.writeCandidate('微明', initial);
        assert.ok(fs.existsSync(store.candidatePath('微明')));
        store.promoteCandidate('微明');
        assert.equal(store.readState('微明').cursor.lastMessageId, 2);
        store.writeCandidate('微明', { ...initial, cursor: { lastMessageId: 3, snapshotDbMaxId: 3 } });
        const originalRename = store.fs.renameSync;
        store.fs = { ...fs, renameSync(source, target) {
            if (target === store.statePath('微明')) throw new Error('simulated promote failure');
            return originalRename.call(fs, source, target);
        }};
        assert.throws(() => store.promoteCandidate('微明'), /simulated promote failure/);
        store.fs = fs;
        assert.equal(store.readState('微明').cursor.lastMessageId, 2);
        const failed = store.recordFailure('微明', new Error('offline failure'), '2026-08-21T01:00:00.000Z');
        assert.equal(failed.cursor.lastMessageId, 2);
        assert.equal(store.readState('微明').cursor.lastMessageId, 2);
        assert.equal(store.readState('微明').lastError, 'offline failure');
        assert.equal(safeAgentFileName('微明'), '_E5_BE_AE_E6_98_8E');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('delta uses cursor < id <= snapshot max and excludes a simulated post-snapshot insert', () => {
    let maxRead = false;
    const database = {
        prepare(sql) {
            if (sql.includes('MAX(id)')) return { get: () => { maxRead = true; return { maxId: 2 }; } };
            if (sql.includes('id>?')) return {
                all: () => [
                    { id: 2, role: 'user', senderName: 'u', frontendSource: 'x', content: '增量事件', timestamp: '2026-08-21 12:00:00' },
                    { id: 3, role: 'user', senderName: 'u', frontendSource: 'x', content: '快照后新增', timestamp: '2026-08-21 12:01:00' }
                ]
            };
            throw new Error(`unexpected SQL ${sql}`);
        }
    };
    const delta = buildDeltaFromDb({
        agentName: 'fixture-agent',
        database,
        previousState: { schemaVersion: 2, initialized: true, agentName: 'fixture-agent', cursor: { lastMessageId: 1, snapshotDbMaxId: 1 }, timeline: [], activeThreads: [], stats: {} }
    });
    assert.equal(maxRead, true);
    assert.deepEqual(delta.sourceMessageIds, [2]);
    assert.equal(delta.snapshotDbMaxId, 2);
    assert.equal(delta.nextCursor.lastMessageId, 2);
});

test('delta bootstrap honors timeline/fallback and reports no-new-event batches', t => {
    const now = new Date('2026-08-21T12:00:00');
    const database = fixtureDb(t, [
        { role: 'user', content: '很久以前', timestamp: dbTimestamp(new Date(now.getTime() - 10 * 86400000)) },
        { role: 'user', content: '近期一', timestamp: dbTimestamp(new Date(now.getTime() - 2 * 86400000)) },
        { role: 'assistant', content: '近期二', timestamp: dbTimestamp(now) }
    ]);
    const bootstrap = buildDeltaFromDb({ agentName: 'fixture-agent', database, now, timelineDays: 3, fallbackCount: 1 });
    assert.equal(bootstrap.bootstrap, true);
    assert.deepEqual(bootstrap.sourceMessageIds, [2, 3]);
    assert.equal(bootstrap.nextCursor.lastMessageId, 3);
    assert.deepEqual(bootstrap.stats.dateRange, { from: '2026-08-19', to: '2026-08-21' });
    const empty = buildDeltaFromDb({
        agentName: 'fixture-agent',
        database,
        previousState: { schemaVersion: 2, initialized: true, agentName: 'fixture-agent', cursor: { lastMessageId: 3, snapshotDbMaxId: 3 }, timeline: [], activeThreads: [], stats: {} },
        now
    });
    assert.deepEqual(empty.sourceMessageIds, []);
    assert.equal(empty.stats.normalizedEventCount, 0);
});

test('dry-run metrics do not contain event body and candidate paths reject V1 files', () => {
    assert.throws(() => candidateOutputPath('Plugin/OneRing/memo/unsafe.json', 'fixture-agent'), error => error.code === 'MEMO_V2_FORBIDDEN_OUTPUT_PATH');
    assert.throws(() => candidateOutputPath('Plugin/OneRing/data/unsafe.db', 'fixture-agent'), error => error.code === 'MEMO_V2_FORBIDDEN_OUTPUT_PATH');
    const delta = {
        agentName: 'fixture-agent',
        snapshotDbMaxId: 4,
        previousState: { cursor: { lastMessageId: 2, snapshotDbMaxId: 2 } },
        nextCursor: { lastMessageId: 4, snapshotDbMaxId: 4 },
        canonicalEvents: [{ kind: 'message', text: 'private event body' }],
        skipped: { total: 0 },
        duplicates: { total: 0 },
        stats: { sourceMessageCount: 1, rawChars: 20, normalizedChars: 18, kindCounts: { message: 1 }, dateRange: { from: null, to: null } }
    };
    const metrics = metricsForDelta(delta, false);
    assert.doesNotMatch(JSON.stringify(metrics), /private event body/);
    assert.equal(metrics.modelCalled, false);
});
