
# AICodeWorker - AI 代码工程 Worker

让 VCP Agent 可以安全调度服务器本地的 [opencode](https://opencode.ai)、OpenAI Codex CLI（及可选的 antigravity/agy），作为下游代码分析、patch 生成、文件修改 Worker。核心理念：**把耗 Token 的代码读写任务交给免费的本地工具执行，VCP 模型只管下命令和看结果**。

## 最快上手：`run_and_wait` + 7 个预设（低算力模型直接抄）

日常 80% 的需求不用自己写任务书，填两三个参数即可：

```text
command: run_and_wait
preset: [预设名]
targetPath: [文件或目录的绝对路径]
```

| preset | 说明 | 必填参数 | 可选参数 |
|--------|------|---------|---------|
| `index` | 列出文件所有函数索引（行号·名称·功能） | targetPath | — |
| `read` | 读取文件完整内容并原文输出 | targetPath | — |
| `scan` | 扫描目录树 + 每个文件用途说明 | targetPath | depth |
| `bug` | 分析某个错误的根本原因 | targetPath, error | detail |
| `set` | 修改文件中某个配置项/变量的值 | targetPath, key, value | — |
| `append` | 在文件末尾追加内容 | targetPath, content | position |
| `create` | 创建或覆写一个文件 | targetPath, what | — |

示例（看文件函数索引）：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run_and_wait「末」,
preset:「始」index「末」,
targetPath:「始」/app/VCPToolBox_new/Plugin/AICodeWorker/AICodeWorker.js「末」
<<<[END_TOOL_REQUEST]>>>
```

用户说的话怎么对应 preset？

| 用户说的话 | 选这个 preset |
|-----------|-------------|
| "看看这个文件/函数" | index |
| "读一下/给我看内容" | read |
| "扫一下目录" | scan |
| "查一下这个报错" | bug（+ error 参数） |
| "把XXX改成YYY" | set（+ key/value） |
| "在文件末尾加一行" | append（+ content） |
| "创建一个文件" | create（+ what） |

预设满足不了的复杂任务，自己写 `task` 参数（见下方「进阶」一节），`run_and_wait` 仍然同步等结果返回，不用走 query 轮询。**完整调用说明以 `plugin-manifest.json` 的 `invocationCommands.description` 为准**（任何算力的 agent 读插件本身就懂，这是单一真相源；本 README 是给人看的补充材料，可能滞后于 manifest）。

## 功能

- **analyze 模式**：只读分析代码结构、逻辑、bug，不修改任何文件
- **patch 模式**：默认保持 legacy；可用独立且默认关闭的 app-server patch flag 生成、验证 unified diff 制品，始终需要人工审查与另行应用
- **write 模式**：默认保持 legacy；Codex 可用独立且默认关闭的 app-server write flag，在隔离 Worktree 中生成并验证候选 commit，主工作树不会被自动修改
- **同步/异步两种调用方式**：`run_and_wait` 直接等结果返回（日常首选）；`run` 立即返回 jobId 不等待，配合 `query`/`listJobs`/`cancel` 用于特别耗时的任务
- **多 Worker**：默认 opencode（免费），复杂任务可点名 antigravity/agy（消耗 Gemini Pro 配额）

## 前置条件

服务器上需安装 [opencode CLI](https://opencode.ai)，安装后确认 `opencode --version` 可用。
未安装时 `capabilities` 命令会返回 `available: false`，此时不可调用 run。

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
# app-server analyze/patch/write 共享固定总上限2；write 另有串行上限1。
# 超限直接拒绝，不排队、不回退；write 从创建 Worktree 起占位，uncertain/finalizationFailed 继续占位。
MAX_CONCURRENT_JOBS=1

# 三个 app-server flag 相互独立，只有严格的字符串 true 才启用；默认都关闭。
ENABLE_CODEX_APP_SERVER_ANALYZE=false
ENABLE_CODEX_APP_SERVER_PATCH=false
ENABLE_CODEX_APP_SERVER_WRITE=false

# write 还必须由 Sidecar 服务端独立确认：专用 Worktree 父目录与允许的真实 Git 仓库根。
# 路径必须是已存在的绝对目录；多个允许根用逗号分隔。调用方不能覆盖这些值。
CODEX_APP_SERVER_WRITE_WORKSPACE_ROOT=/srv/aicw-write-worktrees
CODEX_APP_SERVER_WRITE_ALLOWED_PROJECT_ROOTS=/app/VCPToolBox_new,/app/myproject

# 模型：BASE_URL/API_KEY 都留空 = 用 opencode 自带【免费】模型（不烧你的 token）。
# 但 OPENCODE_MODEL 别留空（留空会回退到付费默认模型），填一个 opencode/ 开头的免费模型：
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
command: run_and_wait
worker: codex
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
- analyze、patch 与 write 共用 Sidecar 的 `maxConcurrency=2` 和 activeJobs 池。

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
保持既有 legacy 行为；开启后，只有实际 Sidecar status 同时证明 write protocol v1 且
服务端配置可用，才走 app-server write。`capabilities` 仅观察当前状态，不启动、替换或
重启 Sidecar，并分别报告：

- `supportsAppServerWrite`：入口 flag 是否开启且实际协议/服务端配置均可用。
- `codexAppServerWriteConfigured`：当前已连接 Sidecar 的服务端 roots、固定验证器与 profile
  是否配置完整。
- `codexAppServerWriteRuntimeAvailable`：当前 Sidecar 是否就绪且 write 配置可用。
- `codexAppServerWriteProtocolSupport`：只表示实时 status 的协议 proof；旧 Sidecar 为 false。

服务端不信任调用参数中的安全配置。它从插件配置独立读取并规范化允许的真实仓库根和专用
Worktree 父目录；请求只能提交项目根、任务、模型、推理强度、Fast 三态与超时，不能指定
shell、测试命令、验证 profile 正文、env、cwd 或制品路径。Worktree 路径和候选 ref 由
服务端生成并锁定。

内置固定验证 profile `builtin-static-v1` 会真实执行 `git diff --check HEAD --`，并对候选中
变更的 JSON 执行 `JSON.parse`、对 `.js/.cjs/.mjs` 执行 `node --check`；它拒绝变更符号链接。
这只是窄用途静态检查，不是项目测试，不会运行 `npm test` 或候选仓库脚本。通过后内核创建
candidate commit；结果只表示可人工审查的候选，不表示主分支、主工作树或远端已被修改。

write 串行上限为1，同时仍占用 Sidecar 的共享总额度2。占位从 Worktree 创建前开始；
submission unknown 或 `finalizationFailed` 会保留占用，避免绕过串行。已选想运行 app-server
write 后，旧 Sidecar、拒绝、失败、unknown 或最终化失败都不会回退 legacy，也不会重放
validation/commit。继续用原 jobId 执行 `query`/`cancel`；full/compact、`listJobs` 和
`run_and_wait` 沿用现有语义，并有限返回 baseRevision、resultCommit、changedFiles、validation
摘要、Worktree 保留状态和脱敏错误。

候选 Worktree/ref 默认保留供人工审查；本功能不 merge、不 push、不 cherry-pick，也不自动
删除唯一候选产物。Worktree 只隔离 Git 工作区，不是 OS 安全边界；Codex 仍依赖
`workspace-write` 沙箱、approval policy `never`、禁用网络和服务端路径门禁。


## Codex 逐任务 Fast mode

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
command: run_and_wait
worker: codex
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

当前模型自身默认是 `low`；本机 Codex 配置显式设为 `medium`，因此不传时当前有效默认值为 `medium`。

插件会按以下优先级确定实际模型：
1. 单次调用的 `model`
2. AICodeWorker 的 `CODEX_MODEL`
3. Codex Profile 配置
4. Codex 基础 `config.toml`

随后从 `models_cache.json` 读取该模型的 `supported_reasoning_levels`。未知模型或无法验证时会拒绝覆盖，不会盲传。

```text
command: run_and_wait
worker: codex
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
- opencode CLI（需单独安装）
- 无 npm 额外依赖


## 多 Worker：opencode（免费）/ antigravity（agy，复杂任务）

用 `worker` 参数选择由谁执行：

| worker | 底层模型 | 成本 | 适用 |
|--------|---------|------|------|
| `opencode`（默认） | 自带免费 zen 模型 | 免费、基本无限 | 常规/批量/简单代码活 |
| `codex` | Codex CLI 当前登录配置 | 按 Codex 账户/API 计费 | 严谨开发、改码、测试、审查 |
| `antigravity`（即 agy） | Gemini 3.x / Claude 4.6 等 | 吃 Gemini Pro 配额(约1500/天,60/分钟) | 复杂、需严谨设计、点名 agy 的任务 |

- 需 `config.env` 设 `ENABLE_ANTIGRAVITY=true` 才有 antigravity；未开启则只用 opencode（行为同以前）。
- agy 依赖 `AGY_BIN`（建议绝对路径）和 `AGY_PROXY`（连 Google 的代理，墙内必填）。详见 config.env.example。

### agy 可用模型（填 AGY_MODEL 或调用时传 model；用 label 全名含括号）
- `Gemini 3.5 Flash (High)`（默认,快）/ `(Medium)` / `(Low)`
- `Gemini 3.1 Pro (High)`（最强,啃硬骨头）/ `(Low)`
- `Claude Opus 4.6 (Thinking)` / `Claude Sonnet 4.6 (Thinking)` / `GPT-OSS 120B (Medium)`
- 查最新清单：`agy models`

### 抄作业①：点名用 agy（低算力模型直接照填）
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run_and_wait「末」,
worker:「始」antigravity「末」,
projectPath:「始」/app/VCPToolBox_new「末」,
task:「始」分析 server.js 的请求处理流程，指出潜在并发问题，不修改任何文件。「末」,
mode:「始」analyze「末」
<<<[END_TOOL_REQUEST]>>>
（要用最强模型做最难的活，再加一行）  model:「始」Gemini 3.1 Pro (High)「末」

### 抄作业②：多协作（opencode 干粗活 + agy 啃硬骨头，并行）
第1步 简单部分派 opencode（用 run 异步，记下返回 jobId）：
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run「末」,
worker:「始」opencode「末」,
projectPath:「始」/app/VCPToolBox_new「末」,
task:「始」统计 modules 目录有哪些文件、各自行数。「末」,
mode:「始」analyze「末」
<<<[END_TOOL_REQUEST]>>>
第2步 复杂部分派 agy（用 run 异步，记下 jobId）：
<<<[TOOL_REQUEST]>>>
tool_name:「始」AICodeWorker「末」,
command:「始」run「末」,
worker:「始」antigravity「末」,
projectPath:「始」/app/VCPToolBox_new「末」,
task:「始」分析 modules/vcpLoop 的工具调用解析逻辑，评估健壮性与边界处理。「末」,
mode:「始」analyze「末」
<<<[END_TOOL_REQUEST]>>>
第3步 分别用 query 查这两个 jobId 的结果，收齐后综合成一份报告回复。

⚠️ **两条铁律**：
1. 并行的两个任务书必须操作【不相交的文件】，否则写冲突；有先后依赖的任务串行做。
2. **内存铁律**：每个 opencode/agy 实例启动后占用约 1.5~2G 内存，本服务器内存上限 6G。**严禁同时并发派出多个 AICodeWorker 任务**（哪怕一个 opencode 一个 agy 也不行），否则会撑爆内存导致服务器卡死——这不是假设，2026-06-26 真实发生过一次（两个 opencode 并发分析任务，内存被打到99%）。正确做法永远是：**串行调用**——等上一个 `run_and_wait`/`query` 返回结果后，再发下一个。上面这个"并行多协作"示例仅作历史参考，**当前不推荐这样用**，请改成串行执行。
   ⚠️ 2026-06-27此规则已升级为**代码强制**：超过 `MAX_CONCURRENT_JOBS`(默认1)时提交会被直接拒绝报错（不会排队、不会卡死，opencode和antigravity共用同一计数）。这是双重保险——子进程清理已修复（不会再堆积僵尸进程拖垮服务器），但并发任务瞬时资源冲击的风险仍存在，所以保留这道硬闸门。
