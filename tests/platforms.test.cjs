const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

require("../extension/src/conversation.js");
require("../extension/src/platforms.js");

const platforms = globalThis.GptExporter;

const fixtures = [
  {
    id: "claude",
    url: "https://claude.ai/chat/example",
    html: `
      <aside><div data-testid="user-message">Sidebar copy</div></aside>
      <main>
        <div data-testid="transcript-row" data-index="0" data-rs-index="0">
          <div data-testid="user-message" data-message-id="u1" data-role="user"><p>Question for Claude</p></div>
        </div>
        <div data-testid="transcript-row" data-index="1" data-rs-index="1">
          <div data-testid="assistant-message" data-message-id="a1"><p>Answer from Claude</p><pre><code class="language-python">def add(a, b):\n    return a + b</code></pre></div>
        </div>
        <div data-testid="user-message">Outside transcript row</div>
      </main>`,
    title: "Project notes - Claude"
  },
  {
    id: "qwen",
    url: "https://chat.qwen.ai/c/example",
    html: `
      <aside><div class="qwen-chat-message-user">Sidebar copy</div></aside>
      <main>
        <div class="qwen-chat-message-user" data-message-id="u1"><p>Question for Qwen</p></div>
        <div class="qwen-chat-message-assistant" data-message-id="a1"><p>Answer from Qwen</p></div>
      </main>`,
    title: "Project notes | Qwen"
  },
  {
    id: "deepseek",
    url: "https://chat.deepseek.com/a/example",
    html: `
      <aside><div class="ds-message"><div class="ds-assistant-message-main-content">Sidebar copy</div></div></aside>
      <main>
        <div class="_9663006"><div class="ds-message" data-message-id="u1"><div class="fbb737a4"><p>Question for DeepSeek</p></div></div></div>
        <div class="ds-message" data-message-id="a1"><div class="ds-assistant-message-main-content"><p>Answer from DeepSeek</p></div></div>
      </main>`,
    title: "Project notes — DeepSeek"
  },
  {
    id: "kimi",
    url: "https://www.kimi.com/chat/example",
    html: `
      <aside><div class="chat-content-item-user"><div class="segment-content">Sidebar copy</div></div></aside>
      <main><div class="chat-content-list">
        <div class="chat-content-item-user" data-message-id="u1"><div class="segment-content"><p>Question for Kimi</p></div></div>
        <div class="chat-content-item-assistant" data-message-id="a1"><div class="segment-content"><p>Answer from Kimi</p></div></div>
      </div></main>`,
    title: "Kimi - Project notes"
  },
  {
    id: "gemini",
    url: "https://gemini.google.com/app/example",
    html: `
      <aside><user-query><div class="query-text">Sidebar copy</div></user-query></aside>
      <main>
        <user-query data-message-id="u1"><span>You said</span><div class="query-text"><p>Question for Gemini</p></div></user-query>
        <model-response data-message-id="a1"><structured-content-container class="model-response-text"><p>Answer from Gemini</p></structured-content-container></model-response>
        <div class="markdown-main-panel">Unmarked content must not become an assistant turn.</div>
      </main>`,
    title: "Project notes - Gemini"
  },
  {
    id: "doubao",
    url: "https://www.doubao.com/chat/example",
    html: `
      <aside><div class="bg-g-send-msg-bubble">Sidebar copy</div></aside>
      <main>
        <div class="bg-g-send-msg-bubble user-bubble" data-message-id="u1"><p>Question for Doubao</p></div>
        <div class="bg-g-receive-msg-bubble answer-bubble" data-message-id="a1"><p>Answer from Doubao</p></div>
      </main>`,
    title: "Project notes - 豆包"
  },
  {
    id: "grok",
    url: "https://grok.com/chat/example",
    html: `
      <aside><div data-testid="user-message">Sidebar copy</div></aside>
      <main>
        <div data-testid="user-message" data-message-id="u1"><p>Question for Grok</p></div>
        <div data-testid="assistant-message" data-message-id="a1"><p>Answer from Grok</p></div>
      </main>`,
    title: "Project notes - Grok"
  }
];

function collect(fixture, html = fixture.html, title = fixture.title) {
  const dom = new JSDOM(`<!doctype html><html><head><title>${title}</title></head><body>${html}</body></html>`, {
    url: fixture.url
  });
  return platforms.collectPlatformConversation({ document: dom.window.document, url: fixture.url });
}

test("registers the eight supported platforms and accepts only exact secure hosts", () => {
  assert.deepEqual(platforms.supportedPlatforms.map(({ id }) => id), [
    "chatgpt", "claude", "qwen", "deepseek", "kimi", "gemini", "doubao", "grok"
  ]);

  for (const fixture of fixtures) {
    assert.equal(platforms.getPlatform(fixture.url).id, fixture.id);
    assert.equal(platforms.getPlatform(fixture.url.replace("https://", "https://user:pass@")), null);
    assert.equal(platforms.getPlatform(fixture.url.replace("https://", "http://")), null);
    const nonstandardPort = new URL(fixture.url);
    nonstandardPort.port = "444";
    assert.equal(platforms.getPlatform(nonstandardPort.href), null);
  }

  assert.equal(platforms.getPlatform("https://chatgpt.com/c/example").id, "chatgpt");
  assert.equal(platforms.getPlatform("https://chat.openai.com/c/example").id, "chatgpt");
  assert.equal(platforms.getPlatform("https://claude.ai:443/chat/example").id, "claude");
  assert.equal(platforms.getPlatform("https://kimi.com/chat/example").id, "kimi");
  assert.equal(platforms.getPlatform("https://kimi.moonshot.cn/chat/example").id, "kimi");
  assert.equal(platforms.getPlatform("https://www.doubao.com.evil.example/chat"), null);
  assert.equal(platforms.getPlatform("https://sub.claude.ai/chat"), null);
  assert.equal(platforms.getPlatform("https://grok.com.evil.example/chat"), null);
  assert.equal(platforms.getPlatform("file:///tmp/grok.html"), null);
});

test("extracts only provider-marked messages in DOM order and reports partial DOM coverage", () => {
  for (const fixture of fixtures) {
    const result = collect(fixture);
    assert.equal(result.schemaVersion, 2, fixture.id);
    assert.equal(result.source.kind, "dom", fixture.id);
    assert.equal(result.source.complete, false, fixture.id);
    assert.equal(result.source.platform, fixture.id, fixture.id);
    assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"], fixture.id);
    assert.match(result.messages[0].text, new RegExp(`Question for ${fixture.id === "doubao" ? "Doubao" : fixture.id}`, "i"));
    assert.match(result.messages[1].text, new RegExp(`Answer from ${fixture.id === "doubao" ? "Doubao" : fixture.id}`, "i"));
    assert.ok(result.messages.every((message) => message.id.startsWith(`${fixture.id}:`)), fixture.id);
    assert.equal(new Set(result.messages.map((message) => message.id)).size, result.messages.length, fixture.id);
    assert.deepEqual(result.branches, [{
      id: "current",
      label: "当前页面",
      leafId: result.messages.at(-1).id,
      messageIds: result.messages.map((message) => message.id)
    }]);
    assert.equal(result.activeBranchId, "current");
    assert.deepEqual(result.assets, []);
    assert.ok(result.warnings.some((warning) => /已加载/.test(warning)), fixture.id);
    assert.ok(result.warnings.some((warning) => /完整会话历史/.test(warning)), fixture.id);
    assert.ok(result.warnings.some((warning) => /媒体文件未下载/.test(warning)), fixture.id);
    assert.equal(result.title, "Project notes", fixture.id);
  }
});

test("copies only safe parser markup while retaining code, whitespace, math, links, and lazy image URLs", () => {
  const fixture = fixtures.find(({ id }) => id === "claude");
  const result = collect(fixture);
  const assistant = result.messages[1];
  assert.match(assistant.markdown, /```python\ndef add\(a, b\):\n    return a \+ b\n```/);
  assert.match(assistant.text, /def add\(a, b\):\n    return a \+ b/);

  const originalExtract = platforms.extractConversation;
  let parserDocument;
  platforms.extractConversation = (doc, url) => {
    parserDocument = doc;
    return originalExtract(doc, url);
  };
  let unsafe;
  try {
    unsafe = collect(fixture, `
    <main>
      <div data-testid="transcript-row" data-index="0" data-rs-index="0">
        <div data-testid="assistant-message" data-message-id="unsafe">
          <p onclick="steal()">Safe <a href="javascript:alert(1)" onmouseover="steal()">label</a>
          <a href="https://example.com/path" target="_blank">safe link</a>
          <img src="https://tracker.example/eager.png" srcset="https://tracker.example/large.png 2x" data-src="https://tracker.example/lazy.png" alt="diagram" onerror="steal()">
          <img src="https://tracker.example/plain.png" alt="plain diagram"><span class="cdk-visually-hidden">Hidden accessibility label</span>
          <pre><code class="language-python" data-language="python">print(&quot;safe&quot;)\n</code></pre>
          <span style="white-space: pre-wrap; background-image: url('https://tracker.example/css.png')">First line
Second line</span>
          <div class="katex-display"><span class="katex"><math display="block"><semantics><annotation encoding="application/x-tex">x^2 + 1</annotation></semantics></math></span></div>
          <p>Inline <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">DUPLICATE_MATH_TEXT</span></span>.</p>
          <script>steal()</script><style>.x{background:url(https://tracker.example/style.png)}</style>
          <link rel="stylesheet" href="https://tracker.example/extra.css"><iframe src="https://evil.example">bad</iframe>
          <object data="https://tracker.example/object.bin"></object><embed src="https://tracker.example/embed.bin">
          <video src="https://tracker.example/video.mp4"><source src="https://tracker.example/source.mp4"></video>
          <button onclick="steal()">Toolbar text</button>
        </p>
        </div>
      </div>
    </main>`, "Project notes - Claude");
  } finally {
    platforms.extractConversation = originalExtract;
  }
  const [message] = unsafe.messages;
  assert.match(message.markdown, /!\[diagram\]\(<https:\/\/tracker\.example\/lazy\.png>\)/);
  assert.match(message.markdown, /!\[plain diagram\]\(<https:\/\/tracker\.example\/plain\.png>\)/);
  assert.doesNotMatch(message.text, /Hidden accessibility label/);
  assert.match(message.markdown, /First line\nSecond line/);
  assert.match(message.markdown, /\$\$\nx\^2 \+ 1\n\$\$/);
  assert.match(message.markdown, /Inline \$E=mc\^2\$/);
  assert.doesNotMatch(message.markdown, /DUPLICATE_MATH_TEXT/);
  assert.match(message.html, /safe link/);
  assert.doesNotMatch(message.html, /javascript:|onclick|onmouseover|target=|<script|<iframe|steal\(\)/i);
  assert.deepEqual(unsafe.assets, []);

  assert.ok(parserDocument);
  assert.equal(parserDocument.querySelectorAll("img[src], img[srcset]").length, 0);
  assert.equal(parserDocument.querySelectorAll("script, style, link, iframe, object, embed, video, audio, source, svg, form, button").length, 0);
  assert.equal(parserDocument.querySelectorAll("[onclick], [onmouseover], [onerror], [style], [srcset]").length, 0);
  assert.ok(parserDocument.querySelector("img[data-src='https://tracker.example/lazy.png'][alt='diagram']"));
  assert.ok(parserDocument.querySelector("a[href='https://example.com/path']"));
  assert.ok(parserDocument.querySelector("a:not([href])"));
  assert.ok(parserDocument.querySelector("code.language-python"));
  assert.ok(parserDocument.querySelector("span.whitespace-pre-wrap"));
  assert.ok(parserDocument.querySelector("annotation[encoding='application/x-tex']"));
});

test("deduplicates nested role markers and strips their role attributes in the parser clone", () => {
  const fixture = fixtures.find(({ id }) => id === "qwen");
  const originalExtract = platforms.extractConversation;
  let parserDocument;
  platforms.extractConversation = (doc, url) => {
    parserDocument = doc;
    return originalExtract(doc, url);
  };
  let result;
  try {
    result = collect(fixture, `
      <main><div data-role="user" data-message-id="outer">
        <p>Outer question</p><div data-role="assistant"><span>Nested marker text</span></div>
      </div></main>`, "Question - Qwen");
  } finally {
    platforms.extractConversation = originalExtract;
  }

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
  assert.match(result.messages[0].text, /Outer question/);
  assert.match(result.messages[0].text, /Nested marker text/);
  assert.equal(result.messages[0].id, "qwen:outer");
  assert.equal(parserDocument.querySelectorAll("main > [data-message-author-role='user']").length, 1);
  assert.equal(parserDocument.querySelectorAll("[data-role], [data-author-role]").length, 0);
});

test("prefixes stable DOM ids and disambiguates duplicate provider ids", () => {
  const fixture = fixtures.find(({ id }) => id === "qwen");
  const result = collect(fixture, `
    <main>
      <div class="qwen-chat-message-user" data-message-id="same">First</div>
      <div class="qwen-chat-message-assistant" data-message-id="same">Second</div>
    </main>`, "Qwen");
  assert.deepEqual(result.messages.map((message) => message.id), ["qwen:same", "qwen:same#2"]);
  assert.equal(result.title, "Qwen 对话");
});

test("ignores hidden, form, chrome, and unmarked generic content and returns explicit empty warnings", () => {
  const fixture = fixtures.find(({ id }) => id === "gemini");
  const result = collect(fixture, `
    <aside><user-query><div class="query-text">Sidebar only</div></user-query></aside>
    <main>
      <user-query hidden><div class="query-text">Hidden question</div></user-query>
      <model-response aria-hidden="true"><structured-content-container class="model-response-text">Hidden answer</structured-content-container></model-response>
      <form><div data-role="user">Composer text</div></form>
      <div class="markdown-main-panel">Generic markdown is not a role marker.</div>
    </main>`, "Gemini");

  assert.deepEqual(result.messages, []);
  assert.equal(result.title, "Gemini 对话");
  assert.deepEqual(result.branches, [{ id: "current", label: "当前页面", leafId: "", messageIds: [] }]);
  assert.ok(result.warnings.some((warning) => /没有找到可识别/.test(warning)));
});

test("does not fetch remote assets, touch storage, or adapt ChatGPT pages", () => {
  const originalFetch = global.fetch;
  const originalChrome = global.chrome;
  let fetchCalls = 0;
  let storageCalls = 0;
  global.fetch = () => { fetchCalls += 1; throw new Error("unexpected network request"); };
  global.chrome = { storage: { local: { get() { storageCalls += 1; }, set() { storageCalls += 1; } } } };

  try {
    const fixture = fixtures.find(({ id }) => id === "gemini");
    collect(fixture);
    const dom = new JSDOM("<main><div data-message-author-role='user'>ChatGPT</div></main>", {
      url: "https://chatgpt.com/c/example"
    });
    assert.equal(platforms.collectPlatformConversation({ document: dom.window.document, url: dom.window.location.href }), null);
    assert.equal(fetchCalls, 0);
    assert.equal(storageCalls, 0);
  } finally {
    if (originalFetch === undefined) delete global.fetch;
    else global.fetch = originalFetch;
    if (originalChrome === undefined) delete global.chrome;
    else global.chrome = originalChrome;
  }
});
