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
  assert.match(html, /alt="TeX: x" class="ge-inline-math" width="24" height="12"/);
  assert.match(html, /href="data:application\/pdf;base64,JVBERi0xLjQK" download="report\.pdf"/);
  assert.doesNotMatch(html, /data-ge-image-ref|data-ge-asset-id|https:\/\/tracker|data:text\/html|image\/svg\+xml/);
});

test('measures formula snapshots before replacing nodes and reuses matching raster output', async () => {
  const { window } = dom;
  const api = global.GptExporter;
  const vendors = global.GptExporterVendors;
  const previousMath = vendors.renderMathSvg;
  const previousRect = window.HTMLElement.prototype.getBoundingClientRect;
  const previousContext = window.HTMLCanvasElement.prototype.getContext;
  const previousEncoder = window.HTMLCanvasElement.prototype.toDataURL;
  const previousImage = window.Image;
  const drawSizes = [];
  const vectorCalls = [];
  const imageLoads = [];
  const pendingUrls = new Map();
  const progress = [];
  let encodes = 0;
  const container = window.document.createElement('div');
  container.innerHTML = [24, 24, 40, 40].map((width, index) =>
    `<span data-ge-math="true" data-ge-tex="\\sqrt{x}" data-ge-rendered="true" data-ge-display="${index === 3}" data-width="${width}">x</span>`
  ).join('');
  try {
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (!this.hasAttribute('data-width')) return { width: 320, height: 60 };
      assert.equal(this.parentNode.querySelectorAll('img').length, 0);
      return { width: Number(this.getAttribute('data-width')), height: 12 };
    };
    vendors.renderMathSvg = (tex, display) => {
      vectorCalls.push([tex, display]);
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><path d="M0 0h800v400z"/>' +
        '<image href="https://tracker.example/math"/></svg>';
    };
    window.URL.createObjectURL = (blob) => {
      const url = `blob:formula-${imageLoads.length}`;
      pendingUrls.set(url, blob);
      return url;
    };
    window.URL.revokeObjectURL = (url) => pendingUrls.delete(url);
    window.Image = class {
      set src(url) {
        assert.match(url, /^blob:formula-/);
        imageLoads.push(pendingUrls.get(url));
        queueMicrotask(() => this.onload());
      }
    };
    window.HTMLCanvasElement.prototype.getContext = function () {
      return { drawImage: (_image, x, y, width, height) => drawSizes.push([this.width, this.height, x, y, width, height]) };
    };
    window.HTMLCanvasElement.prototype.toDataURL = () => { encodes++; return imageData; };
    const snapshot = await api.snapshotRichContent(container, { onProgress: (event) => progress.push(event) });
    assert.deepEqual(vectorCalls, [['\\sqrt{x}', false], ['\\sqrt{x}', false], ['\\sqrt{x}', true]]);
    assert.deepEqual(drawSizes, [
      [48, 24, 0, 2, 38, 20],
      [80, 24, 0, 2, 38, 20],
      [80, 24, 21, 2, 38, 20]
    ]);
    assert.equal(encodes, 3);
    assert.equal(imageLoads.length, 3);
    assert.equal(pendingUrls.size, 0);
    assert.ok((await Promise.all(imageLoads.map((blob) => blob.text()))).every((svg) => svg.includes('<path') && !svg.includes('tracker.example')));
    assert.deepEqual(Array.from(snapshot.querySelectorAll('img'), (img) => [img.width, img.height]), [[24, 12], [24, 12], [40, 12], [40, 12]]);
    assert.equal(snapshot.querySelectorAll('img.ge-inline-math').length, 3);
    assert.deepEqual(progress[0], { completed: 0, total: 4 });
    assert.deepEqual(progress.at(-1), { completed: 4, total: 4 });
  } finally {
    vendors.renderMathSvg = previousMath;
    window.HTMLElement.prototype.getBoundingClientRect = previousRect;
    window.HTMLCanvasElement.prototype.getContext = previousContext;
    window.HTMLCanvasElement.prototype.toDataURL = previousEncoder;
    window.Image = previousImage;
    delete window.URL.createObjectURL;
    delete window.URL.revokeObjectURL;
  }
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

test('refreshes only affected messages and preserves rendered formulas and unchanged nodes', async () => {
  const conversation = {
    messages: [
      { id: 'first', role: 'assistant', markdown: 'Equation $y$ and ![Azure image](https://abc123.blob.core.windows.net/container/image.png?sv=2025-01-01&se=2030-01-01&sig=private)' },
      { id: 'second', role: 'assistant', markdown: '![Other image](gpt-exporter-asset:other)' }
    ],
    assets: [
      { id: 'ignored', messageId: 'second', kind: 'image', status: 'ready', url: 'https://abc123.blob.core.windows.net/container/image.png?sv=2025-01-01&se=2030-01-01&sig=private', dataUrl: imageData },
      { id: 'first-image', messageId: 'first', kind: 'image', name: 'azure.png', status: 'pending', url: 'https://abc123.blob.core.windows.net/container/image.png?sv=2025-01-01&se=2030-01-01&sig=private' },
      { id: 'duplicate-path', messageId: 'first', kind: 'image', status: 'ready', url: 'https://abc123.blob.core.windows.net/container/image.png?sv=2025-01-01&se=2030-01-01&sig=other', dataUrl: imageData },
      { id: 'report', messageId: 'first', kind: 'attachment', name: 'report.pdf', status: 'pending' },
      { id: 'other', messageId: 'second', kind: 'image', status: 'pending' },
      { id: 'other', messageId: 'second', kind: 'image', status: 'ready', dataUrl: imageData }
    ]
  };
  const api = global.GptExporter;
  const container = dom.window.document.createElement('div');
  container.innerHTML = api.renderHtmlFragment(conversation, { includeMetadata: false });
  await api.enhanceRichContent(container, conversation);

  const first = container.querySelector('[data-message-id="first"]');
  const second = container.querySelector('[data-message-id="second"]');
  const formula = first.querySelector('.ge-rendered-math');
  assert.ok(formula);
  assert.match(first.querySelector('.ge-unavailable-image').textContent, /正在读取图片/);
  assert.match(first.querySelector('.ge-attachments').textContent, /正在读取附件/);
  const otherPlaceholder = second.querySelector('.ge-unavailable-image');
  assert.ok(otherPlaceholder);

  const [, image, , attachment, other] = conversation.assets;
  Object.assign(image, { status: 'unavailable', error: 'HTTP 403 from https://example.test/?sig=private' });
  Object.assign(attachment, { status: 'unavailable', error: 'HTTP 404' });
  Object.assign(other, { status: 'ready', dataUrl: imageData });
  const renderCount = katexOptions.length;
  api.refreshRichAssets(container, conversation, [image, 'report']);
  assert.match(first.querySelector('.ge-unavailable-image').textContent, /HTTP 403/);
  assert.match(first.querySelector('.ge-attachments').textContent, /HTTP 404/);
  assert.equal(second.querySelector('.ge-unavailable-image'), otherPlaceholder);

  Object.assign(image, { status: 'ready', dataUrl: imageData });
  Object.assign(attachment, { status: 'ready', dataUrl: pdfData });
  api.refreshRichAssets(container, conversation, [image, attachment]);
  const readyImage = first.querySelector('.ge-ready-image');
  const readyAttachment = first.querySelector('.ge-attachment-download');
  assert.equal(readyImage.getAttribute('src'), imageData);
  assert.equal(readyAttachment.getAttribute('href'), pdfData);
  api.refreshRichAssets(container, conversation, [image, attachment]);
  assert.equal(first.querySelector('.ge-ready-image'), readyImage);
  assert.equal(first.querySelector('.ge-attachment-download'), readyAttachment);
  assert.equal(first.querySelector('.ge-rendered-math'), formula);
  assert.equal(katexOptions.length, renderCount);

  api.refreshRichAssets(container, conversation, ['other']);
  assert.equal(second.querySelector('.ge-ready-image').getAttribute('src'), imageData);
  const snapshot = await api.snapshotRichContent(container);
  assert.doesNotMatch(snapshot.innerHTML, /data-ge-(?:image-ref|asset-id|alt)|sig=|blob\.core\.windows\.net/);
});

test('keeps a snapshot of ordinary content detached from layout', async () => {
  const container = dom.window.document.createElement('div');
  container.innerHTML = '<p>plain content</p>';
  container.getBoundingClientRect = () => { throw new Error('ordinary content should skip measurement'); };
  const snapshot = await global.GptExporter.snapshotRichContent(container);
  assert.equal(snapshot.innerHTML, '<p>plain content</p>');
  assert.equal(snapshot.isConnected, false);
});

test('refreshes a deduplicated image in every message with an explicit asset reference', async () => {
  const shared = {
    id: 'shared-image',
    messageId: 'owner',
    kind: 'image',
    status: 'pending',
    url: 'https://files.oaiusercontent.com/shared.png?sig=private'
  };
  const conversation = {
    messages: [
      { id: 'owner', role: 'assistant', assetIds: [shared.id], markdown: '![Owner](gpt-exporter-asset:shared-image)' },
      { id: 'reused', role: 'assistant', assetIds: [shared.id], markdown: '![Reused](gpt-exporter-asset:shared-image) ![URL only](https://files.oaiusercontent.com/shared.png?sig=private)' },
      { id: 'unrelated', role: 'assistant', markdown: '![Unlisted](gpt-exporter-asset:shared-image)' }
    ],
    assets: [shared]
  };
  const api = global.GptExporter;
  const container = dom.window.document.createElement('div');
  container.innerHTML = api.renderHtmlFragment(conversation);
  await api.enhanceRichContent(container, conversation);

  const owner = container.querySelector('[data-message-id="owner"]');
  const reused = container.querySelector('[data-message-id="reused"]');
  const unrelated = container.querySelector('[data-message-id="unrelated"]');
  assert.match(owner.querySelector('.ge-unavailable-image').textContent, /正在读取图片/);
  assert.match(reused.querySelector('.ge-unavailable-image').textContent, /正在读取图片/);

  Object.assign(shared, { status: 'ready', dataUrl: imageData, mimeType: 'image/png' });
  api.refreshRichAssets(container, conversation, [shared]);
  assert.equal(owner.querySelector('img').getAttribute('src'), imageData);
  assert.equal(reused.querySelector('img').getAttribute('src'), imageData);
  assert.equal(reused.querySelector('img').alt, 'Reused');
  assert.match(reused.querySelector('.ge-unavailable-image').textContent, /URL only/);
  assert.equal(unrelated.querySelector('img'), null);

  shared.mimeType = 'image/jpeg';
  api.refreshRichAssets(container, conversation, [shared.id]);
  assert.equal(owner.querySelector('img'), null);
  assert.equal(reused.querySelector('img'), null);
});
