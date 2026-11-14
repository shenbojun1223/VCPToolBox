'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate the unchanged production class without its imports or singleton
// constructor. The sandbox has no require, fetch, timers, DB or network clients.
// This tests the real methods while avoiding SemanticGroupManager.initialize().
const source = fs.readFileSync(
    path.join(__dirname, '../Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js'), 'utf8');
const classStart = source.indexOf('class RAGDiaryPlugin {');
const exportStart = source.lastIndexOf('// 导出实例以供 Plugin.js 加载');
assert(classStart >= 0 && exportStart > classStart, 'production class boundaries changed');
assert.match(source.slice(exportStart), /module\.exports = new RAGDiaryPlugin\(\);/);
const sandbox = {
    console: Object.freeze({ log() {}, warn() {}, error() {} })
};
const rag = vm.runInNewContext(
    source.slice(classStart, exportStart) + '\nRAGDiaryPlugin.prototype;',
    sandbox,
    { filename: 'RAGDiaryPlugin.production-class.js', timeout: 5000 }
);

const DOLLAR = String.fromCharCode(36);
const tokens = [DOLLAR + DOLLAR, DOLLAR + '&', DOLLAR + '`',
    DOLLAR + "'", DOLLAR + '1', DOLLAR + '99', DOLLAR + '<name>'];
const privateSlot = '[[Private日记本]]';
const publicSlot = '[[Public日记本]]';
const template = `HEAD\nprivate=${privateSlot}\npublic=${publicSlot}\nSYNTHETIC_TAIL`;
const count = (text, needle) => text.split(needle).length - 1;
const wrap = (name, text) =>
    `<!-- VCP_RAG_BLOCK_START {"dbName":"${name}"} -->\n${text}\n<!-- VCP_RAG_BLOCK_END -->`;

function host(resolve) {
    const instance = Object.create(rag);
    instance.pushVcpInfo = () => {};
    instance.tdbProcessor = null;
    instance._evaluateRoleValve = () => true;
    instance._processRAGPlaceholder = ({ dbName }) => resolve(dbName);
    instance._processAggregateRetrieval = ({ diaryNames }) => resolve(diaryNames.join('|'));
    return instance;
}

function inject(instance, text) {
    // Real production parser + task assembly + Promise.all + replacement loop.
    // Only upstream retrieval is stubbed: no DB, embeddings, model or network.
    return instance._processSingleSystemMessage(
        text, [1, 0], 'synthetic query', '', 'synthetic query',
        7, [], new Set(), false
    );
}

for (const token of tokens) {
    test(`retrieved text is literal: ${JSON.stringify(token)}`, async () => {
        const payload = `body [${token}] 中文🙂`;
        const result = await inject(host(async () => payload), `PREFIX ${privateSlot} SUFFIX`);
        assert.equal(result, `PREFIX ${payload} SUFFIX`);
    });
}

test('five suffix tokens cannot copy the template tail or nest public memory', async () => {
    // Synthetic equivalent of the incident diary: five replacement metacharacters.
    const body = `replace notes: ${Array(5).fill(DOLLAR + "'").join(' / ')}`;
    const privateBody = wrap('Private', body);
    const publicBody = wrap('Public', 'public result');
    const result = await inject(host(async name =>
        name === 'Private' ? privateBody : publicBody), template);
    assert.equal(result, `HEAD\nprivate=${privateBody}\npublic=${publicBody}\nSYNTHETIC_TAIL`);
    assert.equal(count(result, publicSlot), 0);
    assert.equal(count(result, 'SYNTHETIC_TAIL'), 1);
    assert.deepEqual([...result.matchAll(/VCP_RAG_BLOCK_(START|END)/g)].map(m => m[1]),
        ['START', 'END', 'START', 'END']);
    assert(result.includes(body));
});

test('both replacement bodies retain all metacharacters without reinterpreting either', async () => {
    const a = tokens.join(' | ');
    const b = `public ${tokens.slice().reverse().join(' / ')}`;
    const result = await inject(host(async name => name === 'Private' ? a : b), template);
    assert.equal(result, `HEAD\nprivate=${a}\npublic=${b}\nSYNTHETIC_TAIL`);
});

test('aggregate plus public path uses literal insertion too', async () => {
    const a = wrap('A|B', tokens.join(' '));
    const b = wrap('Public', 'ordinary public memory');
    const result = await inject(host(async name => name === 'A|B' ? a : b),
        'before [[A|B日记本::Jev+::Time::Group::RiverMemo::Truncate0.35]] middle [[Public日记本]] after');
    assert.equal(result, `before ${a} middle ${b} after`);
});

test('reverse async completion does not change placeholder order or literal text', async () => {
    const completed = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const a = `private ${DOLLAR}'`;
    const b = `public ${DOLLAR}&`;
    const instance = host(async name => {
        if (name === 'Private') {
            await gate;
            completed.push(name);
            return a;
        }
        completed.push(name);
        release();
        return b;
    });
    const result = await inject(instance, template);
    assert.deepEqual(completed, ['Public', 'Private']);
    assert.equal(result, `HEAD\nprivate=${a}\npublic=${b}\nSYNTHETIC_TAIL`);
});

test('mixed direct and RAG results are literal at the shared insertion point', async () => {
    const a = tokens.join(' ');
    const b = `direct ${DOLLAR}'`;
    const instance = host(async () => a);
    instance.directDiaryTextProcessor = { processContent: async () => b };
    const result = await inject(instance, '[[Private日记本]] / {{Direct日记本}} / tail');
    assert.equal(result, `${a} / ${b} / tail`);
});

test('meta thinking result cannot expand replacement metacharacters', async () => {
    const payload = tokens.join(' ');
    const instance = host(async () => 'unused');
    instance.metaThinkingManager = { processMetaThinkingChain: async () => payload };
    assert.equal(await inject(instance, 'before [[VCP元思考]] after'), `before ${payload} after`);
});

test('cold knowledge result uses the same literal merge contract', async () => {
    const payload = tokens.join(' ');
    const instance = host(async () => 'unused');
    instance.tdbProcessor = {
        isEnabled: () => true,
        isDiaryPlaceholderAmbiguity: () => false,
        processDirect: async () => payload
    };
    assert.equal(await inject(instance, 'before [[Cold知识库]] after'), `before ${payload} after`);
});

for (const [label, value, expected] of [
    ['null', null, ''], ['undefined', undefined, ''], ['empty', '', ''],
    ['number', 42, '42'], ['plain', 'ordinary memory', 'ordinary memory']
]) {
    test(`existing content normalization remains unchanged: ${label}`, async () => {
        assert.equal(await inject(host(async () => value), `before ${privateSlot} after`),
            `before ${expected} after`);
    });
}

test('unrequested placeholder-looking text remains data', async () => {
    const payload = `document example [[NotRequested日记本]] ${DOLLAR}&`;
    const calls = [];
    const result = await inject(host(async name => { calls.push(name); return payload; }),
        `before ${privateSlot} after`);
    assert.equal(result, `before ${payload} after`);
    assert.deepEqual(calls, ['Private']);
});

test('plain text without declarations is not changed', async () => {
    const instance = host(async () => { throw new Error('unexpected retrieval'); });
    const text = `literal ${tokens.join(' ')} and ordinary text`;
    assert.equal(await inject(instance, text), text);
});