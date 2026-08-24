# AgentAssistant

AgentAssistant 通过本机 VCP `/v1/chat/completions` 调用已配置的协作 Agent，支持即时通讯、独立临时咨询、持久会话、未来通讯、异步委托、进度查询、合作式取消和单次工具注入。

## 配置

当前配置真相源是 `Plugin/AgentAssistant/config.json`，可在管理面板的 AgentAssistant 页面维护并热重载。运行配置可能包含私有系统提示词，已被 `.gitignore` 排除；仓库模板见 `config.json.example`。旧 `config.env` 仅在 `config.json` 不存在时用于一次性迁移。

每个 Agent 至少需要：

- `baseName`：安全的 ASCII 标识，建议仅使用字母、数字、下划线和连字符。
- `chineseName`：工具调用使用的准确名称，可以是任意语言，但必须唯一。
- `modelId`：本地 VCP `/v1/models` 已可路由的模型 ID。
- `systemPrompt`：可直接写提示词。若引用已注册主 Agent 的 `{{agent:Alias}}`，先确认其展开内容不包含密钥、私人变量或不必要的完整上下文。

AgentAssistant 固定调用本机 VCP 并复用主服务 `PORT` 与 `Key`，不需要在此为每个 Agent 重复填写 URL 或 API key。

## 即时通讯

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」AgentAssistant「末」,
agent_name:「始」Nova「末」,
maid:「始」赞妮「末」,
session_id:「始」TASK-001「末」,
prompt:「始」请审查这份方案并返回证据、结论和残余风险。「末」
<<<[END_TOOL_REQUEST]>>>
```

同一任务复用 `session_id`。一次性、无需历史的咨询传 `temporary_contact: true`。

## 异步委托

增加 `task_delegation: true` 后，工具会立即返回 `delegationId` 和动态结果占位符。调用方必须原样保留实际占位符，之后可用 `query_delegation` 查询。`cancel_delegation` 仅设置取消请求，不会强制中断已经发出的模型 HTTP 请求。

异步轮数和预算来自 `config.json` 的 `delegationMaxRounds` 与 `delegationTimeout`。超时在轮次边界检查，已发出的单轮请求仍受 VCP 的通讯超时控制，因此它不是严格的墙钟中断。

## 未来通讯

`timely_contact` 格式为 `YYYY-MM-DD-HH:mm`，按 VCP 服务器本地时区解释。调度只保存 `agent_name`、完整 `prompt` 与 `maid`；不会保留 `session_id`、`temporary_contact`、`task_delegation` 或 `inject_tools`。
