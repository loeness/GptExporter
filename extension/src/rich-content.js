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

  function protectMathSegment(source, replacements) {
    const value = String(source || '');
    const code = [];
    const nonce = `${Date.now().toString(36)}${(idCounter++).toString(36)}`;
    const codePattern = /(`+)([\s\S]*?)\1/g;
    const withoutInlineCode = value.replace(codePattern, (match) => {
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

  function protectMath(markdown) {
    const lines = String(markdown || '').split(/(?<=\n)/);
    const output = [];
    const replacements = [];
    let fence = null;
    let pending = '';
    const flush = () => {
      if (pending) output.push(protectMathSegment(pending, replacements));
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
      const protectedContent = protectMath(markdown);
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

  function messageAssets(conversation, message) {
    const assets = Array.isArray(conversation && conversation.assets) ? conversation.assets : [];
    const messageId = String(message && message.id == null ? '' : message.id);
    return assets.filter((asset) => asset && String(asset.messageId == null ? '' : asset.messageId) === messageId);
  }

  function assetUrlPath(value) {
    const url = allowedMediaUrl(value);
    return url ? `${url.origin}${url.pathname}` : '';
  }

  function findImageAsset(_message, assets, placeholder) {
    const assetId = safeAssetId(placeholder.getAttribute('data-ge-asset-id'));
    if (assetId) {
      const direct = assets.find((asset) => String(asset.id || '') === assetId && asset.kind === 'image');
      if (direct) return direct;
    }
    const reference = String(placeholder.getAttribute('data-ge-image-ref') || '');
    const path = assetUrlPath(reference);
    if (path) {
      const matching = assets.find((asset) => asset && asset.kind === 'image' && assetUrlPath(asset.url) === path);
      if (matching) return matching;
    }
    return null;
  }

  function replaceImagePlaceholder(placeholder, asset) {
    const document = placeholder.ownerDocument;
    const alt = placeholder.getAttribute('data-ge-alt') || placeholder.textContent.replace(/^图片：?/, '').trim();
    const imageData = asset && asset.status === 'ready' ? isRasterDataUrl(asset.dataUrl) : null;
    if (imageData && (!asset.mimeType || String(asset.mimeType).toLowerCase().split(';', 1)[0] === imageData.mimeType)) {
      const image = document.createElement('img');
      image.src = imageData.dataUrl;
      image.alt = alt || String(asset.name || '对话图片');
      image.className = 'ge-ready-image';
      placeholder.replaceWith(image);
      return;
    }
    const error = safeVisibleError(asset && asset.error);
    const name = asset && asset.name ? safeFilename(asset.name) : alt;
    const label = `图片不可用${name ? `：${name}` : ''}${error ? `（${error}）` : ''}`;
    const fallback = textElement(document, 'span', 'ge-unavailable-image', label);
    placeholder.replaceWith(fallback);
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
      const reason = error || (asset.status === 'ready' ? '附件类型不支持安全下载' : '附件不可用');
      card.append(textElement(document, 'span', 'ge-unavailable-attachment', `${name}（${reason}）`));
    }
    return card;
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
    const messages = new Map((Array.isArray(conversation && conversation.messages) ? conversation.messages : [])
      .map((message) => [String(message.id || ''), message]));
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

    for (const article of Array.from(container.querySelectorAll('article[data-message-id]'))) {
      const message = messages.get(article.getAttribute('data-message-id')) || { id: article.getAttribute('data-message-id') };
      const assets = messageAssets(conversation, message);
      for (const placeholder of Array.from(article.querySelectorAll('[data-ge-image-placeholder="true"]'))) {
        replaceImagePlaceholder(placeholder, findImageAsset(message, assets, placeholder));
      }
      const attachments = assets.filter((asset) => asset.kind === 'attachment');
      if (attachments.length) {
        const section = document.createElement('section');
        section.className = 'ge-attachments';
        section.setAttribute('aria-label', '附件');
        for (const asset of attachments) section.append(renderAttachmentCard(document, asset));
        article.append(section);
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

  async function mathCanvas(node, document) {
    const vectorRenderer=vendors().renderMathSvg;
    if(typeof vectorRenderer==='function'){
      try{
        const display=node.getAttribute('data-ge-display')==='true';
        const generated=vectorRenderer(node.getAttribute('data-ge-tex')||node.textContent||'',display);
        const svg=sanitizeSvg(generated,document);
        if(svg){
          const box=String(svg.getAttribute('viewBox')||'').split(/[\s,]+/).map(Number);
          const fontSize=parseFloat(document.defaultView.getComputedStyle(node.querySelector('.katex')||node).fontSize)||19;
          if(box.length===4&&box.every(Number.isFinite)&&box[2]>0&&box[3]>0){
            const width=Math.ceil(box[2]*fontSize/1000),height=Math.ceil(box[3]*fontSize/1000);
            svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));
            const pixels=await svgCanvas(svg,document);
            if(pixels){
              const image=new root.Image();image.src=pixels;await image.decode();
              const bounds=node.getBoundingClientRect();
              const targetWidth=Math.max(1,Math.ceil(bounds.width)||width),targetHeight=Math.max(1,Math.ceil(bounds.height)||height);
              const scale=Math.min(1,targetWidth/width,targetHeight/height);
              const bitmap=document.createElement('canvas');bitmap.width=targetWidth*2;bitmap.height=targetHeight*2;
              bitmap.getContext('2d').drawImage(image,(display?(targetWidth-width*scale)/2:0)*2,(targetHeight-height*scale),width*scale*2,height*scale*2);
              return bitmap.toDataURL('image/png');
            }
          }
        }
      }catch(_){/* Keep the bounded HTML renderer as a compatibility fallback. */}
    }
    const canvasRenderer = unwrapVendor('html2canvas') || root.html2canvas;
    // SVG formulas require the self-contained vector renderer above. Falling
    // back to HTML for them can silently omit radicals, so retain source instead.
    if (typeof canvasRenderer !== 'function' || node.querySelector('svg')) return null;
    try {
      const canvas = await canvasRenderer(node, {
        backgroundColor: null, scale: 2, logging: false, useCORS: false,
        allowTaint: false, imageTimeout: 0, removeContainer: true
      });
      if (!canvas || typeof canvas.toDataURL !== 'function') return null;
      const data = canvas.toDataURL('image/png');
      return isRasterDataUrl(data) ? data : null;
    } catch (_) { return null; }
  }

  async function svgCanvas(svg, document) {
    const Serializer = document.defaultView && document.defaultView.XMLSerializer || root.XMLSerializer;
    const ImageCtor = document.defaultView && document.defaultView.Image || root.Image;
    const URLApi = document.defaultView && document.defaultView.URL || root.URL;
    if (!Serializer || !ImageCtor || !URLApi || typeof URLApi.createObjectURL !== 'function') return null;
    const copy = svg.cloneNode(true);
    const source = cleanSvgSource(new Serializer().serializeToString(copy));
    if (/<(?:foreignObject|script)\b|\son[a-z]+\s*=/i.test(source)) return null;
    const viewBox = String(copy.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const widthAttr = Number.parseFloat(copy.getAttribute('width'));
    const heightAttr = Number.parseFloat(copy.getAttribute('height'));
    const rect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { width: 0, height: 0 };
    const width = Math.ceil(rect.width || widthAttr || (viewBox.length === 4 ? viewBox[2] : 0));
    const height = Math.ceil(rect.height || heightAttr || (viewBox.length === 4 ? viewBox[3] : 0));
    if (!width || !height || width > 5000 || height > 10000 || width * height > 20000000) return null;
    copy.setAttribute('width', String(width));
    copy.setAttribute('height', String(height));
    const blob = new Blob([new Serializer().serializeToString(copy)], { type: 'image/svg+xml;charset=utf-8' });
    const objectUrl = URLApi.createObjectURL(blob);
    try {
      const image = new ImageCtor();
      const loaded = new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('SVG rasterization failed'));
      });
      image.src = objectUrl;
      await loaded;
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/png');
      return isRasterDataUrl(data) ? data : null;
    } catch (_) {
      return null;
    } finally {
      URLApi.revokeObjectURL(objectUrl);
    }
  }

  function replaceWithSnapshotImage(node, dataUrl, alt) {
    const image = node.ownerDocument.createElement('img');
    image.src = dataUrl;
    image.alt = alt;
    image.className = 'ge-snapshot-image';
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    const width = Math.round(Number(rect && rect.width) || Number(node.getAttribute && node.getAttribute('width')) || 0);
    const height = Math.round(Number(rect && rect.height) || Number(node.getAttribute && node.getAttribute('height')) || 0);
    if (width > 0 && width <= 30000) image.setAttribute('width', String(width));
    if (height > 0 && height <= 30000) image.setAttribute('height', String(height));
    node.replaceWith(image);
  }

  function safeSnapshotClone(container) {
    const clone = container.cloneNode(true);
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

  async function snapshotRichContent(container) {
    if (!container || typeof container.cloneNode !== 'function') throw new TypeError('富内容容器无效');
    const clone = safeSnapshotClone(container);
    const document = clone.ownerDocument || root.document;
    const host = document && document.body;
    const canAttach = Boolean(host && !clone.isConnected);
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
      for (const math of Array.from(clone.querySelectorAll('[data-ge-math="true"][data-ge-rendered="true"]'))) {
        const data = await mathCanvas(math, document);
        if (data) replaceWithSnapshotImage(math, data, imageAltFor(math));
        else {
          const source = math.getAttribute('data-ge-tex') || math.textContent || '';
          math.replaceWith(textElement(document, 'code', 'ge-math-source-fallback', source));
        }
      }
      for (const svg of Array.from(clone.querySelectorAll('svg.ge-mermaid-diagram'))) {
        const data = await svgCanvas(svg, document);
        if (data) replaceWithSnapshotImage(svg, data, imageAltFor(svg));
        else {
          const fallback = textElement(document, 'pre', 'ge-mermaid-source-fallback', svg.getAttribute('data-ge-mermaid-source') || '图表快照不可用。');
          svg.replaceWith(fallback);
        }
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
      if (canAttach) clone.remove();
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
  api.snapshotRichContent = snapshotRichContent;
})(globalThis);
