<template>
  <div class="dashboard-card-shell dashboard-card-shell--emerald newapi-card">
    <div class="dashboard-card-header card-header">
      <div>
        <h3 class="dashboard-card-title">模型用量与额度</h3>
        <p class="dashboard-card-subtitle card-subtitle">
          {{ headerSubtitle }}
        </p>
      </div>
      <div class="header-actions">
        <div v-if="usageSnapshot" class="period-tabs" role="tablist" aria-label="统计周期">
          <button
            v-for="tab in periodTabs"
            :key="tab.key"
            type="button"
            role="tab"
            class="period-tab"
            :class="{ 'is-active': currentPeriod === tab.key }"
            :aria-selected="currentPeriod === tab.key"
            @click="handlePeriodSelect(tab.key)"
          >
            {{ tab.label }}
          </button>
        </div>
        <span class="dashboard-card-badge source-badge">{{ sourceLabel }}</span>
      </div>
    </div>

    <div v-if="status === 'loading' && !usageSnapshot && !summary" class="card-state">
      正在加载用量与额度数据...
    </div>

    <div
      v-else-if="status === 'unavailable' && !usageSnapshot && !summary"
      class="card-state card-state-warning"
    >
      <strong>监控未配置</strong>
      <p>{{ errorMessage || "后端已提供接口，但当前实例尚未完成用量监控配置。" }}</p>
    </div>

    <div
      v-else-if="status === 'error' && !usageSnapshot && !summary"
      class="card-state card-state-error"
    >
      <strong>监控加载失败</strong>
      <p>{{ errorMessage || "请检查后端日志或监控配置。" }}</p>
    </div>

    <div v-else-if="!usageSnapshot && !summary" class="card-state">
      暂无可展示的监控数据。
    </div>

    <div v-else class="monitor-scroll-body">
      <!-- 第一层：账户额度与余额（按账户/共享池展示） -->
      <section v-if="accounts.length > 0" class="accounts-section">
        <div class="section-bar">
          <span class="section-title">账户剩余额度与余额</span>
          <span class="section-hint">进度条统一表示剩余比例 · 窗口独立不平均</span>
        </div>

        <div class="accounts-grid">
          <article
            v-for="acct in sortedAccounts"
            :key="acct.id"
            class="dashboard-card-panel account-card"
            :class="[`account-card--${acct.status}`]"
          >
            <div class="account-top">
              <div class="account-ident">
                <strong class="account-label">{{ acct.label }}</strong>
                <span class="account-scope">{{ acct.scopeLabel }}</span>
              </div>
              <span class="account-status-badge" :class="`status-badge--${acct.status}`">
                {{ formatAccountStatus(acct) }}
              </span>
            </div>

            <!-- 配额窗口列表 -->
            <div v-if="acct.windows && acct.windows.length > 0" class="windows-list">
              <div v-for="win in acct.windows" :key="win.id" class="window-row">
                <div class="window-meta">
                  <span class="window-label">{{ win.label }}剩余</span>
                  <strong
                    class="window-percent"
                    :class="getWindowLevelClass(win.remainingPercent)"
                  >
                    {{ formatPercent(win.remainingPercent) }}
                  </strong>
                </div>
                <div class="quota-bar-track">
                  <div
                    class="quota-bar-fill"
                    :class="getWindowLevelClass(win.remainingPercent)"
                    :style="{ width: `${getSafeBarWidth(win.remainingPercent)}%` }"
                  ></div>
                </div>
                <div v-if="win.resetsAt" class="window-reset">
                  {{ formatResetTime(win.resetsAt) }}
                </div>
              </div>
            </div>

            <!-- 账户余额列表（按币种分开，绝不相加） -->
            <div v-if="acct.balances && acct.balances.length > 0" class="balances-list">
              <div
                v-for="bal in acct.balances"
                :key="bal.currency"
                class="balance-row"
              >
                <span class="balance-currency">{{ bal.currency }} 可用余额</span>
                <strong class="balance-amount">
                  {{ formatCurrencyAmount(bal.currency, bal.available) }}
                </strong>
              </div>
            </div>

            <!-- 底部摘要与展开详情入口 -->
            <div class="account-footer">
              <span class="account-notice">{{ acct.notice }}</span>
              <button
                type="button"
                class="detail-toggle-btn"
                @click="toggleAccountDetail(acct.id)"
              >
                {{ expandedAccountId === acct.id ? "收起" : "详情" }}
              </button>
            </div>

            <!-- 第三层：展开详情 -->
            <div v-if="expandedAccountId === acct.id" class="account-detail-drawer">
              <div class="detail-kv">
                <span>数据源</span>
                <strong>{{ acct.source }}</strong>
              </div>
              <div class="detail-kv">
                <span>观测时间</span>
                <strong>{{ formatDateTime(acct.observedAt) }}</strong>
              </div>
              <div v-if="acct.linkedChannels && acct.linkedChannels.length > 0" class="detail-kv">
                <span>关联渠道</span>
                <strong>
                  {{ acct.linkedChannels.join("、") }}
                  <em v-if="acct.sharedPool" class="shared-pool-tag">（共用同一额度池）</em>
                </strong>
              </div>
              <template v-if="acct.balances && acct.balances.length > 0">
                <div
                  v-for="bal in acct.balances"
                  :key="`${bal.currency}-detail`"
                  class="detail-kv"
                >
                  <span>{{ bal.currency }} 充值 / 赠送</span>
                  <strong>
                    {{ formatCurrencyAmount(bal.currency, bal.toppedUp) }} /
                    {{ formatCurrencyAmount(bal.currency, bal.granted) }}
                  </strong>
                </div>
              </template>
              <div v-if="acct.errorCode" class="detail-kv">
                <span>状态码</span>
                <strong>{{ acct.errorCode }}</strong>
              </div>
            </div>
          </article>
        </div>
      </section>

      <!-- 第二层：NewAPI 网关调用统计 -->
      <section class="gateway-section">
        <div class="section-bar">
          <span class="section-title">NewAPI 网关调用统计（{{ periodDisplayLabel }}）</span>
          <span class="section-hint">
            {{ gatewayScopeNotice }}
          </span>
        </div>

        <div
          v-if="usageSnapshot && usageSnapshot.activity.truncated"
          class="truncation-banner"
        >
          日志达到分页上限（20,000 条），当前周期统计未完整覆盖全部记录。
        </div>

        <div class="metrics-grid">
          <div class="dashboard-card-panel metric-tile">
            <span class="metric-label">调用次数</span>
            <strong class="metric-value">{{ displayTotalRequests }}</strong>
          </div>
          <div class="dashboard-card-panel metric-tile">
            <span class="metric-label">输入 Token</span>
            <strong class="metric-value">{{ displayInputTokens }}</strong>
          </div>
          <div class="dashboard-card-panel metric-tile">
            <span class="metric-label">输出 Token</span>
            <strong class="metric-value">{{ displayOutputTokens }}</strong>
          </div>
          <div class="dashboard-card-panel metric-tile">
            <span class="metric-label">缓存读取 Token</span>
            <strong class="metric-value">{{ displayCacheReadTokens }}</strong>
          </div>
        </div>

        <div class="content-grid">
          <section class="dashboard-card-panel trend-panel">
            <div class="panel-header">
              <span>调用趋势</span>
              <span class="panel-hint">{{ activeTrendPoints.length }} 个时间桶</span>
            </div>
            <div v-if="activeTrendPoints.length === 0" class="panel-empty">暂无趋势数据</div>
            <div v-else class="sparkline-wrap">
              <svg
                class="sparkline"
                viewBox="0 0 320 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <defs>
                  <linearGradient id="newapiSparkFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stop-color="var(--dashboard-accent-border)" />
                    <stop offset="100%" stop-color="transparent" />
                  </linearGradient>
                </defs>
                <path :d="sparklineAreaPath" class="sparkline-area" />
                <path :d="sparklineLinePath" class="sparkline-line" />
              </svg>
              <div class="trend-caption">
                <span>峰值 {{ formatNullableCompact(maxRequests) }}</span>
                <span>总 Token {{ displayTotalTokens }}</span>
              </div>
            </div>
          </section>

          <section class="dashboard-card-panel models-panel">
            <div class="panel-header">
              <span>模型用量排行</span>
              <span class="panel-hint">{{ topDisplayModels.length }} / {{ totalModelCount }}</span>
            </div>
            <div v-if="topDisplayModels.length === 0" class="panel-empty">暂无模型维度数据</div>
            <ul v-else class="model-list">
              <li v-for="model in topDisplayModels" :key="model.name" class="model-item">
                <div class="model-meta">
                  <strong class="model-name">{{ model.name || "unknown" }}</strong>
                  <span class="model-requests">{{ formatNullableCompact(model.requests) }} 次</span>
                </div>
                <div class="model-bar-track">
                  <div
                    class="model-bar-fill"
                    :style="{ width: `${model.barWidth}%` }"
                  ></div>
                </div>
                <div class="model-detail">
                  <span>输入 {{ formatNullableCompact(model.inputTokens) }}</span>
                  <span>输出 {{ formatNullableCompact(model.outputTokens) }}</span>
                  <span>缓存 {{ formatNullableCompact(model.cacheReadTokens) }}</span>
                </div>
              </li>
            </ul>
          </section>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type {
  NewApiMonitorModelItem,
  NewApiMonitorSummary,
  NewApiMonitorTrendItem,
  UsageMonitorAccount,
  UsageMonitorPeriodKey,
  UsageMonitorSnapshot,
} from "@/api";

type CardStatus = "loading" | "ready" | "unavailable" | "error";

const compactNumberFormatter = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const props = defineProps<{
  summary: NewApiMonitorSummary | null;
  trendItems: NewApiMonitorTrendItem[];
  models: NewApiMonitorModelItem[];
  usageSnapshot?: UsageMonitorSnapshot | null;
  activePeriod?: UsageMonitorPeriodKey;
  onSelectPeriod?: (period: UsageMonitorPeriodKey) => void;
  status: CardStatus;
  errorMessage?: string;
}>();

const expandedAccountId = ref<string | null>(null);

const periodTabs: ReadonlyArray<{ key: UsageMonitorPeriodKey; label: string }> = [
  { key: "today", label: "今日" },
  { key: "7d", label: "近7天" },
  { key: "month", label: "本月" },
];

const currentPeriod = computed<UsageMonitorPeriodKey>(
  () => props.activePeriod || props.usageSnapshot?.period.key || "today"
);

const periodDisplayLabel = computed(() => {
  const found = periodTabs.find((item) => item.key === currentPeriod.value);
  return found ? found.label : "今日";
});

const accounts = computed<UsageMonitorAccount[]>(
  () => props.usageSnapshot?.accounts ?? []
);

function getAccountMinRemaining(acct: UsageMonitorAccount): number {
  if (!acct.windows || acct.windows.length === 0) {
    return 101;
  }
  const values = acct.windows
    .map((w) => w.remainingPercent)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return values.length > 0 ? Math.min(...values) : 101;
}

const sortedAccounts = computed<UsageMonitorAccount[]>(() => {
  const rankStatus: Record<UsageMonitorAccount["status"], number> = {
    ok: 0,
    stale: 1,
    error: 2,
    unconfigured: 3,
    unsupported: 4,
  };
  return [...accounts.value].sort((a, b) => {
    const statusDiff = (rankStatus[a.status] ?? 9) - (rankStatus[b.status] ?? 9);
    if (statusDiff !== 0) return statusDiff;
    return getAccountMinRemaining(a) - getAccountMinRemaining(b);
  });
});

function handlePeriodSelect(period: UsageMonitorPeriodKey) {
  props.onSelectPeriod?.(period);
}

function toggleAccountDetail(id: string) {
  expandedAccountId.value = expandedAccountId.value === id ? null : id;
}

function formatNullableCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return compactNumberFormatter.format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return `${Number(value.toFixed(1))}%`;
}

function getSafeBarWidth(remainingPercent: number | null | undefined): number {
  if (remainingPercent === null || remainingPercent === undefined || !Number.isFinite(remainingPercent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, remainingPercent));
}

function getWindowLevelClass(remainingPercent: number | null | undefined): string {
  if (remainingPercent === null || remainingPercent === undefined || !Number.isFinite(remainingPercent)) {
    return "level-unknown";
  }
  if (remainingPercent <= 0) return "level-exhausted";
  if (remainingPercent <= 15) return "level-critical";
  if (remainingPercent <= 35) return "level-warning";
  return "level-normal";
}

function formatCurrencyAmount(currency: string, amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return "—";
  }
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${amount.toFixed(2)}`;
}

function formatAccountStatus(acct: UsageMonitorAccount): string {
  switch (acct.status) {
    case "ok":
      return "正常";
    case "stale":
      return "数据陈旧";
    case "unconfigured":
      return "未配置";
    case "unsupported":
      return "额度未接入";
    case "error":
      return acct.errorCode === "AUTH_REQUIRED" ? "需重新授权" : "异常";
    default:
      return acct.status;
  }
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatResetTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const diffMin = Math.round((ms - Date.now()) / 60000);
  if (diffMin <= 0) {
    return `已过重置点 (${formatDateTime(iso)})`;
  }
  if (diffMin < 60) {
    return `${diffMin} 分钟后重置`;
  }
  if (diffMin < 24 * 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m > 0 ? `${h} 小时 ${m} 分后重置` : `${h} 小时后重置`;
  }
  return `${formatDateTime(iso)} 重置`;
}

const headerSubtitle = computed(() => {
  if (props.usageSnapshot?.generatedAt) {
    return `订阅配额 · 账户余额 · 网关统计（更新于 ${formatDateTime(props.usageSnapshot.generatedAt)}）`;
  }
  return "最近 24 小时用量总览";
});

const gatewayScopeNotice = computed(() => {
  if (props.usageSnapshot?.activity?.notice) {
    return props.usageSnapshot.activity.notice;
  }
  return "仅统计经过 NewAPI 的流量";
});

const displayTotalRequests = computed(() => {
  if (props.usageSnapshot) {
    return formatNullableCompact(props.usageSnapshot.activity.totals.requests);
  }
  return formatNullableCompact(props.summary?.total_requests);
});

const displayInputTokens = computed(() => {
  if (props.usageSnapshot) {
    return formatNullableCompact(props.usageSnapshot.activity.totals.inputTokens);
  }
  return "—";
});

const displayOutputTokens = computed(() => {
  if (props.usageSnapshot) {
    return formatNullableCompact(props.usageSnapshot.activity.totals.outputTokens);
  }
  return "—";
});

const displayCacheReadTokens = computed(() => {
  if (props.usageSnapshot) {
    return formatNullableCompact(props.usageSnapshot.activity.totals.cacheReadTokens);
  }
  return "—";
});

const displayTotalTokens = computed(() => {
  if (props.usageSnapshot) {
    return formatNullableCompact(props.usageSnapshot.activity.totals.totalTokens);
  }
  return formatNullableCompact(props.summary?.total_tokens);
});

const activeTrendPoints = computed<Array<{ requests: number }>>(() => {
  if (props.usageSnapshot) {
    return props.usageSnapshot.activity.trend.map((item) => ({
      requests: item.requests ?? 0,
    }));
  }
  return props.trendItems.map((item) => ({ requests: item.requests }));
});

const maxRequests = computed(() => {
  return activeTrendPoints.value.reduce((max, item) => Math.max(max, item.requests), 0);
});

interface DisplayModelRow {
  name: string;
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  barWidth: number;
}

const totalModelCount = computed(() => {
  if (props.usageSnapshot) {
    return props.usageSnapshot.activity.models.length;
  }
  return props.models.length;
});

const topDisplayModels = computed<DisplayModelRow[]>(() => {
  if (props.usageSnapshot) {
    const list = props.usageSnapshot.activity.models;
    const maxReq = list.reduce((max, item) => Math.max(max, item.requests ?? 0), 0);
    return list.slice(0, 5).map((item) => ({
      name: item.model,
      requests: item.requests,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
      cacheReadTokens: item.cacheReadTokens,
      barWidth: maxReq > 0 && item.requests ? Math.max(8, (item.requests / maxReq) * 100) : 0,
    }));
  }

  const maxReq = props.models.reduce((max, item) => Math.max(max, item.requests), 0);
  return props.models.slice(0, 4).map((item) => ({
    name: item.model_name,
    requests: item.requests,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    barWidth: maxReq > 0 ? Math.max(8, (item.requests / maxReq) * 100) : 0,
  }));
});

const sourceLabel = computed(() => {
  if (props.usageSnapshot?.activity?.source) {
    return props.usageSnapshot.activity.source;
  }
  if (!props.summary?.source) {
    return "monitor";
  }
  return props.summary.source === "quota_data" ? "quota_data" : props.summary.source;
});

const sparklinePoints = computed(() => {
  const points = activeTrendPoints.value;
  if (points.length === 0) {
    return [];
  }

  const width = 320;
  const height = 100;
  const paddingX = 8;
  const paddingY = 10;
  const maxValue = Math.max(...points.map((item) => item.requests), 1);

  return points.map((item, index) => {
    const x =
      points.length === 1
        ? width / 2
        : paddingX + (index / (points.length - 1)) * (width - paddingX * 2);
    const y = height - paddingY - (item.requests / maxValue) * (height - paddingY * 2);
    return { x, y };
  });
});

const sparklineLinePath = computed(() => {
  if (sparklinePoints.value.length === 0) {
    return "";
  }

  return sparklinePoints.value
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
});

const sparklineAreaPath = computed(() => {
  if (sparklinePoints.value.length === 0) {
    return "";
  }

  const firstPoint = sparklinePoints.value[0];
  const lastPoint = sparklinePoints.value[sparklinePoints.value.length - 1];

  return [
    `M ${firstPoint.x} 100`,
    ...sparklinePoints.value.map((point) => `L ${point.x} ${point.y}`),
    `L ${lastPoint.x} 100`,
    "Z",
  ].join(" ");
});
</script>

<style scoped>
@import "./dashboard-card.css";

.newapi-card {
  --dashboard-accent: var(--success-color);
  --dashboard-accent-soft: var(--success-bg);
  --dashboard-accent-border: var(--success-border);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.period-tabs {
  display: inline-flex;
  border-radius: var(--radius-md, 8px);
  background: var(--tertiary-bg);
  padding: 2px;
  gap: 2px;
}

.period-tab {
  border: none;
  background: transparent;
  color: var(--secondary-text);
  font-size: var(--font-size-caption);
  padding: 4px 10px;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
}

.period-tab.is-active {
  background: var(--secondary-bg);
  color: var(--primary-text);
  font-weight: 600;
}

.monitor-scroll-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.section-bar {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.section-title {
  font-size: var(--font-size-body);
  font-weight: 600;
  color: var(--primary-text);
}

.section-hint {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.accounts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.account-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}

.account-card--stale {
  opacity: 0.86;
}

.account-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.account-ident {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.account-label {
  font-size: var(--font-size-body);
  color: var(--primary-text);
}

.account-scope {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.account-status-badge {
  font-size: var(--font-size-helper);
  padding: 2px 8px;
  border-radius: var(--radius-full, 999px);
  background: var(--tertiary-bg);
  color: var(--secondary-text);
  white-space: nowrap;
}

.status-badge--ok {
  color: var(--success-color);
  background: var(--success-bg);
}

.status-badge--stale {
  color: var(--warning-color);
  background: var(--warning-bg, var(--tertiary-bg));
}

.status-badge--error {
  color: var(--danger-color);
  background: var(--danger-bg, var(--tertiary-bg));
}

.windows-list,
.balances-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.window-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.window-meta,
.balance-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--font-size-caption);
}

.window-label,
.balance-currency {
  color: var(--secondary-text);
}

.window-percent,
.balance-amount {
  color: var(--primary-text);
}

.quota-bar-track {
  width: 100%;
  height: 7px;
  border-radius: var(--radius-full, 999px);
  background: var(--tertiary-bg);
  overflow: hidden;
}

.quota-bar-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--success-color);
}

.quota-bar-fill.level-warning {
  background: var(--warning-color);
}

.quota-bar-fill.level-critical,
.quota-bar-fill.level-exhausted {
  background: var(--danger-color);
}

.window-percent.level-warning {
  color: var(--warning-color);
}

.window-percent.level-critical,
.window-percent.level-exhausted {
  color: var(--danger-color);
}

.window-reset {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
  text-align: right;
}

.account-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 6px;
  border-top: 1px solid var(--border-color);
}

.account-notice {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.detail-toggle-btn {
  border: none;
  background: transparent;
  color: var(--highlight-text, var(--primary-text));
  font-size: var(--font-size-helper);
  cursor: pointer;
  padding: 2px 4px;
  white-space: nowrap;
}

.account-detail-drawer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--border-color);
  font-size: var(--font-size-helper);
}

.detail-kv {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--secondary-text);
}

.detail-kv strong {
  color: var(--primary-text);
  text-align: right;
}

.shared-pool-tag {
  font-style: normal;
  color: var(--warning-color);
}

.truncation-banner {
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md, 8px);
  background: var(--warning-bg, var(--tertiary-bg));
  color: var(--warning-color);
  font-size: var(--font-size-caption);
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.metric-tile {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 12px;
  min-height: auto;
}

.metric-label {
  display: block;
  margin-bottom: 6px;
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
}

.metric-value {
  font-size: var(--font-size-title);
  line-height: 1.2;
  color: var(--primary-text);
}

.content-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 16px;
}

.trend-panel,
.models-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 14px;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
  font-weight: 600;
  color: var(--primary-text);
}

.panel-hint {
  font-size: var(--font-size-caption);
  font-weight: 500;
  color: var(--secondary-text);
}

.sparkline-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 10px;
}

.sparkline {
  width: 100%;
  height: 110px;
}

.sparkline-area {
  fill: url(#newapiSparkFill);
}

.sparkline-line {
  fill: none;
  stroke: var(--dashboard-accent);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.trend-caption,
.model-detail,
.card-state p {
  font-size: var(--font-size-helper);
  color: var(--secondary-text);
}

.trend-caption {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.model-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.model-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.model-name {
  font-size: var(--font-size-body);
  word-break: break-word;
  color: var(--primary-text);
}

.model-requests {
  font-size: var(--font-size-caption);
  color: var(--secondary-text);
}

.model-bar-track {
  width: 100%;
  height: 6px;
  overflow: hidden;
  border-radius: var(--radius-full, 999px);
  background: var(--tertiary-bg);
}

.model-bar-fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    var(--dashboard-accent),
    color-mix(in srgb, var(--dashboard-accent) 70%, var(--highlight-text))
  );
}

.panel-empty,
.card-state {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 100px;
  overflow-wrap: anywhere;
  color: var(--secondary-text);
}

.model-detail {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
}

.card-state strong {
  margin-bottom: var(--space-2);
  color: var(--primary-text);
}

.card-state-warning strong {
  color: var(--warning-color);
}

.card-state-error strong {
  color: var(--danger-color);
}

@container dashboard-card (max-width: 460px) {
  .content-grid {
    grid-template-columns: 1fr;
  }
}
</style>
