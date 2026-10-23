'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EngineeringSnapshot } =
    require('../../Plugin/ServerProjectForge/catalogEngineeringPages');
const { projectEngineeringDetail } =
    require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');
const pin = {
    sourceId: 'source-A', localProjectId: 'p1', version: 2, digest: 'a'.repeat(64),
};
function detail(report = '报告') {
    return projectEngineeringDetail({
        project: { report, report_by: 'Kerr' },
        batches: [], batchTotal: 0,
        files: Array.from({ length: 12 }, (_, i) => ({
            file_path: `src/文件-${i}.js`, edits: 1, added: 1, removed: 0, last_node: i + 1,
        })),
        fileTotal: 12,
    }, { shared: true });
}
function all(snapshot, section, options = {}) {
    const items = [];
    let cursor = null;
    for (let i = 0; i < 100; i++) {
        const page = snapshot.page(section, { ...options, cursor });
        assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= (options.maxBytes || 32768));
        items.push(...page.items);
        if (page.next === null) {
            assert.equal(items.length, page.total);
            return { items, page };
        }
        assert.ok(page.items.length > 0, 'Continuation must make progress');
        cursor = page.next;
    }
    assert.fail('Pagination did not terminate');
}

test('report chunks reconstruct exact clipped text, including escaped characters and emoji', () => {
    const value = detail(('中文😀"\\\n').repeat(1000));
    const snapshot = new EngineeringSnapshot(value, pin);
    const { items, page } = all(snapshot, 'report', { limit: 1, maxBytes: 16384 });
    assert.ok(items.length > 1);
    assert.equal(items.map(x => x.text).join(''), value.report.text);
    assert.ok(items.every(x => !/[\uD800-\uDBFF]$/.test(x.text)));
    let offset = 0;
    for (const item of items) {
        assert.equal(item.offset, offset);
        offset += item.text.length;
    }
    assert.equal(page.metadata.by, 'Kerr');
    assert.deepEqual(page.metadata.truncated, value.report.truncated);
    assert.equal(page.metadata.present, true);
});

test('file pages honor actual UTF8 byte budgets and preserve ordered entries', () => {
    const value = detail();
    const snapshot = new EngineeringSnapshot(value, pin);
    const { items, page } = all(snapshot, 'files', { limit: 3, maxBytes: 1800 });
    assert.deepEqual(items, value.files.items);
    assert.equal(page.metadata.total, 12);
    assert.equal(page.metadata.truncated, false);
});

test('cursor binds content, identity, source version and section', () => {
    const value = detail();
    const snapshot = new EngineeringSnapshot(value, pin);
    const cursor = snapshot.page('files', { limit: 1 }).next;
    for (const patch of [
        { sourceId: 'source-B' }, { localProjectId: 'p2' },
        { version: 3 }, { digest: 'b'.repeat(64) },
    ]) {
        assert.throws(() => new EngineeringSnapshot(value, { ...pin, ...patch })
            .page('files', { cursor }), { code: 'REQUEST_CONFLICT' });
    }
    assert.throws(() => new EngineeringSnapshot(detail('changed'), pin)
        .page('files', { cursor }), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => snapshot.page('timeline', { cursor }), { code: 'REQUEST_CONFLICT' });
    for (const offset of [-1, 0, 0.5, 12, 999]) {
        assert.throws(() => snapshot.page('files', { cursor: { ...cursor, offset } }));
    }
});

test('input and returned objects cannot mutate retained snapshot', () => {
    const value = detail(), binding = { ...pin };
    const snapshot = new EngineeringSnapshot(value, binding);
    const before = snapshot.page('files');
    value.files.items[0].file_path = 'changed.js';
    binding.localProjectId = 'p2';
    snapshot.page('files').items[0].file_path = 'caller.js';
    assert.deepEqual(snapshot.page('files'), before);
});

test('not-shared, missing report and empty report are distinct terminal states', () => {
    const unshared = new EngineeringSnapshot({ version: 1, state: 'not-shared' }, pin);
    for (const section of ['report', 'timeline', 'files']) {
        const page = unshared.page(section);
        assert.equal(page.state, 'not-shared');
        assert.deepEqual(page.items, []);
        assert.equal(page.next, null);
    }
    const absent = new EngineeringSnapshot(detail(null), pin).page('report');
    const empty = new EngineeringSnapshot(detail(''), pin).page('report');
    assert.equal(absent.metadata.present, false);
    assert.equal(empty.metadata.present, true);
    assert.equal(absent.state, 'shared');
    assert.equal(empty.state, 'shared');
});

test('invalid section, options and tiny budgets fail without empty continuation loops', () => {
    const snapshot = new EngineeringSnapshot(detail(), pin);
    assert.throws(() => snapshot.page('source'));
    assert.throws(() => snapshot.page('files', { limit: 0 }));
    assert.throws(() => snapshot.page('files', { maxBytes: 32769 }));
    assert.throws(() => snapshot.page('files', { unexpected: true }));
    const value = detail();
    value.files.items[0].file_path = 'a'.repeat(500);
    assert.throws(() => new EngineeringSnapshot(value, pin).page('files', { maxBytes: 512 }),
        { code: 'LIMIT_EXCEEDED' });
});