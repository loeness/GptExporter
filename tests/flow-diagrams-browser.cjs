'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
const output = path.join(root, 'test-results', 'flow-diagrams-' + Date.now());
const bundledPython = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const python = process.env.GPT_EXPORTER_TEST_PYTHON || (fs.existsSync(bundledPython) ? bundledPython : 'python');
const executablePath = process.env.GPT_EXPORTER_CHROMIUM_EXECUTABLE;
const conversationId = '55555555-5555-4555-8555-555555555555';
const series = '累计增广流量';
const totals = [0, 2, 4, 5];
const chart = '\uE200genui\uE202' + JSON.stringify({ charts_widget_v2: { content: {
  chartType: 'line', xKey: '轮次', series: [{ dataKey: 'flow', label: series }],
  yAxisMin: 0, yAxisMax: 5,
  data: totals.map((flow, index) => ({ 轮次: index, flow }))
} } }) + '\uE201';
const answer = String.raw`这个例子有 4 个顶点、5 条边。

## 1. 初始网络

所有边初始 Flow = 0，数字表示 Capacity。

## 2. 逐轮执行 Ford–Fulkerson

当前总流量

# / 5

增广进度： / 3 轮

增加流量

撤销流量

---

[上一轮] [重置] [下一轮]

### Round 1：增广

$$s\to a\to b\to t$$

$$b_{1}=\min(3,2,3)=2$$

### Round 2：增广

$$s\to b\overset{\text{backward}}{\longrightarrow}a\to t$$

$$b_{2}=\min(2,2,2)=2$$

### Round 3：增广

$$s\to a\to b\to t$$

$$b_{3}=\min(1,2,1)=1$$

## 3. 检验

最终总流量为 5。FLOW-PDF-FIXTURE

${chart}

### SVG diagram fixture

~~~svg
<svg xmlns="http://www.w3.org/2000/svg" width="222" height="84" viewBox="0 0 222 84">
  <rect x="12" y="12" width="198" height="60" rx="8" fill="#347253"/>
  <text x="25" y="47" fill="#ffffff">SVG-RASTER-FIXTURE</text>
</svg>
~~~

### Mermaid diagram fixture

~~~mermaid
flowchart LR
  A[MERMAID-START-FIXTURE] --> B[MERMAID-END-FIXTURE]
~~~

保留末尾正文。FLOW-PDF-END`;

function conversation() {
  function message(id, role, parent, children, value) {
    return { id, parent, children, message: {
      id, author: { role }, create_time: 1700000000, metadata: {},
      content: { content_type: 'text', parts: [value] }
    } };
  }
  return { conversation_id: conversationId, title: 'Flow export synthetic fixture', current_node: 'a', mapping: {
    root: { id: 'root', parent: null, children: ['u'], message: null },
    u: message('u', 'user', 'root', ['a'], '请逐轮展示增广流程。'),
    a: message('a', 'assistant', 'u', [], answer)
  } };
}

function readPdf(file) {
  const inspect = `
import hashlib, json, sys
from pypdf import PdfReader

reader = PdfReader(sys.argv[1])
images = {}
for page in reader.pages:
    for entry in page.images:
        image = entry.image.convert('RGB')
        pixels = image.tobytes()
        colors = dict((color, count) for count, color in image.getcolors(image.width * image.height))
        details = {
            'size': list(image.size),
            'ink': sum(count for color, count in colors.items() if min(color) < 230),
            'curvePixels': colors.get((19, 93, 163), 0),
            'svgPixels': colors.get((52, 114, 83), 0)
        }
        if image.size == (1520, 780):
            # Marker centers for 0, 2, 4 and 5 in the 0–5 plotting domain.
            centers = [(244, 654), (648, 455), (1052, 256), (1456, 156)]
            details['chartMarkers'] = [image.getpixel(center) == (19, 93, 163) for center in centers]
        images[hashlib.sha256(pixels).hexdigest()] = details
print(json.dumps({'text': '\\n'.join(page.extract_text() or '' for page in reader.pages), 'images': images}, ensure_ascii=False))
`;
  return JSON.parse(execFileSync(python, ['-c', inspect, file], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
}

function assertPdf(pdf) {
  const body = pdf.text.replace(/\s/g, '');
  for (const total of totals) assert.ok(body.includes('当前总流量' + total), `Flow caption for total ${total} is missing`);
  for (const phrase of [series, '最终总流量为5', 'FLOW-PDF-FIXTURE', 'FLOW-PDF-END']) assert.ok(body.includes(phrase), `Missing PDF text: ${phrase}`);
  assert.doesNotMatch(body, /[\uE200-\uE202]|charts_widget_v2|&(?:lt|quot);|\\u[0-9a-f]{4}|chartType|下一轮|增广进度|flowchartLR|<svg/i);
  const images = Object.values(pdf.images);
  const flowImages = images.filter(image => image.size.join('x') === '1520x660');
  assert.equal(flowImages.length, 4, 'PDF contains four distinct network snapshots');
  assert.ok(flowImages.every(image => image.ink > 5000), 'The network snapshots have visible content');
  const chartImages = images.filter(image => image.size.join('x') === '1520x780');
  assert.equal(chartImages.length, 1, 'PDF contains the chart raster');
  assert.ok(chartImages[0].curvePixels > 500, 'Chart raster includes the plotted series');
  assert.deepEqual(chartImages[0].chartMarkers, [true, true, true, true], 'Chart plots all four source values');
}

function assertDiagramsAbsent(pdf) {
  assert.doesNotMatch(pdf.text, /SVG diagram fixture|Mermaid diagram fixture|SVG-RASTER-FIXTURE|MERMAID-(?:START|END)-FIXTURE/i);
  assert.ok(Object.values(pdf.images).every(image => image.svgPixels === 0));
}

async function previewPdf(reader, name, previous = '') {
  const frame = await reader.waitForFunction(previousUrl => {
    const url = document.querySelector('#pdf-preview-frame')?.src;
    return url?.startsWith('blob:') && url !== previousUrl && !document.querySelector('#pdf-preview-download').disabled && url;
  }, previous, { timeout: 60000 });
  const url = await frame.jsonValue();
  const pending = reader.waitForEvent('download', { timeout: 60000 });
  await reader.locator('#pdf-preview-download').click();
  const file = path.join(output, name);
  await (await pending).saveAs(file);
  return { url, pdf: readPdf(file) };
}

async function quickPdf(chat, worker) {
  const downloads = () => worker.evaluate(() => chrome.downloads.search({}));
  const before = new Set((await downloads()).map(item => item.id));
  await chat.bringToFront();
  await chat.locator('#gpt-exporter-menu-toggle').click();
  await chat.locator('#gpt-exporter-selection-menu [data-preset="all"]').click();
  await chat.waitForFunction(() => document.querySelector('#gpt-exporter-launcher')?.shadowRoot
    ?.querySelector('.status')?.textContent.includes('已导出 2 条消息为 PDF'), null, { timeout: 120000 });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const item of (await downloads()).filter(item => !before.has(item.id))) {
      assert.notEqual(item.state, 'interrupted', `Quick PDF download was interrupted: ${item.error}`);
      if (item.state === 'complete' && fs.existsSync(item.filename)) {
        const file = path.join(output, 'flow-quick.pdf');
        fs.copyFileSync(item.filename, file);
        return readPdf(file);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail('Quick export did not complete its PDF download');
}

async function run() {
  const downloadsPath = path.join(output, 'downloads');
  fs.mkdirSync(downloadsPath, { recursive: true });
  const context = await chromium.launchPersistentContext(path.join(output, 'profile'), {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true, acceptDownloads: true,
    downloadsPath, viewport: { width: 1440, height: 1000 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
  });
  try {
    const errors = [];
    const outbound = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route(/^https?:\/\//, route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'chatgpt.com') {
        outbound.push(url.origin);
        return route.abort();
      }
      const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/api/auth/session') return json({ accessToken: 'fixture-only-token' });
      if (url.pathname === '/backend-api/conversation/' + conversationId) return json(conversation());
      return route.fulfill({ contentType: 'text/html;charset=utf-8', body: `<!doctype html><title>Flow fixture - ChatGPT</title>
        <main><article data-testid="conversation-turn-1"><div data-message-author-role="assistant" data-message-id="a">Synthetic DOM fallback</div></article></main>` });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const chat = await context.newPage();
    await chat.goto('https://chatgpt.com/c/' + conversationId);
    const pending = context.waitForEvent('page');
    await chat.locator('#gpt-exporter-select').click();
    const reader = await pending;
    const preview = reader.locator('#preview-content');
    const flows = preview.locator('[data-ge-static-demo="flow-network"]');
    await flows.last().waitFor();
    assert.deepEqual(await flows.evaluateAll(figures => figures.map(figure => Number(figure.dataset.geFlowRound))), [0, 1, 2, 3]);
    assert.deepEqual(await flows.locator('figcaption').evaluateAll(captions => captions.map(caption => Number(/当前总流量 (\d+)/.exec(caption.textContent)[1]))), totals);
    assert.match(await flows.nth(1).locator('img').getAttribute('alt'), /a → b 2\/2/);
    assert.match(await flows.nth(2).locator('img').getAttribute('alt'), /a → b 0\/2/);
    assert.match(await flows.nth(3).locator('img').getAttribute('alt'), /a → b 1\/2/);
    const chartImage = preview.locator('.ge-data-chart img');
    await chartImage.waitFor();
    await reader.waitForFunction(() => Array.from(document.querySelectorAll('#preview-content :is(.ge-data-chart, [data-ge-static-demo="flow-network"]) img'))
      .every(image => image.complete && image.naturalWidth > 0));
    assert.match(await chartImage.getAttribute('alt'), new RegExp(series));
    await preview.locator('svg.ge-mermaid-diagram').waitFor();
    assert.doesNotMatch(await preview.innerText(), /Synthetic DOM fallback|[\uE200-\uE202]|charts_widget_v2|增广进度|下一轮/);

    await reader.locator('[data-format="pdf"]').click();
    const checkbox = reader.locator('#pdf-include-diagrams');
    await checkbox.waitFor();
    assert.equal(await checkbox.isChecked(), false, 'Standalone diagrams are opt-in');
    const initial = await previewPdf(reader, 'flow-default.pdf');
    assertPdf(initial.pdf);
    assertDiagramsAbsent(initial.pdf);
    await checkbox.check();
    const enabled = await previewPdf(reader, 'flow-with-diagrams.pdf', initial.url);
    assertPdf(enabled.pdf);
    const added = Object.entries(enabled.pdf.images).filter(([hash]) => !initial.pdf.images[hash]).map(([, image]) => image);
    assert.equal(added.length, 2, 'Opting in adds the SVG and Mermaid rasters');
    assert.equal(added.filter(image => image.svgPixels > 2000).length, 1, 'SVG fixture has its green fill');
    assert.equal(added.filter(image => image.svgPixels === 0 && image.ink > 500).length, 1, 'Mermaid fixture has visible raster content');
    assert.doesNotMatch(enabled.pdf.text, /图表不可用|SVG-RASTER-FIXTURE|MERMAID-(?:START|END)-FIXTURE/);

    const quick = await quickPdf(chat, worker);
    assertPdf(quick);
    assertDiagramsAbsent(quick);
    assert.deepEqual(errors, []);
    assert.deepEqual(outbound, []);
    console.log(`Flow reader, PDF preview and quick PDF checks passed. Output: ${output}`);
  } finally {
    await context.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
