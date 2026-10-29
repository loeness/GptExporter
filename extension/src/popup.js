'use strict';
const launchButton = document.getElementById('open');
const statusLine = document.getElementById('status');

launchButton.addEventListener('click', async () => {
  launchButton.disabled = true;
  statusLine.textContent = '正在读取当前对话…';
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    const platform = globalThis.GptExporter.getPlatform(tab?.url);
    if (!tab?.id || !platform) {
      throw new Error('请在支持的 AI 对话页面使用此按钮（ChatGPT、Claude、Qwen、DeepSeek、Kimi、Gemini、豆包、Grok）。');
    }
    let collected;
    try { collected = await chrome.tabs.sendMessage(tab.id, {type: 'GPT_EXPORTER_COLLECT'}); }
    catch {
      // Reconnect already-open supported tabs after installing or reloading the extension.
      if (platform.id === 'chatgpt') await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['src/page-bridge.js']});
      await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['src/platforms.js','src/conversation.js',...(platform.id === 'chatgpt' ? ['src/history.js'] : []),'src/content.js']});
      collected = await chrome.tabs.sendMessage(tab.id, {type: 'GPT_EXPORTER_COLLECT'});
    }
    if (!collected?.ok) throw new Error(collected?.error || '没有找到可导出的消息。');
    collected.conversation.source = {...collected.conversation.source,sourceTabId:tab.id};
    const result = await chrome.runtime.sendMessage({type: 'GPT_EXPORTER_OPEN', conversation: collected.conversation});
    if (!result?.ok) throw new Error(result?.error || '无法打开预览。');
    statusLine.textContent = '预览已在新标签页打开。';
    window.close();
  } catch (error) { statusLine.textContent = error.message || '读取失败，请刷新 ChatGPT 后重试。'; }
  finally { launchButton.disabled = false; }
});
