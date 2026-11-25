'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const extensionOrigin = 'chrome-extension://test-id/';
const source = fs.readFileSync(path.join(__dirname, '../extension/src/background.js'), 'utf8');
const platforms = fs.readFileSync(path.join(__dirname, '../extension/src/platforms.js'), 'utf8');
const captureId = 'visual-capture-8200ccc5-4d52-4060-8659-05436dc787ba';
const reader = {id:'test-id',url:extensionOrigin + 'reader.html?id=export-id'};

// Simulated PNG header plus payload. The canvas and PNG decoder are browser APIs.
function png(width, height) {
  const bytes = Buffer.alloc(33);
  bytes.write('\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR', 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function dataUrl(bytes) {
  return 'data:image/png;base64,' + bytes.toString('base64');
}

function event() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => { for (const listener of listeners) listener(...args); },
    count: () => listeners.size
  };
}

function setup({url = 'https://claude.ai/chat/example', onCapture, assetResponse} = {}) {
  const records = {};
  const calls = {capture:0,decode:0,close:0,draw:[],relay:[]};
  const tab = {id:7,windowId:2,url,active:true};
  const window = {focused:true};
  const activation = event();
  const focus = event();
  const updated = event();
  let listener;
  let clock = 1000;
  const chrome = {
    runtime: {id:'test-id',getURL:value => extensionOrigin + value,onMessage:{addListener(value) { listener = value; }}},
    tabs: {
      onActivated:activation,onUpdated:updated,
      async get(id) { assert.equal(id, tab.id); return {...tab}; },
      async captureVisibleTab(windowId, options) {
        calls.capture++;
        assert.equal(windowId, tab.windowId);
        assert.equal(options.format, 'png');
        await onCapture?.(activation, focus, updated);
        return dataUrl(png(2400, 1600));
      },
      async create() {},
      async sendMessage(...args) { calls.relay.push(args); return assetResponse; }
    },
    windows: {onFocusChanged:focus,async get(id) { assert.equal(id, tab.windowId); return {...window}; }},
    storage: {session:{async get() { return {...records}; },async set(values) { Object.assign(records, values); }}}
  };
  class Canvas {
    constructor(width, height) { this.width = width; this.height = height; }
    getContext() { return {drawImage: (_bitmap,...coordinates) => calls.draw.push(coordinates)}; }
    async convertToBlob(options) {
      assert.equal(options.type, 'image/png');
      return new Blob([png(this.width, this.height)], {type:'image/png'});
    }
  }
  class TestDate extends Date { static now() { return clock; } }
  vm.runInNewContext(platforms + '\n' + source, {
    chrome,importScripts() {},URL,TextEncoder,Blob,atob,btoa,Date:TestDate,crypto:{randomUUID:() => 'export-id'},
    setTimeout,clearTimeout,OffscreenCanvas:Canvas,
    async createImageBitmap() { calls.decode++; return {width:2400,height:1600,close() { calls.close++; }}; },
    async fetch() { assert.fail('visual capture may not fetch an asset'); }
  });
  const sender = {id:'test-id',url,frameId:0,documentLifecycle:'active',tab:{...tab}};
  const send = (message, from = sender) => new Promise(resolve => listener(message, from, resolve));
  const request = {type:'GPT_EXPORTER_CAPTURE_REGION',url,region:{
    x:10.1,y:30,width:100,height:200,viewportWidth:1200,viewportHeight:800,devicePixelRatio:2
  }};
  return {records,calls,tab,window,sender,send,request,advance:ms => { clock += ms; },
    listenerCount:() => activation.count() + focus.count() + updated.count()};
}

test('crops the focused source tab at native bitmap scale and rate-limits globally', async () => {
  const env = setup();
  const result = await env.send(env.request);
  assert.equal(result.ok, true);
  assert.equal(result.size, 33);
  assert.equal(result.dataUrl, dataUrl(png(199, 400)));
  assert.deepEqual(env.calls.draw, [[21,60,199,400,0,0,199,400]]);
  assert.equal(env.calls.close, 1);
  assert.equal(env.listenerCount(), 0);
  env.advance(500);
  assert.equal((await env.send(env.request)).ok, false);
  assert.equal(env.calls.capture, 1);
  env.advance(50);
  assert.equal((await env.send(env.request)).ok, true);
});

test('rejects an untrusted, inactive, unfocused, navigating or out-of-bounds capture before taking a screenshot', async () => {
  const env = setup();
  for (const sender of [{...env.sender,id:'wrong'},{...env.sender,frameId:1},{...env.sender,documentLifecycle:'prerender'}]) {
    assert.equal((await env.send(env.request, sender)).ok, false);
  }
  for (const region of [{x:-1},{width:NaN},{height:Infinity},{width:1200},{viewportHeight:200}]) {
    assert.equal((await env.send({...env.request,region:{...env.request.region,...region}})).ok, false);
  }
  env.tab.active = false;
  assert.equal((await env.send(env.request)).ok, false);
  env.tab.active = true;
  env.window.focused = false;
  assert.equal((await env.send(env.request)).ok, false);
  env.window.focused = true;
  env.tab.pendingUrl = env.tab.url + '?next';
  assert.equal((await env.send(env.request)).ok, false);
  assert.equal(env.calls.capture, 0);
  assert.equal(env.listenerCount(), 0);
});

test('discards pixels when the active tab switches away and back during a capture', async () => {
  const env = setup({onCapture(activation) {
    activation.emit({windowId:2,tabId:8});
    activation.emit({windowId:2,tabId:7});
  }});
  assert.equal((await env.send(env.request)).ok, false);
  assert.equal(env.calls.capture, 1);
  assert.equal(env.calls.decode, 0);
  assert.equal(env.listenerCount(), 0);
});

const conversation = url => ({schemaVersion:2,url,messages:[{id:'message',role:'assistant',markdown:'x',text:'x',html:'<p>x</p>'}],assets:[{
  id:captureId,messageId:'message',kind:'image',visualCapture:true,mimeType:'image/png',name:'diagram.png',size:33,
  url:'https://files.oaiusercontent.com/secret',dataUrl:'secret'
}]});

test('stores only linked visual metadata on non-ChatGPT pages and relays verified original PNG bytes', async () => {
  const url = 'https://claude.ai/chat/example';
  const original = dataUrl(png(2300, 1000));
  const env = setup({url,assetResponse:{ok:true,asset:{dataUrl:original,size:33,mimeType:'image/png'}}});
  const input = conversation(url);
  input.assets.unshift({id:'ordinary',messageId:'message',kind:'image'});
  const opened = await env.send({type:'GPT_EXPORTER_OPEN',conversation:input});
  assert.equal(opened.ok, true);
  const saved = env.records['export:export-id'];
  assert.equal(saved.assets.length, 1);
  assert.equal(saved.assets[0].visualCapture, true);
  assert.deepEqual(Array.from(saved.messages[0].assetIds), [captureId]);
  assert.equal(JSON.stringify(saved).includes('secret'), false);

  const request = {type:'GPT_EXPORTER_ASSET',exportId:'export-id',assetId:captureId};
  const result = await env.send(request, reader);
  assert.equal(result.ok, true);
  assert.equal(result.asset.dataUrl, original);
  assert.equal(result.asset.size, 33);
  assert.equal(result.asset.name, 'diagram.png');
  assert.equal(env.calls.decode, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls.relay)), [[7,{type:'GPT_EXPORTER_GET_VISUAL_CAPTURE',assetId:captureId,url},{frameId:0}]]);
  env.tab.url = url + '-other';
  assert.equal((await env.send(request, reader)).ok, false);
  assert.equal(env.calls.relay.length, 1);
});

test('prioritizes captures within the existing ChatGPT asset cap and rejects invalid relay data', async () => {
  const url = 'https://chatgpt.com/c/example';
  const env = setup({url,assetResponse:{ok:true,asset:{dataUrl:dataUrl(png(2401, 1000)),size:33,mimeType:'image/png'}}});
  const input = conversation(url);
  input.assets.unshift(...Array.from({length:300}, (_,index) => ({id:'ordinary-' + index,messageId:'message',kind:'image'})));
  const opened = await env.send({type:'GPT_EXPORTER_OPEN',conversation:input});
  assert.equal(opened.ok, true);
  const saved = env.records['export:export-id'];
  assert.equal(saved.assets.length, 300);
  assert.equal(saved.assets[0].id, captureId);
  assert.equal((await env.send({type:'GPT_EXPORTER_ASSET',exportId:'export-id',assetId:captureId}, reader)).ok, false);
});
