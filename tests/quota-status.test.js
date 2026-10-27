'use strict';

// Offline integration tests for the Claude quota status contract consumed by
// usageMonitor. The transport is injected; no real bridge, SSH, CLI, network
// or credential file is used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsageMonitorService } = require('../modules/usageMonitor');

function createClaudeService({ nowRef, transport, cacheTtlMs = 60_000 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-quota-status-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
        accounts: [{
            id: 'claude-main',
            provider: 'claude',
            label: 'Claude (Bridge)',
            baseUrl: 'http://127.0.0.1:8797',
            tokenEnv: 'TEST_CLAUDE_BRIDGE_TOKEN'
        }]
    }), 'utf8');
    return createUsageMonitorService({
        configPath: file,
        env: { TEST_CLAUDE_BRIDGE_TOKEN: 'bridge-secret-token' },
        cacheTtlMs,
        now: () => nowRef.value,
        httpTransport: transport
    });
}

async function claudeCard(service) {
    const snapshot = await service.getSnapshot({ period: 'today' });
    return snapshot.accounts.find((account) => account.id === 'claude-main');
}

test('Claude auth wait is classified separately and never fabricates quota', async () => {
    const nowRef = { value: Date.parse('2026-10-26T08:00:00.000Z') };
    const service = createClaudeService({
        nowRef,
        transport: async (req) => {
            assert.equal(req.url, 'http://127.0.0.1:8797/v1/quota');
            assert.equal(req.headers.Authorization, 'Bearer bridge-secret-token');
            return {
                status: 401,
                ok: false,
                data: {
                    object: 'claude.quota',
                    status: 'error',
                    error_code: 'credentials_missing',
                    error_stage: 'auth',
                    observed_at_ms: null,
                    checked_at_ms: nowRef.value,
                    subscription_type: null,
                    cache_hit: false,
                    stale: false,
                    utilization: null,
                    cooldown_until_ms: null,
                    retry_after_seconds: null,
                    last_error_code: null,
                    notice: 'upstream says token is invalid'
                }
            };
        }
    });

    const card = await claudeCard(service);
    assert.equal(card.status, 'error');
    assert.equal(card.errorCode, 'credentials_missing');
    assert.equal(card.errorStage, 'auth');
    assert.equal(card.observedAt, null);
    assert.deepEqual(card.windows, []);
    assert.equal(card.checkedAt, new Date(nowRef.value).toISOString());
    assert.equal(card.retryAfterSeconds, null);
    assert.equal(card.cooldownUntil, null);
    assert.match(card.notice, /等待官方 CLI 更新认证/);
    assert.match(card.notice, /暂无可信额度数据/);
    assert.doesNotMatch(card.notice, /余额耗尽|聊天不可用|upstream says/);
});

test('Claude usage failure exposes Retry-After without extending cooldown on polls', async () => {
    const nowRef = { value: Date.parse('2026-10-26T08:00:00.000Z') };
    const start = nowRef.value;
    const cooldownUntil = start + 60_000;
    let calls = 0;
    const service = createClaudeService({
        nowRef,
        cacheTtlMs: 120_000,
        transport: async () => {
            calls += 1;
            return {
                status: 502,
                ok: false,
                data: {
                    object: 'claude.quota',
                    status: 'error',
                    error_code: 'usage_http_429',
                    error_stage: 'usage',
                    observed_at_ms: null,
                    checked_at_ms: start,
                    subscription_type: null,
                    cache_hit: false,
                    stale: false,
                    utilization: null,
                    cooldown_until_ms: cooldownUntil,
                    retry_after_seconds: 60,
                    last_error_code: 'usage_http_429',
                    notice: '429 from upstream with a token-like secret'
                }
            };
        }
    });

    const first = await claudeCard(service);
    assert.equal(first.status, 'error');
    assert.equal(first.errorCode, 'usage_http_429');
    assert.equal(first.errorStage, 'usage');
    assert.equal(first.checkedAt, new Date(start).toISOString());
    assert.equal(first.cooldownUntil, new Date(cooldownUntil).toISOString());
    assert.equal(first.retryAfterSeconds, 60);
    assert.match(first.notice, /额度接口失败（usage_http_429）/);
    assert.match(first.notice, /下次允许查询：/);
    assert.doesNotMatch(first.notice, /token-like secret|429 from upstream/);

    nowRef.value = start + 20_000;
    const second = await claudeCard(service);
    assert.equal(calls, 1, 'panel polls within the account cache must not re-probe');
    assert.equal(second.retryAfterSeconds, 40, 'remaining seconds must decrease with time');
    assert.equal(second.cooldownUntil, new Date(cooldownUntil).toISOString());
    assert.match(second.notice, /下次允许查询：/);

    nowRef.value = cooldownUntil + 1_000;
    const third = await claudeCard(service);
    assert.equal(calls, 1);
    assert.equal(third.retryAfterSeconds, 0);
    assert.match(third.notice, /冷却已结束，等待下次刷新/);
});

test('Claude keeps last trusted quota stale and identifies an auth-related cooldown', async () => {
    const nowRef = { value: Date.parse('2026-10-26T08:00:00.000Z') };
    const observed = nowRef.value - 30_000;
    let mode = 'ok';
    const service = createClaudeService({
        nowRef,
        cacheTtlMs: 1_000,
        transport: async () => {
            if (mode === 'ok') {
                return {
                    status: 200,
                    ok: true,
                    data: {
                        object: 'claude.quota',
                        status: 'ok',
                        error_code: null,
                        observed_at_ms: observed,
                        checked_at_ms: observed,
                        subscription_type: 'pro',
                        cache_hit: false,
                        stale: false,
                        utilization: {
                            five_hour: {
                                utilization: 12,
                                resets_at: '2026-10-26T12:00:00.000Z'
                            },
                            seven_day: null,
                            seven_day_sonnet: null,
                            seven_day_opus: null
                        }
                    }
                };
            }
            return {
                status: 502,
                ok: false,
                data: {
                    object: 'claude.quota',
                    status: 'error',
                    error_code: 'quota_cooldown',
                    error_stage: 'guard',
                    observed_at_ms: null,
                    checked_at_ms: nowRef.value,
                    subscription_type: null,
                    cache_hit: false,
                    stale: false,
                    utilization: null,
                    cooldown_until_ms: nowRef.value + 3_600_000,
                    retry_after_seconds: 3_600,
                    last_error_code: 'usage_http_401',
                    notice: '<img src=x onerror=alert(1)> token=secret'
                }
            };
        }
    });

    const healthy = await claudeCard(service);
    assert.equal(healthy.status, 'ok');
    assert.equal(healthy.observedAt, new Date(observed).toISOString());
    assert.equal(healthy.windows.length, 1);

    mode = 'cooldown';
    nowRef.value += 5_000;
    const stale = await claudeCard(service);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.stale, true);
    assert.equal(stale.observedAt, new Date(observed).toISOString());
    assert.equal(stale.windows[0].remainingPercent, 88);
    assert.equal(stale.errorCode, 'quota_cooldown');
    assert.equal(stale.errorStage, 'guard');
    assert.equal(stale.lastErrorCode, 'usage_http_401');
    assert.equal(stale.retryAfterSeconds, 3_600);
    assert.match(stale.notice, /额度查询冷却中；认证待官方 CLI 更新/);
    assert.match(stale.notice, /最后观测：/);
    assert.match(stale.notice, /保留上次可信数据（stale）/);
    assert.doesNotMatch(stale.notice, /<img|token=secret|onerror/);
});

test('malformed Claude upstream metadata becomes a fixed, sanitized notice', async () => {
    const nowRef = { value: Date.parse('2026-10-26T08:00:00.000Z') };
    const service = createClaudeService({
        nowRef,
        transport: async () => ({
            status: 502,
            ok: false,
            data: {
                status: 'error',
                error_code: '<script>alert(1)</script>',
                error_stage: 'evil_stage',
                observed_at_ms: 'not-a-time',
                checked_at_ms: 'not-a-time',
                retry_after_seconds: '60',
                cooldown_until_ms: 'tomorrow',
                last_error_code: 'token=secret',
                notice: 'balance exhausted'
            }
        })
    });

    const card = await claudeCard(service);
    assert.equal(card.status, 'error');
    assert.equal(card.errorCode, 'UPSTREAM_ERROR');
    assert.equal(card.errorStage, null);
    assert.equal(card.observedAt, null);
    assert.deepEqual(card.windows, []);
    assert.equal(card.checkedAt, null);
    assert.equal(card.cooldownUntil, null);
    assert.equal(card.retryAfterSeconds, null);
    assert.equal(card.lastErrorCode, null);
    assert.match(card.notice, /额度接口失败（UPSTREAM_ERROR）/);
    assert.match(card.notice, /暂无可信额度数据/);
    assert.doesNotMatch(card.notice, /script|evil_stage|not-a-time|token=secret|balance exhausted|余额/);
});

function createSuccessfulClaudeService({ nowRef, observedAtMs, transport, cacheTtlMs = 0 }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-quota-stale-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({
        cpamp: { staleAfterMs: 30 * 60 * 1000 },
        accounts: [{
            id: 'claude-main',
            provider: 'claude',
            baseUrl: 'http://127.0.0.1:8797',
            tokenEnv: 'TEST_CLAUDE_BRIDGE_TOKEN'
        }]
    }), 'utf8');
    return createUsageMonitorService({
        configPath: file,
        env: { TEST_CLAUDE_BRIDGE_TOKEN: 'bridge-secret-token' },
        cacheTtlMs,
        now: () => nowRef.value,
        httpTransport: async () => ({
            status: 200,
            ok: true,
            data: {
                object: 'claude.quota',
                status: 'ok',
                observed_at_ms: typeof observedAtMs === 'function' ? observedAtMs() : observedAtMs,
                checked_at_ms: nowRef.value,
                subscription_type: 'pro',
                cache_hit: true,
                stale: false,
                utilization: {
                    five_hour: { utilization: 12, resets_at: '2026-10-26T12:00:00.000Z' },
                    seven_day: { utilization: 24, resets_at: '2026-11-01T00:00:00.000Z' }
                }
            }
        })
    });
}

test('first over-age Claude success keeps its observation and utilization as stale', async () => {
    const nowRef = { value: Date.parse('2026-10-26T08:00:00.000Z') };
    const observedAtMs = nowRef.value - 31 * 60 * 1000;
    const card = await claudeCard(createSuccessfulClaudeService({ nowRef, observedAtMs }));

    assert.equal(card.status, 'stale');
    assert.equal(card.stale, true);
    assert.equal(card.observedAt, new Date(observedAtMs).toISOString());
    assert.equal(card.checkedAt, new Date(nowRef.value).toISOString());
    assert.equal(card.cacheHit, true);
    assert.equal(card.errorCode, null);
    assert.equal(card.errorStage, null);
    assert.deepEqual(card.windows.map(({ id, remainingPercent }) => ({ id, remainingPercent })), [
        { id: 'five-hour', remainingPercent: 88 },
        { id: 'weekly', remainingPercent: 76 }
    ]);
    assert.match(card.notice, /缓存超龄/);
    assert.doesNotMatch(card.notice, /额度接口失败|CLAUDE_QUOTA_UNAVAILABLE/);
});

test('over-age Claude success after a last-good snapshot preserves the successful status metadata', async () => {
    const nowRef = { value: Date.parse('2026-10-26T08:00:00.000Z') };
    const observedAtMs = nowRef.value;
    const service = createSuccessfulClaudeService({ nowRef, observedAtMs: () => observedAtMs });

    const first = await claudeCard(service);
    assert.equal(first.status, 'ok');
    nowRef.value += 31 * 60 * 1000;

    const stale = await claudeCard(service);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.stale, true);
    assert.equal(stale.observedAt, new Date(observedAtMs).toISOString());
    assert.equal(stale.checkedAt, new Date(nowRef.value).toISOString());
    assert.equal(stale.errorCode, null);
    assert.equal(stale.errorStage, null);
    assert.deepEqual(stale.windows.map(({ id, remainingPercent }) => ({ id, remainingPercent })), [
        { id: 'five-hour', remainingPercent: 88 },
        { id: 'weekly', remainingPercent: 76 }
    ]);
});

test('Claude age threshold is inclusive and an expired reset marks the window stale', async () => {
    const nowRef = { value: Date.parse('2026-10-26T08:00:00.000Z') };
    const observedAtMs = nowRef.value - 30 * 60 * 1000;
    const service = createSuccessfulClaudeService({ nowRef, observedAtMs });

    const atBoundary = await claudeCard(service);
    assert.equal(atBoundary.status, 'ok');
    assert.equal(atBoundary.stale, false);
    assert.equal(atBoundary.errorCode, null);

    nowRef.value += 1;
    const overBoundary = await claudeCard(service);
    assert.equal(overBoundary.status, 'stale');
    assert.equal(overBoundary.stale, true);
    assert.equal(overBoundary.errorCode, null);
    assert.equal(overBoundary.observedAt, new Date(observedAtMs).toISOString());
    assert.equal(overBoundary.windows.length, 2);

    const expiredResetNow = { value: Date.parse('2026-10-26T08:00:00.000Z') };
    const expiredReset = createUsageMonitorService({
        configPath: (() => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-quota-reset-'));
            const file = path.join(dir, 'config.json');
            fs.writeFileSync(file, JSON.stringify({
                accounts: [{ id: 'claude-main', provider: 'claude', baseUrl: 'http://127.0.0.1:8797', tokenEnv: 'TEST_CLAUDE_BRIDGE_TOKEN' }]
            }), 'utf8');
            return file;
        })(),
        env: { TEST_CLAUDE_BRIDGE_TOKEN: 'bridge-secret-token' },
        cacheTtlMs: 0,
        now: () => expiredResetNow.value,
        httpTransport: async () => ({
            status: 200,
            ok: true,
            data: {
                status: 'ok',
                observed_at_ms: expiredResetNow.value - 1000,
                checked_at_ms: expiredResetNow.value,
                utilization: { five_hour: { utilization: 12, resets_at: '2026-10-26T07:59:59.999Z' } }
            }
        })
    });
    const resetCard = (await expiredReset.getSnapshot({ period: 'today' })).accounts
        .find((account) => account.id === 'claude-main');
    assert.equal(resetCard.status, 'stale');
    assert.equal(resetCard.errorCode, null);
    assert.equal(resetCard.windows[0].remainingPercent, 88);
});
