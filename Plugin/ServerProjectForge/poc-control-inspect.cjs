'use strict';
const { McpClient, loadControlInfo, normalizeSession } = require('./poc-probe.cjs');

async function main() {
  const client = new McpClient(loadControlInfo());
  await client.initialize();
  const list = await client.request('tools/list', {});
  const names = ['pi_agent_status', 'pi_session_get', 'pi_session_create',
    'pi_session_configure', 'pi_agent_prompt', 'pi_project_open'];
  console.log(JSON.stringify({ schemas: list.tools.filter(tool => names.includes(tool.name)) }, null, 2));
  const sessions = await client.callTool('pi_session_list', {});
  const id = sessions?.sessions?.[0]?.id;
  if (!id) return;
  const data = await client.callTool('pi_session_get', { id, messageLimit: 1 });
  const normalized = normalizeSession(data);
  console.log(JSON.stringify({
    id, getKeys: Object.keys(data || {}),
    sessionKeys: Object.keys(normalized.session),
    messageCount: normalized.messages.length,
  }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });