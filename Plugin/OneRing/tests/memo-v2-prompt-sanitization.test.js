'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDefaultState } = require('../lib/MemoV2Store.js');
const {
    sanitizeCanonicalTextForPrompt,
    sanitizeCanonicalEventForPrompt
} = require('../lib/MemoV2PromptSanitizer.js');
const {
    DEFAULT_PROMPT_EVENT_TEXT_CHARS,
    projectCanonicalEventForPrompt,
    projectCanonicalEventsForPrompt,
    summarizeProjection
} = require('../lib/MemoV2PromptProjector.js');
const { compactEvent, buildReductionPrompt } = require('../lib/MemoV2PromptBuilder.js');
const { planMemoV2Batches } = require('../lib/MemoV2BatchPlanner.js');
const { generateShadowCandidate } = require('../lib/MemoV2Orchestrator.js');
const { REDUCTION_TOOL_NAME } = require('../lib/MemoV2ToolContract.js');
const { NEW_THREAD_WIRE_TOKEN, NO_ASSIGNEE_WIRE_TOKEN } = require('../lib/MemoV2WireTokens.js');
const { main: shadowMain, metricsFromDelta } = require('../scripts/memo-v2-shadow-candidate.js');

function event(eventId, text, overrides = {}) {
    return {
        schemaVersion: 2,
        eventId: String(eventId),
        eventUid: `uid-${eventId}`,
        occurredAt: '2026-08-23 10:00:00',
        role: 'user',
        actor: { name: 'Lucy', role: 'user' },
        origin: { frontendSource: 'offline-test' },
        kind: 'message',
        text,
        artifactRefs: [],
        contentHash: `hash-${eventId}`,
        nested: { values: ['unchanged'] },
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
        snapshotDbMaxId: 100,
        nextCursor: { lastMessageId: 100, snapshotDbMaxId: 100 },
        sourceMessageIds: events.map(item => item.eventId),
        canonicalEvents: events,
        skipped: { total: 0 },
        duplicates: { total: 0 },
        stats: {
            sourceMessageCount: events.length,
            normalizedEventCount: events.length,
            normalizedChars: events.reduce((sum, item) => sum + item.text.length, 0)
        }
    };
}

function toolResponse(payload) {
    return {
        content: null,
        toolCalls: [{
            id: 'offline-sanitization-call',
            type: 'function',
            function: { name: REDUCTION_TOOL_NAME, arguments: JSON.stringify(payload) }
        }],
        attempts: 1,
        finishReason: 'tool_calls',
        usage: { total_tokens: 1 }
    };
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

test('sanitizer strips supported placeholder forms and preserves ordinary words', () => {
    assert.equal(sanitizeCanonicalTextForPrompt('前 password="[REDACTED]"；后'), '前；后');
    assert.equal(sanitizeCanonicalTextForPrompt('前 API_KEY：Bearer “[redacted]” 后'), '前 后');
    assert.equal(sanitizeCanonicalTextForPrompt('前 验证码为（[REDACTED]） 后'), '前 后');
    assert.equal(sanitizeCanonicalTextForPrompt('前 Bearer [ReDaCtEd] 后'), '前 后');
    assert.equal(sanitizeCanonicalTextForPrompt('前 [REDACTED] 后'), '前 后');
    assert.equal(sanitizeCanonicalTextForPrompt('ordinary redacted word'), 'ordinary redacted word');
    assert.equal(sanitizeCanonicalTextForPrompt('开始  [REDACTED]  ，\n\n\n 继续   。'), '开始，\n\n继续。');
    const source = event('cleanup', '  前  [REDACTED]  ，\r\n\r\n  后  ');
    const sanitized = sanitizeCanonicalEventForPrompt(source);
    assert.equal(sanitized.text, '前，\n\n后');
    assert.equal(sanitized.promptSanitization.placeholderCount, 1);
});

test('sanitizer is a strict text no-op without the canonical placeholder', () => {
    const text = '  多空格  \r\n第二行   \r\n\r\n\n标点前空格 ，  后  \n  前后空白  ';
    assert.equal(sanitizeCanonicalTextForPrompt(text), text);
    assert.equal(sanitizeCanonicalTextForPrompt('ordinary redacted word'), 'ordinary redacted word');
});

test('sanitizer replaces archived wire tokens only in copied event text and counts occurrences', () => {
    const events = [
        event('wire-new', `前 ${NEW_THREAD_WIRE_TOKEN} 后`),
        event('wire-repeat', `${NEW_THREAD_WIRE_TOKEN} 中 ${NEW_THREAD_WIRE_TOKEN}`),
        event('wire-assignee', `前 ${NO_ASSIGNEE_WIRE_TOKEN} 后`),
        event('wire-both', `${NEW_THREAD_WIRE_TOKEN} 与 ${NO_ASSIGNEE_WIRE_TOKEN}`),
        event('wire-redacted', `前 ${NEW_THREAD_WIRE_TOKEN} [REDACTED] ${NO_ASSIGNEE_WIRE_TOKEN} 后`)
    ];
    const before = JSON.stringify(events);
    const sanitized = events.map(item => sanitizeCanonicalEventForPrompt(item));

    assert.equal(sanitized[0].text, '前 新线程归档 后');
    assert.equal(sanitized[1].text, '新线程归档 中 新线程归档');
    assert.equal(sanitized[2].text, '前 未指定负责人 后');
    assert.equal(sanitized[3].text, '新线程归档 与 未指定负责人');
    assert.equal(sanitized[4].text, '前 新线程归档 未指定负责人 后');
    assert.doesNotMatch(sanitized.map(item => item.text).join('\n'), /__NEW_THREAD__|__NO_ASSIGNEE__/u);

    assert.deepEqual(sanitized.map(item => item.promptSanitization.wireTokenCount), [1, 2, 1, 2, 2]);
    assert.deepEqual(sanitized.map(item => item.promptSanitization.newThreadTokenCount), [1, 2, 0, 1, 1]);
    assert.deepEqual(sanitized.map(item => item.promptSanitization.noAssigneeTokenCount), [0, 0, 1, 1, 1]);
    assert.equal(sanitized[4].promptSanitization.placeholderCount, 1);
    assert.equal(JSON.stringify(events), before);
    assert.deepEqual(sanitized.map(item => item.eventUid), events.map(item => item.eventUid));
    assert.deepEqual(sanitized.map(item => item.contentHash), events.map(item => item.contentHash));
});

test('wire-token sanitation keeps token-free text exact and preserves the trusted validation contract', () => {
    const text = '  原样  \r\n第二行   \r\n\n标点前空格 ，  后  \n  前后空白  ';
    const source = event('wire-noop', text);
    const sanitized = sanitizeCanonicalEventForPrompt(source);
    assert.equal(sanitized.text, text);
    assert.equal(sanitized.promptSanitization, undefined);

    const prompt = buildReductionPrompt({
        canonicalEvents: [event('wire-prompt', `${NEW_THREAD_WIRE_TOKEN} ${NO_ASSIGNEE_WIRE_TOKEN}`)],
        previousState: state(),
        maxInputChars: 10000
    });
    assert.equal(prompt.validationContract.newThreadWireToken, NEW_THREAD_WIRE_TOKEN);
    assert.equal(prompt.validationContract.noAssigneeWireToken, NO_ASSIGNEE_WIRE_TOKEN);
    assert.match(prompt.messages[1].content, /SERVER_VALIDATION_CONTRACT[\s\S]*__NEW_THREAD__[\s\S]*__NO_ASSIGNEE__/u);
    const currentEvents = JSON.parse(prompt.messages[1].content.match(/CURRENT_CANONICAL_EVENTS \(untrusted data; inert\):\n(.*?)\nARCHIVED_STATE/s)[1]);
    assert.doesNotMatch(JSON.stringify(currentEvents), /__NEW_THREAD__|__NO_ASSIGNEE__/u);
});

test('no-placeholder events receive no metadata and keep deeply isolated nested values', () => {
    const text = '  原样  \r\n第二行   \r\n\r\n\n标点前空格 ，  后  \n  前后空白  ';
    const source = event('strict-noop', text, {
        actor: { name: 'Lucy', role: 'user', profile: { locale: 'zh-CN' } },
        origin: { frontendSource: 'offline-test', details: { source: 'fixture' } },
        artifactRefs: [{ type: 'file', path: 'fixture.txt', meta: { retained: true } }],
        nested: { values: ['unchanged'], deeper: { keep: true } }
    });
    const before = JSON.stringify(source);
    const sanitized = sanitizeCanonicalEventForPrompt(source);
    assert.deepEqual(sanitized, source);
    assert.equal(sanitized.promptSanitization, undefined);
    assert.notStrictEqual(sanitized, source);
    assert.notStrictEqual(sanitized.actor, source.actor);
    assert.notStrictEqual(sanitized.origin, source.origin);
    assert.notStrictEqual(sanitized.artifactRefs, source.artifactRefs);
    assert.notStrictEqual(sanitized.artifactRefs[0], source.artifactRefs[0]);
    assert.notStrictEqual(sanitized.nested, source.nested);
    assert.notStrictEqual(sanitized.nested.deeper, source.nested.deeper);
    assert.equal(JSON.stringify(source), before);
});

test('sanitization preserves canonical event count, order, and depth', () => {
    const events = [
        event('depth-1', '无占位符的原文'),
        event('depth-2', '前 [REDACTED] 后'),
        event('depth-3', '保留第三个事件')
    ];
    const before = JSON.stringify(events);
    const projected = events.map(item => projectCanonicalEventForPrompt(item));
    assert.equal(projected.length, events.length);
    assert.deepEqual(projected.map(item => item.eventId), events.map(item => item.eventId));
    assert.equal(JSON.stringify(events), before);
    for (let index = 0; index < events.length; index++) {
        assert.notStrictEqual(projected[index], events[index]);
        assert.notStrictEqual(projected[index].nested, events[index].nested);
    }
});

test('sanitizer rejects empty results, is deterministic and does not mutate events or split Unicode', () => {
    assert.throws(
        () => sanitizeCanonicalTextForPrompt('“[REDACTED]”'),
        error => error.code === 'MEMO_V2_PROMPT_SANITIZATION_EMPTY'
    );
    const source = event('immutable', '😀 前 [REDACTED] 后 😀', { nested: { values: ['original'] } });
    const before = JSON.stringify(source);
    const first = sanitizeCanonicalEventForPrompt(source);
    const second = sanitizeCanonicalEventForPrompt(source);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(source), before);
    assert.notStrictEqual(first, source);
    assert.notStrictEqual(first.nested, source.nested);
    assert.deepEqual(first.nested, source.nested);
    assert.equal(first.eventUid, source.eventUid);
    assert.equal(first.contentHash, source.contentHash);
    assert.equal(first.promptSanitization.applied, true);
    assert.equal(first.promptSanitization.placeholderCount, 1);
    assert.equal(hasUnpairedSurrogate(first.text), false);
});

test('projector sanitizes before fixed cap and keeps tool summaries', () => {
    const belowCap = event('below-cap', `任务：保留。${'[REDACTED]'.repeat(2)}${'x'.repeat(3730)}`);
    const projectedBelowCap = projectCanonicalEventForPrompt(belowCap);
    const belowStats = summarizeProjection([belowCap], [projectedBelowCap], DEFAULT_PROMPT_EVENT_TEXT_CHARS);
    assert.ok(belowCap.text.length > DEFAULT_PROMPT_EVENT_TEXT_CHARS);
    assert.ok(projectedBelowCap.text.length <= DEFAULT_PROMPT_EVENT_TEXT_CHARS);
    assert.equal(projectedBelowCap.textProjection, undefined);
    assert.equal(belowStats.promptSanitizedEventCount, 1);
    assert.equal(belowStats.promptRedactionPlaceholderCount, 2);
    assert.equal(belowStats.projectedEventCount, 0);
    assert.equal(belowStats.projectionRemovedChars, 0);

    const aboveCap = event('above-cap', `任务：保留。${'[REDACTED]'}${'a'.repeat(5000)}`);
    const projectedAboveCap = projectCanonicalEventForPrompt(aboveCap);
    const aboveStats = summarizeProjection([aboveCap], [projectedAboveCap], DEFAULT_PROMPT_EVENT_TEXT_CHARS);
    assert.equal(projectedAboveCap.promptSanitization.placeholderCount, 1);
    assert.equal(projectedAboveCap.textProjection.originalChars, projectedAboveCap.promptSanitization.sanitizedChars);
    assert.equal(aboveStats.promptSanitizedEventCount, 1);
    assert.equal(aboveStats.promptRedactionPlaceholderCount, 1);
    assert.equal(aboveStats.projectedEventCount, 1);
    assert.ok(aboveStats.projectionRemovedChars > 0);
    assert.doesNotMatch(projectedAboveCap.text, /\[REDACTED\]/iu);

    const toolEvent = event('tools', [
        '前置语境。',
        '[工具请求：工具=read；目的=查看文件]',
        '[REDACTED]',
        '普通日志'.repeat(400),
        '[工具结果：退出码=0；结论=完成]',
        '后置语境。'
    ].join('\n'), { kind: 'tool_exchange' });
    const toolProjection = projectCanonicalEventForPrompt(toolEvent, { eventTextCapChars: 512 });
    assert.match(toolProjection.text, /\[工具请求：工具=read；目的=查看文件\]/u);
    assert.match(toolProjection.text, /\[工具结果：退出码=0；结论=完成\]/u);
    assert.doesNotMatch(toolProjection.text, /\[REDACTED\]/iu);
});

test('projector aggregates wire-token counts by occurrence and keeps event order and identity', () => {
    const events = [
        event('stats-1', `${NEW_THREAD_WIRE_TOKEN} ${NEW_THREAD_WIRE_TOKEN}`),
        event('stats-2', `前 ${NO_ASSIGNEE_WIRE_TOKEN} [REDACTED] 后`),
        event('stats-3', '普通正文')
    ];
    const before = JSON.stringify(events);
    const projected = projectCanonicalEventsForPrompt(events);
    const stats = summarizeProjection(events, projected, DEFAULT_PROMPT_EVENT_TEXT_CHARS);

    assert.equal(stats.promptSanitizedEventCount, 2);
    assert.equal(stats.promptWireTokenCount, 3);
    assert.equal(stats.promptNewThreadTokenCount, 2);
    assert.equal(stats.promptNoAssigneeTokenCount, 1);
    assert.deepEqual(projected.map(item => item.eventId), events.map(item => item.eventId));
    assert.deepEqual(projected.map(item => item.eventUid), events.map(item => item.eventUid));
    assert.deepEqual(projected.map(item => item.contentHash), events.map(item => item.contentHash));
    assert.doesNotMatch(JSON.stringify(projected), /__NEW_THREAD__|__NO_ASSIGNEE__/u);
    assert.equal(JSON.stringify(events), before);
});

test('PromptBuilder excludes sanitizer metadata, rejects residual non-text placeholders, and keeps archive safety strict', () => {
    const source = event('builder', '前 password=[REDACTED]；非敏感上下文 后');
    const before = JSON.stringify(source);
    const prompt = buildReductionPrompt({ canonicalEvents: [source], previousState: state(), maxInputChars: 10000 });
    assert.equal(JSON.stringify(source), before);
    assert.doesNotMatch(JSON.stringify(prompt.messages), /\[REDACTED\]/iu);
    assert.doesNotMatch(JSON.stringify(prompt.messages), /promptSanitization/u);
    assert.equal(prompt.stats.promptSanitizedEventCount, 1);
    assert.equal(prompt.stats.promptRedactionPlaceholderCount, 1);
    assert.ok(prompt.stats.promptSanitizationRemovedChars > 0);
    assert.equal(compactEvent(projectCanonicalEventForPrompt(source)).promptSanitization, undefined);

    assert.throws(
        () => buildReductionPrompt({
            canonicalEvents: [event('artifact', '安全正文', { artifactRefs: [{ type: 'file', path: '[REDACTED]' }] })],
            previousState: state(),
            maxInputChars: 10000
        }),
        error => error.code === 'MEMO_V2_PROMPT_REDACTION_PLACEHOLDER_REMAINS'
    );
    for (const unsafeText of ['api_key=unredacted-value', '<b>html</b>', '<<<[TOOL_REQUEST]>>>']) {
        assert.throws(
            () => buildReductionPrompt({ canonicalEvents: [event('unsafe', unsafeText)], previousState: state() }),
            error => error.code === 'MEMO_V2_PROMPT_UNSAFE_INPUT'
        );
    }
});

test('BatchPlanner aggregates sanitization once per canonical event with no coverage loss', () => {
    const events = [
        event('1', '普通 [REDACTED] 内容'),
        event('2', '  普通  内容  \r\n\r\n 行尾空格  '),
        event('3', 'Bearer [REDACTED] 后'),
        event('4', '中文密码是（[REDACTED]）后')
    ];
    const plan = planMemoV2Batches({ canonicalEvents: events, previousState: state(), maxInputChars: 10000 });
    assert.deepEqual(plan.batchIds.flat(), events.map(item => item.eventId));
    assert.equal(plan.droppedEventCount, 0);
    assert.equal(plan.duplicateCoverageCount, 0);
    const placeholderBearingEventCount = events.filter(item => /\[REDACTED\]/iu.test(item.text)).length;
    assert.equal(plan.totalPromptSanitizedEventCount, placeholderBearingEventCount);
    assert.equal(plan.totalPromptSanitizedEventCount, 3);
    assert.equal(plan.totalPromptRedactionPlaceholderCount, 3);
    assert.ok(plan.totalPromptSanitizationRemovedChars > 0);
    assert.equal(plan.totalPromptSanitizedEventCount, plan.batchPromptSanitizedEventCounts.reduce((sum, count) => sum + count, 0));
    assert.equal(plan.totalProjectedEventCount, 0);
});

test('wire-token stats flow through builder, planner, orchestrator, and metrics without duplicate counts', async () => {
    const singleEvents = [
        event('wire-single-1', `${NEW_THREAD_WIRE_TOKEN} ${NEW_THREAD_WIRE_TOKEN} ${NO_ASSIGNEE_WIRE_TOKEN}`),
        event('wire-single-2', `${NO_ASSIGNEE_WIRE_TOKEN} ${NEW_THREAD_WIRE_TOKEN}`)
    ];
    const prompt = buildReductionPrompt({ canonicalEvents: singleEvents, previousState: state(), maxInputChars: 10000 });
    assert.deepEqual([
        prompt.stats.promptWireTokenCount,
        prompt.stats.promptNewThreadTokenCount,
        prompt.stats.promptNoAssigneeTokenCount
    ], [5, 3, 2]);

    const events = [
        event('wire-batch-1', `${NEW_THREAD_WIRE_TOKEN} ${'x'.repeat(4000)}`),
        event('wire-batch-2', `${NO_ASSIGNEE_WIRE_TOKEN} ${'y'.repeat(4000)}`),
        event('wire-batch-3', `${NEW_THREAD_WIRE_TOKEN} ${NO_ASSIGNEE_WIRE_TOKEN} ${'z'.repeat(4000)}`)
    ];
    const plan = planMemoV2Batches({ canonicalEvents: events, previousState: state(), maxInputChars: 10000 });
    assert.ok(plan.batches.length > 1);
    const expected = plan.batches.map(batch => {
        const batchPrompt = buildReductionPrompt({ canonicalEvents: batch, previousState: state(), maxInputChars: 10000 });
        return [
            batchPrompt.stats.promptWireTokenCount,
            batchPrompt.stats.promptNewThreadTokenCount,
            batchPrompt.stats.promptNoAssigneeTokenCount
        ];
    });
    assert.deepEqual(plan.batchPromptWireTokenCounts, expected.map(item => item[0]));
    assert.deepEqual(plan.batchPromptNewThreadTokenCounts, expected.map(item => item[1]));
    assert.deepEqual(plan.batchPromptNoAssigneeTokenCounts, expected.map(item => item[2]));
    assert.equal(plan.totalPromptWireTokenCount, 4);
    assert.equal(plan.totalPromptNewThreadTokenCount, 2);
    assert.equal(plan.totalPromptNoAssigneeTokenCount, 2);

    let modelCalls = 0;
    const result = await generateShadowCandidate({
        agentName: 'fixture-agent',
        delta: delta(events),
        previousState: state(),
        model: 'offline',
        modelClient: {
            complete: async () => {
                modelCalls += 1;
                return toolResponse({ facts: [], threadUpdates: [] });
            }
        }
    });
    assert.equal(result.ok, true);
    assert.equal(modelCalls, plan.batches.length);
    assert.deepEqual(result.stats.batchPromptWireTokenCounts, plan.batchPromptWireTokenCounts);
    assert.deepEqual(result.stats.batchPromptNewThreadTokenCounts, plan.batchPromptNewThreadTokenCounts);
    assert.deepEqual(result.stats.batchPromptNoAssigneeTokenCounts, plan.batchPromptNoAssigneeTokenCounts);
    assert.equal(result.stats.promptWireTokenCount, plan.totalPromptWireTokenCount);
    assert.equal(result.stats.promptNewThreadTokenCount, plan.totalPromptNewThreadTokenCount);
    assert.equal(result.stats.promptNoAssigneeTokenCount, plan.totalPromptNoAssigneeTokenCount);
    assert.deepEqual(result.promptStats.batchPromptWireTokenCounts, plan.batchPromptWireTokenCounts);
    assert.equal(result.promptStats.promptWireTokenCount, plan.totalPromptWireTokenCount);

    const metrics = metricsFromDelta(delta(events), {
        plannedBatchCount: plan.batches.length,
        batchPromptWireTokenCounts: plan.batchPromptWireTokenCounts,
        batchPromptNewThreadTokenCounts: plan.batchPromptNewThreadTokenCounts,
        batchPromptNoAssigneeTokenCounts: plan.batchPromptNoAssigneeTokenCounts
    }, null);
    assert.equal(metrics.totalPromptWireTokenCount, 4);
    assert.equal(metrics.totalPromptNewThreadTokenCount, 2);
    assert.equal(metrics.totalPromptNoAssigneeTokenCount, 2);
    assert.deepEqual(metrics.batchPromptWireTokenCounts, plan.batchPromptWireTokenCounts);
    assert.doesNotMatch(JSON.stringify(metrics), /wire-batch|xxxxxxxx/u);

    const originalWrite = process.stdout.write;
    let output = '';
    process.stdout.write = chunk => { output += String(chunk); return true; };
    try {
        await shadowMain(['--agent', 'fixture-agent', '--request-metrics'], {
            buildDelta: () => delta(events),
            store: { writeCandidate: () => { throw new Error('must not write'); } }
        });
    } finally {
        process.stdout.write = originalWrite;
    }
    const cliMetrics = JSON.parse(output);
    assert.equal(cliMetrics.totalPromptWireTokenCount, 4);
    assert.equal(cliMetrics.totalPromptNewThreadTokenCount, 2);
    assert.equal(cliMetrics.totalPromptNoAssigneeTokenCount, 2);
    assert.deepEqual(cliMetrics.batchPromptWireTokenCounts, plan.batchPromptWireTokenCounts);
    assert.equal(cliMetrics.modelCalled, false);
    assert.equal(cliMetrics.candidateWritten, false);
    assert.doesNotMatch(output, /wire-batch|xxxxxxxx/u);

    const zeroMetrics = metricsFromDelta(delta([event('wire-zero', '普通正文')]), {
        plannedBatchCount: 1,
        batchPromptWireTokenCounts: [undefined],
        batchPromptNewThreadTokenCounts: [Infinity],
        batchPromptNoAssigneeTokenCounts: []
    }, null);
    assert.equal(zeroMetrics.totalPromptWireTokenCount, 0);
    assert.equal(zeroMetrics.totalPromptNewThreadTokenCount, 0);
    assert.equal(zeroMetrics.totalPromptNoAssigneeTokenCount, 0);
    assert.deepEqual(zeroMetrics.batchPromptWireTokenCounts, [0]);
    assert.deepEqual(zeroMetrics.batchPromptNewThreadTokenCounts, [0]);
    assert.deepEqual(zeroMetrics.batchPromptNoAssigneeTokenCounts, [0]);
});

test('orchestrator gives sanitized text, validates original identity, and leaves no prompt metadata in state', async () => {
    const source = event('68', '前 [REDACTED] 后');
    const input = delta([source]);
    let request;
    const result = await generateShadowCandidate({
        agentName: 'fixture-agent',
        delta: input,
        previousState: input.previousState,
        model: 'offline',
        modelClient: {
            complete: async value => {
                request = value;
                assert.doesNotMatch(JSON.stringify(value.messages), /\[REDACTED\]/iu);
                return toolResponse({
                    facts: [{ text: '已确认事实', sourceMessageIds: ['68'] }],
                    threadUpdates: [{
                        threadId: NEW_THREAD_WIRE_TOKEN,
                        task: '继续跟进',
                        status: 'in_progress',
                        constraints: [],
                        assignedBy: 'Lucy',
                        sourceMessageIds: ['68']
                    }]
                });
            }
        }
    });
    assert.equal(result.ok, true);
    assert.ok(request);
    assert.equal(result.state.timeline[0].sourceMessageIds[0], '68');
    assert.equal(result.state.activeThreads[0].assignedBy, 'Lucy');
    assert.doesNotMatch(JSON.stringify(result.state), /"promptSanitization"\s*:/u);
    assert.doesNotMatch(JSON.stringify(result.state), /\[REDACTED\]/iu);
    assert.equal(result.stats.modelCallCount, 1);
    assert.equal(result.stats.promptSanitizedEventCount, 1);
});

test('orchestrator rejects model placeholder output and rolls back empty sanitization before model call', async () => {
    const outputInput = delta([event('output', '安全正文')]);
    let writes = 0;
    const unsafeOutput = await generateShadowCandidate({
        agentName: 'fixture-agent',
        delta: outputInput,
        previousState: outputInput.previousState,
        model: 'offline',
        modelClient: { complete: async () => toolResponse({ facts: [{ text: '[REDACTED]', sourceMessageIds: ['output'] }], threadUpdates: [] }) },
        writeCandidate: true,
        store: { writeCandidate: () => { writes += 1; } }
    });
    assert.equal(unsafeOutput.ok, false);
    assert.equal(unsafeOutput.error.code, 'MEMO_V2_UNSAFE_TEXT');
    assert.equal(unsafeOutput.stats.modelCallCount, 1);
    assert.equal(unsafeOutput.candidateWritten, false);
    assert.equal(unsafeOutput.cursorAdvanced, false);
    assert.equal(writes, 0);

    const emptyInput = delta([event('empty', '[REDACTED]')]);
    const before = JSON.stringify(emptyInput.previousState);
    let calls = 0;
    const emptyResult = await generateShadowCandidate({
        agentName: 'fixture-agent',
        delta: emptyInput,
        previousState: emptyInput.previousState,
        model: 'offline',
        modelClient: { complete: async () => { calls += 1; return toolResponse({ facts: [], threadUpdates: [] }); } },
        writeCandidate: true,
        store: { writeCandidate: () => { writes += 1; } }
    });
    assert.equal(emptyResult.ok, false);
    assert.equal(emptyResult.error.code, 'MEMO_V2_PROMPT_SANITIZATION_EMPTY');
    assert.equal(emptyResult.stats.modelCallCount, 0);
    assert.equal(emptyResult.candidateWritten, false);
    assert.equal(emptyResult.cursorAdvanced, false);
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(emptyInput.previousState), before);
});

test('shadow CLI metrics expose sanitization counts without model, candidate, or body', async () => {
    const input = delta([
        event('cli-1', '前 [REDACTED] 后'),
        event('cli-2', '  普通  内容  \r\n\r\n 行尾空格  ')
    ]);
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
    const placeholderBearingEventCount = input.canonicalEvents.filter(item => /\[REDACTED\]/iu.test(item.text)).length;
    assert.equal(metrics.totalPromptSanitizedEventCount, placeholderBearingEventCount);
    assert.equal(metrics.totalPromptSanitizedEventCount, 1);
    assert.equal(metrics.totalPromptRedactionPlaceholderCount, 1);
    assert.ok(metrics.totalPromptSanitizationRemovedChars > 0);
    assert.equal(metrics.totalPromptWireTokenCount, 0);
    assert.equal(metrics.totalPromptNewThreadTokenCount, 0);
    assert.equal(metrics.totalPromptNoAssigneeTokenCount, 0);
    assert.deepEqual(metrics.batchPromptWireTokenCounts, [0]);
    assert.deepEqual(metrics.batchPromptNewThreadTokenCounts, [0]);
    assert.deepEqual(metrics.batchPromptNoAssigneeTokenCounts, [0]);
    assert.equal(metrics.modelCalled, false);
    assert.equal(metrics.candidateWritten, false);
    assert.doesNotMatch(output, /\[REDACTED\]|CURRENT_CANONICAL_EVENTS|eventUid|contentHash/iu);
});
