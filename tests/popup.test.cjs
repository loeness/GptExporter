'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const source = fs.readFileSync(path.join(__dirname,'../extension/src/popup.js'),'utf8');
function popup(options={}) {
  const dom = new JSDOM('<button id="open"></button><p id="status"></p>', {runScripts:'outside-only'});
  const calls = []; let closed = false, sends = 0;
  dom.window.close = () => { closed = true; };
  dom.window.chrome = {
    tabs: {
      async query() { return [{id: 7, url: options.url || 'https://chatgpt.com/c/test'}]; },
      async sendMessage(id, value) {
        calls.push(['collect', id, value]);
        if (options.needsInjection && sends++ === 0) throw new Error('no listener');
        return options.collectError ? {ok:false,error:'empty conversation'} : {ok:true,conversation:{title:'fixture'}};
      }
    },
    scripting: {async executeScript(value) { calls.push(['inject', value]); }},
    runtime: {async sendMessage(value) { calls.push(['open', value]); return {ok:true,id:'opaque'}; }}
  };
  dom.window.eval(source);
  return {dom,calls,get closed(){return closed;},async click(){dom.window.document.getElementById('open').click(); await new Promise(resolve=>setImmediate(resolve));}};
}
test('popup uses active tab and reinjects the idempotent scripts when a listener is absent', async()=>{
  const env = popup({needsInjection:true}); await env.click();
  assert.deepEqual(env.calls.map(call=>call[0]),['collect','inject','inject','collect','open']);
  assert.equal(env.calls[1][1].world,'MAIN');
  assert.deepEqual(Array.from(env.calls[2][1].files),['src/conversation.js','src/history.js','src/content.js']);
  assert.equal(env.calls[4][1].type,'GPT_EXPORTER_OPEN'); assert.equal(env.closed,true);
});
test('popup reports unsupported origins and collector failures without opening a reader', async()=>{
  for (const options of [{url:'https://chatgpt.com.evil.test/c/x'},{collectError:true}]) {
    const env=popup(options); await env.click();
    assert.equal(env.closed,false); assert.ok(!env.calls.some(call=>call[0]==='open'));
    assert.equal(env.dom.window.document.getElementById('open').disabled,false);
    assert.match(env.dom.window.document.getElementById('status').textContent,/ChatGPT 对话页面|empty conversation/);
  }
});
