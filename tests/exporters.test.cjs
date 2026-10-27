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
  assert.match(html.content, /default-src 'none'; img-src data:/);
  assert.match(html.content, /font-src 'none'; connect-src 'none'/);
  assert.match(html.content, /@media print/);
  assert.match(html.content, /<strong>加粗<\/strong>/);
  const fragment = global.GptExporter.renderHtmlFragment(conversation, { includeMetadata: false });
  assert.doesNotMatch(fragment, /<html|<head|<style/i);
  assert.match(fragment, /<article data-message-id="u1">/);

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

test('sanitizes rendered snapshots while preserving selected raster images and safe attachment downloads', () => {
  const renderedHtml = '<article data-message-id="u1"><h2>User</h2><img src="data:image/png;base64,iVBORw==" alt="plot" width="44" onerror="attack()"></article>' +
    '<article data-message-id="a1"><h2>Assistant</h2><img src="data:image/png;base64,iVBORw==" alt="snapshot" width="52" height="28"><img src="https://tracker.example/pixel" alt="remote">' +
    '<a href="data:application/pdf;base64,JVBERi0xLjQK" download="../answer.pdf" onclick="attack()">PDF</a>' +
    '<a href="data:image/svg+xml;base64,PHN2Zz4=" download="evil.svg">SVG</a></article>' +
    '<script>attack()</script><img src="data:image/svg+xml;base64,PHN2Zz4=" alt="vector">';
  const result = global.GptExporter.serialize(conversation, {
    format: 'html', includeMetadata: false, messages: [conversation.messages[1]], renderedHtml
  });

  assert.match(result.content, /<article data-message-id="a1">/);
  assert.match(result.content, /<img src="data:image\/png;base64,iVBORw==" alt="snapshot" width="52" height="28">/);
  assert.doesNotMatch(result.content, /data-message-id="u1"|tracker\.example|<script|onclick|onerror|evil\.svg|image\/svg\+xml/i);
  assert.match(result.content, /<a href="data:application\/pdf;base64,JVBERi0xLjQK" download="\.\._answer\.pdf">PDF<\/a>/);
});

test('exports v2 branch and asset metadata by whitelist without signed URLs or token fields', () => {
  const v2 = {
    schemaVersion: 2,
    title: '多分支对话',
    url: 'https://chatgpt.com/c/conversation-1?access_token=secret#branch',
    exportedAt: '2026-10-27T00:00:00.000Z',
    selection: { branchId: '__all', secret: 'never export' },
    warnings: ['media token=secret'],
    activeBranchId: 'branch-a',
    branches: [{ id: 'branch-a', label: '当前路径', leafId: 'm2', messageIds: ['m1', 'm2'], secret: 'never export' }],
    source: { kind: 'api', complete: true, conversationId: 'conversation-1', sourceTabId: 7, accessToken: 'never export' },
    assets: [{ id: 'image-1', messageId: 'm2', kind: 'image', name: 'plot.png', mimeType: 'image/png', size: 10,
      fileId: 'file-1', url: 'https://files.oaiusercontent.com/file?sig=secret', dataUrl: 'data:image/png;base64,iVBORw==', status: 'ready', error: 'token=secret' }],
    messages: [{ id: 'm2', role: 'assistant', markdown: 'Formula $x^2$ and Mermaid source.\n\n```mermaid\nflowchart LR\n A-->B\n```',
      text: 'Formula x squared', html: '<p>Formula</p>', assetIds: ['image-1'], rawToken: 'never export' }]
  };
  const parsed = JSON.parse(global.GptExporter.serialize(v2, { format: 'json' }).content);

  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.url, 'https://chatgpt.com/c/conversation-1');
  assert.equal(parsed.source.kind, 'api');
  assert.equal(parsed.source.sourceTabId, 7);
  assert.deepEqual(parsed.selection, { branchId: '__all' });
  assert.equal(parsed.branches[0].messageIds.length, 2);
  assert.equal(parsed.assets[0].fileId, 'file-1');
  assert.equal(parsed.messages[0].markdown, v2.messages[0].markdown);
  assert.deepEqual(parsed.messages[0].assetIds, ['image-1']);
  assert.doesNotMatch(JSON.stringify(parsed), /secret|accessToken|rawToken|dataUrl|files\.oaiusercontent|never export/i);
});

test('annotates branch ownership for all-branch exports in Markdown, text, HTML, and JSON', () => {
  const branched = {
    schemaVersion: 2,
    title: '分支对话',
    url: 'https://chatgpt.com/c/branches',
    exportedAt: '2026-10-27T00:00:00.000Z',
    selection: { branchId: '__all', ignored: 'secret' },
    branches: [
      { id: 'a', label: '路径 A', messageIds: ['shared', 'a1'] },
      { id: 'b', label: '路径 B', messageIds: ['shared', 'b1'] }
    ],
    messages: [
      { id: 'shared', role: 'user', markdown: '共同问题', text: '共同问题', html: '<p>共同问题</p>' },
      { id: 'a1', role: 'assistant', markdown: '路径 A 的回答', text: '路径 A 的回答', html: '<p>路径 A 的回答</p>' },
      { id: 'b1', role: 'assistant', markdown: '路径 B 的回答', text: '路径 B 的回答', html: '<p>路径 B 的回答</p>' }
    ]
  };
  const markdown = global.GptExporter.serialize(branched, { format: 'markdown' }).content;
  const text = global.GptExporter.serialize(branched, { format: 'text' }).content;
  const html = global.GptExporter.serialize(branched, { format: 'html' }).content;
  const json = JSON.parse(global.GptExporter.serialize(branched, { format: 'json' }).content);

  assert.match(markdown, /所属分支：路径 A、路径 B/);
  assert.match(markdown, /所属分支：路径 A\s+路径 A 的回答/);
  assert.match(markdown, /所属分支：路径 B\s+路径 B 的回答/);
  assert.match(text, /所属分支：路径 A、路径 B/);
  assert.equal((html.match(/class=\"branch-affiliations\"/g) || []).length, 3);
  assert.match(html, /<article data-message-id=\"shared\">/);
  assert.deepEqual(json.selection, { branchId: '__all' });
  assert.deepEqual(json.branches.map((branch) => branch.id), ['a', 'b']);

  const selected = global.GptExporter.serialize({ ...branched, selection: { branchId: 'a' } }, {
    format: 'text', messages: [branched.messages[1]]
  }).content;
  assert.doesNotMatch(selected, /所属分支/);
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
