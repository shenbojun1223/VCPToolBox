'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDefaultState } = require('../lib/MemoV2Store.js');
const {
    DEFAULT_PROMPT_EVENT_TEXT_CHARS,
    projectCanonicalEventForPrompt,
    projectCanonicalEventsForPrompt
} = require('../lib/MemoV2PromptProjector.js');
const { buildReductionPrompt } = require('../lib/MemoV2PromptBuilder.js');
const { planMemoV2Batches } = require('../lib/MemoV2BatchPlanner.js');
const { generateShadowCandidate } = require('../lib/MemoV2Orchestrator.js');
const {
    REDUCTION_TOOL_NAME,
    NEW_THREAD_WIRE_TOKEN,
    NO_ASSIGNEE_WIRE_TOKEN
} = require('../lib/MemoV2ToolContract.js');
const {
    parseArgs: parseShadowArgs,
    main: shadowMain,
    usage: shadowUsage
} = require('../scripts/memo-v2-shadow-candidate.js');

function event(eventId, text, overrides = {}) {
    return {
        schemaVersion: 2,
        eventId: String(eventId),
        eventUid: `uid-${eventId}`,
        occurredAt: '2026-08-22 10:00:00',
        role: 'user',
        actor: { name: 'Lucy', role: 'user' },
        origin: { frontendSource: 'offline-test' },
        kind: 'message',
        text,
        artifactRefs: [{ type: 'file', path: 'C:/fixture.txt' }],
        contentHash: `hash-${eventId}`,
        nested: { labels: ['original'] },
        ...overrides
    };
}

function state() {
    const value = createDefaultState('fixture-agent');
    value.initialized = true;
    value.cursor = { lastMessageId: 67, snapshotDbMaxId: 67 };
    return value;
}

function delta(events, previousState = state()) {
    return {
        schemaVersion: 2,
        agentName: 'fixture-agent',
        previousState,
        bootstrap: false,
        snapshotDbMaxId: 1000,
        nextCursor: { lastMessageId: 1000, snapshotDbMaxId: 1000 },
        sourceMessageIds: events.map(item => item.eventId),
        canonicalEvents: events,
        skipped: { total: 0 },
        duplicates: { total: 0 },
        stats: {
            sourceMessageCount: events.length,
            normalizedEventCount: events.length,
            normalizedChars: events.reduce((sum, item) => sum + item.text.length, 0),
            kindCounts: { message: events.length },
            dateRange: { from: '2026-08-22', to: '2026-08-22' }
        }
    };
}

function toolResponse(reduction) {
    const wire = {
        ...reduction,
        threadUpdates: (reduction.threadUpdates || []).map(update => ({
            ...update,
            threadId: update.threadId === null ? NEW_THREAD_WIRE_TOKEN : update.threadId,
            assignedBy: update.assignedBy === null ? NO_ASSIGNEE_WIRE_TOKEN : update.assignedBy
        }))
    };
    return {
        content: null,
        toolCalls: [{
            id: 'offline-call',
            type: 'function',
            function: { name: REDUCTION_TOOL_NAME, arguments: JSON.stringify(wire) }
        }],
        attempts: 1,
        finishReason: 'tool_calls',
        usage: { total_tokens: 5 }
    };
}

function longText() {
    return [
        '首段语境锚点。',
        '任务：完成数据源调研并准备验收。',
        '结果：任务完成，结论已确认。',
        '更正：不是旧日期，应为外层事件日期；禁止猜测省略内容。',
        '普通噪声'.repeat(2200),
        '末段语境锚点。'
    ].join('\n');
}

function hasUnpairedSurrogate(text) {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = text.charCodeAt(index + 1);
            if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
            index += 1;
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
            return true;
        }
    }
    return false;
}

test('small event remains text-identical while nested values are isolated', () => {
    const source = event('small', '短事件', { nested: { labels: ['original'] } });
    const projected = projectCanonicalEventForPrompt(source);
    assert.equal(projected.text, source.text);
    assert.notStrictEqual(projected, source);
    assert.notStrictEqual(projected.nested, source.nested);
    projected.nested.labels.push('changed');
    assert.deepEqual(source.nested.labels, ['original']);
    assert.equal(projected.textProjection, undefined);
});

test('default projection cap is fixed at 3750 and exact-cap events are never projected', () => {
    assert.equal(DEFAULT_PROMPT_EVENT_TEXT_CHARS, 3750);
    const source = event('exact-cap', 'x'.repeat(DEFAULT_PROMPT_EVENT_TEXT_CHARS));
    const projected = projectCanonicalEventForPrompt(source);
    assert.equal(projected.text, source.text);
    assert.equal(projected.textProjection, undefined);
});

test('large event is bounded, deterministic, and preserves canonical identity fields', () => {
    const source = event('large', longText());
    const before = JSON.stringify(source);
    const first = projectCanonicalEventForPrompt(source);
    const second = projectCanonicalEventForPrompt(source);
    assert.ok(first.text.length <= DEFAULT_PROMPT_EVENT_TEXT_CHARS);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(source), before);
    assert.equal(first.eventId, source.eventId);
    assert.equal(first.occurredAt, source.occurredAt);
    assert.deepEqual(first.actor, source.actor);
    assert.deepEqual(first.origin, source.origin);
    assert.equal(first.role, source.role);
    assert.equal(first.kind, source.kind);
    assert.deepEqual(first.artifactRefs, source.artifactRefs);
    assert.equal(first.eventUid, source.eventUid);
    assert.equal(first.contentHash, source.contentHash);
    assert.equal(first.textProjection.applied, true);
    assert.equal(first.textProjection.originalChars, source.text.length);
    assert.equal(first.textProjection.projectedChars, first.text.length);
});

test('semantic projection keeps task, result, correction, and ordered anchors', () => {
    const projected = projectCanonicalEventForPrompt(event('semantic', longText()));
    for (const text of ['任务：完成数据源调研并准备验收。', '结果：任务完成，结论已确认。', '更正：不是旧日期']) {
        assert.match(projected.text, new RegExp(text.slice(0, 8)));
    }
    assert.match(projected.text, /首段语境锚点/);
    assert.match(projected.text, /末段语境锚点/);
    assert.ok(projected.text.indexOf('任务：') < projected.text.indexOf('结果：'));
    assert.ok(projected.text.indexOf('结果：') < projected.text.indexOf('更正：'));
});

test('tool request/result summaries are both mandatory and remain ordered', () => {
    const text = [
        '前置语境。',
        '[工具请求：工具=read；目的=查看文件]',
        '普通日志'.repeat(2200),
        '[工具结果：退出码=0；结论=完成；artifact=C:/fixture.txt]',
        '后置语境。'
    ].join('\n');
    const projected = projectCanonicalEventForPrompt(event('tools', text, { kind: 'tool_exchange' }));
    assert.ok(projected.text.length <= DEFAULT_PROMPT_EVENT_TEXT_CHARS);
    assert.match(projected.text, /\[工具请求：工具=read；目的=查看文件\]/);
    assert.match(projected.text, /\[工具结果：退出码=0；结论=完成；artifact=C:\/fixture\.txt\]/);
    assert.ok(projected.text.indexOf('[工具请求：') < projected.text.indexOf('[工具结果：'));
});

test('required tool summary failure has a stable error and no silent omission', () => {
    const oversizedSummary = `[工具请求：${'x'.repeat(700)}]`;
    assert.throws(
        () => projectCanonicalEventForPrompt(event('too-small', `${oversizedSummary}\n尾部`), { eventTextCapChars: 512 }),
        error => error.code === 'MEMO_V2_PROMPT_PROJECTION_REQUIRED_SEGMENT_LOST'
    );
});

test('single-boundary-free text is safely truncated without unpaired surrogates or empty output', () => {
    const projected = projectCanonicalEventForPrompt(event('unicode', '😀'.repeat(5000)), { eventTextCapChars: 512 });
    assert.ok(projected.text.length <= 512);
    assert.ok(projected.text.length > 0);
    assert.equal(hasUnpairedSurrogate(projected.text), false);
});

test('projector rejects caps outside the stable range', () => {
    for (const cap of [0, 511, 8001, 512.5, 'not-a-number']) {
        assert.throws(
            () => projectCanonicalEventForPrompt(event('bad-cap', '正文'), { eventTextCapChars: cap }),
            error => error.code === 'MEMO_V2_PROMPT_EVENT_TEXT_CAP_INVALID'
        );
    }
});

test('event array projection preserves order, count, and deep isolation', () => {
    const source = [event('1', longText()), event('2', '小事件'), event('3', longText())];
    const projected = projectCanonicalEventsForPrompt(source);
    assert.deepEqual(projected.map(item => item.eventId), ['1', '2', '3']);
    assert.equal(projected.length, source.length);
    projected[0].artifactRefs[0].path = 'changed';
    assert.equal(source[0].artifactRefs[0].path, 'C:/fixture.txt');
});

test('PromptBuilder uses projection text but original IDs and actor contract', () => {
    const source = event('68', longText());
    const before = JSON.stringify(source);
    const prompt = buildReductionPrompt({ canonicalEvents: [source], previousState: {}, maxInputChars: 10000 });
    assert.equal(prompt.validationContract.currentEventIds[0], '68');
    assert.deepEqual(prompt.validationContract.currentActorNames, ['Lucy']);
    assert.equal(prompt.includedEventIds[0], '68');
    assert.match(prompt.messages[1].content, /textProjection/);
    assert.match(prompt.messages[1].content, /任务：完成数据源调研/);
    assert.equal(JSON.stringify(source), before);
    assert.equal(prompt.stats.inputEventCount, 1);
    assert.equal(prompt.stats.includedEventCount, 1);
    assert.equal(prompt.stats.droppedEventCount, 0);
    assert.equal(prompt.stats.eventTextCapChars, 3750);
    assert.equal(prompt.stats.projectedEventCount, 1);
    assert.ok(prompt.stats.projectionRemovedChars > 0);
    assert.doesNotMatch(JSON.stringify(prompt.stats), /任务：|普通噪声|Lucy/u);
});

test('PromptBuilder explicit cap is effective and raw unsafe input remains rejected', () => {
    const prompt = buildReductionPrompt({
        canonicalEvents: [event('69', longText())],
        previousState: {},
        maxInputChars: 10000,
        eventTextCapChars: 3000
    });
    assert.equal(prompt.stats.eventTextCapChars, 3000);
    assert.ok(prompt.stats.projectionOutputChars <= 3000);
    for (const unsafe of ['<<<[TOOL_REQUEST]>>>', '<div>html</div>', 'api-key=raw-secret-value']) {
        assert.throws(
            () => buildReductionPrompt({ canonicalEvents: [event('unsafe', `${unsafe}${longText()}`)], previousState: {} }),
            error => error.code === 'MEMO_V2_PROMPT_UNSAFE_INPUT'
        );
    }
});

test('PromptBuilder projected stats match only unique original over-cap events', () => {
    const events = [
        event('under', 'u'.repeat(3750)),
        event('over-one', 'a'.repeat(3751)),
        event('over-two', 'b'.repeat(5000))
    ];
    const prompt = buildReductionPrompt({ canonicalEvents: events, previousState: {}, maxInputChars: 20000 });
    assert.equal(prompt.stats.eventTextCapChars, 3750);
    assert.equal(prompt.stats.projectedEventCount, 2);
    assert.equal(prompt.stats.projectionRemovedChars, 1251);
    assert.ok(prompt.messages[1].content.includes('"eventId":"under"'));
});

test('PromptBuilder fails fixed-cap budget overflow instead of implicitly lowering cap', () => {
    const source = event('under-cap-budget', 'x'.repeat(3600));
    assert.ok(source.text.length <= 3750);
    assert.throws(
        () => buildReductionPrompt({
            canonicalEvents: [source],
            previousState: {},
            maxInputChars: 7800
        }),
        error => error.code === 'MEMO_V2_PROMPT_BUDGET_EXCEEDED'
    );
});

test('PromptBuilder explicit cap 4500 remains fixed and fails when that request is over budget', () => {
    assert.throws(
        () => buildReductionPrompt({
            canonicalEvents: [event('explicit-4500', 'x'.repeat(6000))],
            previousState: {},
            maxInputChars: 8500,
            eventTextCapChars: 4500
        }),
        error => error.code === 'MEMO_V2_PROMPT_BUDGET_EXCEEDED'
    );
});

test('PromptBuilder keeps complete current event IDs and does not leak projector metadata into stats', () => {
    const events = [event('a', longText()), event('b', '短事件')];
    const prompt = buildReductionPrompt({ canonicalEvents: events, previousState: {}, maxInputChars: 10000 });
    assert.deepEqual(prompt.includedEventIds, ['a', 'b']);
    assert.deepEqual(prompt.validationContract.currentEventIds, ['a', 'b']);
    assert.equal(prompt.stats.inputEventCount, 2);
    assert.equal(prompt.stats.includedEventCount, 2);
    assert.equal(prompt.stats.droppedEventCount, 0);
    assert.doesNotMatch(JSON.stringify(prompt.stats), /textProjection|普通噪声|Lucy/);
});

test('BatchPlanner uses the same projection cap, stays within 10k, and fully covers source events', () => {
    const events = Array.from({ length: 18 }, (_, index) => event(String(index + 1), longText()));
    const plan = planMemoV2Batches({ canonicalEvents: events, previousState: {}, maxInputChars: 10000 });
    assert.equal(plan.eventTextCapChars, 3750);
    assert.deepEqual(plan.batchIds.flat(), events.map(item => item.eventId));
    assert.equal(plan.totalEventCount, 18);
    assert.equal(plan.coveredEventCount, 18);
    assert.equal(plan.droppedEventCount, 0);
    assert.equal(plan.duplicateCoverageCount, 0);
    assert.ok(plan.batchPromptChars.every(chars => chars <= 10000));
    assert.equal(plan.totalProjectedEventCount, 18);
    assert.equal(plan.batchProjectedEventCounts.reduce((sum, count) => sum + count, 0), 18);
    assert.ok(plan.totalProjectionRemovedChars > 0);
});

test('BatchPlanner counts each canonical over-cap event once across the full plan', () => {
    const events = [
        event('under-1', 'u'.repeat(100)),
        event('over-1', 'a'.repeat(4000)),
        event('under-2', 'v'.repeat(100)),
        event('over-2', 'b'.repeat(5000)),
        event('under-3', 'w'.repeat(100))
    ];
    const plan = planMemoV2Batches({ canonicalEvents: events, previousState: {}, maxInputChars: 10000 });
    assert.deepEqual(plan.batchIds.flat(), events.map(item => item.eventId));
    assert.equal(plan.totalProjectedEventCount, 2);
    assert.deepEqual(
        plan.batchProjectedEventCounts.reduce((sum, count) => sum + count, 0),
        events.filter(item => item.text.length > plan.eventTextCapChars).length
    );
    assert.equal(plan.totalProjectionRemovedChars, (4000 - 3750) + (5000 - 3750));
});

test('BatchPlanner with twelve active thread reserve still covers at 10k', () => {
    const previous = state();
    previous.activeThreads = Array.from({ length: 12 }, (_, index) => ({
        threadId: `thread-${index}`,
        task: `保留任务 ${index}`,
        status: 'in_progress',
        constraints: ['预算'],
        assignedBy: 'Lucy',
        sourceMessageIds: [`old-${index}`]
    }));
    const events = Array.from({ length: 12 }, (_, index) => event(String(index + 1), longText()));
    const plan = planMemoV2Batches({ canonicalEvents: events, previousState: previous, maxInputChars: 10000 });
    assert.equal(plan.droppedEventCount, 0);
    assert.equal(plan.duplicateCoverageCount, 0);
    assert.ok(plan.batchPromptChars.every(chars => chars <= 10000));
});

test('cap 8000 can reproduce a single-event prompt budget rejection without skipping it', () => {
    const oversized = event('oversized', '普通内容'.repeat(6000));
    assert.throws(
        () => planMemoV2Batches({ canonicalEvents: [oversized], previousState: {}, maxInputChars: 10000, eventTextCapChars: 8000 }),
        error => error.code === 'MEMO_V2_EVENT_EXCEEDS_PROMPT_BUDGET'
    );
});

test('orchestrator gives the mock model projected text while validation uses original source identity', async () => {
    const source = event('68', longText());
    const input = delta([source]);
    const beforeEvents = JSON.stringify(input.canonicalEvents);
    const beforeState = JSON.stringify(input.previousState);
    let request;
    const result = await generateShadowCandidate({
        agentName: 'fixture-agent',
        delta: input,
        previousState: input.previousState,
        model: 'offline',
        eventTextCapChars: 3000,
        modelClient: {
            complete: async value => {
                request = value;
                assert.match(value.messages[1].content, /任务：完成数据源调研/);
                return toolResponse({ facts: [{ text: '完成数据源调研', sourceMessageIds: ['68'] }], threadUpdates: [] });
            }
        }
    });
    assert.equal(result.ok, true);
    assert.equal(result.state.timeline[0].sourceMessageIds[0], '68');
    assert.equal(result.stats.eventTextCapChars, 3000);
    assert.equal(result.stats.droppedCanonicalEventCount, 0);
    assert.equal(result.stats.projectedEventCount, 1);
    assert.equal(JSON.stringify(input.canonicalEvents), beforeEvents);
    assert.equal(JSON.stringify(input.previousState), beforeState);
    assert.ok(request);
    assert.doesNotMatch(JSON.stringify(result.state), /textProjection|semantic-priority|省略内容/);
    assert.doesNotMatch(result.rendered.text, /textProjection|semantic-priority/);
});

test('projector failure is transactional and records required-segment failure only', async () => {
    const input = delta([event('bad', `[工具请求：${'x'.repeat(700)}]`)]);
    let calls = 0;
    let writes = 0;
    const before = JSON.stringify(input.previousState);
    const result = await generateShadowCandidate({
        agentName: 'fixture-agent',
        delta: input,
        previousState: input.previousState,
        model: 'offline',
        eventTextCapChars: 512,
        modelClient: { complete: async () => { calls++; } },
        writeCandidate: true,
        store: { writeCandidate: () => { writes++; } }
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MEMO_V2_PROMPT_PROJECTION_REQUIRED_SEGMENT_LOST');
    assert.equal(result.cursorAdvanced, false);
    assert.equal(result.candidateWritten, false);
    assert.equal(result.stats.projectionRequiredSegmentFailures, 1);
    assert.equal(calls, 0);
    assert.equal(writes, 0);
    assert.equal(JSON.stringify(input.previousState), before);
});

test('successful candidate and rendered memo contain no projector metadata or omitted body', async () => {
    const input = delta([event('68', longText())]);
    const result = await generateShadowCandidate({
        agentName: 'fixture-agent',
        delta: input,
        previousState: input.previousState,
        model: 'offline',
        modelClient: {
            complete: async () => toolResponse({ facts: [{ text: '投影可见的完成结果', sourceMessageIds: ['68'] }], threadUpdates: [] })
        }
    });
    assert.equal(result.ok, true);
    assert.equal(result.stats.eventTextCapChars, 3750);
    assert.doesNotMatch(JSON.stringify(result.state), /textProjection|originalChars|omittedSegmentCount|普通噪声/);
    assert.doesNotMatch(result.rendered.text, /textProjection|originalChars|omittedSegmentCount/);
});

test('CLI defaults to 3750 metrics, allows override, and never calls model or writes candidate', async () => {
    const input = delta([event('68', longText())]);
    const originalWrite = process.stdout.write;
    let output = '';
    process.stdout.write = chunk => { output += String(chunk); return true; };
    try {
        await shadowMain(['--agent', 'fixture-agent', '--request-metrics'], {
            buildDelta: () => input,
            store: { writeCandidate: () => { throw new Error('must not write'); } }
        });
    } finally {
        process.stdout.write = originalWrite;
    }
    const metrics = JSON.parse(output);
    assert.equal(metrics.eventTextCapChars, 3750);
    assert.equal(metrics.totalCanonicalEventCount, 1);
    assert.equal(metrics.coveredCanonicalEventCount, 1);
    assert.equal(metrics.droppedCanonicalEventCount, 0);
    assert.equal(metrics.duplicateCoverageCount, 0);
    assert.equal(metrics.model, false);
    assert.equal(metrics.candidate, false);
    assert.equal(metrics.modelCalled, false);
    assert.equal(metrics.candidateWritten, false);
    assert.ok(metrics.totalProjectedEventCount >= 1);
    assert.ok(metrics.totalProjectionRemovedChars > 0);
    assert.doesNotMatch(output, /普通噪声|CURRENT_CANONICAL_EVENTS|SERVER_VALIDATION_CONTRACT|textProjection/);

    assert.match(shadowUsage(), /Default event text cap: 3750 characters/u);
    assert.equal(parseShadowArgs(['--agent', 'fixture-agent']).eventTextCapChars, 3750);
    assert.equal(parseShadowArgs(['--agent', 'fixture-agent', '--event-text-cap-chars', '3000']).eventTextCapChars, 3000);
    assert.throws(() => parseShadowArgs(['--agent', 'fixture-agent', '--event-text-cap-chars', '511']));
    assert.throws(() => parseShadowArgs(['--agent', 'fixture-agent', '--event-text-cap-chars', '8001']));
});
