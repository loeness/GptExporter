# 实现与数据流

```text
当前 ChatGPT API / 共享 loader / 临时 SSE ID
  → history.js → 完整消息树、分支、媒体元数据
  → conversation.js DOM 回退（明确标记部分数据）
  → content.js 页面内导出入口
  → background.js 校验、限制大小、生成随机 ID
  → chrome.storage.session[export:<id>]
  → reader.html 分支与消息选择 → 本地 Markdown / KaTeX / Mermaid
  → 预览和导出按需读取媒体 → 源标签页解析地址 → background 校验、并行读取、压缩大图
  → exporters.js → Markdown / TXT / HTML / JSON / CSV
  → 保留正文、公式和上传图片的快照 → pdf.js + pdfmake + 本地 Noto 字体 → PDF

右侧快捷菜单 → background.js 按当前分支与角色筛选
  → 当前选择直接交给 offscreen direct-export.html 本地渲染
  → Blob URL → downloads.download → 仅等待本次下载 ID
  → 释放 Blob 和媒体索引，关闭 offscreen 文档

Claude / Qwen / DeepSeek / Kimi / Gemini / 豆包 / Grok
  → platforms.js 精确域名注册表 + 平台专属消息识别
  → 仅复制识别到的消息正文 → conversation.js 安全语义提取
  → DOM / complete:false / source.platform → 相同预览和快捷导出流程
```

隔离世界的内容脚本只在平台注册表的明确域名执行；MAIN 世界桥与 history.js 仅用于 ChatGPT，不注入其他平台。桥只观察当前会话的指定 API 响应/临时 SSE 副本及共享 loader，不读取 Authorization 请求头。访问令牌仅在同源请求函数闭包中暂存。浮动入口使用 Shadow DOM；安装或重新加载扩展后需刷新对话页。

后台和 offscreen 共用 platforms.js 域名注册表；工具栏弹窗用于配置导出设置。后台从来源 URL 推导平台，强制非 ChatGPT 来源为 DOM/不完整，并清除其资产读取请求。导出 JSON 仅增加经过白名单校验的 platform 标识。资源检查同时比对注册表、主机权限、内容脚本匹配域名，防止扩大页面桥或引入不相关域名。

服务工作线程验证消息来源和数据类型，按顺序创建预览，避免并发写入破坏缓存预算。创建标签页失败会回滚新增缓存。预览数据暂存于 `storage.session`，服务工作线程休眠不影响已创建的预览，浏览器重启会清空对话缓存。24 小时过期清理在下次打开预览时执行。

HTML 在解析、渲染和快照导出时清理。预览自动读取当前选择的图片，文件附件在用户导出或点击嵌入时读取。服务工作线程处理后的媒体保留在 reader 或 offscreen 文档内存中。预览每批只更新对应图片和附件，不重绘整篇对话。没有不受限的 URL 抓取接口。导出器不把消息或 Mermaid 指令当作操作授权。

PDF 由本地 pdfmake 生成，正文使用内嵌 NotoSansCJK Unicode 字体。PDF 快照保留用户和助手的内容并过滤导出元数据、生成图表、引用与内部信息。快照准备时先统一测量公式布局，再使用本地 MathJax 绘制，同次导出会复用相同布局下的公式位图。HTML 保留已净化的 Mermaid 图表与公式图片，Markdown/JSON 保留源码。

PDF 分页预览使用 Chromium 的本地 PDF 查看器。调整字号、紧凑度、纸张或方向时复用当前快照，重新排版后替换 PDF Blob。下载保存当前预览的同一份 PDF。快捷导出使用相同过滤与默认排版，直接通过 downloads API 保存。

快捷导出使用 Chrome 的 [Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen) 与 [Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)。服务工作线程直接向临时文档发送当前选择，并只为正在执行的导出保留媒体索引。快捷导出可与打开预览并行，同时只允许一个快捷任务。生成文件限时 240 秒，下载等待 90 秒，成功或失败后都会释放临时文档。

Chrome API 依据官方 [Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage) 与 [Scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)。所有运行库、KaTeX 字体、CJK 字体均在 extension/vendor，来源与许可证已登记。MathJax 使用 [SVG fontCache:none](https://docs.mathjax.org/en/v3.2/options/output/svg.html) 生成独立字形路径，文件不依赖远端数学字体。
