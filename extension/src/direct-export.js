(function startDirectExport(root) {
  'use strict';

  const SESSION_ID = /^[\w-]{1,100}$/;
  const FORMATS = new Set(['pdf', 'markdown', 'html', 'text', 'json', 'csv']);
  const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
  const CONTENT_FORMATS = new Set(['pdf', 'html']);
  const content = root.document.getElementById('preview-content');
  let activeExport = null;

  function safeError(error) {
    const message = error && typeof error.message === 'string' ? error.message : '直接导出失败。';
    return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) || '直接导出失败。';
  }

  function validSourceUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && !url.username && !url.password &&
        ['chatgpt.com', 'chat.openai.com'].includes(url.hostname);
    } catch (_) {
      return false;
    }
  }

  function validateModel(model) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) throw new TypeError('对话数据格式无效。');
    if (![1, 2].includes(model.schemaVersion)) throw new TypeError('对话数据版本不受支持。');
    if (typeof model.title !== 'string' || typeof model.exportedAt !== 'string' || !validSourceUrl(model.url)) {
      throw new TypeError('对话标题或来源信息无效。');
    }
    if (!Array.isArray(model.messages) || model.messages.length === 0) throw new TypeError('这份对话没有可导出的已加载消息。');
    const ids = new Set();
    for (const message of model.messages) {
      if (!message || typeof message !== 'object' || !VALID_ROLES.has(message.role) ||
          typeof message.id !== 'string' || !message.id || ids.has(message.id) ||
          ['markdown', 'text', 'html'].some((field) => typeof message[field] !== 'string')) {
        throw new TypeError('消息数据不完整或格式无效。');
      }
      ids.add(message.id);
    }
    if (model.warnings != null && (!Array.isArray(model.warnings) || model.warnings.some((warning) => typeof warning !== 'string'))) {
      throw new TypeError('对话提示信息格式无效。');
    }
  }

  function safeBaseName(title) {
    return String(title || '对话导出')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || '对话导出';
  }

  function matchingAssets(model) {
    if (!Array.isArray(model.assets)) return [];
    const messageIds = new Set(model.messages.map((message) => message.id));
    const referencedIds = new Set(model.messages.flatMap((message) => Array.isArray(message.assetIds) ? message.assetIds : []));
    return model.assets.filter((asset) => asset &&
      (messageIds.has(asset.messageId) || referencedIds.has(asset.id)));
  }

  function assertCurrent(context) {
    if (context.released || activeExport !== context) throw new Error('导出记录已释放。');
  }

  async function reportPhase(context, phase) {
    await root.chrome.runtime.sendMessage({type:'GPT_EXPORTER_DIRECT_PROGRESS',exportId:context.exportId,phase}).catch(() => {});
    assertCurrent(context);
  }

  async function renderRichStage(context, model) {
    const api = root.GptExporter;
    if (!api || typeof api.renderHtmlFragment !== 'function' || typeof api.enhanceRichContent !== 'function' ||
        typeof api.snapshotRichContent !== 'function') {
      throw new Error('本地富内容导出组件不可用，请重新加载扩展后重试。');
    }

    const stage = root.document.createElement('div');
    stage.innerHTML = api.renderHtmlFragment(model, {includeMetadata: true, messages: model.messages});
    content.replaceChildren(stage);
    context.model = model;
    context.stage = stage;

    await reportPhase(context,'render');
    await api.enhanceRichContent(stage, model);
    assertCurrent(context);
    await reportPhase(context,'snapshot');
    return api.snapshotRichContent(content);
  }

  async function renderExport(context, format) {
    const api = root.GptExporter;
    if (!api || typeof api.serialize !== 'function') throw new Error('本地导出组件不可用，请重新加载扩展后重试。');
    const model = context.model;
    const messages = model.messages;
    let result;

    if (CONTENT_FORMATS.has(format)) {
      const assets = matchingAssets(model);
      model.assets = assets;
      await reportPhase(context,'assets');
      if (assets.length && typeof api.loadConversationAssets === 'function') await api.loadConversationAssets(model);
      assertCurrent(context);
      const snapshot = await renderRichStage(context, model);
      assertCurrent(context);
      if (!snapshot || typeof snapshot.cloneNode !== 'function') throw new Error('富内容快照生成失败。');
      if (format === 'pdf') {
        if (typeof api.buildPdf !== 'function') throw new Error('本地 PDF 生成组件不可用，请重新加载扩展后重试。');
        await reportPhase(context,'pdf');
        const bytes = await api.buildPdf({
          container: snapshot,
          conversation: model,
          messages,
          includeMetadata: true,
          pageSize: 'A4',
          orientation: 'portrait'
        });
        assertCurrent(context);
        result = {content: bytes, mime: 'application/pdf', extension: 'pdf'};
      } else {
        result = api.serialize(model, {
          format,
          includeMetadata: true,
          messages,
          renderedHtml: snapshot.innerHTML
        });
      }
    } else {
      result = api.serialize(model, {format, includeMetadata: true, messages});
    }

    assertCurrent(context);
    if (!result || typeof result.mime !== 'string' || typeof result.extension !== 'string' || result.content == null) {
      throw new Error('导出组件返回了无效文件。');
    }
    const blob = new root.Blob([result.content], {type: result.mime});
    context.url = root.URL.createObjectURL(blob);
    return {
      ok: true,
      url: context.url,
      filename: `${safeBaseName(model.title)}.${result.extension}`,
      mime: result.mime,
      missingAssets: (model.assets || []).filter((asset) => asset.status === 'unavailable').length
    };
  }

  function senderAllowed(sender) {
    if (!sender || sender.id !== root.chrome.runtime.id || sender.tab) return false;
    const backgroundUrl = root.chrome.runtime.getURL('src/background.js');
    return !sender.url || sender.url === backgroundUrl;
  }

  function releaseExport(exportId) {
    const context = activeExport;
    if (!context) return {ok: true};
    if (context.exportId !== exportId) return {ok: false, error: '导出记录编号不匹配。'};
    context.released = true;
    if (context.url) root.URL.revokeObjectURL(context.url);
    context.url = '';
    context.stage = null;
    context.model = null;
    content.replaceChildren();
    activeExport = null;
    return {ok: true};
  }

  root.chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'GPT_EXPORTER_DIRECT_RENDER' && message?.type !== 'GPT_EXPORTER_DIRECT_RELEASE') return false;
    if (!senderAllowed(sender)) {
      respond({ok: false, error: '来源未授权。'});
      return false;
    }

    const exportId = message.exportId;
    if (typeof exportId !== 'string' || !SESSION_ID.test(exportId)) {
      respond({ok: false, error: '导出记录编号无效。'});
      return false;
    }

    if (message.type === 'GPT_EXPORTER_DIRECT_RELEASE') {
      respond(releaseExport(exportId));
      return false;
    }

    if (activeExport) {
      respond({ok: false, error: '已有直接导出任务正在处理。'});
      return false;
    }
    if (!FORMATS.has(message.format)) {
      respond({ok: false, error: '不支持的导出格式。'});
      return false;
    }

    try {
      validateModel(message.conversation);
    } catch (error) {
      respond({ok: false, error: safeError(error)});
      return false;
    }

    message.conversation.exportId = exportId;
    const context = {exportId, model: message.conversation, stage: null, url: '', released: false};
    activeExport = context;
    renderExport(context, message.format)
      .then(respond)
      .catch((error) => respond({ok: false, error: safeError(error)}));
    return true;
  });
})(globalThis);
