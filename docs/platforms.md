# 多平台对话导出

1.4 支持在下面的网站上使用 SELECT 导出页及 All / Questions / Answers 快捷 PDF。新增平台通过页面消息适配器读取现有对话，不调用模型生成 API，不需要 API Key，不上传对话，也不产生模型调用费用。

| 平台 | 网页入口 | 当前读取方式 |
| --- | --- | --- |
| ChatGPT | [chatgpt.com](https://chatgpt.com/)；兼容 chat.openai.com | 原有会话 API、分支、共享/临时记录及 DOM 回退 |
| Claude | [claude.ai](https://claude.ai/) | 当前页面挂载的提问和回答 |
| Qwen | [chat.qwen.ai](https://chat.qwen.ai/) | 当前页面已加载消息 |
| DeepSeek | [chat.deepseek.com](https://chat.deepseek.com/) | 当前页面已加载消息 |
| Kimi | [www.kimi.com](https://www.kimi.com/)；兼容 kimi.com、kimi.moonshot.cn | 当前页面已加载消息 |
| Gemini | [gemini.google.com](https://gemini.google.com/) | 当前页面已加载提问与模型回答 |
| 豆包 | [www.doubao.com](https://www.doubao.com/)；兼容 doubao.com | 当前页面已加载消息 |
| Grok | [grok.com](https://grok.com/) | 当前页面已加载消息；不在 x.com 全站注入 |

打开具体对话，等待回答结束。如果需要较早的消息，先在原页面加载它们，再打开导出预览检查实际取得的范围。虚拟列表可能在滚动时移除较早的消息，例如 Claude；仅滚动到顶部并不能保证整段历史同时挂载。预览中的消息列表才是本次实际导出范围。新增平台始终显示“部分数据”，不会将 DOM 结果标为完整历史。

文字、段落、列表、表格、代码与可提取的 TeX/Mermaid 源码沿用现有渲染器。没有源码的公式图片、画布或交互式组件无法保证精确重建。新增平台的原始图片、文件附件、共享页及完整历史/分支 API 尚未实现；只保留可取得的链接或替代文字，不自动读取媒体服务器。

## 识别依据与兼容性

适配器只使用平台专属容器、消息属性及有来源记录的角色结构，不按消息出现顺序、正文颜色或“有 Markdown 就是回答”来猜测角色。未识别消息时会提示结构变化或加载不足。以下参考是公开的实现代码/DOM 观察记录，不能替代真实账号验证：

- Claude 与 Gemini：公开的 [DOM 观察记录](https://github.com/JoonJ14/ai-conversation-navigator/blob/main/DOM-REFERENCE.md)。Claude 使用 transcript row 内的 user/assistant testid；Gemini 使用 user-query/model-response 等语义元素。
- Qwen：[AiMsgExport 实现](https://greasyfork.org/en/scripts/568176-aimsgexport/code) 中的平台专属 user/assistant 类名。
- DeepSeek：[用户消息 Markdown 渲染脚本](https://openuserjs.org/scripts/niyue/DeepSeek_User_Message_Markdown_Renderer/source) 记录的 ds-message 与用户分组结构；其中部分分组/正文类名带构建哈希，改版后可能失效。
- Kimi：[Kimi K2 导出脚本](https://greasyfork.org/zh-TW/scripts/552371-kimi-k2-%E8%81%8A%E5%A4%A9%E8%AE%B0%E5%BD%95%E5%AF%BC%E5%87%BA%E5%99%A8/code) 中的 chat-content-list / chat-content-item 结构。该参考较旧，兼容性仍需实际账号验证。
- 豆包：[OpenCLI DOM 变更记录](https://github.com/jackwener/OpenCLI/issues/1189) 中 send/receive bubble 结构，避免使用该记录已指出失效的旧 testid。
- Grok：[OpenCLI 消息 testid 观察](https://github.com/jackwener/OpenCLI/issues/2419)。

选择器事实用于独立实现适配器，未复制第三方导出脚本的实现代码。测试使用上述形状的合成页面，验证提问/回答识别、顺序、正文清理、导出路径及权限边界；没有登录这些平台或读取用户真实对话。网站更新后如不再匹配，需补充新页面结构的适配。
