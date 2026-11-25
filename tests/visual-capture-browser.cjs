'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const executablePath = process.env.GPT_EXPORTER_CHROMIUM_EXECUTABLE;
const bundledPython = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const python = process.env.GPT_EXPORTER_TEST_PYTHON || (fs.existsSync(bundledPython) ? bundledPython : 'python');
const chatUrl = 'https://chat.qwen.ai/chat/visual-capture-fixture';
const demoUrl = 'https://flow-fixture.invalid/demo';
const chartColor = [154, 52, 180];
const firstColor = [210, 52, 33];
const secondColor = [29, 103, 191];
const expectedColors = [chartColor, firstColor, secondColor, firstColor];

const chatHtml = `<!doctype html><meta charset="utf-8"><title>Visual capture fixture</title><link rel="icon" href="data:,">
  <main><div class="qwen-chat-message-user" data-message-id="u1"><div class="message-content"><p>Show chart and steps.</p></div></div>
  <div class="qwen-chat-message-assistant" data-message-id="a1"><div class="message-content"><p>VISUAL_CAPTURE_FIXTURE</p></div></div>
  <svg id="source-chart" style="position:fixed;left:50px;top:150px" width="240" height="160" aria-label="Fixture chart">
    <rect width="240" height="160" fill="rgb(${chartColor.join(',')})"/>
  </svg>
  <iframe title="External flow" src="${demoUrl}" style="position:fixed;top:150px;left:450px;width:360px;height:260px;border:0"></iframe></main>`;

const demoHtml = `<!doctype html><meta charset="utf-8"><title>External flow fixture</title>
  <style>body { margin: 0 } canvas { display: block }</style>
  <canvas width="260" height="170"></canvas><button id="step">Next or reset</button>
  <script>
    const canvas = document.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    let step = 0;
    function draw() {
      canvas.dataset.step = step;
      ctx.fillStyle = step ? 'rgb(${secondColor.join(',')})' : 'rgb(${firstColor.join(',')})';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    document.querySelector('button').addEventListener('click', event => {
      if (!event.isTrusted) throw new Error('Expected a real pointer click');
      step = 1 - step;
      draw();
    });
    draw();
  </script>`;

async function selectRegion(chat, host, source, width, height) {
  const box = await source.boundingBox();
  assert.ok(box && box.width >= width + 20 && box.height >= height + 20, 'Fixture is wholly visible');
  await host.locator('#select').click();
  await host.locator('#selector').waitFor();
  const hit = await host.evaluate((element, point) => element.shadowRoot.elementFromPoint(...point)?.id, [box.x + 10, box.y + 10]);
  assert.equal(hit, 'selector', 'Selection layer receives the drag instead of underlying page content');
  await chat.mouse.move(box.x + 10, box.y + 10);
  await chat.mouse.down();
  await chat.mouse.move(box.x + 10 + width, box.y + 10 + height, { steps: 4 });
  await chat.mouse.up();
  await host.locator('#selector').waitFor({ state: 'hidden', timeout: 5000 });
  await host.locator('#outline').waitFor();
}

async function waitForFrames(host, count) {
  try {
    await host.locator('#count').getByText(`已保存 ${count} / 24 帧`, { exact: true }).waitFor({ timeout: 12000 });
  } catch (error) {
    throw new Error(`Expected ${count} captured frames. Capture status: ${await host.locator('#status').textContent()}`, { cause: error });
  }
}

function inspectPdf(file) {
  const script = `
import json, sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
colors = []
for page in reader.pages:
    objects = page['/Resources'].get('/XObject', {})
    for operands, operator in page.get_contents().operations:
        if operator != b'Do' or operands[0] not in objects:
            continue
        name = operands[0]
        if objects[name].get('/Subtype') != '/Image':
            continue
        image = page.images[name].image.convert('RGB')
        colors.append(image.getpixel((image.width // 2, image.height // 2)))
print(json.dumps({
    'text': '\\n'.join(page.extract_text() or '' for page in reader.pages),
    'images': colors
}))
`;
  const result = JSON.parse(execFileSync(python, ['-c', script, file], { encoding: 'utf8' }));
  assert.match(result.text, /VISUAL_CAPTURE_FIXTURE/);
  const uniqueColors = expectedColors.slice(0, 3);
  const classify = pixel => uniqueColors.findIndex(color =>
    pixel.every((value, index) => Math.abs(value - color[index]) <= 3));
  assert.deepEqual(result.images.map(classify).filter(index => index !== -1), [0, 1, 2, 1],
    `PDF paints chart, A, B and revisited A in order. Found: ${JSON.stringify(result.images)}`);
}

async function assertPdfExports(context, chat, reader, worker, temp) {
  await reader.locator('[data-format="pdf"]').click();
  await reader.waitForFunction(() => document.querySelector('#pdf-preview-frame')?.src.startsWith('blob:') &&
    !document.querySelector('#pdf-preview-download').disabled, null, { timeout: 60000 });
  const pending = reader.waitForEvent('download', { timeout: 60000 });
  await reader.locator('#pdf-preview-download').click();
  const previewFile = path.join(temp, 'preview.pdf');
  await (await pending).saveAs(previewFile);
  inspectPdf(previewFile);

  const getDownloads = () => worker.evaluate(() => chrome.downloads.search({}));
  const before = new Set((await getDownloads()).map(item => item.id));
  await chat.bringToFront();
  await chat.locator('#gpt-exporter-menu-toggle').click();
  await chat.locator('#gpt-exporter-selection-menu [data-preset="all"]').click();
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    for (const item of (await getDownloads()).filter(item => !before.has(item.id))) {
      assert.notEqual(item.state, 'interrupted', `Quick export interrupted: ${item.error}`);
      if (item.state === 'complete' && fs.existsSync(item.filename)) {
        inspectPdf(item.filename);
        assert.equal(context.pages().filter(page => page.url().includes('/reader.html')).length, 1);
        return;
      }
    }
    const status = await chat.locator('#gpt-exporter-launcher .status').textContent();
    assert.doesNotMatch(status, /失败|错误|超时|无法/);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.fail('Quick PDF did not complete.');
}

async function assertOfflineHtml(context, reader, output) {
  const pending = reader.waitForEvent('download');
  await reader.locator('[data-format="html"]').click();
  const file = path.join(output, 'captured.html');
  await (await pending).saveAs(file);
  const offline = await context.newPage();
  await offline.goto(pathToFileURL(file).href);
  const images = offline.locator('img[alt^="画面 "]');
  await images.last().waitFor();
  assert.deepEqual(await images.evaluateAll(nodes => nodes.map(node => [node.alt, node.src.startsWith('data:image/png;base64,'), node.naturalWidth > 0])),
    expectedColors.map((_, index) => [`画面 ${index + 1}`, true, true]));
  await offline.close();
}

async function run() {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const tempPrefix = 'gpt-exporter-visual-capture-';
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, tempPrefix)));
  const extension = path.join(temp, 'extension');
  let context;
  try {
    fs.cpSync(path.join(root, 'extension'), extension, { recursive: true });
    const manifestPath = path.join(extension, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // The headless popup is loaded as an extension page. It does not grant activeTab.
    // Use an isolated manifest to exercise Chromium's real captureVisibleTab implementation.
    manifest.host_permissions.push('<all_urls>');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      ...(executablePath ? { executablePath } : { channel: 'chromium' }),
      headless: true,
      acceptDownloads: true,
      downloadsPath: path.join(temp, 'downloads'),
      viewport: null,
      args: ['--window-size=1200,900', '--force-device-scale-factor=1', '--disable-extensions-except=' + extension, '--load-extension=' + extension]
    });
    await context.route(/^https?:\/\//, route => {
      const url = route.request().url();
      const body = url === chatUrl ? chatHtml : url === demoUrl ? demoHtml : null;
      return body ? route.fulfill({ contentType: 'text/html; charset=utf-8', body }) : route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionUrl = 'chrome-extension://' + new URL(worker.url()).hostname;
    const popup = await context.newPage();
    await popup.goto(extensionUrl + '/popup.html');
    const chat = await context.newPage();
    await chat.goto(chatUrl);
    await chat.bringToFront();
    await chat.locator('#gpt-exporter-launcher').waitFor();
    await popup.evaluate(() => { document.getElementById('start-visual-capture').click(); });
    const host = chat.locator('#gpt-exporter-visual-capture');
    await host.waitFor();

    const scale = await chat.evaluate(() => devicePixelRatio);
    const chartSize = [160, 100];
    const flowSize = [180, 120];
    await selectRegion(chat, host, chat.locator('#source-chart'), ...chartSize);
    await host.locator('#save').click();
    await waitForFrames(host, 1);

    const demo = chat.frameLocator('iframe[title="External flow"]');
    await selectRegion(chat, host, demo.locator('canvas'), ...flowSize);
    await host.locator('#record').click();
    await waitForFrames(host, 2);
    await demo.getByRole('button', { name: 'Next or reset' }).click();
    await waitForFrames(host, 3);
    await demo.getByRole('button', { name: 'Next or reset' }).click();
    await waitForFrames(host, 4);
    await host.locator('#record').click();
    await host.locator('#close').click();

    const page = context.waitForEvent('page');
    await chat.locator('#gpt-exporter-select').click();
    const reader = await page;
    const images = reader.locator('#preview-content img[alt^="画面 "]');
    await images.last().waitFor();
    await reader.waitForFunction(() => {
      const images = Array.from(document.querySelectorAll('#preview-content img[alt^="画面 "]'));
      return images.length === 4 && images.every(image => image.complete && image.naturalWidth > 0);
    });
    const captures = await images.evaluateAll(images => images.map(image => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return {
        label: image.alt,
        size: [canvas.width, canvas.height],
        pixel: Array.from(context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data)
      };
    }));
    assert.deepEqual(captures, expectedColors.map((rgb, index) => ({
      label: `画面 ${index + 1}`,
      size: (index === 0 ? chartSize : flowSize).map(value => value * scale),
      pixel: [...rgb, 255]
    })));
    await assertOfflineHtml(context, reader, temp);
    await assertPdfExports(context, chat, reader, worker, temp);

    await chat.evaluate(() => history.pushState({}, '', '/chat/another-conversation'));
    const nextPage = context.waitForEvent('page');
    await chat.locator('#gpt-exporter-select').click();
    const nextReader = await nextPage;
    await nextReader.locator('#preview-content').getByText('VISUAL_CAPTURE_FIXTURE').waitFor();
    assert.equal(await nextReader.locator('#preview-content img[alt^="画面 "]').count(), 0, 'Captures are scoped to the original conversation');

    console.log('Visual capture browser regression passed: SVG, cross-origin A → B → A, reader, both PDF paths, offline HTML and route isolation.');
  } finally {
    await context?.close();
    assert.equal(path.dirname(temp), tempRoot);
    assert.ok(path.basename(temp).startsWith(tempPrefix));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
