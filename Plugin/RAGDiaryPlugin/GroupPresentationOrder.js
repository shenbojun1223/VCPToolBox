'use strict';

const crypto = require('crypto');
const formatter = require('./RAGResultFormatter');

function identity(result) {
    const path = String(result._expandedFilePath || result.fullPath || result.sourceFile || result.path || '').replace(/\\/g, '/');
    if (result._expanded) return path ? JSON.stringify(['document', path]) : null;
    if (result.chunkId !== undefined && result.chunkId !== null && String(result.chunkId) !== '') {
        return JSON.stringify(['chunk', path, String(result.chunkId)]);
    }
    // Without a stable chunk id, changed text is deliberately treated as a new entry.
    return path && typeof result.text === 'string'
        ? JSON.stringify(['text', path, crypto.createHash('sha256').update(result.text).digest('hex')])
        : null;
}

class GroupPresentationOrder {
    constructor(limit = 256) {
        // Startup-only switch. Unset defaults to enabled; explicit false disables.
        this.enabled = String(process.env.RAG_GROUP_PRESENTATION_ORDER_ENABLED ?? 'true')
            .trim().toLowerCase() !== 'false';
        this.limit = limit;
        this.states = new Map();
        this.sequence = 0;
    }

    begin(context) {
        if (!this.enabled) return null;
        if (!context || context.ownerType !== 'agent' || context.isGroupMessage === true) return null;
        const agent = typeof context.agentId === 'string' ? context.agentId.trim() : '';
        const topic = typeof context.topicId === 'string' ? context.topicId.trim() : '';
        if (!agent || !topic || agent.length > 256 || topic.length > 256) return null;
        return { scope: JSON.stringify(['agent', agent, topic]), sequence: ++this.sequence };
    }

    capture(results, displayName, activatedGroups, metadata) {
        if (!this.enabled) return null;
        return {
            results: (results || []).map(r => ({
                chunkId: r.chunkId, text: r.text, fullPath: r.fullPath,
                sourceFile: r.sourceFile, path: r.path,
                _expanded: r._expanded, _expandedFilePath: r._expandedFilePath
            })),
            displayName,
            activatedGroups: new Map(Array.from(activatedGroups || [], ([name, data]) => [
                name, { strength: data.strength, matchedWords: [...data.matchedWords] }
            ])),
            metadata: { ...metadata }
        };
    }

    render(content, presentation, request) {
        if (!this.enabled || !presentation || !request) return content;
        const { results, metadata } = presentation;
        const ids = results.map(identity);
        // Ambiguous identities must not merge chunks or disturb their original order.
        if (ids.some(id => !id) || new Set(ids).size !== ids.length) return content;
        const key = JSON.stringify([
            request.scope, request.carrier ?? 0, metadata.dbName,
            metadata.modifiers, metadata.engine
        ]);
        const previous = this.states.get(key);
        // An older in-flight request cannot overwrite a newer request's baseline.
        if (previous && previous.sequence > request.sequence) return content;
        const current = new Map(ids.map((id, index) => [id, results[index]]));
        const retained = previous ? previous.ids.filter(id => current.has(id)) : [];
        const retainedSet = new Set(retained);
        const orderedIds = [...retained, ...ids.filter(id => !retainedSet.has(id))];
        const rendered = content === '' ? '' : formatter.formatGroupRAGResults(
            orderedIds.map(id => current.get(id)),
            presentation.displayName, presentation.activatedGroups, metadata
        );
        this.states.delete(key);
        this.states.set(key, { sequence: request.sequence, ids: orderedIds });
        while (this.states.size > this.limit) this.states.delete(this.states.keys().next().value);
        return rendered;
    }
}

module.exports = GroupPresentationOrder;