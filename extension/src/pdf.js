(function attachGptExporterPdf(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const FONT_FILE = 'NotoSansCJKsc-Regular.otf';
  const FONT_FAMILY = 'GptExporterNotoSansCJKsc';
  const FONT_PATH = `vendor/fonts/${FONT_FILE}`;
  const PAGE_WIDTH = { A4: 595.28, LETTER: 612 };
  const PAGE_HEIGHT = { A4: 841.89, LETTER: 792 };
  const MARGINS = [48, 46, 48, 46];
  const DANGEROUS_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'template', 'form', 'input',
    'button', 'textarea', 'select', 'option', 'link', 'meta', 'base'
  ]);
  const FLOW_BLOCK_TAGS = new Set([
    'article', 'aside', 'blockquote', 'div', 'dl', 'figcaption', 'figure', 'footer', 'header',
    'hr', 'main', 'ol', 'p', 'pre', 'section', 'table', 'ul'
  ]);

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  }

  function textOf(node) {
    return cleanText(node && node.textContent || '').replace(/\u00a0/g, ' ');
  }

  function safeFilename(value) {
    const name = cleanText(value || 'attachment')
      .split(/[\\/]/).pop()
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[<>:"|?*]/g, '_')
      .trim()
      .slice(0, 180);
    return name || 'attachment';
  }

  function integerAttribute(node, name) {
    const value = node && node.getAttribute ? node.getAttribute(name) : null;
    if (value == null || !/^-?\d+$/.test(value.trim())) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  function orderedListType(value) {
    const types = { '1': 'decimal', a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman' };
    return types[value] || 'decimal';
  }

  function dataUrlInfo(value, allowAnyMime) {
    const input = String(value || '').trim();
    const match = input.match(/^data:([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+);base64,([a-z0-9+/]*={0,2})$/i);
    if (!match || !match[2] || match[2].length % 4 !== 0) return null;
    const mimeType = match[1].toLowerCase();
    if (!allowAnyMime && !/^image\/(?:png|jpeg|webp|gif)$/.test(mimeType)) return null;
    return { dataUrl: input, mimeType };
  }

  function inlineRuns(node, options) {
    const settings = Object.assign({ skipNestedLists: false }, options || {});
    const visit = (current, inherited) => {
      if (!current) return [];
      if (current.nodeType === 3) {
        const value = cleanText(current.nodeValue || '');
        return value ? [Object.keys(inherited).length ? { text: value, ...inherited } : value] : [];
      }
      if (current.nodeType !== 1) return [];

      const tag = String(current.localName || '').toLowerCase();
      if (DANGEROUS_TAGS.has(tag) || tag === 'svg' || tag === 'math' || tag === 'canvas' || tag === 'video' || tag === 'audio') return [];
      if (settings.skipNestedLists && (tag === 'ul' || tag === 'ol')) return [];
      if (tag === 'br') return [{ text: '\n', ...inherited }];
      if (tag === 'img') {
        const alt = cleanText(current.getAttribute('alt') || '');
        return alt ? [{ text: alt, ...inherited }] : [];
      }

      const style = inlineStyleFor(tag, inherited, current);

      const output = [];
      for (const child of Array.from(current.childNodes || [])) output.push(...visit(child, style));
      return output;
    };
    return visit(node, {});
  }

  function safePdfLink(value) {
    const href = String(value || '').trim();
    if (!href || /[\u0000-\u0020\u007f\\]/.test(href)) return '';
    try {
      const url = new URL(href);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        if (url.username || url.password) return '';
        return url.href;
      }
      if (url.protocol === 'mailto:' && url.pathname && !/[<>]/.test(url.pathname)) return url.href;
    } catch (_) { return ''; }
    return '';
  }

  function inlineStyleFor(tag, inherited, node) {
    if (tag === 'strong' || tag === 'b') return Object.assign({}, inherited, { bold: true });
    if (tag === 'em' || tag === 'i') return Object.assign({}, inherited, { italics: true });
    if (tag === 'del' || tag === 's') return Object.assign({}, inherited, { decoration: 'lineThrough' });
    if (tag === 'code') return Object.assign({}, inherited, { font: FONT_FAMILY, fontSize: 8.5, color: '#8d3b3b' });
    if (tag === 'sup') return Object.assign({}, inherited, { sup: true, fontSize: 8 });
    if (tag === 'sub') return Object.assign({}, inherited, { sub: true, fontSize: 8 });
    if (tag === 'a') {
      const href = safePdfLink(node && node.getAttribute('href'));
      return href ? Object.assign({}, inherited, { link: href, color: '#52786a', decoration: 'underline' }) : inherited;
    }
    return inherited;
  }

  function inlineText(node, options) {
    const runs = inlineRuns(node, options);
    return runs.length ? runs : '';
  }

  function hardWrapToken(token, maxCharacters) {
    const characters = Array.from(token);
    if (characters.length <= maxCharacters) return token;
    const pieces = [];
    for (let offset = 0; offset < characters.length; offset += maxCharacters) {
      pieces.push(characters.slice(offset, offset + maxCharacters).join(''));
    }
    return pieces.join('\n');
  }

  function wrapLongTokens(value, maxCharacters) {
    const wrap = (text) => cleanText(text).replace(/\S+/gu, (token) => hardWrapToken(token, maxCharacters));
    if (!Array.isArray(value)) return wrap(value);
    return value.map((run) => {
      if (typeof run === 'string') return wrap(run);
      if (!run || typeof run !== 'object' || typeof run.text !== 'string') return run;
      return Object.assign({}, run, { text: wrap(run.text) });
    });
  }

  function breakLongCodeLines(value) {
    return cleanText(value).split('\n').map((line) => {
      // Hard breaks keep very long unspaced source lines within the printable page
      // while leaving every source character searchable in extracted text.
      const pieces = [];
      const characters = Array.from(line);
      for (let offset = 0; offset < characters.length; offset += 56) pieces.push(characters.slice(offset, offset + 56).join(''));
      return pieces.join('\n');
    }).join('\n');
  }

  function directRows(table) {
    const rows = [];
    for (const section of Array.from(table.children || [])) {
      const tag = String(section.localName || '').toLowerCase();
      if (tag === 'tr') rows.push(section);
      else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
        for (const row of Array.from(section.children || [])) {
          if (String(row.localName || '').toLowerCase() === 'tr') rows.push(row);
        }
      }
    }
    if (rows.length) return rows;
    return Array.from(table.querySelectorAll ? table.querySelectorAll('tr') : [])
      .filter((row) => row.closest('table') === table);
  }

  function directCells(row) {
    return Array.from(row.children || []).filter((cell) => {
      const tag = String(cell.localName || '').toLowerCase();
      return tag === 'td' || tag === 'th';
    });
  }

  function buildTable(table, maxWidth) {
    const rows = directRows(table);
    if (!rows.length) return null;
    const cellRows = rows.map(directCells);
    const columnCount = Math.max(1, ...cellRows.map((cells) => cells.reduce((count, cell) => {
      const span = Number.parseInt(cell.getAttribute('colspan') || '1', 10);
      return count + (Number.isSafeInteger(span) ? Math.max(1, Math.min(16, span)) : 1);
    }, 0)));
    const body = cellRows.map((cells) => {
      const output = [];
      for (const cell of cells) {
        const parsedSpan = Number.parseInt(cell.getAttribute('colspan') || '1', 10);
        const span = Number.isSafeInteger(parsedSpan) ? Math.max(1, Math.min(columnCount, parsedSpan)) : 1;
        const maxTokenCharacters = Math.max(1, Math.floor((maxWidth / columnCount - 12) / 8.5));
        const cellDefinition = {
          text: wrapLongTokens(inlineText(cell), maxTokenCharacters),
          margin: [4, 3, 4, 3],
          fontSize: 8.5,
          valign: 'top'
        };
        if (String(cell.localName || '').toLowerCase() === 'th') {
          cellDefinition.bold = true;
          cellDefinition.fillColor = '#eef2ef';
        }
        if (span > 1) cellDefinition.colSpan = span;
        output.push(cellDefinition);
        for (let index = 1; index < span; index += 1) output.push('');
      }
      while (output.length < columnCount) output.push({ text: '', margin: [4, 3, 4, 3] });
      return output.slice(0, columnCount);
    });
    let headerRows = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const hasThead = String(rows[index].parentElement && rows[index].parentElement.localName || '').toLowerCase() === 'thead';
      const allHeaderCells = cellRows[index].length > 0 && cellRows[index].every((cell) => String(cell.localName || '').toLowerCase() === 'th');
      if (hasThead || (headerRows === index && allHeaderCells)) headerRows += 1;
      else break;
    }
    const definition = {
      table: {
        headerRows,
        widths: Array(columnCount).fill('*'),
        body
      },
      layout: 'lightHorizontalLines',
      fontSize: 8.5,
      margin: [0, 5, 0, 9]
    };
    return definition;
  }

  function makeMetadata(conversation) {
    const rows = [];
    if (conversation && conversation.title) rows.push(['标题', cleanText(conversation.title)]);
    if (conversation && conversation.url) rows.push(['来源', cleanText(conversation.url)]);
    if (conversation && conversation.exportedAt) rows.push(['导出时间', cleanText(conversation.exportedAt)]);
    const content = [];
    if (conversation && conversation.title) content.push({ text: cleanText(conversation.title), style: 'documentTitle' });
    if (rows.length > 1) {
      content.push({
        table: { widths: [72, '*'], body: rows.slice(1).map(([label, value]) => [
          { text: label, color: '#64716b', fontSize: 8.5, margin: [0, 1, 8, 1] },
          { text: value, fontSize: 8.5, margin: [0, 1, 0, 1] }
        ]) },
        layout: 'noBorders',
        margin: [0, 3, 0, 8]
      });
    }
    const warnings = Array.isArray(conversation && conversation.warnings)
      ? conversation.warnings.filter(Boolean).map(cleanText)
      : [];
    if (warnings.length) content.push({ text: `提示：${warnings.join('；')}`, style: 'warning', margin: [0, 0, 0, 10] });
    if (content.length) content.push({ text: ' ', margin: [0, 0, 0, 3] });
    return content;
  }

  function collectAttachments(conversation, selectedIds) {
    const files = {};
    const byMessage = new Map();
    const assets = Array.isArray(conversation && conversation.assets) ? conversation.assets : [];
    let fileIndex = 0;
    for (const asset of assets) {
      if (!asset || typeof asset !== 'object' || asset.kind !== 'attachment') continue;
      const messageId = String(asset.messageId == null ? '' : asset.messageId);
      if (!messageId || !selectedIds.has(messageId)) continue;
      const name = safeFilename(asset.name);
      let attachment;
      if (asset.status === 'ready') {
        const source = dataUrlInfo(asset.dataUrl, true);
        const declaredMime = String(asset.mimeType || '').toLowerCase();
        if (source && (!declaredMime || source.mimeType === declaredMime)) {
          const key = `gpt_exporter_attachment_${++fileIndex}`;
          files[key] = { src: source.dataUrl, name };
          attachment = { name, key, status: 'ready' };
        } else {
          attachment = { name, status: 'unavailable', reason: '文件数据格式无效或尚未载入' };
        }
      } else {
        attachment = {
          name,
          status: 'unavailable',
          reason: asset.status === 'pending' ? '文件尚未载入' : '文件不可用'
        };
      }
      const list = byMessage.get(messageId) || [];
      list.push(attachment);
      byMessage.set(messageId, list);
    }
    return { files, byMessage };
  }

  function attachmentContent(attachments) {
    const content = [];
    for (const attachment of attachments || []) {
      content.push({ text: `附件：${attachment.name}`, style: 'attachment', margin: [12, 2, 0, 3] });
      if (attachment.status === 'ready') {
        content.push({ text: '已嵌入 PDF 附件面板', color: '#64716b', fontSize: 8, margin: [12, 0, 0, 6] });
      } else {
        content.push({ text: `[附件未嵌入：${attachment.reason}]`, color: '#8d3b3b', fontSize: 8, margin: [12, 0, 0, 6] });
      }
    }
    return content;
  }

  function pageWidth(pageSize, orientation) {
    const portrait = PAGE_WIDTH[pageSize];
    const landscape = PAGE_HEIGHT[pageSize];
    return orientation === 'landscape' ? landscape : portrait;
  }

  function imageFallback(image) {
    const alt = cleanText(image.getAttribute('alt') || '').trim();
    return { text: alt ? `[图片未嵌入：${alt}]` : '[图片未嵌入：图像数据不可用]', style: 'resourceFallback', margin: [0, 3, 0, 7] };
  }

  function imageDimensions(source) {
    if (typeof root.atob !== 'function') return null;
    const encoded = source.dataUrl.slice(source.dataUrl.indexOf(',') + 1);
    const prefixLength = Math.min(encoded.length - (encoded.length % 4), 350000);
    let decoded;
    try { decoded = root.atob(encoded.slice(0, prefixLength)); }
    catch (_) { return null; }
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const u16 = (offset) => (bytes[offset] << 8) | bytes[offset + 1];
    const u32 = (offset) => ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
    if (source.mimeType === 'image/png' && bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return { width: u32(16), height: u32(20) };
    }
    if (source.mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
      let offset = 2;
      while (offset + 8 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        while (bytes[offset] === 0xff) offset += 1;
        const marker = bytes[offset++];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 1 >= bytes.length) break;
        const length = u16(offset);
        if (length < 2 || offset + length > bytes.length) break;
        if (frameMarkers.has(marker) && length >= 7) return { height: u16(offset + 3), width: u16(offset + 5) };
        offset += length;
      }
    }
    return null;
  }

  function cssPixelLength(node, name) {
    const styleValue = node.style && node.style[name];
    const attrValue = node.getAttribute(name);
    const value = styleValue || attrValue || '';
    const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(?:px)?$/i);
    if (!match) return null;
    const pixels = Number(match[1]);
    return Number.isFinite(pixels) && pixels > 0 && pixels <= 100000 ? pixels : null;
  }

  function imageDisplaySize(image, source, maxWidth, maxHeight) {
    const dimensions = imageDimensions(source);
    if (!dimensions || !dimensions.width || !dimensions.height) return null;
    const nativeWidth = dimensions.width * 0.75;
    const nativeHeight = dimensions.height * 0.75;
    const cssWidth = cssPixelLength(image, 'width');
    const cssHeight = cssPixelLength(image, 'height');
    let scale = 1;
    if (cssWidth != null) scale = Math.min(scale, (cssWidth * 0.75) / nativeWidth);
    if (cssHeight != null) scale = Math.min(scale, (cssHeight * 0.75) / nativeHeight);
    scale = Math.min(scale, maxWidth / nativeWidth, maxHeight / nativeHeight, 1);
    return {
      width: Math.max(0.75, Math.round(nativeWidth * scale * 100) / 100),
      height: Math.max(0.75, Math.round(nativeHeight * scale * 100) / 100)
    };
  }

  function renderImage(image, maxWidth, maxHeight) {
    const source = dataUrlInfo(image.getAttribute('src'), false);
    if (!source || (source.mimeType !== 'image/png' && source.mimeType !== 'image/jpeg')) return imageFallback(image);
    const size = imageDisplaySize(image, source, maxWidth, maxHeight);
    if (!size) return imageFallback(image);
    return {
      image: source.dataUrl,
      width: size.width,
      alignment: 'center',
      margin: [0, 5, 0, 9]
    };
  }

  function estimatedTextWidth(runs) {
    let width = 0;
    for (const run of runs) {
      const text = typeof run === 'string' ? run : cleanText(run && run.text || '');
      if (text.includes('\n')) return Infinity;
      const fontSize = Number(run && typeof run === 'object' && run.fontSize) || 10;
      for (const character of Array.from(text)) {
        const codePoint = character.codePointAt(0);
        if (/\s/.test(character)) width += fontSize * 0.3;
        else if (codePoint >= 0x2e80) width += fontSize;
        else if (/[ilI.,'`:;!|]/.test(character)) width += fontSize * 0.32;
        else if (/[MW@#%&]/.test(character)) width += fontSize * 0.78;
        else width += fontSize * 0.56;
      }
    }
    // Keep a generous safety margin; pdfmake remains the final line-width authority.
    return width * 1.2;
  }

  function inlineMathTable(parts) {
    const cells = [];
    const widths = [];
    for (const part of parts) {
      if (part.type === 'text') {
        cells.push({ text: part.runs, margin: [0, 0, 0, 0], valign: 'middle' });
        widths.push('auto');
      } else {
        cells.push({ image: part.definition.image, width: part.definition.width, alignment: 'center', margin: [0, 2, 0, 0], valign: 'middle' });
        widths.push(part.definition.width);
      }
    }
    return {
      table: { widths, body: [cells] },
      layout: 'noBorders',
      margin: [0, 0, 0, 7]
    };
  }

  function paragraphBlocks(paragraph, maxWidth, maxHeight) {
    const output = [];
    let runs = [];
    let inlineParts = [];
    const inlineMathMaxHeight = 1.8 * 10 * 1.3;
    const flushRuns = () => {
      if (runs.length) inlineParts.push({ type: 'text', runs });
      runs = [];
    };
    const flushInlineParts = () => {
      if (!inlineParts.length) return;
      const mathParts = inlineParts.filter((part) => part.type === 'math');
      const textParts = inlineParts.filter((part) => part.type === 'text');
      const hasNeighboringText = textParts.some((part) => part.runs.some((run) => String(typeof run === 'string' ? run : run.text || '').trim()));
      const allOneLine = textParts.every((part) => part.runs.every((run) => !String(typeof run === 'string' ? run : run.text || '').includes('\n')));
      const estimatedWidth = textParts.reduce((total, part) => total + estimatedTextWidth(part.runs), 0) +
        mathParts.reduce((total, part) => total + part.definition.width + 3, 0);
      if (mathParts.length && hasNeighboringText && allOneLine && estimatedWidth <= maxWidth - 12) {
        output.push(inlineMathTable(inlineParts));
      } else {
        let textRuns = [];
        const flushText = () => {
          if (textRuns.length) output.push({ text: textRuns, style: 'paragraph', margin: [0, 0, 0, 7] });
          textRuns = [];
        };
        for (const part of inlineParts) {
          if (part.type === 'text') textRuns.push(...part.runs);
          else {
            flushText();
            output.push(part.definition);
          }
        }
        flushText();
      }
      inlineParts = [];
    };
    const visit = (node, style) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const value = cleanText(node.nodeValue || '');
        if (value) runs.push(Object.keys(style).length ? { text: value, ...style } : value);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = String(node.localName || '').toLowerCase();
      if (DANGEROUS_TAGS.has(tag) || tag === 'svg' || tag === 'math' || tag === 'canvas' || tag === 'video' || tag === 'audio') return;
      if (tag === 'img') {
        flushRuns();
        const source = dataUrlInfo(node.getAttribute('src'), false);
        const size = source && (source.mimeType === 'image/png' || source.mimeType === 'image/jpeg')
          ? imageDisplaySize(node, source, maxWidth, maxHeight)
          : null;
        const isInlineMath = /^TeX:/.test(cleanText(node.getAttribute('alt') || '')) && size && size.height <= inlineMathMaxHeight;
        if (isInlineMath) {
          inlineParts.push({ type: 'math', definition: renderImage(node, maxWidth, maxHeight) });
        } else {
          flushInlineParts();
          output.push(renderImage(node, maxWidth, maxHeight));
        }
        return;
      }
      if (tag === 'br') {
        runs.push({ text: '\n', ...style });
        return;
      }
      const childStyle = inlineStyleFor(tag, style, node);
      for (const child of Array.from(node.childNodes || [])) visit(child, childStyle);
    };
    for (const child of Array.from(paragraph.childNodes || [])) visit(child, {});
    flushRuns();
    flushInlineParts();
    return output;
  }

  function buildPdfDefinition(options) {
    const settings = options || {};
    const conversation = settings.conversation && typeof settings.conversation === 'object' ? settings.conversation : {};
    const selectedMessages = Array.isArray(settings.messages) ? settings.messages : (Array.isArray(conversation.messages) ? conversation.messages : []);
    if (!selectedMessages.length) throw new TypeError('请至少选择一条消息后再生成 PDF。');
    const selectedIds = new Set(selectedMessages.map((message) => message && message.id != null ? String(message.id) : '').filter(Boolean));
    const container = settings.container;
    if (!container || container.nodeType !== 1) throw new TypeError('PDF 内容容器无效或尚未完成渲染。');

    const requestedPageSize = settings.pageSize == null ? 'A4' : String(settings.pageSize).toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(PAGE_WIDTH, requestedPageSize)) throw new TypeError('PDF 纸张规格仅支持 A4 或 LETTER。');
    const orientation = settings.orientation == null ? 'portrait' : String(settings.orientation).toLowerCase();
    if (orientation !== 'portrait' && orientation !== 'landscape') throw new TypeError('PDF 页面方向仅支持 portrait 或 landscape。');
    const includeMetadata = settings.includeMetadata !== false;
    const width = pageWidth(requestedPageSize, orientation) - MARGINS[0] - MARGINS[2];
    const maxHeight = (orientation === 'landscape' ? PAGE_WIDTH[requestedPageSize] : PAGE_HEIGHT[requestedPageSize]) - MARGINS[1] - MARGINS[3] - 80;
    const attachments = collectAttachments(conversation, selectedIds);
    const content = [];
    let renderedArticleCount = 0;
    const articleElements = Array.from(container.querySelectorAll ? container.querySelectorAll('article') : []);
    const articleIds = new Set(articleElements.map((article) => article.getAttribute('data-message-id')).filter(Boolean));
    const hasTaggedArticles = articleIds.size > 0;

    const renderBlock = (node, context) => {
      if (!node) return [];
      if (node.nodeType === 3) {
        const value = cleanText(node.nodeValue || '').trim();
        return value ? [{ text: value, style: 'paragraph', margin: [0, 0, 0, 5] }] : [];
      }
      if (node.nodeType !== 1) return [];
      const tag = String(node.localName || '').toLowerCase();
      if (DANGEROUS_TAGS.has(tag)) return [];
      if (tag === 'svg' || tag === 'math' || tag === 'canvas' || tag === 'video' || tag === 'audio') {
        const label = tag === 'math' ? textOf(node) : '';
        return [{ text: label ? `[未转换的公式：${label}]` : `[未转换的${tag === 'svg' ? '矢量图' : tag === 'math' ? '公式' : tag === 'canvas' ? '画布图像' : '媒体'}]`, style: 'resourceFallback', margin: [0, 3, 0, 7] }];
      }
      if (tag === 'img') return [renderImage(node, width, maxHeight)];

      if (tag === 'header') {
        if (!includeMetadata) return [];
        return renderFlowChildren(node, context);
      }
      if (tag === 'article') {
        const id = node.getAttribute('data-message-id');
        if (id && !selectedIds.has(id)) return [];
        if (hasTaggedArticles && !id) return [];
        renderedArticleCount += 1;
        const blocks = renderFlowChildren(node, context);
        const linkedAssets = attachments.byMessage.get(id || '');
        blocks.push(...attachmentContent(linkedAssets));
        return blocks;
      }
      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag.slice(1));
        const isDocumentTitle = tag === 'h1' && String(node.parentElement && node.parentElement.localName || '').toLowerCase() === 'header';
        return [{ text: inlineText(node), style: isDocumentTitle ? 'documentTitle' : `heading${level}`, margin: [0, level === 1 ? 3 : 9, 0, level === 1 ? 9 : 4], keepWithNext: true }];
      }
      if (tag === 'p') {
        return paragraphBlocks(node, width, maxHeight);
      }
      if (tag === 'pre') {
        const source = node.querySelector && node.querySelector('code') ? node.querySelector('code') : node;
        const code = breakLongCodeLines(textOf(source));
        return code ? [{ text: code, style: 'codeBlock', margin: [12, 4, 0, 9], preserveLeadingSpaces: true, lineHeight: 1.15 }] : [];
      }
      if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(node.children || []).filter((child) => String(child.localName || '').toLowerCase() === 'li');
        if (!items.length) return [];
        const list = { [tag]: [], margin: [context.listDepth * 12, 3, 0, 7] };
        if (tag === 'ol') {
          const reversed = node.hasAttribute('reversed');
          const start = integerAttribute(node, 'start');
          let counter = start == null ? (reversed ? items.length : 1) : start;
          list.type = orderedListType(node.getAttribute('type'));
          list.reversed = reversed;
          list.start = counter;
          for (const item of items) {
            const explicitValue = integerAttribute(item, 'value');
            if (explicitValue != null) counter = explicitValue;
            const itemDefinition = { stack: renderListItem(item, context.listDepth) };
            itemDefinition.counter = counter;
            list.ol.push(itemDefinition);
            counter += reversed ? -1 : 1;
          }
        } else {
          for (const item of items) list.ul.push({ stack: renderListItem(item, context.listDepth) });
        }
        return [list];
      }
      if (tag === 'table') {
        const table = buildTable(node, width);
        return table ? [table] : [{ text: '[表格没有可导出的行]', style: 'resourceFallback' }];
      }
      if (tag === 'blockquote') {
        const blocks = renderFlowChildren(node, context);
        return blocks.map((block) => {
          if (typeof block === 'string') return { text: block, style: 'quote', margin: [16, 2, 0, 4] };
          if (block && block.text) return Object.assign({}, block, { color: '#56665e', italics: true, margin: [16, 2, 0, 5] });
          return block;
        });
      }
      if (tag === 'hr') return [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.5, lineColor: '#d9dfdb' }], margin: [0, 7, 0, 9] }];
      if (tag === 'aside') {
        const runs = inlineText(node);
        return runs ? [{ text: runs, style: 'warning', margin: [5, 5, 5, 8], fillColor: '#f2f5f2' }] : [];
      }
      if (tag === 'dl') {
        const children = Array.from(node.children || []);
        const rows = [];
        for (let index = 0; index < children.length - 1; index += 1) {
          if (String(children[index].localName || '').toLowerCase() === 'dt' && String(children[index + 1].localName || '').toLowerCase() === 'dd') {
            rows.push([
              { text: inlineText(children[index]), color: '#64716b', fontSize: 8.5, margin: [0, 1, 8, 1] },
              { text: inlineText(children[index + 1]), fontSize: 8.5, margin: [0, 1, 0, 1] }
            ]);
            index += 1;
          }
        }
        return rows.length ? [{ table: { widths: [72, '*'], body: rows }, layout: 'noBorders', margin: [0, 3, 0, 8] }] : renderFlowChildren(node, context);
      }
      if (tag === 'br') return [{ text: '\n' }];
      if (FLOW_BLOCK_TAGS.has(tag)) {
        return renderFlowChildren(node, context);
      }
      // Unknown semantic wrappers retain their text and safe descendants.
      return renderFlowChildren(node, context);
    };

    const renderChildren = (parent, context) => {
      const output = [];
      for (const child of Array.from(parent.childNodes || [])) output.push(...renderBlock(child, context));
      return output;
    };

    const renderFlowChildren = (parent, context) => {
      const output = [];
      let inlineNodes = [];
      const flushInline = () => {
        if (!inlineNodes.length) return;
        const visible = inlineNodes.some((node) => {
          if (node.nodeType === 3) return Boolean(cleanText(node.nodeValue || '').trim());
          if (node.nodeType !== 1) return false;
          return Boolean(textOf(node).trim() || (node.matches && node.matches('img')) || (node.querySelector && node.querySelector('img')));
        });
        if (visible) {
          const wrapper = parent.ownerDocument.createElement('span');
          inlineNodes.forEach((node) => wrapper.appendChild(node.cloneNode(true)));
          output.push(...paragraphBlocks(wrapper, width, maxHeight));
        }
        inlineNodes = [];
      };
      for (const child of Array.from(parent.childNodes || [])) {
        const tag = child.nodeType === 1 ? String(child.localName || '').toLowerCase() : '';
        if (tag && (FLOW_BLOCK_TAGS.has(tag) || /^h[1-6]$/.test(tag))) {
          flushInline();
          output.push(...renderBlock(child, context));
        } else {
          inlineNodes.push(child);
        }
      }
      flushInline();
      return output;
    };

    const renderListItem = (item, listDepth) => {
      const blocks = renderFlowChildren(item, { listDepth: listDepth + 1 });
      return blocks.length ? blocks : [{ text: ' ', style: 'paragraph' }];
    };

    if (includeMetadata && !container.querySelector('header')) {
      content.push(...makeMetadata(conversation));
    }
    content.push(...renderFlowChildren(container, { listDepth: 0 }));

    const articleIdsInMessages = selectedMessages.map((message) => String(message && message.id == null ? '' : message.id));
    if (!renderedArticleCount && !articleElements.length) {
      const fallbackText = textOf(container).trim();
      if (fallbackText) content.push({ text: fallbackText, style: 'paragraph' });
    }
    for (const [messageId, items] of attachments.byMessage) {
      if (articleIdsInMessages.includes(messageId) && !articleIds.has(messageId)) content.push(...attachmentContent(items));
    }
    if (!content.length || (!renderedArticleCount && !textOf(container).trim() && !Object.keys(attachments.files).length)) {
      throw new TypeError('PDF 内容为空。请确认所选消息已完成渲染后重试。');
    }

    const definition = {
      pageSize: requestedPageSize,
      pageOrientation: orientation,
      pageMargins: MARGINS.slice(),
      info: {
        title: cleanText(conversation.title || 'ChatGPT conversation'),
        subject: 'Conversation export',
        creator: 'GptExporter'
      },
      defaultStyle: { font: FONT_FAMILY, fontSize: 10, color: '#27312d', lineHeight: 1.25 },
      styles: {
        documentTitle: { fontSize: 20, bold: true, color: '#263c33', margin: [0, 0, 0, 7] },
        paragraph: { fontSize: 10, lineHeight: 1.3 },
        heading1: { fontSize: 18, bold: true, color: '#263c33' },
        heading2: { fontSize: 15, bold: true, color: '#30493e' },
        heading3: { fontSize: 13, bold: true, color: '#3d594d' },
        heading4: { fontSize: 12, bold: true },
        heading5: { fontSize: 11, bold: true },
        heading6: { fontSize: 10, bold: true },
        codeBlock: { font: FONT_FAMILY, fontSize: 8.5, color: '#39423e', fillColor: '#f2f4f1', lineHeight: 1.15 },
        quote: { color: '#56665e', italics: true },
        warning: { fontSize: 8.5, color: '#665f45' },
        attachment: { fontSize: 9, bold: true, color: '#314b40' },
        resourceFallback: { fontSize: 8.5, color: '#8d3b3b', italics: true }
      },
      content,
      footer: (currentPage, pageCount) => ({
        text: `第 ${currentPage} 页 / 共 ${pageCount} 页`,
        alignment: 'center',
        font: FONT_FAMILY,
        fontSize: 8,
        color: '#7b8580',
        margin: [0, 12, 0, 0]
      })
    };
    if (Object.keys(attachments.files).length) definition.files = attachments.files;
    return definition;
  }

  function imageDataToPng(dataUrl) {
    if (!root.Image || !root.document || !root.document.createElement) return Promise.resolve(null);
    return new Promise((resolve) => {
      let image;
      try { image = new root.Image(); } catch (_) { resolve(null); return; }
      image.onload = () => {
        try {
          const canvas = root.document.createElement('canvas');
          canvas.width = image.naturalWidth || image.width;
          canvas.height = image.naturalHeight || image.height;
          if (!canvas.width || !canvas.height || canvas.width * canvas.height > 40000000) { resolve(null); return; }
          const context = canvas.getContext('2d');
          if (!context) { resolve(null); return; }
          context.drawImage(image, 0, 0);
          const output = canvas.toDataURL('image/png');
          resolve(dataUrlInfo(output, false) ? output : null);
        } catch (_) { resolve(null); }
      };
      image.onerror = () => resolve(null);
      image.src = dataUrl;
    });
  }

  async function normalizeImages(container) {
    const images = Array.from(container.querySelectorAll ? container.querySelectorAll('img') : []);
    for (const image of images) {
      const source = dataUrlInfo(image.getAttribute('src'), false);
      if (!source || source.mimeType === 'image/png' || source.mimeType === 'image/jpeg') continue;
      const png = await imageDataToPng(source.dataUrl);
      if (png) image.setAttribute('src', png);
      else image.removeAttribute('src');
    }
  }

  function getLocalFontUrl() {
    try {
      if (root.chrome && root.chrome.runtime && typeof root.chrome.runtime.getURL === 'function') {
        return root.chrome.runtime.getURL(FONT_PATH);
      }
    } catch (_) { /* Fall through to the extension page's own directory. */ }
    const base = root.document && root.document.baseURI || root.location && root.location.href;
    if (base) {
      const url = new URL(FONT_PATH, base);
      if (url.origin !== new URL(base).origin) throw new Error('PDF 字体路径必须来自扩展本地资源。');
      return url.href;
    }
    return FONT_PATH;
  }

  function bytesToBase64(bytes) {
    const chunks = [];
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }
    return root.btoa(chunks.join(''));
  }

  const fontRegistration = new WeakMap();
  async function ensureFont(pdfMake) {
    if (fontRegistration.has(pdfMake)) return fontRegistration.get(pdfMake);
    const loading = (async () => {
      if (typeof root.fetch !== 'function') throw new Error('无法读取本地 PDF 字体：当前环境不支持 fetch。');
      let response;
      try {
        response = await root.fetch(getLocalFontUrl(), { credentials: 'same-origin', cache: 'force-cache' });
      } catch (_) {
        throw new Error('无法读取本地 NotoSansCJK 字体文件。请重新安装扩展后重试。');
      }
      if (!response || !response.ok || typeof response.arrayBuffer !== 'function') {
        throw new Error('本地 NotoSansCJK 字体文件不可用，PDF 未生成。');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) throw new Error('本地 NotoSansCJK 字体文件为空，PDF 未生成。');
      if (typeof root.btoa !== 'function') throw new Error('当前环境无法将本地 PDF 字体注册到虚拟文件系统。');
      const vfs = Object.assign({}, pdfMake.vfs || {});
      vfs[FONT_FILE] = bytesToBase64(bytes);
      if (typeof pdfMake.addVirtualFileSystem === 'function') pdfMake.addVirtualFileSystem(vfs);
      else pdfMake.vfs = vfs;
      const fonts = {
        [FONT_FAMILY]: { normal: FONT_FILE, bold: FONT_FILE, italics: FONT_FILE, bolditalics: FONT_FILE }
      };
      if (typeof pdfMake.addFonts === 'function') pdfMake.addFonts(fonts);
      else pdfMake.fonts = Object.assign({}, pdfMake.fonts || {}, fonts);
    })();
    fontRegistration.set(pdfMake, loading);
    try { await loading; }
    catch (error) { fontRegistration.delete(pdfMake); throw error; }
  }

  async function buildPdf(options) {
    const vendors = root.GptExporterVendors;
    const pdfMake = vendors && vendors.pdfMake;
    if (!pdfMake || typeof pdfMake.createPdf !== 'function') throw new Error('本地 PDF 生成组件不可用，请重新加载扩展后重试。');
    const settings = Object.assign({}, options || {});
    if (settings.container && typeof settings.container.cloneNode === 'function') {
      settings.container = settings.container.cloneNode(true);
      await normalizeImages(settings.container);
    }
    const definition = buildPdfDefinition(settings);
    await ensureFont(pdfMake);
    let pdf;
    try { pdf = pdfMake.createPdf(definition); }
    catch (error) { throw new Error(`PDF 文档构建失败：${error && error.message ? error.message : '未知错误'}`); }
    if (!pdf || typeof pdf.getBuffer !== 'function') throw new Error('PDF 生成器没有提供 getBuffer()，未能生成文件。');
    let buffer;
    try { buffer = await pdf.getBuffer(); }
    catch (error) { throw new Error(`PDF 文件生成失败：${error && error.message ? error.message : '未知错误'}`); }
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).slice();
    throw new Error('PDF 生成器返回了无效的文件数据。');
  }

  api.pdfDefinition = buildPdfDefinition;
  api.buildPdf = buildPdf;
})(globalThis);
