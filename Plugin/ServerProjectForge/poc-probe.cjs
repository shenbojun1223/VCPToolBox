#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function sha256Text(text) {
  return crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
}

function resolveControlFile(explicitPath) {
  const home = os.homedir();
  const candidates = [
    explicitPath,
    process.env.PI_DESKTOP_CONTROL_FILE,
    process.env.PI_DESKTOP_DATA_DIR && path.join(process.env.PI_DESKTOP_DATA_DIR, 'mcp-control.json'),
    home && path.join(home, '.pi-desktop', 'mcp-control.json'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'PI-Desktop-Profiles', 'forge-poc', 'mcp-control.json'),
    'C:\\Users\\Administrator\\.pi-desktop\\mcp-control.json',
    'D:\\VCP\\PI-Desktop-Profiles\\forge-poc\\mcp-control.json',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`mcp-control.json not found. Checked: ${candidates.join(', ')}`);
}

function loadControlInfo(explicitPath) {
  const filePath = resolveControlFile(explicitPath);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const url = raw.url || raw.endpoint || (raw.port ? `http://127.0.0.1:${raw.port}/mcp` : null);
  if (!url || !raw.token) {
    throw new Error(`Invalid mcp-control.json at ${filePath}`);
  }
  return { filePath, url, token: raw.token, pid: raw.pid, active: raw.active, startedAt: raw.startedAt };
}

class McpClient {
  constructor(control) {
    this.url = control.url;
    this.token = control.token;
    this.sessionId = null;
    this.nextId = 1;
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
    };
    if (this.sessionId) {
      headers['Mcp-Session-Id'] = this.sessionId;
    }

    const res = await fetch(this.url, {
      signal: AbortSignal.timeout(30000),
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status} non-JSON response: ${text.slice(0, 300)}`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
    }
    if (json.error) {
      throw new Error(`RPC error (${json.error.code}): ${json.error.message}`);
    }
    return json.result;
  }

  async initialize() {
    return this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vcp-forge-poc-probe-v5', version: '5.0.0' },
    });
  }

  async callTool(name, args = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    if (res && res.isError) {
      throw new Error(`Tool ${name} error: ${JSON.stringify(res.structuredContent || res.content)}`);
    }
    return res ? res.structuredContent : null;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function writeCheckpoint(filePath, data) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeAgentStatus(raw) {
  const status = raw?.status ?? raw;
  if (!status || typeof status.isRunning !== 'boolean') {
    throw new Error('Invalid pi_agent_status response: isRunning must be boolean');
  }
  const pending = status.pendingToolConfirmations ?? 0;
  const count = Array.isArray(pending) ? pending.length : pending;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Invalid pi_agent_status pendingToolConfirmations');
  }
  return { ...status, pendingToolConfirmations: count };
}

function normalizeSession(raw) {
  const session = raw?.session ?? raw;
  if (!session || typeof session !== 'object') {
    throw new Error('Invalid pi_session_get response');
  }
  const messages = raw?.messages ?? session.messages;
  if (!Array.isArray(messages)) {
    throw new Error('Invalid pi_session_get response: messages missing');
  }
  return { session, messages };
}

function verifyPrompt(sessionData, expectedHash) {
  const { messages } = normalizeSession(sessionData);
  const first = messages.find(message => message.role === 'user');
  const text = typeof first?.content === 'string'
    ? first.content
    : Array.isArray(first?.content)
      ? first.content.map(part => part.text || '').join('')
      : '';
  const durablePromptSha256 = text ? sha256Text(text) : null;
  return {
    durablePromptSha256,
    promptHashMatch: Boolean(expectedHash) && durablePromptSha256 === expectedHash,
    messageCount: messages.length,
  };
}

async function runInspect(client, control) {
  const toolsList = await client.request('tools/list', {});
  const appInfo = await client.callTool('pi_app_info', {});
  const health = await client.callTool('pi_desktop_invoke', { operation: 'app/health', args: [] });
  const project = await client.callTool('pi_project_get', {});
  const providers = await client.callTool('pi_desktop_invoke', { operation: 'providers/list', args: [] });
  const settings = await client.callTool('pi_desktop_invoke', { operation: 'settings/get', args: [] });
  const sessionsWrap = await client.callTool('pi_session_list', {});
  const sessions = Array.isArray(sessionsWrap?.sessions) ? sessionsWrap.sessions : [];

  const sessionStatuses = [];
  for (const s of sessions.slice(0, 10)) {
    const st = normalizeAgentStatus(await client.callTool('pi_agent_status', { sessionId: s.id }));
    sessionStatuses.push({
      id: s.id,
      title: s.title,
      projectPath: s.projectPath,
      permissionMode: s.permissionMode,
      modelId: s.modelId,
      status: st,
    });
  }

  return {
    ok: true,
    driverVersion: 'v5',
    control: {
      filePath: control.filePath,
      url: control.url,
      pid: control.pid,
      active: control.active,
      startedAt: control.startedAt,
    },
    toolCount: Array.isArray(toolsList?.tools) ? toolsList.tools.length : 0,
    appInfo,
    health: health?.result,
    project,
    defaultProviderId: settings?.result?.defaultProviderId ?? null,
    defaultModelId: settings?.result?.defaultModelId ?? null,
    providers: (providers?.result?.providers || []).map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      hasSecret: p.hasSecret,
      baseUrl: p.baseUrl,
      defaultModelId: p.defaultModelId,
      modelIds: (p.models || []).map((m) => m.id),
    })),
    sessionCount: sessions.length,
    sessionStatuses,
  };
}

async function runResume(client, checkpointPath) {
  if (!fs.existsSync(checkpointPath)) {
    throw new Error(`Checkpoint file not found: ${checkpointPath}`);
  }
  const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  if (!cp.sessionId) throw new Error(`Checkpoint has no sessionId: ${checkpointPath}`);
  const status = normalizeAgentStatus(await client.callTool('pi_agent_status', { sessionId: cp.sessionId }));
  const sessionData = await client.callTool('pi_session_get', {
    id: cp.sessionId, messageLimit: 50, contentLimit: 50000,
  });
  const verification = verifyPrompt(sessionData, cp.promptSha256);
  cp.lastPolledAt = new Date().toISOString();
  cp.agentStatus = status;
  cp.sessionSnapshot = sessionData;
  Object.assign(cp, verification);
  cp.state = status.pendingToolConfirmations > 0 ? 'blocked_on_confirmation'
    : status.isRunning ? 'running'
      : verification.promptHashMatch ? 'completed' : 'idle_unverified';
  if (cp.state === 'completed') cp.completedAt ??= cp.lastPolledAt;
  writeCheckpoint(checkpointPath, cp);
  return {
    ok: cp.state === 'completed',
    mode: 'resume', state: cp.state, sessionId: cp.sessionId, status, ...verification,
  };
}

async function runDispatch(client, args) {
  const checkpointPath = args.checkpoint;
  if (!checkpointPath) {
    throw new Error('--checkpoint <path> is required for dispatch mode');
  }
  if (fs.existsSync(checkpointPath)) {
    throw new Error(`Checkpoint already exists at ${checkpointPath}; use --resume or a new checkpoint path to avoid duplicate dispatch`);
  }
  const promptFile = args['prompt-file'];
  if (!promptFile || !fs.existsSync(promptFile)) {
    throw new Error('--prompt-file <utf8File> is required and must exist');
  }
  const promptText = fs.readFileSync(promptFile, 'utf8');
  if (!promptText.trim()) {
    throw new Error('Prompt file is empty');
  }
  const promptSha256 = sha256Text(promptText);
  const projectPath = args.project ? path.resolve(args.project) : undefined;
  const timeoutMs = Number(args['timeout-ms'] || 180000);
  const pollMs = Number(args['poll-ms'] || 1500);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error('timeout-ms and poll-ms must be positive finite numbers');
  }

  const cp = {
    driverVersion: 'v5',
    createdAt: new Date().toISOString(),
    projectPath: projectPath || null,
    captureId: args['capture-id'] || null,
    forgeProjectId: args['forge-project-id'] || null,
    promptFile: path.resolve(promptFile),
    promptSha256,
    state: 'initializing',
  };
  writeCheckpoint(checkpointPath, cp);

  if (projectPath) {
    await client.callTool('pi_project_open', { path: projectPath });
  }

  const createPayload = {
    title: args.title || `Forge Worker ${new Date().toISOString()}`,
    mode: 'agent',
    ...(projectPath ? { projectPath } : {}),
    ...(args.provider ? { providerId: args.provider } : {}),
    ...(args.model ? { modelId: args.model } : {}),
  };
  const created = await client.callTool('pi_session_create', createPayload);
  const sessionId = created?.session?.id || created?.id;
  if (!sessionId) {
    cp.state = 'create_failed';
    cp.createResponse = created;
    writeCheckpoint(checkpointPath, cp);
    throw new Error(`pi_session_create did not return session id: ${JSON.stringify(created)}`);
  }

  cp.sessionId = sessionId;
  cp.state = 'created';
  writeCheckpoint(checkpointPath, cp);

  const configured = await client.callTool('pi_session_configure', {
    id: sessionId,
    mode: 'agent',
    permissionMode: 'auto',
    ...(args.provider ? { providerId: args.provider } : {}),
    ...(args.model ? { modelId: args.model } : {}),
    confirm: true,
  });

  const verifyBefore = await client.callTool('pi_session_get', { id: sessionId, messageLimit: 5 });
  const effectivePerm = normalizeSession(verifyBefore).session.permissionMode;
  if (configured?.session?.permissionMode &&
      configured.session.permissionMode !== effectivePerm) {
    throw new Error('Permission configure/readback mismatch');
  }
  if (effectivePerm !== 'auto') {
    cp.state = 'configure_failed';
    cp.configuredResponse = configured;
    writeCheckpoint(checkpointPath, cp);
    throw new Error(`Expected permissionMode=auto, got ${effectivePerm}`);
  }

  cp.state = 'submitting_unknown';
  cp.permissionMode = effectivePerm;
  writeCheckpoint(checkpointPath, cp);

  const promptAck = await client.callTool('pi_agent_prompt', {
    sessionId,
    content: promptText,
  });
  cp.state = 'running';
  cp.promptAck = promptAck;
  writeCheckpoint(checkpointPath, cp);

  const started = Date.now();
  let finalStatus = null;
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    finalStatus = normalizeAgentStatus(await client.callTool('pi_agent_status', { sessionId }));
    const pendingCount = Array.isArray(finalStatus?.pendingToolConfirmations)
      ? finalStatus.pendingToolConfirmations.length
      : Number(finalStatus?.pendingToolConfirmations || 0);
    if (pendingCount > 0) {
      cp.state = 'blocked_on_confirmation';
      cp.agentStatus = finalStatus;
      writeCheckpoint(checkpointPath, cp);
      throw new Error(`Session ${sessionId} has pendingToolConfirmations=${pendingCount}`);
    }
    if (finalStatus && finalStatus.isRunning === false) {
      break;
    }
  }

  const finalSession = await client.callTool('pi_session_get', {
    id: sessionId, messageLimit: 50, contentLimit: 50000,
  });
  const verification = verifyPrompt(finalSession, promptSha256);
  const messages = normalizeSession(finalSession).messages;
  const durableSha256 = verification.durablePromptSha256;

  cp.state = finalStatus?.isRunning === false ? 'completed' : 'timeout';
  cp.completedAt = new Date().toISOString();
  cp.durablePromptSha256 = durableSha256;
  cp.promptHashMatch = durableSha256 === promptSha256;
  cp.agentStatus = finalStatus;
  cp.sessionSnapshot = finalSession;
  writeCheckpoint(checkpointPath, cp);

  return {
    ok: cp.state === 'completed' && cp.promptHashMatch,
    state: cp.state,
    sessionId,
    promptSha256,
    durablePromptSha256: durableSha256,
    promptHashMatch: cp.promptHashMatch,
    messageCount: messages.length,
    agentStatus: finalStatus,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const control = loadControlInfo(args.control);
  const client = new McpClient(control);
  await client.initialize();

  if (args.inspect || (!args.resume && !args.checkpoint)) {
    const res = await runInspect(client, control);
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (args.resume) {
    const res = await runResume(client, args.resume);
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  const res = await runDispatch(client, args);
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exitCode = 1;
}

module.exports = {
  McpClient, loadControlInfo, normalizeAgentStatus, normalizeSession,
  sha256Text, verifyPrompt, runDispatch, runResume,
};
if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
    process.exitCode = 1;
  });
}