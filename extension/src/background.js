'use strict';

// Session-only conversation data; never store chat bodies in persistent local storage.
const SESSION_PREFIX = 'export:';
const MAX_BYTES = 8 * 1024 * 1024;
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
  if (!input || ![1, 2].includes(input.schemaVersion) || !supportedPage(input.url) ||
      !Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 20000) {
    throw new Error('未找到可导出的对话。请打开 ChatGPT 对话并等待内容加载。');
  }
  const roles = new Set(['user', 'assistant', 'system', 'tool']);
  const model = {
    schemaVersion: 2,
    title: String(input.title || 'ChatGPT 对话').slice(0, 300),
    url: input.url,
    exportedAt: new Date().toISOString(),
    messages: input.messages.map((message, index) => {
      if (!message || !roles.has(message.role) ||
          ['markdown', 'text', 'html'].some(field => typeof message[field] !== 'string')) {
        throw new Error('对话数据格式异常，请刷新 ChatGPT 后重试。');
      }
      return {id: String(message.id || index).slice(0, 250), role: message.role,
        markdown: message.markdown, text: message.text, html: message.html,
        createTime: Number.isFinite(message.createTime) ? message.createTime : undefined,
        assetIds: Array.isArray(message.assetIds) ? message.assetIds.map(String).slice(0, 200) : []};
    }),
    warnings: Array.isArray(input.warnings) ? input.warnings.filter(x => typeof x === 'string').slice(0, 10) : [],
    createdAt: Date.now()
  };
  const messageIds = new Set(model.messages.map(message => message.id));
  if (messageIds.size !== model.messages.length) throw new Error('消息标识重复，请刷新后重试。');
  if (['all', 'questions', 'answers', 'none'].includes(input.initialSelection?.preset)) {
    const overrides = new Map();
    for (const entry of (Array.isArray(input.initialSelection.overrides) ? input.initialSelection.overrides : []).slice(0, 20000)) {
      if (entry && typeof entry.id === 'string' && messageIds.has(entry.id) && typeof entry.selected === 'boolean') {
        overrides.set(entry.id, entry.selected);
      }
    }
    model.initialSelection = {preset: input.initialSelection.preset,
      overrides: [...overrides].map(([id, selected]) => ({id, selected}))};
  }
  model.branches = (Array.isArray(input.branches) ? input.branches : []).slice(0, 2000).map((branch, index) => ({
    id: String(branch.id || index).slice(0, 250), label: String(branch.label || `分支 ${index + 1}`).slice(0, 160),
    leafId: String(branch.leafId || '').slice(0, 250),
    messageIds: Array.isArray(branch.messageIds) ? branch.messageIds.map(String).filter(id => messageIds.has(id)).slice(0, 20000) : []
  }));
  if (!model.branches.length) model.branches = [{id:'current',label:'当前页面',leafId:model.messages.at(-1).id,messageIds:[...messageIds]}];
  model.activeBranchId = model.branches.some(branch => branch.id === input.activeBranchId) ? input.activeBranchId : model.branches[0].id;
  model.source = {
    kind: ['api','shared','temporary','dom'].includes(input.source?.kind) ? input.source.kind : 'dom',
    complete: input.source?.complete === true,
    conversationId: String(input.source?.conversationId || '').slice(0, 250)
  };
  model.assets = (Array.isArray(input.assets) ? input.assets : []).slice(0, 300).filter(asset => asset && ['image','attachment'].includes(asset.kind)).map(asset => ({
    id: String(asset.id || '').slice(0, 250), messageId: String(asset.messageId || '').slice(0, 250), kind:asset.kind,
    name:String(asset.name || '附件').slice(0, 250),mimeType:String(asset.mimeType || 'application/octet-stream').slice(0, 100),
    size:Number.isFinite(asset.size) ? asset.size : undefined,fileId:String(asset.fileId || '').slice(0, 250),
    url:typeof asset.url === 'string' && approvedMediaUrl(asset.url) ? asset.url : '',status:'pending'
  }));
  if (new TextEncoder().encode(JSON.stringify(model)).length > MAX_BYTES) {
    throw new Error('当前对话文字与分支超过 8 MB，请缩小范围后重试。');
  }
  return model;
}

async function openExport(input, sender) {
  const model = validateConversation(input);
  const fromPopup = sender?.url === chrome.runtime.getURL('popup.html');
  model.source.sourceTabId = !fromPopup && Number.isInteger(sender?.tab?.id) ? sender.tab.id :
    (Number.isInteger(input.source?.sourceTabId) ? input.source.sourceTabId : undefined);
  const records = await chrome.storage.session.get(null);
  const entries = Object.entries(records).filter(([key]) => key.startsWith(SESSION_PREFIX));
  const stale = entries.filter(([, value]) => !value?.createdAt || Date.now() - value.createdAt > MAX_AGE);
  if (stale.length) await chrome.storage.session.remove(stale.map(([key]) => key));
  // Keep existing open previews intact. Ask the user to clear them instead of evicting data silently.
  const existingBytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(
    entries.filter(([key]) => !stale.some(([oldKey]) => oldKey === key))
  ))).length;
  if (existingBytes + new TextEncoder().encode(JSON.stringify(model)).length > 9 * 1024 * 1024) {
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

function approvedMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port||url.port==='443') &&
      (['chatgpt.com','chat.openai.com','oaiusercontent.com'].includes(url.hostname) || url.hostname.endsWith('.oaiusercontent.com') ||
        (/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname)&&['sig','se','sv'].every(key=>Boolean(url.searchParams.get(key)))));
  } catch { return false; }
}

function readerSender(sender) {
  return sender.id === chrome.runtime.id && String(sender.url || '').split('?')[0] === chrome.runtime.getURL('reader.html');
}

async function loadAsset(message) {
  if (!/^[\w-]{1,100}$/.test(message.exportId || '')) throw new Error('导出记录编号无效。');
  const key = SESSION_PREFIX + message.exportId;
  const model = (await chrome.storage.session.get(key))[key];
  const asset = model?.assets?.find(item => item.id === message.assetId);
  if (!asset) throw new Error('附件不在本次对话中。');
  let resolved = asset;
  if (Number.isInteger(model.source?.sourceTabId)) {
    try {
      const response = await chrome.tabs.sendMessage(model.source.sourceTabId, {type:'GPT_EXPORTER_RESOLVE_ASSET',asset,
        source:{kind:model.source.kind,conversationId:model.source.conversationId},url:model.url});
      if (response?.ok) resolved = {...asset,...response.asset};
      else if (!asset.url) throw new Error(response?.error || '附件地址未取得。');
    } catch (error) { if (!asset.url) throw new Error('请保持原对话标签页打开，以读取附件。' + (error.message || '')); }
  }
  const maximum = 12 * 1024 * 1024;
  let bytes, mimeType;
  if (typeof resolved.dataUrl === 'string' && /^data:[\w.+/-]+;base64,/.test(resolved.dataUrl)) {
    const encoded=resolved.dataUrl.slice(resolved.dataUrl.indexOf(',')+1);
    if(encoded.length>Math.ceil(maximum/3)*4||encoded.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('附件编码无效或单个附件超过 12 MB。');
    const raw = atob(encoded);
    if (raw.length > maximum) throw new Error('单个附件超过 12 MB。');
    bytes = Uint8Array.from(raw, value => value.charCodeAt(0)); mimeType = resolved.dataUrl.slice(5,resolved.dataUrl.indexOf(';'));
  } else {
    if (!approvedMediaUrl(resolved.url)) throw new Error('附件地址不可用，或不属于允许的 ChatGPT 媒体域名。');
    const parsed = new URL(resolved.url);
    const response = await fetch(resolved.url, {credentials:['chatgpt.com','chat.openai.com'].includes(parsed.hostname)?'include':'omit',
      redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`附件读取失败（HTTP ${response.status}）。`);
    if (Number(response.headers.get('content-length')) > maximum) throw new Error('单个附件超过 12 MB。');
    mimeType = String(response.headers.get('content-type') || asset.mimeType).split(';')[0].trim();
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    for (;;) {
      const {value,done} = await reader.read(); if (done) break;
      length += value.length; if (length > maximum) { await reader.cancel(); throw new Error('单个附件超过 12 MB。'); } chunks.push(value);
    }
    bytes = new Uint8Array(length); let offset=0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  }
  if (asset.kind === 'image') {
    const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78, jpeg=bytes[0]===255&&bytes[1]===216,
      gif=bytes[0]===71&&bytes[1]===73&&bytes[2]===70, webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
    if (!(png||jpeg||gif||webp)) throw new Error('图片不是受支持的 PNG、JPEG、GIF 或 WebP，未执行嵌入。');
    mimeType=png?'image/png':jpeg?'image/jpeg':gif?'image/gif':'image/webp';
  }
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) mimeType='application/octet-stream';
  // Preserve active formats only as download-only bytes; never make an HTML/SVG document in the reader.
  if(asset.kind==='attachment'&&/(?:html|svg|javascript|ecmascript|xml)/i.test(mimeType))mimeType='application/octet-stream';
  let binary=''; for (let offset=0;offset<bytes.length;offset+=32768) binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return {ok:true,asset:{dataUrl:`data:${mimeType};base64,${btoa(binary)}`,mimeType,size:bytes.length,name:String(resolved.name||asset.name),status:'ready'}};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'GPT_EXPORTER_ASSET') {
    if (!readerSender(sender)) { respond({ok:false,error:'来源未授权。'}); return false; }
    loadAsset(message).then(respond).catch(error => respond({ok:false,error:error.message || '附件读取失败。'}));
    return true;
  }
  if (message?.type !== 'GPT_EXPORTER_OPEN') return false;
  if (!trustedSender(sender)) { respond({ok: false, error: '来源未授权。'}); return false; }
  const work = openQueue.then(() => openExport(message.conversation, sender));
  openQueue = work.catch(() => {});
  work.then(respond).catch(error => respond({ok: false, error: error.message || '无法打开预览，请重试。'}));
  return true;
});
