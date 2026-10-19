const { UpstreamError, assertResponseOk, abortableDelay, abortError, throwIfAborted } = require('../upstreamErrors.js');
// modules/handlers/nonStreamHandler.js
// AICW 内层禁工具消费回执（opt-in）：仅在请求携带本机控制头时写入保留响应头。
const { emitVcpToolForbiddenReceipt } = require('../vcpToolForbiddenReceipt.js');
const vcpInfoHandler = require('../../vcpInfoHandler.js');
const roleDivider = require('../roleDivider.js');
const {
  buildClientVisibleContent,
  removeReasoningFields,
  normalizeReasoningTag,
  shouldConvertReasoningForModel
} = require('../reasoningContentAdapter.js');
const { createRollKeeper } = require('../vcpLoop/rollKeeper');

// 读取软预算配置：缺失/空白/非法/非正数一律视为禁用 token 黄灯（0），绝不让请求抛错。
function readSoftTokenBudgetEnv() {
  const raw = process.env.VCP_CONTEXT_SOFT_BUDGET;
  if (raw === undefined || raw === null) return 0;
  const trimmed = String(raw).trim();
  if (trimmed === '') return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function hasVisibleContent(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some(part => {
      if (typeof part === 'string') return part.trim().length > 0;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text.trim().length > 0;
      return false;
    });
  }
  return content !== undefined && content !== null && String(content).trim().length > 0;
}

function hasReasoningOnlySignal(message, choice) {
  const reasoningKeys = [
    'reasoning_content',
    'reasoning',
    'reasoning_details',
    'thoughts',
    'thinking',
    'reasoning_text'
  ];

  const hasReasoningField = (obj) => obj && typeof obj === 'object' && reasoningKeys.some(key => hasVisibleContent(obj[key]));
  return hasReasoningField(message) || hasReasoningField(choice) || hasReasoningField(choice?.delta);
}

function hasToolOrRefusalPayload(message) {
  return (
    (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) ||
    (message?.function_call && typeof message.function_call === 'object') ||
    hasVisibleContent(message?.refusal)
  );
}

function parseNonStreamResponse(rawResponseText) {
  try {
    const parsedJson = JSON.parse(rawResponseText);
    return {
      parsedJson,
      message: parsedJson.choices?.[0]?.message || null,
      choice: parsedJson.choices?.[0] || null
    };
  } catch (e) {
    return { parsedJson: null, message: null, choice: null };
  }
}

function isCompleteNonStreamResponse(readResult) {
  const { parsedJson, message, choice } = parseNonStreamResponse(readResult.text);
  return readResult.response.ok && !readResult.semanticRetryExhausted &&
    !!parsedJson && !parsedJson.error && !!message &&
    hasVisibleContent(message.content) && choice?.finish_reason === 'stop';
}

function isReasoningOnlyNonStreamResponse(rawResponseText) {
  const { parsedJson, message, choice } = parseNonStreamResponse(rawResponseText);
  if (!parsedJson || !message || hasToolOrRefusalPayload(message)) return false;
  return !hasVisibleContent(message.content) && hasReasoningOnlySignal(message, choice);
}

async function readNonStreamResponseWithSemanticRetry({
  initialResponse = null,
  fetchResponse,
  retries = 3,
  delay = 1000,
  debugMode = false,
  signal,
  label = 'non_stream'
}) {
  const maxAttempts = Math.max(Number.isFinite(Number(retries)) && Number(retries) > 0 ? Math.floor(Number(retries)) : 1, 1);
  let response = initialResponse;
  let responseText = '';
  let lastReasoningOnlyText = '';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    throwIfAborted(signal);
    if (!response) {
      response = await fetchResponse(attempt);
    }

    await assertResponseOk(response, { phase: label === 'initial' ? 'initial' : 'tool_continuation' }, signal);
    let arrayBuffer;
    const abortRead = () => response.body?.destroy(abortError());
    signal?.addEventListener('abort', abortRead, { once: true });
    try {
      throwIfAborted(signal);
      arrayBuffer = await response.arrayBuffer();
    } catch (_) {
      response.body?.destroy();
      throw new UpstreamError({ status: response.status,
        code: signal?.aborted ? 'aborted' : 'stream_error',
        phase: label === 'initial' ? 'initial' : 'tool_continuation', attempt: attempt + 1 });
    } finally {
      signal?.removeEventListener('abort', abortRead);
    }
    throwIfAborted(signal);
    responseText = Buffer.from(arrayBuffer).toString('utf-8');

    if (!isReasoningOnlyNonStreamResponse(responseText)) {
      return {
        response,
        text: responseText,
        semanticRetryTriggered: attempt > 0,
        semanticRetryExhausted: false
      };
    }

    lastReasoningOnlyText = responseText;
    if (attempt >= maxAttempts - 1) {
      if (debugMode) {
        console.warn(`[NonStream Semantic Retry] ${label}: reasoning-only response detected, but semantic retries are exhausted. Returning last response.`);
      }
      return {
        response,
        text: lastReasoningOnlyText,
        semanticRetryTriggered: true,
        semanticRetryExhausted: true
      };
    }

    const currentDelay = delay * (attempt + 1);
    if (debugMode) {
      console.warn(`[NonStream Semantic Retry] ${label}: upstream returned reasoning-only response without visible content. Retrying in ${currentDelay}ms... (${attempt + 1}/${maxAttempts})`);
    }
    await abortableDelay(currentDelay, signal);
    response = null;
  }

  return {
    response,
    text: responseText || lastReasoningOnlyText,
    semanticRetryTriggered: true,
    semanticRetryExhausted: true
  };
}

class NonStreamHandler {
  constructor(context) {
    this.context = context;
    this.config = context;
  }

  async handle(req, res, firstAiAPIResponse) {
    const {
      apiUrl,
      apiKey,
      pluginManager,
      writeDebugLog,
      writeChatLog,
      DEBUG_MODE,
      SHOW_VCP_OUTPUT,
      maxVCPLoopNonStream,
      apiRetries,
      apiRetryDelay,
      RAGMemoRefresh,
      enableRoleDivider,
      enableRoleDividerInLoop,
      roleDividerIgnoreList,
      roleDividerSwitches,
      roleDividerScanSwitches,
      roleDividerRemoveDisabledTags,
      toolExecutor,
      ToolCallParser,
      abortController,
      originalBody,
      clientIp,
      _refreshRagBlocksIfNeeded,
      fetchWithRetry,
      vcpToolUseForbidden,
      vcpToolForbiddenReceipt,
      apiConnectionTimeoutMs,
      semanticModelFallbackCandidates,
      oneRingResponseMeta,
      shouldProcessMedia,
      shouldProcessMediaPlus,
      isTextOnlyForceTranslateModel,
      requestPreprocessorConfig,
      openCodeGoSessionHeader,
      reasoningToContentEnabled: reasoningToContentGloballyEnabled,
      reasoningToContentTag,
      reasoningToContentModels
    } = this.context;

    const shouldShowVCP = SHOW_VCP_OUTPUT || this.context.forceShowVCP;
    const reasoningToContentEnabled = shouldConvertReasoningForModel(
      originalBody.model,
      reasoningToContentGloballyEnabled,
      reasoningToContentModels
    );
    const reasoningTag = normalizeReasoningTag(reasoningToContentTag);

    const containsImageUrlPart = (content) => Array.isArray(content) &&
      content.some(part => part?.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string');

    const maybeTranslateToolPayloadMedia = async (content) => {
      if (!containsImageUrlPart(content)) return content;

      const shouldTranslateToolMedia = shouldProcessMedia || isTextOnlyForceTranslateModel;
      if (!shouldTranslateToolMedia) return content;

      const processorName = pluginManager.messagePreprocessors.has('MultiModalProcessor')
        ? 'MultiModalProcessor'
        : 'ImageProcessor';
      if (!pluginManager.messagePreprocessors.has(processorName)) {
        if (DEBUG_MODE) console.warn(`[VCP NonStream Loop] Tool payload contains image_url, but ${processorName} is unavailable. Forwarding original payload.`);
        return content;
      }

      const originalImageParts = content.filter(part => part?.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string');
      const payloadMessage = { role: 'user', content: JSON.parse(JSON.stringify(content)) };

      if (DEBUG_MODE) {
        console.log(`[VCP NonStream Loop] Translating tool-returned image_url content via ${processorName}. textOnly=${!!isTextOnlyForceTranslateModel}, plus=${!!shouldProcessMediaPlus}`);
      }

      let translatedMessages;
      try {
        translatedMessages = await pluginManager.executeMessagePreprocessor(
          processorName,
          [payloadMessage],
          requestPreprocessorConfig || {}
        );
      } catch (pluginError) {
        console.error(`[VCP NonStream Loop] Error translating tool-returned media via ${processorName}:`, pluginError);
        return content;
      }

      const translatedContent = translatedMessages?.[0]?.content;
      if (!Array.isArray(translatedContent)) return content;

      if (shouldProcessMediaPlus && !isTextOnlyForceTranslateModel) {
        const translatedWithoutImages = translatedContent.filter(part => part?.type !== 'image_url');
        return [
          ...translatedWithoutImages,
          ...JSON.parse(JSON.stringify(originalImageParts))
        ];
      }

      return translatedContent;
    };

    const fetchNonStreamCompletion = (body, label) => fetchWithRetry(
      `${apiUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...openCodeGoSessionHeader },
        body: JSON.stringify(body),
        signal: abortController.signal,
      },
      { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE, connectionTimeout: apiConnectionTimeoutMs, modelFallbackCandidates: semanticModelFallbackCandidates, phase: label === 'initial' ? 'initial' : 'tool_continuation' }
    );

    const firstReadResult = await readNonStreamResponseWithSemanticRetry({
      initialResponse: firstAiAPIResponse,
      fetchResponse: () => fetchNonStreamCompletion(originalBody, 'initial'),
      retries: apiRetries,
      delay: apiRetryDelay,
      debugMode: DEBUG_MODE,
      signal: abortController.signal,
      label: 'initial'
    });
    firstAiAPIResponse = firstReadResult.response;
    const aiResponseText = firstReadResult.text;
    let chatLogs = [];
    let oneRingAssistantTurnParts = [];
    let validUpstreamTurns = isCompleteNonStreamResponse(firstReadResult);
    let completed = false;

    let fullContentFromAI = '';
    let currentAIContentForClient = '';
    const extractedResponse = (rawResponseText) => parseNonStreamResponse(rawResponseText);
    const extractVisibleContent = (message, fallbackText = '') => {
      if (!message) return fallbackText;
      // OneRing 入库和 VCP 循环始终只使用正文 content。
      return message.content || '';
    };
    const extractClientContent = (message, fallbackText = '', choice = null) => {
      if (!message) return fallbackText;
      return buildClientVisibleContent(
        message,
        reasoningToContentEnabled,
        reasoningTag,
        choice,
        choice?.delta
      );
    };

    const initParsedResponse = extractedResponse(aiResponseText);
    const initMessage = initParsedResponse.message;
    if (initMessage) {
      fullContentFromAI = extractVisibleContent(initMessage);
      currentAIContentForClient = extractClientContent(initMessage, '', initParsedResponse.choice);
    } else {
      fullContentFromAI = aiResponseText;
      currentAIContentForClient = aiResponseText;
    }
    if (writeChatLog) chatLogs.push({ request: originalBody, response: initMessage || fullContentFromAI});
    if (fullContentFromAI && fullContentFromAI.trim()) {
      oneRingAssistantTurnParts.push(fullContentFromAI);
    }

    let recursionDepth = 0;
    const parsedMaxRecursion = Number.parseInt(maxVCPLoopNonStream, 10);
    const maxRecursion = Number.isFinite(parsedMaxRecursion) && parsedMaxRecursion > 0
      ? parsedMaxRecursion
      : 20;
    const rollKeeper = createRollKeeper({ maxRecursion, tokenBudget: readSoftTokenBudgetEnv() });
    // 硬暂停（repeat_halt）时保存停止信息，交由循环后的 stuck 分支统一收口。
    let stuckHalt = null;
    let conversationHistoryForClient = [];
    let currentAIContentForLoop = fullContentFromAI;
    // AICW 内层禁工具消费回执：仅记录本次请求真实发生的分支事实（是否跳过解析、
    // 实际执行了几个内层工具）。未 opt-in 时这两个变量只被写入、不会被读用。
    let toolParseSkippedThisRequest = false;
    let toolExecutionsThisRequest = 0;
    let currentMessagesForNonStreamLoop = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];

    do {
      // 检查中止信号
      if (abortController && abortController.signal.aborted) {
        if (DEBUG_MODE) console.log('[VCP NonStream Loop] Abort detected, exiting loop.');
        break;
      }

      const rollInjection = rollKeeper.evaluate({ recursionDepth, messages: currentMessagesForNonStreamLoop });
      if (rollInjection && rollInjection.kind === 'repeat_halt') {
        // 同指纹连续失败达到阈值：硬暂停本轮工具循环，未派发的工具一律不执行。
        stuckHalt = rollInjection;
        break;
      }
      if (rollInjection && rollInjection.kind && rollInjection.content) {
        currentMessagesForNonStreamLoop.push({ role: 'system', content: rollInjection.content });
      }

      let anyToolProcessedInCurrentIteration = false;
      conversationHistoryForClient.push(currentAIContentForClient);

      // Overlay: 记录本轮真实采用的分支（回执只能申报真实发生的分支）。
      toolParseSkippedThisRequest = vcpToolUseForbidden === true;
      const toolCalls = vcpToolUseForbidden ? [] : ToolCallParser.parse(currentAIContentForLoop);

      if (toolCalls.length > 0) {
        anyToolProcessedInCurrentIteration = true;
        toolExecutionsThisRequest += toolCalls.length;
        const { normal: normalCalls, archery: archeryCalls } = ToolCallParser.separate(toolCalls);
        const archeryErrorContents = [];
        const archeryStatusSummaryItems = [];

        // 执行 Archery 调用
        const archeryLogs = await Promise.all(archeryCalls.map(async toolCall => {
          try {
            const result = await toolExecutor.execute(toolCall, clientIp, currentMessagesForNonStreamLoop);
            const isError = !result.success || (result.raw && this.context.isToolResultError(result.raw));

            if (isError) {
              archeryStatusSummaryItems.push(`${toolCall.name} 调用失败${result.recordId ? ` (记录ID: ${result.recordId})` : ''}`);
              archeryErrorContents.push({
                type: 'text',
                text: `[异步工具 "${toolCall.name}" 返回了错误，请注意]:\n${result.content[0].text}`
              });
              const forceThisOne = !shouldShowVCP && toolCall.markHistory;
              if ((shouldShowVCP || forceThisOne) && (isError || forceThisOne)) {
                const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
                if (vcpText) conversationHistoryForClient.push(vcpText);
              }
            }
            return { tool: toolCall, result: result.content };
          } catch (e) {
            console.error(`[NonStream Archery Error] ${toolCall.name}:`, e);
            return { tool: toolCall, result: [{ type: 'text', text: String(e.message) }] };
          }
        }));

        // 处理纯 Archery 且有错误的情况
        if (normalCalls.length === 0 && archeryErrorContents.length > 0) {
          let assistantMessages = [{ role: 'assistant', content: currentAIContentForLoop }];
          if (enableRoleDivider && enableRoleDividerInLoop) {
            assistantMessages = roleDivider.process(assistantMessages, {
              ignoreList: roleDividerIgnoreList,
              switches: roleDividerSwitches,
              scanSwitches: roleDividerScanSwitches,
              removeDisabledTags: roleDividerRemoveDisabledTags,
              skipCount: 0
            });
          }
          currentMessagesForNonStreamLoop.push(...assistantMessages);

          const errorPayload = `<!-- VCP_TOOL_PAYLOAD -->\n${JSON.stringify(archeryErrorContents)}`;
          const { truncateToolPayload: truncateErrPayload } = require('../vcpLoop/toolPayloadTruncator.js');
          currentMessagesForNonStreamLoop.push({ role: 'user', content: truncateErrPayload(errorPayload, {
            toolNames: archeryCalls.map(call => call.name),
            exempt: archeryCalls.some(call => call.markHistory)
          }) });

          if (archeryStatusSummaryItems.length > 0) {
            if (enableRoleDivider) {
              conversationHistoryForClient.push('\n<<<[ROLE_DIVIDE_USER]>>>\n');
            }
            conversationHistoryForClient.push(`\n[本轮工具调用摘要:]\n${archeryStatusSummaryItems.join('；')}。\n[本轮工具调用摘要结束]\n`);
            if (enableRoleDivider) {
              conversationHistoryForClient.push('\n<<<[END_ROLE_DIVIDE_USER]>>>\n');
            }
          }

          throwIfAborted(abortController.signal);
          if (res.writableEnded || res.destroyed) { rollKeeper.reset(); return; }
          const recursionBody = { ...originalBody, messages: currentMessagesForNonStreamLoop, stream: false };
          const recursionReadResult = await readNonStreamResponseWithSemanticRetry({
            fetchResponse: () => fetchNonStreamCompletion(recursionBody, `archery_error_depth_${recursionDepth}`),
            retries: apiRetries,
            delay: apiRetryDelay,
            debugMode: DEBUG_MODE,
            signal: abortController.signal,
            label: `archery_error_depth_${recursionDepth}`
          });
          const recursionAiResponse = recursionReadResult.response;

          if (recursionAiResponse.ok) {
            validUpstreamTurns = validUpstreamTurns && isCompleteNonStreamResponse(recursionReadResult);
            const recursionText = recursionReadResult.text;
            const recursionParsedResponse = extractedResponse(recursionText);
            const recursionMessage = recursionParsedResponse.message;
            if (recursionMessage) {
              currentAIContentForLoop = '\n' + extractVisibleContent(recursionMessage);
              currentAIContentForClient = '\n' + extractClientContent(recursionMessage, '', recursionParsedResponse.choice);
            } else {
              currentAIContentForLoop = '\n' + recursionText;
              currentAIContentForClient = '\n' + recursionText;
            }
            if (currentAIContentForLoop && currentAIContentForLoop.trim()) {
              oneRingAssistantTurnParts.push(currentAIContentForLoop);
            }
            if (writeChatLog) {
              chatLogs.push({
                request: currentMessagesForNonStreamLoop,
                toolCalls: archeryLogs,
                response: recursionMessage || recursionText,
              });
            }
            recursionDepth++;
            continue;
          }
          break; // 后续上游失败，不提交交互时间。
        }

        if (normalCalls.length === 0) {
          completed = validUpstreamTurns && archeryErrorContents.length === 0;
          break;
        }

        // 执行普通调用
        let assistantMessages = [{ role: 'assistant', content: currentAIContentForLoop }];
        if (enableRoleDivider && enableRoleDividerInLoop) {
          assistantMessages = roleDivider.process(assistantMessages, {
            ignoreList: roleDividerIgnoreList,
            switches: roleDividerSwitches,
            scanSwitches: roleDividerScanSwitches,
            removeDisabledTags: roleDividerRemoveDisabledTags,
            skipCount: 0
          });
        }
        currentMessagesForNonStreamLoop.push(...assistantMessages);

        const toolResults = await toolExecutor.executeAll(normalCalls, clientIp, currentMessagesForNonStreamLoop);
        for (let i = 0; i < normalCalls.length; i++) {
          // 结构化判错：success=false 或 raw 明确报错都算失败，不靠工具回执文本猜成败。
          const recordedResult = toolResults[i];
          const recordedError = !recordedResult || !recordedResult.success ||
            !!(recordedResult.raw && this.context.isToolResultError(recordedResult.raw));
          rollKeeper.record({
            name: normalCalls[i].name,
            args: normalCalls[i].args,
            success: !recordedError
          });
        }
        const normalCallLogs = (() => {
          let logs = [];
          if (writeChatLog) {
            for (let i = 0; i < normalCalls.length; i++) {
              logs.push({ tool: normalCalls[i], result: toolResults[i]?.content });
            }
          }
          return logs;
        })();
        const combinedToolResultsForAI = toolResults.map(r => r.content).flat();
        if (archeryErrorContents.length > 0) combinedToolResultsForAI.push(...archeryErrorContents);

        // VCP 信息展示 - 批量包裹为单个 USER 角色
        let hasStartedUserBlock = false;
        const toolStatusSummaryItems = [...archeryStatusSummaryItems];
        for (let i = 0; i < normalCalls.length; i++) {
          const toolCall = normalCalls[i];
          const result = toolResults[i];
          const forceThisOne = !shouldShowVCP && toolCall.markHistory;
          const isError = !result?.success || (result?.raw && this.context.isToolResultError(result.raw));
          const rawObject = result?.raw && typeof result.raw === 'object' ? result.raw : null;
          const errorText = isError ? [
            result?.error,
            result?.raw,
            ...(Array.isArray(result?.content) ? result.content.map(item => item?.text) : [])
          ].filter(Boolean).map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n') : '';

          // 摘要状态顺序：先由 isError/结构化 success 确定成败；只有失败时才进一步细分“拒绝”，最后再判超时。
          const isRejected = isError && (
            rawObject?.rejected_by_user === true ||
            rawObject?.error_type === 'approval_rejected' ||
            /manual\s*approval\s*was\s*rejected|rejected\s*by\s*user|approval\s*rejected|用户拒绝|人工审核.*拒绝/i.test(errorText)
          );
          const isTimeout = isError && !isRejected && /超时|timeout|timed\s*out|DIRECT_TOOL_TIMEOUT|TIMEOUT/i.test(errorText);
          const statusText = isRejected ? '调用拒绝' : (isTimeout ? '调用超时' : (isError ? '调用失败' : '调用成功'));
          toolStatusSummaryItems.push(`${toolCall.name} ${statusText}${result?.recordId ? ` (记录ID: ${result.recordId})` : ''}`);

          if (shouldShowVCP || forceThisOne) {
            const vcpText = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
            if (vcpText) {
              if (!hasStartedUserBlock && enableRoleDivider) {
                conversationHistoryForClient.push('\n<<<[ROLE_DIVIDE_USER]>>>\n');
                hasStartedUserBlock = true;
              }
              conversationHistoryForClient.push(vcpText);
            }
          }
        }

        if (toolStatusSummaryItems.length > 0) {
          if (!hasStartedUserBlock && enableRoleDivider) {
            conversationHistoryForClient.push('\n<<<[ROLE_DIVIDE_USER]>>>\n');
            hasStartedUserBlock = true;
          }
          conversationHistoryForClient.push(`\n[本轮工具调用摘要:]\n${toolStatusSummaryItems.join('；')}。\n[本轮工具调用摘要结束]\n`);
        }

        if (hasStartedUserBlock && enableRoleDivider) {
           conversationHistoryForClient.push('\n<<<[END_ROLE_DIVIDE_USER]>>>\n');
        }

        const toolResultsTextForRAG = JSON.stringify(combinedToolResultsForAI, (k, v) =>
          (k === 'url' || k === 'image_url') && typeof v === 'string' && v.startsWith('data:') ? "[Omitted]" : v
        );

        // Request-local, round-local handoff; never append vectors to messages.
        let gravityHandoff = null;
        if (RAGMemoRefresh) {
          let gravityReceiver = null;
          try {
            if (process.env.VCP_GRAVITY_SHADOW === 'true' ||
                process.env.VCP_GRAVITY_ENABLED === 'true') {
              const { createGravityVectorReceiver } = require('../vcpLoop/gravityVectorReceiver.js');
              const { findLastRealUserMessage } = require('../messageProcessor.js');
              gravityReceiver = createGravityVectorReceiver({
                userText: findLastRealUserMessage(currentMessagesForNonStreamLoop).rawContent,
                toolResultsText: toolResultsTextForRAG
              });
            }
          } catch { /* Optional receiver initialization cannot stop refresh. */ }
          try {
            currentMessagesForNonStreamLoop = await _refreshRagBlocksIfNeeded(currentMessagesForNonStreamLoop, {
              lastAiMessage: currentAIContentForLoop,
              toolResultsText: toolResultsTextForRAG,
              ...(gravityReceiver ? { onGravityVectors: gravityReceiver.accept } : {})
            }, pluginManager, DEBUG_MODE);
          } finally {
            try { gravityHandoff = gravityReceiver ? gravityReceiver.finish() : null; }
            catch { gravityHandoff = null; }
          }
        }

        const hasImage = combinedToolResultsForAI.some(item => item.type === 'image_url');
        const translatedToolResultsForAI = hasImage
          ? await maybeTranslateToolPayloadMedia([
            { type: 'text', text: `<!-- VCP_TOOL_PAYLOAD -->\nResults:` },
            ...combinedToolResultsForAI
          ])
          : null;
        const finalToolPayloadForAI = hasImage
          ? translatedToolResultsForAI
          : `<!-- VCP_TOOL_PAYLOAD -->\n${toolResultsTextForRAG}`;

        // 超大回执循环内截断：完整原文异步落盘 DebugLog/toolPayloads，ink:mark_history 豁免
        const { truncateToolPayload } = require('../vcpLoop/toolPayloadTruncator.js');
        const payloadForLoop = truncateToolPayload(finalToolPayloadForAI, {
          toolNames: normalCalls.map(call => call.name),
          exempt: normalCalls.some(call => call.markHistory)
        });
        currentMessagesForNonStreamLoop.push({ role: 'user', content: payloadForLoop });

        // 🌟 GravityStub V2：组装期语义引力场可逆投影（纯内存切片，零磁盘污染）
        // GRAVITY_SAFETY_BEGIN
        let messagesForUpstream = currentMessagesForNonStreamLoop;
        try {
          const { safeGravityProjection } = require('../vcpLoop/safeGravityProjection.js');
          messagesForUpstream = await safeGravityProjection(currentMessagesForNonStreamLoop, {
            pluginManager, latestPayload: payloadForLoop, recursionDepth,
            gravityHandoff,
            gravityRawToolResults: toolResultsTextForRAG,
            debugMode: DEBUG_MODE, signal: abortController?.signal
          });
        } catch {
          // Even failure to load the safety module must not break tool continuation.
          messagesForUpstream = currentMessagesForNonStreamLoop;
        }
        // GRAVITY_SAFETY_END

        // Recheck cancellation after awaited tool execution and projection.
        if (abortController?.signal.aborted || res.writableEnded || res.destroyed) {
          break;
        }

        const recursionBody = { ...originalBody, messages: messagesForUpstream, stream: false };
        const recursionReadResult = await readNonStreamResponseWithSemanticRetry({
          fetchResponse: () => fetchNonStreamCompletion(recursionBody, `tool_loop_depth_${recursionDepth}`),
          retries: apiRetries,
          delay: apiRetryDelay,
          debugMode: DEBUG_MODE,
          signal: abortController.signal,
          label: `tool_loop_depth_${recursionDepth}`
        });
        const recursionAiResponse = recursionReadResult.response;

        await assertResponseOk(recursionAiResponse, { phase: 'tool_continuation' }, abortController.signal);

        validUpstreamTurns = validUpstreamTurns && isCompleteNonStreamResponse(recursionReadResult);
        const recursionText = recursionReadResult.text;
        const recursionParsedResponse = extractedResponse(recursionText);
        const recursionMessage = recursionParsedResponse.message;
        if (recursionMessage) {
          currentAIContentForLoop = '\n' + extractVisibleContent(recursionMessage);
          currentAIContentForClient = '\n' + extractClientContent(recursionMessage, '', recursionParsedResponse.choice);
        } else {
          currentAIContentForLoop = '\n' + recursionText;
          currentAIContentForClient = '\n' + recursionText;
        }
        if (currentAIContentForLoop && currentAIContentForLoop.trim()) {
          oneRingAssistantTurnParts.push(currentAIContentForLoop);
        }
        if (writeChatLog) {
          chatLogs.push({
            request: currentMessagesForNonStreamLoop,
            toolCalls: [ ...archeryLogs, ...normalCallLogs ],
            response: recursionMessage || recursionText,
          });
        }

      } else {
        anyToolProcessedInCurrentIteration = false;
        completed = validUpstreamTurns;
      }

      if (!anyToolProcessedInCurrentIteration) break;
      recursionDepth++;
    } while (recursionDepth < maxRecursion && !(abortController && abortController.signal.aborted));

    // 轮数保真器：循环结束（正常退出 / break / 熔断分支）后释放本次会话状态。
    rollKeeper.reset();

    throwIfAborted(abortController.signal);
    if (res.writableEnded || res.destroyed) return;
    const loopEndedAtLimit = recursionDepth >= maxRecursion
      && !(abortController && abortController.signal.aborted);
    let pendingToolCallsAtLimit = [];
    if (loopEndedAtLimit && !vcpToolUseForbidden) {
      try {
        pendingToolCallsAtLimit = ToolCallParser.parse(currentAIContentForLoop);
      } catch (parseError) {
        console.error('[VCP NonStream Loop] Failed to inspect pending tool calls at loop limit:', parseError);
      }
    }

    const hasPendingToolCallsAtLimit = pendingToolCallsAtLimit.length > 0;

    // 独立暂停原因：同一工具同参数连续失败达到阈值。与 limit 分支互斥。
    const loopEndedAtStuck = stuckHalt !== null
      && !(abortController && abortController.signal.aborted);
    let pendingToolCallsAtStuck = [];
    if (loopEndedAtStuck && !vcpToolUseForbidden) {
      try {
        pendingToolCallsAtStuck = ToolCallParser.parse(currentAIContentForLoop);
      } catch (parseError) {
        console.error('[VCP NonStream Loop] Failed to inspect pending tool calls at stuck halt:', parseError);
      }
    }
    const hasPendingToolCallsAtStuck = pendingToolCallsAtStuck.length > 0;

    if ((loopEndedAtLimit || loopEndedAtStuck) && currentAIContentForClient && currentAIContentForClient.trim()) {
      conversationHistoryForClient.push(currentAIContentForClient);
    }
    if (loopEndedAtStuck) {
      const pendingClauseAtStuck = hasPendingToolCallsAtStuck
        ? '最后生成的 ' + pendingToolCallsAtStuck.length + ' 个工具请求尚未执行（已如实保留，未派发）。'
        : '停止时没有待执行的工具请求。';
      const stuckNotice = '\n\n> [!WARNING]\n> **VCP 工具循环已硬暂停（同一调用连续失败）**：检测到同一工具以完全相同参数连续失败达到阈值，已停止本轮工具执行以打断重复失败循环。任务尚未完成；' + pendingClauseAtStuck + '请检查阻塞原因（工具参数、权限或上游状态）后发送“继续”恢复。为避免重复副作用，系统不会自动重放。\n';
      conversationHistoryForClient.push(stuckNotice);
      oneRingAssistantTurnParts.push(stuckNotice);
    }
    if (hasPendingToolCallsAtLimit) {
      const notice = '\n\n> [!WARNING]\n> **VCP 工具循环已暂停**：本轮已达到 ' + maxRecursion + ' 次工具递归上限，最后生成的 ' + pendingToolCallsAtLimit.length + ' 个工具请求尚未执行。任务尚未完成；请发送“继续”恢复。为避免重复副作用，系统不会自动重放。\n';
      conversationHistoryForClient.push(notice);
      oneRingAssistantTurnParts.push(notice);
    }

    let finalContentForClient = conversationHistoryForClient.join('');

    // ★ 熔断收口时净化尾部未闭合的 VCP 工具块残片，确保落盘 history.json 的语法完整。
    if ((loopEndedAtLimit || loopEndedAtStuck) && !vcpToolUseForbidden && finalContentForClient) {
      try {
        const { sanitizeContent } = require('../vcpLoop/historySanitizer.js');
        finalContentForClient = sanitizeContent(finalContentForClient);
      } catch (sanitizeErr) {
        if (DEBUG_MODE) console.warn('[VCP NonStream Loop] Final content sanitize failed:', sanitizeErr.message);
      }
    }

    const finalFinishReason = hasPendingToolCallsAtLimit ? 'length' : 'stop';
    let finalJsonResponse;
    try {
      finalJsonResponse = JSON.parse(aiResponseText);
      if (!finalJsonResponse.choices?.[0]?.message) {
        finalJsonResponse.choices = [{ message: { content: finalContentForClient } }];
      } else {
        finalJsonResponse.choices[0].message.content = finalContentForClient;
        if (reasoningToContentEnabled) {
          removeReasoningFields(finalJsonResponse.choices[0].message);
          removeReasoningFields(finalJsonResponse.choices[0]);
        }
      }
      finalJsonResponse.choices[0].finish_reason = finalFinishReason;
    } catch (e) {
      finalJsonResponse = {
        choices: [{ index: 0, message: { role: 'assistant', content: finalContentForClient }, finish_reason: finalFinishReason }]
      };
    }

    if (loopEndedAtStuck) {
      finalJsonResponse.vcp_status = {
        code: 'VCP_TOOL_LOOP_STUCK',
        current: recursionDepth,
        max: maxRecursion,
        pendingToolCalls: pendingToolCallsAtStuck.length,
      };
    } else if (hasPendingToolCallsAtLimit) {
      finalJsonResponse.vcp_status = {
        code: 'VCP_TOOL_LOOP_LIMIT',
        current: recursionDepth,
        max: maxRecursion,
        pendingToolCalls: pendingToolCallsAtLimit.length,
      };
    }

    if (writeChatLog) writeChatLog(originalBody, chatLogs);
    // OneRing 由主流程在整轮完成且响应发送完成后提交。
    if (!res.writableEnded && !res.destroyed) {
      // ★ AICW 内层禁工具消费回执：在最终有效非流式回应处生成，本机字段强制覆盖
      //   上游同名字段（emit 内部再次复核真实分支事实并重新计算响应摘要）。
      const finalResponseBuffer = Buffer.from(JSON.stringify(finalJsonResponse));
      emitVcpToolForbiddenReceipt(res, {
        binding: vcpToolForbiddenReceipt,
        markerConsumed: vcpToolForbiddenReceipt ? vcpToolForbiddenReceipt.markerConsumed === true : false,
        toolForbidden: vcpToolUseForbidden === true,
        toolParsingSkipped: toolParseSkippedThisRequest === true,
        toolsExecuted: toolExecutionsThisRequest,
        backendModel: vcpToolForbiddenReceipt ? vcpToolForbiddenReceipt.backendModel : null,
        responseText: finalResponseBuffer.toString('utf8')
      });
      res.send(finalResponseBuffer);
    }
    return {
      completed: completed && !abortController?.signal.aborted && !res.destroyed,
      aiText: oneRingAssistantTurnParts.join('\n')
    };
  }
}

module.exports = NonStreamHandler;