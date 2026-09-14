'use strict';
// One bounded offline experiment. Default is planning only; --send opts in.
// Same configured embedding endpoint/model, but no fallback, retry or redirects.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname,'..');
const config = {...require('dotenv').parse(fs.readFileSync(path.join(root,'config.env'))),
  ...process.env};
const hash = text => createHash('sha256').update(text).digest('hex');
const sourcePath = path.join(root,
  'DebugLog/chat/2026-09-08/chat-msg_1788836272272_assistant_3y6x2pe-110604_302-6b7a.json');
const source = fs.readFileSync(sourcePath);
const rounds = JSON.parse(source);
const marker = '<!-- VCP_TOOL_PAYLOAD -->';
const encoding = require('@dqbd/tiktoken').get_encoding('cl100k_base');
const configuredLimit = Math.floor((Number(config.WhitelistEmbeddingModelMaxToken)||8000)*0.85);
const tokenLimit = Math.min(4000,configuredLimit);
assert(tokenLimit >= 32);
const tokens = text => encoding.encode(text,[],[]).length;
const outDir = path.join(root,'scripts','gravity-real-selection-20260908');
const plan = [], seen = new Map();
let segments = 0, chars = 0, stopped = null;
// Split on Unicode character boundaries. Never decode token IDs as UTF-8 bytes.
// No overlap; concatenated chunks must equal the entire input.
function split(text) {
  if(tokens(text) <= tokenLimit) return [text];
  const points = Array.from(text), mid = Math.floor(points.length/2);
  assert(mid > 0);
  return [...split(points.slice(0,mid).join('')),
    ...split(points.slice(mid).join(''))];
}
function assertPrivateSafe(text) {
  for(const secret of [config.API_Key])
    if(secret && secret.length >= 8 && text.includes(secret))
      throw Error('INPUT_CONTAINS_CONFIGURED_SECRET');
  if(/(?:Bearer\s+[A-Za-z0-9._-]{20,}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})/.test(text))
    throw Error('INPUT_POSSIBLE_SECRET');
}
outer: for(let r=0;r<rounds.length;r++) {
  const messages = rounds[r].request.messages;
  for(let i=0;i<messages.length;i++) {
    const m = messages[i];
    if(m.role !== 'user' || typeof m.content !== 'string') continue;
    if(seen.has(i)) {
      assert.equal(hash(m.content),seen.get(i),'Historical input drift');
      continue;
    }
    seen.set(i,hash(m.content));
    let kind = 'goal', text = m.content, raw = null;
    if(text.startsWith(marker)) {
      kind = 'receipt';
      raw = text.slice(marker.length).trim();
      let parts;
      try { parts = JSON.parse(raw); } catch { continue; }
      if(!Array.isArray(parts) || !parts.length || parts.some(p =>
        !p || p.type !== 'text' || typeof p.text !== 'string')) continue;
      text = parts.map(p=>p.text).join('\n');
    }
    if(!text.trim()) continue;
    assertPrivateSafe(text);
    const chunks = split(text);
    assert.equal(chunks.join(''),text);
    const countChars = chunks.reduce((n,c)=>n+c.length,0);
    if(segments+chunks.length > 24 || chars+countChars > 100000) {
      stopped = {round:r,index:i,reason:'next-complete-input-exceeds-budget',
        nextSegments:chunks.length,nextChars:countChars};
      break outer;
    }
    plan.push({round:r,index:i,kind,text,raw,chunks,textHash:hash(text)});
    segments += chunks.length; chars += countChars;
  }
}
const manifest = {
  sourceHash:hash(source),inputs:plan.map(p=>({round:p.round,index:p.index,
    kind:p.kind,chars:p.text.length,chunks:p.chunks.length,textHash:p.textHash})),
  segments,chars,unit:'utf16-code-units',tokenLimit,stopped,
  systemInputs:0,retries:0,transformation:'goal verbatim; receipt text parts joined',
  ragCleanupReproduced:false
};
console.log(JSON.stringify({phase:'plan',...manifest}));
async function run() {
  if(!process.argv.includes('--send')) return;
  assert(segments > 0 && segments <= 24 && chars <= 100000);
  assert(config.API_URL && config.API_Key && config.WhitelistEmbeddingModel,
    'Missing existing embedding configuration');
  fs.mkdirSync(outDir,{recursive:true});
  // Never automatically repeat an uncertain or completed paid experiment.
  fs.writeFileSync(path.join(outDir,'started.json'),
    JSON.stringify({...manifest,started:new Date().toISOString()},null,2),{flag:'wx'});
  const {default:fetch} = await import('node-fetch');
  const endpoint = config.API_URL.replace(/\/$/,'')+'/v1/embeddings';
  let sent = 0, sentChars = 0, dimension = null;
  const vectors = new Map();
  for(const p of plan) {
    const pieces = [];
    for(const chunk of p.chunks) {
      assert(sent+1 <= 24 && sentChars+chunk.length <= 100000);
      sent++; sentChars += chunk.length;
      fs.writeFileSync(path.join(outDir,'budget.json'),JSON.stringify({
        attemptedSegments:sent,attemptedChars:sentChars,lastInputIndex:p.index}));
      const controller = new AbortController();
      const timeout = setTimeout(()=>controller.abort(),45000);
      try {
        const response = await fetch(endpoint,{method:'POST',redirect:'error',
          signal:controller.signal,size:2*1024*1024,
          headers:{'Content-Type':'application/json',
            Authorization:'Bearer '+config.API_Key},
          body:JSON.stringify({model:config.WhitelistEmbeddingModel,input:[chunk]})});
        if(!response.ok) throw Error('EMBEDDING_HTTP_'+response.status);
        const body = await response.json();
        assert(Array.isArray(body.data) && body.data.length===1 &&
          body.data[0].index===0,'Ambiguous response binding');
        const v = body.data[0].embedding;
        assert(Array.isArray(v) && v.length>0 && v.length<=4096 &&
          v.every(n=>typeof n==='number' && Number.isFinite(n)) &&
          v.some(n=>n!==0),'Invalid vector');
        if(dimension===null) dimension=v.length;
        assert.equal(v.length,dimension);
        pieces.push({vector:v,weight:tokens(chunk),
          responseModel:typeof body.model==='string'?body.model:null});
      } finally {clearTimeout(timeout);}
    }
    const totalWeight = pieces.reduce((n,p)=>n+p.weight,0);
    const vector = Array.from({length:dimension},(_,j)=>
      pieces.reduce((n,p)=>n+p.vector[j]*p.weight,0)/totalWeight);
    vectors.set(p.index,vector);
    fs.writeFileSync(path.join(outDir,'vector-'+p.index+'.json'),
      JSON.stringify({index:p.index,textHash:p.textHash,vector,
        requestedModel:config.WhitelistEmbeddingModel,
        responseModels:pieces.map(p=>p.responseModel),
        transform:manifest.transformation,spaceVerified:false}),{flag:'wx'});
    console.log(JSON.stringify({phase:'embedded',index:p.index,
      attemptedSegments:sent,attemptedChars:sentChars}));
  }
  // Reconstruct experimental handoffs from measured vectors, not production RAG.
  const {createGravityReceiptExperiment} = require('../modules/vcpLoop/gravityStub');
  const session = createGravityReceiptExperiment();
  const rows = [], audits = [], previousSelected = new Set();
  let baseline = 0, projected = 0;
  try {
    for(let r=0;r<rounds.length;r++) {
      if(stopped && r>=stopped.round) break;
      const messages = rounds[r].request.messages;
      const index = messages.length-1;
      const p = plan.find(x=>x.kind==='receipt' && x.index===index);
      const goals = plan.filter(x=>x.kind==='goal' && x.index<index && x.round<=r);
      const goal = goals.at(-1);
      if(!p || !goal || !vectors.has(index) || !vectors.has(goal.index)) continue;
      const before = JSON.stringify(messages);
      const packet = {version:'rag-refresh-vectors-v1',source:'current-refresh',
        provenance:'unknown',foldEligible:false,
        bindings:{userRawHash:hash(goal.text),toolResultsRawHash:hash(p.raw)},
        goal:{vector:vectors.get(goal.index),textHash:goal.textHash,
          transform:'sanitizeForEmbedding:user'},
        payload:{vector:vectors.get(index),textHash:p.textHash,
          transform:'refreshRagBlock:tool-cleanup'}};
      const result = session.project(messages,{userText:goal.text,
        latestPayload:messages[index].content,gravityRawToolResults:p.raw,
        gravityHandoff:{packet}});
      assert.equal(JSON.stringify(messages),before);
      const selected = result.scores.filter(s=>s.selected).map(s=>s.index);
      const returned = [...previousSelected].filter(i=>
        result.scores.some(s=>s.index===i && !s.selected) &&
        result.messages[i].content===messages[i].content);
      previousSelected.clear(); selected.forEach(i=>previousSelected.add(i));
      const base = before.length, size = JSON.stringify(result.messages).length;
      baseline += base; projected += size;
      rows.push({round:r,status:result.status,reason:result.reason,
        scores:result.scores,automaticReturns:returned,baseline:base,projected:size});
      for(const i of selected) if(!audits.some(a=>a.index===i)) {
        audits.push({index:i,firstOmittedRound:r,
          omittedMiddle:messages[i].content.slice(marker.length+600,-400)});
      }
    }
  } finally {session.close();}
  assert.equal(hash(fs.readFileSync(sourcePath)),manifest.sourceHash);
  const result = {manifest,attemptedSegments:sent,attemptedChars:sentChars,
    rows,baseline,projected,saved:baseline-projected,
    ratio:baseline?(baseline-projected)/baseline:0,
    realEmbeddings:true,productionRagHandoff:false,productionFolding:false,
    tokenSavingsMeasured:false,semanticSafetyValidated:false};
  fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});
  fs.writeFileSync(path.join(outDir,'omission-audit.json'),
    JSON.stringify(audits,null,2),{flag:'wx'});
  console.log(JSON.stringify({phase:'done',baseline,projected,
    saved:baseline-projected,rounds:rows.length,
    omittedIndices:audits.map(a=>a.index),
    automaticReturns:rows.flatMap(r=>r.automaticReturns)}));
}
run().catch(e=>{
  // Do not print upstream bodies, URLs, headers or arbitrary exception messages.
  console.error('EXPERIMENT_FAILED_NO_RETRY',e.name);
  process.exitCode=1;
}).finally(()=>encoding.free());