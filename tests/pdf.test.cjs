const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('', { url: 'https://extension.invalid/reader.html' });
global.document = dom.window.document;
global.chrome = {
  runtime: {
    getURL(path) { return `chrome-extension://test-extension/${path}`; }
  }
};
global.GptExporterVendors = {};
require('../extension/src/pdf.js');

const api = global.GptExporter;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAg';
const selectedMessage = { id: 'selected', role: 'assistant', text: '所选消息' };

function makeContainer(markup) {
  const container = document.createElement('div');
  container.innerHTML = markup;
  return container;
}

function walk(value, visit) {
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  visit(value);
  Object.values(value).forEach((item) => walk(item, visit));
}

test('builds a semantic PDF definition with CJK, blocks, images, layout, and page numbers', () => {
  const conversation = {
    title: '本地对话',
    url: 'https://chatgpt.com/c/example',
    exportedAt: '2026-10-27T00:00:00.000Z',
    warnings: ['包含已选择消息'],
    messages: [selectedMessage]
  };
  const container = makeContainer(`
    <header><h1>本地对话</h1><dl><dt>来源</dt><dd>https://chatgpt.com/c/example</dd></dl></header>
    <article data-message-id="selected">
      <h2>Assistant</h2>
      <p>可搜索的中文 <strong>加粗文字</strong> 与 <a href="https://example.com">链接文字</a>。</p>
      <ul><li>第一项</li><li>第二项</li></ul>
      <pre><code>const value = '本地';\n${'longLine'.repeat(20)}</code></pre>
      <table><thead><tr><th>字段</th><th>值</th></tr></thead><tbody><tr><td>标题</td><td>内容</td></tr></tbody></table>
      <p>图表：<img alt="图表" width="30" height="15" src="${png}"></p>
      <p>低分辨率图像：<img alt="低分辨率图像" src="${png}"></p>
    </article>
  `);

  const definition = api.pdfDefinition({
    container,
    conversation,
    messages: [selectedMessage],
    includeMetadata: true,
    pageSize: 'LETTER',
    orientation: 'landscape'
  });

  assert.equal(definition.pageSize, 'LETTER');
  assert.equal(definition.pageOrientation, 'landscape');
  assert.equal(definition.defaultStyle.font, 'GptExporterNotoSansCJKsc');
  assert.equal(definition.pageMargins.length, 4);
  assert.equal(definition.footer(2, 7).text, '第 2 页 / 共 7 页');
  assert.equal(definition.footer(2, 7).alignment, 'center');
  assert.match(JSON.stringify(definition.content), /可搜索的中文/);
  assert.match(JSON.stringify(definition.content), /加粗文字/);
  assert.match(JSON.stringify(definition.content), /链接文字/);
  assert.match(JSON.stringify(definition.content), /第一项/);
  assert.match(JSON.stringify(definition.content), /本地/);

  const nodes = [];
  walk(definition.content, (node) => nodes.push(node));
  assert.ok(nodes.some((node) => node.table && node.table.headerRows === 1));
  assert.ok(nodes.some((node) => node.ul && node.ul.length === 2));
  assert.ok(nodes.some((node) => node.link === 'https://example.com/'));
  const images = nodes.filter((node) => node.image === png);
  assert.equal(images.length, 2);
  assert.equal(images[0].width, 22.5);
  assert.equal(images[1].width, 48);
  assert.ok(images.every((image) => !('fit' in image) && image.alignment === 'center'));
  assert.ok(nodes.some((node) => node.style === 'codeBlock' && node.preserveLeadingSpaces === true));
  assert.ok(nodes.some((node) => node.style === 'documentTitle'));
});

test('keeps nested list items in place and preserves ordered start and value numbering', () => {
  const container = makeContainer(`
    <article data-message-id="selected">
      <ol start="4" type="A">
        <li>第一个</li>
        <li value="9">父项开始<ul><li>子项开始<ol start="3"><li>深层项目</li></ol>子项结束</li></ul>父项结束</li>
        <li>最后一个</li>
      </ol>
    </article>
  `);
  const definition = api.pdfDefinition({ container, conversation: {}, messages: [selectedMessage], includeMetadata: false });
  const topList = definition.content.find((node) => node && node.ol);

  assert.ok(topList);
  assert.equal(topList.type, 'upper-alpha');
  assert.equal(topList.start, 4);
  assert.deepEqual(topList.ol.map((item) => item.counter), [4, 9, 10]);
  const parentStack = topList.ol[1].stack;
  const nestedListIndex = parentStack.findIndex((node) => node && node.ul);
  assert.ok(nestedListIndex > 0);
  assert.match(JSON.stringify(parentStack[nestedListIndex - 1]), /父项开始/);
  assert.match(JSON.stringify(parentStack[nestedListIndex + 1]), /父项结束/);

  const nestedList = parentStack[nestedListIndex];
  assert.equal(nestedList.ul.length, 1);
  const nestedItemStack = nestedList.ul[0].stack;
  const deepListIndex = nestedItemStack.findIndex((node) => node && node.ol);
  assert.ok(deepListIndex > 0);
  assert.match(JSON.stringify(nestedItemStack[deepListIndex - 1]), /子项开始/);
  assert.match(JSON.stringify(nestedItemStack[deepListIndex + 1]), /子项结束/);
  assert.equal(nestedItemStack[deepListIndex].start, 3);
});

test('hard-wraps long unbroken text in narrow multi-column table cells', () => {
  const longToken = '没有空格的超长表格内容'.repeat(12);
  const container = makeContainer(`
    <article data-message-id="selected">
      <table><tbody><tr><td>一</td><td>二</td><td>三</td><td>${longToken}</td></tr></tbody></table>
    </article>
  `);
  const definition = api.pdfDefinition({ container, conversation: {}, messages: [selectedMessage], includeMetadata: false, pageSize: 'A4' });
  const tableNode = definition.content.find((node) => node && node.table);
  assert.ok(tableNode);
  const textRuns = tableNode.table.body[0][3].text;
  const wrapped = textRuns.map((run) => typeof run === 'string' ? run : run.text).join('');
  const lines = wrapped.split('\n');
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => Array.from(line).length <= 13));
  assert.equal(lines.join(''), longToken);
});

test('keeps a short inline TeX image between its surrounding text and blocks a tall formula', () => {
  const container = makeContainer(`
    <article data-message-id="selected">
      <p>行内数学<img alt="TeX: E=mc²" width="20" height="12" src="${png}">，显示公式：</p>
      <p>复杂公式<img alt="TeX: large equation" height="40" src="${png}">后续说明</p>
    </article>
  `);
  const definition = api.pdfDefinition({ container, conversation: {}, messages: [selectedMessage], includeMetadata: false });

  const inline = definition.content.find((node) => node && node.layout === 'noBorders' && node.table && node.table.body[0].some((cell) => cell.image));
  assert.ok(inline);
  const inlineCells = inline.table.body[0];
  assert.equal(inlineCells.length, 3);
  assert.match(JSON.stringify(inlineCells[0]), /行内数学/);
  assert.equal(inlineCells[1].image, png);
  assert.equal(inlineCells[1].width, 15);
  assert.equal(inlineCells[1].valign, 'middle');
  assert.match(JSON.stringify(inlineCells[2]), /显示公式/);

  const tallFormula = definition.content.find((node) => node && node.image === png);
  assert.ok(tallFormula);
  assert.equal(tallFormula.width, 48);
  assert.equal(tallFormula.alignment, 'center');
  assert.ok(definition.content.some((node) => node && node.text && JSON.stringify(node.text).includes('复杂公式')));
  assert.ok(definition.content.some((node) => node && node.text && JSON.stringify(node.text).includes('后续说明')));
});

test('filters unselected messages and embeds only ready selected local attachments', () => {
  const conversation = {
    title: '过滤测试',
    assets: [
      { id: 'a1', messageId: 'selected', kind: 'attachment', name: '报告.pdf', mimeType: 'application/pdf', status: 'ready', dataUrl: 'data:application/pdf;base64,JVBERi0x' },
      { id: 'a2', messageId: 'other', kind: 'attachment', name: 'other.pdf', mimeType: 'application/pdf', status: 'ready', dataUrl: 'data:application/pdf;base64,T1RIRVI=' },
      { id: 'a3', messageId: 'selected', kind: 'attachment', name: 'pending.txt', mimeType: 'text/plain', status: 'pending', url: 'https://signed.example/private' },
      { id: 'a4', messageId: 'selected', kind: 'attachment', name: 'remote.txt', mimeType: 'text/plain', status: 'ready', url: 'https://signed.example/secret' }
    ]
  };
  const container = makeContainer(`
    <article data-message-id="selected"><h2>Assistant</h2><p>保留内容 <a href="javascript:alert(1)">安全文字</a></p>
      <img src="https://tracker.invalid/pixel" alt="图像未加载"><script>doNotRun()</script></article>
    <article data-message-id="other"><p>不应导出</p></article>
  `);

  const definition = api.pdfDefinition({ container, conversation, messages: [selectedMessage], includeMetadata: false });
  const serialized = JSON.stringify(definition);

  assert.match(serialized, /保留内容/);
  assert.match(serialized, /安全文字/);
  assert.match(serialized, /图像未加载/);
  assert.match(serialized, /图片未嵌入/);
  assert.doesNotMatch(serialized, /不应导出|tracker\.invalid|signed\.example|javascript:|doNotRun|other\.pdf/);
  assert.deepEqual(Object.keys(definition.files), ['gpt_exporter_attachment_1']);
  assert.equal(definition.files.gpt_exporter_attachment_1.name, '报告.pdf');
  assert.equal(definition.files.gpt_exporter_attachment_1.src, 'data:application/pdf;base64,JVBERi0x');
  assert.match(serialized, /pending\.txt/);
  assert.match(serialized, /附件未嵌入/);
});

test('generates bytes with pdfmake getBuffer after registering the local CJK font', async () => {
  const calls = { fetched: [], fonts: null, definition: null, getBuffer: false };
  const pdfMake = {
    vfs: { existingFont: 'existing-data' },
    addFonts(fonts) { calls.fonts = fonts; },
    createPdf(definition) {
      calls.definition = definition;
      return {
        async getBuffer() {
          calls.getBuffer = true;
          return new Uint8Array([37, 80, 68, 70]);
        }
      };
    }
  };
  global.GptExporterVendors.pdfMake = pdfMake;
  global.fetch = async (url, options) => {
    calls.fetched.push({ url, options });
    return { ok: true, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; } };
  };

  const output = await api.buildPdf({
    container: makeContainer('<article data-message-id="selected"><p>可搜索文本</p></article>'),
    conversation: { title: '本地 PDF' },
    messages: [selectedMessage],
    includeMetadata: false
  });

  assert.ok(output instanceof Uint8Array);
  assert.deepEqual(Array.from(output), [37, 80, 68, 70]);
  assert.equal(calls.fetched.length, 1);
  assert.match(calls.fetched[0].url, /^chrome-extension:\/\/test-extension\/vendor\/fonts\/NotoSansCJKsc-Regular\.otf$/);
  assert.equal(calls.fetched[0].options.credentials, 'same-origin');
  assert.equal(pdfMake.vfs['NotoSansCJKsc-Regular.otf'], 'AQID');
  assert.deepEqual(calls.fonts.GptExporterNotoSansCJKsc, {
    normal: 'NotoSansCJKsc-Regular.otf',
    bold: 'NotoSansCJKsc-Regular.otf',
    italics: 'NotoSansCJKsc-Regular.otf',
    bolditalics: 'NotoSansCJKsc-Regular.otf'
  });
  assert.equal(calls.getBuffer, true);
  assert.equal(calls.definition.defaultStyle.font, 'GptExporterNotoSansCJKsc');
});

test('rejects an empty message selection and unsupported page settings clearly', () => {
  const container = makeContainer('<p>Text</p>');
  assert.throws(() => api.pdfDefinition({ container, conversation: {}, messages: [] }), /至少选择一条消息/);
  assert.throws(() => api.pdfDefinition({ container, conversation: {}, messages: [selectedMessage], pageSize: 'LEGAL' }), /仅支持 A4 或 LETTER/);
  assert.throws(() => api.pdfDefinition({ container, conversation: {}, messages: [selectedMessage], orientation: 'sideways' }), /仅支持 portrait 或 landscape/);
});
