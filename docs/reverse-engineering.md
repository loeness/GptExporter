# ChatGPT Exporter 6.13.2 静态检查

下文“当前重写”对照表记录的是 1.0 基线。1.1 已新增会话树/API/共享/临时读取、媒体与本地 PDF，见 [升级说明](upgrade-1.1.md)；原版静态观察与证据范围保持不变。

## 范围

检查对象为 Chrome 扩展 ID `ilmdofdhpnhffldihboadndccenlnfll`、版本 `6.13.2`。REA 分析记录的目标 SHA-256 为 `10c6fd3af2c5db5012a1ff64b19b33ecff78ec27d8743cbcabe5408901d8bf2d`；单文件 `inj.js` 的 SHA-256 为 `49c06173d4ead0aa293fb459774fc23583f3e42788f13bd40f4fcb8c80b3b83c`。

以下内容来自 `manifest.json`、`_locales/en/messages.json` 和压缩 JavaScript 的静态读取，以及父任务已有的 REA 证据。JS 中的数字是相对相应文件开头的 **零基 UTF-16 代码单元偏移**。未运行扩展、未访问聊天页面或浏览器存储，也未读取凭据或聊天内容。

## 静态观察

### 扩展入口和权限

`manifest.json` 声明 Manifest V3、后台 service worker `background.js`、弹窗 `popup.html` 和设置页 `options.html`（第 9、12、37、39 行）。`content.js` 匹配 `chat.openai.com` 与 `chatgpt.com`；`contentweb.js` 匹配 `*.chatgptexporter.com`（第 14–22 行）。扩展申请 `storage`、`activeTab`，允许产品站与扩展通信，并仅将 `inj.js` 声明为可供 ChatGPT 页面访问的资源（第 26–45 行）。

`content.js` 在偏移 815505 创建脚本元素，将 `chrome.runtime.getURL("inj.js")` 设为脚本地址并插入页面。结合 `manifest.json` 的资源声明，这表明扩展把该脚本加载到页面环境中。

### ChatGPT 数据桥接

- 在 `inj.js` 偏移 16859 附近，脚本包装页面的 `window.fetch`。对 URL 含 `/backend-api/` 的请求，它从请求头读取 `Authorization: Bearer …`，并通过 `window.postMessage` 发送 `gptexp_token` 消息，代码使用 `"*"` 作为目标 origin。`content.js` 偏移 171307 监听该消息并把 token 暂存于页面脚本变量。这里只能确认传递逻辑存在，不能证明实际请求、消息或凭据曾发生。
- `content.js` 偏移 373690 在没有缓存 token 时读取 `/api/auth/session`，随后在偏移 374085 请求 `/backend-api/conversation/{id}`。文件附件解析另在偏移 513913 请求 `/textdocs`。这些是源码中的路径字面量，不是本次访问或重放的网络请求。
- 共享对话桥接位于 `content.js` 偏移 450045–450487：内容脚本发送 `gptexp_share_runtime_request`，并验证返回消息的来源、origin、request ID 和 URL。`inj.js` 偏移 13544 处理该请求，尝试从 React Router 的共享路由 loader 数据及页面消息 ID 中取出对话数据，再于偏移 14853 发送 `gptexp_share_runtime_response`。
- 临时对话桥接位于 `inj.js` 偏移 15374 及之后：包装器识别临时对话的 `/backend-api/f/conversation` 流式响应，解析 conversation ID 后发出 `gptexp_temporary_conversation_id`。`content.js` 偏移 514716 监听并缓存该 ID。

### 导出格式和服务端调用

- `content.js` 偏移 645556 的格式选项列出 CSV、JSON、TXT、Markdown 和 PDF。非 PDF 导出函数分别生成 `.md`、`.txt`、`.csv`、`.json` 文件，相关扩展名出现在偏移 474265、476952、479805、482862。偏移 443123 附近可见每条已选消息的 HTML、Markdown、纯文本和 `textContent` 字段。HTML 在此处是内部数据；该处的格式选项没有列出独立 HTML 导出。
- PDF 请求有两种数据形状：`content.js` 偏移 749521 附近在 DOM 分支提交每条消息的 HTML，否则提交 `contents` 字段；随后偏移 750482 将 `cmd: "pdf"`、`cmd: "create"` 发给 service worker。`background.js` 偏移 230147 对配置的 PDF 服务发起创建请求，偏移 231574 请求 `/pdf/v1/{jobId}` 查询状态；前端使用响应中的 `downloadUrl` 下载 PDF。源码中还配置了 `/account`、`/usage`、`/file/u/v1`、`/config/v3` 和 `/feedback/v1` 等路径（`background.js` 偏移 25950–26211）。这说明原扩展依赖服务端处理 PDF 和账户相关功能；没有验证服务可用性或响应内容。`background.js` 偏移 237500 附近还将 `sender.tab` 的 `url`、`title` 放入 `usage` 请求载荷；偏移 238972 附近可见向 `/usage` 发起 POST。这里只确认载荷构造，不代表请求已发生或读取了实际 URL / 标题。
- `content.js` 偏移 170226 附近通过 `chrome.storage.local` 读写设置。`contentweb.js` 偏移 15946 附近轮询产品站的 `div#sessionInfo`，把其 `data-session` JSON 写入本地扩展存储。`background.js` 偏移 244137 附近的外部消息处理器接受 `from_web_account_update` 并保存 `account_info`。以上只描述代码路径，没有读取本地存储中的任何值。

### 英文界面提到的功能

`_locales/en/messages.json` 的文案包括：Thought Process、Web Search Sources、Deep Research References、Model name、Message Timestamps、角色标签、文件名格式和 PDF 分页设置（例如偏移 3159、3259、3413、3495、3649）。版本更新文案提到 ChatGPT Intelligent UI 的 PDF、共享对话和 Mermaid 图表（偏移 7951、8056、8167）；另有临时及共享对话提示（偏移 9558）。套餐、用量和开发者收费文案分别出现在偏移 6、5947、8267。

这些是界面和更新说明文本，不足以单独证明每项功能的实际行为。代码中可见的格式选项及数据流已在上节单独列出。

## 与当前独立重写的关系

| 方面 | 原扩展静态证据 | 当前重写的已知架构 |
| --- | --- | --- |
| 对话读取 | DOM 结构之外，还包含页面注入脚本、token 消息桥、ChatGPT 对话请求、共享对话 loader 桥和临时对话 ID 桥。 | DOM-only reader；没有原有 API bridge。 |
| 导出 | 可见格式为 PDF、CSV、JSON、TXT、Markdown；PDF 创建和状态查询走原服务端 API。 | `storage.session` → reader → Markdown、TXT、HTML、JSON、CSV 或浏览器打印 PDF；没有原服务端调用。 |
| 账户和设置 | `chrome.storage.local`、产品站 session 桥，以及账户、用量、配置、上传、反馈 API 路径。套餐和用量文案也出现在 locale 文件。 | 不包含原账户、支付或服务端流程。 |

因此不能把原扩展的完整功能视为当前重写已经具备。尤其是原来的 API 数据读取、共享或临时对话桥及服务端 PDF / 账户流程，与重写的 DOM-only 和本地导出路径不同。CSV 为本地独立实现。locale 文件所列的高级选项未逐项实现；不主张与原版完全等价。

## 推断与未验证事项

**推断：** 原扩展会在 DOM 提取和 API 数据形状之间选择 PDF 输入路径；它把页面环境消息用作内容脚本与注入脚本之间的桥。页面级 `postMessage` 设计意味着同页脚本可能观察到相同消息；这是根据静态代码作出的安全边界推断，不是运行时观察。

**未验证：** 本次没有执行插件或调用后端，也没有确认任何导出、认证、支付、用量、上传、反馈或数据收集请求的实际结果。REA 总览覆盖不完整：记录中有 45 个相关文件、6 个 JS 文件完成解析，语义覆盖为 partial；content/options/popup 的语义堆耗尽，contentweb 超出结果预算。静态搜索未找到的功能不能据此判定不存在。

## 证据索引

- REA JavaScript 应用总览：`ev_7931fed4b0b9a9533a37b0a6a7794c0e6cedf16f1f9165554ffb52ecf53aeebd`，目标 SHA-256 见“范围”。
- `inj.js` 模块页面：`ev_dea0aafbeeddd0244a929d821d3e569290cb5c933395065c72f7804b16b277c6`。
- `inj.js` 模块项：`ev_6044c3dac31d54d01998c42822a8ca69cd2929c280d9873d1d9171335ca5a146`，SHA-256 `49c06173d4ead0aa293fb459774fc23583f3e42788f13bd40f4fcb8c80b3b83c`；REA 标注的源码范围为第 1 行第 0 列到第 2 行第 18304 列。
