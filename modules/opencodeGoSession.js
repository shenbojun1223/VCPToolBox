const crypto = require('crypto');

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;

function resolveOpenCodeGoSession(req, secret) {
  const headers = req?.headers || {};
  const suppliedHeader = headers['x-opencode-session'];
  if (typeof suppliedHeader === 'string' && SESSION_ID_PATTERN.test(suppliedHeader)) {
    return suppliedHeader;
  }

  const body = req?.body || {};
  const explicitId = [body.conversationId, body.conversation_id, body.sessionId, body.session_id]
    .find(value => typeof value === 'string' && value.trim());
  const firstUserMessage = Array.isArray(body.messages)
    ? body.messages.find(message => message?.role === 'user')
    : null;
  const fallbackMessage = Array.isArray(body.messages) ? body.messages[0] : null;
  const conversationSeed = explicitId
    ? ['client-id', explicitId]
    : firstUserMessage
      ? ['first-user', firstUserMessage.content]
      : fallbackMessage
        ? ['first-message', fallbackMessage.role, fallbackMessage.content]
        : ['request', body.requestId || body.messageId || crypto.randomUUID()];

  const digest = crypto.createHmac('sha256', String(secret || 'vcp-opencode-go'))
    .update(JSON.stringify([headers.authorization || req?.ip || '', conversationSeed]))
    .digest('hex');
  return `vcp_${digest.slice(0, 32)}`;
}

module.exports = { resolveOpenCodeGoSession };
