'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'Agent', name), 'utf8');
const names = [
    'Aemeath.txt', 'DeepSeekForge.txt', 'DeepSeekOfficial.txt', 'DreamNova.txt',
    'Kerr.txt', 'Lucy.txt', 'MemoMaster.txt', 'Metis.txt', 'Nova.txt',
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
        'Lucy.txt': ['{{VarUser}}', '{{VCPFileToolBox}}', '{{JevToolCall}}', '[[OneRingMemo::Lucy]]'],
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
test('Forge prompt references stay aligned with latest ProjectForge/ServerProjectForge capabilities', () => {
    const kerr = read('Kerr.txt');
    const worker = read('DeepSeekForge.txt');
    const chat = read('DeepSeekOfficial.txt');
    const fileToolBox = fs.readFileSync(path.join(__dirname, '..', 'TVStxt', 'FileToolBox.txt'), 'utf8');

    for (const token of [
        'SearchProjects', 'BeginCapture', 'GetCapture', 'FinishCapture',
        'EvalSymbol', 'RecordDelegationReview', 'GetDelegationReviews',
        'ForgeDelegation v1', '11 门主流语言'
    ]) {
        assert.ok(kerr.includes(token), `Kerr.txt: ${token}`);
    }
    assert.ok(!kerr.includes('JS/TS/TSX/Python/Rust 可按符号寻址，其余语言按文本和行范围'));

    for (const token of [
        'SearchProjects', 'BeginCapture', 'FinishCapture', 'EvalSymbol',
        'ForgeDelegation v1', 'RecordDelegationReview'
    ]) {
        assert.ok(worker.includes(token), `DeepSeekForge.txt: ${token}`);
    }

    for (const token of [
        'SearchProjects', 'BeginCapture', 'FinishCapture', 'EvalSymbol',
        'ForgeDelegation v1', 'RecordDelegationReview'
    ]) {
        assert.ok(chat.includes(token), `DeepSeekOfficial.txt: ${token}`);
    }

    for (const token of [
        'SearchProjects', 'BeginCapture', 'FinishCapture', 'EvalSymbol',
        'RecordDelegationReview', 'GetDelegationReviews', 'ForgeDelegation v1',
        '鲸鱼娘', 'forge_project_id', 'forge_todo_seq', 'forge_role',
        'query_delegation', 'cancel_delegation'
    ]) {
        assert.ok(fileToolBox.includes(token), `FileToolBox.txt: ${token}`);
    }

    for (const token of [
        '## 6. 子代理派工与协同（AgentAssistant）',
        '鲸鱼娘', 'forge_project_id', 'forge_todo_seq', 'forge_role',
        'query_delegation', 'cancel_delegation'
    ]) {
        assert.ok(kerr.includes(token), `Kerr.txt subagent: ${token}`);
    }

    const firstFoldIndex = fileToolBox.indexOf('[===vcp_fold:');
    assert.ok(firstFoldIndex > 0, 'FileToolBox.txt keeps low-frequency fold blocks');
    const alwaysOnSection = fileToolBox.slice(0, firstFoldIndex);
    for (const token of [
        '### 2. 搜索探路决策树：先定位，再读取',
        'ApplyDiff(filePath, target, replace)',
        '### 4. V工程施工速查（ProjectForge / ServerProjectForge）',
        'RecordDelegationReview',
        '### 5. 子代理派工与协同入口（AgentAssistant）'
    ]) {
        assert.ok(alwaysOnSection.includes(token), `FileToolBox always-on: ${token}`);
    }

    const zanni = read('Zanni.txt');
    for (const token of [
        '只读探路先行', '鲸鱼娘', 'forge_project_id', 'forge_todo_seq', 'forge_role',
        'query_delegation', 'cancel_delegation', 'RecordDelegationReview'
    ]) {
        assert.ok(zanni.includes(token), `Zanni.txt subagent: ${token}`);
    }
    assert.ok(!zanni.includes('DeepMemo'), 'Zanni.txt omits DeepMemo');
    assert.ok(!zanni.includes('TopicMemo'), 'Zanni.txt omits TopicMemo');

    const lucy = read('Lucy.txt');
    for (const token of [
        'ServerProjectForge', 'SearchProjects', 'EditCode', 'BeginCapture', 'FinishCapture',
        'EvalSymbol', 'RecordDelegationReview', 'GetDelegationReviews', 'ForgeDelegation v1',
        '鲸鱼娘', 'forge_project_id', 'forge_todo_seq', 'forge_role',
        'query_delegation', 'cancel_delegation'
    ]) {
        assert.ok(lucy.includes(token), `Lucy.txt: ${token}`);
    }

    const nova = read('Nova.txt');
    for (const [label, content] of [
        ['FileToolBox.txt', fileToolBox],
        ['Lucy.txt', lucy],
        ['Zanni.txt', zanni],
        ['Nova.txt', nova]
    ]) {
        assert.ok(!content.includes('AICodeWorker'), `${label} omits AICodeWorker`);
        assert.ok(!content.includes('worker=codex'), `${label} omits worker=codex`);
    }
});
