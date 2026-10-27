((root) => {
  "use strict";

  const namespace = root.GptExporter || (root.GptExporter = {});
  if (typeof namespace.extractConversation === "function") return;

  const ALLOWED_ROLES = new Set(["user", "assistant", "system", "tool"]);
  const SAFE_HTML_TAGS = new Set([
    "a", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3",
    "h4", "h5", "h6", "hr", "i", "kbd", "li", "ol", "p", "pre", "s",
    "span", "strong", "sub", "sup", "table", "tbody", "td", "th", "thead",
    "tr", "ul"
  ]);
  const DROP_TAGS = new Set([
    "audio", "button", "canvas", "embed", "footer", "form", "header", "iframe",
    "input", "nav", "noscript", "object", "script", "select", "style", "svg",
    "textarea", "video"
  ]);
  const BLOCK_TAGS = new Set([
    "article", "blockquote", "div", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "li", "ol", "p", "pre", "section", "table", "ul"
  ]);
  const HISTORY_WARNING = "仅包含当前已加载并挂载在对话 DOM 中的消息；不会获取更早或尚未加载的历史记录。";
  const PRESERVED_TEXT_START = "\uE000";
  const PRESERVED_TEXT_END = "\uE001";

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ");
  }

  function preservedText(value) {
    const text = String(value || "").replace(/\r\n?/g, "\n")
      .replaceAll(PRESERVED_TEXT_START, "�")
      .replaceAll(PRESERVED_TEXT_END, "�");
    return `${PRESERVED_TEXT_START}${text}${PRESERVED_TEXT_END}`;
  }

  function isWhitespacePreserving(element) {
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      const classes = String(current.getAttribute("class") || "").split(/\s+/);
      if (classes.includes("whitespace-pre-wrap") || classes.includes("whitespace-pre") || classes.includes("whitespace-break-spaces")) return true;
      const style = String(current.getAttribute("style") || "");
      if (/(?:^|;)\s*white-space\s*:\s*(?:pre-wrap|pre|break-spaces)(?:\s*!important)?\s*(?:;|$)/i.test(style)) return true;
    }
    return false;
  }

  function isFormattingWhitespace(node) {
    if (!node || node.nodeType !== 3 || !/^\s*$/.test(node.nodeValue || "") || !/[\r\n]/.test(node.nodeValue || "")) return false;
    const parent = node.parentElement;
    if (!parent) return false;
    return Array.from(parent.children || []).some((child) => BLOCK_TAGS.has(child.tagName.toLowerCase()));
  }

  function safeIntegerAttribute(value) {
    const text = String(value || "").trim();
    if (!/^-?\d+$/.test(text)) return "";
    const number = Number(text);
    return Number.isSafeInteger(number) ? String(number) : "";
  }

  function maskPreservedText(value) {
    const preserved = [];
    const masked = String(value || "").replace(/\uE000([\s\S]*?)\uE001/g, (_, content) => {
      const token = `\uE100${preserved.length}\uE101`;
      preserved.push(content);
      return token;
    });
    return {
      masked,
      restore(text) {
        return text.replace(/\uE100(\d+)\uE101/g, (token, index) => preserved[Number(index)] ?? token);
      }
    };
  }

  function escapeMarkdownText(value) {
    return String(value).replace(/([\\`*_{}\[\]()#+.!|>~$-])/g, "\\$1");
  }

  function normalizedRole(value) {
    const role = String(value || "").trim().toLowerCase();
    if (ALLOWED_ROLES.has(role)) return role;
    if (role === "function" || role === "tool_call") return "tool";
    if (role === "developer") return "system";
    return "";
  }

  function isHiddenOrChrome(element) {
    if (!element || element.nodeType !== 1) return true;
    if (element.closest("aside, nav, [role='navigation'], [aria-hidden='true'], [hidden]")) return true;
    return false;
  }

  function isDropped(element) {
    if (!element || element.nodeType !== 1) return false;
    if (DROP_TAGS.has(element.tagName.toLowerCase())) return true;
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
    const testId = (element.getAttribute("data-testid") || "").toLowerCase();
    return /(?:copy|toolbar|message-actions|turn-actions|feedback|regenerate|retry|share|edit-message)/.test(testId);
  }

  function allowedUrl(raw, doc, image) {
    const value = String(raw || "").trim();
    if (!value) return "";
    try {
      const parsed = new URL(value, doc.baseURI || doc.URL || "https://chatgpt.com/");
      const allowed = image ? ["http:", "https:"] : ["http:", "https:", "mailto:"];
      return allowed.includes(parsed.protocol.toLowerCase()) ? parsed.href : "";
    } catch (_) {
      return "";
    }
  }

  function imageInfo(element, doc) {
    const alt = normalizeWhitespace(element.getAttribute("alt") || "").trim();
    const source = element.getAttribute("src") || element.getAttribute("data-src") || "";
    return { alt, url: allowedUrl(source, doc, true) };
  }

  function isMathElement(element) {
    if (!element || element.nodeType !== 1) return false;
    const tag = element.tagName.toLowerCase();
    if (tag === "math") return true;
    if (tag === "script" && /^math\/tex/i.test(element.getAttribute("type") || "")) return true;
    const classes = String(element.getAttribute("class") || "").toLowerCase().split(/\s+/);
    return classes.some((name) => name.startsWith("katex") || name === "mathjax" || name.startsWith("mathjax_") || name.startsWith("mjx-container"));
  }

  function isBlockMathElement(element) {
    const classes = String(element.getAttribute("class") || "").toLowerCase();
    return element.getAttribute("display") === "block" || /(?:^|\s)(?:katex-display|mathjax_display|mjx-container\[display=block\])(?:\s|$)/.test(classes);
  }

  function mathTex(element) {
    const annotation = element.querySelector && element.querySelector("annotation[encoding='application/x-tex'], annotation[encoding='application/x-latex']");
    if (annotation && annotation.textContent.trim()) return annotation.textContent.trim();
    if (element.tagName && element.tagName.toLowerCase() === "script") {
      return String(element.textContent || "").trim();
    }
    return "";
  }

  function getLanguage(pre) {
    const code = pre.querySelector("code");
    const candidates = [
      code && code.getAttribute("class"),
      code && code.getAttribute("data-language"),
      pre.getAttribute("data-language"),
      pre.getAttribute("class")
    ].filter(Boolean).join(" ");
    const match = candidates.match(/(?:language|lang)-([a-z0-9_+#.-]+)/i) || candidates.match(/(?:^|\s)(?:language|lang)=([a-z0-9_+#.-]+)/i);
    return match ? match[1].replace(/[^a-z0-9_+#.-]/gi, "") : "";
  }

  function rawCodeText(pre) {
    const code = pre.querySelector("code") || pre;
    return String(code.textContent || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  }

  function markdownCodeFence(value, language) {
    const runs = String(value).match(/`+/g) || [];
    const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
    return `${fence}${language || ""}\n${value}\n${fence}`;
  }

  function directChildren(element) {
    return Array.from(element.children || []);
  }

  function markdownChildren(element, doc) {
    return Array.from(element.childNodes || []).map((child) => markdownNode(child, doc)).join("");
  }

  function markdownInlineChildren(element, doc) {
    return markdownChildren(element, doc).replace(/\n{2,}/g, " ").replace(/\n/g, " ").trim();
  }

  function listMarkdown(list, doc, indent) {
    const ordered = list.tagName.toLowerCase() === "ol";
    const startValue = safeIntegerAttribute(list.getAttribute("start"));
    let counter = startValue ? Number(startValue) : 1;
    const lines = [];
    for (const item of directChildren(list).filter((child) => child.tagName.toLowerCase() === "li")) {
      const nestedLists = directChildren(item).filter((child) => ["ul", "ol"].includes(child.tagName.toLowerCase()));
      const inlineParts = [];
      for (const child of Array.from(item.childNodes || [])) {
        if (child.nodeType === 1 && ["ul", "ol"].includes(child.tagName.toLowerCase())) continue;
        inlineParts.push(markdownNode(child, doc));
      }
      const label = inlineParts.join("").trim().replace(/\n{2,}/g, " ").replace(/\n/g, " ");
      const itemValue = safeIntegerAttribute(item.getAttribute("value"));
      if (ordered && itemValue) counter = Number(itemValue);
      const marker = ordered ? `${counter++}.` : "-";
      lines.push(`${indent}${marker}${label ? ` ${label}` : ""}`);
      for (const nested of nestedLists) {
        const rendered = listMarkdown(nested, doc, `${indent}${" ".repeat(marker.length + 1)}`);
        if (rendered) lines.push(rendered);
      }
    }
    return lines.join("\n");
  }

  function tableMarkdown(table, doc) {
    const rows = Array.from(table.querySelectorAll("tr")).filter((row) => row.closest("table") === table);
    if (!rows.length) return "";
    const matrix = rows.map((row) => Array.from(row.children)
      .filter((cell) => ["th", "td"].includes(cell.tagName.toLowerCase()))
      .map((cell) => markdownInlineChildren(cell, doc).replace(/\|/g, "\\|").replace(/\n/g, "<br>")));
    if (!matrix.some((row) => row.length)) return "";
    const width = Math.max(...matrix.map((row) => row.length));
    const padded = matrix.map((row) => Array.from({ length: width }, (_, index) => row[index] || ""));
    const headIndex = rows.findIndex((row) => row.parentElement && row.parentElement.tagName.toLowerCase() === "thead");
    const header = headIndex >= 0 ? padded.splice(headIndex, 1)[0] : padded.shift();
    const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
    for (const row of padded) lines.push(`| ${row.join(" | ")} |`);
    return lines.join("\n");
  }

  function markdownNode(node, doc) {
    if (!node) return "";
    if (node.nodeType === 3) {
      const sourceText = String(node.nodeValue || "").replace(/\r\n?/g, "\n");
      if (isWhitespacePreserving(node.parentElement)) return preservedText(escapeMarkdownText(sourceText));
      if (isFormattingWhitespace(node)) return "";
      return escapeMarkdownText(normalizeWhitespace(sourceText));
    }
    if (node.nodeType !== 1 || isDropped(node)) return "";

    const element = node;
    const tag = element.tagName.toLowerCase();
    if (tag === "img") {
      const info = imageInfo(element, doc);
      const label = escapeMarkdownText(info.alt || "image");
      return info.url ? `![${label}](<${info.url}>)` : (info.alt ? label : "");
    }
    if (isMathElement(element)) {
      const tex = mathTex(element);
      if (tex) return isBlockMathElement(element)
        ? `$$\n${tex}\n$$`
        : `$${tex}$`;
    }
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n\n---\n\n";
    if (tag === "pre") return `\n\n${markdownCodeFence(rawCodeText(element), getLanguage(element))}\n\n`;
    if (tag === "code") {
      const value = String(element.textContent || "").replace(/\r\n?/g, "\n").replace(/\n/g, " ");
      const ticks = Math.max(1, ...((value.match(/`+/g) || []).map((run) => run.length + 1)));
      const fence = "`".repeat(ticks);
      const pad = /^`|`$|^\s|\s$/.test(value) ? " " : "";
      return `${fence}${pad}${value}${pad}${fence}`;
    }
    if (tag === "ul" || tag === "ol") return `\n\n${listMarkdown(element, doc, "")}\n\n`;
    if (tag === "table") return `\n\n${tableMarkdown(element, doc)}\n\n`;
    if (tag === "blockquote") {
      const body = markdownChildren(element, doc).trim();
      return body ? `\n\n${body.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` : "";
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      const body = markdownInlineChildren(element, doc);
      return body ? `\n\n${"#".repeat(level)} ${body}\n\n` : "";
    }
    if (tag === "a") {
      const label = markdownInlineChildren(element, doc);
      const href = allowedUrl(element.getAttribute("href"), doc, false);
      return href ? `[${label || escapeMarkdownText(href)}](<${href}>)` : label;
    }
    const body = markdownChildren(element, doc);
    if (["strong", "b"].includes(tag)) return body ? `**${body}**` : "";
    if (["em", "i"].includes(tag)) return body ? `*${body}*` : "";
    if (["del", "s", "strike"].includes(tag)) return body ? `~~${body}~~` : "";
    if (tag === "sub") return body ? `~${body}~` : "";
    if (tag === "sup") return body ? `^${body}^` : "";
    if (tag === "li") return `- ${body.trim()}`;
    if (["p", "div", "section", "article"].includes(tag)) {
      const content = body.trim();
      return content ? `\n\n${content}\n\n` : "";
    }
    return body;
  }

  function safeHtmlNode(node, doc, preserveWhitespace) {
    if (!node) return "";
    if (node.nodeType === 3) {
      const sourceText = String(node.nodeValue || "").replace(/\r\n?/g, "\n");
      const text = preserveWhitespace ? sourceText : normalizeWhitespace(sourceText);
      const escaped = escapeHtml(text);
      return preserveWhitespace ? escaped.replace(/\n/g, "<br>") : escaped;
    }
    if (node.nodeType !== 1 || isDropped(node)) return "";

    const element = node;
    const tag = element.tagName.toLowerCase();
    if (tag === "img") return escapeHtml(normalizeWhitespace(element.getAttribute("alt") || ""));
    if (isMathElement(element)) {
      const tex = mathTex(element);
      if (tex) return `<code>${escapeHtml(tex)}</code>`;
    }
    if (tag === "script") return "";
    const keepWhitespace = preserveWhitespace || tag === "pre" || tag === "code" || isWhitespacePreserving(element);
    const body = Array.from(element.childNodes || []).map((child) => safeHtmlNode(child, doc, keepWhitespace)).join("");
    if (!SAFE_HTML_TAGS.has(tag)) return body;
    if (tag === "br" || tag === "hr") return `<${tag}>`;
    if (tag === "a") {
      const href = allowedUrl(element.getAttribute("href"), doc, false);
      return href ? `<a href="${escapeHtml(href)}">${body}</a>` : body;
    }
    if (tag === "ol" || tag === "li") {
      const name = tag === "ol" ? "start" : "value";
      const number = safeIntegerAttribute(element.getAttribute(name));
      return `<${tag}${number ? ` ${name}="${number}"` : ""}>${body}</${tag}>`;
    }
    return `<${tag}>${body}</${tag}>`;
  }

  function textNode(node, doc, preserveWhitespace) {
    if (!node) return "";
    if (node.nodeType === 3) {
      const sourceText = String(node.nodeValue || "").replace(/\r\n?/g, "\n");
      if (preserveWhitespace) return preservedText(sourceText);
      if (isFormattingWhitespace(node)) return "";
      return normalizeWhitespace(sourceText);
    }
    if (node.nodeType !== 1 || isDropped(node)) return "";

    const element = node;
    const tag = element.tagName.toLowerCase();
    if (tag === "img") return normalizeWhitespace(element.getAttribute("alt") || "");
    if (isMathElement(element)) {
      const tex = mathTex(element);
      if (tex) return tex;
    }
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n";
    if (tag === "pre") return `\n\n${preservedText(rawCodeText(element))}\n\n`;
    if (tag === "code") return preservedText(String(element.textContent || "").replace(/\r\n?/g, "\n"));
    if (tag === "table") {
      return Array.from(element.querySelectorAll("tr"))
        .filter((row) => row.closest("table") === element)
        .map((row) => Array.from(row.children).filter((cell) => ["td", "th"].includes(cell.tagName.toLowerCase()))
          .map((cell) => textNode(cell, doc, false).trim()).join("\t"))
        .join("\n");
    }
    if (tag === "ul" || tag === "ol") {
      return textList(element, doc, "");
    }
    const preserve = preserveWhitespace || tag === "pre" || tag === "code" || isWhitespacePreserving(element);
    const content = Array.from(element.childNodes || []).map((child) => textNode(child, doc, preserve)).join("");
    if (BLOCK_TAGS.has(tag)) return `\n${content.trim()}\n`;
    return content;
  }

  function textList(list, doc, indent) {
    const ordered = list.tagName.toLowerCase() === "ol";
    const start = safeIntegerAttribute(list.getAttribute("start"));
    let counter = start ? Number(start) : 1;
    const lines = [];
    for (const item of directChildren(list).filter((child) => child.tagName.toLowerCase() === "li")) {
      const nested = directChildren(item).filter((child) => ["ul", "ol"].includes(child.tagName.toLowerCase()));
      const label = Array.from(item.childNodes || [])
        .filter((child) => !(child.nodeType === 1 && ["ul", "ol"].includes(child.tagName.toLowerCase())))
        .map((child) => textNode(child, doc, false)).join("").trim();
      const itemValue = safeIntegerAttribute(item.getAttribute("value"));
      if (ordered && itemValue) counter = Number(itemValue);
      const marker = ordered ? `${counter++}.` : "•";
      lines.push(`${indent}${marker}${label ? ` ${label}` : ""}`);
      for (const childList of nested) {
        const childIndent = `${indent}${" ".repeat(marker.length + 1)}`;
        lines.push(textList(childList, doc, childIndent));
      }
    }
    return lines.join("\n");
  }

  function finishText(value) {
    const protectedText = maskPreservedText(value);
    const cleaned = protectedText.masked
      .replace(/[\t ]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return protectedText.restore(cleaned);
  }

  function finishMarkdown(value) {
    const protectedText = maskPreservedText(value);
    return protectedText.restore(protectedText.masked.trim());
  }

  function candidateNodes(doc) {
    const main = doc.querySelector("main");
    const scope = main || doc;
    const primary = [];
    if (scope.matches && scope.matches("[data-message-author-role]")) primary.push(scope);
    primary.push(...Array.from(scope.querySelectorAll("[data-message-author-role]")));
    const validPrimary = primary
      .filter((element) => !isHiddenOrChrome(element) && normalizedRole(element.getAttribute("data-message-author-role")))
      .filter((element) => !element.parentElement?.closest("[data-message-author-role]"));
    if (validPrimary.length) {
      return validPrimary.map((element) => ({ element, content: element, role: normalizedRole(element.getAttribute("data-message-author-role")) }));
    }

    const articles = Array.from(scope.querySelectorAll("article[data-testid^='conversation-turn']"));
    return articles.filter((article) => !isHiddenOrChrome(article)).map((article) => {
      const markers = Array.from(article.querySelectorAll("[data-message-author-role], [data-author-role], [data-role]"));
      const ownRole = normalizedRole(article.getAttribute("data-message-author-role") || article.getAttribute("data-author-role") || article.getAttribute("data-role"));
      const marker = markers.find((item) => normalizedRole(item.getAttribute("data-message-author-role") || item.getAttribute("data-author-role") || item.getAttribute("data-role")));
      const role = ownRole || (marker && normalizedRole(marker.getAttribute("data-message-author-role") || marker.getAttribute("data-author-role") || marker.getAttribute("data-role"))) || "";
      const aria = `${article.getAttribute("aria-label") || ""} ${marker ? marker.getAttribute("aria-label") || "" : ""}`.toLowerCase();
      const inferred = /\b(user|you)\b/.test(aria) ? "user" : /\b(assistant|chatgpt)\b/.test(aria) ? "assistant" : "";
      return { element: article, content: marker || article, role: role || inferred };
    }).filter((candidate) => candidate.role);
  }

  function messageId(element, fallbackIndex) {
    const id = String(element.getAttribute("data-message-id") || element.getAttribute("data-id") || "").trim();
    return id;
  }

  function conversationTitle(doc) {
    const main = doc.querySelector("main");
    if (main) {
      let titleNode = main.querySelector("[data-testid='conversation-title'], [data-testid*='conversation-title']");
      if (!titleNode) {
        titleNode = Array.from(main.querySelectorAll("h1"))
          .find((heading) => !heading.closest("[data-message-author-role], article[data-testid^='conversation-turn'], button, aside, nav"));
      }
      if (titleNode && !isDropped(titleNode)) {
        const title = normalizeWhitespace(titleNode.textContent).trim();
        if (title && !/^chatgpt$/i.test(title)) return title;
      }
    }
    const documentTitle = normalizeWhitespace(doc.title || "").trim();
    const title = documentTitle.replace(/\s*(?:[-|–—])\s*ChatGPT\s*$/i, "").replace(/^ChatGPT\s*(?:[-|–—])\s*/i, "").trim();
    return title && !/^chatgpt$/i.test(title) ? title : "ChatGPT conversation";
  }

  function extractConversation(doc, pageUrl) {
    const sourceDocument = doc && doc.nodeType === 9 ? doc : null;
    const warnings = [HISTORY_WARNING];
    const messages = [];
    if (!sourceDocument) {
      warnings.push("无法读取对话文档，因此没有提取任何消息。");
      return {
        schemaVersion: 1,
        title: "ChatGPT conversation",
        url: String(pageUrl || ""),
        exportedAt: new Date().toISOString(),
        messages,
        warnings
      };
    }

    const candidates = candidateNodes(sourceDocument);
    const seenMessageIds = new Set();
    const usedIds = new Set();
    for (const [index, candidate] of candidates.entries()) {
      const explicitId = messageId(candidate.element, index);
      if (explicitId && seenMessageIds.has(explicitId)) continue;
      if (explicitId) seenMessageIds.add(explicitId);

      let id = explicitId || `dom-position-${index + 1}`;
      let suffix = 2;
      while (usedIds.has(id)) id = `${explicitId || `dom-position-${index + 1}`}#${suffix++}`;
      usedIds.add(id);

      const content = candidate.content;
      messages.push({
        id,
        role: candidate.role,
        markdown: finishMarkdown(markdownNode(content, sourceDocument)),
        text: finishText(textNode(content, sourceDocument, false)),
        html: safeHtmlNode(content, sourceDocument, false)
      });
    }
    if (!messages.length) warnings.push("主对话 DOM 中没有找到已加载的消息。");

    let resolvedUrl = String(pageUrl || "");
    if (!resolvedUrl && sourceDocument.location && sourceDocument.location.href) resolvedUrl = sourceDocument.location.href;
    return {
      schemaVersion: 1,
      title: conversationTitle(sourceDocument),
      url: resolvedUrl,
      exportedAt: new Date().toISOString(),
      messages,
      warnings
    };
  }

  namespace.extractConversation = extractConversation;
})(globalThis);
