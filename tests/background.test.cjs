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
    tabs: {async create(value) { if (options.failOpen) throw new Error('tab failed'); tabs.push(value); }}
  };
  vm.runInNewContext(source, {chrome, TextEncoder, URL, crypto: require('node:crypto').webcrypto, Date});
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
  const big = model(); big.messages[0].text = 'x'.repeat(3 * 1024 * 1024);
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
