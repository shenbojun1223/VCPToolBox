'use strict';

const fs = require('node:fs');

const action = process.argv[2] || '';
const markerPath = process.env.STDOUT_TEST_MARKER || '';
const pidPath = markerPath ? `${markerPath}.pid` : '';

if (pidPath) fs.writeFileSync(pidPath, String(process.pid), 'utf8');

function markClosed() {
    if (markerPath) fs.writeFileSync(markerPath, 'closed', 'utf8');
}

process.on('exit', markClosed);

function finish(code = 0) {
    process.stdout.end(() => {
        process.exitCode = code;
    });
}

function writeTextAndFinish(text, code = 0, stderr = '') {
    if (stderr) process.stderr.write(stderr);
    process.stdout.write(text);
    finish(code);
}

function writeChunks(text, chunkSize, done) {
    let offset = 0;
    const writeNext = () => {
        if (offset >= text.length) {
            done();
            return;
        }
        const nextOffset = Math.min(offset + chunkSize, text.length);
        const accepted = process.stdout.write(text.slice(offset, nextOffset));
        offset = nextOffset;
        if (accepted) setImmediate(writeNext);
        else process.stdout.once('drain', writeNext);
    };
    writeNext();
}

function writeBufferChunks(buffer, chunkSize, done) {
    let offset = 0;
    const writeNext = () => {
        if (offset >= buffer.length) {
            done();
            return;
        }
        const nextOffset = Math.min(offset + chunkSize, buffer.length);
        const accepted = process.stdout.write(buffer.subarray(offset, nextOffset));
        offset = nextOffset;
        if (accepted) setImmediate(writeNext);
        else process.stdout.once('drain', writeNext);
    };
    writeNext();
}

const completeResponse = {
    status: 'success',
    result: {
        phase: 'first',
        text: '字符串中的花括号 {}、反斜杠 \\ 和引号 " 不应改变边界。',
        nested: { values: [1, { ok: true }] }
    }
};

const innerResponse = {
    status: 'success',
    result: { inner: true }
};

const outerResponse = {
    status: 'success',
    result: { outer: true }
};

switch (action) {
    case 'sync-success':
        writeTextAndFinish(JSON.stringify(completeResponse), 0, 'sync stderr\n');
        break;
    case 'sync-error':
        writeTextAndFinish(JSON.stringify({ status: 'error', error: 'expected fixture error' }), 0, 'sync error stderr\n');
        break;
    case 'sync-nonzero':
        writeTextAndFinish(JSON.stringify({ status: 'error', error: 'nonzero fixture error' }), 7, 'nonzero stderr\n');
        break;
    case 'sync-empty':
        finish(0);
        break;
    case 'sync-malformed':
        writeTextAndFinish('{"status":', 0);
        break;
    case 'sync-large': {
        const largeResponse = JSON.stringify({
            status: 'success',
            result: { text: '{'.repeat(256 * 1024), tail: '完整排空' }
        });
        writeChunks(largeResponse, 4096, () => finish(0));
        break;
    }
    case 'async-success-background':
        process.stdout.write('INFO: accepted\n');
        writeChunks(JSON.stringify(completeResponse), 3, () => {
            setTimeout(() => {
                process.stdout.write(JSON.stringify({ status: 'success', result: { phase: 'later' } }));
                finish(9);
            }, 120);
        });
        break;
    case 'async-error-background':
        writeChunks(JSON.stringify({ status: 'error', error: 'initial async error' }), 2, () => {
            setTimeout(() => finish(9), 120);
        });
        break;
    case 'async-prefix-invalid':
        process.stdout.write('INFO {not-json\n');
        writeTextAndFinish(JSON.stringify({ status: 'success', result: { recovered: true } }));
        break;
    case 'async-unrelated-inner':
        process.stdout.write(JSON.stringify({ meta: { status: 'success', result: { inner: true } } }));
        writeTextAndFinish(JSON.stringify({ status: 'success', result: { outer: true } }));
        break;
    case 'async-array-then-success':
        writeChunks(`[${JSON.stringify(innerResponse)}]${JSON.stringify(outerResponse)}`, 2, () => finish(0));
        break;
    case 'async-bad-outer-then-success':
        writeChunks(`{oops:${JSON.stringify(innerResponse)}}${JSON.stringify(outerResponse)}`, 2, () => finish(0));
        break;
    case 'async-nested-containers-then-success': {
        const nestedNoise = JSON.stringify({
            meta: {
                items: [
                    innerResponse,
                    { text: '字符串里的花括号 {} [] \\" 不应改变边界' }
                ]
            }
        });
        writeChunks(`${nestedNoise}${JSON.stringify(outerResponse)}`, 2, () => finish(0));
        break;
    }
    case 'async-malformed-then-success':
        process.stdout.write('{"status":}');
        writeTextAndFinish(JSON.stringify({ status: 'success', result: { recovered: true } }));
        break;
    case 'async-utf8': {
        const utf8Response = JSON.stringify({ status: 'success', result: { text: '跨字节界面 🚀 {}' } });
        writeBufferChunks(Buffer.from(utf8Response, 'utf8'), 1, () => finish(0));
        break;
    }
    case 'async-no-reply-grace':
        setTimeout(() => finish(0), 140);
        break;
    case 'async-no-reply-exit':
        finish(0);
        break;
    case 'async-no-reply-success':
        writeTextAndFinish(JSON.stringify({ status: 'success', result: { noReply: false } }));
        break;
    case 'async-no-reply-error':
        writeTextAndFinish(JSON.stringify({ status: 'error', error: 'initial no-reply error' }));
        break;
    case 'async-hang':
        setInterval(() => {}, 1000);
        break;
    default:
        writeTextAndFinish(`unknown fixture action: ${action}`, 64, 'fixture action error\n');
        break;
}
