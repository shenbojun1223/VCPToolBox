# GravityStub：动态投影阶段交接
日期：2026-09-08

## 本轮实际改动
- 修改 modules/vcpLoop/gravityReversibleSession.js，复用既有 createGravityRequestLifecycle，不再独立直接持有 gravityOriginalStore。
- 新增 tests/gravityDynamicProjection.test.js，8项动态投影测试。
- 修改前备份：modules/vcpLoop/gravityReversibleSession.js.bak-before-dynamic-20260908。
- 未修改生产Handler、RAG实现或配置；未重启、未新增embedding请求、未改history.json、未提交或推送。

## 动态投影接口（仅隔离原型）
- project(indices, currentFullHistory)：实验指定索引，对最新完整历史生成临时存根。
- expand(handles, currentFullHistory)：校验当前历史后恢复并固定展开。
- 不传currentFullHistory时维持旧快照式接口，不能把旧接口测试当成生产动态接入。
- 追加保留句柄；既有正文、顺序、系统RAG变化或缩短使旧句柄和pin失效。
- 本轮未选中的块自动以原文出现；显式展开在当前有效历史版本内保持。
- 保留系统、用户、协议、近期对话、检测到的关键细节，并以初始用户锚点限制本次循环内消息的折叠。
- 只支持plain role/content字符串消息。带元数据、多模态、超预算等输入拒绝处理，project返回当前输入供调用方透传。
- 拒绝含[VCP_GRAVITY_STUB的历史，防止把上轮投影登记为原文。
- 存根带随机句柄、原文长度和48字符字面线索，明确不是摘要；没有模型可调用恢复工具。
- 关闭/中止后无法继续project/expand。生命周期释放原文仓；外层原型快照在后续调用或显式close时清理，仍须调用方finally close，不能宣称事件触发时所有快照都立即释放。
- 正则细节保护只是保守启发式，不保证所有关键参数、决策或隐含关联均被识别。
- 索引形式loopStart不是任意重排后的原始消息身份跟踪；复杂历史漂移的保护边界仍需在生产集成前验证。
- 所有结果foldEligible=false，不是生产省略许可。

## 验收证据
- 两个改动文件独立node --check通过。
- 定向17/17通过。
- 联合隔离回归256/256通过，fail/skipped/cancelled=0，耗时约3.64秒，22个文件。
- 独立空白检查：两个文件trailingWhitespace=0、extraEndBlank=False。
- git diff --no-index --check无诊断文本但退出1；不作为退出0通过的证据。
- SHA256：
  - gravityReversibleSession.js: FA06DC3BE6C0C014CC25218B169357EBAA7571FDB40020A2FA8E38FAA1911315
  - gravityDynamicProjection.test.js: 488200CD387EA116F12837A15E7A8AA07728FDEE49CDEE3B5778E29915204AE1

## 收益实验的真实含义
五轮人工候选序列[[2,3],[2],[3],[2,3],[]]，每轮追加模拟回执。
累计JSON序列化UTF-16代码单元：baseline=27805，projected=19279，saved=8526，ratio=0.3066354972。
计入存根正文和JSON转义开销，但不是完整HTTP请求体、真实token、生产流量或任务质量测量。
这是动态投影机制实验，不是语义选择实验，也不是双Handler实际发送存根验收。

## 有结束条件的算法接口核对：结论
1. gravityRequestShadow只输出scores，没有选候选的决策实现；wouldStub/candidates仍未产生实际省略决策。
2. gravityVerifiedShadow复用gravityNativeGeometry，后者调用现有VexusIndex.computeOrthogonalProjection；没有必要再复制几何公式。
3. 与目标不相关和有独立信息可以同时成立。高残差一律豁免会保护大量无关历史；低残差也不是省略安全证明。相关性选择与关键内容保护必须分开。
4. EPAModule.project依赖初始化后的知识库正交基底，不是可直接套用的Dense/Sparse函数。不要重实例化EPA或重算知识库。
5. RAGDiaryPlugin._calculateDynamicParams返回metrics:{L,R,S,beta}，用于RAG K、标签权重与标签截断，不是聊天折叠阈值。
6. beta实际为sigmoid(L*log(2+R)-S*noise_penalty)，注释写log(1+R)。本轮未改此实现。
7. refreshRagBlock调用_processRAGPlaceholder时传加权queryVector及metadata.k，但没有在已检查调用处传递本轮动态metrics。
8. onGravityVectors当前交接包只有bindings、goal、payload及来源描述，没有L/R/S/beta。
9. ContextBridge.computeLogicDepth委托contextVectorManager，不应直接称为知识库EPA基底投影结果。
10. 当前没有证据表明本轮Memo特征已通过现成接口交给GravityStub。停止继续扩展调查，不把缺失特征伪装成现成输入。

## 后续关键路径
- 下一项应是有明确输入、预期候选和恢复结果的离线语义选择实验，不再扩大生命周期框架。
- 先明确使用何种实际可用输入；合成向量只证明决策逻辑，不能证明真实语义质量。
- 不将远端编码器证明重新设为恢复工作的前置，不伪造旧缓存空间证据。
- 正式上线前仍需真实候选覆盖/任务质量验证、双Handler隔离发送闭环及模型可调用恢复路径。
- 生产实际折叠、重启、新embedding请求仍保留原授权边界。