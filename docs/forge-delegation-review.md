# AA 委托的独立核验

## 三条独立状态

- **宿主执行态**：AA 写入 `ForgeDelegation::v1`，`completed` 只代表执行结束。
- **业务 Todo**：pending/doing/blocked/done；实验冻结状态不得为了核验改为 done。
- **独立核验**：主控在实读交付与证据后登记 passed/rejected，限定范围，不自动验收工程。

`RecordDelegationReview` 使用中央 `maid` 作为署名，不接受另填 `reviewedBy` 冒充操作者。
同一角色的 `#分身` 不算独立审查。该字符串检查是防误用，不是隔离沙箱或身份签名。

## 登记与历史

必需 projectId、todoSeq、delegationId、expectedSequence、expectedRevision、requestId、
verdict、scope、reason、evidence（ref、sha256）。先读 GetProject/GetDelegationReviews，再独立核验。
首次 revision 0；提交时 CAS 校验当前绑定与序号。重复 requestId 必须内容相同且保留原修订。
后续纠正追加新修订，不覆盖历史；冲突先核对现场，不自动重试。最多保留 64 次修订，达到上限停止。
passed 只接受 completed，执行失败可登记 rejected，不可强行通过。

记录在独立 `aa_delegation_review:<delegationId>` 元数据中，原 Todo 整行、
宿主 `aa_delegation:` 数据不变。只推进工程发布时间以触发现有目录发布。
证据引用和摘要必须来自实读核对；API 不读取任意路径、不联网取证，
不宣称摘要已认证内容、文件存在性或数字签名。

## 只读传输与前端

在 GetProject、GUI 读取和目录采集时合成 `ForgeReview::v1` 附注，通过现有 note 字段传输；
源数据库 note 不写入附注，不新增网络 DTO 字段。身份、行号、委托 ID、
宿主序号与更新时间严格绑定，附注完整落在 2048 字符预览内，超限拒绝登记。
无有效记录时插入 null 附注，防止原始备注中伪造的相邻通过文本成为核验结果。
陈旧、损坏、截断或自验记录保守显示为未核验，不改变原执行状态。

前端分别展示执行已结束、限定核验通过/核验未通过，
列出审核人、时间、限定范围、理由和证据摘要。所有文本转义，不自动打开证据路径。
缺少 codec 时失败关闭，保留执行快照。刷新、筛选、定位与复制 ID 行为继续只读。

## 本次历史记录的边界

- p4x8u #1：仅后端成功分支通过，不认证真实内嵌动态全过程。
- pfuhx #1：已有真实非流式双轮、90.522 秒等待及独立答案核验通过证据。
- p4x8u #2、pwl5f #1：保留原验收失败结论，不因后来新样本成功而改绿。
- pg5fp 执行失败、pe0oe 冻结对照及 ps8vm 旧式审查备注不自动迁移/改写。

本文是候选实现契约，不是生产已部署或旧记录已登记的证明。
运行源码更新、重载与实际目录展示须另有执行和核验回执。
测试仅用临时库/合成委托，不重派模型或操作历史样本。