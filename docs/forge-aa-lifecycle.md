# AgentAssistant → Forge 生命周期绑定

工程 `py9el`；隔离分支 `work/forge-aa-lifecycle-20261031`。
服务器基线 `339a1b91ed53e9646e8fd178aebd3e7a276c1531`。
阶段校准（2026-11-02）：原生命周期服务端 `225c22c9`、NextPrompt 调度解析补丁
`8ef123d3` 已部署；前端 `c9625dfd` 仅在家中部署，公司客户端尚未取得该提交。
本次 **NextPrompt 工具派发隔离** 仅隔离开发与离线验证，尚未提交、部署或重载。
真实双轮失败样本 `pwl5f` 保留；公司页面与完整生产闭环未验收。下文原验收和部署
清单保留其历史阶段含义，不能当作当前两端加载状态；最新增量见文末。

## 调用契约

原 AgentAssistant 异步参数保持不变，显式添加：

```js
{
  agent_name: '鲸鱼娘',
  maid: 'Kerr',
  task_delegation: true,
  session_id: '每次任务独立的真实锁分组键',
  forge_project_id: '实际本地工程ID',
  forge_todo_seq: 1,
  forge_role: '鲸鱼娘#实际任务',
  prompt: '自包含工单；明确文件、工具及读写范围'
}
```

这里是参数示例，不是已执行派单；不要沿用示例标识。
`forge_project_id` 必须为同一 VCPToolBox 宿主 ServerProjectForge 的本地工程；
不接受远端展示 ID，不根据 prompt、session_id 或同名工程猜绑定。
只允许异步模式；定时、普通聊天、查询及取消不能混带绑定参数。
缺失参数、宿主能力不可用、无工程写权或同 Todo 已有活动绑定时，
拒绝发生在模型 HTTP 请求之前。未绑定调用仍按原路线运行。

绑定不增加模型工具、文件写权或权限隔离。失败不自动重派。
`forge_role` 可省略；使用真实调用名，最多100字符。
派工署名和 session_id 必须符合受控单行字段约束。

## 状态与业务完成度独立

| AA 生命周期 | 委托阶段 | 展示 |
| --- | --- | --- |
| queued | pending | 待受理 |
| running | working | 施工中 |
| waiting | working | 等待续跑 |
| cancelling | working | 取消中 |
| completed | review | 待核验 |
| failed | unknown | 执行失败 |
| cancelled | unknown | 已取消 |
| stopped | unknown | 已停止 |

**成功返回不等于产物核验通过。** 本接线不写 `verified`，不自动改变 Todo 的业务
`pending/doing/blocked/done`。失败、取消不是产物“核验退回”。
独立验收仍由主控在实读证据后完成；目前没有新增自动验收 API。
若要恢复传统验收备注展示，主控需明确保存/移除机器块，再按原契约记录独立验收；
移除会令旧回调失效，不应在委托仍运行时操作。

## 存储和并发边界

- 复用活动 Forge 服务的连接、工程锁、可用性和写权限守卫；不另开业务数据库。
- `meta` 中以真实 delegationId 保存绑定；同时绑定工程、Todo 序号及数据库行 ID。
- `Todo.note` 前置 `ForgeDelegation v1` JSON 块；原备注正文逐字保留，不改业务状态。
  机读块最多2048 UTF-8字节，原备注最多60000字符；失败事务回滚。
- 同 Todo 的活动绑定互斥；同一委托重复绑定幂等。
  终态后可用新委托显式替换，旧委托回调和较小序号事件不覆盖新状态。
- 修改或删除状态块、替换同序号 Todo 行，会使后续回调以 `DELEGATION_STALE` 拒绝。
- 生命周期序号单调，终态不可退回运行；受理时保存 queued，请求执行前保存 running，
  心跳等待保存 waiting，最后保存终态并通知 Forge changed。
- 同步错误见 AA 快照 `forgeBinding.syncError`；模型完成与状态同步必须分别核验。
  不返回原始异常文本作为同步错误码；没有无限重试。
- 原有会话锁隔离继续有效，取消仍是合作式取消；不会强杀在途模型 HTTP。
- 异常终态只归档/回调一次，防止 finally 与外层 catch 重复发送。

## 持久化与版本兼容限制

不新增数据库表/列；使用既有 meta 和 note，不改变目录传输协议。
远端 Todo 的 note 预览上限2048字符；块在最前面，使完整块可以独立解析。
兼容前端会校验工程和 Todo 身份；损坏或不完整的块不回退套用旧正文中的通过态。
远端不传数据库行ID，前端只能校验来源工程/序号；宿主写回仍强校验真实行ID。
机器块是来源文本声明，不是数字签名，不能证明模型存活、产物存在或权限隔离。

当前无跨进程恢复/持久任务队列。进程意外退出后 queued/working 可能滞留；
需人工对照 AA 归档及回执，不把滞留状态当实时心跳。不要自动重派。
删除工程可能留下 meta 历史绑定，未新增自动清理流程。

## 隔离验证

```powershell
node --test tests/forgeDelegationService.test.cjs tests/forgeDelegationLifecycle.test.cjs tests/agentAssistantDelegationConcurrency.test.js tests/agentAssistantFlowlockProtocol.test.js
git -c core.whitespace=cr-at-eol diff --check
```

首轮41/41通过；最终加入模型输出保护与真实Handler回归后，6文件 **120/120通过**，退出码0。
7个JS语法检查、manifest JSON解析及CRLF感知差分检查通过。
最终日志 `.evidence/server-final.tap`；生产目标路径相对基线无差异，尚未部署或重启。
AA新增6项先红，既有10项通过；存储层初始为缺模块加载失败，不冒称8项逐项验红。
真实宿主入口测试发现 projectOf 读取规范化小写 projectid，已修并通过。
只用临时数据库、内存文件与 HTTP 替身，不连接真实模型。
混合 EOL 文件保留既有 CRLF；三处无关 LF 段原字节已还原，记录 `.evidence/eol-preservation.json`。
证据不纳入源码提交。

## 原生命周期开发阶段的部署与真实闭环待办（历史记录）

1. 当前生产 ServerProjectForge/AgentAssistant 尚未加载本增量；家中前端另有隔离交付。
2. 部署前重新核验两端版本和脏文件，保全运行配置及活动库。
   备份 SQLite 使用在线 backup 或独立维护窗口，不直接复制活动 WAL 库冒充一致副本。
3. 两个服务均为常驻 hybridservice；磁盘更新不证明内存生效。
   `vcp-main` 重启需单独授权，并从承载当前对话以外的执行通道进行；
   不在同轮等待它重启，不与 VCPSleep 并发。若重启客户端主进程也须另行授权。
4. 新建独立测试工程/Todo；**冻结负例 pe0oe 不改、不标done，已结束委托不重派**。
5. 正例真实委托明确传绑定字段，禁止主控和分身手写阶段；
   同时观察 AA、源Todo、Hub发布版本、客户端快照及可见页面，不手动刷新。
6. 成功返回应停在待核验，业务Todo状态保持原值。检查失败/取消及迟到事件隔离。
7. 目录读取的生产原始根因仍未确定。本轮仅修可复现的冲突恢复和安全诊断，
   不能宣称偶发故障已根治，也不能用合成窗口代替真实端到端验收。

## NextPrompt 工具派发隔离（2026-11-02，未部署）

### 故障与边界

真实失败样本 `pwl5f` / `aa-delegation-1793604415670-5819e377` 在单个 AA
请求内提前执行了 NextPrompt 中的 ReadCode 示例；虽然四次只读调用及答案正确，
但没有 90 秒等待或第二个 AA 心跳，67.260 秒即收口。宿主 `Succeed` 与
`completed/review` 不构成该工单验收通过，业务 Todo 继续 `pending`。

调度解析和工具派发是不同边界：`8ef123d3` 可正确解析首轮 `start/90`，
但内层 VCP 工具循环在把回复交给 AA 前，已扫描并执行了未来提示中的工具示例。

### 当前隔离实现契约

- `ToolCallParser.maskNextPromptRegions()` 只生成当前可执行视图：完整或未闭合的
  NextPrompt 区域均按原 UTF-16 长度遮罩，保留换行，避免删除区域后拼接出新工具。
  嵌套提示到最外层闭合才恢复；未闭合提示保护到末尾，孤立结束标签不抑制普通调用。
- 工具块先按既有模糊边界及 ESCAPE 词法跳过；参数中的提示边界是字面数据，
  不能开关外层作用域。结果块内边界也不参与提示配对。未闭合工具/结果块保守保护到末尾。
- `parse()` 过滤当前工具派发；原始 `extractNextToolBlock()` / `parseBlock()` 保持词法
  行为，供角色分段和防护调用，不把它们误当成派发授权入口。
- `ModelOutputGuard` 先按原规则检查新输出，再遮罩执行投影；可见正文及下一轮提示原文
  不改写。伪回执、角色控制、DSML 和行长防护不因此放宽。
- 两种 Handler 及流式工具闭合检查通过共用执行视图排除未来示例；当前顶层工具、
  参数缩进、CRLF、Unicode 及 ESCAPE 内容保持。
- 此实现不新增权限沙箱、队列或模型行为保证，不改变 AA 的 90 秒时限规则。
  原始历史净化模块不在本次修改范围；离线通过不代表所有未来数据格式都已验收。

### 验证与接续

证据位于隔离根 `.evidence/nextprompt-tool-scope-20261102/`，不纳入源码交付：
- `red-result.json`：实现前 88 项，61 通过、27 失败，退出码 1；
- `green-r1-result.json`：同组 88/88，退出码 0；
- `regression-r1-result.json`：扩大至 14 个测试文件，304/304，零失败、取消或跳过；
- `saved-live-output-repro.json`：仅解析保存的真实首轮输出，新版 0 次候选派发，
  下一轮原文与计划一致、保留 start/90；旧版仍列出那次 ReadCode。没有执行日志里的工具。
- 流式逐字符和所有二段切点验证、真实 Handler + 替身工具均为离线合成范围，
  不宣称已生产加载或完成一次新的真实双轮任务。

生产仍为 `8ef123d3`；本轮不提交推送、部署、重启或新派真实委托，不修改旧失败
样本及业务 Todo。后续受控上线须另行核对授权、Git 状态、备份和独立重载证据；
新的真实双轮验收使用新样本，不重派 `pwl5f` 或旧委托。