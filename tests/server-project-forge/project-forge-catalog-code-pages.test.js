'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodeSnapshot, codeDigest, validateCodePage, MAX_CODE_BYTES } =
    require('../../Plugin/ServerProjectForge/catalogCodePages');
const binding = {
    sourceId: 'source-A', localProjectId: 'p1', version: 1, digest: 'a'.repeat(64), node: 1,
};
const clone = value => JSON.parse(JSON.stringify(value));

test('byte pages preserve Unicode BOM CRLF and escaped control text under exact JSON budget', () => {
    const value = { text: '\uFEFF中文🌿\r\n\u0001'.repeat(3000) };
    const snapshot = new CodeSnapshot(value, binding);
    const parts = [];
    let cursor = null, count = 0;
    do {
        const page = snapshot.page({ cursor, maxBytes: 900 });
        assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 900);
        parts.push(validateCodePage(page, cursor));
        cursor = page.next;
        count++;
        assert.ok(count < 1024);
    } while (cursor !== null);
    assert.ok(count > 1);
    const bytes = Buffer.concat(parts);
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), value);
    assert.equal(codeDigest(binding, bytes), snapshot.snapshot);
});

test('cursor is bound to source project version digest node and actual content', () => {
    const value = { text: 'x'.repeat(10000) };
    const cursor = new CodeSnapshot(value, binding).page().next;
    for (const replacement of [
        { sourceId: 'source-B' }, { localProjectId: 'p2' }, { version: 2 },
        { digest: 'b'.repeat(64) }, { node: 2 },
    ]) {
        assert.throws(() => new CodeSnapshot(value, { ...binding, ...replacement }).page({ cursor }),
            { code: 'REQUEST_CONFLICT' });
    }
    assert.throws(() => new CodeSnapshot({ text: 'y'.repeat(10000) }, binding).page({ cursor }),
        { code: 'REQUEST_CONFLICT' });
    const snapshot = new CodeSnapshot(value, binding);
    for (const invalid of [{}, { ...cursor, offset: 0 },
        { ...cursor, offset: snapshot.bytes.length }, { ...cursor, extra: true }]) {
        assert.throws(() => snapshot.page({ cursor: invalid }));
    }
});

test('malformed pages cannot skip bytes, terminate early or smuggle noncanonical base64', () => {
    const snapshot = new CodeSnapshot({ text: 'x'.repeat(10000) }, binding);
    const original = snapshot.page();
    for (const mutate of [
        page => { page.offset = 1; },
        page => { page.next = null; },
        page => { page.next.offset++; },
        page => { page.next.snapshot = '0'.repeat(64); },
        page => { page.data += '\n'; },
        page => { page.data = ''; },
        page => { page.total = MAX_CODE_BYTES + 1; },
        page => { page.extra = 'unexpected'; },
    ]) {
        const page = clone(original); mutate(page);
        assert.throws(() => validateCodePage(page));
    }
    const next = snapshot.page({ cursor: original.next });
    assert.throws(() => validateCodePage(next));
    assert.throws(() => validateCodePage(next, { ...original.next, snapshot: '0'.repeat(64) }));
    assert.ok(validateCodePage(next, original.next).length > 0);
});

test('small unshared response completes once; oversized serialized input is rejected', () => {
    const value = { version: 1, state: 'not-shared' };
    const snapshot = new CodeSnapshot(value, binding);
    const page = snapshot.page();
    assert.equal(page.next, null);
    assert.deepEqual(JSON.parse(validateCodePage(page).toString('utf8')), value);
    assert.throws(() => new CodeSnapshot({ text: 'x'.repeat(MAX_CODE_BYTES) }, binding),
        { code: 'LIMIT_EXCEEDED' });
    assert.throws(() => snapshot.page({ maxBytes: 255 }));
    assert.throws(() => new CodeSnapshot(value, { ...binding, version: 0 }));
});