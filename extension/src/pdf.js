(function attachGptExporterPdf(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const FONT_FILE = 'NotoSansCJKsc-Regular.otf';
  const FONT_FAMILY = 'GptExporterNotoSansCJKsc';
  const FONT_PATH = `vendor/fonts/${FONT_FILE}`;
  const PAGE_WIDTH = { A4: 595.28, LETTER: 612 };
  const PAGE_HEIGHT = { A4: 841.89, LETTER: 792 };
  const MARGINS = [48, 46, 48, 46];
  const PDF_DENSITIES = {
    compact: { margins: [32, 32, 32, 32], lineHeight: 1.12, paragraphLineHeight: 1.12, codeLineHeight: 1.05, spacing: 0.55 },
    standard: { margins: MARGINS, lineHeight: 1.25, paragraphLineHeight: 1.3, codeLineHeight: 1.15, spacing: 1 },
    roomy: { margins: [56, 54, 56, 54], lineHeight: 1.4, paragraphLineHeight: 1.45, codeLineHeight: 1.3, spacing: 1.35 }
  };
  const CONVERSATION_CHROME = 'header:not(.message-body header), article > h2 > time, .branch-affiliations, .ge-attachments, .ge-attachment-card, [data-ge-attachment]';
  const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  const MAX_RASTER_EDGE = 2400;
  const MAX_RASTER_PIXELS = 4000000;
  const MAX_SOURCE_PIXELS = 40000000;
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
        const replacement = settings.replaceImage && settings.replaceImage(current, inherited);
        if (replacement) return [replacement];
        const alt = cleanText(current.getAttribute('alt') || '');
        return alt ? [{ text: alt, ...inherited }] : [];
      }

      const style = inlineStyleFor(tag, inherited, current, settings.fontSize);

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

  function inlineStyleFor(tag, inherited, node, fontSize = 10) {
    if (tag === 'strong' || tag === 'b') return Object.assign({}, inherited, { bold: true });
    if (tag === 'em' || tag === 'i') return Object.assign({}, inherited, { italics: true });
    if (tag === 'del' || tag === 's') return Object.assign({}, inherited, { decoration: 'lineThrough' });
    if (tag === 'code') return Object.assign({}, inherited, { font: FONT_FAMILY, fontSize: fontSize - 1.5, color: '#8d3b3b' });
    if (tag === 'sup') return Object.assign({}, inherited, { sup: true, fontSize: fontSize - 2 });
    if (tag === 'sub') return Object.assign({}, inherited, { sub: true, fontSize: fontSize - 2 });
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

  function semanticMathStack(node, maxWidth, typography, imageInfo, imageName, { fontSize = typography.fontSize, style = null } = {}) {
    if (!node.querySelector('img[alt^="TeX:"]')) return null;
    const runs = inlineRuns(node, {
      ...typography,
      fontSize,
      replaceImage(image, inherited) {
        if (!/^TeX:/.test(image.getAttribute('alt') || '')) return null;
        const source = imageInfo(image.getAttribute('src'));
        const size = imageDisplaySize(image, source && source.dimensions, maxWidth, maxWidth);
        if (!size) return null;
        const maxHeight = Math.max(fontSize, typography.fontSize) * (image.classList.contains('ge-snapshot-image') &&
          !image.classList.contains('ge-inline-math') ? 5 : 1.8);
        // Snapshot dimensions already include the source heading or table font size.
        const width = Math.min(size.width * typography.fontSize / 10, size.width * maxHeight / size.height, Math.max(0.75, maxWidth - 16));
        return { type: 'math', definition: { image: imageName(source.dataUrl), width, link: inherited.link } };
      }
    });
    if (!runs.some((run) => run.type === 'math')) return null;
    const parts = [];
    for (const run of runs) {
      const previous = parts[parts.length - 1];
      if (run.type === 'math') parts.push(run);
      else if (previous && previous.type === 'text') previous.runs.push(run);
      else parts.push({ type: 'text', runs: [run] });
    }
    return wrapInlineMath(parts, maxWidth, { ...typography, fontSize }, { style, trailingMargin: false });
  }

  function buildTable(table, maxWidth, typography, imageInfo, imageName) {
    const rows = directRows(table);
    if (!rows.length) return null;
    const cellRows = rows.map(directCells);
    const occupied = cellRows.map(() => []);
    let columnCount = 1;
    let groupEnd = 0;
    const positionedRows = cellRows.map((cells, rowIndex) => {
      let column = 0;
      if (groupEnd === rowIndex) {
        const rowGroup = rows[rowIndex].parentElement;
        groupEnd = rowIndex + 1;
        while (groupEnd < rows.length && rows[groupEnd].parentElement === rowGroup) groupEnd += 1;
      }
      return cells.map((cell) => {
        const colSpan = Math.max(1, Math.min(16, Number.parseInt(cell.getAttribute('colspan'), 10) || 1));
        const declaredRowSpan = Number.parseInt(cell.getAttribute('rowspan'), 10);
        const rowSpan = declaredRowSpan === 0 ? groupEnd - rowIndex : Math.max(1, Math.min(groupEnd - rowIndex, declaredRowSpan || 1));
        while (Array.from({ length: colSpan }, (_, offset) => occupied[rowIndex][column + offset]).some(Boolean)) column += 1;
        const start = column;
        column += colSpan;
        columnCount = Math.max(columnCount, column);
        for (let row = rowIndex; row < rowIndex + rowSpan; row += 1) {
          for (let index = start; index < column; index += 1) occupied[row][index] = true;
        }
        return { cell, start, colSpan, rowSpan };
      });
    });
    const fontSize = typography.fontSize - 1.5;
    const cellMargin = typography.margin(4, 3, 4, 3);
    const body = positionedRows.map((cells, rowIndex) => {
      const output = Array.from({ length: columnCount }, (_, column) => occupied[rowIndex][column] ? '' : { text: '', margin: cellMargin });
      for (const { cell, start, colSpan, rowSpan } of cells) {
        // lightHorizontalLines uses 8 pt of padding on each side of an internal boundary.
        const outerPadding = (start > 0 ? 8 : 0) + (start + colSpan < columnCount ? 8 : 0);
        const cellWidth = Math.max(1, (maxWidth - 16 * (columnCount - 1)) / columnCount * colSpan +
          16 * (colSpan - 1) - outerPadding - cellMargin[0] - cellMargin[2]);
        const maxTokenCharacters = Math.max(1, Math.floor((maxWidth / columnCount * colSpan - 12) / fontSize));
        const stack = semanticMathStack(cell, cellWidth, typography, imageInfo, imageName, { fontSize });
        const cellDefinition = {
          ...(stack ? { stack } : { text: wrapLongTokens(inlineText(cell, typography), maxTokenCharacters) }),
          margin: cellMargin,
          fontSize,
          valign: 'top'
        };
        if (String(cell.localName || '').toLowerCase() === 'th') {
          cellDefinition.bold = true;
          cellDefinition.fillColor = '#eef2ef';
        }
        if (colSpan > 1) cellDefinition.colSpan = colSpan;
        if (rowSpan > 1) cellDefinition.rowSpan = rowSpan;
        output[start] = cellDefinition;
      }
      return output;
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
        body,
        // Long rows must remain splittable; otherwise a message-sized cell can vanish at a page boundary.
        dontBreakRows: false
      },
      layout: 'lightHorizontalLines',
      fontSize,
      margin: typography.margin(0, 5, 0, 9)
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
    const dataUrl = source.dataUrl;
    const start = dataUrl.indexOf(',') + 1;
    try {
      if (source.mimeType === 'image/png') {
        const header = root.atob(dataUrl.slice(start, start + 32));
        if (header.length < 24 || !header.startsWith('\x89PNG\r\n\x1a\n') || header.slice(12, 16) !== 'IHDR') return null;
        const uint32 = (offset) => (
          header.charCodeAt(offset) * 0x1000000 + (header.charCodeAt(offset + 1) << 16) +
          (header.charCodeAt(offset + 2) << 8) + header.charCodeAt(offset + 3)
        );
        return { width: uint32(16), height: uint32(20) };
      }
      if (source.mimeType !== 'image/jpeg') return null;
      const limit = Math.min(dataUrl.length - start, 350000);
      let decodedLength = Math.min(344, limit);
      let bytes = root.atob(dataUrl.slice(start, start + decodedLength));
      if (!bytes.startsWith('\xff\xd8')) return null;
      const contains = (end) => {
        if (end <= bytes.length) return true;
        const required = Math.ceil(end / 3) * 4;
        if (required > limit) return false;
        decodedLength = Math.min(limit, Math.max(required, decodedLength * 2));
        bytes = root.atob(dataUrl.slice(start, start + decodedLength));
        return end <= bytes.length;
      };
      const uint16 = (offset) => (bytes.charCodeAt(offset) << 8) | bytes.charCodeAt(offset + 1);
      let offset = 2;
      while (contains(offset + 2) && bytes.charCodeAt(offset) === 0xff) {
        while (contains(offset + 1) && bytes.charCodeAt(offset) === 0xff) offset += 1;
        const marker = bytes.charCodeAt(offset++);
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (marker === 0xd9 || marker === 0xda || !contains(offset + 2)) return null;
        const length = uint16(offset);
        if (length < 2) return null;
        if (JPEG_FRAME_MARKERS.has(marker)) {
          return length >= 7 && contains(offset + 7) ? { height: uint16(offset + 3), width: uint16(offset + 5) } : null;
        }
        offset += length;
      }
    } catch (_) { /* An invalid image is replaced with its alt text. */ }
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

  function imageDisplaySize(image, dimensions, maxWidth, maxHeight) {
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

  function getImageInfo(value, cache) {
    if (cache.has(value)) return cache.get(value);
    const source = dataUrlInfo(value, false);
    const info = source && { ...source, dimensions: imageDimensions(source) };
    cache.set(value, info);
    return info;
  }

  function renderImage(image, maxWidth, maxHeight, imageInfo, imageName, typography) {
    const source = imageInfo || null;
    const size = imageDisplaySize(image, source && source.dimensions, maxWidth, maxHeight);
    if (!size) return { ...imageFallback(image), margin: typography.margin(0, 3, 0, 7) };
    const width = image.classList.contains('ge-snapshot-image') && /^TeX:/.test(image.getAttribute('alt') || '')
      ? Math.min(maxWidth, maxHeight * size.width / size.height, size.width * typography.fontSize / 10)
      : size.width;
    return {
      image: imageName(source.dataUrl),
      width,
      maxHeight,
      alignment: 'center',
      margin: typography.margin(0, 5, 0, 9)
    };
  }

  function estimatedTextWidth(runs, baseFontSize) {
    let width = 0;
    for (const run of runs) {
      const text = typeof run === 'string' ? run : cleanText(run && run.text || '');
      if (text.includes('\n')) return Infinity;
      const fontSize = Number(run && typeof run === 'object' && run.fontSize) || baseFontSize;
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

  function inlineMathTable(parts, typography, style) {
    const cells = [];
    const widths = [];
    for (const part of parts) {
      if (part.type === 'text') {
        cells.push({ text: part.runs, ...(style ? { style } : {}), valign: 'middle' });
        widths.push('auto');
      } else {
        const { image, width, link } = part.definition;
        cells.push({ image, width, ...(link ? { link } : {}), alignment: 'center', margin: typography.margin(0, 2, 0, 0), valign: 'middle' });
        widths.push(part.definition.width);
      }
    }
    return {
      table: { widths, body: [cells] },
      layout: 'noBorders',
      margin: [0, 0, 0, 0]
    };
  }

  function wrapInlineMath(parts, maxWidth, typography, { style = 'paragraph', trailingMargin = true } = {}) {
    const lines = [];
    let row = [];
    let rowWidth = 0;
    const finishLine = () => {
      const cells = [];
      let previousSource;
      for (const token of row) {
        if (token.type === 'math') {
          cells.push(token);
          continue;
        }
        const lastCell = cells[cells.length - 1];
        const run = typeof token.source === 'string' ? token.text : { ...token.source, text: token.text };
        if (!lastCell || lastCell.type !== 'text') cells.push({ type: 'text', runs: [run] });
        else if (token.source === previousSource) {
          const index = lastCell.runs.length - 1;
          const previous = lastCell.runs[index];
          lastCell.runs[index] = typeof previous === 'string' ? previous + token.text : { ...previous, text: previous.text + token.text };
        } else lastCell.runs.push(run);
        previousSource = token.source;
      }
      if (cells.some((cell) => cell.type === 'math')) lines.push(inlineMathTable(cells, typography, style));
      else lines.push({ text: cells.length ? cells[0].runs : ' ', ...(style ? { style } : {}) });
      row = [];
      rowWidth = 0;
    };
    // pdfmake's noBorders layout leaves horizontal padding between cells.
    const cellGap = (last, next) => last && (last.type !== 'text' || next.type !== 'text') ? 8 : 0;
    const place = (token) => {
      if (row.length && rowWidth + token.width + cellGap(row[row.length - 1], token) > maxWidth - 8) {
        let carry = [];
        if (token.type === 'math') {
          let index = row.length - 1;
          while (index >= 0 && row[index].type === 'text' && /^\s+$/.test(row[index].text)) index -= 1;
          if (index > 0 && row[index].type === 'text') {
            const nearbyWidth = row.slice(index).reduce((width, item) => width + item.width, 0);
            if (nearbyWidth + token.width + 8 <= maxWidth - 8) carry = row.splice(index);
          }
        }
        finishLine();
        row = carry;
        rowWidth = carry.reduce((width, item) => width + item.width, 0);
      }
      rowWidth += token.width + cellGap(row[row.length - 1], token);
      row.push(token);
    };
    for (const part of parts) {
      if (part.type === 'math') {
        place({ ...part, width: part.definition.width });
        continue;
      }
      for (const run of part.runs) {
        const value = typeof run === 'string' ? run : run.text;
        const tokens = value.match(/\n|[^\S\n]+|[\u2e80-\uffff]|[^\s\u2e80-\uffff]+/gu) || [];
        for (const token of tokens) {
          if (token === '\n') {
            finishLine();
            continue;
          }
          const textToken = (text) => ({
            type: 'text', text, source: run,
            width: estimatedTextWidth([typeof run === 'string' ? text : { ...run, text }], typography.fontSize)
          });
          const entry = textToken(token);
          if (entry.width <= maxWidth - 16) place(entry);
          else {
            for (const character of token) place(textToken(character));
          }
        }
      }
    }
    if (row.length) finishLine();
    if (lines.length && trailingMargin) lines[lines.length - 1].margin = typography.margin(0, 0, 0, 7);
    return lines;
  }

  function paragraphBlocks(paragraph, maxWidth, maxHeight, imageInfo, imageName, typography, renderPhoto) {
    const output = [];
    let runs = [];
    let inlineParts = [];
    const naturalInlineMathHeight = 1.8 * 10 * 1.3;
    const inlineMathMaxHeight = naturalInlineMathHeight * typography.fontSize / 10;
    const flushRuns = () => {
      if (runs.length) inlineParts.push({ type: 'text', runs });
      runs = [];
    };
    const flushInlineParts = () => {
      if (!inlineParts.length) return;
      const mathParts = inlineParts.filter((part) => part.type === 'math');
      const textParts = inlineParts.filter((part) => part.type === 'text');
      const hasNeighboringText = textParts.some((part) => part.runs.some((run) => String(typeof run === 'string' ? run : run.text || '').trim()));
      if (mathParts.length && hasNeighboringText) {
        output.push(...wrapInlineMath(inlineParts, maxWidth, typography));
      } else {
        let textRuns = [];
        const flushText = () => {
          if (textRuns.length) output.push({ text: wrapLongTokens(textRuns, Math.max(10, Math.floor(maxWidth / (typography.fontSize * 1.15)))), style: 'paragraph', margin: typography.margin(0, 0, 0, 7) });
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
        const source = imageInfo(node.getAttribute('src'));
        const size = imageDisplaySize(node, source && source.dimensions, maxWidth, maxHeight);
        const explicitlyInline = node.classList.contains('ge-inline-math');
        const legacyInline = !node.classList.contains('ge-snapshot-image');
        const isInlineMath = /^TeX:/.test(cleanText(node.getAttribute('alt') || '')) && size &&
          ((legacyInline && size.height <= naturalInlineMathHeight) ||
            (explicitlyInline && size.height <= naturalInlineMathHeight * 2));
        if (isInlineMath) {
          const definition = renderImage(node, maxWidth, maxHeight, source, imageName, typography);
          definition.width = Math.min(size.width * typography.fontSize / 10, size.width * inlineMathMaxHeight / size.height, maxWidth - 16);
          inlineParts.push({ type: 'math', definition });
        } else {
          flushInlineParts();
          output.push(renderPhoto?.(node, source) || renderImage(node, maxWidth, maxHeight, source, imageName, typography));
        }
        return;
      }
      if (tag === 'br') {
        runs.push({ text: '\n', ...style });
        return;
      }
      const childStyle = inlineStyleFor(tag, style, node, typography.fontSize);
      for (const child of Array.from(node.childNodes || [])) visit(child, childStyle);
    };
    for (const child of Array.from(paragraph.childNodes || [])) visit(child, {});
    flushRuns();
    flushInlineParts();
    return output;
  }

  function buildPdfDefinition(options, imageCache = new Map(), useImageDictionary = false) {
    const settings = options || {};
    const conversation = settings.conversation && typeof settings.conversation === 'object' ? settings.conversation : {};
    const selectedMessages = Array.isArray(settings.messages) ? settings.messages : (Array.isArray(conversation.messages) ? conversation.messages : []);
    if (!selectedMessages.length) throw new TypeError('请至少选择一条消息后再生成 PDF。');
    const selectedIds = new Set(selectedMessages.map((message) => message && message.id != null ? String(message.id) : '').filter(Boolean));
    const conversationOnly = settings.conversationOnly === true;
    let container = settings.container;
    if (!container || container.nodeType !== 1) throw new TypeError('PDF 内容容器无效或尚未完成渲染。');
    if (conversationOnly && container.querySelector(CONVERSATION_CHROME)) {
      container = container.cloneNode(true);
      container.querySelectorAll(CONVERSATION_CHROME).forEach((node) => node.remove());
    }

    const requestedPageSize = settings.pageSize == null ? 'A4' : String(settings.pageSize).toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(PAGE_WIDTH, requestedPageSize)) throw new TypeError('PDF 纸张规格仅支持 A4 或 LETTER。');
    const orientation = settings.orientation == null ? 'portrait' : String(settings.orientation).toLowerCase();
    if (orientation !== 'portrait' && orientation !== 'landscape') throw new TypeError('PDF 页面方向仅支持 portrait 或 landscape。');
    const includeMetadata = !conversationOnly && settings.includeMetadata !== false;
    const modernLayout = conversationOnly || settings.fontSize != null || settings.density != null;
    const fontSize = Number.isInteger(settings.fontSize) && settings.fontSize >= 8 && settings.fontSize <= 13
      ? settings.fontSize : modernLayout ? 9 : 10;
    const density = Object.prototype.hasOwnProperty.call(PDF_DENSITIES, settings.density)
      ? PDF_DENSITIES[settings.density] : PDF_DENSITIES[modernLayout ? 'compact' : 'standard'];
    const typography = {
      fontSize,
      margin: (left, top, right, bottom) => [left, top * density.spacing, right, bottom * density.spacing]
    };
    const margin = typography.margin;
    const [left, top, right, bottom] = density.margins;
    const width = pageWidth(requestedPageSize, orientation) - left - right;
    const contentHeight = (orientation === 'landscape' ? PAGE_WIDTH[requestedPageSize] : PAGE_HEIGHT[requestedPageSize]) - top - bottom;
    const maxHeight = contentHeight - 80;
    // Set the size in points, keeping the encoded raster at its available resolution.
    const photoPairPadding = 46 + 2 * (5 + 9) * density.spacing;
    const photoHeight = Math.min(maxHeight, Math.floor((contentHeight - photoPairPadding) / 2));
    const images = {};
    const imageNames = new Map();
    const imageInfo = (value) => getImageInfo(value, imageCache);
    const imageName = (dataUrl) => {
      if (!useImageDictionary) return dataUrl;
      if (imageNames.has(dataUrl)) return imageNames.get(dataUrl);
      const name = `gpt_exporter_image_${imageNames.size + 1}`;
      imageNames.set(dataUrl, name);
      images[name] = dataUrl;
      return name;
    };
    const userPhotos = new WeakSet();
    const renderUserPhoto = (node, source) => {
      if (node.classList.contains('ge-snapshot-image') || /^TeX:/.test(node.getAttribute('alt') || '')) return null;
      const photo = renderImage(node, width, photoHeight, source, imageName, typography);
      if (photo.image) userPhotos.add(photo);
      return photo;
    };
    const photoRenderer = (context) => context.messageRole === 'user' ? renderUserPhoto : undefined;
    const keepPhotoPairs = (blocks) => {
      const paired = [];
      for (let index = 0; index < blocks.length; index++) {
        const first = blocks[index];
        if (userPhotos.has(first)) {
          let next = index + 1;
          // Markdown soft line breaks can sit between consecutive image parts.
          while (next < blocks.length && blocks[next].style === 'paragraph' &&
                 (Array.isArray(blocks[next].text) ? blocks[next].text : [blocks[next].text])
                   .every(run => !(typeof run === 'string' ? run : run?.text || '').trim())) next++;
          if (next < blocks.length && userPhotos.has(blocks[next])) {
            const stack = [first, blocks[next]];
            if (index === 1 && blocks[0].columns) stack.unshift(paired.pop());
            paired.push({ stack, unbreakable: true });
            index = next;
            continue;
          }
        }
        paired.push(first);
      }
      return paired;
    };
    const content = [];
    let renderedArticleCount = 0;
    const articleElements = Array.from(container.querySelectorAll ? container.querySelectorAll('article') : []);
    const articleIds = new Set(articleElements.map((article) => article.getAttribute('data-message-id')).filter(Boolean));
    const userIds = new Set(selectedMessages.filter((message) => message?.role === 'user').map((message) => String(message.id)));
    for (const article of articleElements) {
      const id = article.getAttribute('data-message-id');
      if (selectedIds.has(id) && article.getAttribute('data-role') === 'user') userIds.add(id);
    }
    const attachments = collectAttachments(conversation, conversationOnly ? userIds : selectedIds);
    const hasTaggedArticles = articleIds.size > 0;
    let previousArticleRole = '';

    const roleAvatar = (role, repeated) => {
      const scale = (repeated ? 0.78 : 1) * (density === PDF_DENSITIES.compact ? 0.75 : 1);
      const size = 22 * scale;
      const center = size / 2;
      const radius = size / 2 - scale;
      const isUser = role === 'user';
      const background = isUser ? '#617b8a' : role === 'assistant' ? '#4e7865' : '#66736c';
      const canvas = [{ type: 'ellipse', x: center, y: center, r1: radius, r2: radius, color: background }];
      if (isUser) {
        canvas.push(
          { type: 'ellipse', x: center, y: center + 3.2 * scale, r1: 5.1 * scale, r2: 3.9 * scale, color: '#ffffff' },
          { type: 'ellipse', x: center, y: center - 3.1 * scale, r1: 2.5 * scale, r2: 2.5 * scale, color: '#ffffff' }
        );
      } else {
        canvas.push(
          { type: 'line', x1: center, y1: center - 4.2 * scale, x2: center, y2: center - 6.3 * scale, lineColor: '#ffffff', lineWidth: 1.2 * scale },
          { type: 'ellipse', x: center, y: center - 7 * scale, r1: 1.1 * scale, r2: 1.1 * scale, color: '#ffffff' },
          { type: 'rect', x: center - 5.2 * scale, y: center - 4.1 * scale, w: 10.4 * scale, h: 8 * scale, r: 2 * scale, color: '#ffffff' },
          { type: 'ellipse', x: center - 2.3 * scale, y: center - 0.7 * scale, r1: 0.8 * scale, r2: 0.8 * scale, color: background },
          { type: 'ellipse', x: center + 2.3 * scale, y: center - 0.7 * scale, r1: 0.8 * scale, r2: 0.8 * scale, color: background },
          { type: 'line', x1: center - 2 * scale, y1: center + 1.8 * scale, x2: center + 2 * scale, y2: center + 1.8 * scale, lineColor: background, lineWidth: 1 * scale }
        );
      }
      return { width: size, canvas };
    };

    const alignPdfBlock = (block, alignment) => {
      if (!block || typeof block !== 'object') return block;
      if (Array.isArray(block)) return block.map((item) => alignPdfBlock(item, alignment));
      const aligned = Object.assign({}, block);
      if (Object.prototype.hasOwnProperty.call(aligned, 'text') || Object.prototype.hasOwnProperty.call(aligned, 'image')) {
        aligned.alignment = alignment;
      }
      if (aligned.table) {
        aligned.table = Object.assign({}, aligned.table, {
          body: aligned.table.body.map((row) => row.map((cell) => alignPdfBlock(cell, alignment)))
        });
      }
      for (const key of ['stack', 'ul', 'ol']) {
        if (!Array.isArray(aligned[key])) continue;
        aligned[key] = aligned[key].map((item) => {
          if (item && typeof item === 'object' && Array.isArray(item.stack)) {
            return Object.assign({}, item, { stack: item.stack.map((child) => alignPdfBlock(child, alignment)) });
          }
          return alignPdfBlock(item, alignment);
        });
      }
      return aligned;
    };

    const renderBlock = (node, context) => {
      if (!node) return [];
      if (node.nodeType === 3) {
        const value = cleanText(node.nodeValue || '').trim();
        return value ? [{ text: value, style: 'paragraph', margin: margin(0, 0, 0, 5) }] : [];
      }
      if (node.nodeType !== 1) return [];
      const tag = String(node.localName || '').toLowerCase();
      if (DANGEROUS_TAGS.has(tag)) return [];
      if (tag === 'svg' || tag === 'math' || tag === 'canvas' || tag === 'video' || tag === 'audio') {
        const label = tag === 'math' ? textOf(node) : '';
        return [{ text: label ? `[未转换的公式：${label}]` : `[未转换的${tag === 'svg' ? '矢量图' : tag === 'math' ? '公式' : tag === 'canvas' ? '画布图像' : '媒体'}]`, style: 'resourceFallback', margin: [0, 3, 0, 7] }];
      }
      if (tag === 'img') {
        const source = imageInfo(node.getAttribute('src'));
        return [photoRenderer(context)?.(node, source) || renderImage(node, width, maxHeight, source, imageName, typography)];
      }

      if (tag === 'header') {
        if (!includeMetadata && !conversationOnly) return [];
        return renderFlowChildren(node, context);
      }
      if (tag === 'article') {
        const id = node.getAttribute('data-message-id');
        if (id && !selectedIds.has(id)) return [];
        if (hasTaggedArticles && !id) return [];
        renderedArticleCount += 1;
        const heading = Array.from(node.children || []).find((child) => String(child.localName || '').toLowerCase() === 'h2') || null;
        const headingRole = textOf(heading).trim().toLowerCase();
        const messageRole = String(node.getAttribute('data-role') || headingRole).trim().toLowerCase();
        const repeatedRole = Boolean(messageRole && previousArticleRole === messageRole);
        if (messageRole) previousArticleRole = messageRole;
        let blocks = renderFlowChildren(node, Object.assign({}, context, {
          articleHeading: heading,
          messageRole,
          repeatedRole
        }));
        const linkedAssets = attachments.byMessage.get(id || '');
        if (!conversationOnly) blocks.push(...attachmentContent(linkedAssets));
        if (messageRole === 'user') blocks = keepPhotoPairs(blocks).map((block) => alignPdfBlock(block, 'right'));
        return blocks;
      }
      if (/^h[1-6]$/.test(tag)) {
        if (tag === 'h2' && context.articleHeading === node) {
          const roleText = inlineText(node);
          const role = context.messageRole;
          const style = context.repeatedRole ? 'roleHeaderContinuation' : role === 'user' ? 'roleHeaderUser' : role === 'assistant' ? 'roleHeaderAssistant' : 'roleHeader';
          const avatar = roleAvatar(role, context.repeatedRole);
          const avatarColumn = Object.assign({ width: avatar.width }, avatar);
          const textColumn = {
            width: '*',
            text: Array.isArray(roleText) ? roleText : [{ text: String(roleText || '') }],
            style,
            alignment: role === 'user' ? 'right' : 'left'
          };
          return [{
            columns: role === 'user' ? [textColumn, avatarColumn] : [avatarColumn, textColumn],
            columnGap: 5,
            margin: context.repeatedRole ? margin(0, 3, 0, 2) : margin(0, 6, 0, 4)
          }];
        }
        const level = Number(tag.slice(1));
        const isDocumentTitle = tag === 'h1' && String(node.parentElement && node.parentElement.localName || '').toLowerCase() === 'header';
        const style = isDocumentTitle ? 'documentTitle' : `heading${level}`;
        const headingFontSize = fontSize + (isDocumentTitle ? 10 : [8, 5, 3, 2, 1, 0][level - 1]);
        const stack = semanticMathStack(node, width, typography, imageInfo, imageName, { fontSize: headingFontSize, style });
        return [{ ...(stack ? { stack } : { text: inlineText(node, typography), style }), margin: margin(0, level === 1 ? 3 : 9, 0, level === 1 ? 9 : 4) }];
      }
      if (tag === 'p') {
        return paragraphBlocks(node, width, maxHeight, imageInfo, imageName, typography, photoRenderer(context));
      }
      if (tag === 'pre') {
        const source = node.querySelector && node.querySelector('code') ? node.querySelector('code') : node;
        const code = breakLongCodeLines(textOf(source));
        return code ? [{ text: code, style: 'codeBlock', margin: margin(12, 4, 0, 9), preserveLeadingSpaces: true }] : [];
      }
      if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(node.children || []).filter((child) => String(child.localName || '').toLowerCase() === 'li');
        if (!items.length) return [];
        const list = { [tag]: [], margin: margin(context.listDepth * 12, 3, 0, 7) };
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
          const itemDefinition = { stack: renderListItem(item, context) };
            itemDefinition.counter = counter;
            list.ol.push(itemDefinition);
            counter += reversed ? -1 : 1;
          }
        } else {
        for (const item of items) list.ul.push({ stack: renderListItem(item, context) });
        }
        return [list];
      }
      if (tag === 'table') {
        const table = buildTable(node, width, typography, imageInfo, imageName);
        return table ? [table] : [{ text: '[表格没有可导出的行]', style: 'resourceFallback' }];
      }
      if (tag === 'blockquote') {
        const blocks = renderFlowChildren(node, context);
        return blocks.map((block) => {
          if (typeof block === 'string') return { text: block, style: 'quote', margin: margin(16, 2, 0, 4) };
          if (block && block.text) return Object.assign({}, block, { color: '#56665e', italics: true, margin: margin(16, 2, 0, 5) });
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
          output.push(...paragraphBlocks(wrapper, width, maxHeight, imageInfo, imageName, typography, photoRenderer(context)));
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

    const renderListItem = (item, context) => {
      const blocks = renderFlowChildren(item, { ...context, listDepth: context.listDepth + 1 });
      return blocks.length ? blocks : [{ text: ' ', style: 'paragraph' }];
    };

    if (includeMetadata && !container.querySelector('header')) {
      content.push(...makeMetadata(conversation));
    }
    content.push(...renderFlowChildren(container, { listDepth: 0 }));

    if (!conversationOnly && !renderedArticleCount && !articleElements.length) {
      const fallbackText = textOf(container).trim();
      if (fallbackText) content.push({ text: fallbackText, style: 'paragraph' });
    }
    for (const [messageId, items] of attachments.byMessage) {
      if (!conversationOnly && selectedIds.has(messageId) && !articleIds.has(messageId)) content.push(...attachmentContent(items));
    }
    if (!content.length || (!renderedArticleCount && !textOf(container).trim() && !Object.keys(attachments.files).length)) {
      throw new TypeError('PDF 内容为空。请确认所选消息已完成渲染后重试。');
    }

    const definition = {
      pageSize: requestedPageSize,
      pageOrientation: orientation,
      pageMargins: density.margins.slice(),
      info: {
        title: cleanText((!conversationOnly && conversation.title) || 'AI Conversation Export'),
        subject: 'Conversation export',
        creator: 'GptExporter'
      },
      defaultStyle: { font: FONT_FAMILY, fontSize, color: '#27312d', lineHeight: density.lineHeight },
      styles: {
        documentTitle: { fontSize: fontSize + 10, bold: true, color: '#263c33', margin: margin(0, 0, 0, 7) },
        paragraph: { fontSize, lineHeight: density.paragraphLineHeight },
        roleHeaderUser: { fontSize: 8, bold: true, color: '#617b8a', characterSpacing: 0.3 },
        roleHeaderAssistant: { fontSize: 8, bold: true, color: '#4e7865', characterSpacing: 0.3 },
        roleHeader: { fontSize: 8, bold: true, color: '#66736c', characterSpacing: 0.3 },
        roleHeaderContinuation: { fontSize: 7.5, bold: true, color: '#87958d' },
        heading1: { fontSize: fontSize + 8, bold: true, color: '#263c33' },
        heading2: { fontSize: fontSize + 5, bold: true, color: '#30493e' },
        heading3: { fontSize: fontSize + 3, bold: true, color: '#3d594d' },
        heading4: { fontSize: fontSize + 2, bold: true },
        heading5: { fontSize: fontSize + 1, bold: true },
        heading6: { fontSize, bold: true },
        codeBlock: { font: FONT_FAMILY, fontSize: fontSize - 1.5, color: '#39423e', fillColor: '#f2f4f1', lineHeight: density.codeLineHeight },
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
        margin: margin(0, 12, 0, 0)
      })
    };
    if (imageNames.size) definition.images = images;
    if (Object.keys(attachments.files).length) definition.files = attachments.files;
    return definition;
  }

  function rasterNeedsResize(width, height) {
    return Math.max(width, height) > MAX_RASTER_EDGE || width * height > MAX_RASTER_PIXELS;
  }

  function hasRasterEnd(source) {
    try {
      const payloadStart = source.dataUrl.indexOf(',') + 1;
      if (source.mimeType === 'image/png') {
        return root.atob(source.dataUrl.slice(Math.max(payloadStart, source.dataUrl.length - 32))).includes('\0\0\0\0IEND\xaeB`\x82');
      }
      const tail = root.atob(source.dataUrl.slice(Math.max(payloadStart, source.dataUrl.length - 128)));
      return tail.includes('\xff\xd9');
    } catch (_) { return false; }
  }

  function rasterizePdfImage(source) {
    if (!root.Image || !root.document || !root.document.createElement) return Promise.resolve(null);
    return new Promise((resolve) => {
      let image;
      try { image = new root.Image(); } catch (_) { resolve(null); return; }
      const timeout = root.setTimeout(() => finish(null), 10000);
      function finish(result) {
        root.clearTimeout(timeout);
        image.onload = null;
        image.onerror = null;
        image.removeAttribute('src');
        resolve(result);
      }
      image.onload = () => {
        let canvas;
        try {
          const width = image.naturalWidth;
          const height = image.naturalHeight;
          if (!width || !height || width * height > MAX_SOURCE_PIXELS) { finish(null); return; }
          const scale = Math.min(1, MAX_RASTER_EDGE / Math.max(width, height), Math.sqrt(MAX_RASTER_PIXELS / (width * height)));
          canvas = root.document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(width * scale));
          canvas.height = Math.max(1, Math.floor(height * scale));
          const context = canvas.getContext('2d');
          if (!context) { finish(null); return; }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const mimeType = source.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
          const output = canvas.toDataURL(mimeType, 0.88);
          finish(output.startsWith(`data:${mimeType};base64,`) ? output : null);
        } catch (_) { finish(null); }
        finally { if (canvas) { canvas.width = 0; canvas.height = 0; } }
      };
      image.onerror = () => finish(null);
      try { image.src = source.dataUrl; }
      catch (_) { finish(null); }
    });
  }

  async function normalizeImages(container, imageCache) {
    const images = Array.from(container.querySelectorAll ? container.querySelectorAll('img') : []);
    const conversions = new Map();
    for (const image of images) {
      const source = getImageInfo(image.getAttribute('src'), imageCache);
      if (!source) continue;
      const dimensions = source.dimensions;
      if (dimensions && (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > MAX_SOURCE_PIXELS)) {
        image.removeAttribute('src');
        continue;
      }
      if (dimensions && !rasterNeedsResize(dimensions.width, dimensions.height) && hasRasterEnd(source)) continue;
      if (!conversions.has(source.dataUrl)) conversions.set(source.dataUrl, await rasterizePdfImage(source));
      const output = conversions.get(source.dataUrl);
      if (output) image.setAttribute('src', output);
      else image.removeAttribute('src');
    }
    for (const original of conversions.keys()) imageCache.delete(original);
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
      const vfs = Object.assign({}, pdfMake.vfs || {});
      if (typeof pdfMake.addVirtualFileSystem === 'function') {
        // pdfmake passes the data to Buffer, which copies typed arrays without decoding them.
        vfs[FONT_FILE] = { data: bytes, encoding: 'base64' };
        pdfMake.addVirtualFileSystem(vfs);
      } else {
        if (typeof root.btoa !== 'function') throw new Error('当前环境无法将本地 PDF 字体注册到虚拟文件系统。');
        vfs[FONT_FILE] = bytesToBase64(bytes);
        pdfMake.vfs = vfs;
      }
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

  async function getPdfMake() {
    let pdfMake = root.GptExporterVendors?.pdfMake;
    if (!pdfMake || typeof pdfMake.createPdf !== 'function') {
      await api.loadVendor?.('pdf');
      pdfMake = root.GptExporterVendors?.pdfMake;
    }
    if (!pdfMake || typeof pdfMake.createPdf !== 'function') throw new Error('本地 PDF 生成组件不可用，请重新加载扩展后重试。');
    return pdfMake;
  }

  async function preparePdf() {
    await ensureFont(await getPdfMake());
  }

  async function buildPdf(options) {
    const pdfMake = await getPdfMake();
    const settings = Object.assign({ fontSize: 9, density: 'compact' }, options || {});
    const imageCache = new Map();
    if (settings.container && typeof settings.container.cloneNode === 'function') {
      if (settings.consumeContainer !== true) settings.container = settings.container.cloneNode(true);
      await normalizeImages(settings.container, imageCache);
    }
    const definition = buildPdfDefinition(settings, imageCache, true);
    imageCache.clear();
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

  api.pdfDefinition = (options) => buildPdfDefinition(options);
  api.preparePdf = preparePdf;
  api.buildPdf = buildPdf;
})(globalThis);
