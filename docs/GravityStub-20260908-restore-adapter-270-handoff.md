# GravityStub 请求局部恢复适配器：270项阶段交接

## 本轮交付
- 新增 modules/vcpLoop/gravityRestoreAdapter.js。
- 新增 tests/gravityRestoreAdapter.test.js，6项入口及清理边界测试。
- tests/gravityRestoreLoopHttp.test.js 仅四处精确替换：引入适配器、显式创建、关闭入口、恢复入口。
- 修改前备份：tests/gravityRestoreLoopHttp.test.js.bak-before-adapter-20260908。
- 没有修改生产Handler、生产工具分发或配置。

## 实现契约
createGravityRestoreAdapter({enabled=false,store=null})：
- 仅 enabled===true 放行；不读取环境变量自动开启。
- 绑定调用方传入的本请求既有原文仓，不创建第二个仓或全局注册表。
- restore仅接受含唯一自有数据字段handle的普通对象或null原型对象；拒绝路径、命令、额外参数、访问器和继承字段。
- 未知及跨仓句柄由绑定原文仓拒绝；没有原文仓、适配器关闭或原文仓关闭时拒绝。
- close幂等，释放适配器引用并调用原文仓close；清理异常不向外抛出。
- 调用方负责绑定完成、断开、错误及Abort生命周期。适配器本身没有生产生命周期自动挂接。
- 请求归属来自调用方正确绑定原文仓，不是适配器独立验证任意store的可信性。

## 验收实证
- 迁移后的双Handler HTTP专项8/8通过，fail/cancelled/skipped=0，277.0887ms。
- 联合隔离回归24文件270/270通过，fail/cancelled/skipped=0，4032.2532ms，REGRESSION_EXIT=0。包含新增6项边界及原8项HTTP测试。
- 三个源码/测试文件独立node --check均退出0。
- 三文件独立只读空白/冲突标记审计通过。
- 与备份逐字节核验：HTTP测试恰好四处预期替换，其余字节不变；READBACK_AUDIT_EXIT=0。
- git --no-index --check 返回1；工具先前还出现working-copy换行告警且截断错误输出。不将此项描述为Git差分检查退出0。独立空白及精确差分验证已另行完成。
- 新文件写入工具的outside-of-base-path校验警告表示工具校验跳过；独立语法检查才是本轮语法依据。

## 证据边界
完整未改Handler与真实ToolCallParser经过本地模拟HTTP上游；投影器和执行器仍为测试注入，恢复处理改为调用真实新适配器。
不代表生产safeGravityProjection放行、生产工具注册/分发或真实模型端到端验收。
原位置仍是存根，原文作为新工具回执追加，没有自动pin/原位置重展开。
跨仓测试使用第二个仍存活原文仓，不是两个并发完整Handler测试。
270项说明当前机制回归通过，不等于语义候选质量或Token收益验收。

## 未执行及仍未完成
- 未重启、未开启生产折叠、未新增embedding请求、未改history.json、未提交推送。
- 未新增全局恢复服务、日志恢复兜底、第二套原文仓。
- 生产恢复工具及请求生命周期接入仍未完成。
- 基于当前用户目标和最新工具回执的语义候选选择仍未完成。
- 真实模型同请求主动恢复、任务保真及包含恢复轮次的真实Token收益仍未验证。

## 下一关键路径建议（本轮未执行）
核对现有请求生命周期、可逆会话与工具分发的接口，确定如何复用同一原文仓绑定适配器；维持默认关闭，在隔离环境验证请求结束释放及恢复分发。不要把直接传任意store当作生产归属验证，也不要单独创建一个恢复仓导致句柄失配。
语义候选选择是独立未完成主线，不以年龄/头尾规则冒充最终策略。该建议不是生产开启或重启授权。

## 操作留痕
本轮曾用PowerShell内嵌Node修改HTTP测试，违背源码编辑应走FileOperator的纪律；已明确承认，未盲目回滚，备份及四处精确差分已核验。后续源文件编辑使用FileOperator，复杂只读审计也应写独立脚本再执行，避免继续长命令串。
仓库有大量无关修改，不全量暂存或覆盖。