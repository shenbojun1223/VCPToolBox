'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Order = require('../Plugin/RAGDiaryPlugin/GroupPresentationOrder');
const formatter = require('../Plugin/RAGDiaryPlugin/RAGResultFormatter');
// Load the actual method without constructing the resident plugin or starting watchers.
const pluginSource = fs.readFileSync(
    require.resolve('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin'), 'utf8'
);
const methodStart = pluginSource.indexOf('    async _processRAGPlaceholder(options) {');
const methodEnd = pluginSource.indexOf('\n    /**', methodStart);
assert.ok(methodStart > 0 && methodEnd > methodStart);
const plugin = vm.runInNewContext(
    `({ ${pluginSource.slice(methodStart, methodEnd)} })`, { console }
);
Object.assign(plugin, {
    ragParams: {},
    formatGroupRAGResults: formatter.formatGroupRAGResults,
    formatStandardResults: formatter.formatStandardResults,
    formatCombinedTimeAwareResults: formatter.formatCombinedTimeAwareResults
});

const context = (topicId = 'topic1', agentId = 'agent1') => ({
    ownerType: 'agent', agentId, topicId
});
const row = (id, text = id) => ({ chunkId: id, fullPath: 'diary/' + id, text });
const metadata = { dbName: 'diary', modifiers: '::Group', engine: 'TagMemo', k: 3 };
function present(order, rows, request, meta = metadata) {
    const data = order.capture(rows, 'diary', new Map(), meta);
    const content = formatter.formatGroupRAGResults(rows, 'diary', new Map(), meta);
    return order.render(content, data, request);
}
function bodies(content) {
    return [...content.matchAll(/^\* (.*)$/gm)].map(m => m[1]);
}
function seed(order) {
    present(order, [row('A'), row('B'), row('C')], order.begin(context()));
}

test('retain current survivors, append newcomers, never resurrect removed rows', () => {
    const order = new Order();
    seed(order);
    assert.deepEqual(bodies(present(order, [row('C'), row('E'), row('A')], order.begin(context()))), ['A', 'C', 'E']);
    assert.deepEqual(bodies(present(order, [row('E'), row('B')], order.begin(context()))), ['E', 'B']);
});

test('stable chunk identity uses current text, not stored text', () => {
    const order = new Order(); seed(order);
    assert.deepEqual(bodies(present(order, [row('C'), row('A', 'updated')], order.begin(context()))), ['updated', 'C']);
    for (const state of order.states.values()) assert.deepEqual(Object.keys(state).sort(), ['ids', 'sequence']);
});

test('topic, agent, carrier and placeholder modifiers are isolated', () => {
    const order = new Order(); seed(order);
    const rows = [row('C'), row('A')];
    for (const req of [order.begin(context('topic2')), order.begin(context('topic1', 'agent2')),
        { ...order.begin(context()), carrier: 1 }]) {
        assert.deepEqual(bodies(present(order, rows, req)), ['C', 'A']);
    }
    assert.deepEqual(bodies(present(order, rows, order.begin(context()), { ...metadata, modifiers: '::Group::Expand' })), ['C', 'A']);
});

test('missing identity and group chat fall back without retaining state', () => {
    const order = new Order();
    for (const ctx of [null, {}, { agentId: 'a' }, { ownerType: 'agent', topicId: 't' },
        { ...context(), ownerType: 'group' }, { ...context(), isGroupMessage: true }]) {
        assert.equal(order.begin(ctx), null);
        assert.deepEqual(bodies(present(order, [row('C'), row('A')], order.begin(ctx))), ['C', 'A']);
    }
    assert.equal(order.states.size, 0);
});

test('expanded documents ignore retained chunk ID; chunks of one file remain distinct', () => {
    const order = new Order();
    const doc = (id) => ({ ...row(id, 'document'), _expanded: true, _expandedFilePath: 'diary/doc' });
    present(order, [doc('old'), row('B')], order.begin(context()));
    assert.deepEqual(bodies(present(order, [row('B'), doc('new')], order.begin(context()))), ['document', 'B']);
    const chunks = new Order();
    const a = { ...row('1'), fullPath: 'same' }, b = { ...row('2'), fullPath: 'same' };
    present(chunks, [a, b], chunks.begin(context()));
    assert.deepEqual(bodies(present(chunks, [b, a], chunks.begin(context()))), ['1', '2']);
});

test('ambiguous and missing IDs conservatively keep original content', () => {
    const order = new Order(); seed(order);
    const req = order.begin(context());
    assert.deepEqual(bodies(present(order, [row('A'), row('A')], req)), ['A', 'A']);
    assert.deepEqual(bodies(present(order, [{ text: 'unknown' }], req)), ['unknown']);
    assert.deepEqual([...order.states.values()][0].ids.length, 3);
});

test('path/text fallback treats edited text as a new entry', () => {
    const order = new Order();
    const a = { fullPath: 'same', text: 'old' }, b = { fullPath: 'same', text: 'other' };
    present(order, [a, b], order.begin(context()));
    assert.deepEqual(bodies(present(order, [{ ...a, text: 'new' }, b], order.begin(context()))), ['other', 'new']);
});

test('newer completed request cannot be overwritten by older in-flight request', () => {
    const order = new Order(); seed(order);
    const old = order.begin(context()), recent = order.begin(context());
    present(order, [row('C'), row('B')], recent);
    assert.deepEqual(bodies(present(order, [row('A'), row('C')], old)), ['A', 'C']);
    assert.deepEqual(bodies(present(order, [row('C'), row('B')], order.begin(context()))), ['B', 'C']);
});

test('empty result resets baseline and preserves empty content; capacity is bounded', () => {
    const order = new Order(2); seed(order);
    assert.equal(order.render('', order.capture([], 'diary', new Map(), metadata), order.begin(context())), '');
    assert.deepEqual(bodies(present(order, [row('C'), row('A')], order.begin(context()))), ['C', 'A']);
    present(order, [row('A')], order.begin(context('t2')));
    present(order, [row('A')], order.begin(context('t3')));
    assert.equal(order.states.size, 2);
});

test('render does not mutate results, cached presentation, metadata or group description', () => {
    const order = new Order(); seed(order);
    const rows = Object.freeze([Object.freeze(row('C')), Object.freeze(row('A'))]);
    const groups = new Map([['g', { strength: 0.5, matchedWords: ['word'] }]]);
    const data = order.capture(rows, 'diary', groups, { ...metadata, k: 2 });
    const snapshot = JSON.stringify(data);
    const output = order.render('original', data, order.begin(context()));
    assert.deepEqual(bodies(output), ['A', 'C']);
    assert.match(output, /"k":2/);
    assert.match(output, /50%/);
    assert.equal(JSON.stringify(data), snapshot);
    assert.deepEqual(rows.map(r => r.text), ['C', 'A']);
});

test('actual _processRAGPlaceholder cache-hit branch renders per topic without mutating cache', async () => {
    const local = Object.create(plugin);
    local.groupPresentationOrder = new Order(); seed(local.groupPresentationOrder);
    local.pushVcpInfo = null;
    local._generateCacheKey = () => 'test';
    const rows = [row('C'), row('A')];
    const cached = {
        content: formatter.formatGroupRAGResults(rows, 'diary', new Map(), metadata),
        groupPresentation: local.groupPresentationOrder.capture(rows, 'diary', new Map(), metadata)
    };
    local._getCachedResult = () => cached;
    const before = JSON.stringify(cached);
    const run = ctx => local._processRAGPlaceholder({
        dbName: 'diary', modifiers: '::Group',
        requestCache: { groupOrderRequest: local.groupPresentationOrder.begin(ctx) }
    });
    assert.deepEqual(bodies(await run(context())), ['A', 'C']);
    assert.deepEqual(bodies(await run(context('other'))), ['C', 'A']);
    assert.equal(JSON.stringify(cached), before);
    delete cached.groupPresentation; // Old-format cache remains compatible.
    assert.equal(await run(context()), cached.content);
});

test('actual post-retrieval tail stores raw order, applies truncate before ordering and leaves other modes alone', async () => {
    // Execute the real method tail with isolated retrieval outputs. No embedding/DB/network initialization.
    const source = fs.readFileSync(require.resolve('../Plugin/RAGDiaryPlugin/RAGDiaryPlugin'), 'utf8');
    const start = source.indexOf('        // 🧹 最终输出去重');
    const end = source.indexOf('\n    /**', start);
    assert.ok(start > 0 && end > start);
    const tail = source.slice(start, end).trimEnd();
    const execute = vm.runInNewContext(`(async function(input) {
        let { finalResultsForBroadcast, useGroup, useTime, timeRanges, truncateThreshold } = input;
        const finalQueryVector = [], dbScopeKey = 'diary', displayName = 'diary';
        const metadata = input.metadata, activatedGroups = new Map(), returnRawResults = false;
        const modifiers = '::Group', requestCache = input.requestCache, cacheKey = 'test';
        let retrievedContent = '', vcpInfoData = null;
        ${tail}
    )`, { console });
    const local = Object.create(plugin);
    local.groupPresentationOrder = new Order(); seed(local.groupPresentationOrder);
    local.vectorDBManager = { deduplicateResults: async rows => rows };
    local.pushVcpInfo = null;
    let cached;
    local._setCachedResult = (key, value) => { cached = value; };
    const input = {
        finalResultsForBroadcast: [row('C'), row('A'), { ...row('drop'), score: 0 }],
        metadata, useGroup: true, useTime: false, timeRanges: [], truncateThreshold: 0,
        requestCache: { groupOrderRequest: local.groupPresentationOrder.begin(context()) }
    };
    const output = await execute.call(local, input);
    assert.deepEqual(bodies(output), ['A', 'C', 'drop']);
    assert.deepEqual(bodies(cached.content), ['C', 'A', 'drop']);
    input.finalResultsForBroadcast = [{ ...row('C'), score: 1 }, { ...row('A'), score: 0 }];
    input.truncateThreshold = 0.5;
    assert.deepEqual(bodies(await execute.call(local, input)), ['C']);
    input.useGroup = false; input.truncateThreshold = 0;
    await execute.call(local, input);
    assert.equal(cached.groupPresentation, null);
    input.useGroup = true; input.useTime = true;
    input.timeRanges = [{ start: '2026-01-01', end: '2026-01-02' }];
    input.finalResultsForBroadcast = [{ ...row('A'), source: 'rag' }];
    await execute.call(local, input);
    assert.equal(cached.groupPresentation, null);
});

test('unsupported presentation is passed through without creating state', () => {
    const order = new Order();
    assert.equal(order.render('standard/time/AIMemo', null, order.begin(context())), 'standard/time/AIMemo');
    assert.equal(order.states.size, 0);
});test('actual system-message handoff shares cache Maps but isolates carrier context', async () => {
    const start = pluginSource.indexOf('            await Promise.all(targetSystemMessageIndices.map');
    const end = pluginSource.indexOf('            }));', start);
    assert.ok(start > 0 && end > start);
    const execute = vm.runInNewContext(`(async function(input) {
        const { requestCache, groupOrderRequest, newMessages } = input;
        const targetSystemMessageIndices = [0, 1];
        const queryVector = [], userContent = '', aiContent = '', combinedQueryForDisplay = '';
        const effectiveDynamicK = 2, timeRanges = [], globalProcessedDiaries = new Set();
        const isAIMemoLicensed = false, dynamicParams = { metrics: {} }, historySegments = [];
        const contextDiaryPrefixes = new Set(), messages = [], ghostTags = [];
        const collectedAttachments = [], isFreshTimeConversationStart = false;
        ${pluginSource.slice(start, end + '            }));'.length)}
    })`, { console: { log() {} } });
    const shared = { chunksByFilePath: new Map(), fullDocumentCache: new Map() };
    const order = new Order();
    const request = order.begin(context());
    const seen = [];
    const local = {
        _extractTextFromContent: content => content,
        _replaceTextInContent: (content, replacer) => replacer(content),
        _processSingleSystemMessage: async (...args) => {
            const cache = args[args.length - 1];
            seen.push(cache);
            cache.chunksByFilePath.set(cache.groupOrderRequest.carrier, true);
            return 'processed';
        }
    };
    const messages = [{ content: 'first' }, { content: 'second' }];
    await execute.call(local, { requestCache: shared, groupOrderRequest: request, newMessages: messages });
    assert.equal(seen.length, 2);
    assert.notStrictEqual(seen[0], seen[1]);
    for (const cache of seen) {
        assert.strictEqual(cache.chunksByFilePath, shared.chunksByFilePath);
        assert.strictEqual(cache.fullDocumentCache, shared.fullDocumentCache);
        assert.ok(Object.hasOwn(cache, 'chunksByFilePath'));
        assert.equal(cache.groupOrderRequest.scope, request.scope);
    }
    assert.deepEqual(seen.map(cache => cache.groupOrderRequest.carrier), [0, 1]);
    assert.equal(shared.chunksByFilePath.size, 2);
    assert.equal(shared.groupOrderRequest, undefined);
    assert.deepEqual(messages.map(message => message.content), ['processed', 'processed']);
});