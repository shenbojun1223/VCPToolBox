import { HttpError, toHttpError } from '@/platform/http/errors'
import { executeRequest } from "@/platform/http/request";

export interface NewApiMonitorQuery {
  startTimestamp?: number
  endTimestamp?: number
  modelName?: string
}

export interface NewApiMonitorSummary {
  source: string
  start_timestamp: number
  end_timestamp: number
  model_name: string | null
  total_requests: number
  total_tokens: number
  total_quota: number
  current_rpm: number
  current_tpm: number
}

export interface NewApiMonitorTrendItem {
  created_at: number
  requests: number
  token_used: number
  quota: number
}

export interface NewApiMonitorModelItem {
  model_name: string
  requests: number
  token_used: number
  quota: number
}

export type UsageMonitorPeriodKey = 'today' | '7d' | 'month'
export type UsageMonitorProvider = 'codex' | 'antigravity' | 'opencodego' | 'deepseek' | 'claude'
export type UsageMonitorAccountStatus = 'ok' | 'stale' | 'unconfigured' | 'error' | 'unsupported'
export type UsageMonitorActivityStatus = 'ok' | 'stale' | 'unconfigured' | 'error'

export interface UsageMonitorWindow {
  id: string
  label: string
  remainingPercent: number | null
  usedPercent: number | null
  resetsAt: string | null
}

export interface UsageMonitorBalance {
  currency: string
  available: number | null
  granted: number | null
  toppedUp: number | null
}

export interface UsageMonitorAccount {
  id: string
  provider: UsageMonitorProvider
  label: string
  status: UsageMonitorAccountStatus
  source: string
  observedAt: string | null
  scopeLabel: string
  linkedChannels: string[]
  sharedPool: boolean
  windows: UsageMonitorWindow[]
  balances: UsageMonitorBalance[]
  notice: string
  errorCode?: string
}

export interface UsageMonitorActivityTotals {
  requests: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  totalTokens: number | null
}

export interface UsageMonitorActivityTrendItem {
  at: string
  requests: number | null
  totalTokens: number | null
}

export interface UsageMonitorActivityModelItem {
  model: string
  requests: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  totalTokens: number | null
}

export interface UsageMonitorActivity {
  status: UsageMonitorActivityStatus
  observedAt: string | null
  coverage: 'newapi-only'
  complete: boolean | null
  truncated: boolean
  source: string
  totals: UsageMonitorActivityTotals
  trend: UsageMonitorActivityTrendItem[]
  models: UsageMonitorActivityModelItem[]
  notice: string
}

export interface UsageMonitorSnapshot {
  schemaVersion: number
  generatedAt: string
  period: {
    key: UsageMonitorPeriodKey
    start: string
    end: string
    timeZone: string
  }
  accounts: UsageMonitorAccount[]
  activity: UsageMonitorActivity
}

interface NewApiMonitorEnvelope<T> {
  success?: boolean
  data?: T
  error?: string
  message?: string
}

interface NewApiMonitorTrendPayload {
  source: string
  start_timestamp: number
  end_timestamp: number
  model_name: string | null
  items?: NewApiMonitorTrendItem[]
}

interface NewApiMonitorModelsPayload {
  source: string
  start_timestamp: number
  end_timestamp: number
  items?: NewApiMonitorModelItem[]
}

interface MonitorError extends Error {
  status?: number
}

const DEFAULT_MONITOR_TIMEOUT_MS = 10000

function buildQueryString(query: NewApiMonitorQuery = {}): string {
  const params = new URLSearchParams()

  if (query.startTimestamp != null) {
    params.set('start_timestamp', String(query.startTimestamp))
  }

  if (query.endTimestamp != null) {
    params.set('end_timestamp', String(query.endTimestamp))
  }

  if (query.modelName) {
    params.set('model_name', query.modelName)
  }

  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

function createMonitorError(message: string, status?: number): MonitorError {
  const error = new Error(message) as MonitorError
  error.status = status
  return error
}

async function requestMonitorData<T>(
  path: string
): Promise<T> {
  let payload: NewApiMonitorEnvelope<T> | null = null

  try {
    payload = await executeRequest<NewApiMonitorEnvelope<T>>(
      {
        url: path,
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        timeoutMs: DEFAULT_MONITOR_TIMEOUT_MS,
      }
    );
  } catch (error) {
    const normalizedError = toHttpError(error)

    throw createMonitorError(normalizedError.message, normalizedError.status)
  }

  if (payload?.success === false) {
    throw new HttpError(payload.error || payload.message || 'NewAPI monitor request failed')
  }

  if (!payload?.data) {
    throw createMonitorError('NewAPI monitor response is missing data')
  }

  return payload.data
}

export const newApiMonitorApi = {
  async getSummary(query: NewApiMonitorQuery = {}): Promise<NewApiMonitorSummary> {
    return requestMonitorData<NewApiMonitorSummary>(
      `/admin_api/newapi-monitor/summary${buildQueryString(query)}`
    )
  },

  async getTrend(query: NewApiMonitorQuery = {}): Promise<NewApiMonitorTrendPayload> {
    const data = await requestMonitorData<NewApiMonitorTrendPayload>(
      `/admin_api/newapi-monitor/trend${buildQueryString(query)}`
    )

    return {
      ...data,
      items: Array.isArray(data.items) ? data.items : [],
    }
  },

  async getModels(
    query: Omit<NewApiMonitorQuery, 'modelName'> = {}
  ): Promise<NewApiMonitorModelsPayload> {
    const data = await requestMonitorData<NewApiMonitorModelsPayload>(
      `/admin_api/newapi-monitor/models${buildQueryString(query)}`
    )

    return {
      ...data,
      items: Array.isArray(data.items) ? data.items : [],
    }
  },

  async getUsageSnapshot(period: UsageMonitorPeriodKey = 'today'): Promise<UsageMonitorSnapshot> {
    const params = new URLSearchParams({ period })
    return requestMonitorData<UsageMonitorSnapshot>(
      `/admin_api/usage-monitor/snapshot?${params.toString()}`
    )
  },

  async getDashboardSnapshot(query: NewApiMonitorQuery = {}): Promise<{
    summary: NewApiMonitorSummary
    trend: NewApiMonitorTrendItem[]
    models: NewApiMonitorModelItem[]
  }> {
    const [summaryResult, trendResult, modelsResult] = await Promise.allSettled([
      this.getSummary(query),
      this.getTrend(query),
      this.getModels({
        startTimestamp: query.startTimestamp,
        endTimestamp: query.endTimestamp,
      }),
    ])

    if (summaryResult.status !== 'fulfilled') {
      throw summaryResult.reason
    }

    return {
      summary: summaryResult.value,
      trend: trendResult.status === 'fulfilled' ? trendResult.value.items || [] : [],
      models: modelsResult.status === 'fulfilled' ? modelsResult.value.items || [] : [],
    }
  },
}
