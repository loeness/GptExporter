(function attachGptExporterRichContent(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const BLOCKED_ATTACHMENT_TYPES = new Set([
    'text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml',
    'application/javascript', 'text/javascript', 'application/ecmascript', 'text/ecmascript'
  ]);
  let idCounter = 0;
  const initializedMermaid = new WeakSet();
  const imageReferences = new WeakMap();
  const attachmentSections = new WeakMap();

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function vendors() {
    return root.GptExporterVendors || {};
  }

  function unwrapVendor(name) {
    const value = vendors()[name];
    return value && value.default ? value.default : value;
  }

  function getPurifier() {
    const value = unwrapVendor('DOMPurify') || root.DOMPurify;
    if (value && typeof value.sanitize === 'function') return value;
    return null;
  }

  function safeAssetId(value) {
    const id = String(value || '');
    return /^[A-Za-z0-9._:-]{1,256}$/.test(id) ? id : '';
  }

  function allowedMediaHost(host) {
    const value = String(host || '').toLowerCase();
    return value === 'chatgpt.com' || value.endsWith('.chatgpt.com') ||
      value === 'oaiusercontent.com' || value.endsWith('.oaiusercontent.com') ||
      /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(value);
  }

  function allowedMediaUrl(value) {
    try {
      const url = new URL(String(value || ''));
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password || !allowedMediaHost(host)) return null;
      if (/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(host)) {
        const query = url.searchParams;
        if (!query.get('sig') || !query.get('se') || !query.get('sv')) return null;
      }
      return url;
    } catch (_) {
      return null;
    }
  }

  function safeImageReference(value) {
    const raw = String(value || '').trim();
    const internal = raw.match(/^gpt-exporter-asset:([A-Za-z0-9._:-]{1,256})$/i);
    if (internal) return { assetId: internal[1] };
    const url = allowedMediaUrl(raw);
    if (!url) return null;
    // Signed query strings never enter the rendered document. Asset hydration is
    // matched against the same origin and path, then uses only the ready data URL.
    return { url: `${url.origin}${url.pathname}` };
  }

  function isRasterDataUrl(value) {
    const match = String(value || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i);
    if (!match || match[2].length % 4 !== 0) return null;
    return { mimeType: match[1].toLowerCase(), dataUrl: String(value) };
  }

  function isAttachmentDataUrl(value) {
    const match = String(value || '').match(/^data:([a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*);base64,([A-Za-z0-9+/]+={0,2})$/i);
    if (!match || match[2].length % 4 !== 0) return null;
    const mimeType = match[1].toLowerCase();
    if (BLOCKED_ATTACHMENT_TYPES.has(mimeType)) return null;
    return { mimeType, dataUrl: String(value) };
  }

  function markdownCtor() {
    const value = unwrapVendor('MarkdownIt') || root.MarkdownIt;
    return typeof value === 'function' ? value : null;
  }

  function isAllowedMarkdownLink(value) {
    const raw = String(value || '').trim();
    if (/^gpt-exporter-asset:/i.test(raw)) return false;
    return /^(?:https?:|mailto:)/i.test(raw) && !/[\u0000-\u0020]/.test(raw);
  }

  function makeMarkdownRenderer() {
    const MarkdownIt = markdownCtor();
    if (!MarkdownIt) return null;
    const md = new MarkdownIt({
      html: false,
      linkify: false,
      typographer: false,
      breaks: false,
      validateLink: (value) => Boolean(safeImageReference(value) || isAllowedMarkdownLink(value))
    });
    const defaultFenceRenderer = md.renderer.rules.fence;
    md.renderer.rules.image = (tokens, index) => {
      const token = tokens[index];
      const reference = safeImageReference(token.attrGet('src'));
      const alt = token.content || '';
      const position = idCounter++;
      const attributes = [`class="ge-image-placeholder"`, `data-ge-image-placeholder="true"`,
        `data-ge-image-index="${position}"`, `data-ge-alt="${escapeHtml(alt)}"`];
      if (reference && reference.assetId) attributes.push(`data-ge-asset-id="${escapeHtml(reference.assetId)}"`);
      if (reference && reference.url) attributes.push(`data-ge-image-ref="${escapeHtml(reference.url)}"`);
      return `<span ${attributes.join(' ')}>${alt ? `图片：${escapeHtml(alt)}` : '图片'}</span>`;
    };
    md.renderer.rules.fence = (tokens, index, options, env, self) => {
      const token = tokens[index];
      const language = String(token.info || '').trim().split(/\s+/, 1)[0].toLowerCase();
      if (language === 'mermaid') {
        return `<pre class="ge-mermaid-source" data-ge-mermaid="true"><code>${escapeHtml(token.content)}</code></pre>\n`;
      }
      return defaultFenceRenderer(tokens, index, options, env, self);
    };
    return md;
  }

  function mathMarkup(tex, display) {
    return `<span class="ge-math-source" data-ge-math="true" data-ge-display="${display ? 'true' : 'false'}" data-ge-tex="${escapeHtml(tex)}">${escapeHtml(tex)}</span>`;
  }

  function protectMathSegment(source, replacements, allowWidgets) {
    const value = String(source || '');
    const code = [];
    const nonce = `${Date.now().toString(36)}${(idCounter++).toString(36)}`;
    const codeOrWidget = /(`+)([\s\S]*?)\1|\uE200genui\uE202([^\uE200\uE201]*)\uE201/g;
    const withoutInlineCode = value.replace(codeOrWidget, (match, _ticks, _code, widget) => {
      if (widget !== undefined) {
        if (!allowWidgets || !api.dataChartPlaceholder) return match;
        const token = `GEWIDGETPLACEHOLDER${nonce}X${replacements.length}X`;
        replacements.push([token, api.dataChartPlaceholder(widget)]);
        return token;
      }
      const token = `GEINLINECODE${nonce}X${code.length}X`;
      code.push([token, match]);
      return token;
    });
    const mathPattern = /(\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$(?!\$)([^$\n]+?)(?<!\\)\$)/g;
    let result = withoutInlineCode.replace(mathPattern, (match, _all, dollars, bracket, paren, inline) => {
      let tex;
      let display;
      if (dollars !== undefined) { tex = dollars; display = true; }
      else if (bracket !== undefined) { tex = bracket; display = true; }
      else if (paren !== undefined) { tex = paren; display = false; }
      else { tex = inline; display = false; }
      const token = `GEMATHPLACEHOLDER${nonce}X${replacements.length}X`;
      replacements.push([token, mathMarkup(String(tex).trim(), display)]);
      return token;
    });
    for (const [token, raw] of code) result = result.split(token).join(raw);
    return result;
  }

  function protectMath(markdown, allowWidgets) {
    const lines = String(markdown || '').split(/(?<=\n)/);
    const output = [];
    const replacements = [];
    let fence = null;
    let pending = '';
    const flush = () => {
      if (pending) output.push(protectMathSegment(pending, replacements, allowWidgets));
      pending = '';
    };
    for (const line of lines) {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (!fence && fenceMatch) {
        flush();
        fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
        output.push(line);
        continue;
      }
      if (fence) {
        output.push(line);
        const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*\r?\n?$/);
        if (close && close[1][0] === fence.character && close[1].length >= fence.length) fence = null;
        continue;
      }
      pending += line;
    }
    flush();
    return { markdown: output.join(''), replacements };
  }

  function richBodyHtml(message) {
    const markdown = String(message && (message.markdown || message.text) || '');
    const md = makeMarkdownRenderer();
    if (!md) return String(message && message.html || `<p>${escapeHtml(markdown).replace(/\r?\n/g, '<br>')}</p>`);
    try {
      const protectedContent = protectMath(markdown, message?.role === 'assistant');
      let html = md.render(protectedContent.markdown);
      for (const [token, markup] of protectedContent.replacements) html = html.split(token).join(markup);
      return html;
    } catch (_) {
      return String(message && message.html || `<p>${escapeHtml(markdown).replace(/\r?\n/g, '<br>')}</p>`);
    }
  }

  function safeFilename(value) {
    const source = String(value || '附件').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
    return (source || '附件').slice(0, 180);
  }

  function safeVisibleError(value) {
    return String(value || '')
      .replace(/https?:\/\/[^\s<>"']+/gi, '资源链接')
      .replace(/\b(?:access_token|token|api_key|key|signature|sig|auth|code)=[^\s&#]+/gi, '凭据已隐藏')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }

  function textElement(document, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = String(text || '');
    return element;
  }

  function assetUrlPath(value) {
    const url = allowedMediaUrl(value);
    return url ? `${url.origin}${url.pathname}` : '';
  }

  function placeholderReference(placeholder) {
    const attribute = placeholder.getAttribute('data-ge-image-ref');
    let path = '';
    try {
      const url = new URL(attribute);
      // Markdown emits these already-validated references without signed queries.
      if (url.protocol === 'https:' && allowedMediaHost(url.hostname) &&
          attribute === `${url.origin}${url.pathname}`) path = attribute;
    } catch (_) { /* A blocked or missing reference cannot match an asset. */ }
    return {
      id: safeAssetId(placeholder.getAttribute('data-ge-asset-id')),
      path,
      alt: placeholder.getAttribute('data-ge-alt') || placeholder.textContent.replace(/^图片：?/, '').trim()
    };
  }

  function refreshImage(placeholder, reference, asset) {
    const document = placeholder.ownerDocument;
    const { alt } = reference;
    const previousImage = reference.validatedImage;
    const imageData = asset && asset.status === 'ready'
      ? (previousImage && previousImage.dataUrl === asset.dataUrl ? previousImage : isRasterDataUrl(asset.dataUrl))
      : null;
    let replacement;
    let validatedImage;
    if (imageData && (!asset.mimeType || String(asset.mimeType).toLowerCase().split(';', 1)[0] === imageData.mimeType)) {
      const imageAlt = alt || String(asset.name || '对话图片');
      validatedImage = imageData;
      if (placeholder.className === 'ge-ready-image' &&
          placeholder.getAttribute('src') === imageData.dataUrl && placeholder.alt === imageAlt) return;
      replacement = document.createElement('img');
      replacement.src = imageData.dataUrl;
      replacement.alt = imageAlt;
      replacement.className = 'ge-ready-image';
    } else {
      const error = safeVisibleError(asset && asset.error);
      const name = asset && asset.name ? safeFilename(asset.name) : alt;
      const label = asset && asset.status === 'pending' && !error
        ? `正在读取图片${name ? `：${name}` : ''}`
        : `图片不可用${name ? `：${name}` : ''}${error ? `（${error}）` : ''}`;
      if (placeholder.className === 'ge-unavailable-image' && placeholder.textContent === label) return;
      replacement = textElement(document, 'span', 'ge-unavailable-image', label);
    }
    imageReferences.set(replacement, { ...reference, validatedImage });
    placeholder.replaceWith(replacement);
  }

  function renderAttachmentCard(document, asset) {
    const card = document.createElement('div');
    card.className = 'ge-attachment-card';
    card.setAttribute('data-ge-attachment', 'true');
    const name = safeFilename(asset.name || '附件');
    const data = asset.status === 'ready' ? isAttachmentDataUrl(asset.dataUrl) : null;
    if (data && (!asset.mimeType || String(asset.mimeType).toLowerCase().split(';', 1)[0] === data.mimeType)) {
      const link = document.createElement('a');
      link.href = data.dataUrl;
      link.download = name;
      link.className = 'ge-attachment-download';
      link.textContent = name;
      card.append(link);
      const detail = [data.mimeType, Number.isFinite(Number(asset.size)) && Number(asset.size) >= 0 ? `${Number(asset.size)} bytes` : '']
        .filter(Boolean).join(' · ');
      if (detail) card.append(textElement(document, 'span', 'ge-attachment-meta', detail));
    } else {
      const error = safeVisibleError(asset.error);
      const reason = error || (asset.status === 'ready' ? '附件类型不支持安全下载' :
        asset.status === 'pending' ? '正在读取附件' : '附件不可用');
      card.append(textElement(document, 'span', 'ge-unavailable-attachment', `${name}（${reason}）`));
    }
    return card;
  }

  function refreshRichAssets(container, conversation, changedAssets) {
    if (!container || !container.ownerDocument) return;
    const assets = Array.isArray(conversation && conversation.assets) ? conversation.assets : [];
    const messages = Array.isArray(conversation && conversation.messages) ? conversation.messages : [];
    const changedIds = new Set();
    const affectedMessages = changedAssets != null ? new Set() : null;
    if (affectedMessages) {
      for (const changed of changedAssets) {
        const record = changed && typeof changed === 'object' ? changed : null;
        if (record && record.messageId != null) affectedMessages.add(String(record.messageId));
        const id = safeAssetId(record ? record.id : changed);
        if (id) changedIds.add(id);
      }
      if (changedIds.size) {
        for (const asset of assets) {
          if (asset && changedIds.has(String(asset.id || ''))) {
            affectedMessages.add(String(asset.messageId == null ? '' : asset.messageId));
          }
        }
      }
    }

    const referencedIds = new Map();
    for (const message of messages) {
      if (!message || !Array.isArray(message.assetIds) || !message.assetIds.length) continue;
      const id = String(message.id == null ? '' : message.id);
      if (affectedMessages && !affectedMessages.has(id)) {
        if (!message.assetIds.some((assetId) => changedIds.has(String(assetId)))) continue;
        affectedMessages.add(id);
      }
      referencedIds.set(id, new Set(message.assetIds.map(String)));
    }
    if (affectedMessages && !affectedMessages.size) return;

    const byMessage = new Map();
    const sharedImages = new Map();
    for (const asset of assets) {
      if (!asset) continue;
      const id = safeAssetId(asset.id);
      if (id && asset.kind === 'image' && !sharedImages.has(id)) sharedImages.set(id, asset);
      const messageId = String(asset.messageId == null ? '' : asset.messageId);
      if (affectedMessages && !affectedMessages.has(messageId)) continue;
      if (!byMessage.has(messageId)) {
        byMessage.set(messageId, { byId: new Map(), byPath: new Map(), attachments: [] });
      }
      const group = byMessage.get(messageId);
      if (asset.kind === 'image') {
        const path = assetUrlPath(asset.url);
        if (id && !group.byId.has(id)) group.byId.set(id, asset);
        if (path && !group.byPath.has(path)) group.byPath.set(path, asset);
      } else if (asset.kind === 'attachment') {
        group.attachments.push(asset);
      }
    }

    const document = container.ownerDocument;
    for (const article of container.querySelectorAll('article[data-message-id]')) {
      const messageId = article.getAttribute('data-message-id');
      if (affectedMessages && !affectedMessages.has(messageId)) continue;
      const group = byMessage.get(messageId);
      const explicitIds = referencedIds.get(messageId);
      for (const node of article.querySelectorAll('[data-ge-image-placeholder="true"], .ge-ready-image, .ge-unavailable-image')) {
        const reference = imageReferences.get(node) ||
          (node.getAttribute('data-ge-image-placeholder') === 'true' ? placeholderReference(node) : null);
        if (!reference) continue;
        const asset = group?.byId.get(reference.id) ||
          (explicitIds?.has(reference.id) ? sharedImages.get(reference.id) : null) ||
          group?.byPath.get(reference.path);
        refreshImage(node, reference, asset);
      }
      const currentSection = attachmentSections.get(article);
      if (!group || !group.attachments.length) {
        if (currentSection) currentSection.remove();
        attachmentSections.delete(article);
        continue;
      }
      const section = document.createElement('section');
      section.className = 'ge-attachments';
      section.setAttribute('aria-label', '附件');
      for (const asset of group.attachments) section.append(renderAttachmentCard(document, asset));
      if (currentSection && currentSection.parentNode === article) {
        if (currentSection.isEqualNode(section)) continue;
        currentSection.replaceWith(section);
      } else {
        article.append(section);
      }
      attachmentSections.set(article, section);
    }
  }

  function rejectMermaidSource(source) {
    const value = String(source || '');
    return /^\s*---\s*(?:\r?\n|$)/.test(value) || /%%\s*\{[\s\S]*?\}%%/.test(value) ||
      /\bhttps?:\/\/|\bdata:|\burl\s*\(|\bimg\s*:|\bimage\s*:|\bicon\s*:/i.test(value) ||
      /^\s*click\s+\S/im.test(value) || /\bclick\s+\S+\s+(?:"[^"]*"|'[^']*'|\S+)/i.test(value);
  }

  function initializeMermaid(mermaid) {
    if (!mermaid || typeof mermaid.initialize !== 'function') return false;
    if (initializedMermaid.has(mermaid)) return true;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      secure: ['securityLevel', 'startOnLoad', 'htmlLabels', 'flowchart.htmlLabels'],
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
      logLevel: 'fatal'
    });
    initializedMermaid.add(mermaid);
    return true;
  }

  function cleanSvgSource(value) {
    return String(value || '')
      .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, '$1')
      .replace(/\s(?:href|xlink:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (match, double, single, bare) => {
        const reference = String(double || single || bare || '').trim();
        return /^#[A-Za-z0-9_.:-]+$/.test(reference) ? match : '';
      })
      .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (_match, double, single, bare) => {
        const reference = String(double || single || bare || '').trim();
        return /^#[A-Za-z0-9_.:-]+$/.test(reference) ? `url(${reference})` : 'none';
      })
      .replace(/@import\s+[^;]+;?/gi, '')
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  }

  function sanitizeSvg(svg, document) {
    const purifier = getPurifier();
    const Parser = root.DOMParser || (document && document.defaultView && document.defaultView.DOMParser);
    if (!purifier || !Parser) return null;
    let safe;
    try {
      safe = purifier.sanitize(cleanSvgSource(svg), {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'a'],
        FORBID_ATTR: ['onload', 'onclick', 'onerror']
      });
    } catch (_) { return null; }
    const parsed = new Parser().parseFromString(String(safe), 'image/svg+xml');
    const svgRoot = parsed.documentElement && parsed.documentElement.localName.toLowerCase() === 'svg'
      ? parsed.documentElement : parsed.querySelector && parsed.querySelector('svg');
    if (!svgRoot || parsed.querySelector('parsererror')) return null;
    const copy = document.importNode(svgRoot, true);
    for (const element of Array.from(copy.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
        if (/^(?:href|xlink:href|src)$/i.test(attribute.name) && !/^#[A-Za-z0-9_.:-]+$/.test(attribute.value)) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    return copy;
  }

  function sanitizeKatexSvg(svg, document) {
    const purifier = getPurifier();
    const Parser = root.DOMParser || (document && document.defaultView && document.defaultView.DOMParser);
    if (!purifier || !Parser) return null;
    let safe;
    try {
      safe = purifier.sanitize(String(svg || ''), {
        ALLOWED_TAGS: ['svg', 'path'],
        ALLOWED_ATTR: ['class', 'xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'd'],
        FORBID_ATTR: ['href', 'xlink:href', 'src', 'style', 'onload', 'onclick', 'onerror'],
        ALLOW_DATA_ATTR: false,
        RETURN_TRUSTED_TYPE: false
      });
    } catch (_) { return null; }
    const parsed = new Parser().parseFromString(String(safe), 'image/svg+xml');
    const svgRoot = parsed.documentElement && parsed.documentElement.localName.toLowerCase() === 'svg'
      ? parsed.documentElement : null;
    if (!svgRoot || parsed.querySelector('parsererror')) return null;
    if (Array.from(svgRoot.querySelectorAll('*')).some((element) => !['path'].includes(element.localName.toLowerCase()))) return null;
    return document.importNode(svgRoot, true);
  }

  async function renderMermaid(target, mermaid, document) {
    const source = target.textContent || '';
    if (rejectMermaidSource(source) || !mermaid || typeof mermaid.render !== 'function' || !initializeMermaid(mermaid)) return false;
    try {
      const result = await mermaid.render(`gpt-exporter-diagram-${idCounter++}`, source);
      const rawSvg = typeof result === 'string' ? result : result && result.svg;
      const svg = sanitizeSvg(rawSvg, document);
      if (!svg) return false;
      svg.setAttribute('class', 'ge-mermaid-diagram');
      svg.setAttribute('data-ge-mermaid-source', source);
      target.replaceWith(svg);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function enhanceRichContent(container, conversation) {
    if (!container || !container.ownerDocument) return;
    const document = container.ownerDocument;
    refreshRichAssets(container, conversation);
    api.restoreStaticDemos?.(container);
    api.restoreFlowDemos?.(container);
    api.restoreDataCharts?.(container);
    const katex = unwrapVendor('katex') || root.katex;
    const purifier = getPurifier();
    for (const placeholder of Array.from(container.querySelectorAll('[data-ge-math="true"]'))) {
      const tex = placeholder.getAttribute('data-ge-tex') || placeholder.textContent || '';
      if (!katex || typeof katex.render !== 'function' || !purifier || tex.length > 20000) continue;
      try {
        const scratch = document.createElement('span');
        katex.render(tex, scratch, {
          trust: false,
          throwOnError: false,
          strict: 'warn',
          output: 'html',
          maxExpand: 1000,
          maxSize: 20,
          displayMode: placeholder.getAttribute('data-ge-display') === 'true'
        });
        const safeHtml = purifier.sanitize(scratch.innerHTML, {
          ALLOWED_TAGS: ['span', 'svg', 'path'],
          ALLOWED_ATTR: ['class', 'style', 'aria-hidden', 'role', 'xmlns', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'd'],
          FORBID_ATTR: ['href', 'xlink:href', 'src', 'onload', 'onclick', 'onerror'],
          ALLOW_DATA_ATTR: false,
          RETURN_TRUSTED_TYPE: false
        });
        placeholder.innerHTML = String(safeHtml);
        placeholder.classList.add('ge-rendered-math');
        placeholder.setAttribute('data-ge-rendered', 'true');
      } catch (_) {
        placeholder.textContent = tex;
      }
    }

    const mermaid = unwrapVendor('mermaid') || root.mermaid;
    for (const source of Array.from(container.querySelectorAll('pre[data-ge-mermaid="true"]'))) {
      const rendered = await renderMermaid(source, mermaid, document);
      if (!rendered && !source.nextElementSibling?.matches('[data-ge-mermaid-error]')) {
        source.after(textElement(document, 'p', 'ge-mermaid-error', '图表无法安全渲染；保留 Mermaid 源码。'));
        source.nextElementSibling.setAttribute('data-ge-mermaid-error', 'true');
      }
    }
  }

  function imageAltFor(node) {
    const tex = node.getAttribute('data-ge-tex');
    if (tex != null) return `TeX: ${tex}`;
    if (node.matches && node.matches('svg.ge-mermaid-diagram')) {
      return `Mermaid diagram: ${node.getAttribute('data-ge-mermaid-source') || ''}`;
    }
    const source = node.querySelector && node.querySelector('code');
    if (source && node.matches('[data-ge-mermaid]')) return `Mermaid diagram: ${source.textContent || ''}`;
    return node.getAttribute('aria-label') || node.textContent || 'Rendered content';
  }

  function measureMath(node, document) {
    const display = node.getAttribute('data-ge-display') === 'true';
    const tex = node.getAttribute('data-ge-tex') || node.textContent || '';
    const bounds = node.getBoundingClientRect();
    const view = document.defaultView;
    const fontSize = parseFloat(view?.getComputedStyle(node.querySelector('.katex') || node).fontSize) || 19;
    return { node, tex, display, fontSize, width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) };
  }

  function validCanvasSize(width, height) {
    return width > 0 && height > 0 && width <= 5000 && height <= 10000 && width * height <= 20000000;
  }

  async function vectorMathCanvas(math, document, renderMathSvg) {
    const { tex, display, fontSize } = math;
    const svg = sanitizeSvg(renderMathSvg(tex, display), document);
    if (!svg) return null;
    const box = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return null;

    const width = Math.ceil(box[2] * fontSize / 1000);
    const height = Math.ceil(box[3] * fontSize / 1000);
    const targetWidth = math.width || width;
    const targetHeight = math.height || height;
    if (!validCanvasSize(targetWidth, targetHeight)) return null;
    const scale = Math.min(1, targetWidth / width, targetHeight / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    svg.setAttribute('width', String(Math.ceil(drawWidth)));
    svg.setAttribute('height', String(Math.ceil(drawHeight)));

    const dataUrl = await drawSvgSnapshot(svg, document, targetWidth, targetHeight, {
      x: display ? targetWidth - drawWidth : 0,
      y: targetHeight - drawHeight,
      width: drawWidth * 2,
      height: drawHeight * 2
    });
    return dataUrl ? { dataUrl, width: targetWidth, height: targetHeight } : null;
  }

  async function mathCanvas(math, document) {
    const { node, width, height } = math;
    const vectorRenderer = vendors().renderMathSvg;
    if (typeof vectorRenderer === 'function') {
      try {
        const snapshot = await vectorMathCanvas(math, document, vectorRenderer);
        if (snapshot) return snapshot;
      } catch (_) { /* Try the HTML renderer for formulas without embedded SVG. */ }
    }

    const canvasRenderer = unwrapVendor('html2canvas') || root.html2canvas;
    // The HTML renderer can silently omit embedded SVG glyphs such as radicals.
    if (typeof canvasRenderer !== 'function' || node.querySelector('svg') ||
        ((width || height) && !validCanvasSize(width, height))) return null;
    try {
      // html2canvas otherwise clones the whole document for every formula.
      const canvas = await canvasRenderer(node, {
        backgroundColor: null, scale: 2, logging: false, useCORS: false,
        allowTaint: false, imageTimeout: 0, removeContainer: true,
        ignoreElements: (element) => {
          if (element === document.head || element.contains(node) || node.contains(element)) return false;
          return !document.head?.contains(element) || !element.matches('style, link[rel="stylesheet"]');
        }
      });
      if (!canvas || typeof canvas.toDataURL !== 'function') return null;
      const dataUrl = canvas.toDataURL('image/png');
      return isRasterDataUrl(dataUrl)
        ? { dataUrl, width: Math.round(canvas.width / 2), height: Math.round(canvas.height / 2) } : null;
    } catch (_) { return null; }
  }

  function loadSnapshotImage(source, ImageCtor) {
    return new Promise((resolve,reject) => {
      const image = new ImageCtor();
      const timer = root.setTimeout(() => finish(new Error('图片快照加载超时。')),10000);
      function finish(error) {
        root.clearTimeout(timer); image.onload = null; image.onerror = null;
        if (error) reject(error); else resolve(image);
      }
      image.onload = () => finish();
      image.onerror = () => finish(new Error('图片快照加载失败。'));
      // onload does not depend on a rendering frame. Image.decode() can stay
      // pending in an offscreen document; drawImage performs the final decode.
      image.src = source;
    });
  }

  function measureSvg(svg) {
    const viewBox = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const rect = svg.getBoundingClientRect();
    const width = Math.ceil(rect.width || parseFloat(svg.getAttribute('width')) || (viewBox.length === 4 ? viewBox[2] : 0));
    const height = Math.ceil(rect.height || parseFloat(svg.getAttribute('height')) || (viewBox.length === 4 ? viewBox[3] : 0));
    return { width, height };
  }

  async function drawSvgSnapshot(svg, document, width, height, draw = { x: 0, y: 0, width: width * 2, height: height * 2 }) {
    const view = document.defaultView || root;
    const Serializer = view.XMLSerializer || root.XMLSerializer;
    const ImageCtor = view.Image || root.Image;
    const URLApi = view.URL || root.URL;
    if (!Serializer || !ImageCtor || !URLApi || typeof URLApi.createObjectURL !== 'function') return null;
    const source = cleanSvgSource(new Serializer().serializeToString(svg));
    if (/<(?:foreignObject|script)\b|\son[a-z]+\s*=/i.test(source)) return null;
    const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
    const objectUrl = URLApi.createObjectURL(blob);
    try {
      const image = await loadSnapshotImage(objectUrl, ImageCtor);
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(image, draw.x, draw.y, draw.width, draw.height);
      const data = canvas.toDataURL('image/png');
      return isRasterDataUrl(data) ? data : null;
    } catch (_) {
      return null;
    } finally {
      URLApi.revokeObjectURL(objectUrl);
    }
  }

  async function svgCanvas(svg, document, { width, height }) {
    if (!validCanvasSize(width, height)) return null;
    const copy = svg.cloneNode(true);
    copy.setAttribute('width', String(width));
    copy.setAttribute('height', String(height));
    return drawSvgSnapshot(copy, document, width, height);
  }

  function replaceWithSnapshotImage(node, dataUrl, alt, size) {
    const image = node.ownerDocument.createElement('img');
    image.src = dataUrl;
    image.alt = alt;
    image.className = 'ge-snapshot-image' + (node.getAttribute && node.getAttribute('data-ge-display') === 'false' ? ' ge-inline-math' : '');
    const width = Math.round(size.width || Number(node.getAttribute('width')) || 0);
    const height = Math.round(size.height || Number(node.getAttribute('height')) || 0);
    if (width > 0 && width <= 30000) image.setAttribute('width', String(width));
    if (height > 0 && height <= 30000) image.setAttribute('height', String(height));
    node.replaceWith(image);
  }

  const PDF_OMITTED_CONTENT = [
    'header:not(.message-body header)', 'article > h2 > time', '.branch-affiliations',
    '.ge-attachments', '.ge-attachment-card', '.ge-unavailable-image', '[data-ge-image-placeholder]',
    '[data-citation]', '[data-citation-id]', '[data-annotation-type="citation" i]', '.citation-chip', '.source-section',
    '[data-testid*="citation" i]', '[data-testid*="sources" i]',
    '[data-testid*="reasoning" i]', '[data-testid*="analysis" i]',
    '[data-testid*="thinking" i]', '[data-testid*="thought" i]',
    '[data-testid*="tool-call" i]', '[data-testid*="tool_call" i]', '[data-testid*="tool-result" i]',
    '[data-message-channel="analysis" i]', '[data-channel="analysis" i]',
    '[data-message-type="analysis" i]', '[data-message-type="tool" i]',
    'article[data-role]:not([data-role="user"]):not([data-role="assistant"])'
  ].join(',');
  const PDF_DIAGRAM = [
    '[data-ge-mermaid]', '[data-ge-mermaid-source]', '.ge-mermaid-source-fallback', '.ge-mermaid-error',
    '.ge-mermaid-diagram', '.mermaid', 'img[alt^="Mermaid diagram: "]',
    'img[src^="data:image/svg+xml" i]'
  ].join(',');
  const SVG_OPEN = /^\s*(?:(?:<\?(?:[^?]|\?(?!>))*\?>|<!--(?:[^-]|-(?!->))*-->)\s*)*(?:<!DOCTYPE\s+svg\b|<svg(?=[\s/>]))/i;
  const SVG_CLOSE = /<\/svg\s*>|<svg\b(?:[^>"']|"[^"]*"|'[^']*')*\/\s*>/i;
  const PDF_ASSET_MARKER = /^\[(?:Attachment|Image): [^\r\n]*\]$/;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_DIAGRAM_TAGS = new Set('svg g defs marker rect circle ellipse path line polyline polygon text tspan title desc'.split(' '));
  const SVG_NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?/gi;
  const SVG_LENGTH = /^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?(?:px|em|rem|pt|%)?$/i;
  const SVG_LENGTH_ATTRS = new Set(('x y x1 y1 x2 y2 cx cy r rx ry width height dx dy refX refY markerWidth markerHeight ' +
    'stroke-width stroke-dashoffset stroke-miterlimit font-size letter-spacing textLength opacity fill-opacity stroke-opacity').split(' '));
  const SVG_PAINT_ATTRS = new Set(['color', 'fill', 'stroke']);
  const SVG_ENUM_ATTRS = new Set(('preserveAspectRatio fill-rule clip-rule stroke-linecap stroke-linejoin font-weight font-style text-anchor ' +
    'dominant-baseline alignment-baseline baseline-shift lengthAdjust markerUnits role aria-hidden vector-effect').split(' '));
  const PDF_TIMELINE_TITLE = /^(?:timeline|gantt)\b|\b(?:project|implementation|evaluation|research|experiment|alternate|proposed)\s+timeline\b|\bgantt\s+chart\b|时间线|时间轴|甘特图/i;
  const MAX_DIAGRAM_SOURCE = 200000;

  function boundedSvgNumbers(value, syntax) {
    const numbers = Array.from(value.matchAll(SVG_NUMBER), ([number]) => Number(number));
    return syntax.test(value.replace(SVG_NUMBER, '0')) && numbers.every((number) => Number.isFinite(number) && Math.abs(number) <= 1e6);
  }

  function validDiagramAttribute(element, { name, value }) {
    if (name === 'xmlns') return element.localName === 'svg' && value === SVG_NS;
    if (name === 'id') return /^[A-Za-z_][\w.:-]{0,100}$/.test(value);
    if (SVG_LENGTH_ATTRS.has(name)) return SVG_LENGTH.test(value) && Math.abs(parseFloat(value)) <= 1e6;
    if (SVG_PAINT_ATTRS.has(name)) return /^(?:#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i.test(value);
    if (SVG_ENUM_ATTRS.has(name)) return /^[\w\s.%+-]{1,80}$/.test(value);
    if (name === 'font-family') return /^[\w\s,'"-]{1,120}$/.test(value);
    if (name === 'aria-label') return value.length <= 300;
    if (name === 'd') return value.length <= 20000 && boundedSvgNumbers(value, /^[0\s,.MmZzLlHhVvCcSsQqTtAa]+$/);
    if (['viewBox', 'points', 'stroke-dasharray'].includes(name)) {
      return (name === 'stroke-dasharray' && value === 'none') || (value.length <= 12000 && boundedSvgNumbers(value, /^[0\s,]+$/));
    }
    if (name === 'transform') return value.length <= 400 && boundedSvgNumbers(value, /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\([0\s,]+\)[\s,]*)+$/);
    if (name === 'orient') return value === 'auto' || value === 'auto-start-reverse' || boundedSvgNumbers(value, /^0(?:deg|rad|grad|turn)?$/);
    if (['marker-start', 'marker-mid', 'marker-end'].includes(name)) {
      return !element.closest('marker') && (value === 'none' || /^url\(#[A-Za-z_][\w.:-]{0,100}\)$/.test(value));
    }
    return false;
  }

  function diagramSize(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
        width / height > 30 || height / width > 30) return null;
    const scale = Math.min(1, 1600 / width, 2400 / height);
    return { width: Math.ceil(width * scale), height: Math.ceil(height * scale) };
  }

  function parseDiagramSvg(source, document) {
    if (source.length > MAX_DIAGRAM_SOURCE || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) return null;
    const Parser = document.defaultView?.DOMParser || root.DOMParser;
    if (!Parser) return null;
    const parsed = new Parser().parseFromString(source.trim(), 'image/svg+xml');
    const svg = parsed.documentElement;
    if (svg?.localName !== 'svg' || Array.from(parsed.childNodes).some((node) => node.nodeType === 7)) return null;
    const ids = new Map();
    const references = [];
    const pending = [[svg, 0]];
    let count = 0;
    while (pending.length) {
      const [element, depth] = pending.pop();
      if (++count > 1500 || depth > 64) return null;
      if (!SVG_DIAGRAM_TAGS.has(element.localName) || element.prefix || element.namespaceURI !== svg.namespaceURI ||
          (svg.namespaceURI !== null && svg.namespaceURI !== SVG_NS) ||
          (element !== svg && element.localName === 'svg') ||
          Array.from(element.childNodes).some((node) => ![1, 3, 8].includes(node.nodeType))) return null;
      for (const attribute of element.attributes) {
        if (!validDiagramAttribute(element, attribute)) return null;
        if (attribute.name === 'id') {
          if (ids.has(attribute.value)) return null;
          ids.set(attribute.value, element.localName);
        }
        if (attribute.name.startsWith('marker-') && attribute.value.startsWith('url(#')) references.push(attribute.value.slice(5, -1));
      }
      for (const child of element.children) pending.push([child, depth + 1]);
    }
    if (references.some((id) => ids.get(id) !== 'marker')) return null;
    const box = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    if (box && (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0)) return null;
    const width = svg.getAttribute('width')?.match(/^\d+(?:\.\d+)?(?:px)?$/) ? parseFloat(svg.getAttribute('width')) : box?.[2];
    const height = svg.getAttribute('height')?.match(/^\d+(?:\.\d+)?(?:px)?$/) ? parseFloat(svg.getAttribute('height')) : box?.[3];
    const size = diagramSize(width, height);
    if (!size) return null;
    if (!box) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('xmlns', SVG_NS);
    return { svg, size, title: svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent.trim() };
  }

  function svgMarkup(text) {
    if (/^\s*</.test(text)) return text;
    return text.replace(/&(?:lt|#0*60|#x0*3c);/gi, '<')
      .replace(/&(?:gt|#0*62|#x0*3e);/gi, '>');
  }

  function diagramBlock(element, container) {
    // Lift an artifact out of an otherwise empty wrapper so its caption can be found.
    let block = element;
    while (block.parentElement !== container && block.parentElement?.matches('p, pre, figure, div:not(.message-body)') &&
           Array.from(block.parentElement.childNodes).every((child) => child === block ||
             (child.nodeType === 3 && !child.textContent.trim()) || child.localName === 'br')) {
      block = block.parentElement;
    }
    return block;
  }

  function diagramHeading(block) {
    const heading = block.previousElementSibling;
    const title = heading?.textContent.trim() || '';
    const boldParagraph = heading?.matches('p') && heading.firstElementChild?.matches('strong, b') &&
      heading.firstElementChild.textContent.trim() === title;
    if (!heading?.matches('article > h2') && (heading?.matches('h1, h2, h3, h4, h5, h6') || boldParagraph ||
        (heading?.matches('p') && /^(?:timeline|gantt|diagram|flowchart|时间线|时间轴|流程图|示意图|图表)\s*[:：]?$/i.test(title)))) return heading;
    return null;
  }

  function removeDiagramBlock(block, heading) {
    const title = heading?.textContent.trim() || '';
    if (heading && (heading.localName !== 'p' || !/[.!?。！？]$/.test(title)) &&
        /(?:\b(?:timeline|gantt|diagram|mermaid|svg|flowchart)\b|时间线|时间轴|流程图|示意图|图表|甘特图)/i.test(title)) {
      heading.remove();
    }
    block.remove();
  }

  function replacePdfDiagram(element, clone, jobs, source, type, continuation = []) {
    const block = diagramBlock(element, clone);
    const heading = diagramHeading(block);
    const title = heading?.textContent.trim() || '';
    const mermaidType = type === 'mermaid' && /^\s*(?:%%[^\r\n]*\r?\n\s*)*([a-z]+)/i.exec(source)?.[1]?.toLowerCase();
    if (jobs && type && !PDF_TIMELINE_TITLE.test(title) && mermaidType !== 'timeline' && mermaidType !== 'gantt') {
      const label = type === 'mermaid' ? 'Mermaid diagram' : 'SVG diagram';
      const node = textElement(clone.ownerDocument, 'p', 'ge-diagram-unavailable', `图表不可用（${label}）`);
      block.replaceWith(node);
      jobs.push({ node, source, type, title: title.slice(0, 150), supported: type === 'svg' || ['flowchart', 'graph'].includes(mermaidType) });
    } else {
      removeDiagramBlock(block, heading);
    }
    for (const paragraph of continuation) paragraph.remove();
  }

  function filterPdfContent(clone, jobs) {
    for (const element of clone.querySelectorAll(PDF_OMITTED_CONTENT)) element.remove();
    for (const paragraph of clone.querySelectorAll('.message-body > p')) {
      // History import appends these markers as plain paragraphs. An image or
      // other authored inline content may share the same visible wording.
      if (!paragraph.childElementCount && PDF_ASSET_MARKER.test(paragraph.textContent.trim())) paragraph.remove();
    }
    for (const list of clone.querySelectorAll('article[data-role="assistant"] .message-body > :is(ul, ol)')) {
      const heading = list.previousElementSibling;
      if (heading?.matches('h1, h2, h3, h4, h5, h6, p') &&
          /^(?:sources|citations|references|来源|参考资料|参考文献|引用)\s*[:：]?$/i.test(heading.textContent.trim()) &&
          list.children.length && Array.from(list.children).every((item) => item.querySelector('a[href]'))) {
        heading.remove();
        list.remove();
      }
    }
    for (const element of clone.querySelectorAll(`${PDF_DIAGRAM}, svg, pre, p`)) {
      if (!clone.contains(element) || element.closest('[data-ge-math], .katex, .katex-display')) continue;
      if (element.matches('[data-ge-mermaid-error], .ge-mermaid-error')) {
        element.remove();
        continue;
      }
      if (element.matches(`${PDF_DIAGRAM}, svg, pre:has(> code.language-svg), pre:has(> code.language-mermaid)`)) {
        const mermaid = element.getAttribute('data-ge-mermaid-source') ||
          (element.matches('[data-ge-mermaid], .ge-mermaid-source-fallback, .mermaid, pre:has(> code.language-mermaid)') ? element.textContent : '');
        const svg = element.matches('svg') ? element.outerHTML :
          element.querySelector(':scope > code.language-svg')?.textContent;
        replacePdfDiagram(element, clone, jobs, mermaid || svg || '', mermaid ? 'mermaid' : svg ? 'svg' : null);
        continue;
      }
      const source = svgMarkup(element.textContent);
      if (!SVG_OPEN.test(source) || element.querySelector('img, table, [data-ge-math]')) continue;
      if (element.matches('pre') || SVG_CLOSE.test(source)) {
        const closing = SVG_CLOSE.exec(source);
        if (element.matches('pre') || !source.slice(closing.index + closing[0].length).trim()) {
          replacePdfDiagram(element, clone, jobs, source, 'svg');
        }
        continue;
      }
      // Markdown can produce separate paragraphs inside a standalone SVG block.
      const continuation = [];
      for (let next = element.nextElementSibling; next?.matches('p, pre') && /^\s*</.test(svgMarkup(next.textContent)); next = next.nextElementSibling) {
        const part = svgMarkup(next.textContent);
        continuation.push(next);
        if (/<\/svg\s*>\s*$/i.test(part)) {
          const complete = [source, ...continuation.map((paragraph) => svgMarkup(paragraph.textContent))].join('\n');
          replacePdfDiagram(element, clone, jobs, complete, 'svg', continuation);
          break;
        }
      }
    }
    const walker = clone.ownerDocument.createTreeWalker(clone, 4); // SHOW_TEXT
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest('[data-ge-math], .katex, .katex-display')) {
        node.nodeValue = node.nodeValue.replace(/\uE200cite\b[\s\S]*?\uE201/gi, '');
      }
    }
  }

  function safeSnapshotClone(container, purpose, pdfDiagrams) {
    const clone = container.cloneNode(true);
    if (purpose === 'pdf') filterPdfContent(clone, pdfDiagrams);
    if (clone.nodeType === 1) clone.removeAttribute('style');
    for (const svg of Array.from(clone.querySelectorAll('svg'))) {
      const source = svg.getAttribute('data-ge-mermaid-source') || '';
      const insideMath = Boolean(svg.closest('[data-ge-math="true"][data-ge-rendered="true"]'));
      const isMermaid = svg.classList.contains('ge-mermaid-diagram');
      const safe = isMermaid
        ? sanitizeSvg(svg.outerHTML, svg.ownerDocument)
        : (insideMath ? sanitizeKatexSvg(svg.outerHTML, svg.ownerDocument) : null);
      if (safe) {
        if (isMermaid) {
          safe.setAttribute('class', 'ge-mermaid-diagram');
          safe.setAttribute('data-ge-mermaid-source', source);
        }
        svg.replaceWith(safe);
      } else {
        svg.replaceWith(svg.ownerDocument.createTextNode(source || svg.textContent || ''));
      }
    }
    for (const element of Array.from(clone.querySelectorAll('*'))) {
      const tag = element.localName.toLowerCase();
      const insideMermaid = Boolean(element.closest && element.closest('svg.ge-mermaid-diagram'));
      if (['script', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'form', 'input', 'button', 'link'].includes(tag) ||
          (tag === 'style' && !insideMermaid)) {
        element.remove();
        continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        if (/^on/i.test(attribute.name) || ['srcset', 'poster', 'background', 'srcdoc', 'formaction'].includes(attribute.name.toLowerCase())) {
          element.removeAttribute(attribute.name);
        }
      }
      if (element.hasAttribute('style') && !insideMermaid && !element.closest('[data-ge-math="true"][data-ge-rendered="true"]')) {
        element.removeAttribute('style');
      }
      if (tag === 'img') {
        const image = isRasterDataUrl(element.getAttribute('src'));
        if (!image) {
          element.replaceWith(element.ownerDocument.createTextNode(element.getAttribute('alt') || ''));
        } else {
          element.removeAttribute('style');
          element.removeAttribute('srcset');
        }
      } else if (tag === 'a') {
        const download = safeFilename(element.getAttribute('download') || '');
        const attachment = isAttachmentDataUrl(element.getAttribute('href'));
        if (element.hasAttribute('download')) {
          if (!attachment) {
            element.removeAttribute('href');
            element.removeAttribute('download');
          } else {
            element.setAttribute('href', attachment.dataUrl);
            element.setAttribute('download', download);
          }
        } else if (!/^(?:https?:|mailto:)/i.test(element.getAttribute('href') || '')) {
          element.removeAttribute('href');
        }
      } else if (tag === 'svg' && !element.classList.contains('ge-mermaid-diagram') &&
          !element.closest('[data-ge-math="true"][data-ge-rendered="true"]')) {
        element.replaceWith(element.ownerDocument.createTextNode(element.textContent || ''));
      }
    }
    return clone;
  }

  async function rasterizePdfDiagram(job, document) {
    if (!job.supported) return;
    let diagram;
    if (job.type === 'svg') {
      diagram = parseDiagramSvg(job.source, document);
    } else {
      if (job.source.length > 30000) return;
      const scratch = document.createElement('div');
      const source = textElement(document, 'pre', '', job.source);
      scratch.append(source);
      if (!await renderMermaid(source, unwrapVendor('mermaid') || root.mermaid, document)) return;
      const svg = scratch.firstElementChild;
      svg.removeAttribute('data-ge-mermaid-source');
      const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      const size = viewBox?.length === 4 ? diagramSize(viewBox[2], viewBox[3]) : null;
      if (size) diagram = { svg, size };
    }
    if (!diagram) return;
    if (PDF_TIMELINE_TITLE.test(diagram.title || '')) {
      job.node.remove();
      return;
    }
    const data = await svgCanvas(diagram.svg, document, diagram.size);
    if (data) replaceWithSnapshotImage(job.node, data, job.title || diagram.title?.slice(0, 150) ||
      (job.type === 'svg' ? 'SVG diagram' : 'Mermaid diagram'), diagram.size);
  }

  async function snapshotRichContent(container, { onProgress, purpose, includeDiagrams = false } = {}) {
    if (!container || typeof container.cloneNode !== 'function') throw new TypeError('富内容容器无效');
    const pdfDiagrams = purpose === 'pdf' && includeDiagrams === true ? [] : null;
    const clone = safeSnapshotClone(container, purpose, pdfDiagrams);
    const document = clone.ownerDocument || root.document;
    const host = document && document.body;
    const formulas = clone.querySelectorAll('[data-ge-math="true"][data-ge-rendered="true"]');
    const diagrams = clone.querySelectorAll('svg.ge-mermaid-diagram');
    const canAttach = Boolean(host && !clone.isConnected && (formulas.length || diagrams.length));
    if (canAttach) {
      clone.setAttribute('data-ge-snapshot-measuring', 'true');
      clone.style.position = 'fixed';
      clone.style.left = '-100000px';
      clone.style.top = '0';
      clone.style.width = `${Math.max(320, container.getBoundingClientRect ? container.getBoundingClientRect().width : 800)}px`;
      clone.style.zIndex = '-1';
      host.append(clone);
    }
    try {
      // Read every layout before replacing any node. Measuring after each
      // replacement would repeatedly reflow the entire conversation.
      const total = formulas.length + diagrams.length + (pdfDiagrams?.length || 0);
      if (total) onProgress?.({ completed: 0, total });
      const measuredFormulas = Array.from(formulas, (node) => measureMath(node, document));
      const measuredDiagrams = Array.from(diagrams, (node) => ({ node, size: measureSvg(node) }));
      const cache = new Map();
      let completed = 0;
      let lastYield = Date.now();
      async function reportProgress() {
        completed++;
        if (completed === total || Date.now() - lastYield >= 50) {
          onProgress?.({ completed, total });
          if (completed < total) await new Promise((resolve) => root.setTimeout(resolve, 0));
          lastYield = Date.now();
        }
      }
      // Keep the measuring tree intact while the HTML fallback may need it.
      const mathSnapshots = [];
      for (const math of measuredFormulas) {
        const key = JSON.stringify([math.tex, math.display, math.fontSize, math.width, math.height]);
        if (!cache.has(key)) cache.set(key, await mathCanvas(math, document));
        mathSnapshots.push(cache.get(key));
        await reportProgress();
      }
      const diagramSnapshots = [];
      for (const { node, size } of measuredDiagrams) {
        diagramSnapshots.push(await svgCanvas(node, document, size));
        await reportProgress();
      }
      if (canAttach) clone.remove();
      measuredFormulas.forEach(({ node, tex, width, height }, index) => {
        const snapshot = mathSnapshots[index];
        if (snapshot) {
          const size = {
            width: width || Number(node.getAttribute('width')) || snapshot.width,
            height: height || Number(node.getAttribute('height')) || snapshot.height
          };
          replaceWithSnapshotImage(node, snapshot.dataUrl, imageAltFor(node), size);
        } else {
          node.replaceWith(textElement(document, 'code', 'ge-math-source-fallback', tex));
        }
      });
      measuredDiagrams.forEach(({ node, size }, index) => {
        const data = diagramSnapshots[index];
        if (data) replaceWithSnapshotImage(node, data, imageAltFor(node), size);
        else {
          const fallback = textElement(document, 'pre', 'ge-mermaid-source-fallback', node.getAttribute('data-ge-mermaid-source') || '图表快照不可用。');
          node.replaceWith(fallback);
        }
      });
      for (const job of pdfDiagrams || []) {
        await rasterizePdfDiagram(job, document);
        await reportProgress();
      }
      for (const element of Array.from(clone.querySelectorAll('[data-ge-image-placeholder], [data-ge-image-ref], [data-ge-asset-id], [data-ge-math], [data-ge-mermaid], [data-ge-mermaid-error], [data-ge-snapshot-measuring]'))) {
        if (element.hasAttribute('data-ge-image-placeholder') || element.hasAttribute('data-ge-image-ref') || element.hasAttribute('data-ge-asset-id')) {
          element.replaceWith(textElement(document, 'span', 'ge-unavailable-image', element.getAttribute('data-ge-alt') || '图片不可用'));
        } else if (element.hasAttribute('data-ge-mermaid-error')) {
          element.removeAttribute('data-ge-mermaid-error');
        } else {
          for (const attribute of Array.from(element.attributes)) if (attribute.name.startsWith('data-ge-')) element.removeAttribute(attribute.name);
        }
      }
    } finally {
      if (canAttach && clone.isConnected) clone.remove();
    }
    clone.removeAttribute('data-ge-snapshot-measuring');
    clone.removeAttribute('style');
    if (typeof api.sanitizeHtml === 'function') {
      const safe = api.sanitizeHtml(clone.innerHTML);
      const Parser = root.DOMParser || (document && document.defaultView && document.defaultView.DOMParser);
      if (Parser) {
        const parsed = new Parser().parseFromString(safe, 'text/html');
        clone.innerHTML = '';
        clone.append(...Array.from(parsed.body.childNodes));
      }
    }
    return clone;
  }

  api.richBodyHtml = richBodyHtml;
  api.enhanceRichContent = enhanceRichContent;
  api.refreshRichAssets = refreshRichAssets;
  api.snapshotRichContent = snapshotRichContent;
})(globalThis);
