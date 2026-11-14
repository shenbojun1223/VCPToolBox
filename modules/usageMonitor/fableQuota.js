'use strict';
const crypto = require('node:crypto');
const MODEL = /^(?:Claude )?Fable(?: [0-9]{1,2}(?:[.][0-9]{1,2})?)?$/i;
const GROUP = /^[A-Za-z0-9_-]{1,64}$/;
const RESET = /^[0-9T:.+Z-]{1,64}$/;
const SURFACES = new Set(['Claude Code', 'Claude', 'Claude.ai', 'Claude.ai and Claude Code', 'Cowork']);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const full = (pattern, text) => typeof text === 'string' && pattern.exec(text)?.[0] === text;

function buildFableWindows(values, nowMs) {
    const windows = [];
    let staleWindow = false;
    if (!Array.isArray(values) || values.length > 32) return {windows, staleWindow};
    const found = new Map(), conflicts = new Set();
    for (const value of values) {
        if (!plain(value) || value.kind !== 'weekly_scoped' || !plain(value.scope)) continue;
        const scope = value.scope;
        const rawName = scope.model?.display_name, group = value.group;
        if (!plain(scope.model) || !full(MODEL, rawName) || !full(GROUP, group)) continue;
        if (scope.surface != null && (!plain(scope.surface) || !SURFACES.has(scope.surface.display_name))) continue;
        const surface = scope.surface?.display_name ?? '';
        const name = rawName.replace(/^Claude /i, '').replace(/^Fable/i, 'Fable');
        const key = JSON.stringify([group, name, surface]);
        const n = value.percent, reset = value.resets_at ?? null;
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100
                || (reset !== null && !full(RESET, reset))) {
            conflicts.add(key);
            continue;
        }
        const record = {name, surface, percent: Math.round(n * 10000) / 10000, reset};
        if (found.has(key) && JSON.stringify(found.get(key)) !== JSON.stringify(record)) conflicts.add(key);
        found.set(key, record);
    }
    for (const key of [...found.keys()].sort()) {
        if (conflicts.has(key)) continue;
        const row = found.get(key);
        const resetMs = row.reset === null ? NaN : Date.parse(row.reset);
        if (!Number.isFinite(resetMs) || resetMs <= nowMs) staleWindow = true;
        windows.push({
            id: 'weekly-fable-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
            label: row.name + ' 独立周额度' + (row.surface ? ' · ' + row.surface : ''),
            remainingPercent: Math.round((100 - row.percent) * 10000) / 10000,
            usedPercent: row.percent,
            resetsAt: Number.isFinite(resetMs) ? row.reset : null
        });
    }
    return {windows, staleWindow};
}

function withFableNotice(account) {
    if (account?.source !== 'claude-bridge') return account;
    const found = Array.isArray(account.windows)
        && account.windows.some(w => typeof w.id === 'string' && w.id.startsWith('weekly-fable-'));
    const suffix = found
        ? 'Fable 按官方模型限额单列；总额度仍可能同时适用'
        : 'Fable 独立额度暂不可用：尚未取得可信模型限额记录，不能由总额度推算';
    return {...account, notice: [account.notice, suffix].filter(Boolean).join('；')};
}
module.exports = {buildFableWindows, withFableNotice};