'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'Agent', name), 'utf8');
const names = [
    'Aemeath.txt', 'DeepSeekForge.txt', 'DeepSeekOfficial.txt', 'DreamNova.txt',
    'Kerr.txt', 'MemoMaster.txt', 'Metis.txt', 'Nova.txt',
    'ThemeMaidCoco.txt', 'Weiming.txt', 'Zanni.txt'
];

// Read prompt templates as inert text. Never expand placeholders or execute examples.
test('personal prompt templates are lossless UTF-8 without merge markers', () => {
    for (const name of names) {
        const bytes = fs.readFileSync(path.join(__dirname, '..', 'Agent', name));
        const text = bytes.toString('utf8');
        assert.ok(bytes.equals(Buffer.from(text, 'utf8')), name);
        assert.doesNotMatch(text, /^(<<<<<<< |>>>>>>> )/m, name);
    }
});

test('both DeepSeek personas are explicitly admitted by the Agent allowlist', () => {
    const rules = read('.gitignore').split(/\r?\n/);
    assert.ok(rules.includes('!DeepSeekOfficial.txt'));
    assert.ok(rules.includes('!DeepSeekForge.txt'));
});

test('chat and construction personas keep distinct entry points', () => {
    const chat = read('DeepSeekOfficial.txt');
    const worker = read('DeepSeekForge.txt');
    assert.ok(chat.includes('{{VarUser}}'));
    assert.ok(!chat.includes('{{VarUse}}'));
    assert.ok(chat.includes('deepseekmemochat'));
    assert.ok(worker.includes('DeepSeekForge'));
    assert.ok(worker.includes('允许修改文件白名单'));
    assert.ok(worker.includes('delegationId'));
    assert.ok(worker.includes('session_id'));
    assert.ok(worker.includes('严禁再次调用 `AgentAssistant`'));
    assert.ok(worker.includes('「始」'));
});

test('Kerr keeps personal knowledge, shared memory and read-only timeline references', () => {
    const text = read('Kerr.txt');
    for (const token of [
        '# Role: Kerr', '{{VarHome}}', '[[ContextFoldingV2]]',
        'Kerr|Kerr的知识日记本::Jev+', '公共日记本::Jev+',
        '[[OneRingMemo::Kerr]]', '{{VarForum}}', '{{VCPForumLister}}'
    ]) assert.ok(text.includes(token), token);
    assert.ok(text.includes('不替代当前任务授权'));
});

test('memory persona retains its own index and the actual shared index', () => {
    const text = read('MemoMaster.txt');
    assert.ok(text.includes('记忆大师日记本::Jev+'));
    assert.ok(text.includes('公共日记本::Jev+'));
    assert.ok(text.includes('[[OneRingMemo::记忆大师]]'));
    assert.ok(text.includes('ink:「始」mark_history「末」）。'));
    assert.ok(!text.includes('[公共的日常]'));
});

for (const name of ['Nova.txt', 'Zanni.txt']) {
    test(`${name} separates file batching from Forge numbered edit steps`, () => {
        const text = read(name);
        assert.ok(text.includes('FileOperator 的 command1/command2 批处理须以插件契约为准'));
        assert.ok(text.includes('ProjectForge/ServerProjectForge 跨命令独立调用'));
        assert.ok(text.includes('只有 EditCode 内部使用 op1/op2 编号步骤'));
        assert.ok(text.includes('同文件写入和有依赖操作必须串行'));
        assert.ok(!text.includes('`FileOperator` / `ProjectForge` 的 `command1/command2`'));
    });
}

for (const name of ['Nova.txt', 'Weiming.txt', 'Zanni.txt']) {
    test(`${name} excludes same-backend restart from VCPSleep waiting`, () => {
        const text = read(name);
        assert.ok(text.includes('不得用 VCPSleep 等待承载当前对话的 vcp-main 重启'));
        assert.ok(text.includes('由独立维护步骤执行重启'));
        assert.ok(text.includes('唤醒后先核验进程与服务状态'));
    });
}

test('local recall modifiers and research/tool entry points remain present', () => {
    const expectations = {
        'Aemeath.txt': ['爱弥斯|爱弥斯的日常日记本::Jev+', '爱弥斯的知识日记本::Jev+'],
        'DreamNova.txt': ['Nova的梦日记本::Jev+'],
        'Metis.txt': ['{{VarUser}}', '{{VCPFileToolBox}}', '{{JevToolCall}}', '[[OneRingMemo::Metis]]'],
        'Nova.txt': ['{{VCPFileToolBox}}', '{{JevToolCall}}', '[[OneRingMemo::Nova]]'],
        'Weiming.txt': ['微明的知识日记本::Jev+', '{{VCPFileToolBox}}', '{{JevToolCall}}'],
        'Zanni.txt': ['赞妮的日常|赞妮的知识|赞妮的任务日记本::Jev+', '{{WindowSensor_Node}}'],
        'ThemeMaidCoco.txt': ['command=ExecutePowerShell', 'ServerPowerShellExecutor']
    };
    for (const [name, tokens] of Object.entries(expectations)) {
        const text = read(name);
        for (const token of tokens) assert.ok(text.includes(token), `${name}: ${token}`);
    }
});
