'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const forge = require('../Plugin/ServerProjectForge/ProjectForgeService');
const C = require('../Plugin/ServerProjectForge/delegationReviewRecord');
test('real tool review entry, caller identity, idempotence, projection and disabled-workspace guard', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-service-'));
    let enabled = true;
    const workspace = { id: 'fixture', alias: 'fixture', path: root, enabled: true };
    forge.initialize({ dbPath: path.join(root, 'test.db'),
        services: { workspaceService: {
            list: () => [{ ...workspace, enabled }], getActiveWorkspaceId: () => workspace.id,
        } },
        logger: { log() {}, warn() {}, error() {} },
    });
    t.after(async () => { await forge.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
    const p = await forge.processToolCall({ command: 'CreateProject', workspace: 'fixture', dir: 'project',
        name: 'review fixture', todos: 'frozen', maid: 'Controller' });
    const projectId = p.details.projectId || p.details.project.id;
    const bound = { projectId, todoSeq: 1, delegationId: 'aa-delegation-1793459141509-557448cf',
        role: 'Worker', assignedBy: 'Controller', sessionId: 'test' };
    await forge.delegations.bind(bound);
    await forge.delegations.advance({ ...bound, status: 'completed', sequence: 1 });
    const store = forge._test.getRuntime().store;
    const before = store.getTodoBySeq(projectId, 1);
    const call = { command: 'RecordDelegationReview', projectId, todoSeq: '1', delegationId: bound.delegationId,
        expectedSequence: '1', expectedRevision: '0', requestId: 'service-review-1', verdict: 'passed',
        scope: '仅合成后端场景', reason: '独立检查', evidence: JSON.stringify({ ref: 'verification.json', sha256: 'a'.repeat(64) }),
        maid: 'Controller' };
    await assert.rejects(forge.processToolCall({ ...call, maid: undefined, reviewedBy: 'Controller' }));
    await assert.rejects(forge.processToolCall({ ...call, maid: 'Worker', reviewedBy: 'Controller' }));
    await assert.rejects(forge.processToolCall({ ...call, expectedRevision: true }));
    const events = [], listener = event => events.push(event);
    forge.events.on('changed', listener);
    t.after(() => forge.events.removeListener('changed', listener));
    const result = await forge.processToolCall(call);
    assert.equal(result.details.changed, true);
    assert.equal(result.details.review.reviewedBy, 'Controller');
    assert.deepEqual(store.getTodoBySeq(projectId, 1), before);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'recorddelegationreview');
    const repeated = await forge.processToolCall(call);
    assert.equal(repeated.details.changed, false);
    assert.equal(events.length, 1, 'replay must not trigger republishing');
    const history = await forge.processToolCall({ command: 'GetDelegationReviews', ...bound });
    assert.equal(history.details.reviews.length, 1);
    const detail = await forge.processToolCall({ command: 'GetProject', projectId });
    const row = detail.details.todos[0];
    assert.equal(C.readReview(row.note, C.readRuntime(row.note)).verdict, 'passed');
    assert.equal(row.status, 'pending');
    const gui = forge.gui.getProject(projectId);
    assert.equal(C.readReview(gui.todos[0].note, C.readRuntime(gui.todos[0].note)).verdict, 'passed');
    const historyBefore = JSON.stringify(history.details.reviews);
    enabled = false;
    await assert.rejects(forge.processToolCall({ ...call, requestId: 'disabled', expectedRevision: 1, verdict: 'rejected' }));
    enabled = true;
    assert.equal(JSON.stringify((await forge.processToolCall({ command: 'GetDelegationReviews', ...bound })).details.reviews), historyBefore);
    assert.deepEqual(store.getTodoBySeq(projectId, 1), before);
});