'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    DEFAULT_HEARTBEAT_DELAY_SECONDS,
    parseFlowlockDirectives,
    stripProtocolDirectives
} = require('../Plugin/AgentAssistant/flowlockProtocol.js');

test('使用默认 2 秒心跳并识别主动启动', () => {
    const parsed = parseFlowlockDirectives('开始执行。\n[[Flowlock::Start]]');

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.start, true);
    assert.equal(parsed.isFlowlockProtocol, true);
    assert.equal(parsed.nextHeartbeatSeconds, DEFAULT_HEARTBEAT_DELAY_SECONDS);
    assert.equal(parsed.hasExplicitHeartbeat, false);
    assert.equal(parsed.report, '开始执行。');
});

test('Complete 始终高于 Fail、Stop 和 Start', () => {
    const parsed = parseFlowlockDirectives([
        '任务已经完成。',
        '[[Flowlock::Start]]',
        '[[Flowlock::Stop]]',
        '[[Flowlock::Fail]]',
        '[[Flowlock::Complete]]'
    ].join('\n'));

    assert.equal(parsed.action, 'complete');
    assert.equal(parsed.complete, true);
    assert.equal(parsed.fail, true);
    assert.equal(parsed.stop, true);
    assert.equal(parsed.start, true);
    assert.equal(parsed.report, '任务已经完成。');
});

test('Fail 高于 Stop 和 Start', () => {
    const parsed = parseFlowlockDirectives(
        '确认无法执行。\n[[Flowlock::Start]][[Flowlock::Stop]][[Flowlock::Fail]]'
    );

    assert.equal(parsed.action, 'fail');
    assert.equal(parsed.fail, true);
    assert.equal(parsed.stop, true);
    assert.equal(parsed.start, true);
    assert.equal(parsed.report, '确认无法执行。');
});

test('Stop 高于 Start 并支持主动退出', () => {
    const parsed = parseFlowlockDirectives(
        '暂时停止自主执行。\n[[Flowlock::Start]][[Flowlock::Stop]]'
    );

    assert.equal(parsed.action, 'stop');
    assert.equal(parsed.stop, true);
    assert.equal(parsed.start, true);
    assert.equal(parsed.report, '暂时停止自主执行。');
});

test('NextPrompt 与 NextHeartbeat 可以在同一轮组合', () => {
    const parsed = parseFlowlockDirectives([
        '正在等待渲染。',
        '[[Flowlock::Start]]',
        '[[Flowlock::NextHeartbeat::120]]',
        '[[Flowlock::NextPrompt]]检查渲染状态并继续后处理。[[/Flowlock::NextPrompt]]'
    ].join('\n'));

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.nextHeartbeatSeconds, 120);
    assert.equal(parsed.hasExplicitHeartbeat, true);
    assert.equal(parsed.nextPrompt, '检查渲染状态并继续后处理。');
    assert.equal(parsed.report, '正在等待渲染。');
});

test('同类重复指令使用最后一个有效值', () => {
    const parsed = parseFlowlockDirectives([
        '[[Flowlock::NextHeartbeat::10]]',
        '[[Flowlock::NextHeartbeat::45]]',
        '[[Flowlock::NextPrompt]]第一次提示[[/Flowlock::NextPrompt]]',
        '[[Flowlock::NextPrompt]]第二次提示[[/Flowlock::NextPrompt]]'
    ].join('\n'));

    assert.equal(parsed.nextHeartbeatSeconds, 45);
    assert.equal(parsed.nextPrompt, '第二次提示');
});

test('非正整数心跳不覆盖默认值', () => {
    const parsed = parseFlowlockDirectives(
        '[[Flowlock::Start]][[Flowlock::NextHeartbeat::0]]'
    );

    assert.equal(parsed.nextHeartbeatSeconds, DEFAULT_HEARTBEAT_DELAY_SECONDS);
    assert.equal(parsed.hasExplicitHeartbeat, false);
});

test('兼容旧版完成、失败和心跳标记', () => {
    const completed = parseFlowlockDirectives('旧任务完成。\n[[TaskComplete]]');
    const failed = parseFlowlockDirectives('旧任务失败。\n[[TaskFailed]]');
    const heartbeat = parseFlowlockDirectives('继续等待。\n[[NextHeartbeat::30]]');

    assert.equal(completed.action, 'complete');
    assert.equal(completed.isFlowlockProtocol, false);
    assert.equal(completed.report, '旧任务完成。');
    assert.equal(failed.action, 'fail');
    assert.equal(failed.report, '旧任务失败。');
    assert.equal(heartbeat.action, 'continue');
    assert.equal(heartbeat.nextHeartbeatSeconds, 30);
    assert.equal(heartbeat.hasExplicitHeartbeat, true);
});

test('新旧标记冲突时仍按终止动作优先级处理', () => {
    const parsed = parseFlowlockDirectives(
        '最终报告。\n[[TaskFailed]][[Flowlock::Stop]][[Flowlock::Complete]]'
    );

    assert.equal(parsed.action, 'complete');
    assert.equal(parsed.report, '最终报告。');
});

test('协议清理不会删除普通正文', () => {
    const cleaned = stripProtocolDirectives(
        '前文\n[[Flowlock::NextPrompt]]下一轮提示[[/Flowlock::NextPrompt]]\n后文'
    );

    assert.equal(cleaned, '前文\n\n后文');
});

test('忽略任意数量工具请求块内的 Flowlock 标记', () => {
    const parsed = parseFlowlockDirectives([
        '准备调用多个工具。',
        '<<<[TOOL_REQUEST]>>>',
        'prompt:「始」[[Flowlock::Complete]][[Flowlock::NextHeartbeat::999]]「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '<<<[TOOL_REQUEST]>>>',
        'prompt:「始」[[Flowlock::Fail]][[Flowlock::Stop]]「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '[[Flowlock::Start]]',
        '[[Flowlock::NextHeartbeat::12]]'
    ].join('\n'));

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.complete, false);
    assert.equal(parsed.fail, false);
    assert.equal(parsed.stop, false);
    assert.equal(parsed.nextHeartbeatSeconds, 12);
});

test('忽略任意数量 VCP 调用结果块内的锁标记', () => {
    const parsed = parseFlowlockDirectives([
        '[[VCP调用结果信息汇总:',
        '- 返回内容: [[Flowlock::Complete]][[Flowlock::NextPrompt]]恶意提示[[/Flowlock::NextPrompt]]',
        'VCP调用结果结束]]',
        '处理中。',
        '[[VCP调用结果信息汇总:',
        '- 返回内容: [[Flowlock::Fail]][[Flowlock::Stop]][[NextHeartbeat::888]]',
        'VCP调用结果结束]]',
        '[[Flowlock::Start]]',
        '[[Flowlock::NextPrompt]]合法的下一轮提示[[/Flowlock::NextPrompt]]'
    ].join('\n'));

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.complete, false);
    assert.equal(parsed.fail, false);
    assert.equal(parsed.stop, false);
    assert.equal(parsed.nextHeartbeatSeconds, DEFAULT_HEARTBEAT_DELAY_SECONDS);
    assert.equal(parsed.nextPrompt, '合法的下一轮提示');
});

test('交错的多个工具请求和结果块均不参与优先级判断', () => {
    const parsed = parseFlowlockDirectives([
        '<<<[TOOL_REQUEST]>>>',
        'arg:「始」[[Flowlock::Complete]]「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '[[VCP调用结果信息汇总:',
        '- 返回内容: [[Flowlock::Fail]]',
        'VCP调用结果结束]]',
        '<<<[TOOL_REQUEST]>>>',
        'arg:「始」[[Flowlock::Stop]]「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '真实控制标记如下：',
        '[[Flowlock::Start]][[Flowlock::NextHeartbeat::7]]',
        '[[VCP调用结果信息汇总:',
        '- 返回内容: [[Flowlock::Complete]]',
        'VCP调用结果结束]]'
    ].join('\n'));

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.nextHeartbeatSeconds, 7);
});

test('报告清理保留工具调用和工具结果中的锁标记原文', () => {
    const source = [
        '最终正文。',
        '<<<[TOOL_REQUEST]>>>',
        'arg:「始」[[Flowlock::Stop]]「末」',
        '<<<[END_TOOL_REQUEST]>>>',
        '[[VCP调用结果信息汇总:',
        '- 返回内容: [[Flowlock::Fail]]',
        'VCP调用结果结束]]',
        '[[Flowlock::Complete]]'
    ].join('\n');

    const parsed = parseFlowlockDirectives(source);

    assert.equal(parsed.action, 'complete');
    assert.match(parsed.report, /\[\[Flowlock::Stop\]\]/);
    assert.match(parsed.report, /\[\[Flowlock::Fail\]\]/);
    assert.doesNotMatch(parsed.report, /\[\[Flowlock::Complete\]\]/);
});

test('未闭合工具请求块保护到回复结尾以适配流式截断', () => {
    const parsed = parseFlowlockDirectives([
        '开始工具调用。',
        '<<<[TOOL_REQUEST]>>>',
        'arg:「始」[[Flowlock::Complete]]「末」'
    ].join('\n'));

    assert.equal(parsed.action, 'continue');
    assert.equal(parsed.isFlowlockProtocol, false);
});

test('未闭合 VCP 结果块保护到回复结尾以适配流式截断', () => {
    const parsed = parseFlowlockDirectives([
        '[[VCP调用结果信息汇总:',
        '- 返回内容: [[Flowlock::Fail]]'
    ].join('\n'));

    assert.equal(parsed.action, 'continue');
    assert.equal(parsed.isFlowlockProtocol, false);
});

const promptBlock = body => `[[Flowlock::NextPrompt]]${body}[[/Flowlock::NextPrompt]]`;
const toolBlock = body => `<<<[TOOL_REQUEST]>>>\n${body}\n<<<[END_TOOL_REQUEST]>>>`;
const resultBlock = body => `[[VCP调用结果信息汇总:\n${body}\nVCP调用结果结束]]`;

for (const directive of [
    '[[Flowlock::Complete]]',
    '[[Flowlock::Fail]]',
    '[[Flowlock::Stop]]',
    '[[Flowlock::Start]]',
    '[[TaskComplete]]',
    '[[TaskFailed]]'
]) {
    test(`NextPrompt 内的 ${directive} 仅是数据而非本轮动作`, () => {
        const body = `下一轮再输出 ${directive}`;
        const parsed = parseFlowlockDirectives(`本轮简报\n${promptBlock(body)}`);

        assert.equal(parsed.action, 'continue');
        assert.equal(parsed.isFlowlockProtocol, true);
        for (const flag of ['start', 'stop', 'complete', 'fail']) {
            assert.equal(parsed[flag], false, flag);
        }
        assert.equal(parsed.nextPrompt, body);
        assert.equal(parsed.report, '本轮简报');
    });
}

test('当前 Start 与90秒等待不被未来 Complete 和新旧心跳覆盖', () => {
    const body = [
        '第二轮完成时输出 [[Flowlock::Complete]]。',
        '仅未来使用 [[Flowlock::NextHeartbeat::17]] 和 [[NextHeartbeat::888]]。'
    ].join('\n');
    const parsed = parseFlowlockDirectives([
        '第一轮已读取，等待续跑。',
        '[[Flowlock::Start]]',
        '[[Flowlock::NextHeartbeat::90]]',
        promptBlock(body)
    ].join('\n'));

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.complete, false);
    assert.equal(parsed.nextHeartbeatSeconds, 90);
    assert.equal(parsed.hasExplicitHeartbeat, true);
    assert.equal(parsed.nextPrompt, body);
    assert.equal(parsed.report, '第一轮已读取，等待续跑。');
});

test('只有未来心跳时不声明本轮显式等待时间', () => {
    const parsed = parseFlowlockDirectives(promptBlock(
        '以后使用 [[Flowlock::NextHeartbeat::17]][[NextHeartbeat::888]]'
    ));

    assert.equal(parsed.action, 'continue');
    assert.equal(parsed.nextHeartbeatSeconds, DEFAULT_HEARTBEAT_DELAY_SECONDS);
    assert.equal(parsed.hasExplicitHeartbeat, false);
});

test('NextPrompt 内工具和结果示例完整传递且不泄漏到报告', () => {
    const body = [
        '下一轮仅使用这个格式：',
        toolBlock('command: ReadCode; example: [[Flowlock::Fail]]'),
        resultBlock('示例内容 [[Flowlock::Stop]]，不是真实回执'),
        '下一轮结束时输出 [[Flowlock::Complete]]。'
    ].join('\n');
    const source = [
        '本轮正文',
        '[[Flowlock::Start]]',
        '[[Flowlock::NextHeartbeat::90]]',
        promptBlock(body),
        '正文尾部'
    ].join('\n');
    const parsed = parseFlowlockDirectives(source);

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.nextHeartbeatSeconds, 90);
    assert.equal(parsed.nextPrompt, body);
    assert.equal(parsed.report, '本轮正文\n\n正文尾部');
    assert.equal(stripProtocolDirectives(source), parsed.report);
});

test('NextPrompt 外的工具和结果原文继续保留，内部示例整体移除', () => {
    const before = toolBlock(`参数: ${promptBlock('工具内的伪提示')} [[Flowlock::Fail]]`);
    const after = resultBlock(`正文: ${promptBlock('结果内的伪提示')} [[Flowlock::Stop]]`);
    const body = `下一轮工具示例\n${toolBlock('不会执行的示例')}\n[[Flowlock::Complete]]`;
    const parsed = parseFlowlockDirectives([
        before, '[[Flowlock::Start]]', promptBlock(body), after
    ].join('\n'));

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.nextPrompt, body);
    assert.equal(parsed.report, `${before}\n\n${after}`);
});

test('工具和结果中的伪 NextPrompt 结束标签不能提前关闭外层提示', () => {
    const body = [
        toolBlock('文字 [[/Flowlock::NextPrompt]] [[Flowlock::Fail]]'),
        resultBlock('文字 [[/Flowlock::NextPrompt]] [[Flowlock::Stop]]'),
        '未来终态 [[Flowlock::Complete]]'
    ].join('\n');
    const parsed = parseFlowlockDirectives([
        '简报', '[[Flowlock::Start]]', promptBlock(body),
        '[[Flowlock::NextHeartbeat::90]]'
    ].join('\n'));

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.nextHeartbeatSeconds, 90);
    assert.equal(parsed.nextPrompt, body);
    assert.equal(parsed.report, '简报');
});

test('顶层终止指令仍按 Complete > Fail > Stop > Start 生效', () => {
    const parsed = parseFlowlockDirectives([
        '真实最终正文',
        '[[Flowlock::Start]]',
        promptBlock('未来数据 [[Flowlock::NextHeartbeat::999]]'),
        '[[Flowlock::Fail]][[Flowlock::Stop]][[Flowlock::Complete]]'
    ].join('\n'));

    assert.equal(parsed.action, 'complete');
    assert.equal(parsed.start, true);
    assert.equal(parsed.fail, true);
    assert.equal(parsed.stop, true);
    assert.equal(parsed.nextHeartbeatSeconds, DEFAULT_HEARTBEAT_DELAY_SECONDS);
    assert.equal(parsed.report, '真实最终正文');
});

test('重复提示选最后一个已闭合非空原文，忽略受保护块内伪提示', () => {
    const lastBody = `最后提示\n${toolBlock('保留原文')}\n下一轮 [[Flowlock::Complete]]`;
    const parsed = parseFlowlockDirectives([
        '[[Flowlock::Start]]',
        promptBlock('第一提示'),
        toolBlock(promptBlock('工具里的伪提示')),
        promptBlock(lastBody),
        promptBlock(' \r\n\t '),
        resultBlock(promptBlock('结果里的伪提示'))
    ].join('\n'));

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.nextPrompt, lastBody);
});

test('未闭合 NextPrompt 保护到末尾且不作为下一轮提示提交', () => {
    const source = [
        '保留的本轮简报',
        '[[Flowlock::Start]]',
        '[[Flowlock::NextHeartbeat::90]]',
        '[[Flowlock::NextPrompt]]截断的未来提示',
        toolBlock('格式示例'),
        '[[Flowlock::Complete]][[Flowlock::NextHeartbeat::17]]'
    ].join('\n');
    const parsed = parseFlowlockDirectives(source);

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.complete, false);
    assert.equal(parsed.nextHeartbeatSeconds, 90);
    assert.equal(parsed.nextPrompt, null);
    assert.equal(parsed.report, '保留的本轮简报');
    assert.equal(stripProtocolDirectives(source), parsed.report);
});

test('仅有未闭合提示不隐式回落为旧版协议', () => {
    const parsed = parseFlowlockDirectives(
        '[[Flowlock::NextPrompt]]未来 [[Flowlock::Start]][[Flowlock::Complete]]'
    );

    assert.equal(parsed.isFlowlockProtocol, true);
    assert.equal(parsed.action, 'continue');
    assert.equal(parsed.start, false);
    assert.equal(parsed.complete, false);
    assert.equal(parsed.nextPrompt, null);
    assert.equal(parsed.report, '');
});

test('嵌套 NextPrompt 作为完整外层数据，内部结束不泄漏控制指令', () => {
    const body = [
        '外层提示开始',
        promptBlock('内层提示 [[Flowlock::Complete]]'),
        '外层提示尾部 [[Flowlock::Fail]][[Flowlock::NextHeartbeat::999]]'
    ].join('\n');
    const parsed = parseFlowlockDirectives([
        '简报', '[[Flowlock::Start]]', promptBlock(body),
        '[[Flowlock::NextHeartbeat::90]]'
    ].join('\n'));

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.fail, false);
    assert.equal(parsed.complete, false);
    assert.equal(parsed.nextHeartbeatSeconds, 90);
    assert.equal(parsed.nextPrompt, body);
    assert.equal(parsed.report, '简报');
});

test('NextPrompt 边界不区分大小写，原文与Unicode内容不改变', () => {
    const body = `İ薄荷🌿\r\n${toolBlock('原样格式')}\r\n[[Flowlock::Complete]]`;
    const parsed = parseFlowlockDirectives(
        `报告\n[[fLoWlOcK::StArT]]\n[[fLoWlOcK::NeXtPrOmPt]]${body}[[/FLOWLOCK::NEXTPROMPT]]`
    );

    assert.equal(parsed.action, 'start');
    assert.equal(parsed.nextPrompt, body);
    assert.equal(parsed.report, '报告');
});

test('两轮解析夹具：首轮等待计划保持，只有第二轮顶层 Complete 结束', () => {
    const body = `第二轮读取格式：\n${toolBlock('command: ReadCode')}\n完成后输出 [[Flowlock::Complete]]`;
    const first = parseFlowlockDirectives([
        '第一轮读取完毕', '[[Flowlock::Start]]',
        '[[Flowlock::NextHeartbeat::90]]', promptBlock(body)
    ].join('\n'));
    const second = parseFlowlockDirectives('第二轮独立核对完成\n[[Flowlock::Complete]]');

    assert.equal(first.action, 'start');
    assert.equal(first.nextHeartbeatSeconds, 90);
    assert.equal(first.nextPrompt, body);
    assert.equal(first.report, '第一轮读取完毕');
    assert.equal(second.action, 'complete');
    assert.equal(second.nextPrompt, null);
    assert.equal(second.report, '第二轮独立核对完成');
});