const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('');
global.DOMParser = dom.window.DOMParser;
require('../extension/src/exporters.js');

const conversation = {
  schemaVersion: 1,
  title: '安全与格式',
  url: 'https://chatgpt.com/c/example',
  exportedAt: '2026-10-27T00:00:00.000Z',
  warnings: ['仅含已加载的消息'],
  messages: [
    {
      id: 'u1', role: 'user',
      markdown: '请解释 **加粗** 内容。',
      text: '请解释 加粗 内容。',
      html: '<p>请解释 <strong>加粗</strong> 内容。</p>'
    },
    {
      id: 'a1', role: 'assistant',
      markdown: '这是安全回答。',
      text: '这是安全回答。',
      html: '<p>这是安全回答。</p>'
    }
  ]
};

test('serializes only selected messages and honors metadata choice', () => {
  const result = global.GptExporter.serialize(conversation, {
    format: 'markdown',
    includeMetadata: false,
    messages: [conversation.messages[1]]
  });

  assert.equal(result.mime, 'text/markdown;charset=utf-8');
  assert.equal(result.extension, 'md');
  assert.match(result.content, /\[?assistant\]?/i);
  assert.match(result.content, /这是安全回答/);
  assert.doesNotMatch(result.content, /安全与格式|chatgpt\.com|仅含已加载|解释/);
});

test('converts text, HTML, and JSON with their declared formats', () => {
  const text = global.GptExporter.serialize(conversation, { format: 'text', includeMetadata: false });
  const html = global.GptExporter.serialize(conversation, { format: 'html', includeMetadata: false });
  const json = global.GptExporter.serialize(conversation, { format: 'json', includeMetadata: true });

  assert.equal(text.extension, 'txt');
  assert.equal(text.mime, 'text/plain;charset=utf-8');
  assert.match(text.content, /\[user\]/);
  assert.match(text.content, /解释 加粗 内容/);

  assert.equal(html.extension, 'html');
  assert.equal(html.mime, 'text/html;charset=utf-8');
  assert.match(html.content, /^<!doctype html>/i);
  assert.match(html.content, /<meta charset="utf-8">/);
  assert.match(html.content, /default-src 'none'; img-src 'none'/);
  assert.match(html.content, /@media print/);
  assert.match(html.content, /<strong>加粗<\/strong>/);
  const fragment = global.GptExporter.renderHtmlFragment(conversation, { includeMetadata: false });
  assert.doesNotMatch(fragment, /<html|<head|<style/i);
  assert.match(fragment, /<article>/);

  assert.equal(json.extension, 'json');
  assert.equal(json.mime, 'application/json;charset=utf-8');
  const parsed = JSON.parse(json.content);
  assert.equal(parsed.title, '安全与格式');
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].html, '<p>请解释 <strong>加粗</strong> 内容。</p>');
});

test('sanitizes untrusted HTML and removes remote resources before parsing', () => {
  const originalParser = global.DOMParser;
  let parsedInput = '';
  class SpyParser extends originalParser {
    parseFromString(input, type) {
      parsedInput += String(input);
      return super.parseFromString(input, type);
    }
  }
  global.DOMParser = SpyParser;
  try {
    const unsafe = {
      ...conversation,
      messages: [{
        id: 'unsafe', role: 'assistant', markdown: '安全替代内容', text: '安全替代内容',
        html: '<p onclick="alert(1)" style="background:url(https://tracker.example/x)">保留 <a href="javascript:alert(1)" onmouseover="x">文字</a> <a href="https://safe.example/path">安全链接</a><img src="https://tracker.example/pixel" alt="图示"></p><ol start="3"><li value="9">列项</li></ol><script>坏内容</script><iframe src="https://tracker.example/frame"></iframe>'
      }]
    };
    const output = global.GptExporter.serialize(unsafe, { format: 'html', includeMetadata: false });
    assert.doesNotMatch(parsedInput, /tracker\.example|src\s*=/i);
    assert.doesNotMatch(output.content, /<script|<iframe|<img|onclick|onmouseover|style=/i);
    assert.match(output.content, /保留/);
    assert.match(output.content, /图示/);
    assert.match(output.content, /<a href="https:\/\/safe\.example\/path">安全链接<\/a>/);
    assert.match(output.content, /文字/);
    assert.match(output.content, /<ol start="3"><li value="9">列项<\/li><\/ol>/);
    assert.doesNotMatch(output.content, /href="javascript:/i);
  } finally {
    global.DOMParser = originalParser;
  }
});

test('writes RFC 4180 CSV and prefixes formula-like data fields', () => {
  const input = {
    ...conversation,
    title: '@formula-title',
    url: '\t=HYPERLINK("x")',
    exportedAt: '\r=1+1',
    warnings: ['-formula-warning'],
    messages: [{
      id: '=message-id', role: 'assistant', markdown: '+note',
      text: '=SUM("A1")\nsecond line',
      html: '<p>"quoted", value</p>'
    }]
  };
  const result = global.GptExporter.serialize(input, { format: 'csv', includeMetadata: true });

  assert.equal(result.mime, 'text/csv;charset=utf-8');
  assert.equal(result.extension, 'csv');
  assert.match(result.content, /^"title","url","exportedAt","warnings","id","role","markdown","text","html"\r\n/);
  assert.ok(result.content.includes("\"'@formula-title\""));
  assert.ok(result.content.includes(`"'\t=HYPERLINK(""x"")"`));
  assert.ok(result.content.includes("\"'-formula-warning\""));
  assert.ok(result.content.includes(`"'\r\n=1+1"`));
  assert.ok(result.content.includes("\"'=message-id\""));
  assert.ok(result.content.includes("\"'+note\""));
  assert.ok(result.content.includes(`"'=SUM(""A1"")\r\nsecond line"`));
  assert.ok(result.content.includes('"<p>&quot;quoted&quot;, value</p>"'));
  assert.match(result.content, /\r\n$/);
});

test('rejects unsupported formats and malformed message input', () => {
  assert.throws(() => global.GptExporter.serialize(conversation, { format: 'xml' }), /不支持/);
  assert.throws(() => global.GptExporter.serialize(conversation, { format: 'text', messages: [null] }), /无效消息/);
  assert.throws(() => global.GptExporter.serialize(null), /无效/);
});

test('reader demo clears preview DOM for empty selection and explicit clear', async () => {
  const readerPath = path.join(__dirname, '..', 'extension', 'reader.html');
  const exporterPath = path.join(__dirname, '..', 'extension', 'src', 'exporters.js');
  const readerScriptPath = path.join(__dirname, '..', 'extension', 'src', 'reader.js');
  const dom = new JSDOM(fs.readFileSync(readerPath, 'utf8'), {
    url: 'https://extension.test/reader.html?demo=1',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  try {
    dom.window.eval(fs.readFileSync(exporterPath, 'utf8'));
    dom.window.eval(fs.readFileSync(readerScriptPath, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(dom.window.document.querySelectorAll('#preview-content article').length, 4);

    dom.window.document.querySelector('[data-select="none"]').click();
    assert.equal(dom.window.document.getElementById('preview-content').childElementCount, 0);
    assert.equal(dom.window.document.getElementById('preview-paper').hidden, true);

    dom.window.document.getElementById('clear-data').click();
    assert.equal(dom.window.document.getElementById('preview-content').childElementCount, 0);
    assert.equal(dom.window.document.getElementById('load-error').hidden, false);
  } finally {
    dom.window.close();
  }
});
