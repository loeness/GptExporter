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
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'sup', 'sub',
    'article', 'header', 'aside', 'div', 'span', 'small', 'section', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'img', 'time'
  ]);
  const DROP_CONTENT_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math',
    'video', 'audio', 'source', 'form', 'input', 'button', 'textarea', 'select', 'option'
  ]);
  const SAFE_DATA_ATTRS = new Set([
    'data-message-id', 'data-ge-math', 'data-ge-display', 'data-ge-tex', 'data-ge-rendered',
    'data-ge-image-placeholder', 'data-ge-image-index', 'data-ge-alt', 'data-ge-image-ref',
    'data-ge-asset-id', 'data-ge-mermaid', 'data-ge-mermaid-error', 'data-role'
  ]);
  const EXCLUDED_CONTENT = [
    '[data-citation]', '[data-citation-id]', '[data-annotation-type="citation" i]',
    '[data-testid*="citation" i]', '[data-testid*="sources" i]',
    '[data-testid*="analysis" i]', '[data-testid*="reasoning" i]',
    '[data-testid*="thinking" i]', '[data-testid*="thought" i]',
    '[data-testid*="tool-call" i]', '[data-testid*="tool_call" i]',
    '[data-message-channel="analysis" i]', '[data-channel="analysis" i]',
    '[data-message-type="analysis" i]'
  ].join(',');
  const SAFE_RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const BLOCKED_DOWNLOAD_TYPES = new Set([
    'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml',
    'application/javascript', 'text/javascript', 'application/ecmascript', 'text/ecmascript'
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

  function safeRasterDataUrl(value) {
    const match = String(value || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i);
    return match && match[2].length % 4 === 0 && SAFE_RASTER_TYPES.has(match[1].toLowerCase()) ? String(value) : '';
  }

  function safeAttachmentDataUrl(value) {
    const match = String(value || '').match(/^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/i);
    if (!match || match[2].length % 4 !== 0 || BLOCKED_DOWNLOAD_TYPES.has(match[1].toLowerCase())) return '';
    return String(value);
  }

  function safeDownloadName(value) {
    const name = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim().slice(0, 180);
    return name || '';
  }

  function rawAttribute(attributes, name) {
    const expression = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = String(attributes || '').match(expression);
    return match ? String(match[1] || match[2] || match[3] || '') : '';
  }

  function safeImageDimension(value) {
    const dimension = String(value || '');
    return /^\d{1,5}$/.test(dimension) && Number(dimension) > 0 && Number(dimension) <= 30000
      ? String(Number(dimension)) : '';
  }

  function prepareHtmlForParsing(value) {
    return String(value || '')
      .replace(/<img\b([^>]*)>/gi, (_tag, attributes) => {
        const data = safeRasterDataUrl(rawAttribute(attributes, 'src'));
        const alt = rawAttribute(attributes, 'alt');
        const width = safeImageDimension(rawAttribute(attributes, 'width'));
        const height = safeImageDimension(rawAttribute(attributes, 'height'));
        const classes = safeClass(rawAttribute(attributes, 'class')).split(/\s+/)
          .filter(value => value === 'ge-inline-math' || value === 'ge-snapshot-image').join(' ');
        return '<img' + (data ? ' data-ge-safe-image="' + data + '"' : '') +
          ' alt="' + alt.replace(/"/g, '&quot;') + '"' +
          (classes ? ` class="${classes}"` : '') +
          (width ? ' width="' + width + '"' : '') + (height ? ' height="' + height + '"' : '') + '>';
      })
      .replace(/\s+(?:src|srcset|poster|background|style|srcdoc|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/<(script|style|iframe|object|embed|svg|math|video|audio|source|form|template|link|base|meta)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(script|style|iframe|object|embed|svg|math|video|audio|source|form|template|link|base|meta)\b[^>]*\/?>/gi, '');
  }

  function safeClass(value) {
    return String(value || '').split(/\s+/).filter((token) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(token)).join(' ');
  }

  function safeMediaReference(value) {
    try {
      const url = new URL(String(value || ''));
      const host = url.hostname.toLowerCase();
      const allowedHost = host === 'chatgpt.com' || host.endsWith('.chatgpt.com') ||
        host === 'oaiusercontent.com' || host.endsWith('.oaiusercontent.com') ||
        /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(host);
      return url.protocol === 'https:' && !url.username && !url.password && allowedHost && !url.search && !url.hash;
    } catch (_) { return false; }
  }

  function sanitizeWithDom(html, Parser) {
    // Strip resource-bearing elements before parsing: even an inert HTML document
    // may fetch images, frames, media, or stylesheets while it is being built.
    const source = prepareHtmlForParsing(html);
    const doc = new Parser().parseFromString(source, 'text/html');
    try {
      for (const element of Array.from(doc.querySelectorAll(EXCLUDED_CONTENT))) element.remove();
    } catch (_) {
      // Keep a safe sanitized result if an older parser rejects an attribute selector.
    }
    const render = (node) => {
      if (node.nodeType === 3) return escapeHtml(node.nodeValue || '');
      if (node.nodeType !== 1) return '';

      const tag = node.localName.toLowerCase();
      if (DROP_CONTENT_TAGS.has(tag)) {
        if (tag === 'img') return escapeHtml(node.getAttribute('alt') || '');
        return '';
      }
      if (tag === 'img') {
        const src = safeRasterDataUrl(node.getAttribute('data-ge-safe-image'));
        const alt = node.getAttribute('alt') || '';
        if (!src) return escapeHtml(alt);
        const attributes = [`src="${escapeHtml(src)}"`, `alt="${escapeHtml(alt)}"`];
        const className = safeClass(node.getAttribute('class'));
        if (className) attributes.push(`class="${escapeHtml(className)}"`);
        for (const name of ['width', 'height']) {
          const value = node.getAttribute(name) || '';
          if (/^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 30000) attributes.push(`${name}="${Number(value)}"`);
        }
        return `<img ${attributes.join(' ')}>`;
      }

      const children = Array.from(node.childNodes, render).join('');
      if (!SAFE_TAGS.has(tag)) return children;

      if (tag === 'a') {
        const download = safeDownloadName(node.getAttribute('download'));
        const dataHref = download ? safeAttachmentDataUrl(node.getAttribute('href')) : '';
        if (dataHref) return `<a href="${escapeHtml(dataHref)}" download="${escapeHtml(download)}">${children}</a>`;
        const href = safeHref(node.getAttribute('href'));
        return href ? `<a href="${escapeHtml(href)}">${children}</a>` : children;
      }
      if (tag === 'img') return children;
      const attributes = [];
      const className = safeClass(node.getAttribute('class'));
      if (className) attributes.push(`class="${escapeHtml(className)}"`);
      for (const attribute of Array.from(node.attributes)) {
        const name = attribute.name.toLowerCase();
        if (SAFE_DATA_ATTRS.has(name)) {
          const value = attribute.value;
          if (name === 'data-role' && (tag !== 'article' || !/^(?:user|assistant|system|tool|function|developer)$/.test(value.toLowerCase()))) continue;
          if (name === 'data-ge-image-ref') {
            if (!safeMediaReference(value)) continue;
          }
          if (name === 'data-ge-asset-id' && !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) continue;
          if (name === 'data-ge-image-index' && !/^\d{1,8}$/.test(value)) continue;
          attributes.push(`${name}="${escapeHtml(value)}"`);
        } else if (name === 'aria-label' || name === 'aria-hidden' || name === 'role') {
          if (/^[\w -]{1,120}$/.test(attribute.value)) attributes.push(`${name}="${escapeHtml(attribute.value)}"`);
        } else if (name === 'datetime' && tag === 'time') {
          if (/^[\w:+.TZ -]{1,48}$/.test(attribute.value)) attributes.push(`datetime="${escapeHtml(attribute.value)}"`);
        }
      }
      if ((tag === 'ol' && /^-?\d+$/.test(node.getAttribute('start') || '')) ||
          (tag === 'li' && /^-?\d+$/.test(node.getAttribute('value') || ''))) {
        const attribute = tag === 'ol' ? 'start' : 'value';
        const numericValue = Number(node.getAttribute(attribute));
        if (Number.isSafeInteger(numericValue)) return `<${tag} ${attribute}="${numericValue}">${children}</${tag}>`;
      }
      if (tag === 'br' || tag === 'hr') return `<${tag}>`;
      return `<${tag}${attributes.length ? ` ${attributes.join(' ')}` : ''}>${children}</${tag}>`;
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

  function formatTimestamp(value, settings) {
    const helper = api.exportSettings && api.exportSettings.formatTimestamp;
    const fallback = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    if (typeof helper !== 'function') return fallback;
    try { return String(helper(value, settings) || ''); }
    catch (_) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }
  }

  function messageTimestamp(message, settings) {
    return formatTimestamp(message && message.createTime, settings);
  }

  function roleLabel(message, settings) {
    const role = String(message && message.role || 'assistant');
    if (!settings.customizeRoleNames) return role;
    const names = settings.roleNames && typeof settings.roleNames === 'object' ? settings.roleNames : {};
    return String(names[role] || role).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() || role;
  }

  function metadataRows(conversation, settings) {
    const rows = [];
    if (settings.includeTitleInNonPdf && conversation.title) rows.push(['标题', redactMetadataText(conversation.title)]);
    if (settings.includeConversationLink && conversation.url) {
      const url = safeMetadataUrl(conversation.url);
      if (url) rows.push(['来源', url]);
    }
    if (conversation.exportedAt) rows.push(['导出时间', formatTimestamp(conversation.exportedAt, settings)]);
    if (settings.includeUserName && String(settings.userName || '').trim()) rows.push(['用户名', String(settings.userName).trim()]);
    if (settings.includeUserEmail && String(settings.userEmail || '').trim()) rows.push(['邮箱', String(settings.userEmail).trim()]);
    return rows;
  }

  function branchLabelsByMessage(conversation, messages) {
    const byMessage = new Map();
    const branches = Array.isArray(conversation && conversation.branches) ? conversation.branches : [];
    const selection = conversation && conversation.selection;
    if (!selection || selection.branchId !== '__all' || branches.length < 2) return byMessage;
    const selected = new Set(messages.map(message => message.id));
    for (const branch of branches) {
      if (!branch || !Array.isArray(branch.messageIds)) continue;
      const label = redactMetadataText(String(branch.label || branch.id || '')).replace(/\s+/g, ' ').trim();
      if (!label) continue;
      for (const id of branch.messageIds) {
        if (!selected.has(id)) continue;
        if (!byMessage.has(id)) byMessage.set(id, new Set());
        byMessage.get(id).add(label);
      }
    }
    for (const [id, labels] of byMessage) byMessage.set(id, [...labels]);
    return byMessage;
  }

  function markdownInlineText(value) {
    return String(value || '').replace(/\r?\n/g, ' ').replace(/&/g, '&amp;')
      .replace(/([\\*_{}\[\]()#+\-.!|<>])/g, '\\$1')
      .replace(/\x60/g, () => '\\' + String.fromCharCode(96));
  }

  function normalizeMessages(conversation, options) {
    const source = Array.isArray(options.messages) ? options.messages : conversation.messages;
    if (!Array.isArray(source)) throw new TypeError('对话消息列表无效');
    const normalized = source.map((message) => {
      if (!message || typeof message !== 'object') throw new TypeError('包含无效消息');
      const role = typeof message.role === 'string' ? message.role : 'assistant';
      return {
        id: String(message.id == null ? '' : message.id),
        role,
        ...(typeof message.visibility === 'string' ? { visibility: message.visibility } : {}),
        ...(typeof message.classification === 'string' ? { classification: message.classification } : {}),
        ...(message.createTime != null ? { createTime: String(message.createTime) } : {}),
        markdown: String(message.markdown == null ? '' : message.markdown),
        text: String(message.text == null ? '' : message.text),
        html: String(message.html == null ? '' : message.html),
        assetIds: Array.isArray(message.assetIds) ? message.assetIds.map(String) : []
      };
    });
    return typeof api.filterVisibleMessages === 'function' ? api.filterVisibleMessages(normalized) : normalized;
  }

  function markdownOutput(conversation, messages, settings) {
    const sections = [];
    const branchLabels = branchLabelsByMessage(conversation, messages);
    if (settings.includeMetadata) {
      const meta = metadataRows(conversation, settings);
      const title = settings.includeTitleInNonPdf && conversation.title ? `# ${redactMetadataText(conversation.title)}` : '';
      if (meta.length || title) sections.push([title, meta.map(([label, value]) => {
        const rendered = label === '来源' && settings.includeConversationLink ? `[${markdownInlineText(value)}](<${value}>)` : markdownInlineText(value);
        return `- **${label}：** ${rendered}`;
      }).join('\n')].filter(Boolean).join('\n\n'));
      const warnings = Array.isArray(conversation.warnings) ? conversation.warnings.filter(Boolean) : [];
      if (warnings.length) sections.push('> 提示：' + warnings.map(redactMetadataText).join('；'));
    }
    for (const message of messages) {
      const branches = branchLabels.get(message.id) || [];
      const note = branches.length ? '> 所属分支：' + branches.map(markdownInlineText).join('、') + '\n\n' : '';
      const timestamp = settings.includeMessageTimestamp ? messageTimestamp(message, settings) : '';
      const heading = '## ' + markdownInlineText(roleLabel(message, settings)) + (timestamp ? ' · ' + markdownInlineText(timestamp) : '');
      sections.push((heading + '\n\n' + note + messageBody(message, 'markdown')).trim());
    }
    return sections.join('\n\n---\n\n');
  }

  function textOutput(conversation, messages, settings) {
    const sections = [];
    const branchLabels = branchLabelsByMessage(conversation, messages);
    if (settings.includeMetadata) {
      const meta = metadataRows(conversation, settings).filter(([label]) => label !== '标题');
      if (meta.length) sections.push(meta.map(([label, value]) => `${label}：${value}`).join('\n'));
      if (settings.includeTitleInNonPdf && conversation.title) sections.unshift(`标题：${redactMetadataText(conversation.title)}`);
      const warnings = Array.isArray(conversation.warnings) ? conversation.warnings.filter(Boolean) : [];
      if (warnings.length) sections.push(`提示：${warnings.map(redactMetadataText).join('；')}`);
    }
    for (const message of messages) {
      const branches = branchLabels.get(message.id) || [];
      const note = branches.length ? '所属分支：' + branches.join('、') + '\n' : '';
      const timestamp = settings.includeMessageTimestamp ? messageTimestamp(message, settings) : '';
      sections.push(('[' + roleLabel(message, settings) + ']' + (timestamp ? ' ' + timestamp : '') + '\n' + note + messageBody(message, 'text')).trim());
    }
    return sections.join('\n\n----------------------------------------\n\n');
  }

  function updateArticleHeader(article, message, settings, doc) {
    let heading = article.querySelector('h2');
    if (!heading) {
      heading = doc.createElement('h2');
      article.insertBefore(heading, article.firstChild);
    }
    let avatar = heading.querySelector('.message-avatar');
    if (!avatar) avatar = doc.createElement('span');
    avatar.className = 'message-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    let time = heading.querySelector('time');
    const timestamp = settings.includeMessageTimestamp ? messageTimestamp(message, settings) : '';
    if (timestamp) {
      if (!time) time = doc.createElement('time');
      time.setAttribute('datetime', String(message.createTime || ''));
      time.textContent = timestamp;
    } else {
      if (time) time.remove();
      time = null;
    }
    heading.replaceChildren(avatar, doc.createTextNode(roleLabel(message, settings)));
    if (time) heading.append(doc.createTextNode(' '), time);
  }

  function renderedArticles(renderedHtml, messages, settings) {
    if (renderedHtml == null) return null;
    let source = '';
    if (typeof renderedHtml === 'string') source = renderedHtml;
    else if (renderedHtml && renderedHtml.nodeType === 1) {
      source = renderedHtml.outerHTML || renderedHtml.innerHTML || '';
    } else if (renderedHtml && typeof renderedHtml.innerHTML === 'string') source = renderedHtml.innerHTML;
    if (!source) return null;
    const safe = sanitizeHtml(source);
    const Parser = root.DOMParser || (root.document && root.document.defaultView && root.document.defaultView.DOMParser);
    if (!Parser) return null;
    const parsed = new Parser().parseFromString(safe, 'text/html');
    const byId = new Map(Array.from(parsed.querySelectorAll('article[data-message-id]'))
      .map((article) => [article.getAttribute('data-message-id'), article]));
    const selected = messages.map((message) => {
      const article = byId.get(message.id);
      if (article) updateArticleHeader(article, message, settings, parsed);
      return article;
    }).filter(Boolean);
    if (selected.length !== messages.length || !selected.length) return null;
    return selected.map((article) => article.outerHTML).join('\n');
  }

  function htmlFragment(conversation, messages, settings, renderedHtml) {
    const parts = [];
    if (settings.includeMetadata) {
      const title = settings.includeTitleInNonPdf && conversation.title ? `<h1>${escapeHtml(redactMetadataText(conversation.title))}</h1>` : '';
      parts.push('<header>' + title);
      const meta = metadataRows(conversation, settings).filter(([label]) => label !== '标题');
      if (meta.length) parts.push(`<dl>${meta.map(([label, value]) => {
        const renderedValue = label === '来源' && settings.includeConversationLink && value
          ? `<a href="${escapeHtml(value)}">${escapeHtml(value)}</a>`
          : escapeHtml(value);
        return `<dt>${escapeHtml(label)}</dt><dd>${renderedValue}</dd>`;
      }).join('')}</dl>`);
      const warnings = Array.isArray(conversation.warnings) ? conversation.warnings.filter(Boolean) : [];
      if (warnings.length) parts.push(`<aside><strong>提示：</strong>${warnings.map((warning) => escapeHtml(redactMetadataText(warning))).join('；')}</aside>`);
      parts.push('</header>');
    }
    const rendered = renderedArticles(renderedHtml, messages, settings);
    if (rendered != null) parts.push(rendered);
    else {
      const branchLabels = branchLabelsByMessage(conversation, messages);
      for (const message of messages) {
        const generated = typeof api.richBodyHtml === 'function'
          ? api.richBodyHtml(message)
          : (message.html || escapeHtml(messageBody(message, 'text')).replace(/\n/g, '<br>'));
        const body = sanitizeHtml(generated);
        const branches = branchLabels.get(message.id) || [];
        const notice = branches.length ? `<p class="branch-affiliations"><small>所属分支：${branches.map(escapeHtml).join('、')}</small></p>` : '';
        const timestamp = settings.includeMessageTimestamp ? messageTimestamp(message, settings) : '';
        const time = timestamp ? `<time datetime="${escapeHtml(message.createTime || timestamp)}">${escapeHtml(timestamp)}</time>` : '';
        parts.push(`<article data-message-id="${escapeHtml(message.id)}" data-role="${escapeHtml(message.role)}"><h2><span class="message-avatar" aria-hidden="true"></span>${escapeHtml(roleLabel(message, settings))}${time ? ` ${time}` : ''}</h2>${notice}<div class="message-body">${body}</div></article>`);
      }
    }
    return parts.join('\n');
  }

  function htmlDocument(conversation, fragment, includeTitle) {
    const title = escapeHtml(redactMetadataText(includeTitle ? conversation.title || '对话导出' : '对话导出'));
    const styles = [
      'body{margin:0;padding:48px 22px;color:#27312d;background:#f2f4f1;font:16px/1.75 Georgia,"Noto Serif SC",serif}',
      'main{box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;width:min(100%,820px);min-height:70vh;margin:0 auto;padding:64px 72px;background:#fffefa;box-shadow:0 12px 42px #24352b18}',
      'header{margin:0 0 36px;padding-bottom:22px;border-bottom:1px solid #e4e8e2}',
      'h1{margin:0 0 16px;font:650 30px/1.3 system-ui,sans-serif;letter-spacing:-.035em}',
      'dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin:0;color:#65716b;font:12px/1.6 system-ui,sans-serif}',
      'dd{margin:0;overflow-wrap:anywhere} aside{margin-top:14px;padding:10px 13px;border-left:3px solid #91ab9d;background:#f1f5f0;color:#566b60;font:12px/1.65 system-ui,sans-serif}',
      'article{align-self:flex-start;width:fit-content;max-width:100%;margin:0 0 17px;overflow-wrap:anywhere} article h2{display:flex;min-width:0;align-items:center;gap:7px;margin:0 0 4px;color:#668276;font:750 10px/1.3 system-ui,sans-serif;letter-spacing:.02em;text-transform:uppercase} .message-avatar{display:grid;flex:0 0 27px;width:27px;height:27px;place-items:center;border:1px solid #d8e5dc;border-radius:50%;color:#fff;background:#5c8974;font:750 11px/1 system-ui,sans-serif} .message-avatar:before{content:"•"} article[data-role="user"]{align-self:flex-end} article[data-role="user"] h2{justify-content:flex-start;flex-direction:row-reverse} article[data-role="user"] .message-avatar{border-color:#d9e2e8;background:#70899a} article[data-role="user"] .message-avatar:before{content:"U"} article[data-role="assistant"] .message-avatar:before{content:"A"} article>.message-body{width:fit-content;max-width:calc(100% - 37px);margin-left:37px;padding:11px 15px;border:1px solid #e4e9e4;border-radius:13px;background:#fbfcfa;overflow-wrap:anywhere} article[data-role="user"]>.message-body{max-width:calc(100% - 37px);margin-right:37px;margin-left:auto;border-color:#dfe8e2;background:#f1f6f2} article>.branch-affiliations{margin-left:37px} article[data-role="user"]>.branch-affiliations{margin-right:37px;margin-left:0;text-align:right} article[data-role="user"]+article[data-role="user"],article[data-role="assistant"]+article[data-role="assistant"]{margin-top:-8px} article[data-role="user"]+article[data-role="user"]>h2,article[data-role="assistant"]+article[data-role="assistant"]>h2{margin-bottom:2px;font-size:8px;opacity:.58} article[data-role="user"]+article[data-role="user"]>h2 .message-avatar,article[data-role="assistant"]+article[data-role="assistant"]>h2 .message-avatar{flex-basis:0;width:0;height:0;border:0;visibility:hidden} time{margin-left:3px;color:#929c96;font:450 9px/1.4 system-ui,sans-serif;letter-spacing:0;text-transform:none;white-space:nowrap}',
      '.branch-affiliations{margin:0 0 .6em;color:#7a8580;font:12px/1.5 system-ui,sans-serif}',
      'p{margin:0 0 1em} h3,h4,h5,h6{margin:1.4em 0 .5em;line-height:1.45} ul,ol{padding-left:1.5em} li{margin:.25em 0}',
      'blockquote{margin:1em 0;padding:1px 0 1px 16px;border-left:3px solid #b4c7bd;color:#626d68}',
      'pre{overflow:auto;padding:14px 16px;border:1px solid #e5e7e1;border-radius:6px;background:#f6f7f3;color:#39423e;font:13px/1.65 ui-monospace,monospace;white-space:pre-wrap}',
      'code{padding:.1em .32em;border-radius:4px;background:#eef1ec;color:#43564d;font: .88em ui-monospace,monospace} pre code{padding:0;background:transparent}',
      'a{color:#52786a;text-decoration:underline;text-underline-offset:2px} table{width:100%;margin:1em 0;border-collapse:collapse;font-size:.92em}',
      'th,td{padding:7px 9px;border:1px solid #dfe3dc;text-align:left;vertical-align:top} th{background:#f2f4ef}',
      'img{max-width:100%;height:auto} .ge-attachments{display:grid;gap:8px;margin:1.25em 0;padding:12px;border:1px solid #e2e7e1;border-radius:8px;background:#fafbf8} .ge-attachment-card{display:flex;flex-wrap:wrap;gap:8px;color:#66736c;font:12px/1.5 system-ui,sans-serif} .ge-attachment-download{font-weight:650}',
      'hr{height:1px;margin:2em 0;border:0;background:#e2e5df}',
      '@media(max-width:640px){body{padding:12px}main{min-height:0;padding:36px 24px}article>.message-body,article[data-role="user"]>.message-body{max-width:calc(100% - 30px);margin-left:30px}article[data-role="user"]>.message-body{margin-right:30px;margin-left:auto}}',
      '@media print{@page{margin:18mm 20mm}body{padding:0;background:#fff}main{width:100%;min-height:0;padding:0;box-shadow:none}article,.message-body{break-inside:auto;page-break-inside:auto}article h2{break-after:avoid-page;page-break-after:avoid}a{color:#333}}'
    ].join('');
    return '<!doctype html>\n' +
      '<html lang="zh-Hans">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src \'none\'; connect-src \'none\'; media-src \'none\'; style-src \'unsafe-inline\'; script-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">\n' +
      `<title>${title}</title>\n<style>${styles}</style>\n</head>\n<body>\n<main>\n${fragment}\n</main>\n</body>\n</html>`;
  }

  function normalizeForOptions(conversation, options) {
    if (!conversation || typeof conversation !== 'object') throw new TypeError('对话数据无效');
    const settings = normalizeExportOptions(options, {
      includeMetadata: true,
      includeConversationLink: true,
      includeMessageTimestamp: false,
      includeTitleInNonPdf: true,
      includeUserName: false,
      userName: '',
      includeUserEmail: false,
      userEmail: '',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: '24h',
      customizeRoleNames: false,
      roleNames: { user: 'User', assistant: 'Assistant', system: 'System', tool: 'Tool' }
    });
    return {
      settings,
      messages: normalizeMessages(conversation, settings)
    };
  }

  function renderHtmlFragment(conversation, options) {
    const normalized = normalizeForOptions(conversation, options);
    normalized.settings.includeMetadata = Boolean(normalized.settings.includeMetadata);
    normalized.settings.includeConversationLink = normalized.settings.includeConversationLink !== false;
    normalized.settings.includeMessageTimestamp = Boolean(normalized.settings.includeMessageTimestamp);
    return htmlFragment(conversation, normalized.messages, normalized.settings, null);
  }

  function normalizeExportOptions(options, defaults) {
    const settings = Object.assign({}, defaults || {}, options || {});
    const normalize = api.exportSettings && api.exportSettings.normalize;
    if (typeof normalize === 'function') {
      try { Object.assign(settings, normalize(settings)); }
      catch (_) { /* Keep safe local defaults when settings are malformed. */ }
    }
    settings.includeMetadata = settings.includeMetadata !== false;
    settings.includeConversationLink = settings.includeConversationLink !== false;
    settings.includeMessageTimestamp = settings.includeMessageTimestamp === true;
    settings.includeTitleInNonPdf = settings.includeTitleInNonPdf !== false;
    settings.includeUserName = settings.includeUserName === true;
    settings.includeUserEmail = settings.includeUserEmail === true;
    settings.customizeRoleNames = settings.customizeRoleNames === true;
    return settings;
  }

  function safeMetadataUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return '';
      return `${url.origin}${url.pathname}`;
    } catch (_) {
      return '';
    }
  }

  function csvConversationUrl(value) {
    const raw = String(value || '');
    try {
      new URL(raw);
      return safeMetadataUrl(raw);
    }
    catch (_) { return raw; }
  }

  function redactMetadataText(value) {
    return String(value == null ? '' : value)
      .replace(/([?&](?:access_token|token|api_key|key|signature|sig|auth|code)=)[^&#\s]*/gi, '$1[redacted]')
      .replace(/\b(access_token|token|api_key|key|signature|sig|auth)=([^\s&#]+)/gi, '$1=[redacted]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '[redacted]');
  }

  function safeSourceMetadata(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
    const output = {};
    if (['api', 'shared', 'temporary', 'dom'].includes(source.kind)) output.kind = source.kind;
    if (typeof source.complete === 'boolean') output.complete = source.complete;
    if (['chatgpt','claude','qwen','deepseek','kimi','gemini','doubao','grok'].includes(source.platform)) output.platform = source.platform;
    for (const key of ['conversationId', 'sourceTabId']) {
      const value = source[key];
      if ((typeof value === 'string' && value.length <= 256) || (key === 'sourceTabId' && Number.isSafeInteger(value))) output[key] = value;
    }
    return Object.keys(output).length ? output : undefined;
  }

  function safeSelection(selection) {
    if (!selection || typeof selection !== 'object' || typeof selection.branchId !== 'string') return undefined;
    return { branchId: redactMetadataText(selection.branchId).slice(0, 256) };
  }

  function safeBranches(branches) {
    if (!Array.isArray(branches)) return [];
    return branches.filter((branch) => branch && typeof branch === 'object').map((branch) => {
      const output = {};
      for (const key of ['id', 'label', 'leafId']) {
        if (typeof branch[key] === 'string') output[key] = redactMetadataText(branch[key]);
      }
      if (Array.isArray(branch.messageIds)) output.messageIds = branch.messageIds.filter((id) => typeof id === 'string').map(redactMetadataText);
      return output;
    });
  }

  function safeAssets(assets) {
    if (!Array.isArray(assets)) return [];
    return assets.filter((asset) => asset && typeof asset === 'object').map((asset) => {
      const output = {};
      for (const key of ['id', 'messageId', 'kind', 'name', 'mimeType', 'fileId']) {
        if (typeof asset[key] === 'string') output[key] = redactMetadataText(asset[key]);
      }
      if (Number.isFinite(asset.size) && asset.size >= 0) output.size = asset.size;
      if (['pending', 'ready', 'unavailable'].includes(asset.status)) output.status = asset.status;
      return output;
    });
  }

  function jsonOutput(conversation, messages, settings) {
    const version = conversation.schemaVersion === 2 ? 2 : 1;
    const output = { schemaVersion: version };
    if (settings.includeMetadata) {
      if (settings.includeTitleInNonPdf && conversation.title) output.title = redactMetadataText(conversation.title);
      output.url = settings.includeConversationLink ? safeMetadataUrl(conversation.url || '') : '';
      output.exportedAt = formatTimestamp(conversation.exportedAt || '', settings);
      if (settings.includeUserName && String(settings.userName || '').trim()) output.userName = String(settings.userName).trim();
      if (settings.includeUserEmail && String(settings.userEmail || '').trim()) output.userEmail = String(settings.userEmail).trim();
      output.warnings = Array.isArray(conversation.warnings) ? conversation.warnings.map(redactMetadataText) : [];
      if (version === 2) {
        output.branches = safeBranches(conversation.branches);
        output.activeBranchId = typeof conversation.activeBranchId === 'string' ? redactMetadataText(conversation.activeBranchId) : '';
        const source = safeSourceMetadata(conversation.source);
        const selection = safeSelection(conversation.selection);
        if (source) output.source = source;
        if (selection) output.selection = selection;
        const visibleMessageIds = new Set(messages.map((message) => message.id));
        const referencedAssetIds = new Set(messages.flatMap((message) => message.assetIds || []));
        const visibleAssets = Array.isArray(conversation.assets) ? conversation.assets.filter((asset) =>
          asset && (visibleMessageIds.has(String(asset.messageId || '')) || referencedAssetIds.has(String(asset.id || '')))) : [];
        output.assets = safeAssets(visibleAssets);
      }
    }
    output.messages = messages.map((message) => ({
      id: message.id,
      role: message.role,
      ...(settings.customizeRoleNames ? { roleLabel: roleLabel(message, settings) } : {}),
      markdown: message.markdown,
      text: message.text,
      html: sanitizeHtml(message.html),
      ...(settings.includeMessageTimestamp && message.createTime ? { createTime: messageTimestamp(message, settings) } : {}),
      ...(version === 2 || message.assetIds.length ? { assetIds: message.assetIds.slice(0, 1000) } : {})
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

  function csvOutput(conversation, messages, settings) {
    const header = [];
    if (settings.includeMetadata) {
      header.push('title', 'url', 'exportedAt', 'warnings');
      if (settings.includeUserName) header.push('userName');
      if (settings.includeUserEmail) header.push('userEmail');
    }
    header.push('id', 'role');
    if (settings.customizeRoleNames) header.push('roleLabel');
    if (settings.includeMessageTimestamp) header.push('createTime');
    header.push('markdown', 'text', 'html');
    const warnings = Array.isArray(conversation.warnings) ? conversation.warnings.filter(Boolean).join('；') : '';
    const rows = messages.map((message) => {
      const row = [];
      if (settings.includeMetadata) {
        row.push(settings.includeTitleInNonPdf ? conversation.title || '' : '', settings.includeConversationLink ? csvConversationUrl(conversation.url || '') : '',
          formatTimestamp(conversation.exportedAt || '', settings) || String(conversation.exportedAt || ''), warnings);
        if (settings.includeUserName) row.push(String(settings.userName || '').trim());
        if (settings.includeUserEmail) row.push(String(settings.userEmail || '').trim());
      }
      row.push(message.id, message.role);
      if (settings.customizeRoleNames) row.push(roleLabel(message, settings));
      if (settings.includeMessageTimestamp) row.push(messageTimestamp(message, settings) || String(message.createTime || ''));
      row.push(message.markdown, message.text, sanitizeHtml(message.html));
      return row;
    });
    return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
  }

  function serialize(conversation, options) {
    if (!conversation || typeof conversation !== 'object') throw new TypeError('对话数据无效');
    const settings = normalizeExportOptions(options, {
      format: 'markdown',
      includeMetadata: true,
      includeConversationLink: true,
      includeMessageTimestamp: false,
      includeTitleInNonPdf: true,
      includeUserName: false,
      userName: '',
      includeUserEmail: false,
      userEmail: '',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: '24h',
      customizeRoleNames: false,
      roleNames: { user: 'User', assistant: 'Assistant', system: 'System', tool: 'Tool' }
    });
    const descriptor = FORMATS[settings.format];
    if (!descriptor) throw new TypeError('不支持的导出格式');
    const messages = normalizeMessages(conversation, settings);
    let content;
    switch (settings.format) {
      case 'markdown': content = markdownOutput(conversation, messages, settings); break;
      case 'text': content = textOutput(conversation, messages, settings); break;
      case 'html': content = htmlDocument(conversation, htmlFragment(conversation, messages, settings, settings.renderedHtml), settings.includeTitleInNonPdf); break;
      case 'json': content = jsonOutput(conversation, messages, settings); break;
      case 'csv': content = csvOutput(conversation, messages, settings); break;
    }
    return { content, mime: descriptor.mime, extension: descriptor.extension };
  }

  api.serialize = serialize;
  api.sanitizeHtml = sanitizeHtml;
  api.renderHtmlFragment = renderHtmlFragment;
})(globalThis);
