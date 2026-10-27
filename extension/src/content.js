(() => {
  'use strict';
  if (globalThis.__gptExporterContentLoaded) return;
  globalThis.__gptExporterContentLoaded = true;

  const api = globalThis.GptExporter;
  const presets = [
    ['all', 'All (default)', '选择全部消息'],
    ['questions', 'Questions', '仅选择问题'],
    ['answers', 'Answers', '仅选择回答'],
    ['none', 'None', '取消全部选择']
  ];
  const labels = {user:'问题', assistant:'回答', system:'系统消息', tool:'工具消息'};
  const records = new Map(), overrides = new Map(), nodeKeys = new WeakMap();
  let nextNodeKey = 0, selectionActive = false, preset = 'all', busy = false;
  let pageUrl = location.href, routeVersion = 0, refreshFrame = 0;

  function matchesPreset(role, value = preset) {
    return value === 'all' || (value === 'questions' && role === 'user') || (value === 'answers' && role === 'assistant');
  }

  function isSelected(record) {
    return overrides.has(record.key) ? overrides.get(record.key) : matchesPreset(record.role);
  }

  function normalizeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

  async function collect() {
    resetOnNavigation();
    const url = pageUrl, version = routeVersion, active = selectionActive, chosenPreset = preset;
    const choices = [...overrides].map(([key, selected]) => {
      const record = records.get(key);
      return {...record, text: record.element.isConnected ? api.messageText(record.element) : record.text, selected};
    });
    const conversation = await api.collectConversation({document, url});
    if (version !== routeVersion || url !== location.href) throw new Error('对话已切换，请在当前对话重新导出。');
    if (!conversation.messages.length) throw new Error('未找到对话，请打开一段 ChatGPT 对话并等待加载。');
    if (active) {
      const messagesById = new Map(conversation.messages.map(message => [message.id, message]));
      const branch = conversation.branches?.find(item => item.id === conversation.activeBranchId);
      const currentMessages = branch ? branch.messageIds.map(id => messagesById.get(id)).filter(Boolean) : conversation.messages;
      const resolved = new Map();
      for (const choice of choices) {
        // Stable ChatGPT IDs survive DOM virtualization. For pages without IDs,
        // accept a text match only when it identifies exactly one current message.
        let match = choice.explicitId ? messagesById.get(choice.id) : null;
        if (!match) {
          const candidates = currentMessages.filter(message => message.role === choice.role &&
            normalizeText(message.text) === normalizeText(choice.text));
          if (candidates.length === 1) match = candidates[0];
        }
        if (!match || resolved.has(match.id)) throw new Error('无法确认某条手动选择的消息，请重新选择，或选择 All 后重试。');
        resolved.set(match.id, choice.selected);
      }
      conversation.initialSelection = {preset: chosenPreset, overrides: [...resolved].map(([id, selected]) => ({id, selected}))};
    }
    return conversation;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'GPT_EXPORTER_RESOLVE_ASSET') {
      api.resolveAsset(message.asset,{source:message.source,url:message.url})
        .then(asset=>respond({ok:true,asset})).catch(error=>respond({ok:false,error:error.message}));
      return true;
    }
    if (message?.type !== 'GPT_EXPORTER_COLLECT') return false;
    collect().then(conversation=>respond({ok:true,conversation})).catch(error=>respond({ok:false,error:error.message}));
    return true;
  });

  const host = document.createElement('div');
  host.id = 'gpt-exporter-launcher';
  const shadow = host.attachShadow({mode: 'open'});
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial;position:fixed;right:24px;bottom:92px;z-index:2147483600;font:14px system-ui,sans-serif;color:#243833;color-scheme:light}
    *{box-sizing:border-box}[hidden]{display:none!important}
    .toolbar{display:flex;align-items:center;gap:10px}.split{display:flex;position:relative;flex-shrink:0}
    button{font:500 14px system-ui,sans-serif;cursor:pointer}button:disabled{cursor:wait;opacity:.6}
    button:focus-visible{outline:3px solid #bf83ff;outline-offset:3px}
    .select,.toggle{border:1px solid #a34cff;background:#fff;color:#9436ed;height:40px;box-shadow:0 2px 6px #0001}
    .select{border-radius:7px 0 0 7px;padding:0 14px;letter-spacing:1px;font-size:12px}
    .select[aria-pressed=true]{background:#f5eaff}.toggle{border-left:0;border-radius:0 7px 7px 0;width:36px;font-size:18px}
    .select:hover,.toggle:hover,.toggle[aria-expanded=true]{background:#f5eaff}
    .menu{position:absolute;left:0;bottom:calc(100% + 8px);min-width:164px;background:#fff;border:1px solid #dedee4;border-radius:8px;padding:6px;box-shadow:0 5px 14px #0002}
    .menu button{display:flex;align-items:center;gap:10px;text-align:left;width:100%;border:0;border-radius:5px;background:transparent;color:#171717;padding:9px 8px;white-space:nowrap}
    .menu button::before{content:'✓';width:14px;color:#9436ed;visibility:hidden}.menu button[aria-checked=true]::before{visibility:visible}
    .menu button:hover,.menu button:focus-visible{background:#f5eaff}
    .export{border:1px solid #5c8e82;background:#164b41;color:#fff;border-radius:999px;padding:11px 18px;box-shadow:0 4px 18px #0002;font-weight:600;white-space:nowrap}
    .export:hover{background:#216455}.summary{font-size:12px;text-align:right;margin:8px 5px 0;color:#5e297b;background:#fff;border-radius:6px;padding:5px 8px;box-shadow:0 2px 6px #0001}
    .status{max-width:300px;margin:10px 0 0 auto;background:#fff;color:#243833;border:1px solid #ccdcd5;border-radius:10px;padding:12px;line-height:1.5;box-shadow:0 4px 18px #0002}.status:empty{display:none}
    @media(max-width:480px){:host{right:12px;bottom:84px}.toolbar{gap:7px}.export{padding:11px 13px}}
    @media print{:host{display:none}}
  `;
  const toolbar = document.createElement('div'); toolbar.className = 'toolbar';
  const split = document.createElement('div'); split.className = 'split';
  const selectButton = document.createElement('button');
  selectButton.id = 'gpt-exporter-select'; selectButton.className = 'select'; selectButton.type = 'button';
  selectButton.textContent = 'SELECT'; selectButton.setAttribute('aria-label','选择导出的消息'); selectButton.setAttribute('aria-pressed','false');
  selectButton.title = '显示消息复选框；再次点击退出选择并恢复全部';
  const toggle = document.createElement('button');
  toggle.id = 'gpt-exporter-menu-toggle'; toggle.className = 'toggle'; toggle.type = 'button'; toggle.textContent = '⌄';
  toggle.setAttribute('aria-label','选择消息范围'); toggle.setAttribute('aria-haspopup','menu');
  toggle.setAttribute('aria-controls','gpt-exporter-selection-menu'); toggle.setAttribute('aria-expanded','false');
  const menu = document.createElement('div'); menu.id = 'gpt-exporter-selection-menu'; menu.className = 'menu'; menu.hidden = true;
  menu.setAttribute('role','menu'); menu.setAttribute('aria-label','导出消息范围');
  const menuButtons = presets.map(([value, label, description]) => {
    const option = document.createElement('button'); option.type = 'button'; option.dataset.preset = value;
    option.setAttribute('role','menuitemradio'); option.setAttribute('aria-checked',String(value === preset));
    option.title = description; option.textContent = label;
    option.addEventListener('click', () => {
      if (busy) return;
      resetOnNavigation(); preset = value; overrides.clear(); selectionActive = true;
      status.textContent = ''; refreshControls(); closeMenu(true);
    });
    menu.append(option); return option;
  });
  const exportButton = document.createElement('button');
  exportButton.id = 'gpt-exporter-export'; exportButton.className = 'export'; exportButton.type = 'button'; exportButton.textContent = '↗ 导出对话';
  exportButton.title = 'GptExporter · 预览并导出所选对话消息';
  const summary = document.createElement('p'); summary.className = 'summary'; summary.hidden = true;
  summary.setAttribute('role','status'); summary.setAttribute('aria-live','polite');
  const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status');
  split.append(selectButton, toggle, menu); toolbar.append(split, exportButton); shadow.append(style, toolbar, summary, status);
  document.documentElement.append(host);

  function closeMenu(restoreFocus = false) {
    menu.hidden = true; toggle.setAttribute('aria-expanded','false');
    if (restoreFocus) toggle.focus();
  }

  function openMenu(focusIndex) {
    if (busy) return;
    resetOnNavigation(); menu.hidden = false; toggle.setAttribute('aria-expanded','true');
    menuButtons[focusIndex ?? Math.max(0, presets.findIndex(item => item[0] === preset))].focus();
  }

  toggle.addEventListener('click', () => { if (menu.hidden) openMenu(); else closeMenu(true); });
  toggle.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); openMenu(event.key === 'ArrowDown' ? 0 : menuButtons.length - 1);
    }
  });
  menu.addEventListener('keydown', event => {
    const index = menuButtons.indexOf(shadow.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    else if (event.key === 'Tab') closeMenu();
    else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? menuButtons.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + menuButtons.length) % menuButtons.length;
      menuButtons[next].focus();
    }
  });
  document.addEventListener('pointerdown', event => { if (!event.composedPath().includes(host)) closeMenu(); }, true);
  document.addEventListener('focusin', event => { if (!event.composedPath().includes(host)) closeMenu(); }, true);
  selectButton.addEventListener('click', () => {
    resetOnNavigation(); selectionActive = !selectionActive;
    if (!selectionActive) { preset = 'all'; overrides.clear(); }
    closeMenu(); status.textContent = ''; refreshControls();
  });

  function updateSummary() {
    const visible = [...records.values()].filter(record => record.mounted && record.control.isConnected);
    const selected = visible.filter(isSelected).length;
    summary.hidden = !selectionActive;
    const text = `当前页面已选 ${selected} / ${visible.length} 条`;
    if (summary.textContent !== text) summary.textContent = text;
    summary.title = '范围选项同时应用于完整历史；可在导出预览中继续选择分支与消息。';
    selectButton.setAttribute('aria-pressed', String(selectionActive));
    for (const option of menuButtons) option.setAttribute('aria-checked',String(option.dataset.preset === preset));
  }

  function createControl(record) {
    const control = document.createElement('span'); control.setAttribute('data-gpt-exporter-selection', record.key);
    const root = control.attachShadow({mode:'open'});
    const controlStyle = document.createElement('style');
    controlStyle.textContent = ':host{all:initial;display:block;margin:0 0 8px;width:fit-content;color-scheme:light}:host([hidden]){display:none}label{display:inline-flex;align-items:center;gap:7px;padding:5px 9px;border:1px solid #d8c2e8;background:#fff;border-radius:7px;color:#643383;font:12px system-ui,sans-serif;cursor:pointer}label:has(input:checked){background:#f5eaff;border-color:#a34cff}input{accent-color:#9436ed;width:16px;height:16px;margin:0;cursor:pointer}input:focus-visible{outline:3px solid #bf83ff;outline-offset:3px}@media print{:host{display:none}}';
    const label = document.createElement('label');
    const input = document.createElement('input'); input.type = 'checkbox';
    const text = document.createElement('span');
    label.append(input, text); root.append(controlStyle, label);
    record.control = control; record.input = input; record.label = text;
    input.addEventListener('change', () => {
      if (busy) return;
      record.text = api.messageText(record.element);
      if (input.checked === matchesPreset(record.role)) overrides.delete(record.key);
      else overrides.set(record.key, input.checked);
      updateSummary();
    });
  }

  function refreshControls() {
    if (resetOnNavigation()) return;
    if (!selectionActive) {
      for (const record of records.values()) { record.control?.remove(); record.mounted = false; }
      updateSummary(); return;
    }
    const mounted = new Set();
    for (const entry of api.messageElements(document)) {
      let key = entry.explicitId ? 'id:' + entry.id : nodeKeys.get(entry.element);
      if (!key) { key = 'node:' + (++nextNodeKey); nodeKeys.set(entry.element, key); }
      let record = records.get(key);
      if (!record) { record = {key}; records.set(key, record); createControl(record); }
      Object.assign(record, entry);
      record.mounted = true; mounted.add(key);
      record.input.checked = isSelected(record); record.input.disabled = busy;
      record.input.setAttribute('aria-label', `选择${labels[record.role] || '消息'}`);
      record.label.textContent = labels[record.role] || '消息';
      if (record.control.parentNode !== entry.element) entry.element.prepend(record.control);
    }
    for (const [key, record] of records) {
      if (!mounted.has(key)) {
        record.control.remove(); record.mounted = false;
        if (!overrides.has(key)) records.delete(key);
      }
    }
    updateSummary();
  }

  function resetOnNavigation() {
    if (pageUrl === location.href) return false;
    pageUrl = location.href; routeVersion++;
    selectionActive = false; preset = 'all'; overrides.clear();
    for (const record of records.values()) record.control?.remove();
    records.clear(); closeMenu(); status.textContent = ''; updateSummary();
    return true;
  }

  function setBusy(value) {
    busy = value;
    for (const button of [selectButton, toggle, exportButton, ...menuButtons]) button.disabled = value;
    for (const record of records.values()) record.input.disabled = value;
  }

  exportButton.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true); closeMenu(); status.textContent = '';
    try {
      exportButton.textContent = '正在读取完整对话…';
      const response = await chrome.runtime.sendMessage({type: 'GPT_EXPORTER_OPEN', conversation: await collect()});
      if (!response?.ok) throw new Error(response?.error || '无法打开预览。');
    } catch (error) { status.textContent = error.message || '扩展已更新，请刷新本页后重试。'; }
    finally { setBusy(false); exportButton.textContent = '↗ 导出对话'; }
  });

  const observer = new MutationObserver(changes => {
    // Ignore our own UI writes, and coalesce streaming DOM changes per frame.
    if (!changes.some(change => change.target !== host && !host.contains(change.target) &&
      !change.target.parentElement?.closest('[data-gpt-exporter-selection]') &&
      !(change.type === 'childList' && [...change.addedNodes, ...change.removedNodes].every(node =>
        node.nodeType === 1 && node.hasAttribute('data-gpt-exporter-selection'))))) return;
    if (!refreshFrame) refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; refreshControls(); });
  });
  observer.observe(document.documentElement, {subtree:true,childList:true,characterData:true,attributes:true,
    attributeFilter:['data-message-id','data-message-author-role','data-author-role','data-role','hidden','aria-hidden']});
  addEventListener('popstate', resetOnNavigation);
  addEventListener('hashchange', resetOnNavigation);
  // pushState does not have a DOM or popstate event; compare only the URL here.
  setInterval(resetOnNavigation, 750);
})();
