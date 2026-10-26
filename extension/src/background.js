'use strict';

// Session-only conversation data; never store chat bodies in persistent local storage.
const SESSION_PREFIX = 'export:';
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_AGE = 24 * 60 * 60 * 1000;
let openQueue = Promise.resolve();

function supportedPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(url.hostname);
  } catch { return false; }
}

function trustedSender(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  const extensionOrigin = chrome.runtime.getURL('');
  return sender.url === extensionOrigin + 'popup.html' || supportedPage(sender.url);
}

function validateConversation(input) {
  if (!input || input.schemaVersion !== 1 || !supportedPage(input.url) ||
      !Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 5000) {
    throw new Error('未找到可导出的对话。请打开 ChatGPT 对话并等待内容加载。');
  }
  const roles = new Set(['user', 'assistant', 'system', 'tool']);
  const model = {
    schemaVersion: 1,
    title: String(input.title || 'ChatGPT 对话').slice(0, 300),
    url: input.url,
    exportedAt: new Date().toISOString(),
    messages: input.messages.map((message, index) => {
      if (!message || !roles.has(message.role) ||
          ['markdown', 'text', 'html'].some(field => typeof message[field] !== 'string')) {
        throw new Error('对话数据格式异常，请刷新 ChatGPT 后重试。');
      }
      return {id: String(message.id || index), role: message.role,
        markdown: message.markdown, text: message.text, html: message.html};
    }),
    warnings: Array.isArray(input.warnings) ? input.warnings.filter(x => typeof x === 'string').slice(0, 10) : [],
    createdAt: Date.now()
  };
  if (new TextEncoder().encode(JSON.stringify(model)).length > MAX_BYTES) {
    throw new Error('当前对话超过 3 MB，请缩小对话内容后重试。');
  }
  return model;
}

async function openExport(input) {
  const model = validateConversation(input);
  const records = await chrome.storage.session.get(null);
  const entries = Object.entries(records).filter(([key]) => key.startsWith(SESSION_PREFIX));
  const stale = entries.filter(([, value]) => !value?.createdAt || Date.now() - value.createdAt > MAX_AGE);
  if (stale.length) await chrome.storage.session.remove(stale.map(([key]) => key));
  // Keep existing open previews intact. Ask the user to clear them instead of evicting data silently.
  const existingBytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(
    entries.filter(([key]) => !stale.some(([oldKey]) => oldKey === key))
  ))).length;
  if (existingBytes + new TextEncoder().encode(JSON.stringify(model)).length > 8 * 1024 * 1024) {
    throw new Error('预览缓存已满，请在已有预览中点击“清除”后重试。');
  }
  const id = crypto.randomUUID();
  const key = SESSION_PREFIX + id;
  await chrome.storage.session.set({[key]: model});
  try {
    await chrome.tabs.create({url: chrome.runtime.getURL('reader.html?id=' + id)});
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
  return {ok: true, id};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'GPT_EXPORTER_OPEN') return false;
  if (!trustedSender(sender)) { respond({ok: false, error: '来源未授权。'}); return false; }
  const work = openQueue.then(() => openExport(message.conversation));
  openQueue = work.catch(() => {});
  work.then(respond).catch(error => respond({ok: false, error: error.message || '无法打开预览，请重试。'}));
  return true;
});
