'use strict';

const { hasUnsafeText } = require('./MemoV2Reducer.js');

const DEFAULT_CHAR_BUDGET = 12000;

function rendererError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function factDate(fact) {
    const value = String(fact?.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw rendererError('MEMO_V2_RENDER_INVALID_DATE', 'timeline fact date is invalid');
    return value;
}

function safeOutputText(value, field) {
    if (typeof value !== 'string' || !value.trim() || hasUnsafeText(value)) {
        throw rendererError('MEMO_V2_RENDER_UNSAFE_OUTPUT', `${field} contains unsafe output`);
    }
    return value.trim();
}

function factBlock(fact) {
    return `${factDate(fact)}\n- ${safeOutputText(fact.text, 'fact.text')}`;
}

function threadBlock(thread) {
    const task = safeOutputText(thread.task, 'thread.task');
    const status = String(thread.status || '');
    if (!['open', 'in_progress', 'blocked'].includes(status)) {
        throw rendererError('MEMO_V2_RENDER_INVALID_THREAD', 'only active thread statuses may be rendered');
    }
    const constraints = Array.isArray(thread.constraints)
        ? thread.constraints.map(value => safeOutputText(String(value), 'thread.constraint')).filter(Boolean)
        : [];
    const suffix = constraints.length ? `（约束：${constraints.join('、')}）` : '';
    return `- [${status}] ${task}${suffix}`;
}

function validateRenderedText(text) {
    if (hasUnsafeText(text) || /<[^>]{1,500}>/u.test(text)) {
        throw rendererError('MEMO_V2_RENDER_UNSAFE_OUTPUT', 'rendered memo contains unsafe output');
    }
    if (/<<<\[TOOL_REQUEST\]>>>|\[\[VCP|VCP_RAG_BLOCK/iu.test(text)) {
        throw rendererError('MEMO_V2_RENDER_PROTOCOL_OUTPUT', 'rendered memo contains VCP protocol');
    }
    return text;
}

function renderMemo(state, options = {}) {
    if (!state || typeof state !== 'object') throw rendererError('MEMO_V2_INVALID_STATE', 'state is required');
    const budget = Number(options.charBudget ?? DEFAULT_CHAR_BUDGET);
    if (!Number.isSafeInteger(budget) || budget < 1) {
        throw rendererError('MEMO_V2_RENDER_BUDGET_INVALID', 'renderer budget must be a positive integer');
    }
    const facts = (Array.isArray(state.timeline) ? state.timeline : [])
        .map((fact, index) => ({ fact, index, block: factBlock(fact) }))
        .sort((left, right) => factDate(left.fact).localeCompare(factDate(right.fact))
            || left.index - right.index
            || String(left.fact.factId || '').localeCompare(String(right.fact.factId || '')));
    const threads = (Array.isArray(state.activeThreads) ? state.activeThreads : [])
        .map((thread, index) => ({ thread, index, block: threadBlock(thread) }))
        .sort((left, right) => left.index - right.index || String(left.thread.threadId || '').localeCompare(String(right.thread.threadId || '')));

    const selectedThreads = [];
    let threadChars = 0;
    for (const item of threads) {
        const extra = (selectedThreads.length ? 1 : 0) + item.block.length;
        if (threadChars + extra <= budget) {
            selectedThreads.push(item);
            threadChars += extra;
        }
    }

    const recentFirst = [...facts].sort((left, right) => factDate(right.fact).localeCompare(factDate(left.fact))
        || (Array.isArray(right.fact.sourceMessageIds) ? right.fact.sourceMessageIds.length : 0)
            - (Array.isArray(left.fact.sourceMessageIds) ? left.fact.sourceMessageIds.length : 0)
        || left.index - right.index);
    const selectedFacts = [];
    let factChars = 0;
    const threadSection = selectedThreads.length ? `未闭环任务\n${selectedThreads.map(item => item.block).join('\n')}` : '';
    const taskPrefix = threadSection ? `${threadSection}\n\n` : '';
    const factBudget = Math.max(0, budget - taskPrefix.length);
    for (const item of recentFirst) {
        const extra = (selectedFacts.length ? 2 : 0) + item.block.length;
        if (factChars + extra <= factBudget) {
            selectedFacts.push(item);
            factChars += extra;
        }
    }
    selectedFacts.sort((left, right) => factDate(left.fact).localeCompare(factDate(right.fact))
        || left.index - right.index
        || String(left.fact.factId || '').localeCompare(String(right.fact.factId || '')));

    const timelineText = selectedFacts.map(item => item.block).join('\n\n');
    const text = validateRenderedText([timelineText, threadSection].filter(Boolean).join('\n\n'));
    if (text.length > budget) throw rendererError('MEMO_V2_RENDER_BUDGET_EXCEEDED', 'renderer produced text over budget');
    return {
        text,
        stats: {
            charBudget: budget,
            chars: text.length,
            includedFacts: selectedFacts.length,
            droppedFacts: facts.length - selectedFacts.length,
            includedThreads: selectedThreads.length,
            droppedThreads: threads.length - selectedThreads.length
        }
    };
}

module.exports = {
    DEFAULT_CHAR_BUDGET,
    renderMemo,
    validateRenderedText
};
