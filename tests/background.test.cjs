'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/background.js'), 'utf8');
function setup(options = {}) {
  const records = {...options.records}; const tabs = []; let listener;
  const chrome = {
    runtime: {id: 'test-id', getURL: value => 'chrome-extension://test-id/' + value, onMessage: {addListener(value) { listener = value; }}},
    storage: {session: {
      async get() { return {...records}; }, async set(values) { Object.assign(records, values); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete records[key]; }
    }},
    tabs: {async create(value) { if (options.failOpen) throw new Error('tab failed'); tabs.push(value); },
      async sendMessage(){return {ok:true,asset:options.resolvedAsset||{url:'https://files.oaiusercontent.com/fixture'}};}}
  };
  vm.runInNewContext(source, {chrome, TextEncoder, URL, crypto: require('node:crypto').webcrypto, Date,atob:options.atob||atob,btoa,AbortSignal,
    fetch:options.fetch||async function(){throw new Error('network disabled in test');}});
  return {records, tabs, send(message, sender = {id: 'test-id', url: 'https://chatgpt.com/c/test'}) {
    return new Promise(resolve => { const pending = listener(message, sender, resolve); if (pending === false) resolve(undefined); });
  }};
}
const model = () => ({schemaVersion: 1, title: 'Hello', url: 'https://chatgpt.com/c/test', messages: [
  {id: '1', role: 'user', markdown: '你好', text: '你好', html: '<p>你好</p>'}
], warnings: []});
test('stores session model, prunes expired data, opens reader with opaque id', async () => {
  const env = setup({records: {'export:stale': {createdAt: 1}, preference: 'keep'}});
  const result = await env.send({type: 'GPT_EXPORTER_OPEN', conversation: model()});
  assert.equal(result.ok, true); assert.ok(env.records['export:' + result.id]);
  assert.equal(env.records['export:stale'], undefined); assert.equal(env.records.preference, 'keep');
  assert.equal(env.tabs[0].url, 'chrome-extension://test-id/reader.html?id=' + result.id);
});
test('rejects untrusted origins and malformed or oversized bodies', async () => {
  const env = setup();
  for (const url of ['https://chatgpt.com.evil.test/c/a', 'https://example.com', 'chrome-extension://test-id/reader.html']) {
    const result = await env.send({type: 'GPT_EXPORTER_OPEN', conversation: model()}, {id:'test-id', url});
    assert.equal(result.ok, false);
  }
  const bad = model(); bad.messages[0].role = 'admin';
  assert.equal((await env.send({type: 'GPT_EXPORTER_OPEN', conversation: bad})).ok, false);
  const big = model(); big.messages[0].text = 'x'.repeat(8 * 1024 * 1024);
  assert.equal((await env.send({type: 'GPT_EXPORTER_OPEN', conversation: big})).ok, false);
  assert.equal(env.tabs.length, 0);
});
test('rolls back session record if opening preview fails', async () => {
  const env = setup({failOpen: true});
  assert.equal((await env.send({type: 'GPT_EXPORTER_OPEN', conversation: model()})).ok, false);
  assert.deepEqual(Object.keys(env.records), []);
});
test('serializes concurrent launches without losing data', async () => {
  const env = setup();
  const results = await Promise.all([env.send({type:'GPT_EXPORTER_OPEN', conversation:model()}), env.send({type:'GPT_EXPORTER_OPEN', conversation:model()})]);
  assert.ok(results.every(value => value.ok)); assert.notEqual(results[0].id, results[1].id); assert.equal(env.tabs.length, 2);
});
test('retains graph metadata but strips credentials and binary data from session',async()=>{
  const env=setup();const input=model();input.schemaVersion=2;
  input.source={kind:'api',complete:true,conversationId:'c-test',sourceTabId:7,accessToken:'never-store'};
  input.branches=[{id:'b1',label:'One',messageIds:['1','absent']}];input.activeBranchId='b1';
  input.assets=[{id:'image1',messageId:'1',kind:'image',name:'test',mimeType:'image/png',url:'https://files.oaiusercontent.com/test',dataUrl:'never-store'}];
  const result=await env.send({type:'GPT_EXPORTER_OPEN',conversation:input});
  const saved=env.records['export:'+result.id];assert.equal(saved.source.complete,true);
  assert.deepEqual(Array.from(saved.branches[0].messageIds),['1']);assert.ok(!JSON.stringify(saved).includes('never-store'));
});
test('keeps only valid page-selection presets and known boolean overrides',async()=>{
  const env=setup();const input=model();
  input.messages.push({id:'2',role:'assistant',markdown:'答复',text:'答复',html:'<p>答复</p>'});
  input.initialSelection={preset:'questions',overrides:[
    {id:'1',selected:false},
    {id:'2',selected:true,untrusted:'strip-me'},
    {id:'missing',selected:true},
    {id:'2',selected:'yes'}
  ],accessToken:'strip-me',unrelated:{body:'strip-me'}};
  const result=await env.send({type:'GPT_EXPORTER_OPEN',conversation:input});
  const saved=env.records['export:'+result.id];
  assert.deepEqual(JSON.parse(JSON.stringify(saved.initialSelection)),{preset:'questions',overrides:[
    {id:'1',selected:false},{id:'2',selected:true}
  ]});
  assert.ok(!JSON.stringify(saved).includes('strip-me'));
});
test('invalid page-selection presets cannot preserve partial overrides',async()=>{
  const env=setup();const input=model();
  input.initialSelection={preset:'admin',overrides:[{id:'1',selected:false}],extra:'discard'};
  const result=await env.send({type:'GPT_EXPORTER_OPEN',conversation:input});
  const saved=env.records['export:'+result.id];
  assert.ok(!saved.initialSelection || saved.initialSelection.preset==='all');
  assert.ok(!saved.initialSelection?.overrides?.length);
  assert.ok(!JSON.stringify(saved).includes('discard'));
});
test('asset retrieval validates stored membership, sender, host and raster bytes',async()=>{
  const dataUrl='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const env=setup({resolvedAsset:{dataUrl}});const input=model();
  input.source={kind:'api',complete:true,sourceTabId:7};input.assets=[{id:'image1',messageId:'1',kind:'image',name:'test',mimeType:'image/png'}];
  const opened=await env.send({type:'GPT_EXPORTER_OPEN',conversation:input});
  const request={type:'GPT_EXPORTER_ASSET',exportId:opened.id,assetId:'image1'};
  assert.equal((await env.send(request)).ok,false);
  const sender={id:'test-id',url:'chrome-extension://test-id/reader.html?id='+opened.id};
  const result=await env.send(request,sender);assert.equal(result.ok,true);assert.equal(result.asset.mimeType,'image/png');
  assert.equal((await env.send({...request,assetId:'other'},sender)).ok,false);
  const hostile=setup({records:env.records,resolvedAsset:{url:'https://evil.invalid/pixel'}});
  assert.equal((await hostile.send(request,sender)).ok,false);
});
test('caps base64 before decoding and treats active attachments as download-only bytes',async()=>{
  const input=model();input.source={kind:'api',sourceTabId:7};input.assets=[{id:'f',messageId:'1',kind:'attachment',name:'example.html',mimeType:'text/html'}];
  let decoded=false;const huge=setup({resolvedAsset:{dataUrl:'data:text/plain;base64,'+'A'.repeat(17*1024*1024)},atob(){decoded=true;throw new Error('must not decode');}});
  const opened=await huge.send({type:'GPT_EXPORTER_OPEN',conversation:input});
  const sender={id:'test-id',url:'chrome-extension://test-id/reader.html?id='+opened.id};
  assert.equal((await huge.send({type:'GPT_EXPORTER_ASSET',exportId:opened.id,assetId:'f'},sender)).ok,false);assert.equal(decoded,false);
  const html='<html>original attachment bytes</html>';
  const env=setup({resolvedAsset:{dataUrl:'data:text/html;base64,'+btoa(html)}});
  const ready=await env.send({type:'GPT_EXPORTER_OPEN',conversation:input});
  const response=await env.send({type:'GPT_EXPORTER_ASSET',exportId:ready.id,assetId:'f'},sender);
  assert.equal(response.ok,true);assert.equal(response.asset.mimeType,'application/octet-stream');
  assert.equal(atob(response.asset.dataUrl.split(',')[1]),html);
});
