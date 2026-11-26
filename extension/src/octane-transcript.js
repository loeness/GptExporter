(function attachGptExporterOctaneTranscript(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const SELECTOR = 'script#octane-conversation-transcript[type="application/json"]';
  const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
  const MAX_ROWS = 10000;
  const MAX_MARKDOWN = 512 * 1024;
  const MAX_DIL_CODE = 256 * 1024;
  const MAX_DIL_DATA = 512 * 1024;

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function boundedText(value, maximum) {
    return typeof value === 'string' && value.length <= maximum && value.trim() ? value : '';
  }

  function boundedRecord(value) {
    if (!isRecord(value)) return false;
    try {
      return JSON.stringify(value).length <= MAX_DIL_DATA;
    } catch {
      return false;
    }
  }

  function readDil(source) {
    if (!isRecord(source) || source.kind !== 'dil' || source.renderer !== 'dil-v2') return null;
    const code = boundedText(source.code, MAX_DIL_CODE);
    if (!code || !boundedRecord(source.constants)) return null;

    const dil = { code, constants: source.constants };
    if (boundedRecord(source.viewState?.root)) dil.viewState = { root: source.viewState.root };
    return dil;
  }

  function readOctaneTranscript(document, { shareId } = {}) {
    const content = document?.querySelector(SELECTOR)?.textContent;
    if (!content || content.length > MAX_TRANSCRIPT_BYTES) return [];
    if (content.length * 3 > MAX_TRANSCRIPT_BYTES && new Blob([content]).size > MAX_TRANSCRIPT_BYTES) return [];

    let transcript;
    try {
      transcript = JSON.parse(content);
    } catch {
      return [];
    }
    if (!Array.isArray(transcript?.rows) || transcript.rows.length > MAX_ROWS) return [];

    const messages = [];
    const seen = new Set();
    for (const row of transcript.rows) {
      if (!isRecord(row) || row.origin !== 'server' || !isRecord(row.frame)) continue;
      const { id, role, text } = row.frame;
      if (!boundedText(id, 128) || row.key !== id || seen.has(id)) continue;
      if (role !== 'user' && role !== 'assistant') continue;

      const source = row.source;
      if (source != null && (!isRecord(source) || source.messageId !== id)) continue;
      if (shareId && source && Object.hasOwn(source, 'publicShareId') && source.publicShareId !== shareId) continue;

      const dil = role === 'assistant' ? readDil(source?.dil) : null;
      const markdown = (role === 'assistant' && (
        boundedText(source?.markdown, MAX_MARKDOWN)
        || boundedText(source?.dil?.fallbackMarkdown, MAX_MARKDOWN)
      )) || boundedText(text, MAX_MARKDOWN);
      if (!markdown && !dil) continue;

      const message = { id, role, markdown };
      if (dil) message.dil = dil;
      messages.push(message);
      seen.add(id);
    }
    return messages;
  }

  api.readOctaneTranscript = readOctaneTranscript;
})(typeof globalThis === 'object' ? globalThis : this);
