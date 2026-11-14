# 全 Agent 记忆托盘试用：已启用与验收记录

工程：prrib。验收时间：2026-10-30T12:41:47.775Z。
## 最新状态（2026-10-31，覆盖下文准备阶段的待启用描述）

八个 Agent 的后端模板与家中客户端提示词已应用并8/8读回验证；Kerr/Astra真实新请求烟测已通过。部署及本次验收完成，后续缓存收益留待正常使用比较，不自动额外发起模型探测。其他模型不得冒称已完成逐模型线上验收。

最终证据：backups/memory-tray-prrib-20261030/runtime-smoke-final.json，验证时间2026-10-30T18:45:14.426Z（北京时间10月31日02:45）。
实际快照DebugLog/archive/2026-10-31/Debug/LogOutputAfterProcessing-024419_221.txt，对应Kerr、本话题、gpt-6-astra-xhigh。共134条消息：system为21985字符，托盘在索引132（9628字符、2个RAG块），当前任务在索引133；19项结构及来源检查通过。这些是字符/消息统计，不是token节约比例。
固定人设和工程规则仍在system，动态时间/天气、记忆及验证码已移到user托盘；托盘边界和内部VCP_TRAY_MEMO标记未泄漏，OneRingMemo占位符已清除，无显式cache_control。
Kerr的Plugin/OneRing/memo/Kerr.json当前不存在，实际时间线区域为空，与缺失摘要回退一致；不声称命中了非空时间线。非空摘要路径由既有隔离测试覆盖。
当前主PID仍15704，HTTP200/RUNNING；此次最终烟测未重启、未重新启用配置、未对其他模型发起推理请求。Opus桥和远端runner本次均未修改，Opus只有16组合成转换及相关回归证据。真实缓存收益、官方计费和首字延迟尚待后续观察。

- 维护 r1/r2 均停止、restartSent=false，未执行重启。同步启动等待进程造成工具阻塞；执行器原生 background 也存在空闲/超时杀进程树行为，因此未用于正式维护。
- r3 由 Windows 一次性计划任务 VCP-prrib-restart-r3 独立执行；客户端真实认领 Flowlock 请求 mvvb4h4h-2bmu9ta 后发送信号，服务空闲后单次优雅重启。
- restart-r3-status.json：phase=ready，HTTP 202 accepted，vcp-main PID 6924→15704；其他PM2进程未变。实际进程创建时间2026-10-31 02:33:13.501+08:00；生命周期RUNNING、HTTP200，三个兼容代码文件哈希与维护前一致。新进程初始化及执行托盘/OneRing日志已核验。
- 计划任务已退出，LastTaskResult=0、NextRunTime=null；不重放r1/r2/r3。
- 后端模板通过Forge b147～b154应用，8/8等于candidate-manifest候选SHA256，去掉新增标记后原正文逐字节不变。回执backend-template-installed.json（2026-10-30T18:41:16.247Z）。
- 客户端经PromptSponsor SetOriginalPrompt更新8份，systemPrompt和originalSystemPrompt均8/8匹配候选。回执家中同名备份目录client-prompt-installed.json（2026-10-31T02:42:45.007+08:00）。保留现场模型选择，赞妮/Lucy当前均为Argon；未全量覆盖旧config。
- depth默认1，CACHE_BREAKPOINT默认false；未创建私有config.env。Opus桥与远端runner未修改。
- 023803是启用前快照，不作为生效证据；现以已核验的024419快照为实际生效证据。配置应用和重启均已完成，不重复写入或重启。
- 本文下方“待用户确认”“正式模板未切换”等为原准备阶段记录；后续操作以本节和最新工程报告为准。启用步骤已执行，不再重复。

## 准备阶段原记录

状态：当时兼容代码已落盘、正式提示词未切换，后续已按上方最新记录完成加载和配置应用。

## 授权与范围

用户授权全员修改试用并检查 Opus 适配。当前客户端有八个非空提示词 Agent：
Kerr、MemoMaster、Nova、赞妮、Lucy、微明、折枝、鲸鱼娘。
空白测试 Agent 不改；未在当前客户端使用的 Metis、DeepSeekForge 等不改。
部署重启尚待用户确认。不要在承载本轮对话的 vcp-main 内层工具循环中直接重启自身。

## 已落盘的兼容改动

- modules/memoryTrayMemoProvenance.js：Symbol + WeakMap 对象凭据，JSON/用户文本不能伪造。
- Plugin/MemoryThinkingTray/MemoryThinkingTray.js：只对原连续 system 前缀中最后一个、且被托盘搬出的 OneRingMemo 声明签发凭据，替换为临时标记。
- Plugin/OneRing/OneRingMemo.js：仍在原 OneRing 收尾阶段解析可信托盘中的选中声明，清除内部标记，保留请求元数据。普通伪系统 user 文字不能激活该能力；无托盘时保留旧路径。
- Plugin/MemoryThinkingTray/README.md：更新兼容条件及 Opus 限制。
- 新测试 tests/memoryTrayOneRingMemo.test.js。
- 一次性准备/验收脚本 scripts/prepare-memory-tray-prrib.cjs 与 scripts/verify-memory-tray-prrib.cjs。

已检查普通插件重载入口直接 require(scriptPath)，未清理这些模块缓存，不能将其当成代码热加载。
Agent 文本自身存在监听，故必须先加载兼容代码，再切正式模板。
不改预处理器顺序、模型路由、权限校验或远端 Claude runner。
深度沿用现有默认 1；显式缓存断点沿用默认 false。当前没有插件私有 config.env；启用时再次核验实际配置，不声称已创建该文件。

## 候选与备份

后端：
C:\VCP\VCPToolBox\backups\memory-tray-prrib-20261030\
- manifest.json：13份原文件的哈希与备份。
- baseline.json：此前完整7天NewAPI基线，混合首次请求和工具续轮，不是逐档位/实际账单。
- candidates/Agent/*.txt：八个模板候选。
- candidate-manifest.json：原文件/候选SHA256及块数。
- compat-tests-r3.txt：36/36通过。
- candidate-acceptance.json：八Agent乘两组合成动态值的Opus转换结果。
- candidate-acceptance-log.txt：对应运行输出。

当前客户端：
D:\VCP\VCPChat\AppData\Backups\memory-tray-prrib-20261030\
- 各Agent配置备份与 prompt-baseline.json。
- prompt-candidates.json：仅包住验证码占位符的八个客户端提示词候选。
不得向报告复制真实凭据。

模板仅插入Start/End边界，去掉新增标记可恢复原文；没有修改人格、工具与权限规则正文。
移动TarSysPrompt、记忆块（含OneRingMemo）、元思考块、末尾时间及动态论坛/音乐列表。固定论坛工具说明留在system。
鲸鱼娘酒馆记忆原已位于user，保持原预设，只标记system内日期天气。
OneRing启动控制标记和ContextFolding开关留在system。
客户端验证码只改变载体位置，不改变数值和工具校验机制。模型切换不改变同一Agent候选。

## 验收边界

通过：
1. node --test tests/memoryThinkingTray.test.js tests/oneRingUntriggeredPassthrough.test.js tests/memoryTrayOneRingMemo.test.js tests/oneRingTemporaryContract.test.js
   36/36，含真实Only消息转换、working-view恢复、Claude来源投影；持久化、摘要读盘和重试分配按测试桩隔离。
2. node scripts/verify-memory-tray-prrib.cjs
   八Agent×两组动态值，16例通过。实际tray/memo注入/Bridge消息映射/envelope函数，加从配套runner AST提取的五个纯函数。
3. git diff --check通过。八份正式Agent SHA256仍等于备份。

不是已验收：
- 模型真实推理、线上缓存收益、官方账单或首字延迟。
- 远端runner部署版本一致性、所有真实变量展开及完整真实RAG返回。
- 客户端临时工作区注入和上下文折叠造成的其他前缀变化。
- 补丁进程内加载及全员正式提示词启用。

Opus结论：断点关闭时字符串链路合成验收通过；动态资料留在live tail，固定规则进入原生system，历史resume保持。没有改Bridge或远端runner。
断点开启会把字符串变为数组，当前Bridge mapper拒绝multimodal_unsupported，必须保持关闭。

## 下一步

1. 获用户对短维护重启的确认，核对运行机器、vcp-main入口/PID及其他任务占用；查文件差异和候选哈希，防止并行修改。
2. 使用独立维护执行/恢复通道安排受控重启。当前轮必须先正常收口；若用Flowlock，先登记真实当前话题，客户端认领后才能执行独立重启。不能只凭延时断言已收口。
3. 服务就绪后核实补丁加载、托盘深度及断点配置。先保持旧模板，避免半更新请求。
4. 正式Agent使用Forge最小标记差分，逐文件核对candidate-manifest；不覆盖变化过的模板。
5. 客户端使用PromptSponsor SetOriginalPrompt更新提示词，同时保持originalSystemPrompt和活动systemPrompt一致。调用前读取GetActivePrompt及最新配置，对比before；每个Agent单独确认回执，不重写整份config。
6. 保存实际启用时间，读取下一次真实请求的出站快照，核对托盘位置、时间线已展开、无内部VCP_TRAY_MEMO标记、固定规则仍在system、真实问题未丢失。不得用付费批量探测替代未授权模型请求。
7. 把首次用户请求与工具续轮分开做后续对比；正常使用后采样，不承诺即时缓存收益。

## 回退

优先回退模板，不先撤兼容代码：
- 后端按原文件/候选哈希做前置检查后撤销本次标记；原文见manifest对应备份。
- 客户端用PromptSponsor恢复prompt-baseline对应提示词字段；不要全量覆盖旧config.json，以免覆盖新模型、话题或其它设置。
- 老模板不触发新增托盘来源路径，因此可在加载兼容代码后保留旧行为。
- 若需撤源码，先检查当前差异/Forge批次并预演，只撤本工程文件；不得reset/clean或覆盖他人修改。移除新增模块前必须恢复两个require调用方。
- 代码回退也需受控重启；普通插件重载不等价于require缓存刷新。
- 原有Plugin/FileOperator/config.env、Plugin/LinuxShellExecutor/config.env/hosts.json、rag_params.json及未跟踪运行数据不属于本任务。