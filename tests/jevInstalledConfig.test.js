'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JevToolCallExp } = require('../modules/jevToolCallExp');

// No config/configPath override: exercise the configuration actually shipped.
function planner() {
    return new JevToolCallExp({
        env: {},
        jevClient: {
            isConfigured: () => false,
            async decide() {
                throw new Error('Installed-config tests must not contact a decision service');
            }
        }
    });
}

async function one(expression) {
    const calls = await planner().plan(expression, { args: { maid: 'Fixture' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.maid, 'Fixture');
    return calls[0];
}

test('installed configuration contains desktop, handoff and existing official routes', () => {
    const { categories } = planner().config;
    assert.equal(categories.desktop_control.defaultTool, 'screen_pilot');
    assert.equal(categories.desktop_control.tools.screen_pilot.plugin, 'ScreenPilot');
    assert.equal(categories.desktop_control.tools.desktop_remote.plugin, 'DesktopRemote');
    assert.equal(categories.daily_tools.tools.flowlock_handoff.plugin, 'TopicSponsor');
    assert.equal(categories.daily_tools.tools.music_controller.plugin, 'MusicController');
    assert.equal(categories.web_search.tools.vsearch.plugin, 'VSearch');
    assert.equal(categories.image_generation.tools.nanobanana.plugin, 'NanoBananaGen2');
});

test('installed desktop route plans a screenshot with process and format', async () => {
    const call = await one('请使用 {桌面操控} 截图 [进程:Example.exe] [PNG]');
    assert.equal(call.name, 'ScreenPilot');
    assert.equal(call.args.command, 'ScreenCapture');
    assert.equal(call.args.processName, 'Example.exe');
    assert.equal(call.args.format, 'png');
});

test('installed desktop route plans window listing without a click fallback', async () => {
    const call = await one('请使用 {桌面操控}，【列出窗口】');
    assert.equal(call.name, 'ScreenPilot');
    assert.equal(call.args.command, 'QueryWindows');
});

test('installed desktop route selects DesktopRemote for Dock', async () => {
    const call = await one('请使用 {桌面操控}，【查询Dock】');
    assert.equal(call.name, 'DesktopRemote');
    assert.equal(call.args.command, 'QueryDock');
});

test('installed wallpaper route accepts URL-only content without executing it', async () => {
    const url = 'https://example.invalid/fixture.png';
    const call = await one(`请使用 {桌面操控} 设置壁纸 [${url}]`);
    assert.equal(call.name, 'DesktopRemote');
    assert.equal(call.args.command, 'SetWallpaper');
    assert.equal(call.args.wallpaperSource, url);
});

test('installed current-music route queries lyrics instead of starting playback', async () => {
    const call = await one('读取当前音乐歌词。');
    assert.equal(call.name, 'MusicController');
    assert.equal(call.args.command, 'getCurrentLyrics');
    assert.equal(call.args.songname, undefined);
});

test('installed handoff route converts minutes and binds the explicit fixture topic', async () => {
    const call = await one('请使用 {日用工具} 中的 `交班`，为话题[topic_fixture_123]设置[3分钟]后的定时唤醒，醒来后【核验合成测试】。');
    assert.equal(call.name, 'TopicSponsor');
    assert.equal(call.args.command, 'AttachFlowlockToTopic');
    assert.equal(call.args.topic_id, 'topic_fixture_123');
    assert.equal(call.args.flowlock_heartbeat, '180');
    assert.equal(call.args.flowlock_prompt, '核验合成测试');
});

test('installed web route still uses the existing VSearch mapping', async () => {
    const call = await one('请使用 {联网搜索}，搜索【合成配置测试】。');
    assert.equal(call.name, 'VSearch');
    assert.equal(call.args.SearchMode, 'grounding');
});

test('installed handoff route refuses a missing topic instead of choosing memory search', async () => {
    await assert.rejects(
        planner().plan('请使用 {日用工具} 中的 `交班`，设置[180秒]后的定时唤醒，醒来后【核验合成测试】。'),
        /目标话题|话题 ID/
    );
});
