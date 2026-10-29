'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../extension/src/background.js'), 'utf8');
const platformsSource = fs.readFileSync(path.join(__dirname, '../extension/src/platforms.js'), 'utf8');
function setup(options = {}) {
  const records = {...options.records}; const tabs = [], downloads = [], renders = [];
  const documents = {created:0,closed:0}; const downloadListeners = new Set(); let listener;
  const chrome = {
    runtime: {id: 'test-id', getURL: value => 'chrome-extension://test-id/' + value, onMessage: {addListener(value) { listener = value; }},
      async getContexts(){return [];},async getPlatformInfo(){return {};},async sendMessage(message){
        if(message.type==='GPT_EXPORTER_DIRECT_RELEASE')return {ok:true};
        renders.push(JSON.parse(JSON.stringify(message)));
        if(options.render)return options.render(message,send);
        return options.failRender?{ok:false,error:'fixture render failed'}:{ok:true,url:'blob:chrome-extension://test-id/generated',missingAssets:0};
      }},
    storage: {session: {
      async get() { return {...records}; }, async set(values) { Object.assign(records, values); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete records[key]; }
    }},
    tabs: {async create(value) { if (options.failOpen) throw new Error('tab failed'); tabs.push(value); },
      async sendMessage(){return {ok:true,asset:options.resolvedAsset||{url:'https://files.oaiusercontent.com/fixture'}};}},
    offscreen:{async createDocument(){documents.created++;},async closeDocument(){documents.closed++;}},
    downloads:{async download(value){if(options.failDownload)throw new Error('fixture download failed');downloads.push(value);return downloads.length;},
      async search(){return [{state:options.interrupted?'interrupted':'complete',...(options.interrupted?{error:'USER_CANCELED'}:{})}];},
      async cancel(){},onChanged:{addListener(value){downloadListeners.add(value);},removeListener(value){downloadListeners.delete(value);}}}
  };
  vm.runInNewContext(platformsSource + '\n' + source, {chrome, TextEncoder, URL, importScripts(value){assert.equal(value,'platforms.js');},crypto: require('node:crypto').webcrypto, Date,atob:options.atob||atob,btoa,AbortSignal,setTimeout,clearTimeout,setInterval,clearInterval,
    fetch:options.fetch||async function(){throw new Error('network disabled in test');}});
  function send(message, sender = {id: 'test-id', url: 'https://chatgpt.com/c/test'}) {
    return new Promise(resolve => { const pending = listener(message, sender, resolve); if (pending === false) resolve(undefined); });
  }
  return {records,tabs,downloads,renders,documents,downloadListeners,send};
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
test('new platforms derive identity from the source URL and cannot claim full API history or cross-platform assets',async()=>{
  for (const [id,host] of [['claude','claude.ai'],['qwen','chat.qwen.ai'],['deepseek','chat.deepseek.com'],['kimi','www.kimi.com'],['gemini','gemini.google.com'],['doubao','www.doubao.com'],['grok','grok.com']]) {
    const env=setup();const input=model();input.url='https://'+host+'/conversation/example';
    input.source={kind:'api',complete:true,platform:'chatgpt',conversationId:'private-conversation'};
    input.messages[0].assetIds=['f'];input.assets=[{id:'f',messageId:'1',kind:'attachment',url:'https://chatgpt.com/api/auth/session'}];
    const result=await env.send({type:'GPT_EXPORTER_OPEN',conversation:input},{id:'test-id',url:input.url,tab:{id:7}});
    assert.equal(result.ok,true);
    const saved=env.records['export:'+result.id];assert.equal(saved.source.platform,id);
    assert.equal(saved.source.kind,'dom');assert.equal(saved.source.complete,false);assert.equal(saved.source.conversationId,'');
    assert.equal(saved.assets.length,0);assert.equal(saved.messages[0].assetIds.length,0);
    assert.match(saved.warnings[0],/当前页面已加载/);
  }
  const env=setup();
  assert.equal((await env.send({type:'GPT_EXPORTER_OPEN',conversation:model()},{id:'test-id',url:'https://claude.ai/chat/other',tab:{id:7}})).ok,false);
});
function branchedModel(){
  const input=model();input.schemaVersion=2;
  for(const [id,role] of [['2','assistant'],['3','user'],['4','assistant'],['alt','assistant']])input.messages.push({id,role,markdown:id,text:id,html:'<p>'+id+'</p>'});
  input.branches=[{id:'current',messageIds:['1','2','3','4']},{id:'other',messageIds:['1','alt']}];input.activeBranchId='current';
  input.assets=[{id:'kept',messageId:'2',kind:'attachment'},{id:'excluded',messageId:'alt',kind:'attachment'}];
  return input;
}
test('quick All Questions Answers download only the current branch and scoped media without a tab',async()=>{
  for(const [preset,ids] of [['all',['1','2','3','4']],['questions',['1','3']],['answers',['2','4']]]){
    const env=setup();const result=await env.send({type:'GPT_EXPORTER_QUICK',conversation:branchedModel(),preset,format:'pdf'});
    assert.equal(result.ok,true);assert.equal(result.count,ids.length);assert.equal(env.tabs.length,0);
    assert.deepEqual(env.renders[0].conversation.messages.map(message=>message.id),ids);
    assert.deepEqual(env.renders[0].conversation.assets.map(asset=>asset.id),preset==='questions'?[]:['kept']);
    assert.equal(env.downloads[0].saveAs,false);assert.equal(env.downloads[0].conflictAction,'uniquify');
    assert.match(env.downloads[0].filename,/\.pdf$/);assert.deepEqual(env.documents,{created:1,closed:1});
    assert.deepEqual(Object.keys(env.records),[]);assert.equal(env.downloadListeners.size,0);
  }
});
test('quick export rejects empty roles, invalid options and untrusted callers before rendering',async()=>{
  const env=setup();
  const truncated=branchedModel();truncated.branches=Array.from({length:2001},(_,index)=>({id:'b'+index,messageIds:['1']}));truncated.activeBranchId='b2000';
  const missing=branchedModel();missing.activeBranchId='missing';
  for(const message of [
    {type:'GPT_EXPORTER_QUICK',conversation:model(),preset:'answers'},
    {type:'GPT_EXPORTER_QUICK',conversation:model(),preset:'none'},
    {type:'GPT_EXPORTER_QUICK',conversation:model(),preset:'all',format:'__proto__'},
    {type:'GPT_EXPORTER_QUICK',conversation:truncated,preset:'all'},
    {type:'GPT_EXPORTER_QUICK',conversation:missing,preset:'all'}
  ])assert.equal((await env.send(message)).ok,false);
  assert.equal((await env.send({type:'GPT_EXPORTER_QUICK',conversation:model(),preset:'all'},{id:'test-id',url:'https://evil.invalid/'})).ok,false);
  assert.equal(env.renders.length,0);assert.equal(env.downloads.length,0);assert.equal(env.documents.created,0);
});
test('quick export cleans temporary state after renderer, download and interruption failures',async()=>{
  for(const options of [{failRender:true},{failDownload:true},{interrupted:true}]){
    const env=setup(options);const result=await env.send({type:'GPT_EXPORTER_QUICK',conversation:model(),preset:'all'});
    assert.equal(result.ok,false);assert.equal(env.documents.closed,1);assert.equal(env.tabs.length,0);
    assert.deepEqual(Object.keys(env.records),[]);assert.equal(env.downloadListeners.size,0);
  }
});
test('a simultaneous quick request is rejected without disturbing the active job or later requests',async()=>{
  const env=setup();
  const request={type:'GPT_EXPORTER_QUICK',conversation:model(),preset:'all'};
  const first=env.send(request);
  assert.equal((await env.send(request)).ok,false);
  assert.equal((await first).ok,true);
  assert.equal((await env.send(request)).ok,true);
  assert.equal(env.downloads.length,2);assert.equal(env.documents.created,2);assert.equal(env.documents.closed,2);
  assert.deepEqual(Object.keys(env.records),[]);
});
test('offscreen asset broker authorizes only the active job and rejects stale IDs or tab senders',async()=>{
  let activeId;
  const env=setup({resolvedAsset:{dataUrl:'data:text/plain;base64,b2s='},async render(message,send){
    activeId=message.exportId;const sender={id:'test-id',url:'chrome-extension://test-id/direct-export.html'};
    const request={type:'GPT_EXPORTER_ASSET',exportId:activeId,assetId:'f'};
    assert.equal((await send(request,sender)).ok,true);
    assert.equal((await send({...request,exportId:'stale'},sender)).ok,false);
    assert.equal((await send(request,{...sender,tab:{id:2}})).ok,false);
    return {ok:true,url:'blob:chrome-extension://test-id/generated'};
  }});
  const input=model();input.source={kind:'api',sourceTabId:7};input.assets=[{id:'f',messageId:'1',kind:'attachment'}];
  assert.equal((await env.send({type:'GPT_EXPORTER_QUICK',conversation:input,preset:'all'})).ok,true);
  assert.equal((await env.send({type:'GPT_EXPORTER_ASSET',exportId:activeId,assetId:'f'},{id:'test-id',url:'chrome-extension://test-id/direct-export.html'})).ok,false);
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
