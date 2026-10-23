# 模型用量与额度监控（Usage Monitor）说明

## 一、架构与职责边界
- **后端接口**：`GET /admin_api/usage-monitor/snapshot?period=today|7d|month`（挂载于 `routes/admin/newapiMonitor.js`，复用现有 `/admin_api` 管理鉴权）。
- **核心模块**：`modules/usageMonitor/index.js`。
- **双端共享快照**：
  - **VCP Admin (`NewApiMonitorCard.vue`)**：仪表盘「模型用量与额度」完整总览卡片（账户配额/余额 + 今日/近7天/本月网关统计 + 趋势与模型排行 + 详情展开）。
  - **VCPChat (`usageMonitorSideProvider.js`)**：侧栏「用量」紧凑面板，通过主进程只读 IPC (`usage-monitor:get-snapshot`) 拉取同一快照。

## 二、数据源与去重准则
1. **NewAPI 网关统计 (`activity`)**：
   - 复用 `NEWAPI_MONITOR_BASE_URL`、`NEWAPI_MONITOR_ACCESS_TOKEN`、`NEWAPI_MONITOR_API_USER_ID`。
   - 优先读取 `/api/log/` 消费日志，提取请求数、输入 Token、输出 Token、缓存读取 Token（`other.cache_tokens`）。
   - 注意：`prompt_tokens` 已包含缓存读取 Token，总 Token 为 `inputTokens + outputTokens`，不二次累加缓存读取。
   - 若消费日志超过 200 页（20,000 条），显式标记 `truncated: true, complete: false`。
2. **CPAMP 本地配额快照 (`codex` / `antigravity`)**：
   - 通过本机 `POST /v0/management/quota-snapshots/query` 读取配额快照；配置具备账户身份时还可经 CPAMP `/v0/management/api-call` 查询 Codex 实时窗口、Antigravity 配额和模型窗口。实时查询会访问供应商，不应将其描述为纯离线快照读取。
   - 窗口统一转换为剩余百分比（`remainingPercent = 100 - usedPercent`），各窗口独立展示不平均，已过重置时点不凭空归满而标记为 `stale`。
3. **OpenCode Go (`opencodego`)**：
   - 调用 `GET https://opencode.ai/zen/go/v1/usage`，解析五小时（`rolling`）、周（`weekly`）、月（`monthly`）剩余百分比与重置时间。
4. **DeepSeek 官方余额 (`deepseek`)**：
   - 调用 `GET https://api.deepseek.com/user/balance`，按币种独立展示 `available`、`granted`、`toppedUp`，不同币种绝不相加。
5. **Claude (`claude`)**：
   - 未配置本地 Bridge 时显示 `unsupported`。配置后仅向经回环地址校验的 Bridge 请求 `GET /v1/quota`，解析五小时、周度及可用的 Sonnet/Opus 周窗口；失效或过期数据保留 last-good 并标记 `stale`。监控模块不直接获取 Claude OAuth 凭据；Bridge 端的配额采集是独立部署依赖。

## 三、本地配置文件
- 默认路径：`AppData/usage-monitor/config.json`（可通过环境变量 `VCP_USAGE_MONITOR_CONFIG_PATH` 覆盖）。
- 配置由部署端单独维护；本次提交按用户要求排除配置文件及配置模板，不能依赖仓库携带现用账户映射。
- **安全约束**：配置文件中严禁填写明文密钥（`apiKey`/`token`/`password`）。通过 `tokenEnv` 引用服务端环境变量；本地 Claude Bridge 还支持 Windows 当前用户 DPAPI 加密凭据文件 `tokenFile`，明文不进入响应。所有上游请求禁用重定向并限制响应大小。