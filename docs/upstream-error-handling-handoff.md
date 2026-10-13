# 上游错误处理候选交付（2026-10-02）

工作区：`job_20261002_020036_9c3d037b-f68c-4432-8ff6-4a1adda6d5ab`。
基线：`e9c9d83de2144317a1b7e507d61cc32a47a599cf`。仅修改受控 worktree。
未部署、未合并/推送、未启动/停止/重启服务，未改配置、依赖、NewAPI 过滤或生产文件；未删除文件。
候选源码及本报告交由 Worker 正常收尾流程生成 Candidate Commit。本执行环境的 Git 元数据只读，未手工提交或绕过权限；本报告不虚构候选 SHA，以 Worker 最终交付元数据为准。

## 核心变更

- `modules/upstreamErrors.js`：小型共用错误模块。仅完整、限额内 JSON 的 `error.code` / `code` 可识别受控上游码；未知/损坏/超限/超时内容统一 `unknown`，仍保留原始 HTTP status。错误体按 node-fetch 的 Node readable 接口读取，解压后至多 16 KiB、独立 1000 ms；正常 EOF 释放本模块监听，异常路径销毁 body、清理计时器和取消监听，不使用 `text()` / `clone()` 或遗留 reader 的 `Promise.race`。
- `modules/chatCompletionHandler.js`：确定性的 `sensitive_words_detected` 即使 HTTP 500 也立即抛出，不进入 HTTP 重试/模型 fallback；未知 500、503、429、网络失败保留原有有界尝试次数（配置次数与 fallback 候选数取较大值），最后一次失败不退避，等待可取消。移除“401 原文含 token 即重试”的非结构化猜测。统一外层安全输出，HTTP 错误不再误归为网络异常；无 requestId 的断开也会取消请求。
- `modules/handlers/streamHandler.js`：普通工具续轮与 Archery 失败补救续轮均传 `tool_continuation`，非成功响应抛出，不静默退出。正文流异常/提前 close/90 秒空闲超时均终止处理，释放读取监听和计时器，不使用部分内容继续工具循环。
- `modules/handlers/nonStreamHandler.js`：初始、普通续轮和 Archery 补救续轮在读取前检查失败；失败不成为 200 部分成功，也不进入 reasoning-only 补救；原有成功响应和成功空正文语义重试保留，等待/正文读取可取消。
- `modules/diagnostics/requestDiagnostics.js`：现有白名单增加 `upstreamStatus/upstreamCode/upstreamPhase/upstreamAttempt/upstreamRequestId`，只在明确上游阶段存在时输出。下游 SSE HTTP 200 与上游失败 status 分开记录。
- `tests/upstreamErrors.test.js`：54 项合成离线回归，VM 注入 fake fetch、内存流和工具计数器；包含实际外层 handler 加两类续轮、真正 node-fetch Response 的纯内存测试。
- `tests/upstreamRegressionIsolation.cjs`：只为既有 gravity handoff 测试隔离 messageProcessor 的管理器依赖，不改原断言或被测投影实现。

## 输出与重试语义

错误对象仅包含原始 `status`（未收到响应头为 null）、白名单 `code`、`phase`（initial/tool_continuation）、本次 fetch 调用的 1 起始 `attempt` 和安全 `requestId`。后者只检查 `x-request-id`、`request-id` 两个头，以及 JSON 的 `request_id` / `error.request_id`；上限 96 字符，首位字母或数字，其余仅字母、数字、点、下划线、冒号、横线。不导出整个 headers，不从 message 提取 ID，不导出原始 message/body、URL 查询参数或堆栈。

流式错误沿用 HTTP 200 SSE，在 `choices[0].delta.content` 输出固定中文脱敏说明，同帧带 `error.type=upstream_error` 及安全字段，随后一次 `[DONE]`、一次 end。已开始输出的续轮也走此出口；取消/死连接不再写终止帧。非流式返回非 2xx JSON（上游 4xx/5xx 原码，连接/成功头后正文失败为 502，内部错误为 500）。未知 HTTP 500 不会被猜成敏感拒绝。

错误说明只用于最终下游输出，不追加到模型 messages、OneRing 内容或 finalContextStore。原工具回执已经加入续轮请求，失败不清空这些内容、不回滚已完成工具、不自动重跑工具。没有新增跨请求幂等账本，也不承诺失败时所有临时循环上下文都会持久化。手动重试、外部历史恢复或重放仍需外层另行处理。

## 实际验收

环境：Windows PowerShell / Node.js v22.22.1。未安装依赖；现有 node_modules 仅只读导入 node-fetch Response 及其依赖。所有输入、错误内容、工具和词条均合成；未加载配置、认证、Agent 提示词或真实历史，未发出真实网络请求，未监听业务端口。

| 命令/阶段 | 退出码 | 总数 / 通过 / 失败 / 跳过 |
|---|---:|---|
| 修复前 `node --test tests/upstreamErrors.test.js` | 1 | 2 / 0 / 2 / 0 |
| 最终 `node --test --test-reporter=spec tests/upstreamErrors.test.js` | 0 | 54 / 54 / 0 / 0 |
| `node tests/historySanitizer.test.js` | 0 | 12 / 12 / 0 / 0 |
| `node --require ./tests/upstreamRegressionIsolation.cjs --test tests/gravityHandlerHandoff.test.js` | 0 | 15 / 15 / 0 / 0 |
| `node tests/diagnostics.test.js` | 1 | 启动受阻，0 项执行；缺 `scripts/diagnostics-watchdog.js` |
| 下列 7 个 JS/CJS 文件逐个 `node --check` | 各 0 | 7 个语法检查通过 |
| `git diff --check` | 0 | 通过 |

语法检查文件：`modules/chatCompletionHandler.js`、`modules/handlers/streamHandler.js`、`modules/handlers/nonStreamHandler.js`、`modules/diagnostics/requestDiagnostics.js`、`modules/upstreamErrors.js`、`tests/upstreamErrors.test.js`、`tests/upstreamRegressionIsolation.cjs`。

最初两个失败是预期红灯：确定性 500 实际 fetch 3 次（预期 1），工具续轮没有抛出失败（Missing expected rejection）。保留原断言后转绿。中间 `git diff --check` 曾因 Windows 写入 CRLF 报行尾空白（退出 2），已保留未变行的基线字节、改动行使用 LF 修正，再检查为 0。

最终可执行测试合计 **81 项通过，0 失败，0 跳过**；另有 **1 个既有 diagnostics 套件因快照缺依赖受阻**，不算通过。新增测试中的真实 RequestDiagnostics 白名单/外层错误事件已通过，但不能替代缺失套件的 watchdog/CPU/整套验收。未修改旧测试预期、未大范围 skip、未运行占位 npm test、未补拷贝生产源码。

覆盖：400/401/403、未知 500、503/429、网络和连接超时、有界次数与末次无退避；两个流式及两个非流式工具入口；reasoning-only 后确定性拒绝；16 KiB 超限、慢/不结束、部分 JSON 不 EOF、空/损坏/非 JSON、读取错误/提前 close/abort、gzip 解压限制；伪造 code/ID、合成私密 canary、URL/堆栈脱敏；取消退避、工具后取消、带/不带 requestId 的断开、成功头未读完取消；分片中文 SSE、错误/DONE 各一次；成功流与成功工具续轮。

## 未验与授权边界

实际客户端为 VCPMobile 1.1.6，但本任务没有 Android 源码或实机测试。逐字节合成 OpenAI SSE consumer 证明本候选帧可以解析，不等于 Android 兼容性已验。为兼容只读取 delta.content 的客户端，错误提示作为内容输出；客户端可能把它保存到历史。后端本轮不向模型上下文追加提示，不能保证客户端后续不重新带回该文字。

未进行真实 VCP/NewAPI/插件/模型链路验证，未验证 NewAPI dirty binary 的规则或触发字段。测试通过不等于生产已修复。部署、回滚安排和实际 Android 联调仍待外层授权与独立评审。
