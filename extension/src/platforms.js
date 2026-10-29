((root) => {
  "use strict";

  const namespace = root.GptExporter || (root.GptExporter = {});
  if (typeof namespace.getPlatform === "function" &&
      typeof namespace.collectPlatformConversation === "function" &&
      Array.isArray(namespace.supportedPlatforms)) return;

  const definitions = [
    {
      id: "chatgpt",
      label: "ChatGPT",
      hosts: ["chatgpt.com", "chat.openai.com"],
      scopes: ["main", "[role='main']"],
      messages: []
    },
    {
      id: "claude",
      label: "Claude",
      hosts: ["claude.ai"],
      scopes: ["main", "[role='main']"],
      messages: [
        { selector: "[data-testid='transcript-row'][data-index][data-rs-index] [data-testid='user-message']", role: "user" },
        { selector: "[data-testid='transcript-row'][data-index][data-rs-index] [data-testid='assistant-message']", role: "assistant" }
      ]
    },
    {
      id: "qwen",
      label: "Qwen",
      hosts: ["chat.qwen.ai"],
      scopes: ["main", "[role='main']"],
      messages: [
        { selector: ".qwen-chat-message-user", role: "user" },
        { selector: ".qwen-chat-message-assistant", role: "assistant" },
        { selector: ".qwen-chat-message-bot", role: "assistant" }
      ]
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      hosts: ["chat.deepseek.com"],
      scopes: ["main", "[role='main']"],
      messages: [
        {
          selector: ".ds-message",
          roleFor: (element) => element.closest("._9663006") ? "user" :
            (element.querySelector(".ds-assistant-message-main-content, .ds-markdown") ? "assistant" : ""),
          contentFor: (element) => element.closest("._9663006")
            ? element.querySelector("div.fbb737a4")
            : element.querySelector(".ds-assistant-message-main-content, .ds-markdown")
        }
      ]
    },
    {
      id: "kimi",
      label: "Kimi",
      hosts: ["kimi.ai", "www.kimi.ai", "kimi.com", "www.kimi.com", "kimi.moonshot.cn"],
      scopes: [".chat-content-list", "main", "[role='main']"],
      messages: [
        { selector: ".chat-content-item-user", role: "user", contentSelector: ".segment-content" },
        { selector: ".chat-content-item-assistant", role: "assistant", contentSelector: ".segment-content" }
      ]
    },
    {
      id: "gemini",
      label: "Gemini",
      hosts: ["gemini.google.com"],
      scopes: ["main", "[role='main']"],
      messages: [
        { selector: "user-query", role: "user", contentSelector: ".query-text" },
        { selector: "model-response", role: "assistant", contentSelector: "structured-content-container.model-response-text" }
      ]
    },
    {
      id: "doubao",
      label: "豆包",
      hosts: ["www.doubao.com", "doubao.com"],
      scopes: ["main", "[role='main']"],
      messages: [
        { selector: "[class*='bg-g-send-msg-bubble']", role: "user" },
        { selector: "[class*='bg-g-receive-msg-bubble']", role: "assistant" }
      ]
    },
    {
      id: "grok",
      label: "Grok",
      hosts: ["grok.com"],
      scopes: ["main", "[role='main']"],
      messages: [
        { selector: "[data-testid='user-message']", role: "user" },
        { selector: "[data-testid='assistant-message']", role: "assistant" }
      ]
    }
  ];

  const byHost = new Map();
  const byId = new Map();
  for (const definition of definitions) {
    definition.hosts = Object.freeze([...definition.hosts]);
    definition.scopes = Object.freeze([...definition.scopes]);
    definition.messages = Object.freeze(definition.messages.map((entry) => Object.freeze({ ...entry })));
    Object.freeze(definition);
    byId.set(definition.id, definition);
    for (const host of definition.hosts) byHost.set(host, definition);
  }

  const supportedPlatforms = Object.freeze(definitions.map(({ id, label, hosts }) => Object.freeze({
    id,
    label,
    hosts: Object.freeze([...hosts])
  })));

  const ROLE_ATTRIBUTES = ["data-message-author-role", "data-author-role", "data-role", "role"];
  const SAFE_COPY_TAGS = new Set([
    "a", "article", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2",
    "h3", "h4", "h5", "h6", "hr", "i", "img", "kbd", "li", "math", "mi", "mn",
    "mo", "mrow", "msup", "msub", "mfrac", "msqrt", "mroot", "munder", "mover",
    "munderover", "mtable", "mtr", "mtd", "mtext", "mstyle", "mpadded", "mphantom",
    "menclose", "semantics", "annotation", "ol", "p", "pre", "s", "section", "span",
    "strong", "sub", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul"
  ]);
  const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
  const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
  const DROP_TAGS = new Set([
    "audio", "button", "canvas", "embed", "form", "iframe", "input", "link", "object",
    "script", "select", "source", "style", "svg", "textarea", "track", "video"
  ]);
  const WHITESPACE_CLASSES = new Set(["whitespace-pre-wrap", "whitespace-pre", "whitespace-break-spaces"]);
  const SAFE_MATH_CLASSES = new Set(["katex", "katex-display", "mathjax"]);
  const MESSAGE_CHROME = [
    "aside", "nav", "header", "footer", "form", "button", "[role='navigation']",
    "[role='button']", "[hidden]", "[aria-hidden='true']", "[inert]",
    ".sr-only", ".visually-hidden", ".cdk-visually-hidden"
  ].join(",");
  const CLONE_REMOVALS = [
    "aside", "nav", "header", "footer", "form", "button", "input", "select", "textarea",
    "[role='navigation']", "[role='button']", "[hidden]", "[aria-hidden='true']", "[inert]",
    "[data-testid*='toolbar' i]", "[data-testid*='message-actions' i]",
    "[data-testid*='turn-actions' i]", "[data-testid*='feedback' i]",
    "[data-testid*='regenerate' i]", "[data-testid*='retry' i]", "[data-testid*='copy' i]",
    ".sr-only", ".visually-hidden", ".cdk-visually-hidden"
  ].join(",");
  const WARNINGS = Object.freeze([
    "仅包含当前页面已加载并挂载的消息。",
    "完整会话历史不可用；未加载的更早消息不会导出。",
    "媒体文件未下载；图片与附件仅保留页面中可用的链接或替代文本。"
  ]);

  function getPlatform(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
      const definition = byHost.get(url.hostname.toLowerCase());
      return definition ? { id: definition.id, label: definition.label, hosts: [...definition.hosts] } : null;
    } catch (_) {
      return null;
    }
  }

  function isHiddenOrChrome(element) {
    if (!element || element.nodeType !== 1 || !element.closest) return true;
    if (element.closest(MESSAGE_CHROME)) return true;
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      if (String(current.getAttribute("aria-hidden") || "").trim().toLowerCase() === "true") return true;
      const style = String(current.getAttribute("style") || "");
      if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:\s*!important)?\s*(?:;|$)/i.test(style)) return true;
    }
    return false;
  }

  function findScope(doc, definition) {
    for (const selector of definition.scopes) {
      let elements = [];
      try {
        elements = Array.from(doc.querySelectorAll(selector));
      } catch (_) {
        continue;
      }
      const visible = elements.find((element) => !isHiddenOrChrome(element));
      if (visible) return visible;
    }
    return null;
  }

  function explicitRole(element) {
    for (const attribute of ROLE_ATTRIBUTES) {
      const role = String(element.getAttribute(attribute) || "").trim().toLowerCase();
      if (role === "user" || role === "assistant") return role;
    }
    return "";
  }

  function selectedMessages(scope, definition) {
    const roles = new Map();
    for (const message of definition.messages) {
      const matched = [];
      try {
        if (scope.matches && scope.matches(message.selector)) matched.push(scope);
        matched.push(...Array.from(scope.querySelectorAll(message.selector)));
      } catch (_) {
        continue;
      }
      for (const element of matched) {
        if (isHiddenOrChrome(element)) continue;
        const role = typeof message.roleFor === "function" ? message.roleFor(element) : message.role;
        if (role !== "user" && role !== "assistant") continue;
        let content = element;
        if (typeof message.contentFor === "function") content = message.contentFor(element);
        else if (message.contentSelector) content = element.querySelector(message.contentSelector);
        if (content && !isHiddenOrChrome(content)) roles.set(element, { role, content });
      }
    }

    const explicitSelector = ROLE_ATTRIBUTES.map((name) => `[${name}]`).join(",");
    const explicit = [];
    try {
      if (scope.matches && scope.matches(explicitSelector)) explicit.push(scope);
      explicit.push(...Array.from(scope.querySelectorAll(explicitSelector)));
    } catch (_) {
      // The fixed selector is valid, but keep invalid page DOM from breaking the adapter.
    }
    for (const element of explicit) {
      const role = explicitRole(element);
      if (role && !isHiddenOrChrome(element) && !roles.has(element)) roles.set(element, { role, content: element });
    }

    const inDomOrder = [];
    const orderedElements = [scope, ...Array.from(scope.querySelectorAll("*"))];
    for (const element of orderedElements) {
      if (!roles.has(element)) continue;
      if (inDomOrder.some((candidate) => candidate.element.contains(element))) continue;
      inDomOrder.push({ element, ...roles.get(element) });
    }
    return inDomOrder;
  }

  function stableDomKey(element, index) {
    const raw = ["data-message-id", "data-id", "id"]
      .map((name) => String(element.getAttribute(name) || "").trim())
      .find(Boolean);
    const source = raw || `position-${index + 1}`;
    return source.replace(/[^a-z0-9._:-]+/gi, "_").slice(0, 160) || `position-${index + 1}`;
  }

  function isolatedDocument(doc, url) {
    if (!doc.implementation || typeof doc.implementation.createHTMLDocument !== "function") return null;
    const isolated = doc.implementation.createHTMLDocument("");
    const base = isolated.createElement("base");
    base.href = url;
    isolated.head.appendChild(base);
    return isolated;
  }

  function safeAnchorHref(raw, baseUrl) {
    const value = String(raw || "").trim();
    if (!value) return "";
    try {
      const parsed = new URL(value, baseUrl || "https://example.invalid/");
      return ["http:", "https:", "mailto:"].includes(parsed.protocol.toLowerCase()) ? parsed.href : "";
    } catch (_) {
      return "";
    }
  }

  function safeClassNames(element) {
    const names = String(element.getAttribute("class") || "").split(/\s+/).filter(Boolean);
    const safe = names.filter((name) => {
      const lower = name.toLowerCase();
      return /^(?:language|lang)-[a-z0-9_+#.-]+$/i.test(name) ||
        WHITESPACE_CLASSES.has(lower) || SAFE_MATH_CLASSES.has(lower) ||
        lower.startsWith("katex-") || lower.startsWith("mathjax_") || lower.startsWith("mjx-container");
    });
    const style = String(element.getAttribute("style") || "");
    const whitespace = style.match(/(?:^|;)\s*white-space\s*:\s*(pre-wrap|pre|break-spaces)(?:\s*!important)?\s*(?:;|$)/i);
    if (whitespace) {
      const normalized = `whitespace-${whitespace[1].toLowerCase()}`;
      if (!safe.includes(normalized)) safe.push(normalized);
    }
    return [...new Set(safe)].join(" ");
  }

  function safeTargetTag(sourceElement) {
    const tag = String(sourceElement.localName || sourceElement.tagName || "").toLowerCase();
    const namespace = sourceElement.namespaceURI;
    if (namespace && namespace !== HTML_NAMESPACE && namespace !== MATHML_NAMESPACE) return "";
    if (DROP_TAGS.has(tag) || tag === "base" || tag === "meta" || tag === "title") return "";
    if (SAFE_COPY_TAGS.has(tag)) return tag;
    return tag.includes("-") ? "span" : "div";
  }

  function shouldDropElement(element) {
    if (!element || element.nodeType !== 1 || isHiddenOrChrome(element)) return true;
    const tag = String(element.localName || element.tagName || "").toLowerCase();
    if (DROP_TAGS.has(tag)) return true;
    try {
      return element.matches(CLONE_REMOVALS);
    } catch (_) {
      return false;
    }
  }

  function copySafeSubtree(sourceNode, targetDoc, baseUrl) {
    if (!sourceNode) return null;
    if (sourceNode.nodeType === 3) return targetDoc.createTextNode(sourceNode.nodeValue || "");
    if (sourceNode.nodeType !== 1) return null;

    const sourceElement = sourceNode;
    if (shouldDropElement(sourceElement)) return null;
    const sourceTag = String(sourceElement.localName || sourceElement.tagName || "").toLowerCase();
    const targetTag = safeTargetTag(sourceElement);
    if (!targetTag) return null;
    const targetElement = targetDoc.createElement(targetTag);

    const classNames = safeClassNames(sourceElement);
    if (classNames) targetElement.setAttribute("class", classNames);

    if (sourceTag === "a" && targetTag === "a") {
      const href = safeAnchorHref(sourceElement.getAttribute("href"), baseUrl);
      if (href) targetElement.setAttribute("href", href);
    } else if (sourceTag === "img" && targetTag === "img") {
      const alt = sourceElement.getAttribute("alt");
      const dataSrc = sourceElement.getAttribute("data-src") || sourceElement.getAttribute("src");
      if (alt !== null) targetElement.setAttribute("alt", alt);
      if (dataSrc) targetElement.setAttribute("data-src", dataSrc);
    } else if ((sourceTag === "pre" || sourceTag === "code") && sourceElement.hasAttribute("data-language")) {
      targetElement.setAttribute("data-language", sourceElement.getAttribute("data-language") || "");
    } else if (sourceTag === "ol" && sourceElement.hasAttribute("start")) {
      targetElement.setAttribute("start", sourceElement.getAttribute("start") || "");
    } else if (sourceTag === "li" && sourceElement.hasAttribute("value")) {
      targetElement.setAttribute("value", sourceElement.getAttribute("value") || "");
    }

    if ((sourceTag === "math" || sourceElement.namespaceURI === MATHML_NAMESPACE) &&
        ["block", "inline"].includes(String(sourceElement.getAttribute("display") || "").toLowerCase())) {
      targetElement.setAttribute("display", String(sourceElement.getAttribute("display")).toLowerCase());
    }
    if (sourceTag === "annotation") {
      const encoding = String(sourceElement.getAttribute("encoding") || "").toLowerCase();
      if (["application/x-tex", "application/x-latex"].includes(encoding)) targetElement.setAttribute("encoding", encoding);
    }

    if (sourceTag !== "img") {
      for (const child of Array.from(sourceElement.childNodes || [])) {
        const safeChild = copySafeSubtree(child, targetDoc, baseUrl);
        if (safeChild) targetElement.appendChild(safeChild);
      }
    }
    return targetElement;
  }

  function createParserDocument(doc, url, candidates, definition) {
    const parsedDoc = isolatedDocument(doc, url);
    if (!parsedDoc) return null;
    const main = parsedDoc.createElement("main");
    parsedDoc.body.appendChild(main);

    const usedIds = new Set();
    for (const [index, candidate] of candidates.entries()) {
      const wrapper = parsedDoc.createElement("div");
      const baseId = `${definition.id}:${stableDomKey(candidate.element, index)}`;
      let messageId = baseId;
      let suffix = 2;
      while (usedIds.has(messageId)) messageId = `${baseId}#${suffix++}`;
      usedIds.add(messageId);
      wrapper.setAttribute("data-message-author-role", candidate.role);
      wrapper.setAttribute("data-message-id", messageId);

      const safeContent = copySafeSubtree(candidate.content, parsedDoc, url);
      if (!safeContent) continue;
      wrapper.appendChild(safeContent);
      main.appendChild(wrapper);
    }
    return parsedDoc;
  }

  function brandAliases(definition) {
    const known = {
      claude: ["Claude"], qwen: ["Qwen", "通义千问"], deepseek: ["DeepSeek"],
      kimi: ["Kimi"], gemini: ["Gemini"], doubao: ["豆包", "Doubao"], grok: ["Grok"]
    };
    return known[definition.id] || [definition.label];
  }

  function stripProviderBrand(value, definition) {
    let title = String(value || "").replace(/\s+/g, " ").trim();
    for (const brand of brandAliases(definition)) {
      const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      title = title
        .replace(new RegExp(`\\s*(?:[-|–—:]|\\|)\\s*${escaped}\\s*$`, "i"), "")
        .replace(new RegExp(`^${escaped}\\s*(?:[-|–—:]|\\|)\\s*`, "i"), "")
        .trim();
      if (title.toLowerCase() === brand.toLowerCase()) title = "";
    }
    return title;
  }

  function conversationTitle(doc, scope, definition, selectedCandidates) {
    const titles = [];
    if (scope && scope.querySelector) {
      for (const heading of Array.from(scope.querySelectorAll("h1, [data-testid*='conversation-title']"))) {
        const insideMessage = selectedCandidates.some((candidate) => candidate.element.contains(heading));
        if (!insideMessage && !isHiddenOrChrome(heading) && !heading.closest("[data-message-author-role], [data-author-role], [data-role]")) {
          titles.push(heading.textContent);
        }
      }
    }
    titles.push(doc.title || "");
    for (const candidate of titles) {
      const clean = stripProviderBrand(candidate, definition);
      if (clean) return clean.slice(0, 300);
    }
    return `${definition.label} 对话`;
  }

  function collectPlatformConversation(options = {}) {
    const doc = options.document;
    const url = String(options.url || "");
    const platform = getPlatform(url);
    if (!platform || platform.id === "chatgpt" || !doc || doc.nodeType !== 9) return null;
    const definition = byId.get(platform.id);
    const warnings = [...WARNINGS];
    const scope = findScope(doc, definition);
    const candidates = scope ? selectedMessages(scope, definition) : [];
    const parsedDoc = createParserDocument(doc, url, candidates, definition);
    let messages = [];

    if (parsedDoc && typeof namespace.extractConversation === "function") {
      const parsed = namespace.extractConversation(parsedDoc, url);
      messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    }
    if (!messages.length) warnings.push("主对话中没有找到可识别的已加载消息。");

    const messageIds = messages.map((message) => message.id);
    const leafId = messageIds.at(-1) || "";
    return {
      schemaVersion: 2,
      title: conversationTitle(doc, scope, definition, candidates),
      url,
      exportedAt: new Date().toISOString(),
      messages,
      source: { kind: "dom", complete: false, platform: definition.id },
      branches: [{ id: "current", label: "当前页面", leafId, messageIds }],
      activeBranchId: "current",
      assets: [],
      warnings
    };
  }

  namespace.supportedPlatforms = supportedPlatforms;
  namespace.getPlatform = getPlatform;
  namespace.collectPlatformConversation = collectPlatformConversation;
})(globalThis);
