# VCP 故障诊断补丁

本文档对应本次诊断补丁。模块在环境开关缺省时不产生诊断目录、不挂载诊断请求监听器、不启动 CPU sampler，也不启动 watchdog。部署准备后的 ecosystem 配置显式启用请求诊断和 CPU 子开关，详见下节；写入配置不代表运行进程已经加载。

## 总开关和边界

总开关是 `VCP_DIAGNOSTICS_ENABLED`，默认 `false`。主服务和独立 Admin 进程都必须在启动环境中看到 `true`，固定诊断健康端点才会工作。

CPU 采样另需 `VCP_DIAGNOSTICS_CPU_ENABLED=true`，默认 `false`；watchdog 另需 `VCP_DIAGNOSTICS_WATCHDOG_ENABLED=true`，默认 `false`。这些变量只在进程启动时读取，不在本补丁中修改 `config.env`。

诊断日志默认写入独立目录 `DebugLog/diagnostics/`，也可以用 `VCP_DIAGNOSTICS_DIR` 指定目录。日志只包含固定字段：`utcTime`、`serviceRole`、`pid`、`diagnosticId`、`correlationId`、`route`、`probeRole`、`phase`、`elapsedMs`、`httpStatus`、`errorCode`。不会写入正文、提示词、工具参数/回执、原始 URL/query、headers/cookies、凭据、环境变量、异常 message/stack。

客户端关联 ID 仅接受字符串 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$`，优先 `requestId`，其次 `messageId`；非法、过长、对象、空白和控制字符全部丢弃。未知路由统一为 `other`。

默认有界参数：

- JSONL 队列 2048 条，单条 4 KiB；队列满只增加丢弃计数，不阻断业务。
- JSONL 单文件 8 MiB，最多 8 个文件、64 MiB 的保留预算按 **服务角色 + PID** 分别计算；只轮转该前缀的文件，不清理历次启动的其他 PID。因此 64 MiB 不是整个诊断目录的跨重启总上限，旧 PID 的证据需另行授权归档。
- CPU sampler 配置间隔 10 ms，传给 Inspector `Profiler.setSamplingInterval` 时明确换算为 **10000 微秒**；profile 元数据继续使用毫秒。60 秒分段，每个服务角色最多保留 8 个 profile、256 MiB 预算，CPU 轮转覆盖该角色的历次 PID。配置限幅分别为 2–1000 ms、1000–900000 ms、1–64 段；文件名含服务角色、PID、`target-main`、时间和分段序号。保留预算为软限额：最新一份 profile 即使超限也保留，写入中的临时文件及元数据不计入上述预算。
- watchdog 默认每 5 秒一次、单路 2 秒 deadline；安全范围为 1–60000 ms 和 250–10000 ms。请求不重叠，超时连接会销毁。

磁盘失败、队列饱和、Inspector 不支持或 Inspector 请求超时只记录固定错误码并停止对应诊断分支，不让诊断代码改变业务响应。CPU sampler 最后一个尚未完成的分段可能丢失；它不能保证捕获 native 死锁。

## 请求阶段和三路探测

主服务和 Admin 都在 body parser 前生成服务端 `diagnosticId`，解析后再关联经过严格验证的客户端 ID。请求上下文存放在请求对象上，不复制正文，因此并发请求和工具循环不会串 ID。

主服务固定阶段包括：`request_enter`、`body_parsed`、`preprocess_start`、`preprocess_end`、`upstream_request_sent`、`upstream_response_headers`、`first_output`、`complete`、`disconnect`、`error`。上游重试和工具递归沿用同一请求上下文，分别记录每次发出/响应头到达。

Admin 固定增加 `local_processing_start/end`、`proxy_request_sent`、`proxy_response_headers`、`proxy_timeout`、`proxy_error`。本地 AI 代理和 `/admin_api` 兜底代理都沿用实际调用链。

启用后提供三个仅 loopback 的固定端点，不信任 `X-Forwarded-For`：

- 主服务 `GET http://127.0.0.1:<PORT>/__vcp_diag/health`
- Admin 本地 `GET http://127.0.0.1:<PORT+1>/__vcp_diag/health`
- Admin→main `GET http://127.0.0.1:<PORT+1>/__vcp_diag/proxy-health`，目标路径和目标地址在代码中固定，不接受 URL/query 输入

健康端点只返回最小 `{ "status": "ok" }`；关闭或非 loopback 请求会继续进入原有鉴权路由。Admin→main 失败只返回固定 `status:error` 及 502/504，不泄露主服务异常细节。

独立探测脚本：

```powershell
$env:VCP_DIAGNOSTICS_ENABLED = 'true'
$env:VCP_DIAGNOSTICS_WATCHDOG_ENABLED = 'true'
node scripts/diagnostics-watchdog.js --once --main-port 3000 --admin-port 3001
```

持续探测直接省略 `--once`；脚本自身不 restart、kill、清理或修改业务配置。探测角色固定为 `main_direct`、`admin_local`、`admin_proxy`。`probe_connect`、`probe_response_headers`、`probe_complete` 和 timeout/error 阶段的 `elapsedMs` 用同一个单调时钟起点，便于区分连接失败、响应头超时和响应体停滞。

本机三路探测只能证明本机 loopback 路径，不能证明公网入口、反向代理或客户端链路可达。外部故障必须结合故障时刻（UTC）、客户端 `requestId/messageId` 和日志中的 `pid`、`diagnosticId` 定位。

## CPU profile 受控启用

候选补丁已移除 `ecosystem.config.js` 中固定同名 `--cpu-prof`。生产采样不再依赖退出时落盘的单文件，也不会与新 sampler 并行或互相覆盖。

注意：`pm2 restart`（即使带 `--update-env`）不保证重新读取 `ecosystem.config.js` 的 `node_args`；已有进程可能仍携带旧的 `--cpu-prof`。上线或停用时必须由部署流程受控加载当前 `ecosystem.config.js` 并重新创建/重载目标进程，不能只凭 restart 宣称旧参数已去除；完成后还要核验每个实际 PID 的 PM2 `node_args`/进程 argv，确认不含 `--cpu-prof` 且与当前配置一致。

启用步骤（示例，不执行 PM2 命令）：

```powershell
$env:VCP_DIAGNOSTICS_ENABLED = 'true'
$env:VCP_DIAGNOSTICS_CPU_ENABLED = 'true'
$env:VCP_DIAGNOSTICS_CPU_SAMPLING_MS = '10'
$env:VCP_DIAGNOSTICS_CPU_SEGMENT_MS = '60000'
# 由部署系统受控加载当前 ecosystem.config.js 并重载目标进程；不要只执行 pm2 restart
# 随后核验实际 PID 的 node_args/argv，确认没有旧的 --cpu-prof
```

主服务和 Admin 各自由本进程的独立 Worker 执行 `inspector.Session.connectToMainThread()`，不开放 Inspector 网络端口。Worker 只在 `isMainThread` 入口创建，业务 Worker 加载模块时不会递归创建诊断 Worker。profile 元数据明确 `sampleTarget: main-thread`、`targetThreadId: main`、服务角色、PID 和 UTC 时间窗。

停用时把 CPU 子开关设为 `false` 并重启已启用的进程；总开关设为 `false` 可整体关闭请求记录、健康端点和 CPU 诊断。无需执行删除日志操作。

## 上线验收和回滚

候选补丁上线前建议按以下顺序操作：

1. 先保持总开关关闭，验证 `node --check`、JSON 解析和隔离测试。
2. 只开总开关，不开 CPU/watchdog，确认业务请求仍保持原鉴权、流式/非流式和中断语义。
3. 以本机固定端点分别验证 main 直连、Admin 本地和 Admin→main；故意让 fixture 不回响应头/不结束响应体，确认两类错误码不同。
4. 在短时窗口打开 CPU 子开关，确认 profile 文件分段、文件名唯一，且 profile 节点出现命名的主线程忙循环。
5. 启动 watchdog，按 UTC 时间、服务角色、PID 和客户端关联 ID 检查 JSONL 阶段链路，再关闭 watchdog/CPU 子开关。

回滚只需恢复候选代码并将 `VCP_DIAGNOSTICS_ENABLED=false`，随后按部署流程重启读取了开关的进程；本补丁不自动重启 PM2，不删除既有日志，不改变业务配置、网络分流、OneRing、Embedding 或工具循环限制。

已知限制：当前故障的旧 profile 只覆盖先前时间窗，不能由本补丁回溯补齐；Inspector 停止请求若主线程同时卡在 native 层可能无法及时返回，最后分段可能未落盘；本机 watchdog 也不能单独证明公网链路状态。
## 本部署交接：准备完成后由用户手动重启

本次获授权的范围仅为代码应用和启动配置准备。Agent 不执行重启、不启动独立 watchdog、不执行 `pm2 save`。写入磁盘不证明现有进程已加载；运行验收必须在用户手动重启之后另做。

本部署 `ecosystem.config.js` 对 `vcp-main` 和 `vcp-admin` 显式设置：

- `node_args: []`，清除旧固定同名 `--cpu-prof` 配置。
- 请求诊断与 CPU 子开关为 `true`，watchdog 子开关为 `false`。
- CPU 间隔 10 ms（Inspector 实参为 10000 微秒），60 秒分段；每个服务角色保留 8 段、256 MiB 软预算。
- JSONL 每个角色/PID 为 8 个文件、64 MiB 预算；跨重启的旧 PID 文件不自动清理。
- 目录为 `C:/VCP/VCPToolBox/DebugLog/diagnostics`；其他业务启动参数保持原值。

本次补充的采样单位回归直接拦截隔离 fixture 的实际 Inspector 调用。未修复时测试必须失败，修复后确认 `5 ms -> 5000 us`，profile 元数据仍为毫秒。该测试不启动生产采样器。

用户确认当前没有需要保留的在途请求后，在服务器 PowerShell 中执行：

```powershell
Set-Location 'C:\VCP\VCPToolBox'
pm2 restart .\ecosystem.config.js --only "vcp-main,vcp-admin" --update-env
```

这里必须把 **ecosystem 文件路径** 传给 PM2，让本部署 PM2 6.0.14 的配置加载路径传递 `current_conf`，同步更新 `env` 和 `node_args`；不要替换为仅按进程名重启。命令失败时保留错误输出，不连续重试或执行 `restart all`。

重启后仍需核验：

1. 两个目标进程的 PID/启动时间更新，实际启动参数不含 `--cpu-prof`，诊断开关与配置一致。
2. 主服务 `6005` 的 `/__vcp_diag/health`、Admin `6006` 的 `/__vcp_diag/health` 和 `/__vcp_diag/proxy-health` 均能在真实 loopback 请求下正常返回。
3. 等待至少一个 60 秒采样周期，确认 main/admin 的 `target-main` 分段文件及 JSONL 正常落盘；核对采样元数据 `samplingIntervalMs=10` 和时间窗。
4. 未经再次授权，不启动持续 watchdog。单次健康验收也应明确与“已经运行持续监测”区分。
5. 全部运行验收通过后，再决定是否保存 PM2 进程清单，不能在本次准备阶段执行 `pm2 save`。

若需停用，先把目标服务配置中的 `VCP_DIAGNOSTICS_ENABLED` 和 `VCP_DIAGNOSTICS_CPU_ENABLED` 均改为 `'false'`，保留 `node_args: []`，再由用户执行同一条按配置文件重启命令。不要仅删除变量或假定旧 PM2 环境会自动清空，也不要删除诊断证据或自动做 Git 硬回滚。任何恢复旧源码的操作需先核对当前差异并单独授权。