((root) => {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const SELECTION_UNAVAILABLE = /^(?:Current selection unavailable[.]?|当前(?:选择|选项)不可用[。.]?)$/i;
  const ROW_TYPES = new Set(['row', 'table-row']);
  const MAX_ADDED_CHARS = 48000;

  function markdownLiteral(value) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\uE200-\uE2FF]/g, ' ')
      .replace(/\s+/g, ' ').trim()
      .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_\x60{|}~]/g, character =>
        '()[]\\\x60$|&<>'.includes(character) ? '&#' + character.charCodeAt(0) + ';' : '\\' + character);
  }

  function inlineText(node) {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    return (node.children || []).map(inlineText).join('');
  }

  function cellText(node) {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    const children = node.children || [];
    if (node.type === 'box' && children.length > 1) return children.map(inlineText).join(' ');
    return inlineText(node);
  }

  function hasNestedRows(node) {
    if (!node || typeof node !== 'object') return false;
    return ROW_TYPES.has(node.type) || node.type === 'table' || (node.children || []).some(hasNestedRows);
  }

  function isFlatRow(node) {
    return node && ROW_TYPES.has(node.type) && node.children.length >= 2 &&
      node.children.length <= 12 && !node.children.some(hasNestedRows);
  }

  function tableMarkdown(rows) {
    const width = Math.max(...rows.map(row => row.children.length));
    const headerRow = rows.findIndex(row => row.children.every(cell => cell?.props?.header === true)) === 0;
    const rowLine = cells => '| ' + Array.from({length: width}, (_, index) => cells[index] || '').join(' | ') + ' |';
    const lines = rows.map(row => rowLine(row.children.map(cell => markdownLiteral(cellText(cell)))));
    const headers = headerRow ? lines.shift() : rowLine([]);
    return [headers, rowLine(Array(width).fill('---')), ...lines].join('\n');
  }

  function renderBlocks(nodes) {
    const blocks = [];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (isFlatRow(node)) {
        const rows = [node];
        while (isFlatRow(nodes[index + 1])) rows.push(nodes[++index]);
        blocks.push(tableMarkdown(rows));
      } else if (node?.type === 'divider') {
        continue;
      } else if (['card', 'box', 'column', 'stack', 'table', 'row', 'table-row', 'list'].includes(node?.type)) {
        blocks.push(...renderBlocks(node.children));
      } else {
        const text = markdownLiteral(inlineText(node));
        if (text) blocks.push(node?.type === 'list-item' ? '- ' + text : text);
      }
    }
    return blocks;
  }

  function comparisonMarkdown(comparison) {
    const states = comparison.options.map(option => ({
      label: markdownLiteral(option.label), blocks: renderBlocks(option.nodes)
    }));
    if (states.some(state => !state.label || !state.blocks.length)) return '';
    return states.map(state => ['#### ' + state.label, ...state.blocks].join('\n\n')).join('\n\n');
  }

  function insertComparison(markdown, labels, comparison) {
    const lines = markdown.split('\n');
    let fence = null;
    for (let index = 0; index < lines.length; index++) {
      const marker = lines[index].match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        continue;
      }
      if (fence || !SELECTION_UNAVAILABLE.test(lines[index].trim())) continue;
      let start = index;
      let matched = true;
      for (let option = labels.length - 1; option >= 0; option--) {
        do { start--; } while (start >= 0 && !lines[start].trim());
        const bullet = (lines[start] || '').match(/^\s*[-*+]\s+(.+)$/);
        if (bullet?.[1].trim().replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g, '$1') !== labels[option]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        lines.splice(start, index - start + 1, '', comparison, '');
        return lines.join('\n');
      }
    }
    return [markdown, comparison].filter(Boolean).join('\n\n');
  }

  api.renderDilComparisons = function renderDilComparisons(markdown, dil) {
    if (!dil || typeof api.extractDilComparisons !== 'function') return markdown;
    let added = 0;
    for (const comparison of api.extractDilComparisons(dil)) {
      const expansion = comparisonMarkdown(comparison);
      if (!expansion || added + expansion.length > MAX_ADDED_CHARS) continue;
      markdown = insertComparison(markdown, comparison.options.map(option => option.label), expansion);
      added += expansion.length;
    }
    return markdown;
  };
})(globalThis);
