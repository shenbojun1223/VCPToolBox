# ServerPowerShellExecutor：AST 安全检查（v1.2.1）

## 目的与实现
纠正全文关键词误报，不修改部署中的 `config.env`。
固定的 `inspect-command-ast.ps1` 通过 stdin 接收 JSON，调用 PowerShell 原生 Parser，
返回命令身份、位置及少量标志；绝不执行输入源码。`commandSecurity.js` 按事实决定策略。
使用与执行阶段相同的 Shell，`-NoProfile`；一次解析整个 command/command1..N 批次。
检查早于执行和验证码比较，任一禁止项阻止整批执行。

## 决策与授权
- `allow`：未命中本检查器已覆盖的限制，不代表任意副作用都已审计。
- `auth-required`：命中授权配置；仍需正确验证码，不是 Windows 权限提升。
- `forbidden`：命中禁止配置；验证码不可覆盖。
- `review-required`：不能可靠检查或检测到间接执行（如 Start-Process、动态求值、外部脚本等）；需要管理员验证码授权后方可执行（canAuthorize=true）。未提供或验证码错误时拒绝执行。
  这是一种高级审查机制，允许在提供 tool_password 时作为终审通行证放行。
  禁止项（forbidden）依然不可覆盖。

返回诊断包含 decision、rule、commandName、commandIndex（从0开始）、line、column、canAuthorize。
不返回参数全文、原脚本或解析器错误正文。待检脚本不通过命令行参数传输。
解析进程不继承 DECRYPTED_AUTH_CODE。

## 匹配语义与兼容性
- 匹配实际命令位置；普通字符串、注释、路径参数不是命令。
- 执行目标完整路径、模块限定名取命令身份，不把它们当数据路径删除。
- 同时检查原始别名和无配置 Shell 的解析目标。rm/del/rmdir 的禁止规则不会
  被 Remove-Item 的授权规则覆盖；Remove-Item 仍按其自身配置判定。
- 配置 format 时兼顾 Format-Volume；Format-Table/List/Wide 不视为磁盘格式化。
- 配置 restart 时涵盖 Restart-Computer/Restart-Service。
- 遍历嵌套脚本块及字符串中的可执行子表达式；即使脚本块未调用，也保守检查。
- 文件重定向 > / >> 分别按 Set-Content / Add-Content 配置处理；2>&1 不算文件写入。

行为变化：动态命令名、常见动态求值/调用、别名变更、模块导入、
外部 .ps1/.psm1、dot-source、嵌套 PowerShell/cmd、Start-Process 等需审查（review-required），
由管理员动态验证码 tool_password 统一授权。普通对象方法不是一律禁止；
已识别的 Invoke、ScriptBlock.Create 等求值入口均需要验证码授权。
禁止类指令（如磁盘格式化、强制删除等）依然严格拦截，任何验证码均不可覆盖。

## 故障边界
输入 JSON 上限512 KiB，解析输出上限2 MiB，单次解析超时10秒。
输入错误、解析进程失败、超时、输出异常均返回 review-required；未提供正确验证码时拒绝，不回退旧全文正则。
当前实现允许这些检查故障在提供正确 tool_password 后进入执行；这不是无条件拒绝策略。
“禁止项不可覆盖”仅指已被成功解析并识别为 forbidden 的命令；检查器失败不证明命令不含禁止项，授权者须独立审查准确命令及副作用。
额外成本是每次工具请求启动一个只解析的 PowerShell 进程。

这不是 OS 沙箱、程序白名单或全语言安全分析器：
不会审计 node/python 等外部运行时的脚本内容，不完整模拟 .NET 方法、反射、
自定义运行时命令解析或所有系统写入。授权对象和副作用仍需调用者审核。
本次只修改服务端插件，不同步修改客户端同名执行器。

## 验收方式
仓库根目录运行：
    node --test --test-reporter=spec tests/powerShellSecurityAst.test.cjs tests/powerShellSecurityGate.test.cjs

AST 测试覆盖本机 PS7 与 PS5.1，危险样本仅作为解析数据。
入口门禁测试使用 VM 和模拟 fs/process/spawn，不使用真实验证码，不执行危险样本。
现场烟测仅使用输出文字、显示命令等无害操作；不重放旧 Flash 脚本。

## 部署和恢复
PowerShellExecutor 是每次启动 node 入口的 stdio 插件，入口源码在下一次调用时读取。
清单展示信息是否重新加载取决于插件管理器；不为刷新版本展示自动重启服务器。
本次修改前备份位于 `tmp/powershell-ast-20260915/`。
恢复入口和清单前先比对当前变更，避免覆盖后续工作；不要删除唯一备份。