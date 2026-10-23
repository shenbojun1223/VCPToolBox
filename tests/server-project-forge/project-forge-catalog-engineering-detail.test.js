'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    projectEngineeringDetail,
    DETAIL_LIMITS,
} = require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');

const at = '2026-10-22T02:00:00.000Z';
function fixture() {
    return {
        project: { report: '验收通过', report_by: 'Kerr', root: 'C:/private/root', secret: 'DO_NOT_SHARE' },
        batches: [{
            id: 7, kind: 'edit', reason: '修复边界', maid: 'Kerr', created_at: at,
            node_count: 1, added: 2, removed: 1, files: ['src/a.js'],
            secret: 'DO_NOT_SHARE',
        }],
        files: [{
            file_path: 'src/a.js', edits: 1, added: 2, removed: 1, last_node: 9,
            before_content: 'DO_NOT_SHARE', after_content: 'DO_NOT_SHARE',
        }],
        batchTotal: 1, fileTotal: 1,
    };
}

test('sharing is explicit; disabled projection never reads private fields', () => {
    const input = new Proxy({}, { get() { throw Error('PRIVATE_FIELD_ACCESSED'); } });
    assert.deepEqual(projectEngineeringDetail(input), { version: 1, state: 'not-shared' });
    assert.deepEqual(projectEngineeringDetail(input, { shared: false }),
        { version: 1, state: 'not-shared' });
    assert.throws(() => projectEngineeringDetail(input, { shared: 'true' }));
});

test('shared projection emits only report, batch summaries and relative file metadata', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const result = projectEngineeringDetail(input, { shared: true });
    assert.equal(result.version, 1);
    assert.equal(result.state, 'shared');
    assert.deepEqual(result.report, { text: '验收通过', by: 'Kerr', truncated: [] });
    assert.deepEqual(Object.keys(result).sort(), ['files', 'report', 'state', 'timeline', 'version']);
    assert.equal(result.timeline.items[0].id, 7);
    assert.equal(result.files.items[0].file_path, 'src/a.js');
    assert.equal(result.timeline.total, 1);
    assert.equal(result.timeline.truncated, false);
    assert.equal(result.files.truncated, false);
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_SHARE|private\/root|before_content|after_content/);
    assert.equal(JSON.stringify(input), before);
    result.timeline.items[0].files.push('another.js');
    assert.deepEqual(input.batches[0].files, ['src/a.js']);
});

test('shared empty data is distinguishable from data not shared', () => {
    const result = projectEngineeringDetail({
        project: { report: null, report_by: null },
        batches: [], files: [], batchTotal: 0, fileTotal: 0,
    }, { shared: true });
    assert.equal(result.state, 'shared');
    assert.deepEqual(result.report, { text: null, by: null, truncated: [] });
    assert.deepEqual(result.timeline, { items: [], total: 0, truncated: false });
    assert.deepEqual(result.files, { items: [], total: 0, truncated: false });
});

test('report clipping is explicit and does not split surrogate pairs', () => {
    const input = fixture();
    input.project.report = 'x'.repeat(DETAIL_LIMITS.reportChars - 1) + '😀tail';
    const result = projectEngineeringDetail(input, { shared: true });
    assert.ok(result.report.text.length <= DETAIL_LIMITS.reportChars);
    assert.ok(!/[\uD800-\uDBFF]$/.test(result.report.text));
    assert.ok(result.report.truncated.includes('text'));
    assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= DETAIL_LIMITS.maxBytes);
});

test('collector totals are preserved; incomplete previews never look complete', () => {
    const input = fixture();
    input.batchTotal = 100;
    input.fileTotal = 200;
    const result = projectEngineeringDetail(input, { shared: true });
    assert.equal(result.timeline.total, 100);
    assert.equal(result.files.total, 200);
    assert.equal(result.timeline.truncated, true);
    assert.equal(result.files.truncated, true);
    input.batchTotal = 0;
    assert.throws(() => projectEngineeringDetail(input, { shared: true }));
});

test('unsafe paths fail closed rather than leaking absolute filesystem locations', () => {
    for (const bad of ['C:/private/a.js', '/etc/passwd', '../secret', 'src/../../secret',
        '\\\\server\\share\\a.js', 'src\\a.js', 'src//a.js', '.git/config']) {
        const input = fixture();
        input.files[0].file_path = bad;
        assert.throws(() => projectEngineeringDetail(input, { shared: true }), bad);
        const batchInput = fixture();
        batchInput.batches[0].files = [bad];
        assert.throws(() => projectEngineeringDetail(batchInput, { shared: true }), bad);
    }
});

test('invalid counts and over-limit collections are rejected before transport', () => {
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const input = fixture();
        input.fileTotal = invalid;
        assert.throws(() => projectEngineeringDetail(input, { shared: true }));
    }
    const input = fixture();
    input.batches = Array.from({ length: DETAIL_LIMITS.maxBatches + 1 },
        (_, i) => ({ ...input.batches[0], id: i + 1 }));
    input.batchTotal = input.batches.length;
    assert.throws(() => projectEngineeringDetail(input, { shared: true }));
});

test('batch file preview preserves actual total and marks truncation explicitly', () => {
    const input = fixture();
    const row = input.batches[0];
    row.files = Array.from({ length: DETAIL_LIMITS.maxBatchFiles }, (_, i) => `src/file-${i}.js`);
    row.file_total = 37;
    row.node_count = 40;
    const result = projectEngineeringDetail(input, { shared: true });
    const preview = result.timeline.items[0];
    assert.equal(preview.files.length, DETAIL_LIMITS.maxBatchFiles);
    assert.equal(preview.file_total, 37);
    assert.equal(preview.files_truncated, true);
    const complete = projectEngineeringDetail(fixture(), { shared: true }).timeline.items[0];
    assert.equal(complete.file_total, 1);
    assert.equal(complete.files_truncated, false);
});

test('batch file totals cannot undercount preview paths or exceed node count', () => {
    for (const total of [0, -1, 0.5, 2, NaN, Infinity]) {
        const input = fixture();
        input.batches[0].file_total = total;
        assert.throws(() => projectEngineeringDetail(input, { shared: true }));
    }
    const input = fixture();
    input.batches[0].files = [];
    input.batches[0].file_total = 1;
    assert.throws(() => projectEngineeringDetail(input, { shared: true }));
});