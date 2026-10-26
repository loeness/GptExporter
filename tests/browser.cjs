'use strict';
// Real MV3 extension in an isolated Chromium profile. All ChatGPT traffic is a fixture.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'browser-' + Date.now());
fs.mkdirSync(output, {recursive: true});
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>浏览器验收 - ChatGPT</title></head><body>
<aside>sidebar must not export</aside><main>
<article data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u1"><div class="whitespace-pre-wrap">请整理资料\n保留第二行</div></div></article>
<article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">
<h2>回答内容</h2><p>这是<strong>重点</strong>和<a href="javascript:alert(1)">危险链接</a>。</p>
<table><thead><tr><th>项目</th><th>数量</th></tr></thead><tbody><tr><td>样本</td><td>3</td></tr></tbody></table>
<pre><code class="language-python">if True:\n    print("你好")</code></pre><img data-src="https://tracking.invalid/pixel" alt="示意图">
</div></div></article>
<article data-testid="conversation-turn-3"><div data-message-author-role="user" data-message-id="u2"><p>只导出我的两条消息。</p></div></article>
</main></body></html>`;

(async () => {
  const errors = [], unexpectedNetwork = [];
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(output, 'profile'), {
      channel: 'chromium', headless: true, acceptDownloads: true, viewport: {width: 1440, height: 1000},
      args: ['--disable-extensions-except=' + path.join(root, 'extension'), '--load-extension=' + path.join(root, 'extension')]
    });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'chatgpt.com') await route.fulfill({contentType: 'text/html;charset=utf-8', body: fixture});
      else { unexpectedNetwork.push(url.origin); await route.abort(); }
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;
    const base = 'chrome-extension://' + extensionId + '/';
    const chat = await context.newPage();
    await chat.goto('https://chatgpt.com/c/test-fixture');
    await chat.waitForSelector('#gpt-exporter-launcher');
    // Exercise the actual content entry with keyboard access into its closed shadow root.
    // A test-created extension page cannot simulate Chrome's action-granted activeTab.
    let focused = false;
    for (let step = 0; step < 12; step++) {
      await chat.keyboard.press('Tab');
      focused = await chat.evaluate(() => document.activeElement?.id === 'gpt-exporter-launcher');
      if (focused) break;
    }
    assert.ok(focused, 'floating export entry is keyboard accessible');
    const readerPromise = context.waitForEvent('page');
    await chat.keyboard.press('Enter');
    const reader = await readerPromise;
    // Popup invalid-page feedback is tested separately from the action-granted permission.
    const popup = await context.newPage();
    await popup.goto(base + 'popup.html');
    await popup.locator('#open').click();
    assert.match(await popup.locator('#status').innerText(), /ChatGPT 对话页面/);
    await reader.bringToFront();
    await reader.waitForURL('**/reader.html?id=*');
    await reader.waitForFunction(() => document.querySelector('#message-total').textContent === '3 条');
    assert.equal(await reader.locator('#preview-content article').count(), 3);
    assert.equal(await reader.locator('#preview-empty').isVisible(), false);
    assert.equal(await reader.locator('#load-error').isVisible(), false);
    assert.equal(await reader.locator('#status-line').isVisible(), false);
    assert.match(await reader.locator('#preview-content').innerText(), /保留第二行/);
    assert.equal(await reader.locator('#preview-content img,#preview-content iframe,#preview-content script').count(), 0);
    assert.equal(await reader.locator('#preview-content a[href^="javascript:"]').count(), 0);
    await reader.screenshot({path: path.join(output, 'reader-desktop.png'), fullPage: true});

    await reader.locator('[data-select="user"]').click();
    assert.equal(await reader.locator('#preview-content article').count(), 2);
    await reader.locator('#message-search').fill('只导出');
    assert.equal(await reader.locator('#message-list input[type="checkbox"]').count(), 1);
    assert.equal(await reader.locator('#preview-content article').count(), 2);
    const jsonDownloadPromise = reader.waitForEvent('download');
    await reader.locator('[data-format="json"]').click();
    const jsonDownload = await jsonDownloadPromise;
    const json = JSON.parse(fs.readFileSync(await jsonDownload.path(), 'utf8'));
    assert.deepEqual(json.messages.map(message => message.role), ['user', 'user']);
    assert.ok(!JSON.stringify(json).includes('sidebar must not export'));
    await reader.locator('#message-search').fill('');
    await reader.locator('[data-select="all"]').click();

    const htmlDownloadPromise = reader.waitForEvent('download');
    await reader.locator('[data-format="html"]').click();
    const htmlDownload = await htmlDownloadPromise;
    const html = fs.readFileSync(await htmlDownload.path(), 'utf8');
    assert.match(html, /<!doctype html>/i); assert.match(html, /charset=["']?utf-8/i);
    assert.doesNotMatch(html, /<img\b|javascript:|<script\b/i);
    await reader.emulateMedia({media: 'print'});
    assert.equal(await reader.locator('.topbar').isVisible(), false);
    assert.equal(await reader.locator('#preview-content article').count(), 3);
    await reader.pdf({path: path.join(output, 'fixture-print.pdf'), format:'A4', printBackground:true});
    await reader.emulateMedia({media:'screen'});

    await reader.locator('[data-select="none"]').click();
    assert.equal((await reader.locator('#preview-content').innerHTML()).trim(), '');
    assert.equal(await reader.locator('#preview-paper').isVisible(), false);
    assert.equal(await reader.locator('#preview-empty').isVisible(), true);
    await reader.locator('#print-document').click();
    assert.match(await reader.locator('#status-line').innerText(), /至少一条/);
    await reader.locator('[data-select="all"]').click();
    await reader.locator('#theme-toggle').click();
    assert.equal(await reader.locator('body').getAttribute('data-theme'), 'dark');
    assert.equal(await reader.locator('#preview-empty').isVisible(), false);
    await reader.locator('#theme-toggle').click();
    await reader.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText:async()=>{throw new Error('clipboard denied');}}}));
    await reader.locator('#copy-markdown').click();
    assert.match(await reader.locator('#status-line').innerText(), /clipboard denied/);

    await reader.setViewportSize({width:390, height:844});
    await reader.screenshot({path:path.join(output,'reader-mobile.png'),fullPage:true});
    assert.ok(await reader.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile has horizontal overflow');
    const id = new URL(reader.url()).searchParams.get('id');
    await reader.locator('#clear-data').click();
    await reader.waitForFunction(() => document.querySelector('#error-title').textContent.includes('已清除'));
    assert.equal((await reader.locator('#preview-content').innerHTML()).trim(), '');
    assert.equal(await reader.locator('#preview-paper').isVisible(), false);
    const records = await worker.evaluate(async key => chrome.storage.session.get(key), 'export:' + id);
    assert.equal(Object.keys(records).length, 0);
    const local = await worker.evaluate(async()=>chrome.storage.local.get(null));
    assert.ok(!JSON.stringify(local).includes('请整理资料'));

    const missing = await context.newPage();
    await missing.goto(base + 'reader.html?id=missing');
    await missing.waitForSelector('#load-error:not([hidden])');
    assert.match(await missing.locator('#error-detail').innerText(), /过期|不存在/);
    assert.equal(await missing.locator('[data-format="json"]').isDisabled(), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedNetwork, []);
    const report = {status:'passed',chromium:context.browser()?.version() || 'persistent-context',checks:[
      'MV3 load','keyboard content entry to reader','popup invalid-page feedback','three fixture messages','sanitized preview',
      'role selection','search preserves selection','JSON selection download','standalone UTF-8 HTML',
      'PDF print layout','hidden/empty/error visibility','theme toggle','zero-selection protection','clipboard failure','mobile layout','session clear','missing session'
    ]};
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
    console.log('Local test evidence: ' + output);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.txt'), error.stack || String(error));
    console.error(error); process.exitCode = 1;
  } finally { if (context) await context.close(); }
})();
