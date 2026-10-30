'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatToolResultBatch, projectToolBatchForUpstream } = require('../modules/toolResultBatch');
const matcher = require('../modules/vcpLoop/toolMarkerFuzzyMatcher');
const mark = name => '<'.repeat(3) + '[' + name + ']' + '>'.repeat(3);
const escapeStart = '\u300c\u59cbESCAPE\u300d';
const escapeEnd = '\u300c\u672bESCAPE\u300d';
const quoted = formatToolResultBatch(['literal fixture']);
const request = content => `${mark('TOOL_REQUEST')}\ntool_name:\u300c\u59cb\u300dExample\u300c\u672b\u300d\ncontent:${escapeStart}${content}${escapeEnd}\n${mark('END_TOOL_REQUEST')}`;
const receipt = content => '[[' + 'VCP调用结果信息汇总:\n' + content + '\nVCP调用结果结束]]';
const project = (content, role = 'assistant') =>
    projectToolBatchForUpstream({ messages: [{ role, content }] }).messages[0].content;
const fixtures = [
    ['ESCAPE parameter', request(quoted)],
    ['ESCAPE embedded end marker', request(mark('END_TOOL_REQUEST') + quoted)],
    ['backtick fence', '```text\n' + quoted + '\n```'],
    ['long fence with inner short fence', '````text\n```\n' + quoted + '\n````'],
    ['tilde fence', '~~~text\n' + quoted + '\n~~~'],
    ['CRLF fence', ('```text\n' + quoted + '\n```').replace(/\r?\n/g, '\r\n')],
    ['inline code span', 'Example: `' + quoted + '` end'],
    ['double tick span', 'Example: ``one ` ' + quoted + '`` end'],
    ['legacy receipt', receipt(quoted)],
    ['nested legacy receipts', receipt(receipt(quoted) + quoted)],
    ['legacy summary', '[本轮工具调用摘要:]\n' + quoted + '\n[本轮工具调用摘要结束]'],
    ['blockquote', quoted.split('\n').map(line => '> ' + line).join('\n')],
    ['indented documentation', quoted.split('\n').map(line => '    ' + line).join('\n')]
];
for (const [label, literal] of fixtures) {
    test(`projection preserves ${label} and still converts a following real wrapper`, () => {
        for (const role of ['assistant', 'user']) {
            assert.equal(project(literal, role), literal);
            const live = formatToolResultBatch(['actual result']);
            const input = literal + '\n' + live;
            const output = project(input, role);
            assert.ok(output.startsWith(literal + '\n'), 'literal prefix must remain byte-for-byte');
            assert.equal((output.match(/【工具返回批次开始｜时间：/g) || []).length, 1);
            assert.equal((output.match(/【工具返回批次结束｜时间：/g) || []).length, 1);
            assert.ok(output.includes('actual result'));
            assert.equal(project(output, role), output, 'projection remains idempotent');
        }
    });
}
for (const [label, prefix] of [
    ['unfinished tool', mark('TOOL_REQUEST') + '\ncontent:' + escapeStart],
    ['unfinished code fence', '```text\n'],
    ['unfinished inline span', '`'],
    ['unfinished legacy receipt', '[[' + 'VCP调用结果信息汇总:\n'],
    ['unfinished summary', '[本轮工具调用摘要:]\n']
]) {
    test(`projection leaves ${label} opaque through EOF`, () => {
        const input = prefix + quoted;
        assert.equal(project(input), input);
    });
}
test('earlier real batch shields unfinished syntax in its body, without hiding later batches', () => {
    const payload = '```text\n' + request(quoted) + '\n' + mark('TOOL_REQUEST') + escapeStart;
    const first = formatToolResultBatch([payload]);
    const second = formatToolResultBatch(['second real result']);
    const output = project(first + second);
    assert.ok(output.includes(payload), 'outer payload is not inspected or altered');
    assert.equal((output.match(/【工具返回批次开始｜时间：/g) || []).length, 2);
    assert.equal(project(output), output);
});
test('single-text multimodal literals keep media, custom fields and original messages', () => {
    const image = { type: 'image_url', image_url: { url: 'https://example.invalid/fixture.png' } };
    const content = [{ type: 'text', text: request(quoted) + formatToolResultBatch(['real']), custom: 1 }, image];
    const snapshot = JSON.stringify(content);
    const output = project(content);
    assert.ok(output[0].text.startsWith(request(quoted)));
    assert.equal((output[0].text.match(/【工具返回批次开始｜时间：/g) || []).length, 1);
    assert.equal(output[1], image);
    assert.equal(output[0].custom, 1);
    assert.equal(JSON.stringify(content), snapshot);
});
test('fuzzy request boundaries reuse the configured tool matcher', () => {
    const previous = { enabled: matcher.enabled, debugMode: matcher.debugMode };
    try {
        matcher.configure({ enabled: true });
        const literal = request(quoted).replace(mark('TOOL_REQUEST'), '<<[TOOL_REQUEST]>>')
            .replace(mark('END_TOOL_REQUEST'), '<<[END_TOOL_REQUEST]>>');
        assert.equal(project(literal), literal);
        const output = project(literal + formatToolResultBatch(['real']));
        assert.ok(output.startsWith(literal));
        assert.equal((output.match(/【工具返回批次开始｜时间：/g) || []).length, 1);
    } finally {
        matcher.configure(previous);
    }
});
test('no-op projection returns the original frozen request and message array', () => {
    const messages = Object.freeze([
        Object.freeze({ role: 'system', content: 'policy' }),
        Object.freeze({ role: 'assistant', content: request(quoted) }),
        Object.freeze({ role: 'tool', content: quoted })
    ]);
    const body = Object.freeze({ model: 'fixture', messages });
    assert.strictEqual(projectToolBatchForUpstream(body), body);
    assert.strictEqual(projectToolBatchForUpstream(body).messages, messages);
});
test('changed projection copies only affected messages and preserves array metadata', () => {
    const meta = Object.freeze({ turn: 'fixture' });
    const symbol = Symbol('request metadata');
    const first = Object.freeze({ role: 'system', content: 'policy' });
    const second = Object.freeze({ role: 'user', content: formatToolResultBatch(['real'], false) });
    const messages = [first, second];
    Object.defineProperty(messages, '__oneRingMeta', { value: meta });
    Object.defineProperty(messages, symbol, { value: meta });
    Object.freeze(messages);
    const body = Object.freeze({ model: 'fixture', messages });
    const output = projectToolBatchForUpstream(body);
    assert.notStrictEqual(output, body);
    assert.notStrictEqual(output.messages, messages);
    assert.strictEqual(output.messages[0], first);
    assert.notStrictEqual(output.messages[1], second);
    assert.strictEqual(output.messages.__oneRingMeta, meta);
    assert.strictEqual(output.messages[symbol], meta);
    assert.deepEqual(Object.getOwnPropertyDescriptor(output.messages, '__oneRingMeta'),
        Object.getOwnPropertyDescriptor(messages, '__oneRingMeta'));
    assert.ok(second.content.includes(mark('VCP_TOOL_BATCH_START:').slice(0, -4)));
    assert.ok(output.messages[1].content.includes('【工具返回批次开始｜时间：'));
    assert.strictEqual(projectToolBatchForUpstream(output), output);
});