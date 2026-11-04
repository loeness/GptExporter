'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/assets.js');

test('image batches count already loaded assets against the shared memory budget', async () => {
  let requests = 0;
  globalThis.chrome = {runtime:{async sendMessage() { requests++; return {ok:true, asset:{dataUrl:'data:image/png;base64,YWJj'}}; }}};
  const asset = {id:'img', status:'pending'};
  try {
    await globalThis.GptExporter.loadConversationAssets({exportId:'id', assets:[asset]}, {initialBytes:40 * 1024 * 1024});
    assert.equal(requests,0);
    assert.equal(asset.status,'unavailable');
    assert.match(asset.error,/40 MB/);
  } finally { delete globalThis.chrome; }
});
