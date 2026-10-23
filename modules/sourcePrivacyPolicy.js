'use strict';

const CLAUDE_BACKEND_MODEL = 'claude-vcp-sonnet';
const CLAUDE_BASE_MODELS = Object.freeze([
    'claude-vcp-sonnet',
    'claude-vcp-opus',
    'claude-vcp-haiku',
    'claude-vcp-opusplan'
]);
const CLAUDE_EFFORT_LEVELS = Object.freeze([
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
]);
const CLAUDE_BACKEND_MODELS = Object.freeze(
    CLAUDE_BASE_MODELS.flatMap(base => [
        base,
        ...CLAUDE_EFFORT_LEVELS.map(level => `${base}-${level}`)
    ])
);

class SourcePrivacyFallbackError extends Error {
    constructor() {
        super('Claude source privacy policy cannot span mixed fallback model domains.');
        this.name = 'SourcePrivacyFallbackError';
        this.code = 'source_privacy_mixed_fallback';
        this.status = 400;
    }
}

class SourcePrivacyProcessingError extends Error {
    constructor() {
        super('Claude source privacy preprocessing did not complete.');
        this.name = 'SourcePrivacyProcessingError';
        this.code = 'source_privacy_processing_failed';
        this.status = 500;
    }
}

function isClaudeBackendModel(model) {
    return typeof model === 'string' && CLAUDE_BACKEND_MODELS.includes(model);
}

function createRequestSourcePrivacyPolicy(backendModel, fallbackCandidates) {
    const candidates = [backendModel];
    if (Array.isArray(fallbackCandidates)) candidates.push(...fallbackCandidates);
    const domains = new Set(candidates.filter(model => typeof model === 'string' && model.length > 0)
        .map(model => isClaudeBackendModel(model) ? 'claude' : 'other'));

    if (domains.size > 1) throw new SourcePrivacyFallbackError();

    return {
        backendModel: typeof backendModel === 'string' ? backendModel : null,
        enabled: isClaudeBackendModel(backendModel),
        state: { oneRing: 'not_run' }
    };
}

function isClaudeSourcePrivacyEnabled(context) {
    const policy = context && context.sourcePrivacyPolicy;
    return !!policy && policy.enabled === true && isClaudeBackendModel(policy.backendModel);
}

module.exports = {
    CLAUDE_BACKEND_MODEL,
    CLAUDE_BACKEND_MODELS,
    SourcePrivacyFallbackError,
    SourcePrivacyProcessingError,
    isClaudeBackendModel,
    createRequestSourcePrivacyPolicy,
    isClaudeSourcePrivacyEnabled
};