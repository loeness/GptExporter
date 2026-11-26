'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const extension = path.join(root, 'extension');
const output = path.join(root, 'test-results', 'comparison-views-' + Date.now());
const bundledPython = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const python = process.env.GPT_EXPORTER_TEST_PYTHON || (fs.existsSync(bundledPython) ? bundledPython : 'python');
const executablePath = process.env.GPT_EXPORTER_CHROMIUM_EXECUTABLE;
const shareId = '77777777-7777-4777-8777-777777777777';
const userId = '88888888-8888-4888-8888-888888888888';
const assistantId = '99999999-9999-4999-8999-999999999999';
const sharePath = '/share/' + shareId;
const question = 'How do these garden watering schedules compare?';
const introduction = 'Each schedule covers the same garden.';
const conclusion = 'Choose a schedule that matches the available water.';
const scenarios = [
  { label: 'Morning & evening', value: 0, rows: [['Water volume', '11 liters'], ['Window', '06:00 | 18:00']] },
  { label: 'Midday [shade]', value: 1, rows: [['Water volume', '24 liters'], ['Window', '12:30']] },
  { label: 'Overnight *slow*', value: 2, rows: [['Water volume', '37 liters'], ['Window', '<early dawn>']] }
];
const headings = ['Measure', 'Observed value'];
const fallback = [introduction, '', ...scenarios.map(({ label }) => '- ' + label), '',
  'Current selection unavailable.', '', conclusion].join('\n');
const code = `
function __dilSafe(evaluate, failureValue) {
  try { return evaluate(); } catch { return failureValue; }
}
document.documentElement.dataset.comparisonSourceRan = 'true';
DIL.render(__dil.jsx(() => {
  const __dilConstants = DIL.useConstants();
  const [schedule, setSchedule] = DIL.useState(0, { key: 'schedule' });
  return __dil.jsx('column', null, __dil.jsx('card', null,
    __dilSafe(() => __dil.jsx('segmented-control', {
      options: __dilConstants['1'], value: schedule, onChange: setSchedule
    }), null),
    __dil.jsx('box', null,
      __dil.jsx('row', null,
        __dil.jsx('text', { header: true }, 'Measure'),
        __dil.jsx('text', { header: true }, 'Observed value')),
      __dilSafe(() => __dilConstants['2'][schedule].map(row => __dil.jsx('row', null,
        __dil.jsx('text', null, row[0]), __dil.jsx('text', null, row[1])
      )), [])
    )
  ));
}));
`;

function sharedPage() {
  const transcript = {
    rows: [
      { key: userId, origin: 'server', frame: { id: userId, role: 'user', text: question } },
      {
        key: assistantId,
        origin: 'server',
        frame: { id: assistantId, role: 'assistant', text: fallback },
        source: {
          messageId: assistantId,
          publicShareId: shareId,
          dil: {
            kind: 'dil', renderer: 'dil-v2', code, fallbackMarkdown: fallback, viewState: { root: {} },
            constants: {
              1: scenarios.map(({ label, value }) => ({ label, value })),
              2: scenarios.map(({ rows }) => rows)
            }
          }
        }
      }
    ]
  };
  const json = JSON.stringify(transcript).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>Garden fixture</title>
    <script id="octane-conversation-transcript" type="application/json">${json}</script>
    <main><article data-testid="conversation-turn-1">
      <div data-message-author-role="assistant" data-message-id="${assistantId}">Synthetic DOM fallback</div>
    </article></main>`;
}

function assertComparisonText(text) {
  const body = text.replace(/\s+/g, ' ');
  const snippets = [question, introduction, ...scenarios.flatMap(({ label, rows }) =>
    [label, ...rows.map(([, value]) => value)]), conclusion];
  let offset = 0;
  for (const snippet of snippets) {
    const index = body.indexOf(snippet, offset);
    assert.ok(index >= 0, `Missing or out of order: ${snippet}\n${body}`);
    offset = index + snippet.length;
  }
  assert.doesNotMatch(body, /Current selection unavailable|Synthetic DOM fallback|__dil|comparisonSourceRan|DIL\.render/);
}

async function assertComparisonTables(container) {
  const labels = container.locator('h4');
  await labels.last().waitFor();
  assert.deepEqual(await labels.allTextContents(), scenarios.map(({ label }) => label));
  const tables = container.locator('table');
  assert.equal(await tables.count(), scenarios.length);
  for (const [index, { rows }] of scenarios.entries()) {
    const table = tables.nth(index);
    assert.deepEqual(await table.locator('th').allTextContents(), headings);
    const actual = await table.locator('tbody tr').evaluateAll(items => items.map(row =>
      Array.from(row.cells, cell => cell.textContent)));
    assert.deepEqual(actual, rows);
  }
  assert.equal(await container.locator('script, iframe').count(), 0);
  assertComparisonText(await container.innerText());
}

function assertPdf(file) {
  const inspect = `
import json, sys
from pypdf import PdfReader
print(json.dumps('\\n'.join(page.extract_text() or '' for page in PdfReader(sys.argv[1]).pages)))
`;
  const result = execFileSync(python, ['-c', inspect, file], { encoding: 'utf8' });
  assertComparisonText(JSON.parse(result));
}

async function readerDownload(reader, selector, name) {
  const pending = reader.waitForEvent('download');
  await reader.locator(selector).click();
  const file = path.join(output, name);
  await (await pending).saveAs(file);
  return file;
}

async function quickPdf(chat, worker) {
  const downloads = () => worker.evaluate(() => chrome.downloads.search({}));
  const previous = new Set((await downloads()).map(item => item.id));
  await chat.bringToFront();
  await chat.locator('#gpt-exporter-menu-toggle').click();
  await chat.locator('#gpt-exporter-selection-menu [data-preset="all"]').click();
  await chat.waitForFunction(() => document.querySelector('#gpt-exporter-launcher')?.shadowRoot
    ?.querySelector('.status')?.textContent.includes('已导出 2 条消息为 PDF'), null, { timeout: 60000 });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const item of (await downloads()).filter(item => !previous.has(item.id))) {
      assert.notEqual(item.state, 'interrupted', `Quick PDF download interrupted: ${item.error}`);
      if (item.state === 'complete' && fs.existsSync(item.filename)) {
        const file = path.join(output, 'comparison-quick.pdf');
        fs.copyFileSync(item.filename, file);
        return file;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail('Quick PDF download did not complete');
}

async function run() {
  const downloadsPath = path.join(output, 'downloads');
  fs.mkdirSync(downloadsPath, { recursive: true });
  const context = await chromium.launchPersistentContext(path.join(output, 'profile'), {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    headless: true, acceptDownloads: true, downloadsPath, viewport: { width: 1440, height: 1000 },
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
  });
  try {
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://chatgpt.com' && url.pathname === sharePath && route.request().isNavigationRequest()) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: sharedPage() });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const chat = await context.newPage();
    await chat.goto('https://chatgpt.com' + sharePath);
    const pending = context.waitForEvent('page');
    await chat.locator('#gpt-exporter-select').click();
    const reader = await pending;
    await assertComparisonTables(reader.locator('#preview-content'));

    const htmlFile = await readerDownload(reader, '[data-format="html"]', 'comparison.html');
    const offline = await context.newPage();
    await offline.goto(pathToFileURL(htmlFile).href);
    await assertComparisonTables(offline.locator('body'));
    await offline.close();

    await reader.locator('[data-format="pdf"]').click();
    await reader.waitForFunction(() => document.querySelector('#pdf-preview-frame')?.src.startsWith('blob:'));
    assertPdf(await readerDownload(reader, '#pdf-preview-download', 'comparison-reader.pdf'));
    assertPdf(await quickPdf(chat, worker));

    assert.equal(await chat.locator('html').getAttribute('data-comparison-source-ran'), null);
    assert.deepEqual(errors, []);
    console.log(`Comparison reader, HTML, PDF preview and quick PDF checks passed. Output: ${output}`);
  } finally {
    await context.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
