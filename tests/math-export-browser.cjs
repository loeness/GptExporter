'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const extensionOverride = process.env.GPT_EXPORTER_TEST_EXTENSION;
const extension = path.resolve(extensionOverride || path.join(__dirname, '../extension'));
const outputRoot = path.resolve(__dirname, '../test-results');
fs.mkdirSync(outputRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(outputRoot, 'math-export-'));
const bundledChromium = path.resolve(__dirname, '../../browsers/chromium-1194/chrome-win/chrome.exe');
const executablePath = process.env.GPT_EXPORTER_CHROMIUM_EXECUTABLE || (fs.existsSync(bundledChromium) ? bundledChromium : undefined);
const bundledPython = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
const python = process.env.GPT_EXPORTER_TEST_PYTHON || (fs.existsSync(bundledPython) ? bundledPython : 'python');
const conversationId = '11111111-1111-4111-8111-111111111111';
const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
const timeout = 240000;
const marker = number => `POISSONTURN${String(number).padStart(3, '0')}`;

function explanation(index) {
  return String.raw`先看泊松过程的独立增量，记作 $N(t+h)-N(t)$。强度 $\lambda$ 恒定。

$$\mathbb P(N(t+h)-N(t)=k)=e^{-\lambda h}\frac{(\lambda h)^k}{k!}$$

令 $T_{${index}}$ 为到达时刻，等待时间 $W_{${index}}=T_{${index}+1}-T_{${index}}$。

$$\begin{aligned}\mathbb P(W_{${index}}>u)&=e^{-\lambda u} \\ \mathbb E[W_{${index}}]&=\int_0^\infty e^{-\lambda u}\,du=\frac1\lambda\end{aligned}$$

复合泊松过程记为 $S(t)$，并令 $\mu_{${index}}=\mathbb E[X_{${index}}]$。

$$S(t)=\sum_{j=1}^{N(t)} X_j,\qquad \operatorname{Var}(S(t))=\lambda t\,\mathbb E[X_1^2]$$

标准差 $\sqrt{\lambda t\,\mathbb E[X_1^2]}$ 给出波动的量级。

$$\mathbb P(N(s)=${index}\mid N(t)=${index + 2})=\binom{${index + 2}}{${index}}\left(\frac{s}{t}\right)^{${index}}\left(1-\frac{s}{t}\right)^2$$

最后令 $M_{${index}}(t)=\int_0^t r_{${index}}(u)\,du$。

$$\begin{aligned}\Lambda(t)&=\int_0^t \lambda(u)\,du\\ \mathbb E[N(t)]&=\Lambda(t)\end{aligned}$$`;
}

const formulaTable = String.raw`## Count distribution $\mathbb E[N(19)]=19\lambda$

| Quantity $\lambda h$ | Expression |
| --- | --- |
| Increment law | $e^{-\lambda h}\frac{(\lambda h)^k}{k!}$ |
| Conditional count | $\mathbb P(N(s)=k\mid N(t)=n)=\binom nk(s/t)^k(1-s/t)^{n-k}$ |`;

function makeFixture() {
  const mapping = { root: { id: 'root', parent: null, children: [], message: null } };
  let number = 0;
  function add(parent, role, content) {
    const id = marker(++number);
    mapping[id] = { id, parent, children: [], message: {
      id, author: { role }, create_time: 1700000000 + number,
      content: { content_type: 'text', parts: [`${id}\n\n${content}`] }, metadata: {}
    } };
    mapping[parent].children.push(id);
    return id;
  }
  function addPairs(parent, count) {
    for (let pair = 0; pair < count; pair++) {
      const user = add(parent, 'user', String.raw`请解释泊松过程中的条件概率 $\mathbb P(N(t)>0)$ 和到达间隔。`);
      const content = [explanation(number), explanation(number + 50), explanation(number)];
      if (number === 1) content.unshift(formulaTable);
      parent = add(user, 'assistant', content.join('\n\n'));
    }
    return parent;
  }
  const common = addPairs('root', 10);
  const current = addPairs(common, 8);
  for (let branch = 0; branch < 3; branch++) addPairs(common, 2);
  return { graph: { conversation_id: conversationId, current_node: current, mapping, title: '泊松过程与条件概率' },
    messages: number, formulas: number / 2 * (1 + 3 * 13) + 4, activeMessages: 36 };
}

function inspectPdf(file, fixture) {
  const source = `
import hashlib, json, re, sys
from pathlib import Path
from PIL import Image
from pypdf import PdfReader
from pypdf.generic import ContentStream
import pypdfium2 as pdfium

path = Path(sys.argv[1])
reader = PdfReader(path)
text = '\\n'.join(page.extract_text() or '' for page in reader.pages)
markers = re.findall(r'POISSONTURN[0-9]{3}', text)
draws = 0
hashes = set()
blank = 0
glyphs_by_object = {}
for page in reader.pages:
    for args, operation in ContentStream(page.get_contents(), reader).operations:
        if operation != b'Do':
            continue
        resource = page['/Resources']['/XObject'][args[0]]
        if resource['/Subtype'] != '/Image':
            continue
        draws += 1
        resource_id = resource.indirect_reference.idnum
        if resource_id not in glyphs_by_object:
            image = page.images[str(args[0])].image.convert('RGBA')
            on_white = Image.alpha_composite(Image.new('RGBA', image.size, 'white'), image).convert('L')
            glyphs_by_object[resource_id] = (hashlib.sha256(image.tobytes()).hexdigest(), on_white.getextrema()[0] < 180)
        digest, visible = glyphs_by_object[resource_id]
        hashes.add(digest)
        blank += not visible
assert '泊松过程' in text and '条件概率' in text, 'Missing searchable CJK text'
assert '未转换的公式' not in text, 'Formula fallback leaked into the PDF'
for label in ('Count distribution', 'Quantity', 'Expression', 'Increment law', 'Conditional count'):
    assert label in text, f'Missing searchable heading or table label: {label}'
assert not re.search(r'\\\\(?:mathbb|lambda|frac|mid|binom)\\b', text), 'Raw TeX leaked into the PDF'
document = pdfium.PdfDocument(str(path))
for index in [0, len(document) // 2, len(document) - 1]:
    page = document[index]
    page.render(scale=1.5).to_pil().save(path.parent / f'page-{index + 1}.png')
    page.close()
print(json.dumps(dict(markers=markers, pages=len(reader.pages), formulaDraws=draws, distinctGlyphImages=len(hashes), blankImages=blank)))
`;
  const pdf = JSON.parse(execFileSync(python, ['-c', source, file], { encoding: 'utf8', timeout }));
  assert.deepEqual(pdf.markers, Array.from({ length: fixture.messages }, (_, index) => marker(index + 1)));
  assert.equal(pdf.formulaDraws, fixture.formulas, 'every inline and display formula is drawn in the PDF');
  assert.equal(pdf.blankImages, 0, 'every formula image contains visible glyph pixels');
  assert.ok(pdf.distinctGlyphImages >= 100, 'different TeX keeps distinct rendered glyphs');
  assert.ok(pdf.pages > 1, 'the transcript spans multiple pages');
  const { markers, ...summary } = pdf;
  return { bytes: fs.statSync(file).size, ...summary };
}

async function run() {
  const fixture = makeFixture();
  const pageHtml = `<!doctype html><meta charset="utf-8"><title>Poisson fixture - ChatGPT</title><main><article data-testid="conversation-turn-36"><div data-message-author-role="assistant" data-message-id="${fixture.graph.current_node}"><p>泊松过程。</p></div></article></main>`;
  const context = await chromium.launchPersistentContext(path.join(output, 'profile'), {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const errors = [];
  const unexpectedRequests = [];
  try {
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://chatgpt.com') {
        const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        if (url.pathname === '/api/auth/session') return json({ accessToken: 'fixture-only-token' });
        if (url.pathname === `/backend-api/conversation/${conversationId}`) return json(fixture.graph);
        if (url.href === conversationUrl || url.pathname === '/favicon.ico') {
          return route.fulfill({ contentType: 'text/html;charset=utf-8', body: pageHtml });
        }
      }
      unexpectedRequests.push(url.href);
      return route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => {
      const fetchLocal = fetch.bind(globalThis);
      globalThis.fetch = (resource, options) => {
        const url = new URL(typeof resource === 'string' ? resource : resource.url);
        if (url.protocol === 'chrome-extension:') return fetchLocal(resource, options);
        throw new Error(`Unexpected worker request: ${url.href}`);
      };
    });
    const chat = await context.newPage();
    await chat.goto(conversationUrl);
    const readerStarted = performance.now();
    const readerPromise = context.waitForEvent('page', { timeout });
    await chat.locator('#gpt-exporter-select').click();
    const reader = await readerPromise;
    await reader.waitForFunction(count => document.querySelectorAll('#preview-content article').length === count, fixture.activeMessages);
    assert.equal(await reader.locator('#branch-select option').count(), 5, 'four branches plus all branches');
    await reader.locator('#branch-select').selectOption('__all');
    await reader.waitForFunction(count => document.querySelectorAll('#preview-content [data-ge-rendered="true"].ge-math-source').length === count,
      fixture.formulas, { timeout: 60000 }).catch(async error => {
      const rendered = await reader.locator('#preview-content [data-ge-rendered="true"].ge-math-source').count();
      throw new Error(`Expected ${fixture.formulas} rendered formulas in the reader, found ${rendered}`, { cause: error });
    });
    const preview = reader.locator('#preview-content');
    const renderedMath = '[data-ge-rendered="true"].ge-math-source';
    assert.equal(await preview.locator('h2').filter({ hasText: 'Count distribution' }).locator(renderedMath).count(), 1);
    assert.equal(await preview.locator('thead').locator(renderedMath).count(), 1);
    assert.equal(await preview.locator('tbody').locator(renderedMath).count(), 2);
    const readerPreviewMs = Math.round(performance.now() - readerStarted);
    await reader.evaluate(() => {
      const render = GptExporterVendors.renderMathSvg;
      let calls = 0;
      GptExporterVendors.renderMathSvg = (...args) => { calls++; return render(...args); };
      window.mathVectorCalls = () => calls;
    });

    const file = path.join(output, 'reader.pdf');
    const pdfStarted = performance.now();
    await reader.locator('[data-format="pdf"]').click();
    await reader.locator('#pdf-preview-dialog').waitFor({ state: 'visible', timeout });
    await reader.waitForFunction(() => document.querySelector('#pdf-preview-frame')?.src.startsWith('blob:'), null, { timeout });
    const pendingDownload = reader.waitForEvent('download', { timeout });
    await reader.locator('#pdf-preview-download').click();
    await (await pendingDownload).saveAs(file);
    const readerPdfMs = Math.round(performance.now() - pdfStarted);
    const pdf = inspectPdf(file, fixture);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
    const vectorCalls = await reader.evaluate(() => window.mathVectorCalls());
    if (!extensionOverride) {
      assert.ok(vectorCalls > 0 && vectorCalls <= fixture.formulas / 2,
        `Repeated equations should reuse raster snapshots. Rendered ${vectorCalls} of ${fixture.formulas} equations.`);
    }
    const report = { extension, messages: fixture.messages, branches: 4, formulas: fixture.formulas, readerPreviewMs,
      readerPdfMs, vectorCalls, ...pdf, output };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await context.close();
  }
}

run().catch(error => {
  fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
  console.error(error);
  process.exitCode = 1;
});
