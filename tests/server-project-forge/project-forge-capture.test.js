'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const forge = require('../../Plugin/ServerProjectForge/ProjectForgeService');

const call = args => forge.processToolCall(args);

async function fixture(t, config = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-capture-'));
    const root = path.join(dir, 'ws');
    fs.mkdirSync(root);
    let enabled = true;
    const options = {
        dbPath: path.join(dir, 'pf.db'),
        config: { AST_INDEX_ENABLED: false, ...config },
        workspaceService: {
            list: () => [{ id: 'capture-ws', alias: 'demo', path: root, enabled }],
            getActiveWorkspaceId: () => 'capture-ws',
        },
        trash: async file => fs.rmSync(file, { force: true }),
        logger: { log() {}, warn() {}, error() {} },
    };
    forge.initialize(options);
    t.after(async () => {
        await forge.cleanup();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const projectId = (await call({
        command: 'CreateProject', name: 'capture', todos: ['验收'],
    })).details.project.id;
    const begin = (paths, requestId = 'task-1') => call({
        command: 'BeginCapture', projectId, paths, requestId,
        reason: '外部工人施工', maid: 'Worker-1', todo: 1,
    });
    const finish = captureId => call({ command: 'FinishCapture', projectId, captureId });
    return {
        root, projectId, options, begin, finish,
        file: rel => path.join(root, rel),
        store: () => forge._test.getRuntime().store,
        disable: () => { enabled = false; },
    };
}

test('收录修改、新建、删除和二进制：保真、署名、Todo、幂等结束及整批回滚', async t => {
    const f = await fixture(t);
    const originals = {
        'edit.txt': Buffer.from('\uFEFFold\r\n'),
        'delete.txt': Buffer.from('delete me\r\n'),
        'binary.bin': Buffer.from([0, 1, 2, 255]),
    };
    for (const [rel, bytes] of Object.entries(originals)) fs.writeFileSync(f.file(rel), bytes);
    const capture = (await f.begin([...Object.keys(originals), 'new.txt'])).details.capture;
    fs.writeFileSync(f.file('edit.txt'), 'new\r\n');
    fs.unlinkSync(f.file('delete.txt'));
    fs.writeFileSync(f.file('binary.bin'), Buffer.from([0, 5, 255]));
    fs.writeFileSync(f.file('new.txt'), 'created\n');
    const result = await f.finish(capture.id);
    assert.equal(result.details.capture.status, 'finished');
    const batchId = result.details.batchId;
    assert.ok(batchId);
    const nodes = f.store().getBatchNodes(f.projectId, batchId);
    assert.equal(nodes.length, 4);
    assert.ok(nodes.every(n => n.todo_id === capture.todo_id));
    assert.equal(f.store().getBatch(f.projectId, batchId).maid, 'Worker-1');
    assert.equal(f.store().listTodos(f.projectId)[0].status, 'pending');
    assert.equal((await f.finish(capture.id)).details.batchId, batchId);
    assert.equal(f.store().projectStats(f.projectId).nodeCount, 4);
    const diff = await call({ command: 'GetNodeDiff', projectId: f.projectId, batch: `b${batchId}` });
    assert.match(diff.content.map(p => p.text || '').join('\n'), /new/);
    const rollback = await call({ command: 'Rollback', projectId: f.projectId, batch: `b${batchId}` });
    assert.equal(rollback.details.status, 'ok');
    for (const [rel, bytes] of Object.entries(originals)) assert.deepEqual(fs.readFileSync(f.file(rel)), bytes);
    assert.equal(fs.existsSync(f.file('new.txt')), false);
});

test('未完成收录经过 GC 和进程运行时重启后仍保留快照', async t => {
    const f = await fixture(t);
    fs.writeFileSync(f.file('a.txt'), 'before\r\n');
    const capture = (await f.begin(['a.txt'])).details.capture;
    const hash = capture.files[0].before_hash;
    f.store().gcBlobs();
    assert.equal(f.store().getBlob(hash).toString(), 'before\r\n');
    await forge.cleanup();
    forge.initialize(f.options);
    const queried = await call({ command: 'GetCapture', projectId: f.projectId, requestId: 'task-1' });
    assert.equal(queried.details.capture.id, capture.id);
    fs.writeFileSync(f.file('a.txt'), 'after\n');
    assert.ok((await f.finish(capture.id)).details.batchId);
});

test('无变化不产生节点；重复 requestId 与重叠收录拒绝', async t => {
    const f = await fixture(t);
    fs.writeFileSync(f.file('a.txt'), 'same\n');
    const capture = (await f.begin(['a.txt', 'absent.txt'])).details.capture;
    await assert.rejects(f.begin(['a.txt']), /requestId 已存在/);
    await assert.rejects(f.begin(['a.txt'], 'another'), /未结束收录/);
    const ended = await f.finish(capture.id);
    assert.equal(ended.details.batchId, null);
    assert.equal(f.store().projectStats(f.projectId).nodeCount, 0);
    assert.equal((await f.finish(capture.id)).details.capture.status, 'finished');
});

test('SQLite 节点插入失败：无半批次、不改磁盘且可重试', async t => {
    const f = await fixture(t);
    fs.writeFileSync(f.file('a.txt'), 'a0');
    fs.writeFileSync(f.file('b.txt'), 'b0');
    const capture = (await f.begin(['a.txt', 'b.txt'])).details.capture;
    fs.writeFileSync(f.file('a.txt'), 'a1');
    fs.writeFileSync(f.file('b.txt'), 'b1');
    f.store().db.exec(`CREATE TRIGGER reject_capture BEFORE INSERT ON nodes
        WHEN NEW.file_path = 'b.txt' BEGIN SELECT RAISE(ABORT, 'capture failure'); END;`);
    await assert.rejects(f.finish(capture.id), /capture failure/);
    assert.equal(f.store().getCapture(f.projectId, capture.id).status, 'open');
    assert.equal(f.store().projectStats(f.projectId).nodeCount, 0);
    assert.equal(f.store().db.prepare('SELECT COUNT(*) AS n FROM batches WHERE project_id = ?').get(f.projectId).n, 0);
    assert.equal(fs.readFileSync(f.file('a.txt'), 'utf8'), 'a1');
    assert.equal(fs.readFileSync(f.file('b.txt'), 'utf8'), 'b1');
    f.store().db.exec('DROP TRIGGER reject_capture');
    assert.ok((await f.finish(capture.id)).details.batchId);
});

test('途中 Forge 改动产生历史冲突，不重复归档', async t => {
    const f = await fixture(t);
    fs.writeFileSync(f.file('a.txt'), 'before\n');
    const capture = (await f.begin(['a.txt'])).details.capture;
    await call({
        command: 'EditCode', projectId: f.projectId, path: 'a.txt',
        target: 'before', replace: 'forge edit', reason: '并发修改',
    });
    await assert.rejects(f.finish(capture.id), /历史冲突/);
    assert.equal(f.store().getCapture(f.projectId, capture.id).status, 'open');
    assert.equal(f.store().projectStats(f.projectId).nodeCount, 1);
});

test('拒绝越界、目录、超限文件和停用工作区', async t => {
    const f = await fixture(t, { MAX_EDIT_FILE_SIZE: 4 });
    fs.mkdirSync(f.file('directory'));
    fs.writeFileSync(f.file('large.txt'), '12345');
    await assert.rejects(f.begin(['../escape.txt']), /越出/);
    await assert.rejects(f.begin(['directory']), /普通文件/);
    await assert.rejects(f.begin(['large.txt']), /大小上限/);
    await assert.rejects(f.begin([]), /显式文件列表/);
    const capture = (await f.begin(['absent.txt'])).details.capture;
    f.disable();
    await assert.rejects(f.finish(capture.id), /停用/);
    assert.equal((await call({ command: 'GetCapture', projectId: f.projectId, captureId: capture.id })).details.capture.status, 'open');
});

test('清除工程级联删除收录并允许 GC 回收快照', async t => {
    const f = await fixture(t);
    fs.writeFileSync(f.file('a.txt'), 'unique capture bytes');
    const capture = (await f.begin(['a.txt'])).details.capture;
    const hash = capture.files[0].before_hash;
    fs.writeFileSync(f.file('a.txt'), 'changed');
    await f.finish(capture.id);
    await call({ command: 'DeleteProjects', projectIds: [f.projectId] });
    await call({ command: 'PurgeProjects', projectIds: [f.projectId], confirm: true });
    assert.equal(f.store().db.prepare('SELECT COUNT(*) AS n FROM captures').get().n, 0);
    assert.equal(f.store().db.prepare('SELECT COUNT(*) AS n FROM capture_files').get().n, 0);
    assert.throws(() => f.store().getBlob(hash), /丢失/);
    assert.equal(fs.readFileSync(f.file('a.txt'), 'utf8'), 'changed');
});
test('拒绝目录链接、工程祖先链接以及结束前替换为链接', async t => {
    const f = await fixture(t);
    const outside = path.join(path.dirname(f.root), 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside untouched');
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(outside, f.file('linked'), kind);
    await assert.rejects(f.begin(['linked/secret.txt']), /符号链接/);

    // 即使工程根本身不是链接，也不能通过其父目录链接收录。
    fs.mkdirSync(path.join(outside, 'nested'));
    fs.writeFileSync(path.join(outside, 'nested', 'a.txt'), 'secret nested');
    const nestedId = (await call({
        command: 'CreateProject', name: 'linked ancestor', dir: 'linked/nested',
    })).details.project.id;
    await assert.rejects(call({
        command: 'BeginCapture', projectId: nestedId, requestId: 'nested',
        paths: ['a.txt'], reason: 'must reject',
    }), /符号链接/);

    fs.mkdirSync(f.file('normal'));
    const capture = (await f.begin(['normal/secret.txt'])).details.capture;
    fs.rmdirSync(f.file('normal'));
    fs.symlinkSync(outside, f.file('normal'), kind);
    await assert.rejects(f.finish(capture.id), /符号链接/);
    assert.equal(f.store().getCapture(f.projectId, capture.id).status, 'open');
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside untouched');
    assert.equal(f.store().projectStats(f.projectId).nodeCount, 0);
});