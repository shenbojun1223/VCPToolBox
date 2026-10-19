# 服务器 Forge × PI 执行器验收 — 2026-10-15

## 结果
服务器 `10_1_0_14` 已完成真实单 Worker 闭环：
BeginCapture → PI 派工 → 修改实现 → 主控独立测试与范围检查 → FinishCapture。
这是执行器能力验收，不代表中央 Hub、跨设备工程接管或全局写锁已实现。

## 可溯源证据
- 工程：`pyemj`；根：`C:\VCP\VCPToolBox\tmp\forge-pi-server-poc`。
- 独立沙盒 Git 基线：`638f8a9993e5abeb9f2257d0140a59447b9af488`，基线五条测试 3 pass / 2 fail。
- BeginCapture：`c2220b2c6282a1595ef46d44d`。
- requestId：`server-single-worker-20261015-01`；仅登记 `src/slug.js`。
- PI-Desktop / Host：`0.20.1`，内部协议 11；MCP 工具 24。
- 唯一新会话：`a84bcef0-5f45-44bc-af72-cf21c9fb0f1b`。
- 模型：`go-deepseek41-low`；会话权限 `auto` 已读回验证。
- 中文 prompt UTF-8 SHA-256：
  `5488a1fa6955c94e0bcde38fa1b76fa7c559a04f4a6d04e11e1d60a5372dfef6`；
  durable user message 读回相同。
- Worker 已停止，pendingToolConfirmations=0。
- 主控独立运行原始测试 5/5，进程退出码 0；额外 10 项语义边界全部通过。
- 沙盒哈希比较：只有 `src/slug.js` 改变，`test/slug.test.js` 字节未变。
- 同一观察窗口：外层仓库 3542 个 tracked / nonignored untracked 普通文件哈希无变化。
  此检查不涵盖所有 ignored 运行时文件，也不能证明没有越界读取；不是 OS 沙箱。
- FinishCapture：finished，外部批次 `b10`。
- 原会话 `--resume` 真实只读查询成功，未再次派工。

派工资料位于已允许的仓库外目录：
`C:\VCP\ClaudeBridge\operations\forge-server-poc-20261015`。
包括 prompt、checkpoint、stdout/stderr、baseline.json、verification.json。
不将控制 token、Provider 密钥、运行时检查点提交进源码仓库。

## 驱动 v5 修复
工程 `p23nd`，核心修复批次 b7，离线回归 b8。
- PI 返回状态为 `{status:{isRunning,...}}`，兼容直接状态对象并严格校验。
- 会话消息在 `session.messages`，兼容旧顶层 messages。
- 权限必须以 pi_session_get 的读回值为准，不能只相信 configure ack。
- prompt 提交前保存 `submitting_unknown`；已有 checkpoint 拒绝重新派工。
- resume 只查询原会话，并重新核验 durable prompt hash。
- HTTP 单次等待限制 30 秒；轮询总时长可配置。
- 允许 require 导入测试，不在导入时连接 MCP。
- `node --test poc-probe.test.cjs`：12/12，通过；超时恢复离线覆盖。
  真实任务正常完成，未人为制造真实超时。
- v5 当前只部署于服务器插件目录；不能声称已同步到各前端电脑。
- 状态 completed 只表示会话停止且 prompt 校验通过，不代表业务测试或范围验收通过。

## 已知边界
- Capture 是显式范围收录，不是权限隔离，开工与收工要求外部写者静止。
- 现有 checkpoint 为本地 PoC 防重派保护，尚非跨进程原子抢占或生产级调度器。
- durable 消息读取仍有页数/长度上限，长会话需要后续补分页策略。
- 服务器原生 Forge 入口实测不支持 command1/command2；使用独立工具调用。
- 业务仓库开工前已存在多项改动，本轮未重置、提交或推送业务仓库。
- ServerProjectForge 整体目前在外层 Git 中仍为未追踪目录；
  正式跨机交付前需将可发布代码归入明确的源码仓库，剔除配置、依赖和二进制产物。