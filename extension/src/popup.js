'use strict';
const launchButton = document.getElementById('open');
const statusLine = document.getElementById('status');

launchButton.addEventListener('click', async () => {
  launchButton.disabled = true;
  statusLine.textContent = '正在读取页面已加载的消息…';
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) {
      throw new Error('请在 ChatGPT 对话页面使用此按钮。');
    }
    let collected;
    try { collected = await chrome.tabs.sendMessage(tab.id, {type: 'GPT_EXPORTER_COLLECT'}); }
    catch {
      // Covers already-open ChatGPT tabs when the extension was just installed/reloaded.
      await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['src/conversation.js', 'src/content.js']});
      collected = await chrome.tabs.sendMessage(tab.id, {type: 'GPT_EXPORTER_COLLECT'});
    }
    if (!collected?.ok) throw new Error(collected?.error || '没有找到可导出的消息。');
    const result = await chrome.runtime.sendMessage({type: 'GPT_EXPORTER_OPEN', conversation: collected.conversation});
    if (!result?.ok) throw new Error(result?.error || '无法打开预览。');
    statusLine.textContent = '预览已在新标签页打开。';
    window.close();
  } catch (error) { statusLine.textContent = error.message || '读取失败，请刷新 ChatGPT 后重试。'; }
  finally { launchButton.disabled = false; }
});
