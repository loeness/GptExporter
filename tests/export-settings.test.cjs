'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/src/export-settings.js');
const options = globalThis.GptExporter.exportSettings;

test('export settings default safely and filenames cannot escape the download directory', () => {
  assert.equal(options.normalize({}).includeConversationLink, true);
  assert.equal(options.normalize({}).includeMessageTimestamp, false);
  assert.equal(options.normalize({filenameFormat:'unexpected'}).filenameFormat, 'title');
  const name = options.filename('../对话:标题', 'pdf', {filenameFormat:'custom-title', customFilenamePrefix:'../私人/记录'});
  assert.match(name, /\.pdf$/);
  assert.doesNotMatch(name, /[\\/\x00-\x1f:*?"<>|]/);
  assert.ok(name.length <= 104);
});

test('export settings read from local preferences and fall back on storage errors', async () => {
  globalThis.chrome = {storage:{local:{async get() { return {[options.KEY]: {filenameFormat:'custom-title', customFilenamePrefix:'课程', includeMessageTimestamp:true}}; }}}};
  try {
    const value = await options.read();
    assert.equal(options.filename('第一课', 'pdf', value), '课程-第一课.pdf');
    assert.equal(value.includeMessageTimestamp, true);
    globalThis.chrome.storage.local.get = async () => { throw new Error('storage denied'); };
    assert.equal((await options.read()).closeSelectionAfterExport, false);
  } finally { delete globalThis.chrome; }
});
