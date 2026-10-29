# 模型用量与额度 MVP — 共享接口与实施边界

> 历史设计契约：正文记录 2026-10-19 的协作范围与当时验收边界，不代表功能已上线或当前部署已验收。
> 文中的禁止提交、部署、重启等条款属于该次委托范围，不替代后续独立授权；配置结构与已支持功能以当前实现及测试为准。
> 原始契约正文保留；配置示例使用通用标识，真实配置仍由管理员保存在仓库外或本机运行目录。


用户已于 2026-10-19 19:51 批准实施。本文是本项目设计契约，不代表功能已上线。

## 所有权与工作区
- 赞妮：ADMIN 界面与最终整合/验收。
- Nova：VCPToolBox 后端 modules/usageMonitor/、routes/admin/newapiMonitor.js、小范围测试和接入文档。
- Kerr：VCPChat 的主进程只读 IPC、preload、用量侧栏及测试。
- 两边分支 work/forge-multiend-20261018，存在大量他人 staged/unstaged 改动。不得 stash/reset/add/commit/push，不覆盖已有 dirty 文件。
- 不改 Forge、ClaudeBridge、聊天推理链路、config.env 或 config.env.example。不安装依赖、不重启、不调用模型。
- 不使用要求干净仓库的 AICodeWorker write 绕过门禁。按授权路径原生编辑。各受委托者不得再通过 AgentAssistant 转派。
- 未经另行接入验收，不读取真实供应商密钥/浏览器 Cookie，不访问生产账户数据。使用 fixture + mock transport。
- 仓库代码可写，部署、账户接通与离线测试成功必须分别汇报。

## 后端目标
复用 NewAPI/CPAMP，不引入新推理代理、日志数据库或队列消费者。
在现有 routes/admin/newapiMonitor.js 的 router 增加 GET /usage-monitor/snapshot；已有挂载在两个服务器中沿用，公开路径 /admin_api/usage-monitor/snapshot。
保留原 newapi-monitor/summary、trend、models 的响应兼容。
查询 period=today|7d|month，默认 today，非法值400。采用服务端明确时区，返回绝对区间。
继承现有管理认证，不新增任意 URL/路径/命令代理或 HTTP 配置写入口。

## JSON 契约
```json
{
  "success": true,
  "data": {
    "schemaVersion": 1,
    "generatedAt": "ISO8601",
    "period": { "key": "today", "start": "ISO8601", "end": "ISO8601", "timeZone": "Asia/Shanghai" },
    "accounts": [
      {
        "id": "opaque-local-id",
        "provider": "codex",
        "label": "GPT / Codex",
        "status": "unconfigured",
        "source": "cpamp",
        "observedAt": null,
        "scopeLabel": "订阅账户",
        "linkedChannels": [],
        "sharedPool": false,
        "windows": [
          { "id": "five-hour", "label": "五小时", "remainingPercent": null, "usedPercent": null, "resetsAt": null }
        ],
        "balances": [
          { "currency": "CNY", "available": null, "granted": null, "toppedUp": null }
        ],
        "notice": "未配置",
        "errorCode": "UNCONFIGURED"
      }
    ],
    "activity": {
      "status": "unconfigured",
      "observedAt": null,
      "coverage": "newapi-only",
      "complete": null,
      "truncated": false,
      "source": "newapi",
      "totals": { "requests": null, "inputTokens": null, "outputTokens": null, "cacheReadTokens": null, "totalTokens": null },
      "trend": [ { "at": "ISO8601", "requests": null, "totalTokens": null } ],
      "models": [ { "model": "model-name", "requests": null, "inputTokens": null, "outputTokens": null, "cacheReadTokens": null, "totalTokens": null } ],
      "notice": "仅统计经过 NewAPI 的调用"
    }
  }
}
```
- provider: codex | antigravity | opencodego | deepseek | claude。
- account status: ok | stale | unconfigured | error | unsupported。
- activity status: ok | stale | unconfigured | error。
- 数值未知用 null，不伪造0；已测量的0有效。空窗口/余额用空数组。不把缓存读取额外加在已包含缓存的prompt总量上。
- 默认包含五家卡片；Claude 默认 unsupported，“订阅额度未接入；调用量包含于网关统计”。
- 按账户/额度池而非模型建卡，一个账户多个 linkedChannels 不复制额度。多个账户可以同provider。
- quota显示剩余，各窗口分别展示不平均，过了reset不凭空归满。多币种余额绝不求和。
- 不把NewAPI的quota内部记账单位标成真实美元/订阅费用。第一版不展示金额花费。
- observedAt保留源观测时间；generatedAt不是上游测量时间。请求失败保留上次结果但标 stale，绝不刷成“刚更新”。
- CPAMP已观测窗口过期需标明；缺数据不变成健康。
- 返回别名，不返回邮箱、原始账户ID/认证文件名、token、原始错误body或内部URL。

## 数据与配置
- NewAPI：复用 NEWAPI_MONITOR_* 环境变量与原统计路径 /api/data/、/api/log/stat、/api/log/。原归一化无渠道/缓存信息，缺少细分时必须返回null。日志上限200页*100不能悄悄称完整；truncated=true、complete=false。不和CPA总量相加。
- CPAMP：已运行 v1.14.7，127.0.0.1:18317。只调用 POST /v0/management/quota-snapshots/query（需面板认证）；需要accounts row_key/provider/account身份。Query与legacy helper查本地快照/周期证据，无供应商刷新。不得调用/quota-snapshots写入、巡检、usage-queue。核实源码准确DTO/认证，无法确认则该adapter显式unsupported，不能猜字段。
- DeepSeek：固定官方GET https://api.deepseek.com/user/balance，Bearer。is_available与balance_infos中currency/total_balance/granted_balance/topped_up_balance。数值为金额字符串；账号级余额。
- OpenCode Go：GET https://opencode.ai/zen/go/v1/usage，Bearer API key，rolling/weekly/monthly.percent为0..100。reset字段须核验已发布采集器源码。来源参考 CodexBar v0.77.0 docs/opencode.md 与 nesszer/Win-CodexBar v0.70.0 rust/src/providers/opencodego/usage_api.rs。禁回退本地DB或Cookie估算。
- Claude：不读凭据、不启动CLI、不刷新token，先占位。
- 优先薄API适配，不为简单两接口安装额外守护程序，不重复实现复杂登录/抓取。
- 单一后端本地JSON配置，建议 AppData/usage-monitor/config.json，可静态env VCP_USAGE_MONITOR_CONFIG_PATH覆盖。缺失不导致路由失败。
- tokenEnv引用env名，不允许明文key写配置；配置文件由管理员本地配置，无HTTP写入。示例放docs/usage-monitor-config.example.json，不写生产配置。
- 固定provider域名，CPAMP仅允许静态验证的可信本地地址；禁止URL内凭据和认证请求跨域redirect。请求timeout/响应大小有上限。
- 缓存60秒、singleflight、provider失败隔离，账户缓存跨period复用，不因同时查看三种period对供应商查三遍；配置身份变更不得沿用旧账户last-good。
- 缓存只在内存，不新增持久账本。

## ADMIN
复用官方卡片机制，尽量扩展 NewAPI 原卡为“模型用量与额度”，不默认多一张重复统计卡。
账户资源优先；今日/近七天/本月调用指标与趋势、模型排行其次。显示状态/来源/源观测时间/覆盖范围/不完整警示。
统一剩余条、null为—；余额按币种；共享额度说明；异常/认证/404清楚提示。
仅固定GET；无真实供应商凭据进入Vue；不渲染外部HTML。60s轮询，卸载/失活停止并丢弃迟到回执。

## VCPChat
复用 modules/ui-system/side-pane 的Provider/Tab，model-trajectory.js参考。紧凑“用量”侧栏。
新增白名单主进程IPC和preload，固定读snapshot。主进程复用既有后端配置与管理认证，不在renderer读取/保存/拼装供应商凭据。
modules/weatherService.js只是地址与forum config线索：它实际是renderer脚本，不是可直接照搬的主进程安全实现。
不得修改已dirty的main.js或Forge IPC；寻找干净自动注册入口，找不到提供最小挂载补丁并报告，不擅改脏文件。
404提示后端未更新，401/403提示管理认证未就绪，不回传敏感错误。禁任意URL、禁redirect。
无浮窗、无自动切换、无复杂告警。仅生命周期内轮询；卸载清理。

## 测试与交付
- 纯mock离线：null vs 0、各provider失败、多币种、共享池、窗口不平均、过期时间/last-good、配置变更缓存隔离、singleflight、截断标志、认证/redirect安全、原路由兼容。
- UI测试null/0/stale/unconfigured、注入字符串、生命周期、404/401。
- node --check / node --test，ADMIN沿用现有vitest/vue-tsc/build，不安装依赖。
- git diff --check，列出限定变更文件、真实测试结果和受阻项。
- 不将fixtures通过当作生产接通，不自动部署/重启。