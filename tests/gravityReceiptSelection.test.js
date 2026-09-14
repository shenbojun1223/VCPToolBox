'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {createGravityReceiptExperiment} = require('../modules/vcpLoop/gravityStub');
const hash = text => createHash('sha256').update(text).digest('hex');
const marker = '<!-- VCP_TOOL_PAYLOAD -->';
// Explicitly synthetic vectors: tests selection mechanics, NOT text semantics.
function append(messages, vector, label) {
  const call = '<<<['+'TOOL_REQUEST'+']>>>\n'+
    'tool_name: \u300c始\u300dFixtureRead\u300c末\u300d\n'+
    '<<<['+'END_TOOL_REQUEST'+']>>>';
  const raw = JSON.stringify([{type:'text',
    text:label+'\n'+('fixture padding '+label+'\n').repeat(240)}]);
  const latestPayload = marker+'\n'+raw;
  messages.push({role:'assistant',content:call},{role:'user',content:latestPayload});
  const userText = messages[1].content;
  return {userText,latestPayload,gravityRawToolResults:raw,
    gravityHandoff:{status:'received-unverified',packet:{
      version:'rag-refresh-vectors-v1',source:'current-refresh',
      provenance:'unknown',foldEligible:false,
      bindings:{userRawHash:hash(userText),toolResultsRawHash:hash(raw)},
      goal:{vector:[0,1],textHash:hash(userText),
        transform:'sanitizeForEmbedding:user'},
      payload:{vector,textHash:hash(raw),transform:'refreshRagBlock:tool-cleanup'}
    }}};
}
const initial = () => [
  {role:'system',content:'Fixture policy'},
  {role:'user',content:'Synthetic task goal'}
];

test('automatic old-receipt selection and return from full originals', () => {
  const session = createGravityReceiptExperiment(), messages = initial();
  try {
    let options = append(messages,[1,0],'A');
    const first = session.project(messages,options);
    assert.deepEqual(first.messages,messages);
    options = append(messages,[0,1],'B');
    assert.deepEqual(session.project(messages,options).messages,messages);
    options = append(messages,[0,1],'B2');
    const snapshot = JSON.stringify(messages);
    const folded = session.project(messages,options);
    assert.equal(folded.status,'projected');
    assert.deepEqual(folded.scores.map(s=>[s.index,s.selected]),[[3,true]]);
    assert(folded.messages[3].content.includes('[VCP_GRAVITY_STUB'));
    assert(folded.savedChars > 0);
    for(let i=0;i<messages.length;i++)
      if(i!==3) assert.deepEqual(folded.messages[i],messages[i]);
    assert.equal(JSON.stringify(messages),snapshot);
    assert.equal(session.project(folded.messages,options).reason,'projected-input');
    // Latest receipt becomes associated with A. No explicit index or restore call.
    options = append(messages,[1,0],'A-return');
    const restored = session.project(messages,options);
    assert.equal(restored.status,'projected');
    assert.deepEqual(restored.messages[3],messages[3]);
    assert.equal(restored.scores.find(s=>s.index===3).selected,false);
    assert.equal(restored.spaceVerified,false);
    assert.equal(restored.foldEligible,false);
    console.log(JSON.stringify({fixture:'synthetic-vectors-only',
      foldedSavedCodeUnits:folded.savedChars,automaticReturn:true,
      realSemanticQualityValidated:false}));
  } finally { session.close(); }
});

test('missing vectors and transformed receipts pass originals through', () => {
  const session = createGravityReceiptExperiment(), messages = initial();
  try {
    const options = append(messages,[1,0],'A');
    const missing = session.project(messages,{...options,gravityHandoff:null});
    assert.equal(missing.reason,'missing-bound-vectors');
    assert.strictEqual(missing.messages,messages);
    const transformed = session.project(messages,{
      ...options,gravityRawToolResults:options.gravityRawToolResults+' '
    });
    assert.equal(transformed.reason,'unbound-or-transformed-receipt');
    assert.strictEqual(transformed.messages,messages);
  } finally { session.close(); }
});

test('non-system history drift invalidates prior receipt vectors', () => {
  const session = createGravityReceiptExperiment(), messages = initial();
  try {
    session.project(messages,append(messages,[1,0],'A'));
    session.project(messages,append(messages,[0,1],'B'));
    const options = append(messages,[0,1],'B2');
    messages[2].content += '\nChanged command';
    const result = session.project(messages,options);
    assert.equal(result.status,'projected');
    assert.deepEqual(result.scores,[]);
    assert.deepEqual(result.messages,messages);
  } finally { session.close(); }
});

test('abort closes experiment and prevents subsequent selection', () => {
  const session = createGravityReceiptExperiment(), messages = initial();
  const options = append(messages,[1,0],'A');
  const controller = new AbortController();
  controller.abort();
  assert.equal(session.project(messages,{...options,signal:controller.signal}).reason,
    'closed-or-aborted');
  assert.equal(session.project(messages,options).reason,'closed-or-aborted');
});// Synthetic vectors deliberately separate acknowledgement wording from task focus.
function appendWriteAcknowledgement(messages) {
  const options = append(messages,[0,-1],'temporary fixture');
  const raw = JSON.stringify([
    {type:'text',text:'文件编辑成功 (with validation)'},
    {type:'text',text:'Code Validation Results:\n'+JSON.stringify([
      {severity:'warning',message:'File ignored because outside of base path.'}
    ])}
  ]);
  options.gravityRawToolResults = raw;
  options.latestPayload = '<!-- VCP_TOOL_PAYLOAD -->\n'+raw;
  messages.at(-1).content = options.latestPayload;
  options.gravityHandoff.packet.bindings.toolResultsRawHash = hash(raw);
  options.gravityHandoff.packet.payload.textHash = hash(raw);
  return options;
}

test('write acknowledgement retains substantive attention without hiding its warning', () => {
  const session = createGravityReceiptExperiment(), messages = initial();
  try {
    session.project(messages,append(messages,[1,0],'A'));
    session.project(messages,append(messages,[1,0],'A-current'));
    const options = appendWriteAcknowledgement(messages);
    const snapshot = JSON.stringify(messages);
    const result = session.project(messages,options);
    assert.equal(result.status,'projected');
    assert.equal(result.scores.find(s=>s.index===3).selected,false);
    assert.deepEqual(result.messages,messages);
    assert.equal(JSON.stringify(messages),snapshot);
    assert(result.messages.at(-1).content.includes('outside of base path'));
    // A subsequent substantive receipt CAN change focus; the acknowledgement
    // must not permanently pin the earlier attention.
    const changed = session.project(messages,append(messages,[0,1],'B-new-focus'));
    assert.equal(changed.status,'projected');
    assert.equal(changed.scores.find(s=>s.index===3).selected,true);
  } finally { session.close(); }
});

test('acknowledgement never jumps over an unobserved substantive receipt', () => {
  const session = createGravityReceiptExperiment(), messages = initial();
  try {
    session.project(messages,append(messages,[1,0],'A'));
    append(messages,[0,1],'B-without-handoff');
    const options = appendWriteAcknowledgement(messages);
    const result = session.project(messages,options);
    assert.equal(result.reason,'missing-substantive-attention');
    assert.strictEqual(result.messages,messages);
  } finally { session.close(); }
});