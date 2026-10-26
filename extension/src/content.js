(() => {
  'use strict';
  if (globalThis.__gptExporterContentLoaded) return;
  globalThis.__gptExporterContentLoaded = true;

  function collect() {
    const conversation = globalThis.GptExporter.extractConversation(document, location.href);
    if (!conversation.messages.length) throw new Error('未找到对话，请打开一段 ChatGPT 对话并等待加载。');
    return conversation;
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'GPT_EXPORTER_COLLECT') return false;
    try { respond({ok: true, conversation: collect()}); }
    catch (error) { respond({ok: false, error: error.message}); }
    return false;
  });

  const host = document.createElement('div');
  host.id = 'gpt-exporter-launcher';
  const shadow = host.attachShadow({mode: 'closed'});
  const style = document.createElement('style');
  style.textContent = ':host{all:initial;position:fixed;right:24px;bottom:92px;z-index:2147483600;font:14px system-ui,sans-serif}button{border:1px solid #5c8e82;background:#164b41;color:white;border-radius:999px;padding:11px 18px;box-shadow:0 4px 18px #0002;cursor:pointer;font:600 14px system-ui}button:hover{background:#216455}button:focus-visible{outline:3px solid #80d5bc;outline-offset:3px}button:disabled{opacity:.6}p{max-width:260px;background:#fff;color:#243833;border:1px solid #ccdcd5;border-radius:10px;padding:12px;line-height:1.5;box-shadow:0 4px 18px #0002}p:empty{display:none}@media print{:host{display:none}}';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '↗ 导出对话';
  button.title = 'GptExporter · 预览并导出已加载的对话';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      const response = await chrome.runtime.sendMessage({type: 'GPT_EXPORTER_OPEN', conversation: collect()});
      if (!response?.ok) throw new Error(response?.error || '无法打开预览。');
    } catch (error) { status.textContent = error.message || '扩展已更新，请刷新本页后重试。'; }
    finally { button.disabled = false; }
  });
  shadow.append(style, button, status);
  document.documentElement.append(host);
})();
