'use strict';

// Advisory only: reuse the existing estimate, never tokenize or trim messages here.
// Deduplication tracks a send attempt, not confirmed model receipt. It is local to
// this process; a restart or FIFO eviction permits a later reminder.
const MARKER = '[系统上下文预算预警]';
const MAX_TOPICS = 2048;

// The advisory is transient. Carry the confirmed procedure in the button payload
// so the next user turn does not depend on this notice or an Agent-specific prompt.
// Keep the client-wrapped click text within the existing 500-character limit.
const HANDOFF_CONFIRMATION = [
  '确认执行跨话题交接：仅移交既有授权任务。',
  '以当前Agent署名按其记忆目录规则用DailyNote create写交接单（实际Date/Content/Tag，目标/进展/决策/待办/证据/限制，无凭据）。',
  '禁用no_reply，等成功回执，以实际folder/fileName及已核实根目录组成绝对路径，不猜。',
  '调用客户端插件：tool_name=TopicSponsor，command=CreateFlowlockTopic，maid=当前Agent，topic_name=交接标题，flowlock_heartbeat=15。',
  'initial_message填交接单绝对路径及接管指令；flowlock_prompt填先用ServerFileOperator.ReadFile精确读取、复述核验后再续既有授权，不靠模糊召回。',
  '旧话题交割释放心流、停止推进及心跳；写入/创建/接管分别验收。',
  '失败或结果不明即停，保留交接单，不重建不全库搜索；缺工具给手动新建口令，缺读取工具请用户提供正文。'
].join('');

const HANDOFF_GUIDE = [
  '【本次阈值触发的通用交接流程】不依赖特定Agent的常驻交接提示词。',
  '预警不是迁移授权。不要中断正在执行的编码或测试，不强制截断上下文，不在确认前写交接单或创建话题。',
  '在自然安全断点简述目标、进展、待办与风险，再原样渲染下方原生DOM按钮（不放代码围栏，不缩短data-send）。当前若还需工具推进，先在可见正文保留交接待办，断点再展示按钮。',
  `<button class="vcp-button" data-send="${HANDOFF_CONFIRMATION}">确认跨话题交接</button>`,
  '按钮示例及本说明都不是用户确认。只有收到用户明确确认（含客户端包装的点击消息）后，才执行data-send内的流程；等待确认时若已在心流中，按既有协议停止自主推进，不用心跳代替授权。',
  '本预警不进入原始聊天历史；按钮data-send必须完整携带确认后的操作步骤。身份、maid和日记索引按当前Agent的实际规则填写，不借用其他Agent身份；索引或根目录不明先核实。DailyNote写入不得使用no_reply，必须等待成功回执。',
  '创建工具为客户端插件TopicSponsor，不是服务端插件，不使用旧名AgentTopicCreator。正常调用直接采用下列字段，无需先查manifest。CreateFlowlockTopic用于自动唤醒；CreateTopic只创建普通话题，不能当作自动接管。',
  '【直接调用参数：按标准VCP工具请求格式填写；尖括号替换为本次真实值，不照抄占位内容】',
  'tool_name: TopicSponsor',
  'command: CreateFlowlockTopic',
  'maid: <当前Agent中文名>',
  'topic_name: <本次交接话题标题>',
  'initial_message: 请先用ServerFileOperator.ReadFile精确读取交接单 <已核实的交接单绝对路径>，复述目标、进展、待办和限制，再按既有授权接管；未读到原文不得宣称接管成功，不再次创建话题。',
  'flowlock_heartbeat: 15',
  'flowlock_prompt: 先读取本话题initial_message指定的交接单并复述核验，再按既有授权推进；已读取则不重复迁移。完成、受阻或需用户确认时按既有协议结束心流。',
  'CreateFlowlockTopic的唤醒请求会在旧话题最终回复完整落盘后由客户端认领；工具返回创建成功时不能宣称新会话已经读取。',
  '仅需核对版本或参数差异时，再用客户端FileOperator读取当前客户端根目录下的VCPDistributedServer/Plugin/TopicSponsor/plugin-manifest.json；不去服务端Plugin目录寻找，不猜客户端绝对路径。',
  '创建成功不等于接管成功，写入、创建、读取分别按实证汇报；旧话题交割后停止推进和心跳。失败或结果不明即停并保留交接单，不自动重试创建、不全库搜索。工具不可用时给含精确路径的手动新建接管口令；读取工具也缺失则请用户提供正文。不承诺全平台成功。'
].join('\n');

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function createSoftContextBudget() {
  const warned = new Set();
  return function appendBudgetNotice(messages, extensions, tokenCount) {
    try {
      // One setting: default 100k estimated tokens; a nonpositive value disables.
      const raw = process.env.VCP_CONTEXT_SOFT_BUDGET;
      const parsed = raw === undefined || raw.trim() === '' ? 100000 : Number(raw);
      const budget = Number.isFinite(parsed) ? parsed : 100000;
      if (budget <= 0 || !Array.isArray(messages) ||
          !Number.isFinite(tokenCount) || tokenCount < budget) {
        return messages;
      }

      if (extensions?.schemaVersion !== 1) return messages;
      const context = extensions.requestContext;
      if (!context || !['agent', 'group'].includes(context.ownerType) ||
          !validId(context.agentId) || !validId(context.topicId)) {
        return messages;
      }
      // Structured client identity only; do not infer topics from message text.
      // This tuple is a dedup namespace, not an authenticated tenant identity.
      const key = JSON.stringify([
        'vcpchat-v1', context.ownerType, context.agentId, context.topicId
      ]);
      if (warned.has(key)) return messages;

      const outgoing = [...messages, {
        role: 'system',
        content: `${MARKER}\n当前出站上下文估算约 ${Math.ceil(tokenCount)} tokens，` +
          `已达到软预算 ${budget} tokens。文本与附件计数均有误差，` +
          '这不是实际模型用量或硬限制。\n' + HANDOFF_GUIDE
      }];
      warned.add(key);
      if (warned.size > MAX_TOPICS) warned.delete(warned.values().next().value);
      return outgoing;
    } catch {
      console.warn('[SoftContextBudget] Notice skipped; continuing chat.');
      return messages;
    }
  };
}

module.exports = {
  appendBudgetNotice: createSoftContextBudget(),
  createSoftContextBudget
};