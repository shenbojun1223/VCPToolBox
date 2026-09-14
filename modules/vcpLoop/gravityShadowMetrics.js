'use strict';
// Fixed-size aggregate diagnostics; no messages, vectors, IDs or arbitrary strings.
// No timers/file writes. First report emits, then at most once per 60 seconds.
const REASONS = [
  'aborted', 'message-budget', 'not-tool-loop', 'invalid-message',
  'character-budget', 'below-watermark', 'missing-user-anchor',
  'missing-payload-anchor', 'missing-cache', 'time-budget-or-abort',
  'anchor-cache-miss-or-invalid', 'anchor-cache-unavailable',
  'vector-budget', 'shadow-only', 'handoff-unverified', 'analysis-error', 'other'
];
const STATES = ['hit','miss','invalid','error','not-read'];
const NUMERIC = ['cacheHits','cacheMisses','cacheInvalid','cacheErrors',
  'eligible','protected','wouldStub','potentialChars'];
function createMetrics({ now = Date.now, emit = line => console.log(line) } = {}) {
  let started = null, lastEmit = null;
  const counts = {
    reports:0, analyzed:0, skipped:0, cacheHits:0, cacheMisses:0,
    cacheInvalid:0, cacheErrors:0,
    eligible:0, protected:0, wouldStub:0, potentialChars:0,
    elapsedMsTotal:0, elapsedMsMax:0, emitFailures:0
  };
  const reasons = Object.fromEntries(REASONS.map(key => [key, 0]));
  const anchors = Object.fromEntries(['goal','payload'].map(key =>
    [key, Object.fromEntries(STATES.map(state => [state, 0]))]));
  const number = value => typeof value === 'number' && Number.isFinite(value) &&
    value >= 0 ? Math.min(value, 1000000000) : 0;
  const add = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
  function snapshot() {
    return {version:'gravity-metrics-v2', scope:'process-cumulative',
      ...counts, reasons:{...reasons},
      anchorCache:{goal:{...anchors.goal},payload:{...anchors.payload}}};
  }
  function observe(report) {
    try {
      if (!report || typeof report !== 'object') return;
      // Validate every input before updating counters. Never retain report objects.
      const sample = {};
      for (const key of [...NUMERIC,'elapsedMs']) sample[key] = number(report[key]);
      const status = report.status === 'analyzed' ? 'analyzed' : 'skipped';
      const reason = typeof report.reason === 'string' &&
        Object.prototype.hasOwnProperty.call(reasons, report.reason) ? report.reason : 'other';
      const anchorSample = {};
      for (const key of ['goal','payload']) {
        const state = report.anchorCache?.[key];
        anchorSample[key] = STATES.includes(state) ? state : 'not-read';
      }
      const time = now();
      if (!Number.isFinite(time)) return;
      counts.reports = add(counts.reports, 1);
      counts[status] = add(counts[status], 1);
      reasons[reason] = add(reasons[reason], 1);
      for (const key of NUMERIC) counts[key] = add(counts[key], sample[key]);
      for (const key of ['goal','payload']) {
        const state = anchorSample[key];
        anchors[key][state] = add(anchors[key][state], 1);
      }
      counts.elapsedMsTotal = add(counts.elapsedMsTotal, sample.elapsedMs);
      counts.elapsedMsMax = Math.max(counts.elapsedMsMax, sample.elapsedMs);
      if (started === null) started = time;
      if (lastEmit === null || time - lastEmit >= 60000) {
        lastEmit = time;
        try {
          const pending = emit('[GravityStub:metrics] ' + JSON.stringify({
            ...snapshot(), uptimeMs:Math.max(0, time - started)
          }));
          if (pending && typeof pending.catch === 'function')
            pending.catch(() => { counts.emitFailures = add(counts.emitFailures, 1); });
        } catch { counts.emitFailures = add(counts.emitFailures, 1); }
      }
    } catch { /* Diagnostics cannot interrupt tool continuation. */ }
  }
  return {observe, snapshot};
}
const metrics = createMetrics();
function recordGravityReport(report) {
  if (process.env.VCP_GRAVITY_METRICS !== 'true') return;
  metrics.observe(report);
}
module.exports = { createMetrics, recordGravityReport };