(function attachGptExporter(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  if (typeof api.serialize === 'function') return;

  const FORMATS = Object.freeze({
    markdown: { mime: 'text/markdown;charset=utf-8', extension: 'md' },
    text: { mime: 'text/plain;charset=utf-8', extension: 'txt' },
    html: { mime: 'text/html;charset=utf-8', extension: 'html' },
    json: { mime: 'application/json;charset=utf-8', extension: 'json' },
    csv: { mime: 'text/csv;charset=utf-8', extension: 'csv' }
  });
  const SAFE_TAGS = new Set([
    'p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'sup', 'sub'
  ]);
  const DROP_CONTENT_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math',
    'video', 'audio', 'source', 'form', 'input', 'button', 'textarea', 'select', 'option'
  ]);

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeHref(value) {
    const href = String(value || '').trim();
    if (!href || /[\u0000-\u0020]/.test(href)) return '';
    return /^(https?:|mailto:)/i.test(href) ? href : '';
  }

  function sanitizeWithDom(html, Parser) {
    // Strip resource-bearing elements before parsing: even an inert HTML document
    // may fetch images, frames, media, or stylesheets while it is being built.
    const source = String(html || '')
      .replace(/\s+(?:src|srcset|poster|background|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/<(script|style|iframe|object|embed|svg|math|video|audio|source|form|template|link|base|meta)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(script|style|iframe|object|embed|svg|math|video|audio|source|form|template|link|base|meta)\b[^>]*\/?>/gi, '')
      .replace(/<img\b([^>]*)>/gi, (_tag, attributes) => {
        const match = attributes.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        return match ? escapeHtml(match[1] || match[2] || match[3] || '') : '';
      });
    const doc = new Parser().parseFromString(source, 'text/html');
    const render = (node) => {
      if (node.nodeType === 3) return escapeHtml(node.nodeValue || '');
      if (node.nodeType !== 1) return '';

      const tag = node.localName.toLowerCase();
      if (DROP_CONTENT_TAGS.has(tag)) {
        if (tag === 'img') return escapeHtml(node.getAttribute('alt') || '');
        return '';
      }
      if (tag === 'img') return escapeHtml(node.getAttribute('alt') || '');

      const children = Array.from(node.childNodes, render).join('');
      if (!SAFE_TAGS.has(tag)) return children;

      if (tag === 'a') {
        const href = safeHref(node.getAttribute('href'));
        return href ? `<a href="${escapeHtml(href)}">${children}</a>` : children;
      }
      if ((tag === 'ol' && /^-?\d+$/.test(node.getAttribute('start') || '')) ||
          (tag === 'li' && /^-?\d+$/.test(node.getAttribute('value') || ''))) {
        const attribute = tag === 'ol' ? 'start' : 'value';
        const numericValue = Number(node.getAttribute(attribute));
        if (Number.isSafeInteger(numericValue)) return `<${tag} ${attribute}="${numericValue}">${children}</${tag}>`;
      }
      if (tag === 'br' || tag === 'hr') return `<${tag}>`;
      return `<${tag}>${children}</${tag}>`;
    };
    return Array.from(doc.body.childNodes, render).join('');
  }

  function sanitizeHtml(html) {
    const Parser = root.DOMParser || (root.document && root.document.defaultView && root.document.defaultView.DOMParser);
    // Without a standards parser, prefer escaped text over attempting an unsafe HTML rewrite.
    if (!Parser) return escapeHtml(html || '');
    return sanitizeWithDom(html, Parser);
  }

  function messageBody(message, format) {
    const value = format === 'markdown'
      ? (message.markdown || message.text || '')
      : (message.text || message.markdown || '');
    return String(value).trim();
  }

  function normalizeMessages(conversation, options) {
    const source = Array.isArray(options.messages) ? options.messages : conversation.messages;
    if (!Array.isArray(source)) throw new TypeError('对话消息列表无效');
    return source.map((message) => {
      if (!message || typeof message !== 'object') throw new TypeError('包含无效消息');
      const role = typeof message.role === 'string' ? message.role : 'assistant';
      return {
        id: String(message.id == null ? '' : message.id),
        role,
        markdown: String(message.markdown == null ? '' : message.markdown),
        text: String(message.text == null ? '' : message.text),
        html: String(message.html == null ? '' : message.html)
      };
    });
  }

  function metaLines(conversation) {
    const rows = [];
    if (conversation.title) rows.push(['标题', String(conversation.title)]);
    if (conversation.url) rows.push(['来源', String(conversation.url)]);
    if (conversation.exportedAt) rows.push(['导出时间', String(conversation.exportedAt)]);
    return rows;
  }

  function markdownOutput(conversation, messages, includeMetadata) {
    const sections = [];
    if (includeMetadata) {
      const meta = metaLines(conversation);
      if (meta.length) sections.push(`# ${String(conversation.title || '对话')}` + '\n\n' + meta.map(([label, value]) => `- **${label}：** ${value}`).join('\n'));
      const warnings = Array.isArray(conversation.warnings) ? conversation.warnings.filter(Boolean) : [];
      if (warnings.length) sections.push('> 提示：' + warnings.join('；'));
    }
    for (const message of messages) {
      sections.push(`## ${message.role}\n\n${messageBody(message, 'markdown')}`.trim());
    }
    return sections.join('\n\n---\n\n');
  }

  function textOutput(conversation, messages, includeMetadata) {
    const sections = [];
    if (includeMetadata) {
      const meta = metaLines(conversation);
      if (meta.length) sections.push(meta.map(([label, value]) => `${label}：${value}`).join('\n'));
      const warnings = Array.isArray(conversation.warnings) ? conversation.warnings.filter(Boolean) : [];
      if (warnings.length) sections.push(`提示：${warnings.join('；')}`);
    }
    for (const message of messages) {
      sections.push(`[${message.role}]\n${messageBody(message, 'text')}`.trim());
    }
    return sections.join('\n\n----------------------------------------\n\n');
  }

  function htmlFragment(conversation, messages, includeMetadata) {
    const parts = [];
    if (includeMetadata) {
      const title = escapeHtml(conversation.title || '对话');
      parts.push(`<header><h1>${title}</h1>`);
      const meta = metaLines(conversation).filter(([label]) => label !== '标题');
      if (meta.length) parts.push(`<dl>${meta.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>`);
      const warnings = Array.isArray(conversation.warnings) ? conversation.warnings.filter(Boolean) : [];
      if (warnings.length) parts.push(`<aside><strong>提示：</strong>${warnings.map(escapeHtml).join('；')}</aside>`);
      parts.push('</header>');
    }
    for (const message of messages) {
      const body = sanitizeHtml(message.html || escapeHtml(messageBody(message, 'text')).replace(/\n/g, '<br>'));
      parts.push(`<article><h2>${escapeHtml(message.role)}</h2><div>${body}</div></article>`);
    }
    return parts.join('\n');
  }

  function htmlDocument(conversation, fragment) {
    const title = escapeHtml(conversation.title || '对话导出');
    const styles = [
      'body{margin:0;padding:48px 22px;color:#27312d;background:#f2f4f1;font:16px/1.75 Georgia,"Noto Serif SC",serif}',
      'main{box-sizing:border-box;width:min(100%,820px);min-height:70vh;margin:0 auto;padding:64px 72px;background:#fffefa;box-shadow:0 12px 42px #24352b18}',
      'header{margin:0 0 36px;padding-bottom:22px;border-bottom:1px solid #e4e8e2}',
      'h1{margin:0 0 16px;font:650 30px/1.3 system-ui,sans-serif;letter-spacing:-.035em}',
      'dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0;color:#65716b;font:12px/1.6 system-ui,sans-serif}',
      'dd{margin:0;overflow-wrap:anywhere} aside{margin-top:14px;padding:10px 13px;border-left:3px solid #91ab9d;background:#f1f5f0;color:#566b60;font:12px/1.65 system-ui,sans-serif}',
      'article{margin:0 0 30px;overflow-wrap:anywhere} article h2{margin:0 0 10px;color:#668276;font:750 11px/1.4 system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase}',
      'p{margin:0 0 1em} h3,h4,h5,h6{margin:1.4em 0 .5em;line-height:1.45} ul,ol{padding-left:1.5em} li{margin:.25em 0}',
      'blockquote{margin:1em 0;padding:1px 0 1px 16px;border-left:3px solid #b4c7bd;color:#626d68}',
      'pre{overflow:auto;padding:14px 16px;border:1px solid #e5e7e1;border-radius:6px;background:#f6f7f3;color:#39423e;font:13px/1.65 ui-monospace,monospace;white-space:pre-wrap}',
      'code{padding:.1em .32em;border-radius:4px;background:#eef1ec;color:#43564d;font: .88em ui-monospace,monospace} pre code{padding:0;background:transparent}',
      'a{color:#52786a;text-decoration:underline;text-underline-offset:2px} table{width:100%;margin:1em 0;border-collapse:collapse;font-size:.92em}',
      'th,td{padding:7px 9px;border:1px solid #dfe3dc;text-align:left;vertical-align:top} th{background:#f2f4ef}',
      'hr{height:1px;margin:2em 0;border:0;background:#e2e5df}',
      '@media(max-width:640px){body{padding:12px}main{min-height:0;padding:36px 24px}}',
      '@media print{@page{margin:18mm 20mm}body{padding:0;background:#fff}main{width:100%;min-height:0;padding:0;box-shadow:none}article{break-inside:avoid}a{color:#333}}'
    ].join('');
    return '<!doctype html>\n' +
      '<html lang="zh-Hans">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'none\'; style-src \'unsafe-inline\'; script-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">\n' +
      `<title>${title}</title>\n<style>${styles}</style>\n</head>\n<body>\n<main>\n${fragment}\n</main>\n</body>\n</html>`;
  }

  function normalizeForOptions(conversation, options) {
    if (!conversation || typeof conversation !== 'object') throw new TypeError('对话数据无效');
    const settings = Object.assign({ includeMetadata: true }, options || {});
    return {
      settings,
      messages: normalizeMessages(conversation, settings)
    };
  }

  function renderHtmlFragment(conversation, options) {
    const normalized = normalizeForOptions(conversation, options);
    return htmlFragment(conversation, normalized.messages, Boolean(normalized.settings.includeMetadata));
  }

  function jsonOutput(conversation, messages, includeMetadata) {
    const output = { schemaVersion: 1 };
    if (includeMetadata) {
      output.title = String(conversation.title || '');
      output.url = String(conversation.url || '');
      output.exportedAt = String(conversation.exportedAt || '');
      output.warnings = Array.isArray(conversation.warnings) ? conversation.warnings.map(String) : [];
    }
    output.messages = messages.map((message) => ({
      id: message.id,
      role: message.role,
      markdown: message.markdown,
      text: message.text,
      html: sanitizeHtml(message.html)
    }));
    return JSON.stringify(output, null, 2);
  }

  function csvField(value) {
    let field = String(value == null ? '' : value);
    // Spreadsheet apps may evaluate these leading characters as formulas.
    if (/^[=+\-@\t\r\n]/.test(field)) field = `'${field}`;
    field = field.replace(/\r\n|\r|\n/g, '\r\n');
    return `"${field.replace(/"/g, '""')}"`;
  }

  function csvOutput(conversation, messages, includeMetadata) {
    const header = [];
    if (includeMetadata) header.push('title', 'url', 'exportedAt', 'warnings');
    header.push('id', 'role', 'markdown', 'text', 'html');
    const warnings = Array.isArray(conversation.warnings) ? conversation.warnings.filter(Boolean).join('；') : '';
    const rows = messages.map((message) => {
      const row = [];
      if (includeMetadata) row.push(conversation.title || '', conversation.url || '', conversation.exportedAt || '', warnings);
      row.push(message.id, message.role, message.markdown, message.text, sanitizeHtml(message.html));
      return row;
    });
    return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
  }

  function serialize(conversation, options) {
    if (!conversation || typeof conversation !== 'object') throw new TypeError('对话数据无效');
    const settings = Object.assign({ format: 'markdown', includeMetadata: true }, options || {});
    const descriptor = FORMATS[settings.format];
    if (!descriptor) throw new TypeError('不支持的导出格式');
    const messages = normalizeMessages(conversation, settings);
    let content;
    switch (settings.format) {
      case 'markdown': content = markdownOutput(conversation, messages, Boolean(settings.includeMetadata)); break;
      case 'text': content = textOutput(conversation, messages, Boolean(settings.includeMetadata)); break;
      case 'html': content = htmlDocument(conversation, htmlFragment(conversation, messages, Boolean(settings.includeMetadata))); break;
      case 'json': content = jsonOutput(conversation, messages, Boolean(settings.includeMetadata)); break;
      case 'csv': content = csvOutput(conversation, messages, Boolean(settings.includeMetadata)); break;
    }
    return { content, mime: descriptor.mime, extension: descriptor.extension };
  }

  api.serialize = serialize;
  api.sanitizeHtml = sanitizeHtml;
  api.renderHtmlFragment = renderHtmlFragment;
})(globalThis);
