# 实现与数据流

```text
ChatGPT DOM → conversation.js → content.js / popup.js
  → background.js 校验、限制大小、生成随机 ID
  → chrome.storage.session[export:<id>]
  → reader.html 消息选择与本地预览
  → exporters.js → Markdown / TXT / HTML / JSON / CSV
                   或浏览器 print → PDF
```

内容脚本只在两个 ChatGPT 域名执行，保持在扩展的隔离世界；没有注入页面主世界，没有拦截 fetch，没有访问会话 API。浮动入口使用 Shadow DOM，避免与网页样式冲突。弹窗遇到安装前已打开的页面时，可通过 `activeTab` 临时授权注入同一组幂等脚本。

服务工作线程验证消息来源和数据类型，按顺序创建预览，避免并发写入破坏缓存预算。创建标签页失败会回滚新增缓存。数据只存在 `storage.session`；服务工作线程休眠不影响已创建预览，浏览器重启会清空对话缓存。24 小时过期清理在下次打开预览时执行，没有定时后台任务。

HTML 在 DOM 解析和导出时各自清理。预览使用语义标签允许列表，不带原网页样式、事件属性、iframe 或可执行 URL；图片不自动加载。标题、元数据和角色用文本方式构造。导出器不执行消息内容，也不会把消息当作操作指令。

PDF 由 Chromium 排版引擎使用 print CSS 输出，保留可搜索文字，并处理长代码和表格。导出由用户点击触发，通过 Blob URL 保存单个文件；不需要 `downloads` 权限。

Chrome API 依据官方 [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage) 与 [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)。运行时没有 npm 包，`jsdom` 与 `playwright` 仅参与测试。
