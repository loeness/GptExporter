'use strict';
importScripts('platforms.js');

// Session-only conversation data; never store chat bodies in persistent local storage.
const SESSION_PREFIX = 'export:';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_AGE = 24 * 60 * 60 * 1000;
const MAX_ASSETS = 300;
const assetLookups = new Map();
const MAX_IMAGE_EDGE = 1800;
const IMAGE_TARGET_BYTES = 900 * 1024;
let openQueue = Promise.resolve();
let activeDirectId = '';
let directAssetLookup;
let quickPending = false;
let activeDirectTabId;
let directPhase = '准备文档';

function supportedPage(value) {
  return Boolean(globalThis.GptExporter.getPlatform(value));
}

function trustedSender(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  const extensionOrigin = chrome.runtime.getURL('');
  return sender.url === extensionOrigin + 'popup.html' || supportedPage(sender.url);
}

function validateConversation(input) {
  if (!input || ![1, 2].includes(input.schemaVersion) || !supportedPage(input.url) ||
      !Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 20000) {
    throw new Error('未找到可导出的对话。请打开支持平台的具体对话并等待内容加载。');
  }
  const platform = globalThis.GptExporter.getPlatform(input.url);
  const chatgpt = platform.id === 'chatgpt';
  const roles = new Set(['user', 'assistant', 'system', 'tool']);
  const model = {
    schemaVersion: 2,
    title: String(input.title || platform.label + ' 对话').slice(0, 300),
    url: input.url,
    exportedAt: new Date().toISOString(),
    messages: input.messages.map((message, index) => {
      if (!message || !roles.has(message.role) ||
          ['markdown', 'text', 'html'].some(field => typeof message[field] !== 'string')) {
        throw new Error('对话数据格式异常，请刷新原对话后重试。');
      }
      return {id: String(message.id || index).slice(0, 250), role: message.role,
        markdown: message.markdown, text: message.text, html: message.html,
        ...(message.visibility === 'internal' ? {visibility:'internal'} : {}),
        createTime: typeof message.createTime === 'string' && Number.isFinite(Date.parse(message.createTime))
          ? new Date(message.createTime).toISOString()
          : Number.isFinite(message.createTime) ? message.createTime : undefined,
        assetIds: chatgpt && Array.isArray(message.assetIds) ? message.assetIds.map(String).slice(0, 200) : []};
    }),
    warnings: Array.isArray(input.warnings) ? input.warnings.filter(x => typeof x === 'string').slice(0, 10) : [],
    createdAt: Date.now()
  };
  const messageIds = new Set(model.messages.map(message => message.id));
  if (messageIds.size !== model.messages.length) throw new Error('消息标识重复，请刷新后重试。');
  if (Array.isArray(input.branches) && input.branches.length > 2000) throw new Error('对话分支超过 2,000 个，无法确认当前分支，本次导出已停止。');
  model.branches = (Array.isArray(input.branches) ? input.branches : []).slice(0, 2000).map((branch, index) => ({
    id: String(branch.id || index).slice(0, 250), label: String(branch.label || `分支 ${index + 1}`).slice(0, 160),
    leafId: String(branch.leafId || '').slice(0, 250),
    messageIds: Array.isArray(branch.messageIds) ? branch.messageIds.map(String).filter(id => messageIds.has(id)).slice(0, 20000) : []
  }));
  if (!model.branches.length) model.branches = [{id:'current',label:'当前页面',leafId:model.messages.at(-1).id,messageIds:[...messageIds]}];
  const hasActiveBranch = model.branches.some(branch => branch.id === input.activeBranchId);
  if (input.activeBranchId && !hasActiveBranch) throw new Error('无法确认当前对话分支，请刷新对话后重试。');
  model.activeBranchId = hasActiveBranch ? input.activeBranchId : model.branches[0].id;
  model.source = {
    platform: platform.id,
    kind: chatgpt && ['api','shared','temporary','dom'].includes(input.source?.kind) ? input.source.kind : 'dom',
    complete: chatgpt && input.source?.complete === true,
    conversationId: chatgpt ? String(input.source?.conversationId || '').slice(0, 250) : ''
  };
  if (!chatgpt) model.warnings = [`${platform.label}：仅包含当前页面已加载的消息，未读取完整历史和其他分支。`,...model.warnings].slice(0,10);
  const assets = chatgpt && Array.isArray(input.assets) ? input.assets : [];
  if (assets.length > MAX_ASSETS) model.warnings.unshift(`对话中的媒体超过 ${MAX_ASSETS} 个，超出部分未读取。`);
  model.assets = assets.slice(0, MAX_ASSETS).filter(asset => asset && ['image','attachment'].includes(asset.kind)).map(asset => ({
    id: String(asset.id || '').slice(0, 250), messageId: String(asset.messageId || '').slice(0, 250), kind:asset.kind,
    name:String(asset.name || '附件').slice(0, 250),mimeType:String(asset.mimeType || 'application/octet-stream').slice(0, 100),
    size:Number.isFinite(asset.size) ? asset.size : undefined,fileId:String(asset.fileId || '').slice(0, 250),
    url:typeof asset.url === 'string' && approvedMediaUrl(asset.url) ? asset.url : '',status:'pending'
  }));
  return model;
}

function measureModel(model) {
  const bytes = new TextEncoder().encode(JSON.stringify(model)).length;
  if (bytes > MAX_BYTES) throw new Error('当前对话文字与分支超过 8 MB，请缩小范围后重试。');
  return bytes;
}

function modelFromSender(input, sender) {
  const model = validateConversation(input);
  const fromPopup = sender?.url === chrome.runtime.getURL('popup.html');
  if (!fromPopup && new URL(sender.url).origin !== new URL(model.url).origin) throw new Error('对话来源与当前平台不一致，请刷新原页面后重试。');
  model.source.sourceTabId = !fromPopup && Number.isInteger(sender?.tab?.id) ? sender.tab.id :
    (Number.isInteger(input.source?.sourceTabId) ? input.source.sourceTabId : undefined);
  return model;
}

async function storeExport(model) {
  const modelBytes = measureModel(model);
  const records = await chrome.storage.session.get(null);
  const entries = Object.entries(records).filter(([key]) => key.startsWith(SESSION_PREFIX));
  const stale = entries.filter(([, value]) => !value?.createdAt || Date.now() - value.createdAt > MAX_AGE);
  if (stale.length) await chrome.storage.session.remove(stale.map(([key]) => key));
  // Keep existing open previews intact. Ask the user to clear them instead of evicting data silently.
  const existingBytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(
    entries.filter(([key]) => !stale.some(([oldKey]) => oldKey === key))
  ))).length;
  if (existingBytes + modelBytes > 9 * 1024 * 1024) {
    throw new Error('预览缓存已满，请在已有预览中点击“清除”后重试。');
  }
  const id = crypto.randomUUID();
  const key = SESSION_PREFIX + id;
  await chrome.storage.session.set({[key]: model});
  return {id, key};
}

async function openExport(input, sender) {
  const {id, key} = await storeExport(modelFromSender(input, sender));
  try {
    await chrome.tabs.create({url: chrome.runtime.getURL('reader.html?id=' + id)});
  } catch (error) {
    await chrome.storage.session.remove(key);
    throw error;
  }
  return {ok: true, id};
}

function quickModel(input, sender, preset) {
  if (!['all', 'questions', 'answers'].includes(preset)) throw new Error('快捷导出范围无效。');
  const model = modelFromSender(input, sender);
  const branch = model.branches.find(item => item.id === model.activeBranchId);
  const byId = new Map(model.messages.map(message => [message.id, message]));
  model.messages = globalThis.GptExporter.filterVisibleMessages([...new Set(branch.messageIds)].map(id => byId.get(id)).filter(Boolean))
    .filter(message => preset === 'all' || message.role === (preset === 'questions' ? 'user' : 'assistant'));
  if (!model.messages.length) throw new Error(preset === 'questions' ? '当前分支没有可导出的提问。' : preset === 'answers' ? '当前分支没有可导出的回答。' : '当前分支没有可导出的消息。');
  const ids = new Set(model.messages.map(message => message.id));
  const assetIds = new Set(model.messages.flatMap(message => message.assetIds));
  model.assets = model.assets.filter(asset => ids.has(asset.messageId) || assetIds.has(asset.id));
  model.branches = [{...branch, messageIds:model.messages.map(message => message.id),leafId:model.messages.at(-1).id}];
  model.title += ' - ' + ({all:'All',questions:'Questions',answers:'Answers'})[preset];
  return model;
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise,new Promise((_,reject) => { timer = setTimeout(() => reject(new Error(typeof message === 'function' ? message() : message)),milliseconds); })])
    .finally(() => clearTimeout(timer));
}

function assetLookup(model) {
  return { source: model.source, url: model.url, assets: new Map(model.assets.map(asset => [asset.id, asset])) };
}

async function withAssetRecord(exportId, fromOffscreen, callback) {
  if (fromOffscreen) return callback(directAssetLookup);
  const key = SESSION_PREFIX + exportId;
  let lookup = assetLookups.get(key);
  if (!lookup) {
    lookup = { users: 0, pending: chrome.storage.session.get(key).then(records => records[key] && assetLookup(records[key])) };
    assetLookups.set(key, lookup);
  }
  lookup.users++;
  try { return await callback(await lookup.pending); }
  finally {
    if (--lookup.users === 0) assetLookups.delete(key);
  }
}

async function waitForDownload(id) {
  let listener;
  const pending = new Promise((resolve,reject) => {
    function inspect(item) {
      const state = typeof item.state === 'string' ? item.state : item.state?.current;
      const error = typeof item.error === 'string' ? item.error : item.error?.current;
      if (state === 'complete') resolve();
      else if (state === 'interrupted' || error) reject(new Error('下载中断：' + (error || '文件未保存，请重试。')));
    }
    listener = delta => { if (delta.id === id) inspect(delta); };
    chrome.downloads.onChanged.addListener(listener);
    // The file can complete before onChanged is registered; inspect only our ID.
    chrome.downloads.search({id}).then(items => {
      if (items.length) inspect(items[0]); else reject(new Error('未找到本次下载记录。'));
    },reject);
  });
  try { await withTimeout(pending,90000,'下载等待超时，请检查浏览器下载列表。'); }
  catch (error) { await chrome.downloads.cancel(id).catch(() => {}); throw error; }
  finally { chrome.downloads.onChanged.removeListener(listener); }
}

async function quickExport(message, sender) {
  const format = message.format || 'pdf';
  const extensions = {pdf:'pdf',markdown:'md',html:'html',text:'txt',json:'json',csv:'csv'};
  if (!Object.hasOwn(extensions,format)) throw new Error('快捷导出格式无效。');
  if (!chrome.offscreen?.createDocument || !chrome.downloads?.download) throw new Error('浏览器不支持后台导出，请使用 SELECT 打开导出页面。');
  const model = quickModel(message.conversation,sender,message.preset);
  measureModel(model);
  const id = crypto.randomUUID();
  let offscreen = false;
  // Keep the worker responsive during long local rendering/media requests.
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); },20000);
  activeDirectId = id;
  directAssetLookup = assetLookup(model);
  activeDirectTabId = model.source.sourceTabId; directPhase = '准备文档';
  try {
    const documentUrl = chrome.runtime.getURL('direct-export.html');
    const contexts = typeof chrome.runtime.getContexts === 'function'
      ? await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[documentUrl]})
      : await globalThis.clients.matchAll();
    if (!contexts.some(context => (context.documentUrl || context.url) === documentUrl)) {
      await chrome.offscreen.createDocument({url:'direct-export.html',reasons:['BLOBS','DOM_PARSER'],
        justification:'在本机渲染所选对话并生成下载文件，无需打开导出标签页。'});
    }
    offscreen = true;
    const result = await withTimeout(chrome.runtime.sendMessage({type:'GPT_EXPORTER_DIRECT_RENDER',exportId:id,format,conversation:model}),
      240000,() => `本地文件生成超时（${directPhase}），请使用 SELECT 选择部分消息后重试。`);
    if (!result?.ok) throw new Error(result?.error || '后台文件生成失败。');
    if (typeof result.url !== 'string' || !result.url.startsWith('blob:' + chrome.runtime.getURL(''))) throw new Error('后台返回的下载地址无效。');
    const suffix = '.' + extensions[format];
    const suggested = typeof result.filename === 'string' && result.filename.toLowerCase().endsWith(suffix)
      ? result.filename.slice(0, -suffix.length) : model.title;
    const baseName = suggested.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'-').replace(/\s+/g,' ').replace(/[. ]+$/,'').trim().slice(0,100) || '对话导出';
    const filename = baseName + '.' + extensions[format];
    const downloadId = await chrome.downloads.download({url:result.url,filename,saveAs:false,conflictAction:'uniquify'});
    if (!Number.isInteger(downloadId)) throw new Error('浏览器未能启动下载。');
    await waitForDownload(downloadId);
    return {ok:true,count:model.messages.length,format,downloadId,missingAssets:Number.isInteger(result.missingAssets)?result.missingAssets:0};
  } finally {
    clearInterval(keepAlive);
    const failures = [];
    if (offscreen) {
      await withTimeout(chrome.runtime.sendMessage({type:'GPT_EXPORTER_DIRECT_RELEASE',exportId:id}),3000,'释放临时文档超时。').catch(() => {});
      try { await chrome.offscreen.closeDocument(); } catch (error) { failures.push(error); }
    }
    activeDirectId = '';
    directAssetLookup = undefined;
    activeDirectTabId = undefined;
    if (failures.length) throw new Error('快捷导出已结束，但临时数据清理失败，请重新加载扩展。');
  }
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

async function loadAsset(message, fromOffscreen) {
  if (!/^[\w-]{1,100}$/.test(message.exportId || '')) throw new Error('导出记录编号无效。');
  return withAssetRecord(message.exportId, fromOffscreen, model => readAsset(model, message.assetId));
}

async function compactImage(bytes, mimeType) {
  const original = { bytes, mimeType };
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return original;
  if (mimeType === 'image/png' && bytes.length >= 24) {
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = header.getUint32(16), height = header.getUint32(20);
    if (width * height > 64000000) throw new Error('图片像素超过 6,400 万，无法安全嵌入。');
    if (bytes.length <= IMAGE_TARGET_BYTES && Math.max(width, height) <= MAX_IMAGE_EDGE) return original;
  } else if (bytes.length <= IMAGE_TARGET_BYTES) {
    return original;
  }

  let bitmap, expired = false;
  try {
    const decoding = createImageBitmap(new Blob([bytes], { type: mimeType })).then(image => {
      if (expired) image.close();
      return image;
    });
    bitmap = await withTimeout(decoding, 8000, '图片解码超时。');
  } catch (_) {
    expired = true;
    return original;
  }

  const canvas = new OffscreenCanvas(1, 1);
  try {
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const resized = scale < 1;
    const context = canvas.getContext('2d', { willReadFrequently: mimeType !== 'image/jpeg' });
    if (!context) return original;
    let output;
    for (let attempt = 0; attempt < 3; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      output = await canvas.convertToBlob({ type: mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png', quality: 0.86 });
      if (output.size > IMAGE_TARGET_BYTES && output.type === 'image/png') {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let opaque = true;
        for (let offset = 3; offset < pixels.length; offset += 4) {
          if (pixels[offset] !== 255) { opaque = false; break; }
        }
        if (opaque) output = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
      }
      if (output.size <= IMAGE_TARGET_BYTES) break;
      scale *= 0.72;
    }
    if (!output?.size || (!resized && output.size >= bytes.length)) return original;
    return { bytes: new Uint8Array(await output.arrayBuffer()), mimeType: output.type };
  } catch (_) {
    return original;
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 1;
  }
}

async function readAsset(model, assetId) {
  const asset = model?.assets.get(assetId);
  if (!asset) throw new Error('附件不在本次对话中。');
  let resolved = asset;
  if ((asset.fileId || !asset.url) && Number.isInteger(model.source?.sourceTabId)) {
    try {
      const response = await withTimeout(chrome.tabs.sendMessage(model.source.sourceTabId, {
        type:'GPT_EXPORTER_RESOLVE_ASSET',asset,source:{kind:model.source.kind,conversationId:model.source.conversationId},url:model.url
      }), 40000, '原对话未及时返回媒体地址。');
      if (response?.ok) resolved = {...asset,...response.asset};
      else if (!asset.url) throw new Error(response?.error || '附件地址未取得。');
    } catch (error) { if (!asset.url) throw new Error('请保持原对话标签页打开，以读取附件。' + (error.message || '')); }
  }
  const limitMB = asset.kind === 'image' ? 20 : 12;
  const maximum = limitMB * 1024 * 1024;
  const tooLarge = `单个${asset.kind === 'image' ? '图片' : '附件'}超过 ${limitMB} MB。`;
  let bytes, mimeType;
  if (typeof resolved.dataUrl === 'string' && /^data:[\w.+/-]+;base64,/.test(resolved.dataUrl)) {
    const encoded=resolved.dataUrl.slice(resolved.dataUrl.indexOf(',')+1);
    if (encoded.length > Math.ceil(maximum / 3) * 4) throw new Error(tooLarge);
    if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded)) throw new Error('附件编码无效。');
    const raw = atob(encoded);
    if (raw.length > maximum) throw new Error(tooLarge);
    bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    mimeType = resolved.dataUrl.slice(5,resolved.dataUrl.indexOf(';'));
  } else {
    if (!approvedMediaUrl(resolved.url)) throw new Error('附件地址不可用，或不属于允许的 ChatGPT 媒体域名。');
    const parsed = new URL(resolved.url);
    const response = await fetch(resolved.url, {credentials:['chatgpt.com','chat.openai.com'].includes(parsed.hostname)?'include':'omit',
      redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`附件读取失败（HTTP ${response.status}）。`);
    if (Number(response.headers.get('content-length')) > maximum) {
      await response.body?.cancel().catch(() => {});
      throw new Error(tooLarge);
    }
    mimeType = String(response.headers.get('content-type') || asset.mimeType).split(';')[0].trim();
    const reader = response.body.getReader(); const chunks = []; let length = 0;
    for (;;) {
      const {value,done} = await reader.read(); if (done) break;
      length += value.length; if (length > maximum) { await reader.cancel(); throw new Error(tooLarge); } chunks.push(value);
    }
    bytes = new Uint8Array(length); let offset=0; for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  }
  if (asset.kind === 'image') {
    const png=bytes[0]===137&&bytes[1]===80&&bytes[2]===78, jpeg=bytes[0]===255&&bytes[1]===216,
      gif=bytes[0]===71&&bytes[1]===73&&bytes[2]===70, webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
    if (!(png||jpeg||gif||webp)) throw new Error('图片不是受支持的 PNG、JPEG、GIF 或 WebP，未执行嵌入。');
    mimeType=png?'image/png':jpeg?'image/jpeg':gif?'image/gif':'image/webp';
    ({ bytes, mimeType } = await compactImage(bytes, mimeType));
  }
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) mimeType='application/octet-stream';
  // Preserve active formats only as download-only bytes; never make an HTML/SVG document in the reader.
  if(asset.kind==='attachment'&&/(?:html|svg|javascript|ecmascript|xml)/i.test(mimeType))mimeType='application/octet-stream';
  let encoded;
  if (typeof bytes.toBase64 === 'function') encoded = bytes.toBase64();
  else {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    encoded = btoa(binary);
  }
  return {ok:true,asset:{dataUrl:`data:${mimeType};base64,${encoded}`,mimeType,size:bytes.length,name:String(resolved.name||asset.name),status:'ready'}};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'GPT_EXPORTER_DIRECT_PROGRESS') {
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('direct-export.html') ||
        !activeDirectId || message.exportId !== activeDirectId) { respond({ok:false}); return false; }
    const phases = {assets:'读取图片与附件',render:'排版对话内容',snapshot:'处理公式和图表',pdf:'生成 PDF 文件'};
    if (!Object.hasOwn(phases,message.phase)) { respond({ok:false}); return false; }
    directPhase = phases[message.phase];
    if (Number.isInteger(activeDirectTabId)) {
      const {completed, total} = message;
      const progress = message.phase === 'snapshot' && Number.isSafeInteger(completed) &&
        Number.isSafeInteger(total) && completed >= 0 && completed <= total && total <= 100000 ? ` ${completed}/${total}` : '';
      chrome.tabs.sendMessage(activeDirectTabId,{type:'GPT_EXPORTER_PROGRESS',text:`正在${directPhase}${progress}…`}).catch(() => {});
    }
    respond({ok:true}); return false;
  }
  if (message?.type === 'GPT_EXPORTER_ASSET') {
    const offscreenSender = sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('direct-export.html') &&
      activeDirectId && message.exportId === activeDirectId;
    if (!readerSender(sender) && !offscreenSender) { respond({ok:false,error:'来源未授权。'}); return false; }
    loadAsset(message, Boolean(offscreenSender)).then(respond).catch(error => respond({ok:false,error:error.message || '附件读取失败。'}));
    return true;
  }
  if (!['GPT_EXPORTER_OPEN','GPT_EXPORTER_QUICK'].includes(message?.type)) return false;
  if (!trustedSender(sender)) { respond({ok: false, error: '来源未授权。'}); return false; }
  const direct = message.type === 'GPT_EXPORTER_QUICK';
  if (direct && quickPending) { respond({ok:false,error:'已有快捷导出正在处理，请稍后重试。'}); return false; }
  if (direct) quickPending = true;
  const work = direct ? quickExport(message, sender) : openQueue.then(() => openExport(message.conversation, sender));
  if (!direct) openQueue = work.catch(() => {});
  work.then(result => { if (direct) quickPending = false; respond(result); },error => {
    if (direct) quickPending = false;
    respond({ok:false,error:error.message || '导出失败，请重试。'});
  });
  return true;
});
