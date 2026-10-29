'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = path.resolve(__dirname, '../Plugin/OneRing/OneRing.js');
const localRequire = createRequire(filename);
const fuzzy = localRequire('./OneRingFuzzy.js');
const common = localRequire('./OneRingTimelineCommon.js');
const timeline = localRequire('./OneRingServerInferredTimeline.js');
const task = '[系统提示:][VCHAT上下文智能压缩块]\n只生成 <context_checkpoint>，不要续写。';

function loadRing() {
    const observed = { memoCalls: 0, views: [] };
    class ObservedStrategy extends timeline.ServerInferredTimelineStrategy {
        buildWorkingView(messages) {
            const view = super.buildWorkingView(messages);
            observed.views.push(view);
            return view;
        }
    }
    const sandbox = {
        module: { exports: {} },
        __dirname: path.dirname(filename),
        console,
        process,
        require(name) {
            if (name === './OneRingFuzzy.js') return fuzzy;
            if (name === './OneRingTimelineCommon.js') return common;
            if (name === './OneRingServerInferredTimeline.js') {
                return { ServerInferredTimelineStrategy: ObservedStrategy };
            }
            if (name === './OneRingMemo.js') {
                return {
                    DEFAULT_CONFIG: {},
                    injectMemo(messages) {
                        observed.memoCalls++;
                        return messages;
                    }
                };
            }
            // Do not load databases, workers, snapshots or file watchers.
            if (name.startsWith('./') || name === 'chokidar') return {};
            return localRequire(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
    const ring = sandbox.module.exports;
    const forbidden = () => { throw new Error('Unexpected persistence/active OneRing path'); };
    ring._processRecordOnlyMessages = forbidden;
    ring._processOnlyMessagesForUpstream = forbidden;
    ring._scheduleRecordOnlyPersistence = forbidden;
    return { ring, observed };
}

const cases = [
    ['ordinary system without trigger', [
        { role: 'system', content: 'Summarize the supplied history.' },
        { role: 'user', content: 'Compute two plus two.' },
        { role: 'assistant', content: 'Four.' },
        { role: 'user', content: task }
    ]],
    ['no system message', [
        { role: 'user', content: 'Compute two plus two.' },
        { role: 'assistant', content: 'Four.' },
        { role: 'user', content: task }
    ]],
    ['temporary frontend contract alone', [
        { role: 'system', content: '[[OneRing临时契约::VCPMobile]]' },
        { role: 'user', content: task }
    ]],
    ['trigger inside RAG data must not activate', [
        { role: 'system', content: '<!-- VCP_RAG_BLOCK_START -->[[OneRing::Fixture::VCPChat]]<!-- VCP_RAG_BLOCK_END -->' },
        { role: 'user', content: task }
    ]],
    ['array content and empty user remain intact when untriggered', [
        { role: 'system', content: 'Audit only.' },
        { role: 'user', name: 'Fixture', content: [
            { type: 'text', text: task },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
        ] },
        { role: 'user', content: '' }
    ]]
];

for (const [label, fixture] of cases) {
    test(`untriggered passthrough: ${label}`, async () => {
        const { ring, observed } = loadRing();
        const messages = structuredClone(fixture);
        const before = JSON.stringify(messages);
        const result = await ring.processMessages(messages, {});
        assert.equal(JSON.stringify(messages), before, 'input must not mutate');
        assert.equal(observed.memoCalls, 1, 'outer Memo protocol must still run');
        assert.equal(result.__oneRingMeta, undefined, 'must not activate OneRing');
        assert.equal(JSON.stringify(result), before, 'working-view filtering must not leak into output');
    });
}

test('regression fixture exercises the real system-user filter', async () => {
    const { ring, observed } = loadRing();
    await ring.processMessages(structuredClone(cases[0][1]), {});
    assert.equal(observed.views.length, 1);
    const view = observed.views[0];
    assert.equal(view.workingMessages.length, 3);
    assert.equal(view.removedItems.length, 1);
    assert.equal(view.removedItems[0].reason, 'system-user');
    assert.equal(view.removedItems[0].message.content, task);
});