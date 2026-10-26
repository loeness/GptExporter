const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

require("../extension/src/conversation.js");

function extract(markup, url = "https://chatgpt.com/c/example") {
  const dom = new JSDOM(markup, { url });
  return globalThis.GptExporter.extractConversation(dom.window.document, url);
}

test("extracts loaded main conversation messages and deduplicates ids only", () => {
  const first = `
    <aside><div data-message-author-role="user" data-message-id="sidebar">Navigation text</div></aside>
    <main>
      <h1>Research notes</h1>
      <div data-message-author-role="user" data-message-id="same"><p>Repeated text</p></div>
      <div data-message-author-role="user" data-message-id="same"><p>Repeated text</p></div>
      <div data-message-author-role="assistant"><p>Repeated text</p></div>
    </main>`;
  const result = extract(first);

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.title, "Research notes");
  assert.equal(result.url, "https://chatgpt.com/c/example");
  assert.match(result.exportedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(result.messages.map(({ id, role }) => ({ id, role })), [
    { id: "same", role: "user" },
    { id: "dom-position-3", role: "assistant" }
  ]);
  assert.equal(result.messages.length, 2);
  assert.ok(!JSON.stringify(result).includes("Navigation text"));
  assert.match(result.warnings.join(" "), /更早|尚未加载/);
});

test("converts semantic formatting, nested lists, tables, blockquotes, code, and TeX", () => {
  const result = extract(`
    <main>
      <h1>Semantics</h1>
      <article data-testid="conversation-turn-1">
        <div data-message-author-role="assistant" data-message-id="semantic">
          <h2>Heading</h2>
          <p>A <strong>bold</strong> and <a href="https://example.com/docs">linked</a> line.</p>
          <blockquote><p>Quoted text</p></blockquote>
          <ul><li>Parent<ul><li>Child</li></ul></li></ul>
          <table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>alpha</td><td>one</td></tr></tbody></table>
          <pre><code class="language-python">print("hello")\n</code></pre>
          <span class="katex-display"><span class="katex"><math><semantics><annotation encoding="application/x-tex">x^2 + 1</annotation></semantics></math></span></span>
        </div>
      </article>
    </main>`);
  const message = result.messages[0];

  assert.match(message.markdown, /## Heading/);
  assert.match(message.markdown, /\*\*bold\*\*/);
  assert.match(message.markdown, /\[linked\]\(<https:\/\/example\.com\/docs>\)/);
  assert.match(message.markdown, /> Quoted text/);
  assert.match(message.markdown, /- Parent\n  - Child/);
  assert.match(message.markdown, /\| Name \| Value \|\n\| --- \| --- \|\n\| alpha \| one \|/);
  assert.match(message.markdown, /```python\nprint\("hello"\)\n```/);
  assert.match(message.markdown, /\$\$\nx\^2 \+ 1\n\$\$/);
  assert.match(message.text, /x\^2 \+ 1/);
  assert.match(message.html, /<h2>Heading<\/h2>/);
  assert.match(message.html, /<table><thead>/);
  assert.match(message.html, /<code>x\^2 \+ 1<\/code>/);
});

test("preserves code indentation, internal blank lines, and paragraph boundaries in plain text", () => {
  const result = extract(`
    <main><div data-message-author-role="assistant" data-message-id="code-text">
      <p>Before code.</p>
      <pre><code class="language-python">def sample():
    if True:
        return 1

    return 2
</code></pre>
      <p>After code.</p>
    </div></main>`);
  const message = result.messages[0];
  const code = "def sample():\n    if True:\n        return 1\n\n    return 2";

  assert.ok(message.text.includes(code), JSON.stringify(message.text));
  assert.match(message.text, /Before code\.\n\n/);
  assert.match(message.text, /\n\nAfter code\./);
});

test("preserves whitespace-pre-wrap lines in Markdown and plain text", () => {
  const content = "First line\nSecond line\n\n  indented line";
  const result = extract(`<main><div data-message-author-role="user" data-message-id="pre-wrap"><span class="whitespace-pre-wrap">${content}</span></div></main>`);
  const message = result.messages[0];

  assert.ok(message.markdown.includes(content), JSON.stringify(message.markdown));
  assert.ok(message.text.includes(content), JSON.stringify(message.text));
  assert.match(message.html, /First line<br>Second line<br><br>  indented line/);
});

test("indents nested ordered lists by marker width and keeps safe numeric HTML values", () => {
  const result = extract(`
    <main><div data-message-author-role="assistant" data-message-id="ordered-list">
      <ol start="10"><li>Parent<ol><li>Child<ul><li>Grandchild</li></ul></li></ol></li><li value="13">Other</li></ol>
      <ol start="999999999999999999999"><li value="1e3">Invalid numeric attributes</li></ol>
    </div></main>`);
  const message = result.messages[0];

  assert.match(message.markdown, /10\. Parent\n    1\. Child\n       - Grandchild\n13\. Other/);
  assert.match(message.text, /10\. Parent\n    1\. Child\n       • Grandchild\n13\. Other/);
  assert.match(message.html, /<ol start="10">/);
  assert.match(message.html, /<li value="13">Other<\/li>/);
  assert.doesNotMatch(message.html, /start="999999999999999999999"|value="1e3"/);
});

test("sanitizes active payloads and keeps image alt text out of preview media", () => {
  const result = extract(`
    <main><div data-message-author-role="assistant" data-message-id="unsafe">
      <p onclick="steal()">Safe <a href="javascript:alert(1)" onmouseover="steal()">label</a>
      <a href="https://example.com/path" style="color:red" target="_blank">safe link</a>
      <img src="https://tracker.example/pixel.png" alt="diagram">
      <img src="javascript:alert(1)" alt="unsafe image url">
      <script>steal()</script><iframe src="https://evil.example"></iframe></p>
    </div></main>`);
  const [message] = result.messages;

  assert.match(message.markdown, /!\[diagram\]\(<https:\/\/tracker\.example\/pixel\.png>\)/);
  assert.match(message.markdown, /unsafe image url/);
  assert.match(message.html, /safe link/);
  assert.match(message.html, /diagram/);
  assert.match(message.html, /unsafe image url/);
  assert.doesNotMatch(message.html, /<img|javascript:|onclick|onmouseover|style=|target=|<script|<iframe|steal\(\)/i);
  assert.match(message.html, /<a href="https:\/\/example\.com\/path">safe link<\/a>/);
  assert.ok(!message.html.includes("https://tracker.example/pixel.png"));
});

test("uses conversation-turn fallback when role data is unavailable and ignores unrelated articles", () => {
  const result = extract(`
    <main>
      <article data-testid="conversation-turn-1" aria-label="You said"><p>Fallback user content</p></article>
      <article data-testid="conversation-turn-2" aria-label="ChatGPT said"><p>Fallback assistant content</p></article>
      <article data-testid="other-card" aria-label="You said"><p>Not a turn</p></article>
    </main>`);

  assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"]);
  assert.match(result.messages[0].text, /Fallback user content/);
  assert.match(result.messages[1].text, /Fallback assistant content/);
  assert.ok(!JSON.stringify(result.messages).includes("Not a turn"));
});

test("returns an explicit empty result when the loaded conversation DOM has no messages", () => {
  const result = extract("<main><h1>Empty conversation</h1><p>Page chrome only</p></main>");
  assert.equal(result.messages.length, 0);
  assert.ok(result.warnings.some((warning) => /没有找到已加载的消息/.test(warning)));
});

test("loading the script more than once preserves the existing API function", () => {
  const first = globalThis.GptExporter.extractConversation;
  delete require.cache[require.resolve("../extension/src/conversation.js")];
  require("../extension/src/conversation.js");
  assert.equal(globalThis.GptExporter.extractConversation, first);
});
