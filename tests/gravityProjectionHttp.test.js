'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { createSoftContextBudget } = require('../modules/softContextBudget');
const { safeGravityProjection } = require('../modules/vcpLoop/safeGravityProjection');

const CALL = 'ISOLATED_FAKE_TOOL_REQUEST';
const ANSWER = 'ISOLATED_CONTINUATION_OK';
const SHADOW_OLD = 'gentle clouds drift across the quiet sky. '.repeat(1000);
const frame = content => 'data: ' + JSON.stringify({
  choices: [{index:0,delta:{content},finish_reason:null}]
}) + '\n\n';

async function listen(server) {
  await new Promise((resolve,reject) => {
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}
function request(url, options = {}) {
  return new Promise((resolve,reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
      agent:false
    }, res => resolve({
      ok:res.statusCode===200,status:res.statusCode,body:res,
      arrayBuffer:async()=>{
        const chunks=[];
        for await (const chunk of res) chunks.push(Buffer.from(chunk));
        const buffer=Buffer.concat(chunks);
        return buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength);
      }
    }));
    req.on('error',reject);
    req.setTimeout(3000,()=>req.destroy(new Error('isolated HTTP timeout')));
    req.end(options.body);
  });
}

// Compile the complete production Handler unchanged, with one dependency seam.
// Parser/executor are explicit fixtures; no production tools, plugins or model API.
function loadHandler(mode, observations, streaming = true) {
  const filename = path.resolve(__dirname,'../modules/handlers/',
    streaming ? 'streamHandler.js' : 'nonStreamHandler.js');
  const instance = new Module(filename,module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = Module.createRequire(filename);
  instance.require = id => {
    if (id === '../vcpLoop/safeGravityProjection.js') {
      observations.guardLoads++;
      if (mode === 'guard-load-failure') throw new Error('injected guard load failure');
      if (mode === 'real-shadow') {
        return {safeGravityProjection: (messages, options) => {
          observations.shadowInput = structuredClone(messages);
          return safeGravityProjection(messages, {
            ...options, enabled:true, shadow:true,
            contextBridge:{
              getEmbeddingFromCache(text) {
                observations.cacheReads = (observations.cacheReads || 0) + 1;
                return text === SHADOW_OLD ? [0,1] : [1,0];
              },
              embedText() { throw new Error('network must not be used'); }
            },
            onGravityReport: report => { observations.shadowReport = report; }
          });
        }};
      }
      return {safeGravityProjection: (messages, options) =>
        safeGravityProjection(messages, {
          ...options, enabled:true, shadow:false, timeoutMs:10,
          loadProjector: () => {
            observations.projectorLoads++;
            if (mode === 'projector-load-failure') throw new Error('injected missing module');
            return copy => {
              if (mode === 'sync-throw') throw new Error('injected sync failure');
              if (mode === 'rejection') return Promise.reject(new Error('injected rejection'));
              if (mode === 'timeout') return new Promise(()=>{});
              return copy;
            };
          }
        })
      };
    }
    return nativeRequire(id);
  };
  instance._compile(fs.readFileSync(filename,'utf8'),filename);
  return instance.exports;
}

async function scenario(mode, abortDuringTool = false, streaming = true) {
  const observed = {tools:0,upstream:0,fetchAttempts:0,guardLoads:0,projectorLoads:0,errors:[]};
  const controller = new AbortController();
  const original = mode === 'real-shadow' ? [
    {role:'system',content:'isolated policy'},
    {role:'assistant',content:SHADOW_OLD,name:'agent'},
    {role:'user',content:'previous request'},
    {role:'assistant',content:'previous answer'},
    {role:'user',content:'isolated goal'}
  ] : [{role:'system',content:'isolated policy'},{role:'user',content:'isolated goal'}];
  const originalSnapshot = JSON.stringify(original);
  const upstream = http.createServer(async (req,res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      observed.upstream++;
      if (mode === 'soft-budget') {
        const notices = parsed.messages.filter(m =>
          typeof m.content === 'string' && m.content.startsWith('[系统上下文预算预警]'));
        assert.equal(notices.length, observed.upstream === 1 ? 1 : 0,
          'advisory belongs only to the initial outbound body, not the tool loop');
        observed.budgetNoticeCounts = [...(observed.budgetNoticeCounts || []), notices.length];
      }
      if (observed.upstream > 1) {
        if (mode === 'real-shadow') {
          assert.deepEqual(parsed.messages, observed.shadowInput,
            'shadow must forward all original messages unchanged');
          assert.equal(parsed.messages[1].content, SHADOW_OLD);
        }
        assert(parsed.messages.some(m => typeof m.content === 'string' && m.content.includes('FAKE_RECEIPT')));
      }
      const content = observed.upstream === 1 ? CALL : ANSWER;
      if (streaming) {
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        res.write(frame(content));
        res.end('data: [DONE]\n\n');
      } else {
        assert.equal(parsed.stream,false);
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({choices:[{
          index:0,message:{role:'assistant',content},finish_reason:'stop'
        }]}));
      }
    } catch (err) {
      observed.errors.push(err.message);
      res.destroy();
    }
  });
  let gateway;
  try {
    const upstreamUrl = await listen(upstream);
    const Handler = loadHandler(mode,observed,streaming);
    gateway = http.createServer(async (req,res) => {
      try {
        res.writeHead(200,{'Content-Type':streaming ? 'text/event-stream' : 'application/json'});
        // Minimal Express send adapter on a real HTTP ServerResponse.
        res.send = data => res.end(data);
        const context = {
          apiUrl:upstreamUrl,apiKey:'isolated-dummy-key',
          originalBody:{model:'isolated-model',messages:original,stream:streaming},
          abortController:controller,
          pluginManager:{messagePreprocessors:new Map()},
          maxVCPLoopStream:3,maxVCPLoopNonStream:3,apiRetries:0,apiRetryDelay:0,
          SHOW_VCP_OUTPUT:false,DEBUG_MODE:false,RAGMemoRefresh:false,
          isToolResultError:()=>false,
          ToolCallParser:{
            parse:text => text.includes(CALL) ? [{name:'FakeTool',arguments:{}}] : [],
            separate:calls=>({normal:calls,archery:[]})
          },
          toolExecutor:{executeAll:async calls=>{
            observed.tools += calls.length;
            if (abortDuringTool) controller.abort();
            return calls.map(()=>({success:true,content:[{type:'text',text:'FAKE_RECEIPT'}]}));
          }},
          fetchWithRetry:async (url,options)=>{
            observed.fetchAttempts++;
            return request(url,options);
          }
        };
        let firstBody = context.originalBody;
        if (mode === 'soft-budget') {
          // Actual production first-send assembly with a synthetic count and
          // process-local identity. No production snapshots, plugins or model API.
          const source = fs.readFileSync(
            path.resolve(__dirname, '../modules/chatCompletionHandler.js'), 'utf8');
          const start = source.indexOf('      const finalUpstreamBody =');
          const end = source.indexOf("      await writeDebugLog('LogOutputAfterProcessing'", start);
          assert(start >= 0 && end > start);
          const sandbox = {
            originalBody: context.originalBody, willStreamResponse: streaming,
            finalContextStore: { setLastFinalContext(body, metadata) {
              observed.snapshotCalls = (observed.snapshotCalls || 0) + 1;
              observed.snapshotBody = structuredClone(body);
              assert.equal(metadata.budgetNoticeExcluded, true);
              return 100000;
            } },
            appendBudgetNotice: createSoftContextBudget(),
            vcpchatExtensions: { schemaVersion: 1, requestContext: {
              ownerType: 'agent', agentId: 'fixture-agent', topicId: 'fixture-budget-topic'
            } },
            req: { body: {} }, clientIp: '', forceShowVCP: false, console
          };
          const previous = process.env.VCP_CONTEXT_SOFT_BUDGET;
          try {
            process.env.VCP_CONTEXT_SOFT_BUDGET = '100000';
            vm.runInNewContext(source.slice(start, end) +
              '\nthis.outgoing = finalUpstreamBody;', sandbox);
          } finally {
            if (previous === undefined) delete process.env.VCP_CONTEXT_SOFT_BUDGET;
            else process.env.VCP_CONTEXT_SOFT_BUDGET = previous;
          }
          firstBody = sandbox.outgoing;
          assert.strictEqual(context.originalBody.messages, original);
          assert.equal(JSON.stringify(context.originalBody.messages), originalSnapshot);
        }
        const first = await request(upstreamUrl+'/v1/chat/completions',{
          method:'POST',body:JSON.stringify(firstBody)
        });
        await new Handler(context).handle(req,res,first);
      } catch (err) {
        observed.errors.push(err.message);
      } finally {
        // Outer transport cleanup, not a fabricated DONE event.
        if (!res.writableEnded) res.end();
      }
    });
    const gatewayUrl = await listen(gateway);
    const client = await request(gatewayUrl);
    let received = '';
    for await (const chunk of client.body) received += chunk;
    assert.equal(JSON.stringify(original),originalSnapshot);
    return {...observed,received};
  } finally {
    if (gateway?.listening) await close(gateway);
    if (upstream.listening) await close(upstream);
  }
}

for (const mode of [
  'success','guard-load-failure','projector-load-failure','sync-throw','rejection','timeout'
]) {
  test('real HTTP + full StreamHandler: '+mode,{timeout:8000},async()=>{
    const result = await scenario(mode);
    assert.deepEqual(result.errors,[]);
    assert.equal(result.tools,1,'tool must not be replayed');
    assert.equal(result.upstream,2);
    assert.equal(result.fetchAttempts,1);
    assert.equal(result.guardLoads,1);
    if (mode !== 'guard-load-failure') assert.equal(result.projectorLoads,1);
    assert(result.received.includes(ANSWER),'post-tool answer must reach client');
    assert.equal((result.received.match(/data: \[DONE\]/g)||[]).length,1);
    const events=result.received.split(/\r?\n/).filter(x=>x.startsWith('data: {'))
      .map(x=>JSON.parse(x.slice(6)));
    assert(events.some(x=>x.choices?.[0]?.finish_reason==='stop'));
  });
}
test('abort during tool must prevent subsequent fetch invocation',{timeout:8000},async()=>{
  const result=await scenario('success',true);
  assert.equal(result.tools,1);
  assert.equal(result.upstream,1);
  assert.equal(result.fetchAttempts,0,'abort must be checked again after tool execution');
  assert(!result.received.includes(ANSWER));
});for (const mode of [
  'success','guard-load-failure','projector-load-failure','sync-throw','rejection','timeout'
]) {
  test('real HTTP + full NonStreamHandler: '+mode,{timeout:8000},async()=>{
    const result=await scenario(mode,false,false);
    assert.deepEqual(result.errors,[]);
    assert.equal(result.tools,1,'tool must not be replayed');
    assert.equal(result.upstream,2);
    assert.equal(result.fetchAttempts,1);
    assert.equal(result.guardLoads,1);
    if (mode!=='guard-load-failure') assert.equal(result.projectorLoads,1);
    const response=JSON.parse(result.received);
    assert(response.choices[0].message.content.includes(ANSWER));
    assert.equal(response.choices[0].finish_reason,'stop');
  });
}
for (const streaming of [true, false]) {
  test('real projector shadow + full HTTP handler: '+(streaming?'stream':'nonstream'),
    {timeout:8000},async()=>{
      const result=await scenario('real-shadow',false,streaming);
      assert.deepEqual(result.errors,[]);
      assert.equal(result.tools,1);
      assert.equal(result.upstream,2);
      assert.equal(result.fetchAttempts,1);
      assert.equal(result.shadowReport.status,'analyzed',JSON.stringify(result.shadowReport));
      assert.equal(result.shadowReport.wouldStub,1);
      assert.equal(result.cacheReads,3);
      assert(result.received.includes(ANSWER));
      if(streaming) assert.equal((result.received.match(/data: \[DONE\]/g)||[]).length,1);
      else assert.equal(JSON.parse(result.received).choices[0].finish_reason,'stop');
    });
}
test('nonstream abort during tool prevents subsequent fetch invocation',{timeout:8000},async()=>{
  const result=await scenario('success',true,false);
  assert.deepEqual(result.errors,[]);
  assert.equal(result.tools,1);
  assert.equal(result.upstream,1);
  assert.equal(result.fetchAttempts,0);
  assert(!result.received.includes(ANSWER));
});for (const streaming of [true, false]) {
  test('soft budget first-send + full HTTP tool loop: ' + (streaming ? 'stream' : 'nonstream'),
    {timeout:8000}, async () => {
      const result = await scenario('soft-budget', false, streaming);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.budgetNoticeCounts, [1, 0]);
      assert.equal(result.snapshotCalls, 1);
      assert(!JSON.stringify(result.snapshotBody).includes('[系统上下文预算预警]'));
      assert.equal(result.tools, 1, 'tool must not be replayed');
      assert.equal(result.upstream, 2);
      assert.equal(result.fetchAttempts, 1);
      assert(result.received.includes(ANSWER), 'continuation must reach client');
      if (streaming) assert.equal((result.received.match(/data: \[DONE\]/g) || []).length, 1);
      else assert.equal(JSON.parse(result.received).choices[0].finish_reason, 'stop');
    });
}