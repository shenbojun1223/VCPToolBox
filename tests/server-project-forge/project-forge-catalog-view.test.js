'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { remoteSummary, remoteDetail, mergeCatalog } =
    require('../../Plugin/ServerProjectForge/catalogView');
const time = '2026-10-21T00:00:00.000Z';
function entry(sourceId = 'server') {
    return {
        id: 'remote:' + sourceId, kind: 'source', pin: { version: 3 },
        observedAt: 1000,
        summary: { sourceId, localProjectId: 'p1', globalProjectId: null,
            name: '同名计划', status: 'accepted', createdAt: time, updatedAt: time,
            deletedAt: null, progress: { total: 1, done: 1, pending: 0, doing: 0, blocked: 0 } },
    };
}
const local = () => ({ id: 'p1', name: '同名计划', status: 'active', deleted_at: null });
test('remote view has no root, write capability or fabricated history stats', () => {
    const row = remoteSummary(entry(), { stale: true, error: 'NETWORK_ERROR' });
    assert.equal(row.root, null);
    assert.equal(row.rootInfo.writable, false);
    assert.equal(row.stats, null);
    assert.equal(row.catalog.historyAvailable, false);
    assert.equal(row.catalog.stale, true);
    assert.equal(row.catalog.observedAt, 1000);
    assert.equal(row.progress.text, '1/1');
    assert.notEqual(row.id, row.catalog.localProjectId);
});
test('same name and short local ID from another source remain separate', () => {
    const rows = mergeCatalog([local()], [remoteSummary(entry())], {
        hubId: 'hub-A', localSourceId: 'home',
    });
    assert.equal(rows.length, 2);
});
test('own ordinary source deduplicates against local but never another source', () => {
    const rows = mergeCatalog([local()], [remoteSummary(entry('home')), remoteSummary(entry())], {
        hubId: 'hub-A', localSourceId: 'home',
    });
    assert.deepEqual(rows.map(r => r.id), ['p1', 'remote:server']);
});
test('global binding suppresses only its local replica on the matching Hub', () => {
    const e = { id: 'remote:global', kind: 'global', observedAt: 1000,
        global: { id: 'global-A', localProjectId: 'origin-id', originId: 'source',
            name: '全局计划', revision: 4, createdAt: 0, updatedAt: 1000 } };
    const row = remoteSummary(e);
    assert.equal(row.progress, null);
    assert.equal(row.status, 'unknown');
    const mappings = [{ localProjectId: 'p1', globalProjectId: 'global-A', hubId: 'hub-A' }];
    assert.equal(mergeCatalog([local()], [row], { mappings, hubId: 'hub-B' }).length, 2);
    assert.deepEqual(mergeCatalog([local()], [row], { mappings, hubId: 'hub-A' }).map(r => r.id),
        ['remote:global']);
});
test('detail contains only readonly plan data and explicit truncation flags', () => {
    const e = entry();
    const view = remoteDetail(e, { id: e.id, summary: e.summary, observedAt: 2000,
        todos: [{ seq: 1, title: '任务', status: 'done', note: '预览',
            updatedBy: 'Kerr', updatedAt: time, truncated: ['note'] }] });
    assert.deepEqual(view.todos[0].truncated, ['note']);
    assert.deepEqual(view.files, []);
    assert.deepEqual(view.timeline, []);
    assert.equal(view.project.report, null);
    assert.equal(view.project.catalog.observedAt, 2000);
});

test('engineering view exposes validated shared summaries without local history capabilities', () => {
    const { projectEngineeringDetail } =
        require('../../Plugin/ServerProjectForge/catalogEngineeringDetail');
    const e = entry();
    const engineering = projectEngineeringDetail({
        project: { report: '远端验收报告', report_by: 'Kerr' },
        batches: [{
            id: 7, kind: 'edit', reason: '修复', maid: 'Kerr', created_at: time,
            node_count: 1, added: 2, removed: 1, files: ['src/a.js'],
        }],
        batchTotal: 1,
        files: [{ file_path: 'src/a.js', edits: 1, added: 2, removed: 1, last_node: 9 }],
        fileTotal: 1,
    }, { shared: true });
    const data = { id: e.id, summary: e.summary, observedAt: 2000, todos: [], engineering };
    const view = remoteDetail(e, data, { stale: true, error: 'NETWORK_ERROR' });
    assert.deepEqual(view.engineering, engineering);
    assert.equal(view.project.report, '远端验收报告');
    assert.equal(view.project.report_by, 'Kerr');
    assert.equal(view.project.hasReport, true);
    assert.equal(view.project.catalog.engineeringState, 'shared');
    assert.equal(view.project.catalog.historyAvailable, false);
    assert.equal(view.project.catalog.stale, true);
    assert.equal(view.project.root, null);
    assert.equal(view.project.rootInfo.writable, false);
    assert.deepEqual(view.timeline, []);
    assert.deepEqual(view.files, []);
    view.engineering.timeline.items[0].files.push('caller.js');
    assert.deepEqual(engineering.timeline.items[0].files, ['src/a.js']);
    assert.throws(() => remoteDetail(e, {
        ...data, engineering: { ...engineering, secret: 'unexpected' },
    }));
});

test('engineering view preserves unavailable versus unshared without fabricating reports', () => {
    const e = entry();
    const data = { id: e.id, summary: e.summary, observedAt: 2000, todos: [] };
    for (const engineering of [
        { version: 1, state: 'not-shared' },
        { version: 1, state: 'unavailable', reason: 'endpoint-or-resource-unavailable' },
        { version: 1, state: 'unavailable', reason: 'global-detail-not-supported' },
    ]) {
        const view = remoteDetail(e, { ...data, engineering });
        assert.deepEqual(view.engineering, engineering);
        assert.equal(view.project.catalog.engineeringState, engineering.state);
        assert.equal(view.project.report, null);
        assert.equal(view.project.hasReport, false);
    }
    assert.throws(() => remoteDetail(e, { ...data, engineering: {
        version: 1, state: 'unavailable', reason: 'unexpected-secret-text',
    } }));
});