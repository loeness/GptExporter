(() => {
  'use strict';
  if (globalThis.__gptExporterContentLoaded) return;
  globalThis.__gptExporterContentLoaded = true;
  const api = globalThis.GptExporter;
  let busy = false, closeTimer = 0;

  async function collect() {
    const url = location.href;
    const platform = api.getPlatform(url);
    if (!platform) throw new Error('当前网站暂不支持对话导出。');
    const conversation = platform.id === 'chatgpt' ? await api.collectConversation({document, url}) : api.collectPlatformConversation({document, url});
    if (url !== location.href) throw new Error('对话已切换，请在当前对话重新导出。');
    if (!conversation?.messages.length) throw new Error(`未识别到 ${platform.label} 对话消息，请打开具体对话并等待加载；页面结构变化时可能需要更新适配。`);
    return conversation;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'GPT_EXPORTER_PROGRESS') {
      if (busy && typeof message.text === 'string') status.textContent = message.text.slice(0,100);
      respond({ok:true}); return false;
    }
    if (message?.type === 'GPT_EXPORTER_RESOLVE_ASSET') {
      if (api.getPlatform(location.href)?.id !== 'chatgpt') { respond({ok:false,error:'此平台暂不支持读取原始附件。'}); return false; }
      api.resolveAsset(message.asset,{source:message.source,url:message.url})
        .then(asset=>respond({ok:true,asset})).catch(error=>respond({ok:false,error:error.message}));
      return true;
    }
    if (message?.type !== 'GPT_EXPORTER_COLLECT') return false;
    collect().then(conversation=>respond({ok:true,conversation})).catch(error=>respond({ok:false,error:error.message}));
    return true;
  });

  const host = document.createElement('div'); host.id = 'gpt-exporter-launcher';
  const shadow = host.attachShadow({mode:'open'});
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial;position:fixed;right:24px;bottom:92px;z-index:2147483600;font:14px system-ui,sans-serif;color:#243833;color-scheme:light}
    *{box-sizing:border-box}[hidden]{display:none!important}.split{display:flex;position:relative;justify-content:flex-end}
    button{font:500 14px system-ui,sans-serif;cursor:pointer}button:disabled{cursor:wait;opacity:.65}
    button:focus-visible{outline:3px solid #80d5bc;outline-offset:3px}
    .select,.toggle{height:42px;border:1px solid #5c8e82;background:#164b41;color:#fff;box-shadow:0 3px 12px #0002}
    .select{border-radius:10px 0 0 10px;padding:0 18px;letter-spacing:.5px;font-weight:600}
    .toggle{display:flex;align-items:center;justify-content:center;padding:0;line-height:1;border-left:1px solid #ffffff40;border-radius:0 10px 10px 0;width:44px}
    .toggle svg{display:block;width:24px;height:24px;pointer-events:none}
    .select:hover,.toggle:hover,.toggle[aria-expanded=true]{background:#216455}
    .menu{position:absolute;right:0;bottom:100%;padding-bottom:8px;min-width:164px}
    .options{background:#fff;border:1px solid #dedee4;border-radius:8px;padding:6px;box-shadow:0 5px 14px #0002}
    .menu button{display:block;text-align:left;width:100%;border:0;border-radius:5px;background:transparent;color:#171717;padding:10px 12px;white-space:nowrap}
    .menu button:hover,.menu button:focus-visible{background:#eaf4ef}
    .status{max-width:300px;margin:10px 0 0 auto;background:#fff;color:#243833;border:1px solid #ccdcd5;border-radius:10px;padding:12px;line-height:1.5;box-shadow:0 4px 18px #0002}.status:empty{display:none}
    @media(max-width:480px){:host{right:12px;bottom:84px}}@media print{:host{display:none}}
  `;
  const split = document.createElement('div'); split.className = 'split';
  const select = document.createElement('button'); select.id = 'gpt-exporter-select'; select.className = 'select'; select.type = 'button';
  select.textContent = 'SELECT'; select.title = '打开导出页面，选择消息与文件格式'; select.setAttribute('aria-label','打开对话导出页面');
  const toggle = document.createElement('button'); toggle.id = 'gpt-exporter-menu-toggle'; toggle.className = 'toggle'; toggle.type = 'button';
  const arrow = document.createElementNS('http://www.w3.org/2000/svg','svg'); arrow.setAttribute('viewBox','0 0 24 24'); arrow.setAttribute('aria-hidden','true');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg','path'); arrowPath.setAttribute('d','M6 9l6 6 6-6'); arrowPath.setAttribute('fill','none'); arrowPath.setAttribute('stroke','currentColor'); arrowPath.setAttribute('stroke-width','2.4'); arrowPath.setAttribute('stroke-linecap','round'); arrowPath.setAttribute('stroke-linejoin','round');
  arrow.append(arrowPath); toggle.append(arrow); toggle.title = '快捷导出 PDF'; toggle.setAttribute('aria-label','快捷导出范围');
  toggle.setAttribute('aria-haspopup','menu'); toggle.setAttribute('aria-controls','gpt-exporter-selection-menu'); toggle.setAttribute('aria-expanded','false');
  const menu = document.createElement('div'); menu.id = 'gpt-exporter-selection-menu'; menu.className = 'menu'; menu.hidden = true;
  menu.setAttribute('role','menu'); menu.setAttribute('aria-label','直接导出 PDF');
  const options = document.createElement('div'); options.className = 'options'; options.setAttribute('role','none');
  const buttons = [['all','All','导出全部消息'],['questions','Questions','仅导出提问'],['answers','Answers','仅导出回答']].map(([preset,label,title]) => {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.preset = preset;
    button.textContent = label; button.title = title + '，直接保存 PDF'; button.setAttribute('role','menuitem');
    button.addEventListener('click', () => launch(preset)); options.append(button); return button;
  });
  const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
  menu.append(options); split.append(select,toggle,menu); shadow.append(style,split,status); document.documentElement.append(host);

  function cancelClose() { clearTimeout(closeTimer); closeTimer = 0; }
  function closeMenu(restoreFocus = false) {
    cancelClose(); menu.hidden = true; toggle.setAttribute('aria-expanded','false');
    if (restoreFocus) toggle.focus();
  }
  function openMenu(focusIndex) {
    if (busy) return;
    cancelClose(); menu.hidden = false; toggle.setAttribute('aria-expanded','true');
    if (focusIndex !== undefined) buttons[focusIndex].focus();
  }
  function scheduleClose() {
    cancelClose(); closeTimer = setTimeout(() => {
      if (!menu.matches(':hover') && !toggle.matches(':hover') && !buttons.includes(shadow.activeElement)) closeMenu();
    },180);
  }
  toggle.addEventListener('pointerenter', event => { if (event.pointerType !== 'touch') openMenu(); });
  toggle.addEventListener('pointerleave', scheduleClose);
  menu.addEventListener('pointerenter', cancelClose); menu.addEventListener('pointerleave', scheduleClose);
  toggle.addEventListener('click', () => openMenu(0));
  toggle.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openMenu(event.key === 'ArrowDown' ? 0 : buttons.length - 1); }
    else if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
  });
  menu.addEventListener('keydown', event => {
    const index = buttons.indexOf(shadow.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
    else if (event.key === 'Tab') closeMenu();
    else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  });
  document.addEventListener('pointerdown', event => { if (!event.composedPath().includes(host)) closeMenu(); },true);
  document.addEventListener('focusin', event => { if (!event.composedPath().includes(host)) closeMenu(); },true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault(); event.stopPropagation();
      closeMenu(shadow.activeElement === toggle || buttons.includes(shadow.activeElement));
    }
  },true);
  addEventListener('popstate', () => closeMenu());
  addEventListener('hashchange', () => closeMenu());

  function setBusy(value) {
    busy = value;
    for (const button of [select,toggle,...buttons]) button.disabled = value;
    select.textContent = value ? '正在处理…' : 'SELECT';
  }
  async function launch(preset) {
    if (busy) return;
    const returnFocus = shadow.activeElement === select || shadow.activeElement === toggle || buttons.includes(shadow.activeElement);
    setBusy(true); closeMenu();
    status.textContent = preset ? '正在读取对话并生成 PDF…' : '正在读取对话…';
    try {
      const conversation = await collect();
      const response = await chrome.runtime.sendMessage(preset ? {type:'GPT_EXPORTER_QUICK',conversation,preset,format:'pdf'} : {type:'GPT_EXPORTER_OPEN',conversation});
      if (!response?.ok) throw new Error(response?.error || '导出失败，请重试。');
      status.textContent = preset ? `已导出 ${response.count} 条消息为 PDF${response.missingAssets ? `；${response.missingAssets} 个媒体缺失，文件中保留提示` : ''}。` : '';
    } catch (error) { status.textContent = error.message || '扩展已更新，请刷新本页后重试。'; }
    finally {
      setBusy(false);
      if (returnFocus && [host,document.body].includes(document.activeElement)) (preset ? toggle : select).focus();
    }
  }
  select.addEventListener('click', () => launch());
})();
