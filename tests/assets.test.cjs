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

function pendingResponses() {
  const requests = new Map();
  globalThis.chrome = {runtime: {
    sendMessage({assetId}) {
      return new Promise(resolve => {
        const responses = requests.get(assetId) || [];
        responses.push(resolve);
        requests.set(assetId, responses);
      });
    }
  }};
  return requests;
}

const image = size => ({ok: true, asset: {dataUrl: 'data:image/png;base64,' + 'A'.repeat(size)}});
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('asset fetches overlap within a bounded window and commit in selection order', async () => {
  const requests = pendingResponses();
  const assets = ['first', 'second', 'third'].map(id => ({id, status: 'pending'}));
  const updates = [];
  try {
    const work = globalThis.GptExporter.loadConversationAssets({exportId: 'id', assets}, {
      initialBytes: 40 * 1024 * 1024 - 40,
      onProgress: ({asset}) => updates.push(asset)
    });
    assert.deepEqual([...requests.keys()], ['first', 'second']);
    requests.get('second')[0](image(16));
    await nextTurn();
    assert.deepEqual(updates, []);
    assert.equal(requests.has('third'), false);
    requests.get('first')[0](image(24));
    await nextTurn();
    requests.get('third')[0](image(24));
    await work;
    assert.deepEqual(updates, assets);
    assert.deepEqual(assets.map(asset => asset.status), ['ready', 'unavailable', 'unavailable']);
    assert.match(assets[1].error, /40 MB/);
  } finally { delete globalThis.chrome; }
});

test('overlapping subsets share a request and can retry a failed asset', async () => {
  const requests = pendingResponses();
  const asset = {id: 'shared', status: 'pending'};
  const skipped = {id: 'skipped', status: 'pending'};
  const cacheAssets = [asset, skipped];
  const load = (assets, options) => globalThis.GptExporter.loadConversationAssets(
    {exportId: 'id', assets}, {cacheAssets, ...options}
  );
  try {
    const preview = load([asset, skipped], {shouldLoad: item => item !== skipped});
    const exportLoad = load([asset]);
    assert.equal(requests.get('shared').length, 1);
    requests.get('shared')[0]({ok: false, error: 'temporary failure'});
    await Promise.all([preview, exportLoad]);
    assert.equal(asset.status, 'unavailable');
    assert.equal(skipped.status, 'pending');
    assert.equal(requests.has('skipped'), false);

    const retry = load([asset]);
    assert.equal(requests.get('shared').length, 2);
    requests.get('shared')[1](image(4));
    await retry;
    assert.equal(asset.status, 'ready');
    assert.equal(asset.error, undefined);
  } finally { delete globalThis.chrome; }
});

test('concurrent selections enforce one aggregate allowance for their shared cache', async () => {
  const requests = pendingResponses();
  const assets = ['preview', 'download'].map(id => ({id, status: 'pending'}));
  const options = {cacheAssets: assets, initialBytes: 40 * 1024 * 1024 - 40};
  try {
    const loads = assets.map(asset => globalThis.GptExporter.loadConversationAssets({exportId: 'id', assets: [asset]}, options));
    for (const asset of assets) requests.get(asset.id)[0](image(24));
    await Promise.all(loads);
    assert.deepEqual(assets.map(asset => asset.status), ['ready', 'unavailable']);
    assert.match(assets[1].error, /40 MB/);
  } finally { delete globalThis.chrome; }
});
