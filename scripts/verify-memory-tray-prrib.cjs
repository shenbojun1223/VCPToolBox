'use strict';

// Deployment-local acceptance fixture. No network, CLI session, or production DB.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const backup = path.join(root, 'backups/memory-tray-prrib-20261030');
const bridge = 'C:/VCP/ClaudeBridge/releases/d973751985-sonnet-r1';
const tray = require('../Plugin/MemoryThinkingTray/MemoryThinkingTray');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const START = '<---VCP记忆思维区Start--->', END = '<---VCP记忆思维区End--->';

function fixtureText(template, variant) {
    return template
        .replace(/\{\{TarSysPrompt\}\}/g, `DYNAMIC_ENV_${variant}`)
        .replace(/\{\{(?:Date|Time|Today|Festival|VCPWeatherInfoNow|VCPForumLister)\}\}/g,
            `DYNAMIC_FACT_${variant}`)
        .replace(/\{\{USER_AUTH_CODE\}\}/g, `DYNAMIC_AUTH_FIXTURE_${variant}`);
}
function mockRag(text, variant) {
    return text
        .replace(/\[\[[^\]\r\n]*日记本[^\]\r\n]*\]\]|<<[^>\r\n]*日记本[^>\r\n]*>>|《《[^》\r\n]*日记本[^》\r\n]*》》|\{\{[^}\r\n]*日记本[^}\r\n]*\}\}/g,
            `<!-- VCP_RAG_BLOCK_START -->DYNAMIC_RAG_${variant}<!-- VCP_RAG_BLOCK_END -->`)
        .replace(/\[\[VCP元思考[^\]\r\n]*\]\]/g, `DYNAMIC_THINKING_${variant}`);
}
function fixtureMemo(variant) {
    const filename = path.join(root, 'Plugin/OneRing/OneRingMemo.js');
    const localRequire = createRequire(filename);
    const sandbox = {
        module: { exports: {} }, __dirname: path.dirname(filename), console, process,
        require(name) {
            if (name === './OneRingDB.js') return {};
            if (name === 'fs') return {
                readFileSync() { return JSON.stringify({ summary: `DYNAMIC_MEMO_${variant}` }); }
            };
            return localRequire(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox.module.exports;
}
(async () => {
    const { mapChatRequest } = await import('file:///' + bridge + '/src/messages.js');
    const { buildEnvelope } = await import('file:///' + bridge + '/src/envelope.js');
    const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'candidate-manifest.json'), 'utf8'));
    const cases = [], reports = [];
    for (const record of manifest.records) {
        const template = fs.readFileSync(path.join(backup, record.candidate), 'utf8');
        assert.equal(hash(template), record.after);
        const systems = [];
        for (const variant of ['A', 'B']) {
            const system = fixtureText(template + '\n' + START + '验证码：{{USER_AUTH_CODE}}' + END, variant);
            const source = [
                { role: 'system', content: system },
                { role: 'user', content: 'previous question' },
                { role: 'assistant', content: 'previous answer' },
                { role: 'user', content: 'current question' }
            ];
            let messages = await tray.processMessages(source, {
                MEMORY_THINKING_TRAY_DEPTH: 1, MEMORY_THINKING_TRAY_CACHE_BREAKPOINT: false
            });
            messages = messages.map(m => ({ ...m, content: mockRag(m.content, variant) }));
            messages = fixtureMemo(variant).injectMemo(messages);
            assert.equal(messages.length, 5);
            assert.equal(messages.at(-1).content, 'current question');
            assert.ok(messages.every(m => typeof m.content === 'string'));
            const serial = JSON.stringify(messages);
            assert.ok(!serial.includes('VCP_TRAY_MEMO:'));
            assert.ok(!serial.includes(START) && !serial.includes(END));
            assert.ok(!serial.includes('[[OneRingMemo::'));
            assert.ok(!serial.includes('cache_control'));
            assert.ok(!messages[0].content.includes('DYNAMIC_'), record.file + ': dynamic value left in system');
            assert.ok(messages[3].content.includes('DYNAMIC_AUTH_FIXTURE_' + variant));
            const mapped = mapChatRequest({ model: 'claude-vcp-opus', messages }, { model: 'claude-vcp-opus' });
            assert.equal(mapped.lastUserContent, 'current question');
            const envelope = buildEnvelope({ system: mapped.system, history: mapped.history, requestId: 'offline-prrib' });
            cases.push({ file: record.file, variant, envelope });
            systems.push(messages[0].content);
        }
        assert.equal(systems[0], systems[1], record.file + ': system changed between fixture times');
        reports.push({ file: record.file, blocks: record.blocks, systemStable: true, opusMapperAccepted: true });
    }

    // Compile only five pure functions and three constants from the runner AST.
    // Protocol I/O/SSH/process lifecycle is never imported or executed.
    const python = String.raw`
import ast, hashlib, json, re, sys, types
source = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(source)
functions = {"_core_without_rag", "_rag_only_for_wire", "_normalize_history_turns",
             "compact_envelope_for_cli", "build_system_prompt"}
constants = {"SYSTEM_PROMPT", "MAX_CLI_SYSTEM_CHARS", "MAX_CLI_SYSTEM_BYTES"}
nodes = [n for n in tree.body if
         (isinstance(n, ast.FunctionDef) and n.name in functions) or
         (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in constants for t in n.targets))]
assert len(nodes) == len(functions) + len(constants)
def safe_text(s):
    assert isinstance(s, str) and "\x00" not in s
class ProtocolError(Exception):
    pass
P = types.SimpleNamespace(
    ProtocolError=ProtocolError, assert_safe_text=safe_text,
    utf16_length=lambda s: len(s.encode("utf-16-le")) // 2,
    sha256_hex=lambda s: hashlib.sha256(s.encode("utf-8")).hexdigest())
ns = {"P": P, "json": json, "re": re}
exec(compile(ast.Module(body=nodes, type_ignores=[]), "<runner-pure-functions>", "exec"), ns)
previous, result = {}, []
for case in json.load(sys.stdin):
    native = ns["build_system_prompt"](case["envelope"])
    assert "DYNAMIC_" not in native
    compact, digest, pairs = ns["compact_envelope_for_cli"](case["envelope"])
    assert "DYNAMIC_AUTH_FIXTURE_" + case["variant"] in compact
    assert "current question" in compact
    assert len(pairs) == 2
    assert all("DYNAMIC_" not in p["content"] for p in pairs)
    if case["file"] in previous:
        assert previous[case["file"]] == native
    previous[case["file"]] = native
    result.append({"file": case["file"], "variant": case["variant"],
                   "nativeSystemChars": len(native), "resumeMessages": len(pairs),
                   "dynamicOnlyInLiveTail": True})
print(json.dumps(result))
`;
    const run = spawnSync(process.env.PYTHON || 'python', ['-c', python, bridge + '/remote/pty_runner.py'], {
        input: JSON.stringify(cases), encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    assert.equal(run.status, 0, 'runner pure-function check failed: ' + (run.error?.message || run.stderr));
    const result = {
        checkedAt: new Date().toISOString(),
        scope: 'synthetic variables/RAG/memos; real tray, memo injection, Opus map/envelope and extracted runner pure functions; not live/remote validation',
        reports, runner: JSON.parse(run.stdout)
    };
    fs.writeFileSync(path.join(backup, 'candidate-acceptance.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
});