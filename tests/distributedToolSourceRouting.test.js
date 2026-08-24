const test = require('node:test');
const assert = require('node:assert/strict');

const webSocketServer = require('../WebSocketServer');
const pluginManager = require('../Plugin');

const { distributedServers } = webSocketServer.__testing;

function addServer(serverId, {
  serverName = serverId,
  connectionIp,
  publicIP,
  localIPs = [],
  tools = ['PowerShellExecutor'],
  connected = true
} = {}) {
  distributedServers.set(serverId, {
    ws: {
      readyState: connected ? 1 : 3,
      clientId: serverId + '-client',
      clientIp: connectionIp || null
    },
    serverName,
    tools,
    capabilities: {},
    ips: { publicIP: publicIP || null, localIPs },
    connectedAt: null,
    lastSeenAt: null
  });
}

test.beforeEach(() => {
  distributedServers.clear();
});

test.after(() => {
  distributedServers.clear();
});

test('routes a duplicated tool to the unique provider matching request source IP', () => {
  addServer('home', {
    serverName: 'Home-PC',
    connectionIp: '203.0.113.10',
    publicIP: '203.0.113.10'
  });
  addServer('work', {
    serverName: 'Work-PC',
    connectionIp: '198.51.100.20',
    publicIP: '198.51.100.20'
  });

  const route = webSocketServer.resolveDistributedToolServer(
    'PowerShellExecutor',
    '::ffff:203.0.113.10',
    'work'
  );

  assert.equal(route.serverId, 'home');
  assert.equal(route.reason, 'source_ip');
});

test('fails closed when multiple providers exist and source cannot be matched', () => {
  addServer('home', { publicIP: '203.0.113.10' });
  addServer('work', { publicIP: '198.51.100.20' });

  assert.throws(
    () => webSocketServer.resolveDistributedToolServer(
      'PowerShellExecutor',
      '192.0.2.99',
      'work'
    ),
    /DISTRIBUTED_TOOL_TARGET_AMBIGUOUS/
  );
});

test('fails closed when multiple providers share the same visible source IP', () => {
  addServer('home', { publicIP: '203.0.113.10' });
  addServer('work', { publicIP: '203.0.113.10' });

  assert.throws(
    () => webSocketServer.resolveDistributedToolServer(
      'PowerShellExecutor',
      '203.0.113.10'
    ),
    /DISTRIBUTED_TOOL_TARGET_AMBIGUOUS/
  );
});

test('uses a sole online provider when no source match is available', () => {
  addServer('work', { publicIP: '198.51.100.20' });

  const route = webSocketServer.resolveDistributedToolServer(
    'PowerShellExecutor',
    null
  );

  assert.equal(route.serverId, 'work');
  assert.equal(route.reason, 'sole_provider');
});

test('PluginManager keeps duplicate providers and fails over the logical manifest', () => {
  const originalBuild = pluginManager.buildVCPDescription;
  const originalWebSocketServer = pluginManager.webSocketServer;

  pluginManager.plugins.clear();
  pluginManager.distributedToolProviders.clear();
  pluginManager.buildVCPDescription = () => {};
  pluginManager.webSocketServer = {
    getDistributedServerSnapshot() {
      return [
        { serverId: 'home', connected: false, tools: ['PowerShellExecutor'] },
        { serverId: 'work', connected: true, tools: ['PowerShellExecutor'] }
      ];
    }
  };

  const manifest = {
    name: 'PowerShellExecutor',
    displayName: 'PowerShell Executor',
    pluginType: 'synchronous',
    entryPoint: { type: 'nodejs', command: 'node index.js' }
  };

  try {
    pluginManager.registerDistributedTools('home', [{ ...manifest }]);
    pluginManager.registerDistributedTools('work', [{ ...manifest }]);

    assert.deepEqual(
      Array.from(pluginManager.distributedToolProviders.get('PowerShellExecutor').keys()),
      ['home', 'work']
    );
    assert.equal(pluginManager.getPlugin('PowerShellExecutor').serverId, 'home');

    pluginManager.unregisterAllDistributedTools('home');

    assert.equal(pluginManager.getPlugin('PowerShellExecutor').serverId, 'work');
    assert.deepEqual(
      pluginManager.getPlugin('PowerShellExecutor').providerServerIds,
      ['work']
    );
  } finally {
    pluginManager.plugins.clear();
    pluginManager.distributedToolProviders.clear();
    pluginManager.buildVCPDescription = originalBuild;
    pluginManager.webSocketServer = originalWebSocketServer;
  }
});
