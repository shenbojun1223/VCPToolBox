'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JevToolCallExp } = require('../modules/jevToolCallExp');

function planner() {
    return new JevToolCallExp({
        configPath: path.join(__dirname, '../ToolConfigs/jev_tool_call_exp.json'),
        decisionPromptPath: path.join(__dirname, '../TVStxt/JevToolCallDecision.txt'),
        jevClient: {
            isConfigured: () => false,
            async decide() {
                throw new Error('Desktop planning must not call an external decision service');
            }
        }
    });
}

async function one(expression, inherited = {}) {
    const calls = await planner().plan(expression, inherited);
    assert.equal(calls.length, 1);
    return calls[0];
}

test('desktop screenshot accepts constraints without primary content', async () => {
    const call = await one('请使用 {桌面操控} 截图 [进程:Example.exe] [PNG]');
    assert.equal(call.name, 'ScreenPilot');
    assert.equal(call.args.command, 'ScreenCapture');
    assert.equal(call.args.processName, 'Example.exe');
    assert.equal(call.args.format, 'png');
});

test('desktop window listing has no accidental click fallback', async () => {
    const call = await one('请使用 {桌面操控}，【列出窗口】');
    assert.equal(call.name, 'ScreenPilot');
    assert.equal(call.args.command, 'QueryWindows');
});

test('input payload containing action words stays an input payload', async () => {
    const call = await one('请使用 {桌面操控}，在[窗口:记事本]中【输入】【不要点击，也不要截图】并[回车]');
    assert.equal(call.name, 'ScreenPilot');
    assert.equal(call.args.command, 'TypeText');
    assert.equal(call.args.text, '不要点击，也不要截图');
    assert.equal(call.args.windowTitle, '记事本');
    assert.equal(call.args.enter, 'true');
});

test('explicit OCR click preserves selector and verification constraint', async () => {
    const call = await one('请使用 {桌面操控}，【点击】【接受】[窗口:测试窗口][OCR][后台][验证:完成]');
    assert.equal(call.name, 'ScreenPilot');
    assert.equal(call.args.command, 'ClickText');
    assert.equal(call.args.text, '接受');
    assert.equal(call.args.windowTitle, '测试窗口');
    assert.equal(call.args.background, 'true');
    assert.equal(call.args.verifyText, '完成');
});

test('coordinate-only request maps to ClickAt', async () => {
    const call = await one('请使用 {桌面操控} 点击 [坐标:12,34][相对窗口]');
    assert.equal(call.name, 'ScreenPilot');
    assert.equal(call.args.command, 'ClickAt');
    assert.equal(call.args.x, '12');
    assert.equal(call.args.y, '34');
    assert.equal(call.args.relativeToWindow, 'true');
});

test('Dock query selects DesktopRemote rather than ScreenPilot', async () => {
    const call = await one('请使用 {桌面操控}，【查询Dock】');
    assert.equal(call.name, 'DesktopRemote');
    assert.equal(call.args.command, 'QueryDock');
});

test('URL-only wallpaper payload remains supported beside upstream third-party rules', async () => {
    const source = 'https://example.invalid/wallpaper.png';
    const call = await one(`请使用 {桌面操控} 设置壁纸 [${source}]`);
    assert.equal(call.name, 'DesktopRemote');
    assert.equal(call.args.command, 'SetWallpaper');
    assert.equal(call.args.wallpaperSource, source);
});

test('desktop planning preserves caller identity and scheduling metadata', async () => {
    const call = await one('请使用 {桌面操控}，【列出窗口】', {
        args: { maid: 'Kerr', timely_contact: '2027-01-01-10:00' }
    });
    assert.equal(call.name, 'ScreenPilot');
    assert.equal(call.args.maid, 'Kerr');
    assert.equal(call.args.timely_contact, '2027-01-01-10:00');
});