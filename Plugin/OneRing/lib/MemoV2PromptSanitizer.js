'use strict';

const REDACTION_PLACEHOLDER = '\\[REDACTED\\]';
const REDACTION_PLACEHOLDER_PATTERN = /\[REDACTED\]/giu;
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

function sanitizeTextDetails(text) {
    const originalText = String(text ?? '');
    if (!hasPromptRedactionPlaceholder(originalText)) {
        return {
            text: originalText,
            originalChars: originalText.length,
            sanitizedChars: originalText.length,
            removedChars: 0,
            placeholderCount: 0
        };
    }
    let placeholderCount = 0;
    let sanitizedText = removeRedactionMatches(originalText, match => {
        placeholderCount += countRedactionPlaceholders(match);
    });
    sanitizedText = normalizeSanitizedWhitespace(sanitizedText);

    if (originalText.length > 0 && sanitizedText.length === 0) {
        throw sanitizationError(
            'MEMO_V2_PROMPT_SANITIZATION_EMPTY',
            'canonical text became empty after prompt sanitization'
        );
    }

    return {
        text: sanitizedText,
        originalChars: originalText.length,
        sanitizedChars: sanitizedText.length,
        removedChars: Math.max(0, originalText.length - sanitizedText.length),
        placeholderCount
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
            strategy: 'remove-canonical-redaction-placeholders',
            originalChars: details.originalChars,
            sanitizedChars: details.sanitizedChars,
            removedChars: details.removedChars,
            placeholderCount: details.placeholderCount
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
