'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const modulePath = require.resolve('../Plugin/RAGDiaryPlugin/GroupPresentationOrder');

for (const [name, value, enabled] of [
    ['unset defaults to enabled', null, true],
    ['explicit true enables ordering', 'true', true],
    ['explicit false bypasses ordering', 'false', false],
    ['false accepts case and whitespace', ' FALSE ', false]
]) {
    test(name, () => {
        const env = { ...process.env };
        delete env.RAG_GROUP_PRESENTATION_ORDER_ENABLED;
        if (value !== null) env.RAG_GROUP_PRESENTATION_ORDER_ENABLED = value;
        const script = `
            const assert = require('node:assert/strict');
            const Order = require(${JSON.stringify(modulePath)});
            const expected = ${enabled};
            const order = new Order();
            assert.equal(order.enabled, expected);
            const context = { ownerType: 'agent', agentId: 'a', topicId: 't' };
            const meta = { dbName: 'd', modifiers: '::Group', engine: 'TagMemo' };
            const rows = ['A', 'B'].map(text => ({ chunkId: text, fullPath: 'd/' + text, text }));
            const capture = rs => order.capture(rs, 'd', new Map(), meta);
            if (expected) {
                order.render('raw', capture(rows), order.begin(context));
                const output = order.render('raw', capture([...rows].reverse()), order.begin(context));
                assert.ok(output.indexOf('* A') < output.indexOf('* B'));
                assert.equal(order.states.size, 1);
            } else {
                assert.equal(order.begin(context), null);
                assert.equal(capture(rows), null);
                // Even pre-existing cached presentation and request data must be bypassed.
                assert.equal(order.render('raw unchanged', {}, { scope: 'old', sequence: 1 }), 'raw unchanged');
                assert.equal(order.states.size, 0);
                assert.equal(order.sequence, 0);
            }
            // Existing instances keep their startup setting; new instances read the new value.
            process.env.RAG_GROUP_PRESENTATION_ORDER_ENABLED = expected ? 'false' : 'true';
            assert.equal(order.enabled, expected);
            assert.equal(new Order().enabled, !expected);
        `;
        const result = spawnSync(process.execPath, ['-e', script], {
            env, encoding: 'utf8', timeout: 10000
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });
}