'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const forge = require('../Plugin/ServerProjectForge/ProjectForgeService');
const L = require('../Plugin/ServerProjectForge/delegationLifecycle');
test('real host entry locks binding, emits changed and leaves business state untouched', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-host-lifecycle-'));
    t.after(async () => { await forge.cleanup(); fs.rmSync(root, { recursive: true, force: true }); });
    forge.initialize({ config: {
        PROJECTFORGE_DB_PATH: path.join(root, 'test.db'),
        WORKSPACES: 'fixture|' + root, ACTIVE_WORKSPACE: 'fixture', AST_INDEX_ENABLED: 'false',
    }, logger: { log() {}, warn() {} } });
    const p = await forge.processToolCall({ command: 'CreateProject', workspace: 'fixture',
        dir: 'project', name: 'fixture', todos: 'test', maid: 'Test' });
    const projectId = p.details.projectId || p.details.project?.id;
    assert.ok(projectId);
    const args = { projectId, todoSeq: 1, delegationId: 'aa-delegation-1793459141509-557448cf',
        role: 'Worker', assignedBy: 'Test', sessionId: 'test' };
    const events = [];
    const listener = e => events.push(e);
    forge.events.on('changed', listener);
    t.after(() => forge.events.removeListener('changed', listener));
    await forge.delegations.bind(args);
    await assert.rejects(forge.delegations.bind({
        ...args, delegationId: 'aa-delegation-1793459141510-557448ce',
    }), { code: 'DELEGATION_BUSY' });
    await forge.delegations.advance({ ...args, status: 'running', sequence: 1 });
    await forge.delegations.advance({ ...args, status: 'completed', sequence: 2 });
    const detail = forge.gui.getProject(projectId);
    assert.equal(detail.todos[0].status, 'pending');
    assert.equal(L.readNote(detail.todos[0].note).data.stage, 'review');
    assert.equal(events.length, 3);
    assert.ok(events.every(e => e.projectId === projectId && e.todoSeq === 1));
    assert.equal(forge.catalogStatus().read, false);
});