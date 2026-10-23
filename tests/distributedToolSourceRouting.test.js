const test = require('node:test');
const assert = require('node:assert/strict');

const webSocketServer = require('../WebSocketServer');
const pluginManager = require('../Plugin');
const { createDefaultExecutionBridgeRegistry } = require('../modules/pluginBridgeRegistry');

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

test.after(async () => {
  distributedServers.clear();
  // PluginManager constructs an approval-config watcher even without server startup.
  const approval = pluginManager.toolApprovalManager;
  const watcher = approval?.watcher;
  if (watcher) {
    await watcher.close();
    if (approval.watcher === watcher) approval.watcher = null;
  }
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
test('disambiguates shared publicIP when one provider uniquely matches connectionIp', () => {
  addServer('home', { connectionIp: '10.1.0.25', publicIP: '203.0.113.10' });
  // Both providers advertise the request address, but only home connects from it.
  addServer('work', {
    connectionIp: '10.1.0.99',
    publicIP: '203.0.113.10',
    localIPs: ['10.1.0.25']
  });

  const route = webSocketServer.resolveDistributedToolServer(
    'PowerShellExecutor',
    '10.1.0.25'
  );

  assert.equal(route.serverId, 'home');
  assert.equal(route.reason, 'connection_ip');
});

test('routes to explicitTarget by serverId or serverName when multiple providers exist', () => {
  addServer('home', { serverName: 'Home-PC', publicIP: '203.0.113.10' });
  addServer('work', { serverName: 'Work-PC', publicIP: '198.51.100.20' });

  const byName = webSocketServer.resolveDistributedToolServer(
    'PowerShellExecutor',
    '192.0.2.99',
    'home',
    'Work-PC'
  );
  assert.equal(byName.serverId, 'work');
  assert.equal(byName.reason, 'explicit_target');

  const byId = webSocketServer.resolveDistributedToolServer(
    'PowerShellExecutor',
    null,
    'work',
    'home'
  );
  assert.equal(byId.serverId, 'home');
  assert.equal(byId.reason, 'explicit_target');
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

test('execution bridge routes distributed calls using the request source', async () => {
  const routedCalls = [];
  const registry = createDefaultExecutionBridgeRegistry();
  const plugin = { name: 'PowerShellExecutor', isDistributed: true, serverId: 'work' };
  const context = {
    toolName: 'PowerShellExecutor',
    requestIp: '203.0.113.10',
    debugLog() {},
    webSocketServer: {
      resolveDistributedToolServer(toolName, requestIp, preferredServerId) {
        assert.deepEqual([toolName, requestIp, preferredServerId],
          ['PowerShellExecutor', '203.0.113.10', 'work']);
        return { serverId: 'home', reason: 'source_ip' };
      },
      async executeDistributedTool(serverId, toolName, args) {
        routedCalls.push([serverId, toolName, args]);
        return { status: 'success', result: 'ok' };
      }
    }
  };

  const result = await registry.execute(plugin, { command: 'Get-Date' }, context);
  assert.deepEqual(routedCalls, [['home', 'PowerShellExecutor', { command: 'Get-Date' }]]);
  assert.deepEqual(result, { result: { status: 'success', result: 'ok' } });
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

for (const key of ['targetServer', 'target_server', 'targetClient', 'target_client']) {
  test(`execution bridge consumes ${key} without mutating business arguments`, async () => {
    const args = Object.freeze({
      [key]: 'work', command: 'inspect',
      serverId: 'business-id', server_id: 'business-id-2',
      serverName: 'business-name', server_name: 'business-name-2'
    });
    let executions = 0;
    const context = {
      toolName: 'SyntheticTool', requestIp: null, debugLog() {},
      webSocketServer: {
        resolveDistributedToolServer(tool, ip, preferred, explicit) {
          assert.equal(explicit, 'work');
          return { serverId: 'work', reason: 'explicit_target' };
        },
        async executeDistributedTool(server, tool, forwarded) {
          executions++;
          assert.equal(server, 'work');
          assert.notStrictEqual(forwarded, args);
          assert.deepEqual(forwarded, {
            command: 'inspect', serverId: 'business-id', server_id: 'business-id-2',
            serverName: 'business-name', server_name: 'business-name-2'
          });
          return 'ok';
        }
      }
    };
    const result = await createDefaultExecutionBridgeRegistry().execute(
      { isDistributed: true, serverId: 'home' }, args, context
    );
    assert.equal(args[key], 'work');
    assert.equal(executions, 1);
    assert.deepEqual(result, { result: 'ok' });
  });
}

test('business server fields do not select the execution device', async () => {
  const args = Object.freeze({
    serverId: 'data-store', server_id: 'data-store-2',
    serverName: 'database', server_name: 'database-2'
  });
  let executed = false;
  await createDefaultExecutionBridgeRegistry().execute(
    { isDistributed: true, serverId: 'home' }, args, {
      toolName: 'SyntheticTool', requestIp: null, debugLog() {},
      webSocketServer: {
        resolveDistributedToolServer(tool, ip, preferred, explicit) {
          assert.equal(explicit, null);
          return { serverId: 'home' };
        },
        async executeDistributedTool(server, tool, forwarded) {
          executed = true;
          assert.equal(server, 'home');
          assert.deepEqual(forwarded, args);
          return 'ok';
        }
      }
    }
  );
  assert.equal(executed, true);
});

test('array arguments are passed through without routing-field interpretation', async () => {
  const args = Object.assign(['value'], { targetServer: 'not-a-routing-object' });
  Object.freeze(args);
  await createDefaultExecutionBridgeRegistry().execute(
    { isDistributed: true, serverId: 'home' }, args, {
      toolName: 'SyntheticTool', requestIp: null, debugLog() {},
      webSocketServer: {
        resolveDistributedToolServer(tool, ip, preferred, explicit) {
          assert.equal(explicit, null);
          return { serverId: 'home' };
        },
        async executeDistributedTool(server, tool, forwarded) {
          assert.strictEqual(forwarded, args);
          assert.equal(args.targetServer, 'not-a-routing-object');
          return 'ok';
        }
      }
    }
  );
});

test('unknown explicit target refuses fallback even with a sole provider', () => {
  addServer('home', { serverName: 'Home-PC' });
  assert.throws(
    () => webSocketServer.resolveDistributedToolServer('PowerShellExecutor', null, 'home', 'missing'),
    /DISTRIBUTED_TOOL_TARGET_NOT_FOUND/
  );
});

test('duplicate explicit server names fail closed while exact IDs remain usable', () => {
  addServer('home', { serverName: 'Same-PC' });
  addServer('work', { serverName: 'Same-PC' });
  assert.throws(
    () => webSocketServer.resolveDistributedToolServer('PowerShellExecutor', null, 'home', 'Same-PC'),
    /DISTRIBUTED_TOOL_TARGET_AMBIGUOUS/
  );
  assert.equal(
    webSocketServer.resolveDistributedToolServer('PowerShellExecutor', null, 'home', 'work').serverId,
    'work'
  );
});
