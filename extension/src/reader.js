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
    statusTimer: 0
  };

  function byId(id) { return root.document.getElementById(id); }

  function cacheElements() {
    [
      'message-total', 'message-search', 'message-list', 'list-empty', 'selection-count',
      'conversation-title', 'include-metadata', 'copy-markdown', 'print-document',
      'theme-toggle', 'clear-data', 'preview-paper', 'preview-content', 'preview-empty',
      'load-error', 'error-title', 'error-detail', 'reload-demo', 'status-line',
      'source-caption'
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
    if (value.schemaVersion !== 1) throw new TypeError('数据版本不受支持。');
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
  }

  function selectedMessages() {
    if (!state.conversation) return [];
    return state.conversation.messages.filter((message) => state.selected.has(message.id));
  }

  function currentConversation() {
    return Object.assign({}, state.conversation, { title: els['conversation-title'].value });
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
    state.conversation.messages.forEach((message, index) => {
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
    els['message-total'].textContent = `${state.conversation.messages.length} 条`;
  }

  function renderPreview() {
    const selected = selectedMessages();
    const empty = selected.length === 0;
    els['preview-empty'].hidden = !empty;
    els['preview-paper'].hidden = empty;
    if (empty) {
      els['preview-content'].replaceChildren();
      return;
    }

    try {
      const output = root.GptExporter.renderHtmlFragment(currentConversation(), {
        includeMetadata: els['include-metadata'].checked,
        messages: selected
      });
      els['preview-content'].innerHTML = output;
    } catch (_) {
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

  function saveBlob(format) {
    const messages = selectedMessages();
    if (!messages.length) throw new Error('请先勾选至少一条消息。');
    const result = root.GptExporter.serialize(currentConversation(), {
      format,
      includeMetadata: els['include-metadata'].checked,
      messages
    });
    const blob = new Blob([result.content], { type: result.mime });
    const href = root.URL.createObjectURL(blob);
    const anchor = root.document.createElement('a');
    const baseName = (els['conversation-title'].value || '对话导出')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || '对话导出';
    anchor.href = href;
    anchor.download = `${baseName}.${result.extension}`;
    anchor.hidden = true;
    root.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    root.setTimeout(() => root.URL.revokeObjectURL(href), 30000);
    showStatus(`已生成 ${result.extension.toUpperCase()} 文件，仅含所选的 ${messages.length} 条消息。`);
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

  function printDocument() {
    try {
      if (!selectedMessages().length) throw new Error('请先勾选至少一条消息。');
      root.print();
      showStatus('已打开打印对话框，可选择“保存为 PDF”。', 'info');
    } catch (error) {
      showStatus(error && error.message ? error.message : '无法打开打印对话框。', 'error');
    }
  }

  async function clearCurrentData() {
    const key = state.storageKey;
    state.conversation = null;
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
        if (action === 'all') state.conversation.messages.forEach((message) => state.selected.add(message.id));
        else if (action === 'none') state.selected.clear();
        else if (action === 'user' || action === 'assistant') {
          state.selected.clear();
          state.conversation.messages.filter((message) => message.role === action).forEach((message) => state.selected.add(message.id));
        }
        renderList();
        renderSelection();
      });
    });
    root.document.querySelectorAll('[data-format]').forEach((button) => {
      button.addEventListener('click', () => {
        try { saveBlob(button.dataset.format); }
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
      state.selected = new Set(state.conversation.messages.map((message) => message.id));
      clearLoadError();
      els['conversation-title'].value = state.conversation.title;
      els['source-caption'].textContent = '只读取浏览器中已加载的对话 DOM';
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
