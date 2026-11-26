const { UpstreamError, assertResponseOk, throwIfAborted, isClaudeBridgeModel } = require('../upstreamErrors.js');
// modules/handlers/streamHandler.js
const { StringDecoder } = require('string_decoder');
const vcpInfoHandler = require('../../vcpInfoHandler.js');
const { matchesNativeToolIsolation } = require('../nativeToolIsolation.js');
const { ModelOutputGuard, inspectModelOutput, NOTICE: modelProtocolNotice } = require('../vcpLoop/modelOutputGuard');
const contextBudget = require('../contextBudget.js');
const finalContextStore = require('../finalContextStore.js');
const roleDivider = require('../roleDivider.js');
const { formatToolResultBatch, projectToolBatchForUpstream, buildToolPayloadMessage } = require('../toolResultBatch.js');
const { NATIVE_CALL_ID, collectStreamToolCalls, normalizeNativeVcpCalls, buildBoundedNativeReceipts } = require('../nativeToolLoop');

const {
  extractReasoningText,
  removeReasoningFields,
  normalizeReasoningTag,
  shouldConvertReasoningForModel
} = require('../reasoningContentAdapter.js');
const { createRollKeeper } = require('../vcpLoop/rollKeeper');
const { inspectToolBlockClosure } = require('../vcpLoop/historySanitizer');

// 读取软预算配置：缺失/空白/非法/非正数一律视为禁用 token 黄灯（0），绝不让请求抛错。
function readSoftTokenBudgetEnv() {
  const raw = process.env.VCP_CONTEXT_SOFT_BUDGET;
  if (raw === undefined || raw === null) return 0;
  const trimmed = String(raw).trim();
  if (trimmed === '') return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

class StreamHandler {
  constructor(context) {
    this.context = context;
    this.config = context; // 兼容旧代码中的解构
  }

  async handle(req, res, firstAiAPIResponse) {
    const {
      apiUrl,
      apiKey,
      pluginManager,
      writeDebugLog,
      writeChatLog,
      webSocketServer,
      DEBUG_MODE,
      SHOW_VCP_OUTPUT,
      maxVCPLoopStream,
      apiRetries,
      apiRetryDelay,
      RAGMemoRefresh,
      enableRoleDivider,
      touchRequestActivity,
      toolExecutor,
      ToolCallParser,
      abortController,
      originalBody,
      clientIp,
      _refreshRagBlocksIfNeeded,
      fetchWithRetry,
      vcpToolUseForbidden,
      apiConnectionTimeoutMs,
      semanticModelFallbackCandidates,
      oneRingResponseMeta,
      budgetGuard,
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
    const id = originalBody.requestId || originalBody.messageId;

    const waitForHandoff = async () => {
      console.log(`[Handoff] WAITING: requestId=${id}. 工具回执已发送；因 ready 暂缓下一轮上游 AI 请求，等待 Interrupt 或 cancel（最多2秒），尚未向 AI 派发。`);
      try {
        await this.context.handoffGate.wait();
      } catch (error) {
        if (error.name === 'AbortError') {
          console.log(`[Handoff] STOPPED before dispatch: requestId=${id}. ready 等待期间收到中止信号，本轮工具结果未触发下一次上游 AI 请求。`);
        }
        throw error;
      }
      if (!abortController.signal.aborted && !res.writableEnded && !res.destroyed) {
        console.log(`[Handoff] RESUMING: requestId=${id}. 预约已取消或等待超时，恢复下一轮上游 AI 请求派发。`);
      }
    };

    // Keep the client connection alive across the entire VCP request, including
    // tool execution and the wait for a continuation response from upstream.
    const keepAliveIntervalMs = this.context.sseKeepAliveIntervalMs || 5000;
    const keepAliveTimer = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try { res.write(': vcp-keepalive\n\n'); } catch { /* client disconnected */ }
    }, keepAliveIntervalMs);
    keepAliveTimer.unref?.();
    const stopKeepAlive = () => clearInterval(keepAliveTimer);
    res.once?.('finish', stopKeepAlive);
    res.once?.('close', stopKeepAlive);

    try {

    let currentMessagesForLoop = originalBody.messages ? JSON.parse(JSON.stringify(originalBody.messages)) : [];
    let recursionDepth = 0;
    const parsedMaxRecursion = Number.parseInt(maxVCPLoopStream, 10);
    const maxRecursion = Number.isFinite(parsedMaxRecursion) && parsedMaxRecursion > 0
      ? parsedMaxRecursion
      : 20;
    const rollKeeper = createRollKeeper({ maxRecursion, tokenBudget: readSoftTokenBudgetEnv() });
    // 硬暂停（repeat_halt）时保存停止信息，交由循环后的 stuck 分支统一收口。
    let stuckHalt = null;
    let currentAIContentForLoop = '';
    let chatLogs = [];
    let oneRingAssistantTurnParts = [];
    let validUpstreamTurns = true;
    let lastUpstreamFinishReason = null;
    let lastUpstreamError = null;
    let completed = false;
    let protocolHalt = null;
    let currentExecutionText = '';

    const finalUpstreamFinishReason = () => validUpstreamTurns ? (['tool_calls','function_call'].includes(lastUpstreamFinishReason) ? lastUpstreamFinishReason : 'stop')
      : (lastUpstreamFinishReason && lastUpstreamFinishReason !== 'stop' ? lastUpstreamFinishReason : null);

    const formatStreamUpstreamErrorNotice = (errObj) => {
      if (!errObj) return null;
      const safeClean = (val, maxLen = 160) => String(val ?? '')
        .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
      if (typeof errObj === 'string') {
        const msg = safeClean(errObj);
        return msg ? `\n\n[上游返回错误：${msg}]` : '\n\n[上游返回错误；请检查渠道状态或配额后重试。]';
      }
      if (typeof errObj === 'object') {
        const rawCode = typeof errObj.code === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(errObj.code)
          ? errObj.code
          : (typeof errObj.type === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(errObj.type) ? errObj.type : null);
        const rawMsg = typeof errObj.message === 'string' ? safeClean(errObj.message) : '';
        if (rawCode === 'limit_error_upstream') {
          return `\n\n[上游返回错误 (${rawCode})：Claude 官方订阅配额已达当前窗口上限${rawMsg ? ` (${rawMsg})` : ''}。请等待窗口重置或切换模型渠道，无需发送“继续”。]`;
        }
        if (rawCode && rawMsg) return `\n\n[上游返回错误 (${rawCode})：${rawMsg}]`;
        if (rawCode) return `\n\n[上游返回错误 (${rawCode})；请检查渠道状态后重试。]`;
        if (rawMsg) return `\n\n[上游返回错误：${rawMsg}]`;
      }
      return '\n\n[上游返回错误；请检查渠道状态或配额后重试。]';
    };

    const writeIncompleteUpstreamNotice = () => {
      if (validUpstreamTurns || finalUpstreamFinishReason() || res.writableEnded || res.destroyed) return;
      const explicitErrorNotice = formatStreamUpstreamErrorNotice(lastUpstreamError);
      const noticeText = explicitErrorNotice || '\n\n[上游响应未完整结束；本次回复可能不完整。请重试或发送“继续”。]';
      const statusCode = explicitErrorNotice ? 'UPSTREAM_STREAM_ERROR' : 'UPSTREAM_STREAM_INCOMPLETE';
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-VCP-upstream-incomplete-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: originalBody.model,
        choices: [{ index: 0, delta: { content: noticeText }, finish_reason: null }],
        vcp_status: { code: statusCode }
      })}\n\n`);
    };

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
        if (DEBUG_MODE) console.warn(`[VCP Stream Loop] Tool payload contains image_url, but ${processorName} is unavailable. Forwarding original payload.`);
        return content;
      }

      const originalImageParts = content.filter(part => part?.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string');
      const payloadMessage = { role: 'user', content: JSON.parse(JSON.stringify(content)) };

      if (DEBUG_MODE) {
        console.log(`[VCP Stream Loop] Translating tool-returned image_url content via ${processorName}. textOnly=${!!isTextOnlyForceTranslateModel}, plus=${!!shouldProcessMediaPlus}`);
      }

      let translatedMessages;
      try {
        translatedMessages = await pluginManager.executeMessagePreprocessor(
          processorName,
          [payloadMessage],
          requestPreprocessorConfig || {}
        );
      } catch (pluginError) {
        console.error(`[VCP Stream Loop] Error translating tool-returned media via ${processorName}:`, pluginError);
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

    // 辅助函数：处理 AI 响应流 (优化版：直通转发 + 后台解析 + chunk 空闲超时保护)
    const readAIResponseStream = async (aiResponse, isInitialCall) => {
      // On a healthy response attach listeners in this turn: a peer can close immediately after its last frame.
      if (!aiResponse.ok || abortController.signal.aborted) {
        await assertResponseOk(aiResponse, { phase: isInitialCall ? 'initial' : 'tool_continuation' }, abortController.signal);
      }
      return new Promise((resolve, reject) => {
        const decoder = new StringDecoder('utf8');
        let collectedContentThisTurn = '';
        const outputGuard = new ModelOutputGuard();
        let sseLineBuffer = '';
        let streamAborted = false;
        let chunkIdleTimer = null;
        const configuredIdleTimeout = Number(process.env.STREAM_CHUNK_IDLE_TIMEOUT_MS);
        const CHUNK_IDLE_TIMEOUT = Number.isFinite(configuredIdleTimeout) && configuredIdleTimeout > 0 ? configuredIdleTimeout : 90000; // 默认 90 秒（可通过 STREAM_CHUNK_IDLE_TIMEOUT_MS 配置）
        let message = { content: '', reasoning_content: '' };
        let clientReasoningBlockOpen = false;
        let clientReasoningEndsWithNewline = false;

        let finishReason = null;
        let nativeFinishReason = null;
        let malformedFunctionCall = false;
        let sawDone = false;
        let invalidPayload = false;
        let streamError = null;
        let upstreamEnded = false;
        let sawNativeToolCall = false;
        let identifiedNativeCall = false;
        let nativeToolCallCommitted = false;
        let ownedNativeTurn = null;
        let invalidOwnedNativeTurn = false;
        const nativeToolFrames = [];
        const MAX_NATIVE_TOOL_BYTES = 4 * 1024 * 1024;
        let nativeToolBytes = 0;
        let nativeToolOverflow = false;

        let nativeKind = null, hasPayloadError = false, toolTailTimer = null, settled = false;
        const result = () => ({
          content: collectedContentThisTurn, executionText: outputGuard.executionText(), halt: outputGuard.halt,
          message, finishReason: nativeKind && (!finishReason || finishReason === 'stop') ? nativeKind : finishReason,
          streamError, malformedFunctionCall, streamAborted, hasPayloadError, nativeFinishReason,
          sawNativeToolCall: nativeToolCallCommitted, ownedNativeTurn, invalidOwnedNativeTurn,
          completed: !outputGuard.halt && !streamAborted && !invalidPayload && aiResponse.ok &&
            ((collectedContentThisTurn.trim().length > 0 && (finishReason === 'stop' || (!finishReason && sawDone))) ||
             (nativeToolCallCommitted || ownedNativeTurn !== null)) === true
        });
        const observePayload = (parsedData) => {
          // 首个上游调用的 usage 就是「最终上下文」快照那份请求体的真实计数。
          if (isInitialCall && parsedData?.usage) finalContextStore.recordUpstreamUsage(id, parsedData.usage);
          // 每一轮的真实用量都用来校准下一轮的预算估算。
          if (parsedData?.usage) budgetGuard?.noteUsage(parsedData.usage, aiResponse?.vcpAttemptModel);
          if (parsedData?.error) {
            hasPayloadError = true;
            invalidPayload = true;
            streamError = parsedData.error;
          }
          const choice = parsedData?.choices?.[0];
          if ([choice?.native_finish_reason, choice?.finish_reason]
            .some(reason => typeof reason === 'string' && reason.toLowerCase() === 'malformed_function_call')) {
            malformedFunctionCall = true;
            invalidPayload = true;
          }
          const isolated = matchesNativeToolIsolation(originalBody?.model) || matchesNativeToolIsolation(parsedData?.model || originalBody?.model);
          for (const item of parsedData?.choices || []) {
            for (const field of [item.delta, item.message]) {
              if (!field) continue;
              if (isolated) { delete field.tool_calls; delete field.function_call; }
              else if (item === choice) {
                if (field.tool_calls?.length) nativeKind = 'tool_calls';
                else if (field.function_call) nativeKind = 'function_call';
              }
            }
            if (isolated) for (const key of ['finish_reason','native_finish_reason']) {
              if (['tool_calls','function_call'].includes(item[key])) item[key] = null;
            }
          }
          const delta = choice?.delta;
          const msg = choice?.message;
          if (
            (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) ||
            delta?.function_call ||
            (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) ||
            msg?.function_call ||
            ['tool_calls', 'function_call'].includes(choice?.finish_reason)
          ) {
            sawNativeToolCall = true;
            // An arguments-only fragment has no actionable identity. Buffer it
            // for normal native completion, but do not let it hold a complete text tool forever.
            if (['tool_calls', 'function_call'].includes(choice?.finish_reason) ||
                ['tool_calls', 'function_call'].includes(choice?.native_finish_reason) ||
                [delta, msg].some(part => part?.function_call?.name ||
                  (Array.isArray(part?.tool_calls) && part.tool_calls.some(call => call?.id || call?.function?.name)))) {
              identifiedNativeCall = true;
            }
          }
          if (choice?.native_finish_reason) nativeFinishReason = choice.native_finish_reason;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        };

        const collectAndGuardPayload = (payload) => {
          const delta = payload.choices?.[0]?.delta;
          const visible = typeof delta?.content === 'string' ? delta.content : '';
          // Raw upstream text is retained only in the diagnostic response object.
          message.content += visible;
          message.reasoning_content += extractReasoningText(delta) || '';
          const safeText = outputGuard.push(visible);
          collectedContentThisTurn += safeText;
          const clientPayload = JSON.parse(JSON.stringify(payload));
          if (clientPayload.choices?.[0]?.delta) {
            clientPayload.choices[0].delta.content = safeText;
          }
          if (visible || extractReasoningText(delta)) {
            clearTimeout(toolTailTimer);
            toolTailTimer = null;
            if (!vcpToolUseForbidden && !outputGuard.halt && visible && message.content.trimEnd().endsWith('>>>')) {
              toolTailTimer = setTimeout(() => takeTail(), 15000);
            }
          }
          return clientPayload;
        };

        const transformParsedDataForClient = (parsedData) => {
          if (!reasoningToContentEnabled || !parsedData || typeof parsedData !== 'object') {
            return parsedData;
          }

          const transformed = JSON.parse(JSON.stringify(parsedData));
          const choice = transformed.choices?.[0];
          const delta = choice?.delta;
          if (!delta || typeof delta !== 'object') return transformed;

          const reasoningText = extractReasoningText(delta);
          const visibleContent = typeof delta.content === 'string' ? delta.content : '';
          let clientContent = '';

          if (reasoningText) {
            if (!clientReasoningBlockOpen) {
              clientContent += `<${reasoningTag}>\n`;
              clientReasoningBlockOpen = true;
            }
            clientContent += reasoningText;
            clientReasoningEndsWithNewline = /(?:\r\n|\r|\n)$/.test(reasoningText);
          }

          // 正文与推理同 chunk 出现时，先规范闭合思考块，再输出正文。
          if (visibleContent && clientReasoningBlockOpen) {
            clientContent += `${clientReasoningEndsWithNewline ? '' : '\n'}</${reasoningTag}>\n`;
            clientReasoningBlockOpen = false;
            clientReasoningEndsWithNewline = false;
          }
          clientContent += visibleContent;

          // 上游明确结束但没有正文时，也必须规范补齐闭合标签。
          if (choice.finish_reason && clientReasoningBlockOpen) {
            clientContent += `${clientReasoningEndsWithNewline ? '' : '\n'}</${reasoningTag}>\n`;
            clientReasoningBlockOpen = false;
            clientReasoningEndsWithNewline = false;
          }

          removeReasoningFields(delta);
          if (clientContent) {
            delta.content = clientContent;
          } else if (Object.prototype.hasOwnProperty.call(delta, 'content')) {
            delete delta.content;
          }

          return transformed;
        };

        // Defer only FC data and its terminal choice; visible text still streams immediately.
        const forwardClientPayload = (parsedData) => {
          if (!hasPayloadError && !sawNativeToolCall &&
              parsedData?.choices?.[0]?.finish_reason === 'content_filter' &&
              !collectedContentThisTurn.trim() && !message.reasoning_content &&
              /hydrogen/i.test(aiResponse?.vcpAttemptModel || originalBody?.model || '')) {
            console.warn(`[VCP Stream Recovery] requestId=${id || 'unknown'} Hydrogen 空 content_filter，按上游 MALFORMED_FUNCTION_CALL 映射处理。`);
            malformedFunctionCall = true;
            invalidPayload = true;
            return;
          }
          const transformed = transformParsedDataForClient(parsedData);
          // Only the outer loop terminates the downstream chat.
          if (!sawNativeToolCall) for (const choice of transformed?.choices || []) {
            if (choice.finish_reason) choice.finish_reason = null;
          }
          if (!Array.isArray(transformed?.choices) || !sawNativeToolCall) {
            res.write(`data: ${JSON.stringify(transformed)}\n`);
            return;
          }

          const immediate = [];
          const pending = [];
          for (const choice of transformed.choices) {
            const fc = { index: choice.index };
            const visible = { ...choice };
            for (const key of ['delta', 'message']) {
              const payload = choice[key];
              if (!payload || typeof payload !== 'object') continue;
              const { tool_calls, function_call, ...rest } = payload;
              if (tool_calls !== undefined || function_call !== undefined) {
                fc[key] = {
                  ...(tool_calls !== undefined ? { tool_calls } : {}),
                  ...(function_call !== undefined ? { function_call } : {})
                };
                visible[key] = rest;
              }
            }

            if (choice.finish_reason && ['tool_calls', 'function_call', 'stop'].includes(choice.finish_reason)) {
              // Keep buffered call arguments intact. The outer chat loop emits the sole client terminal.
              fc.finish_reason = this.context.ownsNativeVcpTools ? choice.finish_reason : null;
              visible.finish_reason = null;
              if (visible.native_finish_reason != null) {
                if (this.context.ownsNativeVcpTools) fc.native_finish_reason = visible.native_finish_reason;
                delete visible.native_finish_reason;
              }
            }
            if (Object.keys(fc).length > 1) {
              fc.delta ??= {};
              fc.finish_reason ??= null;
              pending.push(fc);
              if (Object.keys(visible.delta || visible.message || {}).length > 0) immediate.push(visible);
            } else {
              immediate.push(visible);
            }
          }

          if (pending.length && !nativeToolOverflow) {
            const frame = `data: ${JSON.stringify({ ...transformed, usage: undefined, choices: pending })}\n\n`;
            nativeToolBytes += Buffer.byteLength(frame);
            if (nativeToolBytes > MAX_NATIVE_TOOL_BYTES) {
              nativeToolOverflow = true;
              invalidPayload = true;
              nativeToolFrames.length = 0;
            } else {
              nativeToolFrames.push(frame);
            }
          }
          if (immediate.length || !pending.length || transformed.usage) {
            res.write(`data: ${JSON.stringify({ ...transformed, choices: immediate })}\n`);
          }
        };

        const commitNativeToolFrames = () => {
          if (!nativeToolFrames.length || !sawNativeToolCall || outputGuard.halt || hasPayloadError || invalidPayload || streamAborted ||
              abortController?.signal.aborted || !aiResponse.ok || res.writableEnded || res.destroyed ||
              !(['tool_calls', 'function_call', 'stop'].includes(finishReason) || (!finishReason && sawDone))) return;
          if (this.context.ownsNativeVcpTools) {
            const calls = collectStreamToolCalls(nativeToolFrames);
            const normalized = normalizeNativeVcpCalls(calls);
            if (!normalized) {
              invalidOwnedNativeTurn = true;
              invalidPayload = true;
              return;
            }
            ownedNativeTurn = { calls, normalized };
            return;
          }
          for (const frame of nativeToolFrames) res.write(frame);
          nativeToolCallCommitted = true;
        };
        const writeClientReasoningCloseChunk = () => {
          if (!reasoningToContentEnabled || !clientReasoningBlockOpen || res.writableEnded || res.destroyed) {
            return;
          }

          const closePrefix = clientReasoningEndsWithNewline ? '' : '\n';
          clientReasoningBlockOpen = false;
          clientReasoningEndsWithNewline = false;
          const closePayload = {
            id: `chatcmpl-VCP-reasoning-close-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model || 'unknown',
            choices: [{
              index: 0,
              delta: { content: `${closePrefix}</${reasoningTag}>\n` },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(closePayload)}\n\n`);
        };
        // 🌟 新增：chunk 级空闲超时保护
        // 如果连续 CHUNK_IDLE_TIMEOUT 毫秒未收到任何上游 data chunk，
        // 则终止读取并抛出安全错误，不允许把部分输出送入工具补救轮。
        const resetChunkIdleTimer = () => {
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          chunkIdleTimer = setTimeout(() => {
            if (streamAborted) return;
            if (takeTail()) return;
            console.warn(`[Stream IdleTimeout] No upstream chunk received for ${CHUNK_IDLE_TIMEOUT / 1000}s. Assuming stream stalled. Forcing end.`);
            failStream('upstream_timeout');
          }, CHUNK_IDLE_TIMEOUT);
        };
        resetChunkIdleTimer(); // 启动首次空闲计时

        const cleanupStream = () => {
          settled = true;
          clearTimeout(toolTailTimer);
          clearTimeout(chunkIdleTimer);
          abortController?.signal.removeEventListener('abort', abortHandler);
          aiResponse.body.removeListener('data', onData);
          aiResponse.body.removeListener('end', onEnd);
          aiResponse.body.removeListener('error', onError);
          aiResponse.body.removeListener('close', onClose);
        };
        const failStream = code => {
          if (streamAborted) return;
          streamAborted = true;
          cleanupStream();
          // At body idle, only complete decoded SSE deltas are in this guard.
          // Display the checked text tail; never use it for tool dispatch or mark this turn complete.
          if (code === 'upstream_timeout' && !abortController.signal.aborted && !res.destroyed && !res.writableEnded) {
            try {
              const tail = outputGuard.finish();
              writeClientReasoningCloseChunk();
              if (tail && !outputGuard.halt) {
                res.write('data: ' + JSON.stringify({ object: 'chat.completion.chunk', model: originalBody.model,
                  choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] }) + '\n\n');
              }
            } catch { /* Continue to terminate and release the upstream reader. */ }
          }
          if (!aiResponse.body.destroyed) {
            // _destroy may report an asynchronous error before close.
            const ignoreDestroyError = () => {};
            aiResponse.body.on('error', ignoreDestroyError);
            aiResponse.body.once('close', () => aiResponse.body.removeListener('error', ignoreDestroyError));
            aiResponse.body.destroy();
          }
          const failure = new UpstreamError({ status: aiResponse.status, code,
            phase: isInitialCall ? 'initial' : 'tool_continuation' });
          if (code === 'upstream_timeout') failure.streamBodyIdle = true;
          reject(failure);
        };
        const takeTail = () => {
          if (settled || streamAborted || identifiedNativeCall || nativeToolOverflow || hasPayloadError || outputGuard.halt || !aiResponse.ok ||
              abortController.signal.aborted || res.destroyed || res.writableEnded || vcpToolUseForbidden ||
              sseLineBuffer.trim() || decoder.lastNeed ||
              (finishReason && !malformedFunctionCall && !['stop','tool_calls','function_call'].includes(finishReason))) return false;
          if (!ToolCallParser.endsWithCompleteToolRequest?.(message.content)) return false;
          const safe = inspectModelOutput(message.content);
          if (safe.halt || !ToolCallParser.endsWithCompleteToolRequest?.(safe.executionText)) return false;
          // Text owns this incomplete upstream turn now. Never forward or dispatch the orphan fragments.
          nativeToolFrames.length = 0;
          nativeToolBytes = 0;
          nativeKind = null;
          const tail = outputGuard.finish();
          collectedContentThisTurn += tail;
          try {
            writeClientReasoningCloseChunk();
            if (tail) res.write('data: ' + JSON.stringify({object:'chat.completion.chunk', model:originalBody.model,
              choices:[{index:0,delta:{content:tail},finish_reason:null}]}) + '\n\n');
          } catch {
            failStream('aborted');
            return true;
          }
          cleanupStream();
          if (!aiResponse.body.destroyed) {
            const ignore = () => {};
            aiResponse.body.on('error', ignore);
            aiResponse.body.once('close', () => aiResponse.body.removeListener('error', ignore));
            aiResponse.body.destroy();
          }
          resolve({...result(), completed:true, malformedFunctionCall:false, finishReason:'stop'});
          return true;
        };
        const abortHandler = () => failStream('aborted');
        const onClose = () => {
          if (!aiResponse.body.readableEnded && !streamAborted && !takeTail()) failStream('stream_error');
        };
        const onError = () => { if (!takeTail()) failStream(abortController.signal.aborted ? 'aborted' : 'stream_error'); };

        const onData = chunk => {
          if (streamAborted) return;
          resetChunkIdleTimer(); // 每收到一个 chunk 就重置空闲计时器
          touchRequestActivity?.();

          const chunkString = decoder.write(chunk);
          sseLineBuffer += chunkString;

          // 按行处理：既保证了转发的实时性，又解决了 [DONE] 跨包截断的问题
          // 使用更健壮的正则拆分，处理 \r\n, \n, \r (SSE 规范允许这三种换行符)
          let lines = sseLineBuffer.split(/\r\n|\r|\n/);
          sseLineBuffer = lines.pop(); // 最后一项可能是截断的，留到下一轮

          for (const line of lines) {
            const trimmedLine = line.trim();
            const isDoneLine = trimmedLine === 'data: [DONE]' || trimmedLine === 'data:[DONE]';
            if (isDoneLine) sawDone = true;
            let parsedData = null;

            if (trimmedLine.startsWith('data:')) {
              const jsonData = trimmedLine.substring(5).trim();
              if (jsonData && jsonData !== '[DONE]') {
                try {
                  parsedData = JSON.parse(jsonData);
                  observePayload(parsedData);
                  parsedData = collectAndGuardPayload(parsedData);
                } catch (e) { invalidPayload = hasPayloadError = true; parsedData = null; }
              }
            }

            // Failed terminal payloads must not end the frontend listener before recovery.
            if (malformedFunctionCall) continue;
            // 转发时才将 reasoning 字段改写成标签化正文；内部处理仍使用原始 parsedData。
            if (!res.writableEnded && !res.destroyed) {
              try {
                if (isDoneLine) {
                  writeClientReasoningCloseChunk();
                } else if (parsedData) {
                  forwardClientPayload(parsedData);
                } else {
                  // 保留空行，因为 SSE 依靠空行分隔消息块。
                  res.write(line + '\n');
                }
              } catch (writeError) {
                failStream('aborted');
                return;
              }
            }
          }
        };

        const onEnd = () => {
          upstreamEnded = true;
          if (chunkIdleTimer) clearTimeout(chunkIdleTimer);
          const remainingString = decoder.end();
          if (remainingString) {
            sseLineBuffer += remainingString;
          }

          // 处理最后剩余的 buffer并转发
          if (sseLineBuffer.length > 0) {
            const trimmedLine = sseLineBuffer.trim();
            const isDoneLine = trimmedLine === 'data: [DONE]' || trimmedLine === 'data:[DONE]';
            if (isDoneLine) sawDone = true;
            let parsedData = null;

            if (trimmedLine.startsWith('data:')) {
              const jsonData = trimmedLine.substring(5).trim();
              if (jsonData && jsonData !== '[DONE]') {
                try {
                  parsedData = JSON.parse(jsonData);
                  observePayload(parsedData);
                  parsedData = collectAndGuardPayload(parsedData);
                } catch (e) { invalidPayload = hasPayloadError = true; parsedData = null; }
              }
            }

            if (!res.writableEnded && !res.destroyed) {
              try {
                if (isDoneLine) {
                  writeClientReasoningCloseChunk();
                } else if (parsedData && !malformedFunctionCall) {
                  forwardClientPayload(parsedData);
                  res.write('\n');
                } else {
                  if (!malformedFunctionCall) res.write(sseLineBuffer + '\n');
                }
              } catch (e) { }
            }
          }

          if (!finishReason && !sawDone && takeTail()) return;
          const tail = outputGuard.finish();
          collectedContentThisTurn += tail;
          writeClientReasoningCloseChunk();
          if (tail && !res.writableEnded && !res.destroyed) {
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-VCP-guard-tail-${Date.now()}`,
              object: 'chat.completion.chunk',
              model: originalBody.model,
              choices: [{ index: 0, delta: { content: tail }, finish_reason: null }]
            })}\n\n`);
          }
          if (!outputGuard.halt && !hasPayloadError && !invalidPayload) {
            try { commitNativeToolFrames(); } catch { failStream('stream_error'); return; }
          }
          cleanupStream();
          resolve(result());
        };
        aiResponse.body.on('error', onError);
        aiResponse.body.on('close', onClose);
        aiResponse.body.on('end', onEnd);
        abortController?.signal.addEventListener('abort', abortHandler, { once: true });
        if (abortController?.signal.aborted) { abortHandler(); return; }
        aiResponse.body.on('data', onData);
      });
    };

    const noteLoopRequest = (body) => {
      budgetGuard?.noteRequest(body);
      return body;
    };

    /**
     * 工具循环每次再发上游之前的预算检查。返回要发送的请求体；返回 null 表示已超预算、
     * 已向客户端说明并结束响应，调用方应退出循环。
     * 超预算时先把本轮之前的工具结果压缩成摘要（当前轮不动），仍然超才停止。
     */
    const prepareLoopRequest = (roundStartIndex, loopMessages = currentMessagesForLoop) => {
      const build = () => projectToolBatchForUpstream({ ...originalBody, messages: loopMessages, stream: true });
      let body = build();
      if (!budgetGuard?.active) return body;
      let check = budgetGuard.check(body, 'tool_loop', { silent: budgetGuard.enforcing });
      if (check.over && budgetGuard.enforcing) {
        const slimmed = contextBudget.slimToFit(loopMessages, roundStartIndex, () => budgetGuard.check(build(), 'tool_loop', { silent: true }).over);
        if (slimmed > 0) {
          body = build();
          const before = check.estimated;
          check = budgetGuard.check(body, 'tool_loop', { silent: true });
          console.warn(`[ContextBudget] 工具循环超预算，已压缩 ${slimmed} 条较早的工具结果: requestId=${id || 'none'} ${before} -> ${check.estimated} / ${check.limit}`);
        }
      }
      if (check.over && budgetGuard.enforcing) {
        console.warn(`[ContextBudget] 工具循环已停止: requestId=${id || 'none'} estimated=${check.estimated} limit=${check.limit}`);
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-VCP-context-budget-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: originalBody.model || 'unknown',
              vcp_incomplete: true,
              vcp_context_budget: { stage: 'tool_loop', estimated: check.estimated, limit: check.limit },
              choices: [{ index: 0, delta: {
                content: `\n\n> [!WARNING]\n> ${contextBudget.exceededMessage(check, 'tool_loop', budgetGuard.breakdown(body))}\n`
              }, finish_reason: 'stop' }],
            })}\n\n`);
            res.write('data: [DONE]\n\n', () => {
              try { res.end(); } catch (e) { }
            });
          } catch (e) {
            try { res.end(); } catch (_) { }
          }
        }
        return null;
      }
      return noteLoopRequest(body);
    };

    // Semantic recovery is per upstream turn, separate from transport retries and tool execution.
    // Recovery belongs to one upstream turn. Never replay guarded or bridge output.
    const processAIResponseStreamHelper = async (aiResponse, isInitialCall) => {
      let data = await readAIResponseStream(aiResponse, isInitialCall);
      const recoverBody = value => value.malformedFunctionCall && !value.halt && !value.streamAborted &&
        !value.hasPayloadError && !value.sawNativeToolCall && !value.ownedNativeTurn && !value.invalidOwnedNativeTurn && !vcpToolUseForbidden && !abortController.signal.aborted &&
        !res.destroyed && !res.writableEnded && ToolCallParser.parse(value.executionText).length > 0;
      if (recoverBody(data)) return {...data, completed:true, malformedFunctionCall:false, finishReason:'stop'};
      if (!data.malformedFunctionCall || data.halt) return data;
      if (abortController.signal.aborted || data.streamAborted || res.writableEnded || res.destroyed) return data;

      if (!data.hasPayloadError && !data.content.trim() && !data.message.reasoning_content && !isClaudeBridgeModel(originalBody.model)) {
        currentMessagesForLoop.push({
          role: 'user',
          content: '[系统提示]你的上一个回复在思维链里输出了call导致报错，不要在思维链里输出call啦，正常回复用户的回复吧！'
        });
        if (this.context.handoffGate?.isReady()) await waitForHandoff();
        throwIfAborted(abortController.signal);
        if (res.writableEnded || res.destroyed) return { ...data, content: '', executionText: '', completed: false };
        // The request-wide heartbeat stays active; do not replay preprocessors.
        const response = await fetchWithRetry(`${apiUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...openCodeGoSessionHeader,
            Accept: 'text/event-stream'
          },
          body: JSON.stringify(noteLoopRequest(projectToolBatchForUpstream({
            ...originalBody, messages: currentMessagesForLoop, stream: true
          }))),
          signal: abortController.signal
        }, {
          retries: 1, delay: apiRetryDelay, debugMode: DEBUG_MODE,
          connectionTimeout: apiConnectionTimeoutMs, phase: 'tool_continuation'
        });
        await assertResponseOk(response, { phase: 'tool_continuation' }, abortController.signal);
        if (res.writableEnded || res.destroyed) {
          response.body?.destroy();
          return { ...data, content: '', executionText: '', completed: false };
        }
        data = await readAIResponseStream(response, false);
        if (recoverBody(data)) return {...data, completed:true, malformedFunctionCall:false, finishReason:'stop'};
        if (!data.malformedFunctionCall) return data;
      }

      if (!abortController.signal.aborted && !res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({
          object: 'chat.completion.chunk', model: originalBody.model,
          choices: [{ index: 0, delta: {
            content: '\n[ERROR] 上游生成失败：MALFORMED_FUNCTION_CALL。恢复未成功或已有输出；本轮工具未执行。\n'
          }, finish_reason: null }]
        })}\n\n`);
      }
      // Only the outer handler owns terminal output; failed text never reaches tools.
      return { ...data, content: '', executionText: '', finishReason: null, completed: false };
    };

    // --- 初始 AI 调用 ---
    if (DEBUG_MODE) console.log('[VCP Stream Loop] Processing initial AI call.');
    let initialAIResponseData = await processAIResponseStreamHelper(firstAiAPIResponse, true);
    let lastAIResponseData = initialAIResponseData;
    let lastTurnSawNativeToolCall = Boolean(lastAIResponseData.sawNativeToolCall);
    validUpstreamTurns = initialAIResponseData.completed;
    lastUpstreamFinishReason = initialAIResponseData.finishReason;
    if (initialAIResponseData.streamError) lastUpstreamError = initialAIResponseData.streamError;
    currentAIContentForLoop = initialAIResponseData.content;
    currentExecutionText = initialAIResponseData.executionText;
    protocolHalt = initialAIResponseData.halt;
    if (writeChatLog) chatLogs.push({ request: originalBody, response: initialAIResponseData.message });
    if (!protocolHalt && currentAIContentForLoop && currentAIContentForLoop.trim()) {
      oneRingAssistantTurnParts.push(currentAIContentForLoop);
    }

    // --- VCP 循环 ---
    while (recursionDepth < maxRecursion) {
      // 检查中止信号
      if (abortController && abortController.signal.aborted) {
        if (DEBUG_MODE) console.log('[VCP Stream Loop] Abort detected, exiting loop.');
        break;
      }

      // Check before role processing AND before either normal or archery dispatch.
      if (protocolHalt) break;
      const rollInjection = rollKeeper.evaluate({ recursionDepth, messages: currentMessagesForLoop });
      if (rollInjection && rollInjection.kind === 'repeat_halt') {
        // 同指纹连续失败达到阈值：硬暂停本轮工具循环，未派发的工具一律不执行。
        stuckHalt = rollInjection;
        break;
      }
      // New model output has no authority to change its protocol role.
      const roundStartIndex = currentMessagesForLoop.length;
      const nativeTurn = lastAIResponseData.ownedNativeTurn;
      const nativeReasoning = lastAIResponseData.message?.reasoning_content;
      currentMessagesForLoop.push(nativeTurn ? {
        role: 'assistant',
        content: currentAIContentForLoop || null,
        ...(nativeReasoning ? { reasoning_content: nativeReasoning } : {}),
        tool_calls: nativeTurn.calls
      } : { role: 'assistant', content: currentAIContentForLoop });
      // Append reminders after the response so signature replay retains its history position.
      if (!nativeTurn && rollInjection && rollInjection.kind && rollInjection.content) {
        currentMessagesForLoop.push({ role: 'system', content: rollInjection.content });
      }

      const toolCalls = vcpToolUseForbidden || protocolHalt || !validUpstreamTurns || lastTurnSawNativeToolCall || lastAIResponseData.invalidOwnedNativeTurn
        ? []
        : nativeTurn?.normalized ?? ToolCallParser.parse(currentExecutionText);
      if (lastAIResponseData.invalidOwnedNativeTurn && !res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({
          object: 'chat.completion.chunk', model: originalBody.model, vcp_incomplete: true,
          choices: [{ index: 0, delta: { content: '\n[VCP 原生工具调用格式无效，本批未执行。]\n' }, finish_reason: null }]
        })}\n\n`);
      }
      if (toolCalls.length === 0) {
        if (DEBUG_MODE) console.log('[VCP Stream Loop] No tool calls found. Exiting loop.');
        const hasUnclosedToolBlock = !vcpToolUseForbidden &&
          inspectToolBlockClosure(currentExecutionText).hasUnclosed;
        if (!res.writableEnded) {
          const finalFinishReason = hasUnclosedToolBlock ? null : finalUpstreamFinishReason();
          const incompleteToolStatus = hasUnclosedToolBlock ? { code: 'VCP_TOOL_BLOCK_INCOMPLETE' } : null;
          const finalChunkPayload = {
            id: `chatcmpl-VCP-final-${finalFinishReason}-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model,
            choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }],
          };
          if (incompleteToolStatus) finalChunkPayload.vcp_status = incompleteToolStatus;
          try {
            if (hasUnclosedToolBlock) {
              res.write(`data: ${JSON.stringify({
                id: `chatcmpl-VCP-tool-block-incomplete-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: originalBody.model,
                choices: [{ index: 0, delta: { content: '\n\n[模型在工具请求中途停止；该工具没有执行，本次任务尚未完成。请发送“继续”。]' }, finish_reason: null }],
                vcp_status: incompleteToolStatus
              })}\n\n`);
            }
            if (!hasUnclosedToolBlock) writeIncompleteUpstreamNotice();
            res.write(`data: ${JSON.stringify(finalChunkPayload)}\n\n`);
            res.write('data: [DONE]\n\n', () => res.end());
          } catch (writeError) {
            console.error('[VCP Stream Loop] Failed to write final chunk:', writeError.message);
            if (!res.writableEnded && !res.destroyed) try { res.end(); } catch (e) { }
          }
        }
        completed = validUpstreamTurns && !hasUnclosedToolBlock;
        break;
      }

      const expandedCalls = await (toolExecutor.expandCalls?.(toolCalls) ?? toolCalls);
      if (abortController?.signal.aborted || res.destroyed || res.writableEnded) break;
      const { normal: normalCalls, archery: archeryCalls } = ToolCallParser.separate(expandedCalls);
      const archeryReceiptGroups = [];
      const archeryStatusSummaryItems = [];
      const visibleToolResults = [];
      const emitToolBatch = () => {
        if (res.writableEnded || res.destroyed || abortController?.signal.aborted) return;
        const content = formatToolResultBatch(visibleToolResults, enableRoleDivider);
        if (!content) return;
        res.write(`data: ${JSON.stringify({
          id: `chatcmpl-vcp-batch-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: originalBody.model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }]
        })}\n\n`);
      };

      // 执行 Archery 调用
      const archeryLogs = await Promise.all(archeryCalls.map(async (toolCall, index) => {
        try {
          const result = await toolExecutor.execute(toolCall, clientIp, currentMessagesForLoop);
          const isError = !result.success || (result.raw && this.context.isToolResultError(result.raw));

          if (isError) {
            archeryStatusSummaryItems.push(`${toolCall.name} 调用失败${result.recordId ? ` (记录ID: ${result.recordId})` : ''}`);
            archeryReceiptGroups[index] = { name: toolCall.name, callId: toolCall[NATIVE_CALL_ID], parts: [{
              type: 'text',
              text: `[异步工具 "${toolCall.name}" 返回了错误，请注意]:\n${result.content[0].text}`
            }] };
          } else if (result.approvalFeedbackContent?.length) {
            // 用户明确输入的审核留言优先于 archery 静默；只回灌留言，不回灌成功业务输出。
            archeryReceiptGroups[index] = { name: toolCall.name, callId: toolCall[NATIVE_CALL_ID], parts: result.approvalFeedbackContent };
          }

          const forceThisOne = !shouldShowVCP && toolCall.markHistory;
          if ((shouldShowVCP || forceThisOne) && !res.writableEnded && (isError || forceThisOne)) {
            const text = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
            if (text) visibleToolResults.push(text);
          }
          return { tool: toolCall, result: result.content };
        } catch (e) {
          console.error(`[VCP Stream Loop Archery Error] ${toolCall.name}:`, e);
          return { tool: toolCall, result: [{ type: 'text', text: String(e.message) }] };
        }
      }));
      const archeryGroups = archeryReceiptGroups.filter(Boolean);
      const archeryErrorContents = archeryGroups.flatMap(group => group.parts);

      // 处理纯 Archery 的错误或用户审核留言；成功留言不改变工具成功状态。
      if (normalCalls.length === 0 && archeryErrorContents.length > 0) {
        if (nativeTurn) {
          currentMessagesForLoop.push(...buildBoundedNativeReceipts(nativeTurn.calls, archeryGroups, archeryCalls));
          if (rollInjection?.kind && rollInjection.content) currentMessagesForLoop.push({ role: 'system', content: rollInjection.content });
        } else {
          const { content: errorPayload } = await buildToolPayloadMessage(archeryGroups);
          const { truncateToolPayload: truncateErrPayload } = require('../vcpLoop/toolPayloadTruncator.js');
          currentMessagesForLoop.push({ role: 'user', content: truncateErrPayload(errorPayload, {
            toolNames: archeryCalls.map(call => call.name),
            exempt: archeryCalls.some(call => call.markHistory)
          }) });
        }

        if (!res.writableEnded && !res.destroyed) {
          try {
            if (archeryStatusSummaryItems.length > 0) {
              visibleToolResults.push(`\n[本轮工具调用摘要:]\n${archeryStatusSummaryItems.join('；')}。\n[本轮工具调用摘要结束]\n`);
            }
            emitToolBatch();
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-VCP-separator-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: originalBody.model,
              choices: [{ index: 0, delta: { content: '\n' }, finish_reason: null }],
            })}\n\n`);
          } catch (e) { }
        }

        if (this.context.handoffGate?.isReady()) await waitForHandoff();
        throwIfAborted(abortController.signal);
        if (res.writableEnded || res.destroyed) { rollKeeper.reset(); return; }
        const archeryLoopBody = prepareLoopRequest(roundStartIndex);
        if (!archeryLoopBody) { completed = false; break; }
        const nextAiAPIResponse = await fetchWithRetry(
          `${apiUrl}/v1/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              ...openCodeGoSessionHeader,
              Accept: 'text/event-stream',
            },
            body: JSON.stringify(archeryLoopBody),
            signal: abortController.signal,
          },
          { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE, connectionTimeout: apiConnectionTimeoutMs, modelFallbackCandidates: semanticModelFallbackCandidates, phase: 'tool_continuation' }
        );

        await assertResponseOk(nextAiAPIResponse, { phase: 'tool_continuation' }, abortController.signal);
        if (nextAiAPIResponse.ok) {
          let nextAIResponseData = await processAIResponseStreamHelper(nextAiAPIResponse, false);
          lastAIResponseData = nextAIResponseData;
          lastTurnSawNativeToolCall = Boolean(nextAIResponseData.sawNativeToolCall);
          validUpstreamTurns = validUpstreamTurns && nextAIResponseData.completed;
          lastUpstreamFinishReason = nextAIResponseData.finishReason;
          if (nextAIResponseData.streamError) lastUpstreamError = nextAIResponseData.streamError;
          currentAIContentForLoop = nextAIResponseData.content;
          currentExecutionText = nextAIResponseData.executionText;
          protocolHalt = nextAIResponseData.halt;
          if (!protocolHalt && currentAIContentForLoop && currentAIContentForLoop.trim()) {
            oneRingAssistantTurnParts.push(currentAIContentForLoop);
          }
          if (writeChatLog) {
            chatLogs.push({
              request: { messages: currentMessagesForLoop },
              toolCalls: archeryLogs,
              response: nextAIResponseData.message,
            });
          }
          recursionDepth++;
          continue;
        }
        break; // assertResponseOk above rejects unsuccessful continuations.
      }

      if (normalCalls.length === 0) {
        emitToolBatch();
        if (!res.writableEnded && !res.destroyed) {
          try {
            const finalFinishReason = finalUpstreamFinishReason();
            writeIncompleteUpstreamNotice();
            res.write(`data: ${JSON.stringify({
              id: `chatcmpl-VCP-final-${finalFinishReason}-${Date.now()}`,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }],
            })}\n\n`);
            res.write('data: [DONE]\n\n', () => {
              try { res.end(); } catch (e) { }
            });
          } catch (e) { }
        }
        completed = validUpstreamTurns && archeryErrorContents.length === 0;
        break;
      }

      touchRequestActivity?.();
      // 执行普通调用
      const toolResults = await toolExecutor.executeAll(normalCalls, clientIp, currentMessagesForLoop);
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

      // VCP 信息展示 - 批量包裹为单个 USER 角色
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

        if ((shouldShowVCP || forceThisOne) && !res.writableEnded && !res.destroyed) {
          const text = vcpInfoHandler.streamVcpInfo(null, originalBody.model, toolCall.name, result.success ? 'success' : 'error', result.raw || result.error, abortController);
          if (text) visibleToolResults.push(text);
        }
      }

      if (toolStatusSummaryItems.length > 0) {
        visibleToolResults.push(`\n[本轮工具调用摘要:]\n${toolStatusSummaryItems.join('；')}。\n[本轮工具调用摘要结束]\n`);
      }
      if (!res.writableEnded && !res.destroyed) {
        try { emitToolBatch(); } catch (e) {}
      }

      // RAG 刷新
      const toolResultsTextForRAG = JSON.stringify([...toolResults.flatMap(result => result.content), ...archeryErrorContents], (k, v) =>
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
              userText: findLastRealUserMessage(currentMessagesForLoop).rawContent,
              toolResultsText: toolResultsTextForRAG
            });
          }
        } catch { /* Optional receiver initialization cannot stop refresh. */ }
        try {
          currentMessagesForLoop = await _refreshRagBlocksIfNeeded(currentMessagesForLoop, {
            lastAiMessage: currentAIContentForLoop,
            toolResultsText: toolResultsTextForRAG,
            ...(gravityReceiver ? { onGravityVectors: gravityReceiver.accept } : {})
          }, pluginManager, DEBUG_MODE);
        } finally {
          try { gravityHandoff = gravityReceiver ? gravityReceiver.finish() : null; }
          catch { gravityHandoff = null; }
        }
      }

      const modelResultGroups = [
        ...toolResults.map((result, index) => ({
          name: normalCalls[index]?.name,
          callId: normalCalls[index]?.[NATIVE_CALL_ID],
          parts: result.contentForAI ?? result.content
        })),
        ...archeryGroups
      ];
      let payloadForLoop;
      if (nativeTurn) {
        const receipts = buildBoundedNativeReceipts(nativeTurn.calls, modelResultGroups, [...normalCalls, ...archeryCalls]);
        currentMessagesForLoop.push(...receipts);
        if (rollInjection?.kind && rollInjection.content) currentMessagesForLoop.push({ role: 'system', content: rollInjection.content });
        payloadForLoop = receipts.at(-1)?.content ?? '';
      } else {
        const { content } = await buildToolPayloadMessage(modelResultGroups, maybeTranslateToolPayloadMedia);
        const calls = [...normalCalls, ...archeryCalls];
        const { truncateToolPayload } = require('../vcpLoop/toolPayloadTruncator.js');
        payloadForLoop = truncateToolPayload(content, { toolNames: calls.map(c => c.name), exempt: calls.some(c => c.markHistory) });
        currentMessagesForLoop.push({ role: 'user', content: payloadForLoop });
      }

      if (!res.writableEnded && !res.destroyed) {
        try {
          res.write(`data: ${JSON.stringify({
            id: `chatcmpl-VCP-separator-${Date.now()}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: '\n' }, finish_reason: null }],
          })}\n\n`);
        } catch (e) { }
      }

      // 🌟 GravityStub V2：组装期语义引力场可逆投影（纯内存切片，零磁盘污染）
      // GRAVITY_SAFETY_BEGIN
      let messagesForUpstream = currentMessagesForLoop;
      try {
        const { safeGravityProjection } = require('../vcpLoop/safeGravityProjection.js');
        messagesForUpstream = await safeGravityProjection(currentMessagesForLoop, {
          pluginManager, latestPayload: payloadForLoop, recursionDepth,
          gravityHandoff,
          gravityRawToolResults: toolResultsTextForRAG,
          debugMode: DEBUG_MODE, signal: abortController?.signal
        });
      } catch {
        // Even failure to load the safety module must not break tool continuation.
        messagesForUpstream = currentMessagesForLoop;
      }
      // GRAVITY_SAFETY_END

      // Tool execution and projection may yield while the user cancels.
      // Do not invoke another upstream request after cancellation or disconnect.
      if (abortController?.signal.aborted || res.writableEnded || res.destroyed) {
        rollKeeper.reset();
        return;
      }

      if (this.context.handoffGate?.isReady()) await waitForHandoff();
      throwIfAborted(abortController.signal);
      if (res.writableEnded || res.destroyed) { rollKeeper.reset(); return; }

      const loopBody = prepareLoopRequest(roundStartIndex, messagesForUpstream);
      if (!loopBody) { completed = false; break; }
      const nextAiAPIResponse = await fetchWithRetry(
        `${apiUrl}/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...openCodeGoSessionHeader,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify(loopBody),
          signal: abortController.signal,
        },
        { retries: apiRetries, delay: apiRetryDelay, debugMode: DEBUG_MODE, connectionTimeout: apiConnectionTimeoutMs, modelFallbackCandidates: semanticModelFallbackCandidates, phase: 'tool_continuation' }
      );

      await assertResponseOk(nextAiAPIResponse, { phase: 'tool_continuation' }, abortController.signal);

      let nextAIResponseData = await processAIResponseStreamHelper(nextAiAPIResponse, false);
      lastAIResponseData = nextAIResponseData;
      lastTurnSawNativeToolCall = Boolean(nextAIResponseData.sawNativeToolCall);
      validUpstreamTurns = validUpstreamTurns && nextAIResponseData.completed;
      lastUpstreamFinishReason = nextAIResponseData.finishReason;
      if (nextAIResponseData.streamError) lastUpstreamError = nextAIResponseData.streamError;
      currentAIContentForLoop = nextAIResponseData.content;
      currentExecutionText = nextAIResponseData.executionText;
      protocolHalt = nextAIResponseData.halt;
      if (!protocolHalt && currentAIContentForLoop && currentAIContentForLoop.trim()) {
        oneRingAssistantTurnParts.push(currentAIContentForLoop);
      }
      if (writeChatLog) {
        chatLogs.push({
          request: { messages: currentMessagesForLoop },
          toolCalls: [ ...archeryLogs, ...normalCallLogs ],
          response: nextAIResponseData.message,
        });
      }

      recursionDepth++;
    } // toolcall loop end

    // 轮数保真器：循环结束（正常退出 / break / 熔断分支）后释放本次会话状态。
    rollKeeper.reset();

    // ★ 熔断收口前，将尾部未闭合的 VCP 工具块残片从 OneRing 记忆流中剥除，
    //   防止残片进入 Agent 长期记忆并污染未来的 RAG 检索。
    if (!protocolHalt && (stuckHalt || recursionDepth >= maxRecursion) && oneRingAssistantTurnParts.length > 0) {
      try {
        const { sanitizeContent } = require('../vcpLoop/historySanitizer.js');
        const lastIdx = oneRingAssistantTurnParts.length - 1;
        oneRingAssistantTurnParts[lastIdx] = sanitizeContent(oneRingAssistantTurnParts[lastIdx]);
      } catch (sanitizeErr) {
        if (DEBUG_MODE) console.warn('[VCP Stream Loop] Final turn sanitize failed:', sanitizeErr.message);
      }
    }

    if (writeChatLog) writeChatLog(originalBody, chatLogs);
    // OneRing 由主流程在整轮完成且响应发送完成后提交。

    if (protocolHalt && !res.writableEnded && !res.destroyed) {
      completed = false;
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-VCP-protocol-halt-${Date.now()}`,
        object: 'chat.completion.chunk',
        model: originalBody.model,
        choices: [{ index: 0, delta: { content: modelProtocolNotice }, finish_reason: 'stop' }],
        vcp_status: protocolHalt
      })}\n\n`);
      res.write('data: [DONE]\n\n', () => res.end());
    } else if (stuckHalt && !res.writableEnded && !res.destroyed) {
      // 独立暂停原因：同一工具同参数连续失败达到阈值。与 limit 分支互斥，各自只结束一次响应。
      let pendingToolCallsAtStuck = [];
      if (!vcpToolUseForbidden) {
        try {
          pendingToolCallsAtStuck = ToolCallParser.parse(currentExecutionText);
        } catch (parseError) {
          console.error('[VCP Stream Loop] Failed to inspect pending tool calls at stuck halt:', parseError);
        }
      }

      const pendingCountAtStuck = pendingToolCallsAtStuck.length;
      const stuckStatus = {
        code: 'VCP_TOOL_LOOP_STUCK',
        current: recursionDepth,
        max: maxRecursion,
        pendingToolCalls: pendingCountAtStuck,
      };
      const pendingClauseAtStuck = pendingCountAtStuck > 0
        ? '最后生成的 ' + pendingCountAtStuck + ' 个工具请求尚未执行（已如实保留，未派发）。'
        : '停止时没有待执行的工具请求。';
      const stuckNotice = '\n\n> [!WARNING]\n> **VCP 工具循环已硬暂停（同一调用连续失败）**：检测到同一工具以完全相同参数连续失败达到阈值，已停止本轮工具执行以打断重复失败循环。任务尚未完成；' + pendingClauseAtStuck + '请检查阻塞原因（工具参数、权限或上游状态）后发送“继续”恢复。为避免重复副作用，系统不会自动重放。\n';

      try {
        res.write('data: ' + JSON.stringify({
          id: 'chatcmpl-VCP-tool-loop-stuck-notice-' + Date.now(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: originalBody.model,
          choices: [{ index: 0, delta: { content: stuckNotice }, finish_reason: null }],
          vcp_status: stuckStatus,
        }) + '\n\n');

        const stuckFinalChunk = {
          id: 'chatcmpl-VCP-final-stuck-' + Date.now(),
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          vcp_status: stuckStatus,
        };
        res.write('data: ' + JSON.stringify(stuckFinalChunk) + '\n\n');
        res.write('data: [DONE]\n\n', () => {
          try { res.end(); } catch (e) { }
        });
      } catch (e) { }
    } else if (recursionDepth >= maxRecursion && !res.writableEnded && !res.destroyed) {
      let pendingToolCallsAtLimit = [];
      if (!vcpToolUseForbidden) {
        try {
          pendingToolCallsAtLimit = ToolCallParser.parse(currentExecutionText);
        } catch (parseError) {
          console.error('[VCP Stream Loop] Failed to inspect pending tool calls at loop limit:', parseError);
        }
      }

      const hasPendingToolCallsAtLimit = pendingToolCallsAtLimit.length > 0;
      const finalFinishReason = hasPendingToolCallsAtLimit ? 'length' : finalUpstreamFinishReason();
      const status = hasPendingToolCallsAtLimit ? {
        code: 'VCP_TOOL_LOOP_LIMIT',
        current: recursionDepth,
        max: maxRecursion,
        pendingToolCalls: pendingToolCallsAtLimit.length,
      } : null;

      try {
        if (!hasPendingToolCallsAtLimit) writeIncompleteUpstreamNotice();
        if (hasPendingToolCallsAtLimit) {
          const notice = '\n\n> [!WARNING]\n> **VCP 工具循环已暂停**：本轮已达到 ' + maxRecursion + ' 次工具递归上限，最后生成的 ' + pendingToolCallsAtLimit.length + ' 个工具请求尚未执行。任务尚未完成；请发送“继续”恢复。为避免重复副作用，系统不会自动重放。\n';
          const noticePayload = {
            id: 'chatcmpl-VCP-tool-loop-limit-notice-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: originalBody.model,
            choices: [{ index: 0, delta: { content: notice }, finish_reason: null }],
            vcp_status: status,
          };
          res.write('data: ' + JSON.stringify(noticePayload) + '\n\n');
        }

        const finalChunkPayload = {
          id: 'chatcmpl-VCP-final-' + finalFinishReason + '-' + Date.now(),
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: finalFinishReason }],
        };
        if (status) finalChunkPayload.vcp_status = status;
        res.write('data: ' + JSON.stringify(finalChunkPayload) + '\n\n');
        res.write('data: [DONE]\n\n', () => {
          try { res.end(); } catch (e) { }
        });
      } catch (e) { }
    }
    return {
      completed: completed && !abortController?.signal.aborted && !res.destroyed,
      aiText: oneRingAssistantTurnParts.join('\n')
    };
    } finally {
      stopKeepAlive();
      res.off?.('finish', stopKeepAlive);
      res.off?.('close', stopKeepAlive);
    }
  }
}

module.exports = StreamHandler;
