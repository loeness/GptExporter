# GptExporter

将 ChatGPT 对话整理成可保存的文档。独立实现的 Chrome / Edge Manifest V3 扩展，中文界面，运行时零第三方依赖。

支持 Markdown、TXT、HTML、JSON、CSV，以及通过浏览器“打印 → 另存为 PDF”。预览中可编辑标题、逐条选择消息、按角色选择、搜索和复制 Markdown。代码块、列表、表格、引用和可取得的公式 TeX 会尽量保留。

## 安装源码

1. 用 Git 获取本仓库：`git clone https://github.com/loeness/GptExporter.git`。
2. 打开 Chrome 的 `chrome://extensions`（Edge 使用 `edge://extensions`），开启“开发者模式”。
3. 选择“加载已解压的扩展程序”，选中仓库里的 **`extension` 文件夹**。
4. 刷新已打开的 ChatGPT 页面。在对话页点击“导出对话”，或点击浏览器工具栏的扩展图标。

安装不需要 Node.js、构建、注册账号或 API Key。要求 Chromium 114 或更新版本。仓库只交付源码，不提供 ZIP、CRX、Release 附件或打包下载入口。

## 使用

打开具体对话，等待回答生成完成；长对话请先向上滚动，让需要的消息加载到页面。打开预览后选择消息和格式。PDF 按钮会打开系统打印界面，在目标打印机中选择“另存为 PDF”；它不承诺静默生成 PDF。

搜索只筛选左侧消息列表，不改变已经选中的消息。导出的内容以预览中的选中消息为准。HTML 文档可以独立打开，不依赖 ChatGPT 或外部脚本。图片只保留描述/链接，预览不自动请求远端图片。公式以提取到的 TeX 文本保留，不重新排版为数学图形。

CSV 按 RFC 4180 引号与换行规则生成；可能被电子表格识别为公式的字段会前置单引号，避免打开表格时执行公式。

## 数据与权限

- 只从 `chatgpt.com` 和旧域名 `chat.openai.com` 已加载的对话 DOM 读取消息。不会读取 Cookie、访问令牌或调用私有对话 API。
- 对话暂存在 `chrome.storage.session` 中，浏览器会话结束即清空。预览内可主动清除；超过 24 小时的记录在下一次创建预览时清理。单段对话上限 3 MB，总预览缓存预算 8 MB，缓存不足会明确报错。
- `chrome.storage.local` 仅保存界面偏好。无数据上传、遥测、账号或支付系统。
- `storage` 用于暂存与偏好；`activeTab`、`scripting` 用于扩展刚加载时连接当前已打开的 ChatGPT 标签页。声明式内容脚本只匹配上述两个域名。
- 没有远端脚本、额外主机权限或外部消息接口。预览与 HTML 导出使用允许列表清理标记和链接。

## 范围与限制

读取当前页面已加载并保留在 DOM 中的消息；不能保证获取未加载、被虚拟化移除的历史，也不会抓取所有会话、分支或附件原文件。若 ChatGPT 改变 DOM，选择器可能需要更新。网页尚未生成完的回答可能只导出当前部分。

本项目基于对已安装 ChatGPT Exporter `6.13.2` 的 REA 静态调查独立重写。原扩展的服务器、登录、订阅、图片导出、批量任务等能力不在本版范围。没有复制其压缩源码、图标、品牌、密钥或网站服务。逆向证据与覆盖边界见 [分析报告](docs/reverse-engineering.md)，数据流见 [架构说明](docs/architecture.md)。

## 开发与验证

Node.js 22+：

```sh
npm ci
npm run check
npm test
```

浏览器集成检查需要 Playwright Chromium（仅开发测试依赖）：

```sh
npx playwright install chromium
npm run test:browser
```

测试使用自造对话，不访问真实账号。检查包括 DOM 转换、恶意 HTML 清理、会话数据校验和失败回滚、真实 MV3 加载、页面入口到预览流程、弹窗错误提示、选择导出与打印样式。测试打开的弹窗页不能模拟用户点击工具栏授予的 `activeTab`，该权限流程另以 API mock 验证。浏览器检查默认把截图/日志放在忽略的 `test-results/`；不发布这些文件为下载包。GitHub Actions 只执行源码和单元检查，不上传构建产物。

`extension/` 可直接加载；`scripts/` 为资源检查和原创图标生成脚本；`tests/` 为测试；`docs/` 为调查与架构记录。
