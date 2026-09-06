# AICodeWorker - AI 代码工程 Worker

## Agent 调用规则（本部署，2026-09-05）

- 每次显式传 worker=codex；插件底层默认 worker 仍为 opencode，不传不会自动选择 Codex。
- Fast 默认不启用：所有 Codex run/run_and_wait 都显式传 fastMode=false。只有用户明确要求本任务开启 Fast 才传 true；“继续”“尽快”“并发”不构成 Fast 授权。不要把一次授权扩展到后续任务。
- API 兼容语义未改变：省略/null/空字符串会继承 Codex 配置，不等于关闭 Fast。上述默认关闭是 Agent 调用规范，不是后端强制默认。
- 纯搬砖任务（目标、路径和验收已明确的机械修改、批量实现、按既定方案补测试）使用 model=gpt-5.6-luna、reasoningEffort=max。不得因是 write 模式就一律用 Luna；架构判断、需求不清及独立审查另行选型。
- 派任务前查 capabilities，针对拟用模型核对可用性与合法推理档位；能力不符则报告，不静默换模型。模型默认档位随配置变化，不硬编码。
- app-server analyze/patch/write 共享总额度3，其中 Write最多2；legacy Worker共用独立额度1（以实时 capabilities 为准）。2W+1A/P、1W+2A/P、3A/P可行；第三个Write或第四个总任务拒绝，不排队。
- 额度按仍持有所有权的任务计数，创建Worktree、验证、提交和未释放的终态均占槽；不能仅因模型停止输出就认为名额释放。
- 默认 command=run。收到成功提交与 jobId 后结束当轮，不自动连续轮询；用户说“跑完了/继续/查结果”后单次 query，优先 wait=false,responseMode=compact。run_and_wait仅在用户明确要求同步等待时使用。
- 超时/中断/提交结果unknown先查询原jobId和落盘证据，禁止直接重发；取消要核实目标任务已收敛，不全局杀进程。

## 快速使用

以下仅为普通字段示例，不是可执行工具请求块：

```text
command: run
worker: codex
projectPath: <白名单内干净Git仓库根>
task: <目标、相对文件路径、禁区与验收要求>
mode: write
model: gpt-5.6-luna
reasoningEffort: max
fastMode: false
traceMode: events
timeoutSec: 1200
```

提交后保存jobId；用户要求查结果时单次query。Write结果是独立Worktree中的候选commit，不自动应用到原分支。复杂分析或审查不要机械套用搬砖模型。

## 说明如何进入Agent

`plugin-manifest.json → capabilities.invocationCommands[].description → Plugin.js/buildVCPDescription → {{VCPAICodeWorker}} → messageProcessor变量展开`。`{{VCPAllTools}}`包含全部已生成说明；`{{VCPDynamicTools}}`走动态选择，具体注入由动态注册器决定。README仅供人工阅读。Lucy还有`Agent/Lucy.txt`的长期调用规范，需要与工具说明保持一致。

manifest元数据监听会重建工具说明并发出tools_changed；Agent文件有缓存失效监听。正常后续请求读取新说明，不需要重启Codex Sidecar。磁盘修改不等于当前会话历史文本已被改写；运行态刷新仍需实际核验。

## 模式与前提

- analyze：只读。
- app-server patch：只读生成并验证patch，不自动apply，要求干净Git根及受支持文件操作。
- app-server write：干净原仓库 → 独立Worktree → 修改 → 固定静态验证 → 候选commit；不自动合并。使用相对文件路径，不指示Worker写原工作区。
- 静态验证不是项目功能测试；超时/unknown不重放。
- 安装默认与本部署启用状态不同，实际以capabilities确认。
- legacy预设index/read/scan/bug/set/append/create保留，但不作为本部署默认调用方式。

## 配置

`config.env`：

```env
# opencode 可执行文件路径（在 PATH 中则填 opencode）
OPENCODE_BIN=opencode

# 允许操作的项目根目录白名单（逗号分隔），projectPath 必须在其中
ALLOWED_PROJECT_ROOTS=/app/VCPToolBox_new,/app/myproject

# 项目背景说明，自动注入每条任务书前面，省去 VCP AI 每次重复介绍项目背景（多项目共用本插件时建议留空）
PROJECT_CONTEXT=

# 大文件预检阈值(KB)，任务涉及文件超过此大小会在 warnings 里提醒缩小范围/分段处理（默认 200）
FILE_SIZE_WARN_KB=200

# ⚠️ legacy runner 并发上限（opencode、legacy Codex、antigravity共用），默认1。
# app-server analyze/patch/write 共享固定总上限3；write 另有固定上限2；legacy 仍为1。
# 超限直接拒绝，不排队、不回退；write 从创建 Worktree 前起占位，terminal 尚未删除、
# submission unknown 与 finalizationFailed ownership 都继续占槽。
MAX_CONCURRENT_JOBS=1

# 三个 app-server flag 相互独立，只有严格的字符串 true 才启用；默认都关闭。
ENABLE_CODEX_APP_SERVER_ANALYZE=false
ENABLE_CODEX_APP_SERVER_PATCH=false
ENABLE_CODEX_APP_SERVER_WRITE=false

# write 还必须由 Sidecar 服务端独立确认：专用 Worktree 父目录与允许的真实 Git 仓库根。
# 路径必须是已存在的绝对目录；多个允许根用逗号分隔。调用方不能覆盖这些值。
CODEX_APP_SERVER_WRITE_WORKSPACE_ROOT=/srv/aicw-write-worktrees
CODEX_APP_SERVER_WRITE_ALLOWED_PROJECT_ROOTS=/app/VCPToolBox_new,/app/myproject

# 可选opencode配置示例，非本部署默认；免费资格和费用取决于所选模型及服务商。
# 显式选择并核验OPENCODE_MODEL，不能仅凭示例名认定当前免费：
#   opencode/deepseek-v4-flash-free（推荐，代码强）/ opencode/north-mini-code-free（轻量）
#   / opencode/mimo-v2.5-free / opencode/big-pickle
# 用 `opencode models | grep opencode/` 看最新清单。
# 若要改用自有模型：把 BASE_URL 和 API_KEY 都填上即切换（会消耗你的 token，且别用推理模型）。
OPENCODE_BASE_URL=
OPENCODE_API_KEY=
OPENCODE_MODEL=opencode/deepseek-v4-flash-free

# 单次任务最大字符数（默认 20000）
MAX_TASK_CHARS=20000

# 默认超时（秒，默认 600）
DEFAULT_TIMEOUT_SEC=600

# ⚠️ 2026-06-27起此开关已失效（保留仅兼容旧配置，填什么不影响行为）。
# 曾经只write模式自动跳过权限确认，analyze/patch不跳过——结果analyze模式一旦
# 触发opencode工具调用确认，因AICodeWorker是无人值守进程(stdin=ignore)，没人能点确认，
# 直接卡死到超时(2026-06-27实测：不加--dangerously-skip-permissions时日志0字节+timeout)。
# 现已改为三种模式恒自动批准——这是修复死锁bug，不是放宽安全。安全边界=mode=write门槛 + ALLOWED_PROJECT_ROOTS白名单 + 任务写明约束词。
ALLOW_DANGEROUS_SKIP_PERMISSIONS=false

# 脱敏输出中的密钥/Token（默认 true）
REDACT_SECRETS=true
```

## Codex CLI Worker

Codex 适合作为“VCP 外层大脑 + Codex 下层执行器”架构中的代码执行层：

- `worker=codex`
- `analyze` / `patch` → Codex `read-only` 沙箱
- `write` → Codex `workspace-write` 沙箱
- 不绕过 Codex 原生沙箱
- 默认 `--ephemeral`，长期记忆仍由 VCP RAG/DailyNote 管理
- Windows 使用 Job PID + `taskkill /T` 清理当前任务进程树，不全局杀 Codex
- Codex 登录态必须对运行 VCP/PM2 的同一系统用户有效
- 已实测 Codex CLI 0.144.5 的 Windows `workspace-write` 沙箱会保护工作目录中的 `.git` 与 `.agents`；目录不存在时可能创建空占位目录并写入拒绝沙箱写入的 ACL。这不是模型越权修改。write 模式应优先把 `projectPath` 指向真实仓库根目录，插件不得自动删除这两个目录

配置示例：

```env
ENABLE_CODEX=true
CODEX_BIN=C:\VCP\path\to\codex.exe
CODEX_MODEL=
CODEX_PROFILE=
ALLOWED_PROJECT_ROOTS=C:\VCP\VCPToolBox
JOB_ROOT=C:\VCP\VCPToolBox\Plugin\AICodeWorker\jobs
```

调用示例：

```text
command: run
worker: codex
fastMode: false
projectPath: C:\VCP\VCPToolBox
task: 请只读分析指定模块，给出文件依据与验证结论，不修改文件。
mode: analyze
```

## Codex app-server patch 安全契约

`ENABLE_CODEX_APP_SERVER_PATCH=false` 是独立的默认值。它不会被 analyze/write flag
隐式开启，反向也一样：

- flag 关闭：`worker=codex, mode=patch` 完全保持 legacy 行为。
- flag 开启：只有 `worker=codex, mode=patch` 走 app-server；非 Codex Worker 不受影响。
- app-server patch 第一版不接受 attachments 或 `sessionId`，不自动应用 patch，
  也不会隐式开放 app-server write。
- analyze、patch 与 write 共用 Sidecar 的固定 `maxConcurrency=3` 和 activeJobs 池。

patch 路由还需要实际 Sidecar status 提供完整的正向 proof：
`patchProtocolSupported=true`、`patchContractVersion=1`、`patchMaxBytes=524288`、
`patchRepositoryPolicy="clean-git-root"`、`patchOperations=["modify-existing-tracked-file"]`。
因此 `codexAppServerPatchProtocolSupport` 表示实际协议证明，
`supportsAppServerPatch` 还会额外要求 patch flag=true；flag=false 时可以观察到新协议，
但绝不宣称 patch route 已启用。缺字段或旧 Sidecar 只能是 unknown/false，不能乐观升级。

app-server patch 只接受干净 Git 仓库根目录，并只允许修改现有、已 tracked 的 regular
file。create/delete/rename、mode change、binary、submodule 一律拒绝。内核固定使用
read-only sandbox、approval policy `never` 与禁用网络；调用方不能覆盖 cwd、sandbox、
approval、network、artifact 目录或 patch 路径。

状态机为：

```text
prepared → submitting → accepted → baseline-check → running
         → validating → publishing → completed
         └────────────────────────────→ failed/cancelled/timeout
```

提交严格 exactly-once。一旦 Job/meta 已创建，只调用一次 `submitPatchJob`；IPC timeout、
closed/error、畸形响应或 request mismatch 都视为 submission unknown，保留原 jobId，禁止
重放或回退，只能继续 `query`/`cancel`。Sidecar 缺失、启动失败、无响应、并发满、
`UNKNOWN_METHOD`、协议或 Codex 版本不匹配也全部 fail-closed，不会退回 legacy。

公开结果不直接返回 patch 正文。full/compact 只有在 `state=completed`、后端与 jobKind
匹配、三项验证布尔值均为 true，且固定 public patch 的目录/regular-file identity、hash、
bytes 持续复验通过时，才返回 `patchFile`、SHA-256、字节数、文件数、base HEAD 和验证状态；
否则 `patchFile=null, patchAvailable=false`。trace 仅返回安全阶段与错误码，不返回 delta、
目标文件、Git stderr/status、candidate/nonce 或 artifact identity。

Monitor 不信任 meta 中自行写入的 `patchAvailable`；每次投影都会对 app-server patch
重新调用同一只读授权 verifier，只暴露 `patchAvailable`、验证布尔值、bytes 和 fileCount。
制品缺失、篡改、目录漂移或 verifier 异常均降级为 false，不返回 patch 正文、target path、
真实 artifact identity、nonce 或 Git 诊断。过期 Job 清理只处理 terminal Job，并用同一套
固定目录、regular-file identity、hash 和 bytes 规则精确删除 public patch；证明不足时保留制品
并记录有界安全错误，legacy 清理保持原兼容行为。

即使 query 已授权，真正应用 patch 前仍必须重新确认仓库 HEAD 与工作树基线未变化，并再次
执行 apply/check；query 的授权结果不是自动应用许可。

> 运维门禁：Slice 3A 之前启动的旧 Sidecar 不具备 patch RPC。开启 patch flag 前，必须先
> 对旧 Sidecar 做有界 shutdown，确认退出后再启动新实例。不要依赖 capabilities 自动启动、
> 替换或热升级 Sidecar；无法从实际 status 证明 patch 协议时，能力值只能是 unknown/false。

## Codex app-server Worktree Write Preview

`ENABLE_CODEX_APP_SERVER_WRITE=false` 默认关闭。关闭时 `worker=codex, mode=write`
保持既有 legacy 行为；开启后，只有实际 Sidecar status 同时证明 write protocol v2、
`writeMaxConcurrency=2` 且
服务端配置可用，才走 app-server write。`capabilities` 仅观察当前状态，不启动、替换或
重启 Sidecar，并分别报告：

- `supportsAppServerWrite`：入口 flag 是否开启且实际协议/服务端配置均可用。
- `codexAppServerWriteConfigured`：当前已连接 Sidecar 的服务端 roots、固定验证器与 profile
  是否配置完整。
- `codexAppServerWriteRuntimeAvailable`：当前 Sidecar 是否就绪且 write 配置可用。
- `codexAppServerWriteProtocolSupport`：只表示实时 status 的协议 proof；旧 Sidecar 为 false。
- `appServerMaxConcurrentJobs` / `codexAppServerWriteMaxConcurrency`：客户端预期的固定 3/2 额度。
- `appServerRuntimeMaxConcurrentJobs` / `codexAppServerWriteRuntimeMaxConcurrency`：当前实例实际
  status 报告的额度；没有可验证的运行实例时为 null。

服务端不信任调用参数中的安全配置。它从插件配置独立读取并规范化允许的真实仓库根和专用
Worktree 父目录；请求只能提交项目根、任务、模型、推理强度、Fast 三态与超时，不能指定
shell、测试命令、验证 profile 正文、env、cwd 或制品路径。Worktree 路径和候选 ref 由
服务端生成并锁定。

内置固定验证 profile `builtin-static-v1` 会真实执行 `git diff --check HEAD --`，并对候选中
变更的 JSON 执行 `JSON.parse`、对 `.js/.cjs/.mjs` 执行 `node --check`；它拒绝变更符号链接。
这只是窄用途静态检查，不是项目测试，不会运行 `npm test` 或候选仓库脚本。通过后内核创建
candidate commit；结果只表示可人工审查的候选，不表示主分支、主工作树或远端已被修改。

write 固定上限为2，同时仍占用 Sidecar 的共享总额度3。额度检查和 Map 占位在首个异步
操作前同步完成；creating、running、validating、committing，以及 terminal 但尚未从 Map 删除的
ownership 都计数。submission unknown 或 `finalizationFailed` 也会保留占用，避免绕过限额。
第 3 个 Write 或第 4 个 app-server 总任务会立即拒绝，不排队。已选想运行 app-server
write 后，旧 Sidecar、拒绝、失败、unknown 或最终化失败都不会回退 legacy，也不会重放
validation/commit。继续用原 jobId 执行 `query`/`cancel`；full/compact、`listJobs` 和
`run_and_wait` 沿用现有语义，并有限返回 baseRevision、resultCommit、changedFiles、validation
摘要、Worktree 保留状态和脱敏错误。

候选 Worktree/ref 默认保留供人工审查；本功能不 merge、不 push、不 cherry-pick，也不自动
删除唯一候选产物。Worktree 只隔离 Git 工作区，不是 OS 安全边界；Codex 仍依赖
`workspace-write` 沙箱、approval policy `never`、禁用网络和服务端路径门禁。

> 从总额2 / write protocol v1 升级到固定3/2与 write protocol v2 时，必须选择无活跃任务的
> 维护窗口，对旧 Sidecar 做有界、受控重启并确认退出后再启动新实例。额度或 proof 不匹配会
> fail-closed；客户端不会自动重启、替换、回退或重放，`capabilities` 也只观察不启动。


## Codex 逐任务 Fast mode

**Agent规范：默认显式传 `fastMode=false`；仅用户明确要求本任务Fast才传true。以下三态是API兼容语义，不代表允许Agent默认继承Fast。**

`fastMode` 是 Codex 专用的三态逐任务开关：

| 调用值 | 行为 |
|---|---|
| `true` | 请求将本 Job 档位覆盖为 Fast（`serviceTier=fast`） |
| `false` | 请求将本 Job 档位覆盖为默认档（`serviceTier=default`） |
| 不传或留空 | 继承 Codex `config.toml` / Profile 配置 |

Legacy `codex exec` 与 app-server analyze/patch/write 执行链均支持。Fast mode 与
`reasoningEffort` 独立。显式覆盖是否可用、是否被后端采用取决于模型、计划、额度和
服务容量；它可能增加额度消耗，但不保证加速。返回及 meta 中的 `fastMode` /
`serviceTierOverride` 只记录请求的覆盖值，不表示后端实际采用的 tier。

app-server 会以当前连接的 Sidecar `status` 实时握手。旧 Sidecar 不支持显式覆盖时，
`true` / `false` 会在提交前被拒绝且不回退、不重放；省略参数仍按原行为兼容。
`capabilities.supportsPerTaskFastMode` 表示插件总体支持该参数，不等同于当前长驻
Sidecar 已通过逐任务档位覆盖协议握手。

```text
command: run
worker: codex
fastMode: false
mode: analyze
fastMode: true
projectPath: C:\VCP\VCPToolBox
task: 请只读分析指定模块，不修改文件。
```

## Codex 逐任务推理强度

`reasoningEffort` 按本次实际 Codex 模型动态校验，不再由插件固定成三档。

当前 `gpt-5.6-sol` 支持：

| reasoningEffort | 建议场景 |
|---|---|
| `low` | 快速检查、小范围机械任务 |
| `medium` | 常规开发、调试、测试与审查 |
| `high` | 复杂问题与跨模块分析 |
| `xhigh` | 需要额外推理深度的困难任务 |
| `max` | 最困难问题的最大推理深度 |
| `ultra` | 最大推理并自动委托子任务；使用量可能显著增加 |

不传 reasoningEffort 时继承当前 Codex 配置，未覆盖时使用模型默认值；实际默认与合法档位用 capabilities 针对所选 model 查询，不在说明中写死。上述表格是档位一般含义，不覆盖本部署选型：纯搬砖任务显式使用 gpt-5.6-luna / max，并显式 fastMode=false。

插件会按以下优先级确定实际模型：
1. 单次调用的 `model`
2. AICodeWorker 的 `CODEX_MODEL`
3. Codex Profile 配置
4. Codex 基础 `config.toml`

随后从 `models_cache.json` 读取该模型的 `supported_reasoning_levels`。未知模型或无法验证时会拒绝覆盖，不会盲传。

```text
command: run
worker: codex
fastMode: false
mode: analyze
reasoningEffort: xhigh
projectPath: C:\VCP\VCPToolBox
task: 调查复杂调用链，给出文件与行号依据，不修改文件。
```

只开放模型声明支持的档位，不开放任意 Codex `rawArgs` 或 `-c` 参数；沙箱、白名单、并发和 `--ephemeral` 仍由插件强制控制。

## 执行轨迹与可见性

AICodeWorker 默认仍只返回最终报告。需要查看 Codex 的执行过程时，可传：

| traceMode | 返回内容 |
|---|---|
| `summary` | 默认；仅最终报告 |
| `events` | 整理后的阶段说明、命令、命令输出、文件变更、工具结果与 Token 用量 |
| `raw` | 脱敏、限长的原始 JSONL；内部推理字段始终排除 |

即时查看运行中任务：

```text
command: trace
jobId: job_xxx
traceMode: events
```

也可使用：

```text
command: query
jobId: job_xxx
wait: false
traceMode: events
```

这不是可插话的第二个终端。VCP Agent 仍负责审查轨迹、判断是否返工，并发起下一份任务书。

## 进阶：异步工作流（run + query，不等结果立即返回）

日常任务直接用 `run_and_wait`（见顶部「最快上手」）就够了。以下 `run`/`query` 异步模式只在任务**特别耗时**、需要"先提交、过会再来看结果"时才用。

### 1. 提交任务（run）

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run「末」,
worker:「始」opencode「末」,
projectPath:「始」/app/VCPToolBox_new「末」,
task:「始」请分析 Plugin/AICodeWorker/AICodeWorker.js 的整体结构，说明主要函数的作用，不要修改任何文件。「末」,
mode:「始」analyze「末」
<<<[END_TOOL_REQUEST]>>>
```
### 2. 查询结果（query）

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」query「末」,
jobId:「始」job_20260620_001910_172286「末」
<<<[END_TOOL_REQUEST]>>>
```

state 含义：`running` 进行中 / `completed` 成功 / `failed` 失败 / `timeout` 超时

## 命令速查

| 命令 | 说明 | 关键参数 |
|------|------|---------|
| `capabilities` | 查询 opencode / Codex / antigravity 可用状态 | 无 |
| `run` | 提交任务，立即返回 jobId | `worker` `projectPath` `task` `mode` `timeoutSec` `traceMode` `reasoningEffort` `fastMode` |
| `query` | 查询任务结果；`wait=false` 可即时返回 | `jobId` `wait` `traceMode` |
| `trace` | 即时读取已有执行轨迹 | `jobId` `traceMode` |
| `listJobs` | 列出历史任务 | `limit`（默认10） |
| `cancel` | 取消进行中任务 | `jobId` |

## 模式选择指南

| 场景 | 推荐模式 |
|------|---------|
| 理解代码结构/排查 bug | `analyze` |
| 需要人工审查再决定是否修改 | `patch` |
| 已明确需求，直接让 AI 实现 | `write` |

## 安全机制

- `projectPath` 必须在 `ALLOWED_PROJECT_ROOTS` 白名单内，否则拒绝执行
- `task` 内容长度上限由 `MAX_TASK_CHARS` 控制
- `REDACT_SECRETS=true` 时自动脱敏输出中的 API Key / Token

## 依赖

- Node.js >= 16
- 所选Worker的CLI：本部署使用Codex；opencode/antigravity仅在选择对应后端时需要
- 无 npm 额外依赖


## 可选 Worker 与并发边界

本部署 Agent 默认显式选择 worker=codex；插件 API 的 worker 缺省值仍为 opencode，二者不要混淆。

| worker | 定位 | 使用条件 |
|---|---|---|
| codex | 本部署默认代码执行器；纯搬砖使用 gpt-5.6-luna / max | capabilities确认模型与档位；默认fastMode=false |
| opencode | 可选legacy后端 | 用户另行指定且实际可用；模型与费用以服务商为准 |
| antigravity | 可选legacy后端 | 用户另行指定且实际启用；模型与配额以实际配置为准 |

- app-server analyze/patch/write共享总额度3，Write最多2；2W+1A/P、1W+2A/P或3A/P均可。
- legacy Codex exec、opencode、antigravity共用独立额度，默认1；不能把legacy单并发限制套到app-server。
- 第三个Write或第四个app-server任务拒绝，不排队；已有任务未释放ownership前继续占槽。
- 同仓两个Write各自产生独立Worktree和候选commit，不直接覆盖彼此；候选之间仍可能有语义或合并冲突，不自动合并。有先后依赖的任务按依赖顺序执行。
- 提交成功拿到jobId后停止自动轮询；用户要求查结果时单次query。取消与异常恢复的必要状态核验不受此限制。
- 不自动改全局模型、Fast或服务配置；不能因用户说“尽快”就开启Fast。
