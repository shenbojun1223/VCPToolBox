'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsageMonitorService, resolvePeriodRange, validateLoopbackBaseUrl } = require('../modules/usageMonitor');
const newApiMonitorRoutes = require('../routes/admin/newapiMonitor');

function createTempConfigFile(obj) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-usage-monitor-'));
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    return { dir, file };
}

test('resolvePeriodRange validates period and computes Asia/Shanghai boundaries', () => {
    const nowMs = Date.parse('2026-10-22T09:00:00.000Z'); // 17:00 CST
    const today = resolvePeriodRange('today', { nowMs, timeZone: 'Asia/Shanghai' });
    assert.equal(today.key, 'today');
    assert.equal(today.start, '2026-10-21T16:00:00.000Z');
    assert.equal(today.end, '2026-10-22T09:00:00.000Z');

    const sevenDays = resolvePeriodRange('7d', { nowMs, timeZone: 'Asia/Shanghai' });
    assert.equal(sevenDays.key, '7d');
    assert.equal(sevenDays.start, '2026-10-15T16:00:00.000Z');

    const month = resolvePeriodRange('month', { nowMs, timeZone: 'Asia/Shanghai' });
    assert.equal(month.key, 'month');
    assert.equal(month.start, '2026-09-30T16:00:00.000Z');

    assert.throws(
        () => resolvePeriodRange('invalid', { nowMs }),
        (err) => err && err.status === 400 && err.code === 'INVALID_PERIOD'
    );
});

test('validateLoopbackBaseUrl enforces loopback and rejects embedded credentials', () => {
    assert.equal(validateLoopbackBaseUrl('http://127.0.0.1:18317'), 'http://127.0.0.1:18317');
    assert.equal(validateLoopbackBaseUrl('http://localhost:18317/sub'), 'http://localhost:18317');
    assert.throws(() => validateLoopbackBaseUrl('https://evil.example.com:18317'));
    assert.throws(() => validateLoopbackBaseUrl('http://user:pass@127.0.0.1:18317'));
});

test('returns 5 default accounts (Claude unsupported, others unconfigured) and unconfigured activity when config/env missing', async () => {
    const service = createUsageMonitorService({
        configPath: path.join(os.tmpdir(), 'non-existent-usage-config.json'),
        env: {},
        now: () => Date.parse('2026-10-22T09:00:00.000Z')
    });

    const snapshot = await service.getSnapshot({ period: 'today' });
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.accounts.length, 5);

    const byProvider = Object.fromEntries(snapshot.accounts.map(a => [a.provider, a]));
    assert.equal(byProvider.codex.status, 'unconfigured');
    assert.equal(byProvider.antigravity.status, 'unconfigured');
    assert.equal(byProvider.opencodego.status, 'unconfigured');
    assert.equal(byProvider.deepseek.status, 'unconfigured');
    assert.equal(byProvider.claude.status, 'unsupported');
    assert.match(byProvider.claude.notice, /订阅额度未接入/);

    assert.equal(snapshot.activity.status, 'unconfigured');
    assert.equal(snapshot.activity.coverage, 'newapi-only');
    assert.equal(snapshot.activity.totals.requests, null);
    assert.equal(snapshot.activity.totals.inputTokens, null);
    assert.equal(snapshot.activity.totals.cacheReadTokens, null);
});

test('aggregates CPAMP, OpenCodeGo (including 1% / 0.5% precision), DeepSeek multi-currency, and NewAPI logs with cache_tokens', async () => {
    const { file } = createTempConfigFile({
        timeZone: 'Asia/Shanghai',
        cpamp: {
            baseUrl: 'http://127.0.0.1:18317',
            tokenEnv: 'TEST_CPAMP_KEY'
        },
        accounts: [
            {
                id: 'codex-pool',
                provider: 'codex',
                label: 'Codex 主池',
                linkedChannels: ['gpt-ch-1', 'gpt-ch-2'],
                sharedPool: true,
                queryAccount: {
                    row_key: 'row-codex-1',
                    provider: 'codex',
                    auth_file_name: 'codex.json'
                }
            },
            {
                id: 'agy-pool',
                provider: 'antigravity',
                label: 'Antigravity',
                queryAccount: {
                    row_key: 'row-agy-1',
                    provider: 'antigravity',
                    auth_file_name: 'agy.json'
                }
            },
            {
                id: 'oc-go',
                provider: 'opencodego',
                label: 'OpenCode Go',
                tokenEnv: 'TEST_OC_KEY'
            },
            {
                id: 'ds-main',
                provider: 'deepseek',
                label: 'DeepSeek 官方',
                tokenEnv: 'TEST_DS_KEY'
            }
        ]
    });

    const nowMs = Date.parse('2026-10-22T09:00:00.000Z');
    const calls = [];

    const service = createUsageMonitorService({
        configPath: file,
        env: {
            TEST_CPAMP_KEY: 'cpamp-secret-token',
            TEST_OC_KEY: 'oc-secret-token',
            TEST_DS_KEY: 'ds-secret-token',
            NEWAPI_MONITOR_BASE_URL: 'http://127.0.0.1:3000',
            NEWAPI_MONITOR_ACCESS_TOKEN: 'newapi-secret-token',
            NEWAPI_MONITOR_API_USER_ID: '1'
        },
        now: () => nowMs,
        httpTransport: async (req) => {
            calls.push(req);
            if (req.url.endsWith('/v0/management/quota-snapshots/query')) {
                return {
                    status: 200,
                    ok: true,
                    data: {
                        generated_at_ms: nowMs,
                        items: [
                            {
                                row_key: 'row-codex-1',
                                provider: 'codex',
                                windows: [
                                    {
                                        provider_window_id: 'rate_limit:five_hour',
                                        window_kind: 'five_hour',
                                        observed_at_ms: nowMs - 120_000,
                                        cycle_end_ms: nowMs + 7200_000,
                                        used_percent: 32,
                                        cycle_state: 'active'
                                    },
                                    {
                                        provider_window_id: 'rate_limit:weekly',
                                        window_kind: 'weekly',
                                        observed_at_ms: nowMs - 120_000,
                                        cycle_end_ms: nowMs + 172800_000,
                                        used_percent: 69,
                                        cycle_state: 'active'
                                    }
                                ]
                            },
                            {
                                row_key: 'row-agy-1',
                                provider: 'antigravity',
                                windows: [
                                    {
                                        provider_window_id: 'bucket:claude',
                                        window_kind: 'five_hour',
                                        model_scope_kind: 'family',
                                        model_scope_key: 'claude_sonnet',
                                        observed_at_ms: nowMs - 60_000,
                                        cycle_end_ms: nowMs + 3600_000,
                                        remaining_percent: 0,
                                        cycle_state: 'active'
                                    }
                                ]
                            }
                        ]
                    }
                };
            }
            if (req.url === 'https://opencode.ai/zen/go/v1/usage') {
                return {
                    status: 200,
                    ok: true,
                    data: {
                        usage: {
                            rolling: { percent: 1, resetsAt: '2026-10-22T12:00:00.000Z' },
                            weekly: { percent: 0.5, resetsAt: '2026-10-25T00:00:00.000Z' },
                            monthly: { percent: 25, resetsAt: '2026-11-01T00:00:00.000Z' }
                        }
                    }
                };
            }
            if (req.url === 'https://api.deepseek.com/user/balance') {
                return {
                    status: 200,
                    ok: true,
                    data: {
                        is_available: true,
                        balance_infos: [
                            { currency: 'CNY', total_balance: '128.50', granted_balance: '0.00', topped_up_balance: '128.50' },
                            { currency: 'USD', total_balance: '15.25', granted_balance: '5.00', topped_up_balance: '10.25' }
                        ]
                    }
                };
            }
            if (req.url.includes('/api/log/?')) {
                return {
                    status: 200,
                    ok: true,
                    data: {
                        success: true,
                        data: {
                            total: 2,
                            items: [
                                {
                                    created_at: Math.floor(nowMs / 1000) - 600,
                                    model_name: 'claude-vcp-sonnet',
                                    prompt_tokens: 10545,
                                    completion_tokens: 120,
                                    other: JSON.stringify({ cache_tokens: 10308 })
                                },
                                {
                                    created_at: Math.floor(nowMs / 1000) - 300,
                                    model_name: 'gpt-6-luna',
                                    prompt_tokens: 2000,
                                    completion_tokens: 300,
                                    other: JSON.stringify({ cache_tokens: 0 })
                                }
                            ]
                        }
                    }
                };
            }
            throw new Error(`Unexpected URL: ${req.url}`);
        }
    });

    const snapshot = await service.getSnapshot({ period: 'today' });
    const byId = Object.fromEntries(snapshot.accounts.map(a => [a.id, a]));

    // Codex windows kept separate, not averaged, converted to remainingPercent
    assert.equal(byId['codex-pool'].status, 'ok');
    assert.equal(byId['codex-pool'].sharedPool, true);
    assert.equal(byId['codex-pool'].windows.length, 2);
    assert.equal(byId['codex-pool'].windows[0].remainingPercent, 68);
    assert.equal(byId['codex-pool'].windows[1].remainingPercent, 31);

    // Real 0% remaining is preserved as 0 (not null)
    assert.equal(byId['agy-pool'].status, 'ok');
    assert.equal(byId['agy-pool'].windows[0].remainingPercent, 0);
    assert.equal(byId['agy-pool'].windows[0].usedPercent, 100);

    // OpenCode Go preserves 1% used -> 99% remaining, 0.5% used -> 99.5% remaining
    assert.equal(byId['oc-go'].status, 'ok');
    assert.equal(byId['oc-go'].windows[0].remainingPercent, 99);
    assert.equal(byId['oc-go'].windows[1].remainingPercent, 99.5);
    assert.equal(byId['oc-go'].windows[2].remainingPercent, 75);

    // DeepSeek multi-currency kept separate, never summed
    assert.equal(byId['ds-main'].status, 'ok');
    assert.equal(byId['ds-main'].balances.length, 2);
    assert.deepEqual(byId['ds-main'].balances[0], { currency: 'CNY', available: 128.5, granted: 0, toppedUp: 128.5 });
    assert.deepEqual(byId['ds-main'].balances[1], { currency: 'USD', available: 15.25, granted: 5, toppedUp: 10.25 });

    // Activity totals: totalTokens = inputTokens + outputTokens (cacheReadTokens is subset of prompt_tokens, not double-added)
    assert.equal(snapshot.activity.status, 'ok');
    assert.equal(snapshot.activity.complete, true);
    assert.equal(snapshot.activity.truncated, false);
    assert.deepEqual(snapshot.activity.totals, {
        requests: 2,
        inputTokens: 12545,
        outputTokens: 420,
        cacheReadTokens: 10308,
        totalTokens: 12965
    });

    // No secrets leaked in serialized response
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes('cpamp-secret-token'), false);
    assert.equal(serialized.includes('oc-secret-token'), false);
    assert.equal(serialized.includes('ds-secret-token'), false);
    assert.equal(serialized.includes('newapi-secret-token'), false);

    // Calling period=7d reuses cached account snapshot without re-querying providers
    const callCountAfterToday = calls.length;
    await service.getSnapshot({ period: '7d' });
    const providerCallsAfter7d = calls.slice(callCountAfterToday).filter(c => !c.url.includes('/api/log/'));
    assert.equal(providerCallsAfter7d.length, 0);
});

test('singleflight deduplicates concurrent requests and preserves last-good with stale status on failure', async () => {
    const { file } = createTempConfigFile({
        accounts: [
            {
                id: 'ds-1',
                provider: 'deepseek',
                tokenEnv: 'DS_KEY'
            }
        ]
    });

    let currentNow = Date.parse('2026-10-22T09:00:00.000Z');
    let dsCalls = 0;
    let shouldFail = false;

    const service = createUsageMonitorService({
        configPath: file,
        env: { DS_KEY: 'secret-1' },
        cacheTtlMs: 1000,
        now: () => currentNow,
        httpTransport: async (req) => {
            if (req.url === 'https://api.deepseek.com/user/balance') {
                dsCalls += 1;
                await new Promise(r => setTimeout(r, 20));
                if (shouldFail) {
                    const err = new Error('timeout');
                    err.code = 'UPSTREAM_TIMEOUT';
                    throw err;
                }
                return {
                    status: 200,
                    ok: true,
                    data: {
                        is_available: true,
                        balance_infos: [{ currency: 'CNY', total_balance: '88.00', granted_balance: '0', topped_up_balance: '88.00' }]
                    }
                };
            }
            throw new Error('unexpected');
        }
    });

    const [s1, s2] = await Promise.all([
        service.getSnapshot({ period: 'today' }),
        service.getSnapshot({ period: 'today' })
    ]);
    assert.equal(dsCalls, 1);
    const firstObservedAt = s1.accounts.find(a => a.id === 'ds-1').observedAt;
    assert.equal(s2.accounts.find(a => a.id === 'ds-1').observedAt, firstObservedAt);

    // Advance clock past TTL and fail upstream -> should return stale with original observedAt
    currentNow += 5000;
    shouldFail = true;
    const s3 = await service.getSnapshot({ period: 'today' });
    const dsAcct = s3.accounts.find(a => a.id === 'ds-1');
    assert.equal(dsAcct.status, 'stale');
    assert.equal(dsAcct.observedAt, firstObservedAt);
    assert.equal(dsAcct.balances[0].available, 88);
});

test('rejects plaintext secret fields in config and marks past reset windows as stale without resetting to 100%', async () => {
    const { file } = createTempConfigFile({
        cpamp: {
            baseUrl: 'http://127.0.0.1:18317',
            tokenEnv: 'CPAMP_KEY'
        },
        accounts: [
            {
                id: 'bad-secret',
                provider: 'deepseek',
                apiKey: 'sk-plaintext-forbidden'
            },
            {
                id: 'expired-win',
                provider: 'codex',
                queryAccount: {
                    row_key: 'row-exp',
                    provider: 'codex',
                    auth_file_name: 'codex.json'
                }
            }
        ]
    });

    const nowMs = Date.parse('2026-10-22T09:00:00.000Z');
    const service = createUsageMonitorService({
        configPath: file,
        env: { CPAMP_KEY: 'cpamp-ok' },
        now: () => nowMs,
        httpTransport: async () => ({
            status: 200,
            ok: true,
            data: {
                items: [
                    {
                        row_key: 'row-exp',
                        provider: 'codex',
                        windows: [
                            {
                                provider_window_id: 'five_hour',
                                window_kind: 'five_hour',
                                observed_at_ms: nowMs - 600_000,
                                cycle_end_ms: nowMs - 60_000, // already past reset!
                                used_percent: 95
                            }
                        ]
                    }
                ]
            }
        })
    });

    const snapshot = await service.getSnapshot({ period: 'today' });
    const badAcct = snapshot.accounts.find(a => a.id === 'bad-secret');
    assert.equal(badAcct.status, 'error');
    assert.equal(badAcct.errorCode, 'INSECURE_CONFIG_REJECTED');

    const expAcct = snapshot.accounts.find(a => a.id === 'expired-win');
    assert.equal(expAcct.status, 'stale');
    assert.equal(expAcct.windows[0].remainingPercent, 5); // kept at 5%, never auto-reset to 100%
});

test('marks NewAPI activity truncated=true and complete=false when total exceeds fetched log items', async () => {
    const nowMs = Date.parse('2026-10-22T09:00:00.000Z');
    const service = createUsageMonitorService({
        configPath: path.join(os.tmpdir(), 'missing-cfg.json'),
        env: {
            NEWAPI_MONITOR_BASE_URL: 'http://127.0.0.1:3000',
            NEWAPI_MONITOR_ACCESS_TOKEN: 'tok',
            NEWAPI_MONITOR_API_USER_ID: '1'
        },
        now: () => nowMs,
        httpTransport: async () => ({
            status: 200,
            ok: true,
            data: {
                success: true,
                data: {
                    total: 25000,
                    items: [
                        {
                            created_at: Math.floor(nowMs / 1000) - 60,
                            model_name: 'gpt-6-luna',
                            prompt_tokens: 100,
                            completion_tokens: 50
                        }
                    ]
                }
            }
        })
    });

    const snapshot = await service.getSnapshot({ period: 'today' });
    assert.equal(snapshot.activity.status, 'ok');
    assert.equal(snapshot.activity.truncated, true);
    assert.equal(snapshot.activity.complete, false);
    assert.equal(snapshot.activity.totals.cacheReadTokens, null);
});

test('route mount preserves existing newapi-monitor endpoints and serves /usage-monitor/snapshot', async () => {
    const router = newApiMonitorRoutes({
        usageMonitorService: {
            async getSnapshot({ period }) {
                if (period === 'bad') {
                    const err = new Error('无效的 period 参数');
                    err.status = 400;
                    throw err;
                }
                return { schemaVersion: 1, period: { key: period } };
            }
        }
    });

    const routePaths = router.stack
        .filter(layer => layer.route)
        .map(layer => layer.route.path);

    assert.deepEqual(routePaths.sort(), [
        '/newapi-monitor/models',
        '/newapi-monitor/summary',
        '/newapi-monitor/trend',
        '/usage-monitor/snapshot'
    ]);
});
test('queries Claude Bridge /v1/quota when configured, converts utilization to remainingPercent, and preserves last-good on error', async () => {
    const { file } = createTempConfigFile({
        accounts: [
            {
                id: 'claude-bridge-main',
                provider: 'claude',
                label: 'Claude (Bridge)',
                scopeLabel: 'Pro 订阅',
                linkedChannels: ['vcp-claude-sonnet-dedicated (#22)'],
                sharedPool: true,
                baseUrl: 'http://127.0.0.1:8797',
                tokenEnv: 'TEST_CLAUDE_BRIDGE_TOKEN'
            }
        ]
    });

    let currentNow = Date.parse('2026-10-22T15:50:00.000Z');
    let shouldFail = false;

    const service = createUsageMonitorService({
        configPath: file,
        env: {
            TEST_CLAUDE_BRIDGE_TOKEN: 'bridge-secret-token'
        },
        cacheTtlMs: 1000,
        now: () => currentNow,
        httpTransport: async (req) => {
            if (req.url === 'http://127.0.0.1:8797/v1/quota') {
                assert.equal(req.headers.Authorization, 'Bearer bridge-secret-token');
                if (shouldFail) {
                    return {
                        status: 502,
                        ok: false,
                        data: { status: 'error', error_code: 'upstream_unreachable' }
                    };
                }
                return {
                    status: 200,
                    ok: true,
                    data: {
                        object: 'claude.quota',
                        status: 'ok',
                        error_code: null,
                        observed_at_ms: currentNow - 30_000,
                        subscription_type: 'pro',
                        cache_hit: true,
                        utilization: {
                            five_hour: {
                                utilization: 1.0,
                                resets_at: '2026-10-22T21:20:00.000Z'
                            },
                            seven_day: {
                                utilization: 15.0,
                                resets_at: '2026-10-26T09:00:00.000Z'
                            },
                            seven_day_sonnet: null,
                            seven_day_opus: null
                        }
                    }
                };
            }
            throw new Error(`Unexpected URL: ${req.url}`);
        }
    });

    const s1 = await service.getSnapshot({ period: 'today' });
    const claude1 = s1.accounts.find(a => a.id === 'claude-bridge-main');
    assert.equal(claude1.status, 'ok');
    assert.equal(claude1.source, 'claude-bridge');
    assert.equal(claude1.windows.length, 2);
    assert.deepEqual(claude1.windows[0], {
        id: 'five-hour',
        label: '五小时',
        remainingPercent: 99,
        usedPercent: 1,
        resetsAt: '2026-10-22T21:20:00.000Z'
    });
    assert.deepEqual(claude1.windows[1], {
        id: 'weekly',
        label: '周度',
        remainingPercent: 85,
        usedPercent: 15,
        resetsAt: '2026-10-26T09:00:00.000Z'
    });

    currentNow += 5000;
    shouldFail = true;
    const s2 = await service.getSnapshot({ period: 'today' });
    const claude2 = s2.accounts.find(a => a.id === 'claude-bridge-main');
    assert.equal(claude2.status, 'stale');
    assert.equal(claude2.windows[0].remainingPercent, 99);
    assert.equal(claude2.windows[1].remainingPercent, 85);
});
