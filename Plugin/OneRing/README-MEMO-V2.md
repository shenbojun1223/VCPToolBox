# OneRingMemo V2 Phase 2

V2 仍是独立影子实现，不接入 V1 的 `injectMemo`、`generateMemo`、`scheduleAutoGenerate` 或活动 DB/Memo。默认路径只读、只构建指标，不调用模型、不写文件；本阶段没有生产 feature flag，也不执行 promote。

## Phase 2 批处理事务

单个 Prompt 不能容纳全部 current events 时，静默裁剪事件会造成更严重的问题：如果随后把完整 snapshot delta 的 `nextCursor` 当作成功游标，未进入模型的 canonical events 就会被错误消费，之后无法自然重试。因此 V2 先用 `MemoV2BatchPlanner` 按完整事件边界规划所有批次，任何单事件超预算都失败，不跳过事件。

影子归并采用 all-or-nothing multi-batch transaction：工作态从 previous state 深拷贝开始，批次按稳定顺序逐一构建 Prompt、调用注入的模型客户端、严格校验并合并；中间批次不推进正式游标、不写 candidate、不设置最终成功时间。只有全部批次成功、覆盖断言和全局安全校验通过后，才确定性 render，并最多写一次 candidate；此时才把完整 snapshot 的 `nextCursor` 一次推进。任一批失败都会停止后续批次并丢弃 working state，previous state 与正式游标保持不变。

### 可信外层日期边界

每一个模型批次都以 canonical event 的可信外层日期为硬边界：日期解析复用 `MemoV2Reducer.eventDate()`，只读取 `event.occurredAt`，不从正文日期推断，也不改写 `occurredAt`。相邻事件的 trusted outer date 发生变化时立即封批，即使请求预算仍有余量；单日事件在日期边界内继续使用原有预算贪心装箱。

canonical event 始终保持原始顺序，不做全局日期排序或 `groupBy(date)`；因此 `A → B → A` 会形成三个连续日期段，后来的 A 不会向前重排。该结构限制模型把不同日期事件合并为同一事实，但 `MEMO_V2_CROSS_DATE_FACT` 仍是 validator 的不可重试语义错误，不会被加入格式重试，也不会自动拆分 reduction 后放行。

日期边界只影响批次规划，不计为 dropped/skipped；metrics 只报告 `dateBoundedBatching`、连续日期段数、边界分割数、每批唯一日期计数和混合日期批次数，不输出具体日期、事件 ID、正文或 actor。V2 当前仍保持独立影子态。

默认 shadow metrics 模式只读取快照并报告 `plannedBatchCount`、canonical event 全覆盖计数、零丢弃/零重复和批次 Prompt 预算；它不实例化真实模型客户端、不读取环境密钥、不创建 `memo-v2` 状态目录、不写 candidate。默认完整请求预算为 10000 字符，这是根据当前 Gemini 网关实测得到的保守值，不是 provider 的正式公开限制；`--max-input-chars` 可显式覆盖。V2 当前仍为影子态，生产 V1 没有任何接入。

## Prompt-only deterministic semantic projection

### Prompt-only canonical redaction placeholder stripping

Canonical archive 是事实层，可以保留确定性的脱敏占位符（例如 `[REDACTED]`）；构造 Prompt 时才对深拷贝工作副本执行 sanitizer，删除凭据字段外壳、Bearer 外壳和独立占位符，不恢复未知敏感内容，也不插入替代标记。若非空 canonical text 被完全删除，事务以 `MEMO_V2_PROMPT_SANITIZATION_EMPTY` 失败，不丢弃事件。

对不含精确 canonical redaction placeholder 的文本，Prompt sanitizer 是严格逐字 no-op；它不是通用空白规范化器。

模型只能看到 sanitizer 之后、固定 3750 字符 cap 之前的文本；sanitization 与 semantic projection 是两套独立统计。PromptBuilder 会拒绝模型可见字段中残留的占位符，输出 validator 仍严格拒绝模型输出中的占位符，不自动清洗或放行。`promptSanitization` 只存在于 Prompt 工作副本，compact event、candidate、state 和 rendered memo 不包含该元数据；普通 metrics 只记录计数。

该处理不改变 Canonical Event、eventUid、contentHash、来源/日期/actor 校验、批次覆盖、状态归并或游标事务边界。当前能力仍处于独立影子态：默认 CLI 只读并输出非正文 metrics，不调用真实模型、不写 candidate、不 promote，也不接入 V1 Memo。

Canonical Event 是真相层：`eventId`、时间、actor、origin、role/kind、artifactRefs、source identity、delta、hash、数据库和 V2 state lineage 永不因请求预算而改写。Prompt Projection 只在构造模型请求时生成深度隔离的惰性工作副本，canonical event 数量、顺序和 validation contract 保持不变；投影副本不会进入 working state、candidate、timeline、active threads、thread history 或 rendered memo。

默认对每个事件使用固定 3750 字符的 `text` cap，并继续使用 10000 字符的完整请求预算。3750 是当前真实微明只读实测下的最高可行固定值：98 个 canonical events、预留 12 个 active threads、44 批、最大完整请求 9995 字符，98/98 覆盖且 dropped=0、duplicate=0；原文超过 3750 的事件恰好 12 个，实际投影 12 个，移除 32013 字符，工具请求/结果摘要丢失 0。4000/4250 仍有单事件超预算，较低 cap 的语义保留更少。可通过 `--event-text-cap-chars` 或调用参数显式覆盖测试 cap。

PromptBuilder 不执行自适应的隐式二次降 cap：每个事件只按调用方 cap（未提供时固定 3750）投影一次。若固定 cap 后 mandatory request 仍超过预算，直接抛出 `MEMO_V2_PROMPT_BUDGET_EXCEEDED`；BatchPlanner 对无法容纳的单事件转换为 `MEMO_V2_EVENT_EXCEEDS_PROMPT_BUDGET`，不静默跳过或丢弃事件。`eventTextCapChars`、`projectedEventCount` 和 `projectionRemovedChars` 只反映最终固定 cap 工作副本；全计划中每个 canonical event 只计一次。

投影不等于事件丢弃：事件数量、ID 和原始 source lineage 仍完整覆盖，metrics 会把 `projectedEventCount`/`totalProjectionRemovedChars` 与 dropped/duplicate 独立统计。选择顺序优先保留工具请求/结果摘要，其次是任务/委托/约束/验收、结果/失败/阻塞/完成、用户更正/边界，再保留首尾语境锚点；按原顺序使用段落、行和句子边界，必要时才做 Unicode 安全裁剪。工具摘要无法容纳时稳定失败，不静默丢失。

模型只能依据可见投影文本生成高置信 reduction；`textProjection` 是服务端压缩元数据，不是会话事实，模型不得声称省略正文的具体内容。语义不足时必须返回空 reduction，不得猜测。投影后仍执行归档输入安全检查，原始 VCP 协议、HTML 和未脱敏凭据不会被恢复或引入。

该能力当前仍处于独立影子态：默认 CLI 只读构建 metrics，不调用真实模型、不写 candidate、不创建生产 `memo-v2` 状态，也不接入 V1 Memo、活动 DB 或 promote。

## 真实模型格式边界

- provider 接收 `response_format` 只代表 best-effort 请求，不保证返回严格 JSON；`thinking_budget`、`include_thoughts` 或同类参数也不是可靠的泄漏控制手段。
- V2 保留严格 JSON parser，不从杂文中搜索或截取 JSON 对象。模型输出超过任一固定 V2 上限时不裁剪、不自动纠错；`MEMO_V2_LIMIT_EXCEEDED` 与格式/schema 服从性失败一样，最多按配置执行 3 次更小、合法、完整的重生成（默认 `formatRetries=2`）。
- 限额本身不放宽；每次重生成仍使用同一批 canonical events、当前 working state、wire contract 和 validation contract，只传短错误码，不传上一轮模型正文或 arguments。
- 只有格式错误、`MEMO_V2_LIMIT_EXCEEDED` 以及 malformed `sourceMessageIds` 容器/元素（`MEMO_V2_INVALID_SOURCES`、`MEMO_V2_INVALID_SOURCE_ID`）允许有界格式重试；unknown/stale source、跨日期/未知日期、身份、安全、assignee、状态转换等语义错误，以及 `MODEL_TRUNCATED`/`SAFETY_BLOCKED` 不重试并立即失败。网络/HTTP 重试仍由 `InternalModelClient` 的 transport retry 独立处理；通用 HTTP 400 只有显式 opt-in 且同时满足精确 status/type/message/空 code 条件时才有限重试，日志只保留 attempt、status 和内部稳定 code。
- 来源格式重试只要求模型对同一批重新生成完整合法参数：服务端不自动把标量包装成数组、不删除坏元素、不替换为当前 ID；unknown/stale/cross-date source 仍按语义错误处理。当前 V2 仍为独立影子态，不接入 V1、不 promote、不写生产状态。
- format retry 与 transport retry 分别计数；任一批次最终失败都会全事务回滚，丢弃 working state，不写 candidate、不推进 cursor，也不返回部分状态。当前 V2 仍为独立影子态。

## Phase 1 安全基础

- `lib/MemoEventNormalizer.js`：把 messages 行转换为 canonical event；只使用 DB 外层 `timestamp` 作为 `occurredAt`，清理上下文包装、脱敏、工具摘要、artifact 路径和长文本元数据。
- `lib/InternalModelClient.js`：依赖注入式 completion 客户端；调用方提供连接参数，不读取 dotenv/config.env，不经过主聊天处理器。
- `lib/MemoV2Store.js`：独立 schemaVersion 2 状态、candidate 和 failure artifact，使用临时文件加 rename 原子写。
- `lib/MemoDeltaBuilder.js` 与 `OneRingMemoV2.js`：只读快照、游标增量、bootstrap 范围和 delta package 构建。

## Phase 2 影子链路

链路为 `canonical events → structured reducer → validated candidate state → deterministic renderer`：

- `lib/MemoV2Reducer.js`：严格 JSON（兼容唯一完整 `json` 围栏）与手工 schema 校验；来源 ID、可信外层日期、状态、actor、长度、敏感字段和 VCP 协议均有约束及稳定错误码。模型不得提供日期、factId 或 cursor。
- `lib/MemoV2StateReducer.js`：纯函数式事实/任务合并；确定性 factId/threadId、来源和 actor 合并、任务 transition、timeline 保留策略、threadHistory 和候选 cursor。
- `lib/MemoV2Renderer.js`：不调用模型，按日期升序渲染 `YYYY-MM-DD`/`- 事实`，单独追加 `未闭环任务`，在事实边界执行字符预算和最终安全检查。
- `lib/MemoV2PromptBuilder.js`：只传必要的 canonical event 字段和紧凑状态快照；归档数据明确标为 inert/untrusted，按完整事件边界裁剪，不传完整旧 Memo、工具百科或连接信息。
- `lib/MemoV2Orchestrator.js`：提供 `prepareReductionRequest`、`validateReductionResponse`、`buildCandidateState`、`generateShadowCandidate`。模型客户端必须注入；只有 `writeCandidate: true` 才写 candidate，任何失败都不推进正式状态 cursor。
- `lib/MemoStaleDeltaView.js`：纯安全增量 helper，默认最多 12 条、8000 字符；本阶段不接入 `injectMemo`。

## 结构化模型协议

Gemini 当前工具 Schema 不稳定支持 nullable/string 混合类型，因此 V2 使用 wire-only sentinel：模型只返回工具调用 arguments 中的严格 JSON 对象，服务端在 semantic validator 前严格解码：

```json
{
  "facts": [
    { "text": "完成数据源调研", "sourceMessageIds": ["68", "69"] }
  ],
  "threadUpdates": [
    {
      "threadId": "__NEW_THREAD__",
      "task": "调研数据源",
      "status": "in_progress",
      "constraints": ["个人预算"],
      "assignedBy": "Lucy",
      "sourceMessageIds": ["68", "69"]
    }
  ]
}
```

日期由服务器依据 canonical event 外层时间推导；factId 和新 threadId 由服务器确定性生成。未被本批更新的 open/in_progress/blocked 任务会保留。

### 标识符契约

- 模型没有标识符生成权。每个 batch 的 user prompt 都包含可信的 `SERVER_VALIDATION_CONTRACT` allowlist：`currentEventIds`、实际展示的 active `existingThreadIds` 和去重后的 `currentActorNames`；archived data 仍是 inert/untrusted，未展示的 `threadHistory` ID 不会进入 allowlist。
- `facts` 与 `threadUpdates` 的 `sourceMessageIds` 必须逐字复制当前 batch 的 `currentEventIds`，每项至少一个；不能发明、改写、拼接、推导或使用 archived timeline 的旧 source ID。
- 新任务的 `threadId` 必须逐字使用 `__NEW_THREAD__`，服务端随后解码为逻辑 `null` 并生成正式 ID；更新既有任务时只能逐字复制 allowlist 中的 `existingThreadIds`，不能自行生成 ID。
- `assignedBy` 只能使用 `__NO_ASSIGNEE__`（服务端解码为逻辑 `null`）或逐字复制 `currentActorNames`；不从事件正文自述猜测身份。
- 两个 sentinel 只允许出现在各自对应字段，不能出现在 task/text/constraints/sourceMessageIds 或任何 ID 中；它们不会进入状态、thread history、renderedMemo 或最终 Memo。
- 无法高置信形成事实/任务更新时返回 `{"facts":[],"threadUpdates":[]}`。validator 是真正边界，不会把未知字符串自动改成 `null`，也不会猜测模型意图；这些语义错误立即失败，不进入 format retry。
- format retry 使用同一 wire contract、同一 batch、working state 和 validation contract，不回退到逻辑 null 表述，也不嵌入上一轮模型正文；当前 V2 仍为影子态。

## Shadow candidate CLI

默认只构建请求指标：

```powershell
node Plugin/OneRing/scripts/memo-v2-shadow-candidate.js --agent 微明 --request-metrics
node Plugin/OneRing/scripts/memo-v2-shadow-candidate.js --agent 微明 --timeline-days 3 --fallback-count 30
```

显式模型调用必须同时提供三项开关/参数：

```powershell
node Plugin/OneRing/scripts/memo-v2-shadow-candidate.js --agent 微明 --call-model --write-candidate --model <model-name>
```

连接参数只允许由进程环境 `ONERING_INTERNAL_MODEL_BASE_URL`、`ONERING_INTERNAL_MODEL_API_KEY` 注入。stdout 只输出指标；candidate 仅允许写入独立 `Plugin/OneRing/memo-v2/` 范围，禁止写 V1 Memo/DB，禁止 promote。测试使用 mock client，不调用真实模型。

## 离线测试与 Phase 1 dry-run

```powershell
node --test Plugin/OneRing/tests/memo-v2.test.js Plugin/OneRing/tests/memo-v2-phase2.test.js
node Plugin/OneRing/scripts/memo-v2-dry-run.js --agent 微明
node Plugin/OneRing/scripts/memo-v2-shadow-candidate.js --agent 微明 --request-metrics
```

测试使用临时目录和 mock client，不访问真实 API、活动 DB/Memo 或正式 `memo-v2` 目录。生产 V1 仍保持冻结。

## 下一阶段

Phase 3 才会讨论 feature flag、stale injection、调度和 promote；本阶段不做任何生产接入。
