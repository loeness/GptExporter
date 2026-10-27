const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://extension.test/reader.html' });
global.DOMParser = dom.window.DOMParser;
global.document = dom.window.document;
global.window = dom.window;
const purifier = require('dompurify')(dom.window);
const realKatex = require('katex');
const katexOptions = [];
const mermaidConfigs = [];
const mermaidSources = [];
const mermaid = {
  initialize(config) { mermaidConfigs.push(config); },
  async render(_id, source) {
    mermaidSources.push(source);
    return {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><script>bad()</script>' +
        '<foreignObject><img src="https://tracker.example/pixel"></foreignObject>' +
        '<image href="https://tracker.example/image.png"/><text>safe diagram</text></svg>'
    };
  }
};
global.GptExporterVendors = {
  MarkdownIt: require('markdown-it'),
  DOMPurify: purifier,
  katex: {
    render(tex, target, options) {
      katexOptions.push({ tex, options });
      return realKatex.render(tex, target, options);
    }
  },
  mermaid,
  html2canvas: async () => ({ toDataURL: () => 'data:image/png;base64,iVBORw==' })
};
require('../extension/src/exporters.js');
require('../extension/src/rich-content.js');

const imageData = 'data:image/png;base64,iVBORw==';
const pdfData = 'data:application/pdf;base64,JVBERi0xLjQK';

test('renders semantic Markdown and inert formula, image, and Mermaid placeholders', () => {
  const message = {
    id: 'm1',
    markdown: '# Results\n\n**Bold** and $x^2$ with `code $stay$`.\n\n$$\\frac{a}{b}$$\n\n' +
      '![local](gpt-exporter-asset:img-1) ![allowed](https://files.oaiusercontent.com/a.png?sig=do-not-copy) ' +
      '![external](https://tracker.example/a.png)\n\n```mermaid\nflowchart LR\n A-->B\n```'
  };
  message.markdown += '\n\n![azure](https://abc123.blob.core.windows.net/container/file.png?sv=2025-01-01&se=2030-01-01&sig=private)';
  const html = global.GptExporter.richBodyHtml(message);

  assert.match(html, /<h1>Results<\/h1>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /data-ge-tex="x\^2"/);
  assert.match(html, /data-ge-display="true"/);
  assert.match(html, /data-ge-asset-id="img-1"/);
  assert.match(html, /data-ge-image-ref="https:\/\/files\.oaiusercontent\.com\/a\.png"/);
  assert.match(html, /data-ge-image-ref="https:\/\/abc123\.blob\.core\.windows\.net\/container\/file\.png"/);
  assert.match(html, /data-ge-mermaid="true"/);
  assert.match(html, /code \$stay\$/);
  assert.doesNotMatch(html, /<img\b|src\s*=|tracker\.example|do-not-copy/);
});

test('enhances only READY assets, blocks Mermaid configuration and resource syntax, and sanitizes renderers', async () => {
  const conversation = {
    schemaVersion: 2,
    messages: [{
      id: 'm1', role: 'assistant', assetIds: ['image-1', 'image-2', 'attachment-1'],
      markdown: 'Inline $x^2$ and display $$\\sqrt{x^2+y^2}$$.\n\n' +
        '![ready](gpt-exporter-asset:image-1) ![pending](https://files.oaiusercontent.com/pending.png?sig=private) ' +
        '![external](https://tracker.example/pixel.png)\n\n' +
        '```mermaid\nflowchart LR\n A-->B\n```\n\n' +
        '```mermaid\n%%{init: {"theme":"dark"}}%%\nflowchart LR\n A-->B\n```\n\n' +
        '```mermaid\n---\nconfig:\n  theme: forest\n---\nflowchart LR\n A-->B\n```\n\n' +
        '```mermaid\nA@{ img: "https://tracker.example/a.png" }\n```'
    }],
    assets: [
      { id: 'image-1', messageId: 'm1', kind: 'image', name: 'chart.png', mimeType: 'image/png', status: 'ready', dataUrl: imageData },
      { id: 'image-2', messageId: 'm1', kind: 'image', name: 'pending.png', mimeType: 'image/png', status: 'pending', url: 'https://files.oaiusercontent.com/pending.png?sig=private', error: 'HTTP 403 from https://files.oaiusercontent.com/private?sig=do-not-show&token=secret' },
      { id: 'attachment-1', messageId: 'm1', kind: 'attachment', name: 'answer.pdf', mimeType: 'application/pdf', size: 6, status: 'ready', dataUrl: pdfData },
      { id: 'attachment-unsafe', messageId: 'm1', kind: 'attachment', name: 'open.html', mimeType: 'text/html', status: 'ready', dataUrl: 'data:text/html;base64,PGh0bWw+' }
    ]
  };
  const container = dom.window.document.createElement('div');
  container.innerHTML = global.GptExporter.renderHtmlFragment(conversation, { includeMetadata: false });
  dom.window.document.body.append(container);
  const fetched = [];
  const oldFetch = global.fetch;
  global.fetch = (...args) => { fetched.push(args); throw new Error('network is forbidden in this test'); };
  try {
    await global.GptExporter.enhanceRichContent(container, conversation);
  } finally {
    global.fetch = oldFetch;
  }

  assert.equal(fetched.length, 0);
  assert.equal(container.querySelectorAll('img.ge-ready-image').length, 1);
  assert.equal(container.querySelector('img.ge-ready-image').src, imageData);
  assert.equal(container.querySelectorAll('.ge-unavailable-image').length, 2);
  assert.match(container.querySelector('.ge-unavailable-image').textContent, /HTTP 403/);
  assert.doesNotMatch(container.querySelector('.ge-unavailable-image').textContent, /oaiusercontent|do-not-show|secret/i);
  assert.equal(container.querySelectorAll('a.ge-attachment-download').length, 1);
  assert.equal(container.querySelector('a.ge-attachment-download').download, 'answer.pdf');
  assert.match(container.textContent, /open\.html（附件类型不支持安全下载）/);
  assert.equal(katexOptions.length, 2);
  assert.ok(katexOptions.every(({ options }) => options.trust === false));
  assert.equal(katexOptions[0].options.displayMode, false);
  assert.equal(katexOptions[1].options.displayMode, true);
  assert.ok(container.querySelector('[data-ge-math="true"] svg path'));
  assert.equal(container.querySelectorAll('[onclick],script,foreignObject').length, 0);
  assert.equal(container.querySelectorAll('image[href^="https:"]').length, 0);
  assert.equal(mermaidSources.length, 1);
  assert.equal(mermaidConfigs[0].securityLevel, 'strict');
  assert.equal(mermaidConfigs[0].htmlLabels, false);
  assert.equal(mermaidConfigs[0].flowchart.htmlLabels, false);
  assert.ok(mermaidConfigs[0].secure.includes('securityLevel'));
});

test('snapshots embed READY raster media and safe downloads without SVG or remote references', async () => {
  const conversation = {
    schemaVersion: 2,
    messages: [{ id: 'm2', role: 'assistant', assetIds: ['image-2', 'attachment-2'], markdown: 'Formula $x$ and ![plot](gpt-exporter-asset:image-2)\n\n```mermaid\nflowchart LR\n A-->B\n```' }],
    assets: [
      { id: 'image-2', messageId: 'm2', kind: 'image', name: 'plot.png', mimeType: 'image/png', status: 'ready', dataUrl: imageData },
      { id: 'attachment-2', messageId: 'm2', kind: 'attachment', name: 'report.pdf', mimeType: 'application/pdf', status: 'ready', dataUrl: pdfData }
    ]
  };
  const container = dom.window.document.createElement('div');
  container.innerHTML = global.GptExporter.renderHtmlFragment(conversation, { includeMetadata: false });
  dom.window.document.body.append(container);
  const mathPlaceholder = container.querySelector('[data-ge-math="true"]');
  mathPlaceholder.setAttribute('width', '24');
  mathPlaceholder.setAttribute('height', '12');
  const mathCallsBefore = katexOptions.length;
  await global.GptExporter.enhanceRichContent(container, conversation);
  assert.equal(container.querySelectorAll('[data-ge-rendered="true"]').length, 1, `${container.innerHTML}\nCalls: ${JSON.stringify(katexOptions.slice(mathCallsBefore))}`);
  const snapshot = await global.GptExporter.snapshotRichContent(container);
  const html = snapshot.innerHTML;

  assert.equal(snapshot.querySelectorAll('svg,script,foreignObject').length, 0);
  assert.equal(snapshot.querySelectorAll('img[src="data:image/png;base64,iVBORw=="]').length, 2, html);
  assert.match(html, /alt="TeX: x" width="24" height="12"/);
  assert.match(html, /href="data:application\/pdf;base64,JVBERi0xLjQK" download="report\.pdf"/);
  assert.doesNotMatch(html, /data-ge-image-ref|data-ge-asset-id|https:\/\/tracker|data:text\/html|image\/svg\+xml/);
});

test('keeps legacy HTML fallback when the local Markdown vendor is absent', () => {
  const previous = global.GptExporterVendors.MarkdownIt;
  global.GptExporterVendors.MarkdownIt = undefined;
  try {
    assert.equal(global.GptExporter.richBodyHtml({ markdown: '# old', html: '<p>legacy body</p>' }), '<p>legacy body</p>');
  } finally {
    global.GptExporterVendors.MarkdownIt = previous;
  }
});
