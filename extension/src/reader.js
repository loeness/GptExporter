(function startReader(root) {
  'use strict';

  const PREF_KEY = 'gptExporter.reader.preferences';
  const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
  const ROLE_LABELS = { user: 'User', assistant: 'Assistant', system: 'System', tool: 'Tool' };
  const els = {};
  const state = {
    conversation: null,
    storageKey: '',
    selected: new Set(),
    query: '',
    preferences: { includeMetadata: true, theme: 'light' },
    hasError: false,
    statusTimer: 0,
    branchId: '__all',
    renderPromise: Promise.resolve(),
    renderError: null,
    renderSequence: 0,
    busy: false,
    blobUrls: new Set()
  };

  function byId(id) { return root.document.getElementById(id); }

  function cacheElements() {
    [
      'message-total', 'message-search', 'message-list', 'list-empty', 'selection-count',
      'conversation-title', 'include-metadata', 'copy-markdown', 'print-document',
      'theme-toggle', 'clear-data', 'preview-paper', 'preview-content', 'preview-empty',
      'load-error', 'error-title', 'error-detail', 'reload-demo', 'status-line',
      'source-caption', 'branch-select', 'source-quality', 'load-media', 'pdf-page-size', 'pdf-orientation'
    ].forEach((id) => { els[id] = byId(id); });
  }

  function getChromeArea(areaName) {
    try {
      return root.chrome && root.chrome.storage && root.chrome.storage[areaName]
        ? root.chrome.storage[areaName]
        : null;
    } catch (_) {
      return null;
    }
  }

  async function loadPreferences() {
    const local = getChromeArea('local');
    if (!local) return;
    try {
      const result = await local.get(PREF_KEY);
      const saved = result && result[PREF_KEY];
      if (saved && typeof saved === 'object') {
        state.preferences.includeMetadata = saved.includeMetadata !== false;
        state.preferences.theme = saved.theme === 'dark' ? 'dark' : 'light';
      }
    } catch (_) {
      showStatus('偏好设置读取失败，当前使用默认显示设置。', 'error');
    }
  }

  async function savePreferences() {
    const local = getChromeArea('local');
    if (!local) return;
    try {
      await local.set({
        [PREF_KEY]: {
          includeMetadata: Boolean(state.preferences.includeMetadata),
          theme: state.preferences.theme === 'dark' ? 'dark' : 'light'
        }
      });
    } catch (_) {
      showStatus('显示偏好未能保存；本次阅读仍可继续。', 'error');
    }
  }

  function makeDemoConversation() {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      title: '一份关于好问题的示例对话',
      url: 'https://chatgpt.com/c/demo-conversation',
      exportedAt: now,
      warnings: ['仅展示当前已加载的消息；未加载的历史内容不在此示例中。'],
      messages: [
        {
          id: 'demo-user-1', role: 'user',
          markdown: '请用三个要点说明，怎样提出一个更容易得到好答案的问题？',
          text: '请用三个要点说明，怎样提出一个更容易得到好答案的问题？',
          html: '<p>请用三个要点说明，怎样提出一个更容易得到好答案的问题？</p>'
        },
        {
          id: 'demo-assistant-1', role: 'assistant',
          markdown: '一个清晰的问题通常包含目标、背景和边界。\n\n1. **说明目标**：先说希望完成什么。\n2. **补充背景**：只提供影响答案的关键信息。\n3. **写明边界**：说明格式、范围或时间限制。',
          text: '一个清晰的问题通常包含目标、背景和边界。\n\n1. 说明目标：先说希望完成什么。\n2. 补充背景：只提供影响答案的关键信息。\n3. 写明边界：说明格式、范围或时间限制。',
          html: '<p>一个清晰的问题通常包含目标、背景和边界。</p><ol><li><strong>说明目标</strong>：先说希望完成什么。</li><li><strong>补充背景</strong>：只提供影响答案的关键信息。</li><li><strong>写明边界</strong>：说明格式、范围或时间限制。</li></ol>'
        },
        {
          id: 'demo-user-2', role: 'user',
          markdown: '如果背景很多，应该怎么取舍？',
          text: '如果背景很多，应该怎么取舍？',
          html: '<p>如果背景很多，应该怎么取舍？</p>'
        },
        {
          id: 'demo-assistant-2', role: 'assistant',
          markdown: '可以把问题拆成两层：先保留会改变答案的事实，再把其余材料放到补充说明里。这样读者更容易看清重点，也能在需要时继续追问。',
          text: '可以把问题拆成两层：先保留会改变答案的事实，再把其余材料放到补充说明里。这样读者更容易看清重点，也能在需要时继续追问。',
          html: '<p>可以把问题拆成两层：先保留会改变答案的事实，再把其余材料放到补充说明里。这样读者更容易看清重点，也能在需要时继续追问。</p>'
        }
      ]
    };
  }

  function validateConversation(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('保存的数据为空或不是有效对象。');
    if (![1, 2].includes(value.schemaVersion)) throw new TypeError('数据版本不受支持。');
    if (typeof value.title !== 'string' || typeof value.url !== 'string' || typeof value.exportedAt !== 'string') {
      throw new TypeError('对话标题或来源信息不完整。');
    }
    if (!Array.isArray(value.messages)) throw new TypeError('消息列表格式无效。');
    if (value.messages.length === 0) throw new TypeError('这份对话没有可导出的已加载消息。');
    const ids = new Set();
    for (const message of value.messages) {
      if (!message || typeof message !== 'object' || !VALID_ROLES.has(message.role)) throw new TypeError('消息数据格式无效。');
      if (typeof message.id !== 'string' || !message.id || ids.has(message.id)) throw new TypeError('消息标识缺失或重复。');
      ids.add(message.id);
      for (const field of ['markdown', 'text', 'html']) {
        if (typeof message[field] !== 'string') throw new TypeError('消息内容不完整。');
      }
    }
    if (value.warnings != null && (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== 'string'))) {
      throw new TypeError('提示信息格式无效。');
    }
    return value;
  }

  function showStatus(message, kind) {
    if (!els['status-line']) return;
    root.clearTimeout(state.statusTimer);
    els['status-line'].textContent = message;
    els['status-line'].dataset.kind = kind || 'success';
    els['status-line'].hidden = false;
    state.statusTimer = root.setTimeout(() => { els['status-line'].hidden = true; }, kind === 'error' ? 6500 : 4200);
  }

  function showLoadError(title, detail) {
    state.conversation = null;
    state.selected.clear();
    state.hasError = true;
    if(els['branch-select'])els['branch-select'].disabled=true;
    if(els['load-media'])els['load-media'].disabled=true;
    if(els['source-quality'])els['source-quality'].textContent='没有可用的导出记录';
    els['message-total'].textContent = '0 条';
    els['message-list'].replaceChildren();
    els['preview-content'].replaceChildren();
    els['selection-count'].textContent = '已选择 0 条';
    els['conversation-title'].value = '';
    els['message-search'].value = '';
    state.query = '';
    els['conversation-title'].disabled = true;
    els['message-search'].disabled = true;
    els['include-metadata'].disabled = true;
    els['copy-markdown'].disabled = true;
    els['print-document'].disabled = true;
    root.document.querySelectorAll('[data-select], [data-format]').forEach((button) => { button.disabled = true; });
    els['preview-paper'].hidden = true;
    els['preview-empty'].hidden = true;
    els['load-error'].hidden = false;
    els['error-title'].textContent = title;
    els['error-detail'].textContent = detail;
    els['list-empty'].hidden = false;
    els['list-empty'].textContent = '没有可用的消息';
    els['reload-demo'].hidden = new URLSearchParams(root.location.search).get('demo') === '1';
  }

  function clearLoadError() {
    state.hasError = false;
    els['load-error'].hidden = true;
    els['preview-paper'].hidden = false;
    els['conversation-title'].disabled = false;
    els['message-search'].disabled = false;
    els['include-metadata'].disabled = false;
    els['copy-markdown'].disabled = false;
    els['print-document'].disabled = false;
    root.document.querySelectorAll('[data-select], [data-format]').forEach((button) => { button.disabled = false; });
  }

  async function loadConversation() {
    const params = new URLSearchParams(root.location.search);
    if (params.get('demo') === '1') {
      state.conversation = validateConversation(makeDemoConversation());
      return;
    }

    const id = params.get('id');
    if (!id) throw new Error('缺少导出记录编号。请从扩展入口重新打开，或使用示例预览。');
    state.storageKey = `export:${id}`;
    const session = getChromeArea('session');
    if (!session) throw new Error('当前页面无法访问扩展会话存储。请从扩展入口重新打开。');
    let stored;
    try {
      const result = await session.get(state.storageKey);
      stored = result && result[state.storageKey];
    } catch (_) {
      throw new Error('读取本次导出数据失败。请返回对话页重新生成，或检查浏览器扩展状态。');
    }
    if (!stored) throw new Error('这份导出记录已过期或不存在。请返回对话页重新生成。');
    state.conversation = validateConversation(stored);
    state.conversation.exportId = id;
  }

  function branchMessages() {
    if (!state.conversation) return [];
    const branch = state.conversation.branches?.find(item => item.id === state.branchId);
    if (!branch) return state.conversation.messages;
    const byId = new Map(state.conversation.messages.map(message => [message.id,message]));
    return branch.messageIds.map(id => byId.get(id)).filter(Boolean);
  }

  function initializeBranches() {
    const list = els['branch-select']; list.replaceChildren();
    const branches = state.conversation.branches || [];
    for (const branch of branches) {
      const option = root.document.createElement('option'); option.value=branch.id;
      option.textContent=`${branch.label} (${branch.messageIds.length} 条)`; list.append(option);
    }
    const all = root.document.createElement('option'); all.value='__all';all.textContent='全部分支（共同消息仅一次）';list.append(all);
    state.branchId = branches.some(branch => branch.id === state.conversation.activeBranchId) ? state.conversation.activeBranchId : '__all';
    list.value=state.branchId;
    const source=state.conversation.source;
    const names={api:'完整对话 API',shared:'共享对话',temporary:'临时对话',dom:'页面 DOM'};
    els['source-quality'].textContent=`${names[source?.kind] || '页面 DOM'} · ${source?.complete ? '已读取返回的完整消息树' : '部分数据，请留意提示'} · ${branches.length || 1} 个分支`;
    els['load-media'].disabled=!(state.conversation.assets?.length);
    els['source-caption'].textContent=source?.complete ? '消息树在本地解析，数据不经过自建服务器' : '未确认完整历史；仅导出本次实际取得的内容';
  }

  function selectedMessages() {
    if (!state.conversation) return [];
    return branchMessages().filter((message) => state.selected.has(message.id));
  }

  function currentConversation() {
    return Object.assign({}, state.conversation, { title: els['conversation-title'].value, selection:{branchId:state.branchId} });
  }

  function shortText(message) {
    const text = String(message.text || message.markdown || '').replace(/\s+/g, ' ').trim();
    return text || '（此消息没有可预览的文字）';
  }

  function renderList() {
    const list = els['message-list'];
    list.replaceChildren();
    const query = state.query.trim().toLocaleLowerCase();
    let visibleCount = 0;
    branchMessages().forEach((message, index) => {
      const searchable = `${ROLE_LABELS[message.role]} ${message.text} ${message.markdown}`.toLocaleLowerCase();
      if (query && !searchable.includes(query)) return;
      visibleCount += 1;

      const item = root.document.createElement('li');
      item.className = 'message-item';
      const label = root.document.createElement('label');
      label.className = 'message-card';
      const checkbox = root.document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selected.has(message.id);
      checkbox.setAttribute('aria-label', `选择 ${ROLE_LABELS[message.role]} 消息 ${index + 1}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(message.id);
        else state.selected.delete(message.id);
        renderSelection();
      });

      const body = root.document.createElement('span');
      body.className = 'message-card-content';
      const top = root.document.createElement('span');
      top.className = 'message-card-top';
      const role = root.document.createElement('span');
      role.className = 'role-label';
      role.textContent = ROLE_LABELS[message.role];
      const number = root.document.createElement('span');
      number.className = 'message-index';
      number.textContent = String(index + 1).padStart(2, '0');
      top.append(role, number);
      const snippet = root.document.createElement('span');
      snippet.className = 'message-snippet';
      snippet.textContent = shortText(message);
      body.append(top, snippet);
      label.append(checkbox, body);
      item.append(label);
      list.append(item);
    });
    els['list-empty'].hidden = visibleCount > 0;
    els['list-empty'].textContent = '没有匹配的消息';
    els['message-total'].textContent = `${branchMessages().length} 条`;
  }

  function renderPreview() {
    const renderSequence=++state.renderSequence;
    state.renderError=null;
    const selected = selectedMessages();
    const empty = selected.length === 0;
    els['preview-empty'].hidden = !empty;
    els['preview-paper'].hidden = empty;
    if (empty) {
      els['preview-content'].replaceChildren();
      state.renderPromise=Promise.resolve();
      return;
    }

    try {
      const output = root.GptExporter.renderHtmlFragment(currentConversation(), {
        includeMetadata: els['include-metadata'].checked,
        messages: selected
      });
      const stage=root.document.createElement('div');stage.innerHTML=output;
      els['preview-content'].replaceChildren(stage);
      state.renderPromise = root.GptExporter.enhanceRichContent
        ? root.GptExporter.enhanceRichContent(stage,state.conversation).catch(error => {if(renderSequence===state.renderSequence){state.renderError=error;showStatus('富内容渲染失败：'+error.message,'error');}})
        : Promise.resolve();
    } catch (error) {
      state.renderError=error;
      els['preview-content'].replaceChildren();
      showStatus('预览生成失败，请重新加载这份对话。', 'error');
    }
  }

  function renderSelection() {
    const count = state.selected.size;
    els['selection-count'].textContent = `已选择 ${count} 条`;
    renderPreview();
  }

  function applyTheme() {
    root.document.body.dataset.theme = state.preferences.theme;
    els['theme-toggle'].setAttribute('aria-pressed', String(state.preferences.theme === 'dark'));
    els['theme-toggle'].setAttribute('aria-label', state.preferences.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  }

  function setBusy(value) {
    state.busy=value;
    root.document.querySelectorAll('[data-format],[data-select],#message-list input,#copy-markdown,#print-document,#clear-data,#branch-select,#conversation-title,#include-metadata,#message-search,#load-media')
      .forEach(element => { element.disabled=value || (element.id==='load-media'&&!state.conversation?.assets?.length); });
  }

  async function hydrateSelectedAssets() {
    const ids=new Set(selectedMessages().map(message=>message.id));
    const explicitIds=new Set(selectedMessages().flatMap(message=>message.assetIds||[]));
    const assets=(state.conversation.assets||[]).filter(asset=>ids.has(asset.messageId)||explicitIds.has(asset.id));
    if (assets.length && root.GptExporter.loadConversationAssets) {
      await root.GptExporter.loadConversationAssets({...state.conversation,assets},{onProgress:progress=>showStatus(`正在嵌入媒体 ${progress.completed}/${progress.total}：${progress.name}`,'info')});
      const failed=assets.filter(asset=>asset.status!=='ready');
      if (failed.length) showStatus(`${failed.length} 个媒体无法嵌入，文档中会保留缺失提示。`,'error');
    }
    renderPreview();await state.renderPromise;
    if(state.renderError)throw new Error('富内容未能完成渲染，本次导出已停止：'+state.renderError.message);
  }

  function downloadResult(result) {
    const blob = new Blob([result.content], { type: result.mime });
    const href = root.URL.createObjectURL(blob);state.blobUrls.add(href);
    const anchor = root.document.createElement('a');
    const baseName = (els['conversation-title'].value || '对话导出')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100) || '对话导出';
    anchor.href = href;anchor.download = `${baseName}.${result.extension}`;anchor.hidden = true;
    root.document.body.append(anchor);anchor.click();anchor.remove();
    root.setTimeout(() => {root.URL.revokeObjectURL(href);state.blobUrls.delete(href);},30000);
  }

  async function saveBlob(format) {
    if (state.busy) return;
    const messages = selectedMessages();
    if (!messages.length) throw new Error('请先勾选至少一条消息。');
    setBusy(true);
    try {
      let renderedHtml, snapshot;
      if (format==='pdf'||format==='html') {
        showStatus('正在准备本地文档与媒体…','info');await hydrateSelectedAssets();
        snapshot=root.GptExporter.snapshotRichContent ? await root.GptExporter.snapshotRichContent(els['preview-content']) : els['preview-content'].cloneNode(true);
        renderedHtml=snapshot.innerHTML;
      }
      const options={format,includeMetadata:els['include-metadata'].checked,messages,renderedHtml};
      const result = format==='pdf' ? {
        content:await root.GptExporter.buildPdf({container:snapshot,conversation:currentConversation(),messages,
          includeMetadata:options.includeMetadata,pageSize:els['pdf-page-size'].value,orientation:els['pdf-orientation'].value}),
        mime:'application/pdf',extension:'pdf'
      } : root.GptExporter.serialize(currentConversation(),options);
      downloadResult(result);
      const failed=(state.conversation.assets||[]).filter(asset=>asset.status==='unavailable'&&messages.some(message=>message.id===asset.messageId));
      showStatus(`已生成 ${result.extension.toUpperCase()}，包含所选 ${messages.length} 条消息${failed.length?`；${failed.length} 个媒体缺失，已保留提示`:''}。`,failed.length?'error':'success');
    } finally {setBusy(false);}
  }

  async function copyMarkdown() {
    try {
      const messages = selectedMessages();
      if (!messages.length) throw new Error('请先勾选至少一条消息。');
      const result = root.GptExporter.serialize(currentConversation(), {
        format: 'markdown',
        includeMetadata: els['include-metadata'].checked,
        messages
      });
      if (!root.navigator.clipboard || typeof root.navigator.clipboard.writeText !== 'function') {
        throw new Error('此浏览器未提供剪贴板权限。');
      }
      await root.navigator.clipboard.writeText(result.content);
      showStatus(`已复制所选的 ${messages.length} 条消息为 Markdown。`);
    } catch (error) {
      showStatus(error && error.message ? error.message : '复制失败，请检查剪贴板权限。', 'error');
    }
  }

  async function printDocument() {
    try {
      if (!selectedMessages().length) throw new Error('请先勾选至少一条消息。');
      await state.renderPromise;root.print();
      showStatus('已打开打印对话框，可选择“保存为 PDF”。', 'info');
    } catch (error) {
      showStatus(error && error.message ? error.message : '无法打开打印对话框。', 'error');
    }
  }

  async function clearCurrentData() {
    const key = state.storageKey;
    state.conversation = null;
    state.renderSequence++;
    for (const href of state.blobUrls) root.URL.revokeObjectURL(href);
    state.blobUrls.clear();
    state.selected.clear();
    state.storageKey = '';
    renderClearedState();
    const session = getChromeArea('session');
    if (key && session) {
      try {
        await session.remove(key);
        showStatus('本次会话中的导出数据已清除。');
      } catch (_) {
        state.storageKey = key;
        showStatus('内存中的数据已清除；会话存储清理失败，请稍后重试。', 'error');
      }
    } else {
      showStatus('本页中的示例或临时数据已清除。');
    }
  }

  function renderClearedState() {
    showLoadError('本次导出数据已清除', '如需再次导出，请返回对话页重新生成。');
  }

  function bindEvents() {
    els['branch-select'].addEventListener('change',()=>{
      state.branchId=els['branch-select'].value;
      state.selected=new Set(branchMessages().map(message=>message.id));renderList();renderSelection();
    });
    els['load-media'].addEventListener('click',async()=>{
      if(state.busy||!state.conversation)return;setBusy(true);
      try{await hydrateSelectedAssets();showStatus('媒体读取完成。不可用的文件已在预览中标出。');}
      catch(error){showStatus(error.message,'error');}finally{setBusy(false);}
    });
    els['message-search'].addEventListener('input', () => {
      state.query = els['message-search'].value;
      renderList();
    });
    els['conversation-title'].addEventListener('input', renderPreview);
    els['include-metadata'].addEventListener('change', () => {
      state.preferences.includeMetadata = els['include-metadata'].checked;
      renderPreview();
      savePreferences();
    });
    els['theme-toggle'].addEventListener('click', () => {
      state.preferences.theme = state.preferences.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      savePreferences();
    });
    els['clear-data'].addEventListener('click', clearCurrentData);
    els['copy-markdown'].addEventListener('click', copyMarkdown);
    els['print-document'].addEventListener('click', printDocument);
    els['reload-demo'].addEventListener('click', () => { root.location.search = '?demo=1'; });

    root.document.querySelectorAll('[data-select]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.dataset.select;
        if (action === 'all') branchMessages().forEach((message) => state.selected.add(message.id));
        else if (action === 'none') state.selected.clear();
        else if (action === 'user' || action === 'assistant') {
          state.selected.clear();
          branchMessages().filter((message) => message.role === action).forEach((message) => state.selected.add(message.id));
        }
        renderList();
        renderSelection();
      });
    });
    root.document.querySelectorAll('[data-format]').forEach((button) => {
      button.addEventListener('click', async () => {
        try { await saveBlob(button.dataset.format); }
        catch (error) { showStatus(error && error.message ? error.message : '生成导出文件失败。', 'error'); }
      });
    });
    root.document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !/^(INPUT|TEXTAREA)$/.test(event.target.tagName)) {
        event.preventDefault();
        els['message-search'].focus();
      }
    });
  }

  async function init() {
    cacheElements();
    bindEvents();
    await loadPreferences();
    applyTheme();
    els['include-metadata'].checked = state.preferences.includeMetadata;
    try {
      await loadConversation();
      clearLoadError();
      initializeBranches();
      state.selected = new Set(branchMessages().map((message) => message.id));
      els['conversation-title'].value = state.conversation.title;
      renderList();
      renderSelection();
      if (new URLSearchParams(root.location.search).get('demo') === '1') {
        showStatus('示例数据仅用于预览界面；真实导出只读取已加载的对话 DOM。', 'info');
      }
    } catch (error) {
      showLoadError('无法打开这份导出', error && error.message ? error.message : '数据无效或已过期。');
    }
  }

  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(globalThis);
