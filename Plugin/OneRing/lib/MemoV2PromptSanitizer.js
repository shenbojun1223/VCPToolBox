'use strict';

const {
    NEW_THREAD_WIRE_TOKEN,
    NO_ASSIGNEE_WIRE_TOKEN
} = require('./MemoV2WireTokens.js');

const REDACTION_PLACEHOLDER = '\\[REDACTED\\]';
const REDACTION_PLACEHOLDER_PATTERN = /\[REDACTED\]/giu;
const NEW_THREAD_ARCHIVE_LABEL = '新线程归档';
const NO_ASSIGNEE_ARCHIVE_LABEL = '未指定负责人';
const WRAPPER_CHARS = `"'“”‘’「」『』（()）【】〔〕［］《》<>`;
const WRAPPED_REDACTION_SOURCE = `(?:[${WRAPPER_CHARS}])*[^\\S\\r\\n]*${REDACTION_PLACEHOLDER}[^\\S\\r\\n]*(?:[${WRAPPER_CHARS}])*`;
const ENGLISH_CREDENTIAL_PLACEHOLDER_PATTERN = new RegExp(
    `\\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|authorization)\\b\\s*(?:=|:|：)?\\s*(?:bearer\\s+)?${WRAPPED_REDACTION_SOURCE}`,
    'giu'
);
const CHINESE_CREDENTIAL_PLACEHOLDER_PATTERN = new RegExp(
    `(?:管理员密码|访问密码|工具密码|验证码|授权码|密码)\\s*(?:为|是|=|:|：)?\\s*(?:bearer\\s+)?${WRAPPED_REDACTION_SOURCE}`,
    'gu'
);
const BEARER_PLACEHOLDER_PATTERN = new RegExp(`\\bBearer\\s+${WRAPPED_REDACTION_SOURCE}`, 'giu');
const INDEPENDENT_PLACEHOLDER_PATTERN = new RegExp(WRAPPED_REDACTION_SOURCE, 'giu');
const REDACTION_PATTERNS = [
    ENGLISH_CREDENTIAL_PLACEHOLDER_PATTERN,
    CHINESE_CREDENTIAL_PLACEHOLDER_PATTERN,
    BEARER_PLACEHOLDER_PATTERN,
    INDEPENDENT_PLACEHOLDER_PATTERN
];

function sanitizationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value && typeof value === 'object') {
        const clone = {};
        for (const [key, child] of Object.entries(value)) clone[key] = cloneValue(child);
        return clone;
    }
    return value;
}

function countRedactionPlaceholders(value) {
    REDACTION_PLACEHOLDER_PATTERN.lastIndex = 0;
    const count = (String(value).match(REDACTION_PLACEHOLDER_PATTERN) || []).length;
    REDACTION_PLACEHOLDER_PATTERN.lastIndex = 0;
    return count;
}

function removeRedactionMatches(text, onMatch = () => {}) {
    let result = String(text ?? '');
    for (const pattern of REDACTION_PATTERNS) {
        pattern.lastIndex = 0;
        result = result.replace(pattern, match => {
            onMatch(match);
            return ' ';
        });
        pattern.lastIndex = 0;
    }
    return result;
}

function normalizeSanitizedWhitespace(text) {
    return text
        .replace(/\r\n?/gu, '\n')
        .replace(/[^\S\r\n]+/gu, ' ')
        .replace(/[^\S\r\n]*\n[^\S\r\n]*/gu, '\n')
        .replace(/[^\S\r\n]+([,.;:!?，。！？；：、）】》」』〕］〉》])/gu, '$1')
        .replace(/\n{3,}/gu, '\n\n')
        .replace(/[^\S\r\n]+$/gmu, '')
        .trim();
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function countWireTokenOccurrences(text, token) {
    const pattern = new RegExp(escapeRegExp(token), 'gu');
    return (String(text).match(pattern) || []).length;
}

function replaceWireTokens(text) {
    const originalText = String(text ?? '');
    const newThreadTokenCount = countWireTokenOccurrences(originalText, NEW_THREAD_WIRE_TOKEN);
    const noAssigneeTokenCount = countWireTokenOccurrences(originalText, NO_ASSIGNEE_WIRE_TOKEN);
    const replacedText = originalText
        .replace(new RegExp(escapeRegExp(NEW_THREAD_WIRE_TOKEN), 'gu'), NEW_THREAD_ARCHIVE_LABEL)
        .replace(new RegExp(escapeRegExp(NO_ASSIGNEE_WIRE_TOKEN), 'gu'), NO_ASSIGNEE_ARCHIVE_LABEL);
    return {
        text: replacedText,
        wireTokenCount: newThreadTokenCount + noAssigneeTokenCount,
        newThreadTokenCount,
        noAssigneeTokenCount
    };
}

function sanitizeTextDetails(text) {
    const originalText = String(text ?? '');
    let placeholderCount = 0;
    let sanitizedText = originalText;
    if (hasPromptRedactionPlaceholder(originalText)) {
        sanitizedText = removeRedactionMatches(originalText, match => {
            placeholderCount += countRedactionPlaceholders(match);
        });
        sanitizedText = normalizeSanitizedWhitespace(sanitizedText);
    }

    if (originalText.length > 0 && sanitizedText.length === 0) {
        throw sanitizationError(
            'MEMO_V2_PROMPT_SANITIZATION_EMPTY',
            'canonical text became empty after prompt sanitization'
        );
    }

    const wireDetails = replaceWireTokens(sanitizedText);
    sanitizedText = wireDetails.text;
    return {
        text: sanitizedText,
        originalChars: originalText.length,
        sanitizedChars: sanitizedText.length,
        removedChars: Math.max(0, originalText.length - sanitizedText.length),
        placeholderCount,
        wireTokenCount: wireDetails.wireTokenCount,
        newThreadTokenCount: wireDetails.newThreadTokenCount,
        noAssigneeTokenCount: wireDetails.noAssigneeTokenCount
    };
}

function stripCanonicalRedactionPlaceholdersForSafety(text) {
    return removeRedactionMatches(text);
}

function sanitizeCanonicalTextForPrompt(text) {
    return sanitizeTextDetails(text).text;
}

function sanitizeCanonicalEventForPrompt(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw sanitizationError('MEMO_V2_PROMPT_SANITIZATION_EVENT_INVALID', 'canonical event must be an object');
    }
    const clone = cloneValue(event);
    delete clone.promptSanitization;
    const details = sanitizeTextDetails(event.text);
    clone.text = details.text;
    if (details.text !== String(event.text ?? '')) {
        clone.promptSanitization = {
            applied: true,
            strategy: details.wireTokenCount > 0
                ? (details.placeholderCount > 0
                    ? 'remove-canonical-redaction-placeholders-and-replace-wire-tokens'
                    : 'replace-canonical-wire-tokens')
                : 'remove-canonical-redaction-placeholders',
            originalChars: details.originalChars,
            sanitizedChars: details.sanitizedChars,
            removedChars: details.removedChars,
            placeholderCount: details.placeholderCount,
            wireTokenCount: details.wireTokenCount,
            newThreadTokenCount: details.newThreadTokenCount,
            noAssigneeTokenCount: details.noAssigneeTokenCount
        };
    }
    return clone;
}

function hasPromptRedactionPlaceholder(value) {
    if (typeof value === 'string') {
        REDACTION_PLACEHOLDER_PATTERN.lastIndex = 0;
        const found = REDACTION_PLACEHOLDER_PATTERN.test(value);
        REDACTION_PLACEHOLDER_PATTERN.lastIndex = 0;
        return found;
    }
    if (Array.isArray(value)) return value.some(hasPromptRedactionPlaceholder);
    if (value && typeof value === 'object') return Object.values(value).some(hasPromptRedactionPlaceholder);
    return false;
}

module.exports = {
    REDACTION_PLACEHOLDER_PATTERN,
    sanitizeCanonicalTextForPrompt,
    sanitizeCanonicalEventForPrompt,
    stripCanonicalRedactionPlaceholdersForSafety,
    hasPromptRedactionPlaceholder
};
