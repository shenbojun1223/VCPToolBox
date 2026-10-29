'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const {
    canonicalizeMessage,
    messageContentHash
} = require('../Plugin/VCPChatSyncHub/sync/canonical');
const { projectMobileMessage } = require('../Plugin/VCPChatSyncHub/sync/projection');

const topicId = 'checkpoint-fixture';
const checkpoint = () => ({
    schemaVersion: 1,
    type: 'context_checkpoint',
    sourceMessageIds: ['fixture-1', 'fixture-2'],
    summary: 'Synthetic checkpoint only.',
    nested: { complete: true, tokenCount: 37 }
});
const rawMessage = () => ({
    id: 'checkpoint-message',
    role: 'user',
    content: '<context_checkpoint>Synthetic summary</context_checkpoint>',
    timestamp: 123456,
    contextCompaction: checkpoint()
});

async function project(raw) {
    return projectMobileMessage({
        rawMessage: raw,
        topicId,
        parentId: 'fixture-agent',
        ownerType: 'agent',
        db: { prepare() { throw new Error('No attachment database access expected'); } },
        appDataPath: os.tmpdir()
    });
}

test('checkpoint metadata survives canonicalization and serialized desktop projection', async () => {
    const raw = rawMessage();
    const snapshot = structuredClone(raw);
    const canonical = canonicalizeMessage(raw, topicId);
    assert.deepEqual(canonical.contextCompaction, snapshot.contextCompaction);

    const projected = await project(JSON.parse(JSON.stringify(canonical)));
    assert.deepEqual(projected.neededAttachmentHashes, []);
    assert.deepEqual(projected.message.contextCompaction, snapshot.contextCompaction);

    const roundTrip = canonicalizeMessage(
        JSON.parse(JSON.stringify(projected.message)), topicId
    );
    assert.deepEqual(roundTrip.contextCompaction, snapshot.contextCompaction);
    assert.equal(messageContentHash(roundTrip), messageContentHash(canonical));
    assert.deepEqual(raw, snapshot, 'the source message must not be mutated');
});

for (const [label, supplied, expected] of [
    ['missing', {}, undefined],
    ['null', { name: null }, undefined],
    ['explicit empty', { name: '' }, ''],
    ['explicit custom', { name: 'Fixture User' }, 'Fixture User']
]) {
    test(`desktop projection preserves ${label} name without inventing defaults`, async () => {
        const raw = { ...rawMessage(), ...supplied };
        const canonical = canonicalizeMessage(raw, topicId);
        const projected = await project(raw);
        if (expected === undefined) {
            assert.equal(Object.hasOwn(canonical, 'name'), false);
            assert.equal(Object.hasOwn(projected.message, 'name'), false);
        } else {
            assert.equal(projected.message.name, expected);
        }
        const roundTrip = canonicalizeMessage(projected.message, topicId);
        assert.equal(messageContentHash(roundTrip), messageContentHash(canonical));
        assert.deepEqual(roundTrip.contextCompaction, raw.contextCompaction);
    });
}

test('non-object checkpoint metadata is not promoted into the canonical protocol', async () => {
    for (const value of [null, false, 42, 'not metadata', []]) {
        const raw = { ...rawMessage(), contextCompaction: value };
        const canonical = canonicalizeMessage(raw, topicId);
        assert.equal(Object.hasOwn(canonical, 'contextCompaction'), false);
        const projected = await project(raw);
        assert.equal(Object.hasOwn(projected.message, 'contextCompaction'), false);
    }
});

test('checkpoint metadata does not bypass existing name validation', () => {
    assert.throws(
        () => canonicalizeMessage({ ...rawMessage(), name: 42 }, topicId),
        /name must be a string/
    );
});