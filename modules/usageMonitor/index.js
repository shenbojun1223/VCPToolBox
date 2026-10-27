'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const VALID_PERIODS = new Set(['today', '7d', 'month']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const FORBIDDEN_SECRET_KEYS = new Set([
    'apiKey', 'api_key', 'apikey',
    'token', 'accessToken', 'access_token',
    'password', 'passwd', 'secret', 'clientSecret', 'cookie'
]);
const DEFAULT_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 1000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_LOG_PAGES = 200;
const CPAMP_TOKEN_PLACEHOLDER = ['$', 'TOKEN', '$'].join('');

function createError(message, code, status = 500) {
    const err = new Error(message);
    err.code = code;
    err.status = status;
    return err;
}

function roundPercent(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const clamped = Math.max(0, Math.min(100, value));
    return Number(clamped.toFixed(4));
}

function parseFiniteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

const CLAUDE_QUOTA_STAGES = new Set([
    'auth', 'residential', 'account', 'cache', 'usage', 'service', 'guard',
    'local', 'probe', 'transport'
]);
const CLAUDE_QUOTA_REMOTE_CODES = new Set([
    'auth_required', 'credentials_untrusted', 'credentials_missing',
    'credential_expiry_invalid', 'account_identity_missing',
    'account_identity_invalid', 'residential_proxy_config_invalid',
    'local_probe_failed', 'local_file_untrusted', 'local_file_oversize',
    'local_file_invalid', 'local_file_missing', 'cache_missing',
    'invalid_payload', 'usage_payload_invalid', 'usage_proxy_request_failed',
    'usage_response_oversize', 'usage_endpoint_refused', 'refresh_token_missing',
    'credentials_changed', 'credentials_changed_after_refresh',
    'credentials_persist_failed', 'refresh_payload_invalid',
    'refresh_proxy_request_failed', 'refresh_response_oversize',
    'quota_cooldown', 'quota_cooldown_invalid', 'quota_cli_active',
    'quota_service_busy', 'quota_guard_failed', 'quota_probe_timeout',
    'live_not_enabled', 'ssh_config_invalid', 'ssh_spawn_failed',
    'ssh_transport_error', 'output_overflow', 'invalid_probe_output',
    'invalid_probe_json', 'invalid_probe_shape', 'probe_error',
    'pending_probe', 'legacy_cooldown', 'success_interval'
]);
const CLAUDE_QUOTA_FIXED_CODES = new Set(['UPSTREAM_ERROR', 'CLAUDE_QUOTA_UNAVAILABLE']);
const CLAUDE_QUOTA_HTTP_RE = /^(?:usage|refresh)_http_[1-5][0-9]{2}$/;
const CLAUDE_WINDOW_DEFS = [
    { key: 'five_hour', id: 'five-hour', label: '五小时' },
    { key: 'seven_day', id: 'weekly', label: '周度' },
    { key: 'seven_day_sonnet', id: 'weekly-sonnet', label: 'Sonnet (周)' },
    { key: 'seven_day_opus', id: 'weekly-opus', label: 'Opus (周)' }
];
const CLAUDE_MAX_SAFE_MS = 8_640_000_000_000_000;

function safeClaudeStatusCode(value) {
    if (typeof value !== 'string') return null;
    if (CLAUDE_QUOTA_REMOTE_CODES.has(value) || CLAUDE_QUOTA_FIXED_CODES.has(value)
        || CLAUDE_QUOTA_HTTP_RE.test(value)) return value;
    return null;
}

function claudeStageForCode(code) {
    if (typeof code !== 'string') return null;
    if (code.startsWith('usage_')) return 'usage';
    if (/^(?:refresh_|credential_|credentials_|auth_)/.test(code)) return 'auth';
    if (code.startsWith('account_')) return 'account';
    if (code.startsWith('residential_')) return 'residential';
    if (code.startsWith('local_') || code.startsWith('cache_')) return 'local';
    if (/^(?:ssh_|invalid_probe|output_)/.test(code) || code === 'quota_probe_timeout') return 'transport';
    if (code === 'live_not_enabled' || code === 'quota_cli_active'
        || code === 'quota_service_busy') return 'service';
    if (code === 'invalid_payload' || code === 'probe_error') return 'probe';
    return CLAUDE_QUOTA_REMOTE_CODES.has(code) ? 'guard' : null;
}

function safeClaudeStage(value, code) {
    if (CLAUDE_QUOTA_STAGES.has(value)) return value;
    return claudeStageForCode(code);
}

function safeClaudeTimeMs(value) {
    return Number.isSafeInteger(value) && value > 0 && value <= CLAUDE_MAX_SAFE_MS ? value : null;
}

function safeClaudeRetrySeconds(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 365 * 24 * 60 * 60
        ? value : null;
}

function claudeIso(ms) {
    const safe = safeClaudeTimeMs(ms);
    return safe === null ? null : new Date(safe).toISOString();
}

function safeClaudeReset(value) {
    return typeof value === 'string' && value.length <= 64
        && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function buildClaudeWindows(utilRoot, nowMs) {
    const windows = [];
    let staleWindow = false;
    if (!utilRoot || typeof utilRoot !== 'object' || Array.isArray(utilRoot)) {
        return { windows, staleWindow };
    }
    for (const def of CLAUDE_WINDOW_DEFS) {
        const item = utilRoot[def.key];
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const usedPct = parseFiniteNumber(item.utilization ?? item.percent ?? item.usedPercent);
        const remPct = parseFiniteNumber(item.remainingPercent);
        let remainingPercent = null;
        let usedPercent = null;
        if (remPct !== null) {
            remainingPercent = roundPercent(remPct);
            usedPercent = roundPercent(100 - remainingPercent);
        } else if (usedPct !== null) {
            usedPercent = roundPercent(usedPct);
            remainingPercent = roundPercent(100 - usedPercent);
        } else {
            continue;
        }
        const resetsAt = safeClaudeReset(item.resets_at ?? item.resetsAt);
        if (resetsAt) {
            const resetMs = Date.parse(resetsAt);
            if (!Number.isFinite(resetMs) || resetMs <= nowMs) staleWindow = true;
        }
        windows.push({ id: def.id, label: def.label, remainingPercent, usedPercent, resetsAt });
    }
    return { windows, staleWindow };
}

function readClaudeQuotaMeta(payload, fallbackCode) {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const observedAtMs = safeClaudeTimeMs(source.observed_at_ms);
    const checkedAtMs = safeClaudeTimeMs(source.checked_at_ms);
    const retryAfterSeconds = safeClaudeRetrySeconds(source.retry_after_seconds);
    let cooldownUntilMs = safeClaudeTimeMs(source.cooldown_until_ms);
    if (cooldownUntilMs === null && checkedAtMs !== null
        && retryAfterSeconds !== null && retryAfterSeconds > 0) {
        cooldownUntilMs = checkedAtMs + retryAfterSeconds * 1000;
    }
    const errorCode = safeClaudeStatusCode(source.error_code) || fallbackCode;
    return {
        errorCode,
        errorStage: safeClaudeStage(source.error_stage, errorCode),
        lastErrorCode: safeClaudeStatusCode(source.last_error_code),
        observedAtMs,
        checkedAtMs,
        cooldownUntilMs,
        retryAfterSeconds,
        cacheHit: source.cache_hit === true,
        stale: source.stale === true,
        utilization: source.utilization && typeof source.utilization === 'object'
            && !Array.isArray(source.utilization) ? source.utilization : null,
        subscriptionType: typeof source.subscription_type === 'string'
            && /^[a-z0-9_-]{1,32}$/.test(source.subscription_type)
            ? source.subscription_type : null
    };
}

function claudeQuotaNotice(meta, hasTrustedData, nowMs) {
    let head;
    if (meta.errorCode === 'quota_cooldown') {
        const reason = safeClaudeStatusCode(meta.lastErrorCode);
        const authReason = reason !== null && (reason === 'usage_http_401'
            || /^(?:auth_|credential_|credentials_|refresh_)/.test(reason));
        if (reason && reason.startsWith('refresh_')) {
            head = `额度查询冷却中；上次认证刷新失败（${reason}），不代表当前认证状态`;
        } else if (authReason) {
            head = '额度查询冷却中；认证待官方 CLI 更新';
        } else {
            head = reason ? `额度查询冷却中（上次原因：${reason}）` : '额度查询冷却中';
        }
    } else if (typeof meta.errorCode === 'string' && meta.errorCode.startsWith('refresh_')) {
        head = `上次认证刷新失败（${meta.errorCode}），不代表当前认证状态`;
    } else if (meta.errorStage === 'auth' || meta.errorCode === 'auth_required'
        || meta.errorCode === 'usage_http_401' || meta.errorCode === 'credentials_untrusted') {
        head = '等待官方 CLI 更新认证';
    } else if (meta.errorCode === 'quota_cli_active') {
        head = 'Claude CLI 正在运行，额度查询暂缓';
    } else if (meta.errorCode === 'quota_service_busy') {
        head = 'Bridge 正在执行其他任务，额度查询暂缓';
    } else if (meta.errorStage === 'usage' || CLAUDE_QUOTA_HTTP_RE.test(meta.errorCode || '')
        || CLAUDE_QUOTA_FIXED_CODES.has(meta.errorCode)) {
        head = meta.errorCode ? `额度接口失败（${meta.errorCode}）` : '额度接口失败';
    } else {
        head = meta.errorCode ? `额度状态暂不可用（${meta.errorCode}）` : '额度状态暂不可用';
    }
    const details = [head];
    const observedIso = claudeIso(meta.observedAtMs);
    if (observedIso) details.push(`最后观测：${observedIso}`);
    const checkedIso = claudeIso(meta.checkedAtMs);
    if (checkedIso) details.push(`最近检查：${checkedIso}`);
    if (meta.cooldownUntilMs !== null) {
        const cooldownIso = claudeIso(meta.cooldownUntilMs);
        if (meta.cooldownUntilMs > nowMs) {
            details.push(`下次允许查询：${cooldownIso}`);
        } else {
            details.push('冷却已结束，等待下次刷新');
        }
    } else if (meta.retryAfterSeconds !== null && meta.retryAfterSeconds > 0) {
        details.push(`约 ${meta.retryAfterSeconds} 秒后可再查询`);
    }
    details.push(hasTrustedData ? '保留上次可信数据（stale）' : '暂无可信额度数据');
    return details.join('；');
}

function refreshClaudeStatusCard(account, nowMs) {
    if (!account || account.provider !== 'claude' || !account.errorCode) return account;
    let cooldownUntilMs = null;
    if (typeof account.cooldownUntil === 'string') {
        const parsed = Date.parse(account.cooldownUntil);
        if (Number.isFinite(parsed)) cooldownUntilMs = safeClaudeTimeMs(parsed);
    }
    let retryAfterSeconds = safeClaudeRetrySeconds(account.retryAfterSeconds);
    if (cooldownUntilMs !== null) {
        retryAfterSeconds = Math.max(0, Math.ceil((cooldownUntilMs - nowMs) / 1000));
    }
    const meta = {
        errorCode: safeClaudeStatusCode(account.errorCode) || 'CLAUDE_QUOTA_UNAVAILABLE',
        errorStage: safeClaudeStage(account.errorStage, account.errorCode),
        lastErrorCode: safeClaudeStatusCode(account.lastErrorCode),
        observedAtMs: typeof account.observedAt === 'string' ? Date.parse(account.observedAt) : null,
        checkedAtMs: typeof account.checkedAt === 'string' ? Date.parse(account.checkedAt) : null,
        cooldownUntilMs,
        retryAfterSeconds
    };
    const hasTrustedData = Array.isArray(account.windows) && account.windows.length > 0
        && meta.observedAtMs !== null;
    return {
        ...account,
        retryAfterSeconds,
        notice: claudeQuotaNotice(meta, hasTrustedData, nowMs)
    };
}

function validateLoopbackBaseUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
        throw createError('CPAMP baseUrl 不能为空', 'INVALID_CPAMP_URL', 400);
    }
    let parsed;
    try {
        parsed = new URL(rawUrl.trim());
    } catch (_) {
        throw createError('CPAMP baseUrl 格式非法', 'INVALID_CPAMP_URL', 400);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw createError('CPAMP baseUrl 仅支持 http/https', 'INVALID_CPAMP_URL', 400);
    }
    if (parsed.username || parsed.password) {
        throw createError('CPAMP baseUrl 禁止内嵌凭据', 'INVALID_CPAMP_URL', 400);
    }
    if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
        throw createError('CPAMP baseUrl 仅允许本机回环地址', 'INVALID_CPAMP_URL', 400);
    }
    return `${parsed.protocol}//${parsed.host}`;
}

function getTimeZoneOffsetMs(utcMs, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    const parts = Object.fromEntries(
        dtf.formatToParts(new Date(utcMs)).map(p => [p.type, p.value])
    );
    const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
    const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        hour,
        Number(parts.minute),
        Number(parts.second)
    );
    return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function resolvePeriodRange(rawPeriod = 'today', { nowMs = Date.now(), timeZone = 'Asia/Shanghai' } = {}) {
    const key = typeof rawPeriod === 'string' && rawPeriod.trim()
        ? rawPeriod.trim().toLowerCase()
        : 'today';

    if (!VALID_PERIODS.has(key)) {
        throw createError('无效的统计周期参数，仅支持 today、7d、month。', 'INVALID_PERIOD', 400);
    }

    const offsetMs = getTimeZoneOffsetMs(nowMs, timeZone);
    const localDate = new Date(nowMs + offsetMs);
    const year = localDate.getUTCFullYear();
    const month = localDate.getUTCMonth();
    const day = localDate.getUTCDate();

    let startLocalUtcMs;
    if (key === 'today') {
        startLocalUtcMs = Date.UTC(year, month, day, 0, 0, 0, 0);
    } else if (key === '7d') {
        startLocalUtcMs = Date.UTC(year, month, day - 6, 0, 0, 0, 0);
    } else {
        startLocalUtcMs = Date.UTC(year, month, 1, 0, 0, 0, 0);
    }

    const startUtcMs = startLocalUtcMs - getTimeZoneOffsetMs(startLocalUtcMs - offsetMs, timeZone);

    return {
        key,
        start: new Date(startUtcMs).toISOString(),
        end: new Date(nowMs).toISOString(),
        timeZone,
        startTimestamp: Math.floor(startUtcMs / 1000),
        endTimestamp: Math.floor(nowMs / 1000)
    };
}

async function defaultHttpTransport({ url, method = 'GET', headers = {}, body = undefined, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('UPSTREAM_TIMEOUT')), timeoutMs);
    try {
        const res = await fetch(url, {
            method,
            headers,
            body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
            redirect: 'error',
            signal: controller.signal
        });
        const text = await res.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
            throw createError('上游响应体积超出安全上限', 'RESPONSE_TOO_LARGE', 502);
        }
        let data = null;
        if (text.trim()) {
            try {
                data = JSON.parse(text);
            } catch (_) {
                data = null;
            }
        }
        return {
            status: res.status,
            ok: res.ok,
            data
        };
    } finally {
        clearTimeout(timer);
    }
}

function hasForbiddenSecretField(obj) {
    if (!obj || typeof obj !== 'object') return false;
    for (const [k, v] of Object.entries(obj)) {
        if (FORBIDDEN_SECRET_KEYS.has(k) && v !== undefined && v !== null && String(v).trim() !== '') {
            return true;
        }
        if (v && typeof v === 'object' && !Array.isArray(v) && hasForbiddenSecretField(v)) {
            return true;
        }
    }
    return false;
}

function buildDefaultAccounts() {
    return [
        {
            id: 'default-codex',
            provider: 'codex',
            label: 'GPT / Codex',
            status: 'unconfigured',
            source: 'cpamp',
            observedAt: null,
            scopeLabel: '订阅账户',
            linkedChannels: [],
            sharedPool: false,
            windows: [],
            balances: [],
            notice: '未配置',
            errorCode: 'UNCONFIGURED'
        },
        {
            id: 'default-antigravity',
            provider: 'antigravity',
            label: 'Antigravity',
            status: 'unconfigured',
            source: 'cpamp',
            observedAt: null,
            scopeLabel: '订阅账户',
            linkedChannels: [],
            sharedPool: false,
            windows: [],
            balances: [],
            notice: '未配置',
            errorCode: 'UNCONFIGURED'
        },
        {
            id: 'default-opencodego',
            provider: 'opencodego',
            label: 'OpenCode Go',
            status: 'unconfigured',
            source: 'opencodego',
            observedAt: null,
            scopeLabel: '订阅账户',
            linkedChannels: [],
            sharedPool: false,
            windows: [],
            balances: [],
            notice: '未配置',
            errorCode: 'UNCONFIGURED'
        },
        {
            id: 'default-deepseek',
            provider: 'deepseek',
            label: 'DeepSeek',
            status: 'unconfigured',
            source: 'deepseek',
            observedAt: null,
            scopeLabel: 'API 账户余额',
            linkedChannels: [],
            sharedPool: false,
            windows: [],
            balances: [],
            notice: '未配置',
            errorCode: 'UNCONFIGURED'
        },
        {
            id: 'default-claude',
            provider: 'claude',
            label: 'Claude',
            status: 'unsupported',
            source: 'claude',
            observedAt: null,
            scopeLabel: '订阅账户',
            linkedChannels: [],
            sharedPool: false,
            windows: [],
            balances: [],
            notice: '订阅额度未接入；调用量包含于网关统计'
        }
    ];
}

function formatWindowLabel(w, provider = '') {
    if (typeof w.label === 'string' && w.label.trim()) {
        return w.label.trim();
    }
    const kind = String(w.window_kind || w.provider_window_id || '').toLowerCase();
    const scopeKey = String(w.model_scope_key || '').toLowerCase();
    const winId = String(w.provider_window_id || '').toLowerCase();

    let periodText = '';
    if (kind.includes('five_hour') || kind.includes('5h') || kind.includes('rolling')) {
        periodText = provider === 'antigravity' ? '5h' : '五小时';
    } else if (kind.includes('weekly') || kind.includes('week')) {
        periodText = provider === 'antigravity' ? '周' : '周度';
    } else if (kind.includes('monthly') || kind.includes('month')) {
        periodText = '月度';
    } else {
        periodText = String(w.window_kind || w.provider_window_id || '配额窗口');
    }

    if (provider === 'antigravity') {
        if (scopeKey.includes('claude') || winId.includes('claude') || winId.includes('3p')) {
            return `Claude (${periodText})`;
        }
        if (scopeKey.includes('gemini') || winId.includes('gemini')) {
            return `Gemini (${periodText})`;
        }
    }
    return periodText;
}

function unwrapCpampApiCallBody(respData) {
    if (!respData || typeof respData !== 'object') return null;
    const statusCode = respData.status_code ?? respData.statusCode ?? 200;
    if (statusCode < 200 || statusCode >= 300) return null;
    const rawBody = respData.body ?? respData.bodyText;
    if (!rawBody) return null;
    if (typeof rawBody === 'object') return rawBody;
    if (typeof rawBody === 'string' && rawBody.trim()) {
        try {
            return JSON.parse(rawBody);
        } catch (_) {
            return null;
        }
    }
    return null;
}

function pickConservativeModelGroupWindow(id, label, modelIds, modelsMap) {
    const entries = [];
    for (const mId of modelIds) {
        const meta = modelsMap[mId];
        if (!meta || typeof meta !== 'object') continue;
        const qInfo = meta.quotaInfo || meta.quota_info;
        const frac = parseFiniteNumber(qInfo?.remainingFraction ?? qInfo?.remaining_fraction);
        if (frac === null) continue;
        const resetTime = typeof (qInfo?.resetTime ?? qInfo?.reset_time) === 'string'
            ? String(qInfo.resetTime ?? qInfo.reset_time).trim()
            : null;
        entries.push({ frac, resetTime });
    }
    if (entries.length === 0) return null;

    const minFrac = entries.reduce((min, e) => Math.min(min, e.frac), entries[0].frac);
    const limiting = entries.filter(e => Math.abs(e.frac - minFrac) < 1e-6);
    let chosenReset = null;
    let maxResetMs = -1;
    for (const item of limiting) {
        if (!item.resetTime) continue;
        const ms = Date.parse(item.resetTime);
        if (!Number.isNaN(ms) && ms > maxResetMs) {
            maxResetMs = ms;
            chosenReset = item.resetTime;
        } else if (!chosenReset) {
            chosenReset = item.resetTime;
        }
    }
    const remainingPercent = roundPercent(minFrac <= 1 ? minFrac * 100 : minFrac);
    return {
        id,
        label,
        remainingPercent,
        usedPercent: roundPercent(100 - remainingPercent),
        resetsAt: chosenReset
    };
}

function parseAntigravityLiveWindows(summaryRespData, modelsRespData) {
    const summaryPayload = unwrapCpampApiCallBody(summaryRespData);
    const modelsPayload = unwrapCpampApiCallBody(modelsRespData);
    const windows = [];

    const rawGroups = Array.isArray(summaryPayload?.groups)
        ? summaryPayload.groups
        : (Array.isArray(summaryPayload?.quotaGroups) ? summaryPayload.quotaGroups : []);

    const sortedGroups = [...rawGroups].sort((a, b) => {
        const an = String(a?.displayName || a?.groupLabel || a?.groupId || '').toLowerCase();
        const bn = String(b?.displayName || b?.groupLabel || b?.groupId || '').toLowerCase();
        const aClaude = /claude|gpt/.test(an);
        const bClaude = /claude|gpt/.test(bn);
        if (aClaude !== bClaude) return aClaude ? -1 : 1;
        return 0;
    });

    for (const grp of sortedGroups) {
        const gName = String(grp?.displayName || grp?.groupLabel || grp?.groupId || '').toLowerCase();
        const prefix = /claude|gpt/.test(gName)
            ? 'Claude'
            : (/gemini/.test(gName) ? 'Gemini' : String(grp?.displayName || '配额'));
        const buckets = Array.isArray(grp?.buckets)
            ? grp.buckets
            : (Array.isArray(grp?.quotaBuckets) ? grp.quotaBuckets : []);

        const sortedBuckets = [...buckets].sort((a, b) => {
            const aw = String(a?.window || a?.windowType || a?.bucketId || '').toLowerCase();
            const bw = String(b?.window || b?.windowType || b?.bucketId || '').toLowerCase();
            const a5h = aw.includes('5h') || aw.includes('five');
            const b5h = bw.includes('5h') || bw.includes('five');
            if (a5h !== b5h) return a5h ? -1 : 1;
            return 0;
        });

        for (const b of sortedBuckets) {
            const frac = parseFiniteNumber(b?.remainingFraction ?? b?.remaining_fraction);
            if (frac === null) continue;
            const remainingPercent = roundPercent(frac <= 1 ? frac * 100 : frac);
            const usedPercent = roundPercent(100 - remainingPercent);
            const wType = String(b?.window || b?.windowType || b?.bucketId || '').toLowerCase();
            const pLabel = wType.includes('5h') || wType.includes('five')
                ? '5h'
                : (wType.includes('week') ? '周' : (b?.displayName || wType));
            const resetsAt = typeof b?.resetTime === 'string' && b.resetTime.trim()
                ? b.resetTime.trim()
                : null;
            windows.push({
                id: `${prefix.toLowerCase()}:${b?.bucketId || wType}`,
                label: `${prefix} (${pLabel})`,
                remainingPercent,
                usedPercent,
                resetsAt
            });
        }
    }

    const modelsMap = modelsPayload?.models && typeof modelsPayload.models === 'object'
        ? modelsPayload.models
        : null;
    if (modelsMap && !windows.some(w => w.label.startsWith('Gemini'))) {
        const allIds = Object.keys(modelsMap);
        const geminiIds = allIds.filter(id => /^gemini-/i.test(id));
        const geminiWin = pickConservativeModelGroupWindow('gemini:5h', 'Gemini (5h)', geminiIds, modelsMap);
        if (geminiWin) windows.push(geminiWin);
    }

    return windows;
}

const dpapiTokenCache = new Map();
function resolveDpapiTokenFile(tokenFilePath) {
    if (typeof tokenFilePath !== 'string' || !tokenFilePath.trim()) return '';
    const norm = path.resolve(tokenFilePath.trim());
    const cached = dpapiTokenCache.get(norm);
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    try {
        if (!fs.existsSync(norm)) return '';
        const psCmd = `Add-Type -AssemblyName System.Security; $b=[System.IO.File]::ReadAllBytes('${norm.replace(/'/g, "''")}'); $p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($p).Trim())`;
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true
        }).trim();
        if (out) {
            dpapiTokenCache.set(norm, { token: out, expiresAt: Date.now() + 10 * 60 * 1000 });
        }
        return out;
    } catch (_) {
        return '';
    }
}

function loadDiskConfigEnv() {
    try {
        const envPath = path.join(__dirname, '..', '..', 'config.env');
        if (!fs.existsSync(envPath)) return {};
        const dotenv = require('dotenv');
        return dotenv.parse(fs.readFileSync(envPath, 'utf8')) || {};
    } catch (_) {
        return {};
    }
}

function createUsageMonitorService(options = {}) {
    const defaultConfigPath = path.join(__dirname, '..', '..', 'AppData', 'usage-monitor', 'config.json');
    const getEnv = () => options.env || { ...process.env, ...loadDiskConfigEnv() };
    const env = new Proxy({}, {
        get(_target, prop) {
            const current = getEnv();
            return current[prop];
        }
    });
    const configPath = options.configPath || env.VCP_USAGE_MONITOR_CONFIG_PATH || defaultConfigPath;
    const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
    const httpTransport = options.httpTransport || defaultHttpTransport;
    const cacheTtlMs = typeof options.cacheTtlMs === 'number' ? options.cacheTtlMs : DEFAULT_CACHE_TTL_MS;

    let cachedAccountsEntry = null;
    let inflightAccountsPromise = null;
    let inflightAccountsFingerprint = '';
    const lastGoodAccountByKey = new Map();
    const activityCacheByPeriod = new Map();
    const inflightActivityByPeriod = new Map();

    function loadConfig() {
        try {
            if (!fs.existsSync(configPath)) {
                return { exists: false, raw: '', parsed: null };
            }
            const raw = fs.readFileSync(configPath, 'utf8');
            const parsed = JSON.parse(raw);
            return { exists: true, raw, parsed };
        } catch (err) {
            return { exists: true, raw: '', parsed: null, error: err };
        }
    }

    function computeAccountsFingerprint(cfgResult) {
        const hash = crypto.createHash('sha256');
        hash.update(cfgResult.raw || '');
        const parsed = cfgResult.parsed || {};
        const cpampTokenEnv = parsed.cpamp?.tokenEnv;
        if (cpampTokenEnv) {
            hash.update(`cpamp:${cpampTokenEnv}=${env[cpampTokenEnv] || ''}`);
        }
        if (Array.isArray(parsed.accounts)) {
            for (const acct of parsed.accounts) {
                if (acct && typeof acct.tokenEnv === 'string') {
                    hash.update(`acct:${acct.id}:${acct.tokenEnv}=${env[acct.tokenEnv] || ''}`);
                }
            }
        }
        return hash.digest('hex');
    }

    function accountIdentityKey(acct, cpampCfg) {
        const hash = crypto.createHash('sha256');
        hash.update(JSON.stringify({
            id: acct.id,
            provider: acct.provider,
            baseUrl: acct.baseUrl || null,
            tokenEnv: acct.tokenEnv || null,
            tokenFile: acct.tokenFile || null,
            tokenPresent: acct.tokenEnv ? Boolean(env[acct.tokenEnv]) : false,
            queryAccount: acct.queryAccount || null,
            cpampBaseUrl: cpampCfg?.baseUrl || null,
            cpampTokenEnv: cpampCfg?.tokenEnv || null
        }));
        return `${acct.id}::${hash.digest('hex').slice(0, 16)}`;
    }

    async function evaluateAccounts(cfgResult, nowMs) {
        if (!cfgResult.exists || !cfgResult.parsed || !Array.isArray(cfgResult.parsed.accounts) || cfgResult.parsed.accounts.length === 0) {
            return buildDefaultAccounts();
        }

        const parsed = cfgResult.parsed;
        const cpampCfg = parsed.cpamp || {};
        const staleAfterMs = Number(cpampCfg.staleAfterMs) > 0 ? Number(cpampCfg.staleAfterMs) : DEFAULT_STALE_AFTER_MS;
        const rawAccounts = [...parsed.accounts];
        if (!rawAccounts.some(a => a && a.provider === 'claude')) {
            rawAccounts.push({
                id: 'default-claude',
                provider: 'claude',
                label: 'Claude',
                scopeLabel: '订阅账户',
                notice: '订阅额度未接入；调用量包含于网关统计'
            });
        }

        let cpampItemsByRowKey = null;
        let cpampError = null;
        let cpampGeneratedAtMs = null;

        const cpampCandidates = rawAccounts.filter(a =>
            a && (a.provider === 'codex' || a.provider === 'antigravity') &&
            !hasForbiddenSecretField(a) &&
            a.queryAccount && typeof a.queryAccount.row_key === 'string'
        );

        if (cpampCandidates.length > 0) {
            if (hasForbiddenSecretField(cpampCfg)) {
                cpampError = { code: 'INSECURE_CONFIG_REJECTED', notice: 'CPAMP 配置含明文密钥字段，已拒绝加载' };
            } else {
                const cpampToken = cpampCfg.tokenEnv ? String(env[cpampCfg.tokenEnv] || '').trim() : '';
                if (!cpampCfg.baseUrl || !cpampToken) {
                    cpampError = { unconfigured: true };
                } else {
                    try {
                        const baseUrl = validateLoopbackBaseUrl(cpampCfg.baseUrl);
                        const resp = await httpTransport({
                            url: `${baseUrl}/v0/management/quota-snapshots/query`,
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${cpampToken}`,
                                'Content-Type': 'application/json',
                                'Accept': 'application/json'
                            },
                            body: {
                                accounts: cpampCandidates.map(c => c.queryAccount)
                            }
                        });
                        if (!resp.ok || !resp.data || !Array.isArray(resp.data.items)) {
                            cpampError = { code: `HTTP_${resp.status || 502}`, notice: 'CPAMP 快照查询返回异常' };
                        } else {
                            cpampGeneratedAtMs = parseFiniteNumber(resp.data.generated_at_ms);
                            cpampItemsByRowKey = new Map();
                            for (const item of resp.data.items) {
                                if (item && typeof item.row_key === 'string') {
                                    cpampItemsByRowKey.set(item.row_key, item);
                                }
                            }
                        }
                    } catch (err) {
                        cpampError = { code: err.code || 'CPAMP_REQUEST_FAILED', notice: 'CPAMP 快照接口请求失败' };
                    }
                }
            }
        }

        const results = [];
        for (const rawAcct of rawAccounts) {
            const id = String(rawAcct.id || rawAcct.provider || 'account');
            const provider = String(rawAcct.provider || 'codex').toLowerCase();
            const label = String(rawAcct.label || provider);
            const scopeLabel = String(rawAcct.scopeLabel || (provider === 'deepseek' ? 'API 账户余额' : '订阅账户'));
            const linkedChannels = Array.isArray(rawAcct.linkedChannels) ? rawAcct.linkedChannels.map(String) : [];
            const sharedPool = Boolean(rawAcct.sharedPool);
            const idKey = accountIdentityKey(rawAcct, cpampCfg);

            const baseCard = {
                id,
                provider,
                label,
                status: 'unconfigured',
                source: provider === 'codex' || provider === 'antigravity' ? 'cpamp' : provider,
                observedAt: null,
                scopeLabel,
                linkedChannels,
                sharedPool,
                windows: [],
                balances: [],
                notice: ''
            };

            if (hasForbiddenSecretField(rawAcct)) {
                results.push({
                    ...baseCard,
                    status: 'error',
                    errorCode: 'INSECURE_CONFIG_REJECTED',
                    notice: '配置文件包含明文凭据字段，已拒绝加载；请改用 tokenEnv'
                });
                continue;
            }

            if (provider === 'claude') {
                const hasBridgeCfg = Boolean(
                    (typeof rawAcct.baseUrl === 'string' && rawAcct.baseUrl.trim()) ||
                    (typeof rawAcct.tokenEnv === 'string' && rawAcct.tokenEnv.trim()) ||
                    (typeof rawAcct.tokenFile === 'string' && rawAcct.tokenFile.trim())
                );
                if (!hasBridgeCfg) {
                    results.push({
                        ...baseCard,
                        status: 'unsupported',
                        notice: rawAcct.notice || '订阅额度未接入；调用量包含于网关统计'
                    });
                    continue;
                }
                const token = (rawAcct.tokenEnv ? String(env[rawAcct.tokenEnv] || '').trim() : '') || (rawAcct.tokenFile ? resolveDpapiTokenFile(rawAcct.tokenFile) : '');
                const rawBaseUrl = typeof rawAcct.baseUrl === 'string' ? rawAcct.baseUrl.trim() : '';
                if (!rawBaseUrl || !token) {
                    results.push({
                        ...baseCard,
                        status: 'unconfigured',
                        errorCode: 'UNCONFIGURED',
                        notice: '未配置 Claude Bridge 地址或环境变量'
                    });
                    continue;
                }
                try {
                    const baseUrl = validateLoopbackBaseUrl(rawBaseUrl);
                    const resp = await httpTransport({
                        url: `${baseUrl}/v1/quota`,
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/json'
                        }
                    });
                    const payload = resp && resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)
                        ? resp.data : {};
                    const meta = readClaudeQuotaMeta(payload,
                        resp && resp.ok ? 'CLAUDE_QUOTA_UNAVAILABLE' : 'UPSTREAM_ERROR');
                    if (!resp || !resp.ok || payload.status !== 'ok' || !meta.utilization) {
                        const err = createError('Claude Bridge 配额状态不可用', 'CLAUDE_QUOTA_UNAVAILABLE');
                        err.claudeQuotaMeta = meta;
                        throw err;
                    }
                    let { windows, staleWindow } = buildClaudeWindows(meta.utilization, nowMs);
                    const observedAt = claudeIso(meta.observedAtMs);
                    if (meta.observedAtMs !== null && nowMs - meta.observedAtMs > staleAfterMs) {
                        staleWindow = true;
                    }
                    const checkedAtMs = meta.checkedAtMs ?? meta.observedAtMs;
                    const subType = meta.subscriptionType ? meta.subscriptionType.toUpperCase() : null;
                    const stale = meta.stale || staleWindow || observedAt === null;
                    const notice = observedAt === null
                        ? 'Bridge 未提供可信观测时间，额度数据暂标记为 stale'
                        : stale
                            ? '部分窗口已过重置时间或缓存超龄，待刷新'
                            : (sharedPool ? 'Claude 官方订阅配额（Bridge 共享池）' : 'Claude 官方订阅配额');
                    const card = {
                        ...baseCard,
                        source: 'claude-bridge',
                        scopeLabel: rawAcct.scopeLabel || (subType ? `Claude ${subType} 订阅` : '订阅账户'),
                        status: stale ? 'stale' : 'ok',
                        observedAt,
                        checkedAt: claudeIso(checkedAtMs),
                        cacheHit: meta.cacheHit,
                        stale,
                        windows,
                        errorCode: null,
                        errorStage: null,
                        cooldownUntil: null,
                        retryAfterSeconds: null,
                        lastErrorCode: null,
                        notice
                    };
                    if (windows.length > 0 && observedAt !== null) {
                        lastGoodAccountByKey.set(idKey, card);
                    }
                    results.push(card);
                } catch (err) {
                    const meta = err && err.claudeQuotaMeta
                        ? err.claudeQuotaMeta
                        : readClaudeQuotaMeta({}, 'CLAUDE_QUOTA_UNAVAILABLE');
                    const lastGood = lastGoodAccountByKey.get(idKey);
                    const remote = buildClaudeWindows(meta.utilization, nowMs);
                    const remoteObservedMs = meta.observedAtMs;
                    const lastGoodObservedMs = lastGood && typeof lastGood.observedAt === 'string'
                        ? Date.parse(lastGood.observedAt) : null;
                    const useRemote = remote.windows.length > 0 && remoteObservedMs !== null
                        && (!lastGood || !Number.isFinite(lastGoodObservedMs)
                            || remoteObservedMs > lastGoodObservedMs);
                    let trustedCard = null;
                    if (lastGood && !useRemote) {
                        trustedCard = lastGood;
                    } else if (useRemote) {
                        const subType = meta.subscriptionType ? meta.subscriptionType.toUpperCase() : null;
                        trustedCard = {
                            ...baseCard,
                            source: 'claude-bridge',
                            scopeLabel: rawAcct.scopeLabel || (subType ? `Claude ${subType} 订阅` : '订阅账户'),
                            observedAt: claudeIso(remoteObservedMs),
                            windows: remote.windows,
                            cacheHit: meta.cacheHit
                        };
                        lastGoodAccountByKey.set(idKey, trustedCard);
                    }
                    const hasTrustedData = Boolean(trustedCard && trustedCard.windows?.length > 0
                        && trustedCard.observedAt);
                    const noticeMeta = {
                        ...meta,
                        observedAtMs: hasTrustedData ? Date.parse(trustedCard.observedAt) : meta.observedAtMs
                    };
                    const effectiveCooldownMs = meta.cooldownUntilMs !== null
                        ? meta.cooldownUntilMs
                        : (meta.retryAfterSeconds !== null && meta.retryAfterSeconds > 0
                            ? nowMs + meta.retryAfterSeconds * 1000 : null);
                    const card = hasTrustedData
                        ? {
                            ...trustedCard,
                            status: 'stale',
                            stale: true,
                            errorCode: meta.errorCode,
                            errorStage: meta.errorStage,
                            checkedAt: claudeIso(meta.checkedAtMs),
                            cooldownUntil: claudeIso(effectiveCooldownMs),
                            retryAfterSeconds: meta.retryAfterSeconds,
                            lastErrorCode: meta.lastErrorCode,
                            notice: claudeQuotaNotice(noticeMeta, true, nowMs)
                        }
                        : {
                            ...baseCard,
                            source: 'claude-bridge',
                            status: 'error',
                            observedAt: null,
                            checkedAt: claudeIso(meta.checkedAtMs),
                            cacheHit: meta.cacheHit,
                            stale: false,
                            windows: [],
                            errorCode: meta.errorCode,
                            errorStage: meta.errorStage,
                            cooldownUntil: claudeIso(effectiveCooldownMs),
                            retryAfterSeconds: meta.retryAfterSeconds,
                            lastErrorCode: meta.lastErrorCode,
                            notice: claudeQuotaNotice({ ...meta, observedAtMs: null }, false, nowMs)
                        };
                    results.push(card);
                }
                continue;
            }

            if (provider === 'codex' || provider === 'antigravity') {
                if (!rawAcct.queryAccount || !rawAcct.queryAccount.row_key || (cpampError && cpampError.unconfigured)) {
                    results.push({
                        ...baseCard,
                        status: 'unconfigured',
                        errorCode: 'UNCONFIGURED',
                        notice: '未配置 CPAMP 账户映射或环境变量'
                    });
                    continue;
                }
                if (cpampError) {
                    const lastGood = lastGoodAccountByKey.get(idKey);
                    if (lastGood) {
                        results.push({
                            ...lastGood,
                            status: 'stale',
                            errorCode: cpampError.code,
                            notice: `${cpampError.notice}（保留上次观测结果）`
                        });
                    } else {
                        results.push({
                            ...baseCard,
                            status: 'error',
                            errorCode: cpampError.code,
                            notice: cpampError.notice
                        });
                    }
                    continue;
                }

                const matched = cpampItemsByRowKey ? cpampItemsByRowKey.get(rawAcct.queryAccount.row_key) : null;
                let liveAgyWindows = null;
                const authIndex = rawAcct.queryAccount?.account?.auth_index || rawAcct.queryAccount?.auth_index;

                if (provider === 'antigravity' && authIndex && cpampCfg.baseUrl && cpampCfg.tokenEnv) {
                    const cpampToken = String(env[cpampCfg.tokenEnv] || '').trim();
                    if (cpampToken) {
                        try {
                            const baseUrl = validateLoopbackBaseUrl(cpampCfg.baseUrl);
                            const commonHeaders = {
                                'Authorization': `Bearer ${cpampToken}`,
                                'Content-Type': 'application/json',
                                'Accept': 'application/json'
                            };
                            const agyReqHeaders = {
                                'Authorization': `Bearer ${CPAMP_TOKEN_PLACEHOLDER}`,
                                'Content-Type': 'application/json',
                                'User-Agent': 'antigravity/hub/2.23.0 darwin/arm64'
                            };
                            const reqData = JSON.stringify({ project: rawAcct.projectId || 'aicode-consumers' });

                            const [sumResp, modResp] = await Promise.all([
                                httpTransport({
                                    url: `${baseUrl}/v0/management/api-call`,
                                    method: 'POST',
                                    headers: commonHeaders,
                                    body: {
                                        authIndex: String(authIndex),
                                        method: 'POST',
                                        url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
                                        header: agyReqHeaders,
                                        data: reqData
                                    }
                                }).catch(() => null),
                                httpTransport({
                                    url: `${baseUrl}/v0/management/api-call`,
                                    method: 'POST',
                                    headers: commonHeaders,
                                    body: {
                                        authIndex: String(authIndex),
                                        method: 'POST',
                                        url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
                                        header: agyReqHeaders,
                                        data: reqData
                                    }
                                }).catch(() => null)
                            ]);

                            const parsedWins = parseAntigravityLiveWindows(
                                sumResp?.ok ? sumResp.data : null,
                                modResp?.ok ? modResp.data : null
                            );
                            if (parsedWins.length > 0) {
                                liveAgyWindows = parsedWins;
                            }
                        } catch (_) {
                            // fallback to matched DB snapshot
                        }
                    }
                }

                if (liveAgyWindows && liveAgyWindows.length > 0) {
                    const card = {
                        ...baseCard,
                        status: 'ok',
                        observedAt: new Date(nowMs).toISOString(),
                        windows: liveAgyWindows,
                        notice: 'Antigravity 实时配额'
                    };
                    lastGoodAccountByKey.set(idKey, card);
                    results.push(card);
                    continue;
                }

                if (!matched || !Array.isArray(matched.windows) || matched.windows.length === 0) {
                    results.push({
                        ...baseCard,
                        status: 'stale',
                        errorCode: 'SNAPSHOT_EMPTY',
                        notice: 'CPAMP 暂无该账户的配额窗口快照'
                    });
                    continue;
                }

                let maxObservedMs = null;
                let hasExpiredOrStaleWindow = false;
                const windows = matched.windows.map((w, idx) => {
                    const remRaw = parseFiniteNumber(w.remaining_percent);
                    const usedRaw = parseFiniteNumber(w.used_percent);
                    let remainingPercent = null;
                    let usedPercent = null;
                    if (remRaw !== null) {
                        remainingPercent = roundPercent(remRaw);
                        usedPercent = roundPercent(100 - remainingPercent);
                    } else if (usedRaw !== null) {
                        usedPercent = roundPercent(usedRaw);
                        remainingPercent = roundPercent(100 - usedPercent);
                    }

                    const obsMs = parseFiniteNumber(w.observed_at_ms);
                    if (obsMs !== null && (maxObservedMs === null || obsMs > maxObservedMs)) {
                        maxObservedMs = obsMs;
                    }
                    if (obsMs !== null && nowMs - obsMs > staleAfterMs) {
                        hasExpiredOrStaleWindow = true;
                    }

                    const cycleEndMs = parseFiniteNumber(w.cycle_end_ms);
                    if (cycleEndMs !== null && cycleEndMs <= nowMs) {
                        hasExpiredOrStaleWindow = true;
                    }

                    return {
                        id: String(w.provider_window_id || w.window_kind || `win-${idx}`),
                        label: formatWindowLabel(w, provider),
                        remainingPercent,
                        usedPercent,
                        resetsAt: cycleEndMs !== null && cycleEndMs > 0 ? new Date(cycleEndMs).toISOString() : null
                    };
                });

                const finalObsMs = maxObservedMs ?? cpampGeneratedAtMs;
                const card = {
                    ...baseCard,
                    status: hasExpiredOrStaleWindow ? 'stale' : 'ok',
                    observedAt: finalObsMs ? new Date(finalObsMs).toISOString() : new Date(nowMs).toISOString(),
                    windows,
                    notice: hasExpiredOrStaleWindow
                        ? '快照窗口已过重置时点或超龄，未自动归满'
                        : (sharedPool ? '多渠道共享同一订阅配额池' : 'CPAMP 本地配额快照')
                };
                lastGoodAccountByKey.set(idKey, card);
                results.push(card);
                continue;
            }

            if (provider === 'opencodego') {
                const token = rawAcct.tokenEnv ? String(env[rawAcct.tokenEnv] || '').trim() : '';
                if (!token) {
                    results.push({
                        ...baseCard,
                        status: 'unconfigured',
                        errorCode: 'UNCONFIGURED',
                        notice: '未配置 OpenCode Go 环境变量'
                    });
                    continue;
                }
                try {
                    const resp = await httpTransport({
                        url: 'https://opencode.ai/zen/go/v1/usage',
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/json'
                        }
                    });
                    const usageRoot = resp.data?.usage || resp.data;
                    if (!resp.ok || !usageRoot || typeof usageRoot !== 'object') {
                        throw createError('OpenCode Go 响应无效', `HTTP_${resp.status || 502}`);
                    }
                    const defs = [
                        { key: 'rolling', id: 'five-hour', label: '五小时' },
                        { key: 'weekly', id: 'weekly', label: '周度' },
                        { key: 'monthly', id: 'monthly', label: '月度' }
                    ];
                    const windows = [];
                    let staleWin = false;
                    for (const def of defs) {
                        const item = usageRoot[def.key];
                        if (!item || typeof item !== 'object') continue;
                        const usedPct = parseFiniteNumber(item.percent ?? item.usedPercent);
                        const remPct = parseFiniteNumber(item.remainingPercent);
                        let remainingPercent = null;
                        let usedPercent = null;
                        if (remPct !== null) {
                            remainingPercent = roundPercent(remPct);
                            usedPercent = roundPercent(100 - remainingPercent);
                        } else if (usedPct !== null) {
                            usedPercent = roundPercent(usedPct);
                            remainingPercent = roundPercent(100 - usedPercent);
                        }
                        const resetsAt = typeof item.resetsAt === 'string' && item.resetsAt.trim()
                            ? item.resetsAt.trim()
                            : (typeof item.reset_at === 'string' ? item.reset_at.trim() : null);
                        if (resetsAt && Date.parse(resetsAt) <= nowMs) {
                            staleWin = true;
                        }
                        windows.push({
                            id: def.id,
                            label: def.label,
                            remainingPercent,
                            usedPercent,
                            resetsAt
                        });
                    }
                    const card = {
                        ...baseCard,
                        status: staleWin ? 'stale' : 'ok',
                        observedAt: new Date(nowMs).toISOString(),
                        windows,
                        notice: staleWin ? '部分窗口已过重置时间，待上游刷新' : 'OpenCode Go 官方订阅配额'
                    };
                    lastGoodAccountByKey.set(idKey, card);
                    results.push(card);
                } catch (err) {
                    const lastGood = lastGoodAccountByKey.get(idKey);
                    if (lastGood) {
                        results.push({
                            ...lastGood,
                            status: 'stale',
                            errorCode: err.code || 'UPSTREAM_ERROR',
                            notice: 'OpenCode Go 刷新失败，保留上次观测结果'
                        });
                    } else {
                        results.push({
                            ...baseCard,
                            status: 'error',
                            errorCode: err.code || 'UPSTREAM_ERROR',
                            notice: 'OpenCode Go 配额查询失败'
                        });
                    }
                }
                continue;
            }

            if (provider === 'deepseek') {
                const token = rawAcct.tokenEnv ? String(env[rawAcct.tokenEnv] || '').trim() : '';
                if (!token) {
                    results.push({
                        ...baseCard,
                        status: 'unconfigured',
                        errorCode: 'UNCONFIGURED',
                        notice: '未配置 DeepSeek 环境变量'
                    });
                    continue;
                }
                try {
                    const resp = await httpTransport({
                        url: 'https://api.deepseek.com/user/balance',
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Accept': 'application/json'
                        }
                    });
                    if (!resp.ok || !resp.data || !Array.isArray(resp.data.balance_infos)) {
                        throw createError('DeepSeek 余额响应无效', `HTTP_${resp.status || 502}`);
                    }
                    const balances = resp.data.balance_infos.map(info => ({
                        currency: String(info.currency || 'CNY').toUpperCase(),
                        available: parseFiniteNumber(info.total_balance),
                        granted: parseFiniteNumber(info.granted_balance),
                        toppedUp: parseFiniteNumber(info.topped_up_balance)
                    }));
                    const card = {
                        ...baseCard,
                        status: 'ok',
                        observedAt: new Date(nowMs).toISOString(),
                        balances,
                        notice: resp.data.is_available === false ? '账户当前不可用或余额不足' : 'DeepSeek 官方账户级余额'
                    };
                    lastGoodAccountByKey.set(idKey, card);
                    results.push(card);
                } catch (err) {
                    const lastGood = lastGoodAccountByKey.get(idKey);
                    if (lastGood) {
                        results.push({
                            ...lastGood,
                            status: 'stale',
                            errorCode: err.code || 'UPSTREAM_ERROR',
                            notice: 'DeepSeek 余额刷新失败，保留上次观测结果'
                        });
                    } else {
                        results.push({
                            ...baseCard,
                            status: 'error',
                            errorCode: err.code || 'UPSTREAM_ERROR',
                            notice: 'DeepSeek 余额查询失败'
                        });
                    }
                }
                continue;
            }
        }

        return results;
    }

    async function getAccountsSnapshot(cfgResult, nowMs) {
        const fingerprint = computeAccountsFingerprint(cfgResult);
        if (cachedAccountsEntry && cachedAccountsEntry.fingerprint === fingerprint && nowMs < cachedAccountsEntry.expiresAt) {
            return cachedAccountsEntry.accounts;
        }
        if (inflightAccountsPromise && inflightAccountsFingerprint === fingerprint) {
            return inflightAccountsPromise;
        }
        inflightAccountsFingerprint = fingerprint;
        inflightAccountsPromise = (async () => {
            try {
                const accounts = await evaluateAccounts(cfgResult, nowMs);
                cachedAccountsEntry = {
                    fingerprint,
                    expiresAt: nowMs + cacheTtlMs,
                    accounts
                };
                return accounts;
            } finally {
                inflightAccountsPromise = null;
                inflightAccountsFingerprint = '';
            }
        })();
        return inflightAccountsPromise;
    }

    async function evaluateActivity(periodRange, nowMs) {
        const baseUrl = String(env.NEWAPI_MONITOR_BASE_URL || '').trim().replace(/\/+$/, '');
        const accessToken = String(env.NEWAPI_MONITOR_ACCESS_TOKEN || '').trim();
        const apiUserId = String(env.NEWAPI_MONITOR_API_USER_ID || '').trim();

        const emptyActivity = {
            status: 'unconfigured',
            observedAt: null,
            coverage: 'newapi-only',
            complete: null,
            truncated: false,
            source: 'newapi',
            totals: {
                requests: null,
                inputTokens: null,
                outputTokens: null,
                cacheReadTokens: null,
                totalTokens: null
            },
            trend: [],
            models: [],
            notice: '仅统计经过 NewAPI 的调用'
        };

        if (!baseUrl || !accessToken || !apiUserId) {
            return emptyActivity;
        }

        const logItems = [];
        let reportedTotal = 0;
        let truncated = false;

        for (let page = 1; page <= MAX_LOG_PAGES; page += 1) {
            const qs = new URLSearchParams({
                type: '2',
                start_timestamp: String(periodRange.startTimestamp),
                end_timestamp: String(periodRange.endTimestamp),
                p: String(page),
                page_size: '100'
            });
            const resp = await httpTransport({
                url: `${baseUrl}/api/log/?${qs.toString()}`,
                method: 'GET',
                headers: {
                    'Authorization': accessToken,
                    'New-Api-User': apiUserId,
                    'Accept': 'application/json'
                }
            });
            if (!resp.ok || !resp.data || resp.data.success === false) {
                throw createError('NewAPI 日志请求失败', `HTTP_${resp.status || 502}`);
            }
            const pageData = resp.data.data || {};
            const items = Array.isArray(pageData.items) ? pageData.items : [];
            const total = parseFiniteNumber(pageData.total);
            if (total !== null && total > reportedTotal) {
                reportedTotal = total;
            }
            logItems.push(...items);

            if (items.length < 100) break;
            if (reportedTotal > 0 && logItems.length >= reportedTotal) break;
            if (page === MAX_LOG_PAGES && (reportedTotal > logItems.length || items.length === 100)) {
                truncated = true;
            }
        }

        if (reportedTotal > logItems.length) {
            truncated = true;
        }

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadSum = 0;
        let hasCacheField = false;

        const trendMap = new Map();
        const modelMap = new Map();

        for (const item of logItems) {
            const prompt = parseFiniteNumber(item.prompt_tokens) ?? 0;
            const completion = parseFiniteNumber(item.completion_tokens) ?? 0;
            let itemCache = null;

            if (typeof item.other === 'string' && item.other.trim()) {
                try {
                    const otherObj = JSON.parse(item.other);
                    const rawCache = parseFiniteNumber(otherObj?.cache_tokens ?? otherObj?.cached_tokens);
                    if (rawCache !== null) {
                        itemCache = rawCache;
                        hasCacheField = true;
                        cacheReadSum += rawCache;
                    }
                } catch (_) {
                    // ignore malformed other
                }
            }

            inputTokens += prompt;
            outputTokens += completion;
            const itemTotal = prompt + completion;

            const createdSec = parseFiniteNumber(item.created_at) ?? Math.floor(nowMs / 1000);
            const bucketSec = createdSec - (createdSec % 3600);
            const bucketIso = new Date(bucketSec * 1000).toISOString();
            if (!trendMap.has(bucketIso)) {
                trendMap.set(bucketIso, { at: bucketIso, requests: 0, totalTokens: 0 });
            }
            const tBucket = trendMap.get(bucketIso);
            tBucket.requests += 1;
            tBucket.totalTokens += itemTotal;

            const modelName = typeof item.model_name === 'string' && item.model_name.trim()
                ? item.model_name.trim()
                : '(unknown)';
            if (!modelMap.has(modelName)) {
                modelMap.set(modelName, {
                    model: modelName,
                    requests: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: null,
                    totalTokens: 0
                });
            }
            const mBucket = modelMap.get(modelName);
            mBucket.requests += 1;
            mBucket.inputTokens += prompt;
            mBucket.outputTokens += completion;
            mBucket.totalTokens += itemTotal;
            if (itemCache !== null) {
                mBucket.cacheReadTokens = (mBucket.cacheReadTokens ?? 0) + itemCache;
            }
        }

        const trend = Array.from(trendMap.values()).sort((a, b) => a.at.localeCompare(b.at));
        const models = Array.from(modelMap.values()).sort((a, b) => {
            if (b.requests !== a.requests) return b.requests - a.requests;
            return b.totalTokens - a.totalTokens;
        });

        return {
            status: 'ok',
            observedAt: new Date(nowMs).toISOString(),
            coverage: 'newapi-only',
            complete: !truncated,
            truncated,
            source: 'newapi',
            totals: {
                requests: logItems.length,
                inputTokens,
                outputTokens,
                cacheReadTokens: hasCacheField ? cacheReadSum : null,
                totalTokens: inputTokens + outputTokens
            },
            trend,
            models,
            notice: truncated
                ? '消费日志超过分页上限（20,000 条），当前统计已截断（不完整）'
                : '仅统计经过 NewAPI 的调用'
        };
    }

    async function getActivitySnapshot(periodRange, nowMs) {
        const key = periodRange.key;
        const entry = activityCacheByPeriod.get(key);
        if (entry && nowMs < entry.expiresAt) {
            return entry.activity;
        }
        if (inflightActivityByPeriod.has(key)) {
            return inflightActivityByPeriod.get(key);
        }
        const promise = (async () => {
            try {
                const activity = await evaluateActivity(periodRange, nowMs);
                activityCacheByPeriod.set(key, {
                    expiresAt: nowMs + cacheTtlMs,
                    activity,
                    lastGood: activity.status === 'ok' ? activity : entry?.lastGood || null
                });
                return activity;
            } catch (_) {
                if (entry?.lastGood) {
                    return {
                        ...entry.lastGood,
                        status: 'stale',
                        notice: 'NewAPI 统计刷新失败，当前保留上次观测结果'
                    };
                }
                return {
                    status: 'error',
                    observedAt: null,
                    coverage: 'newapi-only',
                    complete: null,
                    truncated: false,
                    source: 'newapi',
                    totals: {
                        requests: null,
                        inputTokens: null,
                        outputTokens: null,
                        cacheReadTokens: null,
                        totalTokens: null
                    },
                    trend: [],
                    models: [],
                    notice: 'NewAPI 网关统计查询失败'
                };
            } finally {
                inflightActivityByPeriod.delete(key);
            }
        })();
        inflightActivityByPeriod.set(key, promise);
        return promise;
    }

    return {
        async getSnapshot({ period = 'today' } = {}) {
            const nowMs = nowFn();
            const cfgResult = loadConfig();
            const timeZone = cfgResult.parsed?.timeZone || 'Asia/Shanghai';
            const periodRange = resolvePeriodRange(period, { nowMs, timeZone });

            const [accounts, activity] = await Promise.all([
                getAccountsSnapshot(cfgResult, nowMs),
                getActivitySnapshot(periodRange, nowMs)
            ]);

            return {
                schemaVersion: 1,
                generatedAt: new Date(nowMs).toISOString(),
                period: {
                    key: periodRange.key,
                    start: periodRange.start,
                    end: periodRange.end,
                    timeZone: periodRange.timeZone
                },
                accounts: accounts.map(account => refreshClaudeStatusCard(account, nowMs)),
                activity
            };
        }
    };
}

module.exports = {
    createUsageMonitorService,
    resolvePeriodRange,
    validateLoopbackBaseUrl
};