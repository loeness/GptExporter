# 1.1：历史、媒体与本地 PDF

本次升级在本机完成，未连接或占用额外服务器。没有生成 ZIP、CRX、Release 资产；仓库只保留可直接加载的扩展源码、所需渲染库/字体及其许可证。

## 对话与分支

`history.js` 读取当前对话的 `mapping`，保留所有可导出的消息与根到叶路径。预览默认当前分支，可选其他分支或去重后的全树；全树导出标注消息所属分支，JSON 显式保留分支与选择元数据。缺失父节点、循环、预算截断或 DOM 回退都不标记为完整。

共享页支持普通 share、share/e 及 GPT shared/c 路径，优先使用当前 React Router loader，再使用共享会话接口。临时页在文档开始时观察对应会话 SSE 响应副本以取得 ID，优先用该 ID 读取完整树，失败时保留可取得的部分数据。桥接有 origin、nonce、路由与容量限制，不检查 Authorization 请求头，不向页面发送访问令牌。

账号令牌只在当前页请求闭包中临时用于同源 GET，不会进入 reader、会话缓存、日志或文档。该实现依赖 ChatGPT 的非公开页面接口，服务端变更可能需要更新适配器。被拒绝或不存在的历史不可恢复。

## 图片与附件

多模态 image_asset_pointer、消息 metadata 附件、以及 DOM 回退中的允许域图片/文件链接统一为资产元数据。媒体读取由明确点击“嵌入”或 HTML/PDF 导出触发；源标签页负责刷新文件地址，background 只读取该导出记录中已登记的资产。

仅允许 HTTPS ChatGPT/oaiusercontent，以及账号名合法且有 SAS `sig`/`se`/`sv` 字段的 Azure Blob。拒绝 userinfo、未知域、未签名 Azure 地址和无法安全处理的重定向。图片核对 PNG/JPEG/GIF/WebP 文件签名；SVG 不作为远端图片执行。活动附件 MIME 转成下载专用二进制。单文件 12 MB、所选媒体 40 MB；元数据与字节分别存放，后者只在 reader 内存中。读取失败有明确卡片提示，不生成占位成功文件。

## 公式、图表与 PDF

Markdown 渲染之前保护 TeX 定界内容，使用本地 KaTeX 的 `trust:false`；保留经清理的数学 SVG 路径，防止根号等丢失。Mermaid 使用 strict 模式和纯 SVG 文字，拒绝配置/资源指令与外链图片，净化标签、属性和本地图形样式。

独立 HTML 将公式/图表转换为带尺寸的 2 倍分辨率 PNG；公式导出使用本地 MathJax 自含 SVG 路径，避免 HTML 截图丢失根号。文件不依赖外部脚本或字体，原始 TeX/Mermaid 源码仍在 Markdown/JSON 中。普通图片内嵌，安全附件链接保留原始字节。

PDF 使用本地 pdfmake 与 NotoSansCJK 字体生成，正文为可搜索 Unicode 文字，处理标题、列表层级、表格、代码、链接、分页和页码；公式/图表使用预览快照，附件放入 PDF 的 EmbeddedFiles。A4/Letter、横纵向可选。系统打印保留为备用入口。渲染出现未处理错误时停止导出；可安全回退的内容会保留源码或缺失说明。

## 新增 REA 证据

对原版 `inj.js` 的独立聚焦分析（未执行）：文件 SHA-256 `49c06173d4ead0aa293fb459774fc23583f3e42788f13bd40f4fcb8c80b3b83c`，与原安装文件一致。聚焦目录只含这一文件，不能代替全包分析。

- Parent Evidence：`ev_47084d522a3b18219978a57db90b732900c62e03d2a55faff1c5fb0de1f74fb6`。
- Summary Evidence：`ev_cdb6c8146f1bf8d75ec8ebac4219aae981f261574b9d5948c4e965c90fdd1f67`。
- 18,365 字节、1 个 JavaScript 文件、5,871 个 AST 节点；静态应用覆盖 complete，语义仍有 1,281 个 unknown，不能据此主张运行行为或全功能等价。

本机工作目录已保留 7,099,128 字节的 canonical Evidence bundle 和失败日志；未把原插件代码、个人路径或该原始 bundle 上传到仓库。原版会话/分享/临时对话与文件 API 的静态位置仍见逆向报告。本版行为以自身实现与测试为准。
