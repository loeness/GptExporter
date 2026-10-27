# 实现与数据流

```text
当前 ChatGPT API / 共享 loader / 临时 SSE ID
  → history.js → 完整消息树、分支、媒体元数据
  → conversation.js DOM 回退（明确标记部分数据）
  → content.js / popup.js
  → background.js 校验、限制大小、生成随机 ID
  → chrome.storage.session[export:<id>]
  → reader.html 分支与消息选择 → 本地 Markdown / KaTeX / Mermaid
  → 用户触发媒体读取 → 源标签页解析地址 → background 白名单读取
  → exporters.js → Markdown / TXT / HTML / JSON / CSV
  → 公式/图表向量快照 → pdf.js + pdfmake + 本地 Noto 字体 → PDF

右侧快捷菜单 → background.js 按当前分支与角色筛选
  → 临时 session 模型 → offscreen direct-export.html 本地渲染
  → Blob URL → downloads.download → 仅等待本次下载 ID
  → 释放 Blob、关闭 offscreen 文档、移除临时 session 记录
```

隔离世界的内容脚本只在两个 ChatGPT 域名执行；MAIN 世界桥只观察当前会话的指定 API 响应/临时 SSE 副本及共享 loader，不读取 Authorization 请求头。访问令牌仅在同源请求函数闭包中暂存。浮动入口使用 Shadow DOM；已有页面可幂等注入重连。

服务工作线程验证消息来源和数据类型，按顺序创建预览，避免并发写入破坏缓存预算。创建标签页失败会回滚新增缓存。数据只存在 `storage.session`；服务工作线程休眠不影响已创建预览，浏览器重启会清空对话缓存。24 小时过期清理在下次打开预览时执行，没有定时后台任务。

HTML 在解析、渲染和快照导出时清理。图片初始为占位，明确导出/嵌入操作才读取本次记录内的资产；字节只保留在 reader 或 offscreen 文档内存，不放进 session。没有不受限的 URL 抓取接口。导出器不把消息或 Mermaid 指令当作操作授权。

PDF 由本地 pdfmake 生成，正文使用内嵌 NotoSansCJK Unicode 字体；列表、表格、代码、分页和附件使用语义结构。预览公式使用 KaTeX，导出由本地 MathJax 生成自含 SVG 字形路径后栅格化，规避 HTML 截图遗漏根号的兼容问题。Mermaid 净化后本地栅格化。HTML/PDF 的公式与图表是图片，原始源码保留在 Markdown/JSON。系统打印是备用路径。预览内通过链接保存 Blob；快捷导出通过 downloads API 保存，原对话标签页保持不变。

快捷导出使用 Chrome 的 [Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) 与 [Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)。offscreen 文档仅能使用 runtime 扩展 API，因此模型由后台消息转交，媒体请求也经 runtime 回到后台；它不直接读取 storage。文档只接受本扩展后台消息，媒体代理仅授权正在执行的导出 ID。后台串行处理缓存操作，同时只允许一个快捷任务；渲染限时 150 秒，下载等待 90 秒，失败也执行清理。

Chrome API 依据官方 [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage) 与 [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)。所有运行库、KaTeX 字体、CJK 字体均在 extension/vendor，来源与许可证已登记。MathJax 使用 [SVG fontCache:none](https://docs.mathjax.org/en/v3.2/options/output/svg.html) 生成独立字形路径，文件不依赖远端数学字体。
