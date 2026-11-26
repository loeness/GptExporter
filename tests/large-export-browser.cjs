'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const extension = path.resolve(process.env.GPT_EXPORTER_TEST_EXTENSION || path.join(__dirname, '../extension'));
const output = path.resolve(__dirname, '../test-results/large-export-' + Date.now());
const bundledChromium = path.resolve(__dirname, '../../browsers/chromium-1194/chrome-win/chrome.exe');
const configuredChromium = process.env.GPT_EXPORTER_CHROMIUM_EXECUTABLE || (fs.existsSync(bundledChromium) ? bundledChromium : undefined);
const bundledPython = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const python = process.env.GPT_EXPORTER_TEST_PYTHON || (fs.existsSync(bundledPython) ? bundledPython : 'python');
const conversationId = '11111111-1111-4111-8111-111111111111';
const messageCount = 320;
const imageCount = 24;
const highResolutionCount = 8;
const pairedPhotoIndex = highResolutionCount + 1;
const timeout = 180000;

function marker(number) {
  return `STRESSMESSAGE${String(number).padStart(4, '0')}`;
}

function conversationGraph() {
  const mapping = { root: { id: 'root', parent: null, children: [], message: null } };
  let parent = 'root';
  for (let number = 1; number <= messageCount; number++) {
    const id = `message-${number}`;
    const user = number % 2 === 1;
    const parts = [marker(number) + (user
      ? ' Can you review the observations from this field visit and summarize the next steps?'
      : ' The notes are consistent with the earlier observations. Record the location and lighting for each photograph, and collect another sample from the same viewpoint. Keep the original notes alongside the revised summary.')];
    if (number % 12 === 1 && (number - 1) / 12 < imageCount) {
      const imageId = (number - 1) / 12;
      if (imageId !== pairedPhotoIndex + 1) {
        parts.push({ content_type: 'image_asset_pointer', asset_pointer: `sediment://file-stress-photo-${imageId}` });
      }
      if (imageId === pairedPhotoIndex) {
        parts.push({ content_type: 'image_asset_pointer', asset_pointer: `sediment://file-stress-photo-${imageId + 1}` });
      }
    }
    mapping[id] = { id, parent, children: [], message: {
      id, author: { role: user ? 'user' : 'assistant' }, create_time: 1700000000 + number * 60,
      content: { content_type: 'multimodal_text', parts }, metadata: {}
    } };
    mapping[parent].children.push(id);
    parent = id;
  }
  return { conversation_id: conversationId, title: 'Field visit notes and uploaded photographs', current_node: parent, mapping };
}

function inspectPdf(file, originals) {
  const source = `
import sys, json, re, hashlib
from pypdf import PdfReader
from pypdf.generic import ContentStream
reader = PdfReader(sys.argv[1])
pair = {photo['digest'] for photo in json.loads(sys.argv[2])}
text = '\\n'.join(page.extract_text() or '' for page in reader.pages)
images = [image for page in reader.pages for image in page.images]
hashes = {hashlib.sha256(image.image.tobytes()).hexdigest() for image in images}
paired_draws = []
for index, page in enumerate(reader.pages):
    resources = page['/Resources'].get('/XObject', {})
    transform = None
    for args, operation in ContentStream(page.get_contents(), reader).operations:
        if operation == b'cm':
            transform = [float(value) for value in args]
        if operation != b'Do':
            continue
        resource = resources[args[0]]
        if resource['/Subtype'] != '/Image':
            continue
        digest = hashlib.sha256(resource.get_data()).hexdigest()
        if digest in pair:
            # PDFKit places an image after its own cm inside the page's top-down coordinate system.
            width, _, _, height, _, offset = transform
            top, bottom = sorted((offset, offset + height))
            paired_draws.append(dict(digest=digest, page=index + 1, pixels=[int(resource['/Width']), int(resource['/Height'])],
                                     width=abs(width), height=abs(height), top=top, bottom=bottom,
                                     pageHeight=float(page.mediabox.height)))
print(json.dumps(dict(markers=re.findall(r'STRESSMESSAGE[0-9]{4}', text), images=len(images),
                      distinctImages=len(hashes), pages=len(reader.pages), pairedDraws=paired_draws)))
`;
  const bytes = fs.statSync(file).size;
  const pdf = JSON.parse(execFileSync(python, ['-c', source, file, JSON.stringify(originals)], { encoding: 'utf8', timeout }));
  assert.deepEqual(pdf.markers, Array.from({ length: messageCount }, (_, index) => marker(index + 1)), 'PDF retains every message in order');
  assert.equal(pdf.images, imageCount, 'PDF contains every uploaded image');
  assert.equal(pdf.distinctImages, imageCount, 'PDF contains distinct decoded image pixels');
  assert.ok(pdf.pages > 1, 'the transcript spans multiple pages');
  assert.deepEqual(pdf.pairedDraws.map(draw => draw.digest), originals.map(photo => photo.digest),
    'both JPEG uploads are embedded byte-for-byte and drawn in order');
  assert.equal(pdf.pairedDraws[0].page, pdf.pairedDraws[1].page, 'both uploads from a single message share a PDF page');
  for (const [index, draw] of pdf.pairedDraws.entries()) {
    const { width, height } = originals[index];
    assert.deepEqual(draw.pixels, [width, height]);
    assert.ok(draw.width > 100 && draw.height > 100, 'each photo is large enough to view');
    assert.ok(draw.height < draw.pageHeight / 2, 'each photo leaves room for a second photo on the page');
    assert.ok(draw.top >= 0 && draw.bottom <= draw.pageHeight, 'the entire photo fits on the page');
    assert.ok(Math.abs(draw.width / draw.height - width / height) < 0.01, 'PDF drawing preserves the photo aspect ratio');
  }
  const [first, second] = pdf.pairedDraws;
  assert.ok(first.bottom <= second.top,
    'paired photos are stacked vertically without overlap');
  return { bytes, pages: pdf.pages, images: pdf.images, distinctImages: pdf.distinctImages, pairedDraws: pdf.pairedDraws };
}

async function generateImage(page, index) {
  return page.evaluate(({ index, highResolutionCount, pairedPhotoIndex }) => {
    const canvas = document.createElement('canvas');
    const large = index < highResolutionCount;
    const portrait = index % 2 === 1 || index === pairedPhotoIndex + 1;
    canvas.width = large ? (portrait ? 2400 : 3200) : (portrait ? 768 : 1024);
    canvas.height = large ? (portrait ? 3200 : 2400) : (portrait ? 1024 : 768);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, `hsl(${index * 43 % 360} 58% 32%)`);
    gradient.addColorStop(1, `hsl(${(index * 43 + 90) % 360} 72% 76%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Seeded textures exercise JPEG compression and produce independent image payloads.
    let randomState = index + 1;
    function random() {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 2 ** 32;
    }
    for (let detail = 0; detail < (large ? 4500 : 1200); detail++) {
      ctx.fillStyle = `hsla(${index * 43 % 360} 35% ${30 + Math.floor(random() * 60)}% / 0.45)`;
      ctx.fillRect(random() * canvas.width, random() * canvas.height, 5 + random() * 58, 5 + random() * 58);
    }
    if (large) {
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let offset = 0; offset < image.data.length; offset += 4) {
        const exposureNoise = (random() - 0.5) * 210;
        image.data[offset] += exposureNoise;
        image.data[offset + 1] += exposureNoise;
        image.data[offset + 2] += exposureNoise;
      }
      ctx.putImageData(image, 0, 0);
    }
    ctx.font = `${Math.round(canvas.width / 16)}px sans-serif`;
    ctx.fillStyle = 'white';
    ctx.fillText(`Field photo ${index + 1}`, canvas.width / 10, canvas.height / 2);
    return { width: canvas.width, height: canvas.height, data: canvas.toDataURL('image/jpeg', large ? 0.97 : 0.9).split(',')[1] };
  }, { index, highResolutionCount, pairedPhotoIndex });
}

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const downloadsPath = path.join(output, 'downloads');
  const context = await chromium.launchPersistentContext(path.join(output, 'profile'), {
    ...(configuredChromium ? { executablePath: configuredChromium } : { channel: 'chromium' }),
    headless: true, acceptDownloads: true, downloadsPath,
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const errors = [];
  const unexpectedRequests = [];
  const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
  const conversations = JSON.stringify(conversationGraph());
  const fixturePage = `<!doctype html><title>Large export fixture - ChatGPT</title><main><article data-testid="conversation-turn-320"><div data-message-author-role="assistant" data-message-id="message-320"><p>${marker(messageCount)}</p></div></article></main>`;
  try {
    context.on('page', page => page.on('pageerror', error => errors.push(error.stack || error.message)));
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://chatgpt.com') {
        const json = body => route.fulfill({ contentType: 'application/json', body });
        if (url.pathname === '/api/auth/session') return json(JSON.stringify({ accessToken: 'fixture-only-token' }));
        if (url.pathname === `/backend-api/conversation/${conversationId}`) return json(conversations);
        const file = url.pathname.match(/^\/backend-api\/files\/download\/file-stress-photo-(\d+)$/);
        if (file && Number(file[1]) < imageCount) {
          return json(JSON.stringify({ download_url: `https://files.oaiusercontent.com/fixture/photo-${file[1]}`, file_name: `photo-${file[1]}.jpg`, mime_type: 'image/jpeg' }));
        }
        if (url.href === conversationUrl || url.pathname === '/favicon.ico') {
          return route.fulfill({ contentType: 'text/html;charset=utf-8', body: fixturePage });
        }
      }
      unexpectedRequests.push(url.href);
      return route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
    const chat = await context.newPage();
    // Worker fetches are outside Playwright page routing. Stub only the signed fixture files.
    await worker.evaluate(() => {
      globalThis.stressFixtures = new Map();
      const originalFetch = globalThis.fetch.bind(globalThis);
      globalThis.fetch = async (resource, options) => {
        const url = new URL(typeof resource === 'string' ? resource : resource.url);
        if (url.protocol === 'chrome-extension:') return originalFetch(resource, options);
        const match = url.href.match(/^https:\/\/files\.oaiusercontent\.com\/fixture\/photo-(\d+)$/);
        const bytes = match && globalThis.stressFixtures.get(Number(match[1]));
        if (!bytes) throw new Error(`Unexpected worker fetch: ${url.href}`);
        return new Response(bytes, { headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length) } });
      };
    });
    const fixtures = [];
    let fixtureBytes = 0;
    for (let index = 0; index < imageCount; index++) {
      const { width, height, data } = await generateImage(chat, index);
      const digest = createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
      fixtures.push({ width, height, digest });
      fixtureBytes += Buffer.byteLength(data, 'base64');
      await worker.evaluate(({ index, data }) => {
        globalThis.stressFixtures.set(index, Uint8Array.fromBase64(data));
      }, { index, data });
    }
    console.log(`Prepared ${imageCount} JPEG uploads totaling ${(fixtureBytes / 1024 ** 2).toFixed(1)} MiB.`);
    assert.ok(fixtureBytes > 40 * 1024 ** 2, 'the original uploads exceed the aggregate media budget before PDF preparation');

    await chat.goto(conversationUrl);
    await chat.waitForSelector('#gpt-exporter-launcher');
    const readerStarted = performance.now();
    const readerPromise = context.waitForEvent('page', { timeout });
    await chat.locator('#gpt-exporter-select').click();
    const reader = await readerPromise;
    const readerStatus = () => reader.evaluate(() => ({
      status: document.getElementById('status-line')?.textContent,
      messages: document.querySelectorAll('#preview-content article').length,
      images: document.querySelectorAll('#preview-content img').length,
      unavailable: [...document.querySelectorAll('.ge-unavailable-image')].slice(0, 3).map(node => node.textContent)
    }));
    const progress = setInterval(() => {
      readerStatus().then(status => console.log('Reader preview progress', status)).catch(() => {});
    }, 15000);
    const preview = await reader.waitForFunction(({ imageCount, messageCount }) => {
      const preview = document.getElementById('preview-content');
      if (preview?.querySelectorAll('article').length !== messageCount) return false;
      const images = Array.from(preview.querySelectorAll('img'));
      if (images.length !== imageCount || !images.every(image => image.complete && image.naturalWidth)) return false;
      return { text: preview.textContent, dimensions: images.map(image => [image.naturalWidth, image.naturalHeight]) };
    }, { imageCount, messageCount }, { timeout }).catch(async error => {
      const status = await readerStatus();
      throw new Error(`Reader preview incomplete: ${JSON.stringify({ ...status, unexpectedRequests })}`, { cause: error });
    }).finally(() => clearInterval(progress));
    const readerPreviewMs = Math.round(performance.now() - readerStarted);
    const { text, dimensions } = await preview.jsonValue();
    assert.equal(await reader.locator('#message-list input').count(), messageCount);
    assert.ok(text.includes(marker(1)) && text.includes(marker(messageCount)));
    for (const [index, [width, height]] of dimensions.entries()) {
      const original = fixtures[index];
      assert.ok(width <= original.width && height <= original.height, 'reader does not upscale the upload');
      assert.ok(Math.abs(width / height - original.width / original.height) < 0.01, 'reader preserves the upload aspect ratio');
    }
    const readerPath = path.join(output, 'reader.pdf');
    const readerPdfStarted = performance.now();
    await reader.locator('[data-format="pdf"]').click();
    await reader.locator('#pdf-preview-dialog').waitFor({ state: 'visible', timeout });
    await reader.waitForFunction(() => document.querySelector('#pdf-preview-frame')?.src.startsWith('blob:') &&
      !document.getElementById('pdf-preview-download')?.disabled, null, { timeout });
    const readerPdfReadyMs = Math.round(performance.now() - readerPdfStarted);
    const readerDownloadPromise = reader.waitForEvent('download', { timeout });
    await reader.locator('#pdf-preview-download').click();
    await (await readerDownloadPromise).saveAs(readerPath);
    const readerPdfMs = Math.round(performance.now() - readerPdfStarted);
    const photoPair = fixtures.slice(pairedPhotoIndex, pairedPhotoIndex + 2);
    const readerPdf = inspectPdf(readerPath, photoPair);
    console.log(`Reader preview completed in ${readerPreviewMs} ms and PDF downloaded in ${readerPdfMs} ms.`);
    await reader.close();

    await chat.bringToFront();
    const quickPdfStarted = performance.now();
    const pagesBeforeQuick = context.pages().length;
    const listDownloads = () => worker.evaluate(() => chrome.downloads.search({}));
    const existingIds = new Set((await listDownloads()).map(item => item.id));
    const existingFiles = new Set(fs.readdirSync(downloadsPath));
    await chat.locator('#gpt-exporter-menu-toggle').click();
    await chat.locator('#gpt-exporter-selection-menu [data-preset="all"]').click();
    let quickFile;
    while (performance.now() - quickPdfStarted < timeout) {
      const items = (await listDownloads()).filter(item => !existingIds.has(item.id));
      const interrupted = items.find(item => item.state === 'interrupted');
      assert.ok(!interrupted, `Quick PDF download interrupted: ${interrupted?.error}`);
      const completed = items.find(item => item.state === 'complete');
      if (completed) {
        // Playwright stores managed downloads under GUIDs, while Chrome's history can report the suggested path.
        const newFiles = fs.readdirSync(downloadsPath).filter(name => !existingFiles.has(name) && !name.endsWith('.crdownload'));
        if (newFiles.length === 1) quickFile = path.join(downloadsPath, newFiles[0]);
        else if (fs.existsSync(completed.filename)) quickFile = completed.filename;
      }
      if (quickFile) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const status = await chat.locator('#gpt-exporter-launcher .status').textContent();
    assert.ok(quickFile, `Quick PDF download timed out. Launcher status: ${status}`);
    const quickPdfMs = Math.round(performance.now() - quickPdfStarted);
    assert.equal(context.pages().length, pagesBeforeQuick, 'quick PDF exports in place');
    const quickPath = path.join(output, 'quick.pdf');
    fs.copyFileSync(quickFile, quickPath);
    const quickPdf = inspectPdf(quickPath, photoPair);

    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
    const report = { browser: context.browser().version(), messageCount, imageCount, highResolutionCount, fixtureBytes,
      readerPreviewMs, readerPdfReadyMs, readerPdf: { milliseconds: readerPdfMs, ...readerPdf }, quickPdf: { milliseconds: quickPdfMs, ...quickPdf } };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, output }, null, 2));
  } finally {
    await context.close();
  }
}

run().catch(error => {
  fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
  console.error(error);
  process.exitCode = 1;
});
