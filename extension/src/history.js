((root) => {
  "use strict";

  const api = root.GptExporter || (root.GptExporter = {});
  if (typeof api.collectConversation === "function") return;

  const HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const MAX_API_BYTES = 8 * 1024 * 1024;
  const MAX_NODES = 10000;
  const MAX_ASSETS = 2000;
  const MAX_TEXT_CHARS = 2 * 1024 * 1024;
  const MAX_ASSET_BYTES = 20 * 1024 * 1024;
  const ALLOWED_ROLES = new Set(["user", "assistant", "system", "tool"]);
  const SNAPSHOT_REQUEST = "GPT_EXPORTER_PAGE_SNAPSHOT_REQUEST";
  const SNAPSHOT_RESPONSE = "GPT_EXPORTER_PAGE_SNAPSHOT_RESPONSE";

  function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function cleanString(value, limit = 100000) {
    if (typeof value !== "string") return "";
    return value.replace(/\r\n?/g, "\n").slice(0, limit);
  }

  function supportedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && HOSTS.has(url.hostname.toLowerCase()) ? url : null;
    } catch (_) {
      return null;
    }
  }

  function pageKind(value) {
    const page = supportedUrl(value);
    if (!page) return null;
    if (page.searchParams.get("temporary-chat") === "true") return { kind: "temporary", id: "" };
    let match = page.pathname.match(/^\/share\/(?:e\/)?([0-9a-f-]{36})\/?$/i);
    if (match && UUID.test(match[1])) return { kind: "shared", id: match[1].toLowerCase() };
    match = page.pathname.match(/^\/g\/[^/]+\/shared\/c\/([0-9a-f-]{36})\/?$/i);
    if (match && UUID.test(match[1])) return { kind: "shared", id: match[1].toLowerCase() };
    match = page.pathname.match(/^\/c\/([0-9a-f-]{36})\/?$/i);
    if (!match) match = page.pathname.match(/^\/g\/[^/]+\/c\/([0-9a-f-]{36})\/?$/i);
    if (match && UUID.test(match[1])) return { kind: "api", id: match[1].toLowerCase() };
    return null;
  }

  function addWarning(warnings, value) {
    const warning = cleanString(value, 500).trim();
    if (warning && !warnings.includes(warning) && warnings.length < 20) warnings.push(warning);
  }

  function requestSignal() {
    const signals = root.AbortSignal;
    try { return signals && typeof signals.timeout === "function" ? signals.timeout(15000) : undefined; }
    catch (_) { return undefined; }
  }

  function safeTime(value) {
    if (typeof value === "string") return cleanString(value, 100);
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value > 1e12 ? value : value * 1000);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    return "";
  }

  function normalizedRole(value) {
    const role = cleanString(value, 40).trim().toLowerCase();
    if (ALLOWED_ROLES.has(role)) return role;
    if (["function", "tool_call", "browser", "python"].includes(role)) return "tool";
    if (role === "developer") return "system";
    return role ? "tool" : "assistant";
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function safeAssetUrl(value, baseUrl) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value, baseUrl);
      const host = url.hostname.toLowerCase();
      const signedAzure = /^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(host) &&
        ["sig", "se", "sv"].every(key => Boolean(url.searchParams.get(key)));
      const allowed = host === "chatgpt.com" || host === "chat.openai.com" || host === "oaiusercontent.com" || host.endsWith(".oaiusercontent.com") || signedAzure;
      return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && allowed ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function pointerId(value) {
    return cleanString(value, 2000).replace(/^sediment:\/\//i, "").split(/[?#]/, 1)[0].slice(0, 500);
  }

  function findGraph(raw) {
    if (!raw) return null;
    const queue = [raw];
    const seen = new Set();
    let inspected = 0;
    while (queue.length && inspected < 12000) {
      const value = queue.shift();
      if (!isRecord(value) || seen.has(value)) continue;
      seen.add(value);
      inspected++;
      if (isRecord(value.mapping)) return value;
      const values = Array.isArray(value) ? value.slice(0, 5000) : Object.values(value).slice(0, 5000);
      for (const child of values) if (isRecord(child) || Array.isArray(child)) queue.push(child);
    }
    return null;
  }

  function pageTitle(doc, raw) {
    const value = isRecord(raw) ? raw.title : "";
    if (typeof value === "string" && value.trim()) return cleanString(value, 300).trim();
    const title = doc && typeof doc.title === "string" ? doc.title : "";
    return cleanString(title.replace(/\s*(?:[-|–—])\s*ChatGPT\s*$/i, "").trim() || "ChatGPT conversation", 300);
  }

  function normalizeV1(raw, options, warnings, title, url) {
    const sourceMessages = Array.isArray(raw.messages) ? raw.messages.slice(0, MAX_NODES) : [];
    const messages = [];
    let contentWasTruncated = Array.isArray(raw.messages) && raw.messages.length > MAX_NODES;
    for (const [index, item] of sourceMessages.entries()) {
      if (!isRecord(item)) continue;
      if ([item.markdown, item.text, item.html].some((value) => typeof value === "string" && value.length > MAX_TEXT_CHARS)) contentWasTruncated = true;
      const markdown = cleanString(item.markdown, MAX_TEXT_CHARS);
      const text = cleanString(item.text || markdown, MAX_TEXT_CHARS);
      const id = cleanString(item.id || "message-" + (index + 1), 300);
      messages.push({
        id,
        role: normalizedRole(item.role),
        markdown: markdown || text,
        text,
        html: cleanString(item.html || "<p>" + escapeHtml(text).replace(/\n/g, "<br>") + "</p>", MAX_TEXT_CHARS),
        ...(item.createTime ? { createTime: safeTime(item.createTime) || cleanString(item.createTime, 100) } : {}),
        ...(Array.isArray(item.assetIds) ? { assetIds: item.assetIds.filter((value) => typeof value === "string").slice(0, 100) } : {})
      });
    }
    if (messages.length < sourceMessages.length) addWarning(warnings, "部分消息超出处理上限或格式无效，已省略。");
    if (contentWasTruncated) addWarning(warnings, "消息内容超过处理上限，DOM 结果不完整。");
    addWarning(warnings, options.kind === "dom"
      ? "DOM 回退只包含当前已加载的消息，无法确认完整历史或分支。"
      : "收到扁平消息列表，无法验证历史分支是否完整。");
    const branchId = "branch-1";
    return {
      schemaVersion: 2, title, url, exportedAt: new Date().toISOString(), messages,
      branches: messages.length ? [{ id: branchId, label: "Branch 1", leafId: messages.at(-1).id, messageIds: messages.map((message) => message.id) }] : [],
      activeBranchId: messages.length ? branchId : "",
      source: { kind: options.kind, complete: false, ...(options.conversationId ? { conversationId: cleanString(options.conversationId, 300) } : {}) },
      assets: [], warnings
    };
  }

  function normalizeGraph(graph, options, warnings, title, url) {
    const sourceEntries = Object.entries(graph.mapping);
    const truncated = sourceEntries.length > MAX_NODES;
    const entries = sourceEntries.slice(0, MAX_NODES);
    if (truncated) addWarning(warnings, "对话节点超过处理上限，结果不完整。");

    const nodes = new Map(entries.map(([id, value]) => [String(id), isRecord(value) ? value : {}]));
    const parents = new Map();
    const children = new Map([...nodes.keys()].map((id) => [id, []]));
    let structurallyComplete = !truncated;

    for (const [id, node] of nodes) {
      if (typeof node.parent === "string" && node.parent) {
        if (!nodes.has(node.parent)) {
          structurallyComplete = false;
          addWarning(warnings, "节点 " + id + " 引用了缺失的父节点 " + node.parent + "。");
          parents.set(id, null);
        } else parents.set(id, node.parent);
      } else parents.set(id, null);
    }

    for (const [parentId, node] of nodes) {
      if (node.children == null) continue;
      if (!Array.isArray(node.children)) {
        structurallyComplete = false;
        addWarning(warnings, "节点 " + parentId + " 的 children 字段格式无效。");
        continue;
      }
      for (const childValue of node.children) {
        if (typeof childValue !== "string" || !nodes.has(childValue)) {
          structurallyComplete = false;
          addWarning(warnings, "节点 " + parentId + " 引用了缺失或无效的子节点。");
          continue;
        }
        if (parents.get(childValue) == null) parents.set(childValue, parentId);
        else if (parents.get(childValue) !== parentId) {
          structurallyComplete = false;
          addWarning(warnings, "节点 " + childValue + " 的 parent 与 children 引用不一致。");
        }
      }
    }

    for (const [id, parent] of parents) if (parent && nodes.has(parent)) children.get(parent).push(id);
    for (const [parentId, node] of nodes) {
      const ordered = [];
      if (Array.isArray(node.children)) {
        for (const childId of node.children) {
          if (typeof childId === "string" && parents.get(childId) === parentId && !ordered.includes(childId)) ordered.push(childId);
        }
      }
      for (const childId of children.get(parentId)) if (!ordered.includes(childId)) ordered.push(childId);
      children.set(parentId, ordered);
    }

    const cyclic = new Set();
    for (const id of nodes.keys()) {
      const path = new Set();
      let cursor = id;
      while (cursor && nodes.has(cursor)) {
        if (path.has(cursor)) {
          cyclic.add(cursor);
          structurallyComplete = false;
          addWarning(warnings, "节点关系包含循环（涉及 " + cursor + "）。");
          break;
        }
        path.add(cursor);
        cursor = parents.get(cursor) || null;
      }
    }

    const messageIdsByNode = new Map();
    const usedIds = new Set();
    const messageRecords = new Map();
    const assets = [];
    const assetsByKey = new Map();

    function addAsset(candidate, messageId, defaults = {}) {
      if (!isRecord(candidate)) return null;
      const pointer = pointerId(candidate.asset_pointer || candidate.assetPointer);
      const fileId = cleanString(candidate.fileId || candidate.file_id || candidate.id || pointer, 500) || pointer;
      const directUrl = safeAssetUrl(candidate.url || candidate.download_url || candidate.public_url || candidate.publicUrl, url);
      if (!fileId && !directUrl) return null;
      const mimeType = cleanString(candidate.mimeType || candidate.mime_type || defaults.mimeType ||
        (defaults.kind === "image" ? "image/*" : ""), 200);
      const kind = defaults.kind === "image" || mimeType.toLowerCase().startsWith("image/") || !!pointer ? "image" : "attachment";
      const name = cleanString(candidate.name || candidate.file_name || candidate.fileName ||
        defaults.name || (kind === "image" ? "Image" : "Attachment"), 300);
      const key = fileId ? kind + ":" + fileId : kind + ":" + directUrl;
      let asset = assetsByKey.get(key);
      if (!asset) {
        if (assets.length >= MAX_ASSETS) {
          structurallyComplete = false;
          addWarning(warnings, "附件数量超过处理上限，部分附件未列入导出。");
          return null;
        }
        asset = {
          id: "asset-" + (assets.length + 1), messageId, kind, name, mimeType,
          ...(fileId ? { fileId } : {}), ...(directUrl ? { url: directUrl } : {}), status: "pending"
        };
        assetsByKey.set(key, asset);
        assets.push(asset);
      }
      return asset;
    }

    function partText(part, messageId, metadata, localAssetIds) {
      if (typeof part === "string") {
        if (part.length > MAX_TEXT_CHARS) {
          structurallyComplete = false;
          addWarning(warnings, "消息 " + messageId + " 的文本超过处理上限。");
        }
        return cleanString(part, MAX_TEXT_CHARS);
      }
      if (!isRecord(part)) return "";
      if (part.content_type === "image_asset_pointer" || typeof part.asset_pointer === "string") {
        const asset = addAsset(part, messageId, { kind: "image", name: metadata.image_gen_title || metadata.imageGenTitle || "Image" });
        if (!asset) return "[Image]";
        localAssetIds.push(asset.id);
        const label = asset.name.replace(/([\[\]])/g, "\\$1");
        return "![" + label + "](gpt-exporter-asset:" + encodeURIComponent(asset.id) + ")";
      }
      if (typeof part.text === "string") {
        if (part.text.length > MAX_TEXT_CHARS) {
          structurallyComplete = false;
          addWarning(warnings, "消息 " + messageId + " 的文本超过处理上限。");
        }
        return cleanString(part.text, MAX_TEXT_CHARS);
      }
      if (typeof part.content === "string") {
        if (part.content.length > MAX_TEXT_CHARS) {
          structurallyComplete = false;
          addWarning(warnings, "消息 " + messageId + " 的文本超过处理上限。");
        }
        return cleanString(part.content, MAX_TEXT_CHARS);
      }
      return "";
    }

    for (const [nodeId, node] of nodes) {
      const message = node.message;
      if (!isRecord(message)) continue;
      let id = cleanString(message.id || nodeId, 300) || nodeId;
      if (usedIds.has(id)) {
        let suffix = 2;
        while (usedIds.has(id + "#" + suffix)) suffix++;
        id += "#" + suffix;
      }
      usedIds.add(id);
      messageIdsByNode.set(nodeId, id);

      const metadata = isRecord(message.metadata) ? message.metadata : {};
      const content = isRecord(message.content) ? message.content : {};
      const parts = Array.isArray(content.parts) ? content.parts.slice(0, 10000) : [];
      if (Array.isArray(content.parts) && content.parts.length > 10000) {
        structurallyComplete = false;
        addWarning(warnings, "消息 " + id + " 的内容块超过处理上限。");
      }
      const rawFallback = metadata.model_dil_v2 && metadata.model_dil_v2.fallbackMarkdown;
      const fallback = typeof rawFallback === "string" ? cleanString(rawFallback, MAX_TEXT_CHARS) : "";
      if (typeof rawFallback === "string" && rawFallback.length > MAX_TEXT_CHARS) {
        structurallyComplete = false;
        addWarning(warnings, "消息 " + id + " 的 Markdown 超过处理上限。");
      }
      const partAssetIds = [];
      const textParts = parts.map((part) => partText(part, id, metadata, partAssetIds)).filter(Boolean);
      let markdown = fallback || textParts.join("\n");

      const attachmentCandidates = [];
      let attachmentCount = 0;
      for (const value of [content.attachments, content.files, metadata.attachments, metadata.files, message.attachments, message.files]) {
        if (Array.isArray(value)) {
          if (attachmentCount + value.length > 1000) {
            structurallyComplete = false;
            addWarning(warnings, "消息 " + id + " 的附件数量超过处理上限。");
          }
          const remaining = Math.max(0, 1000 - attachmentCount);
          attachmentCandidates.push(...value.slice(0, remaining));
          attachmentCount += Math.min(value.length, remaining);
        }
      }
      const localAssetIds = [];
      for (const candidate of attachmentCandidates) {
        const asset = addAsset(candidate, id, { name: "Attachment" });
        if (!asset) continue;
        localAssetIds.push(asset.id);
        const label = asset.name.replace(/([\[\]])/g, "\\$1");
        const marker = asset.kind === "image"
          ? "![" + label + "](gpt-exporter-asset:" + encodeURIComponent(asset.id) + ")"
          : "[Attachment: " + asset.name + "]";
        if (!markdown.includes(marker)) markdown += (markdown ? "\n\n" : "") + marker;
      }
      const assetIds = [...new Set(partAssetIds.concat(localAssetIds))];
      const text = textParts.map((part) => part.replace(/!\[([^\]]*)\]\(gpt-exporter-asset:[^)]+\)/g, "[Image: $1]")).join("\n") ||
        cleanString(content.text, MAX_TEXT_CHARS) || cleanString(markdown, MAX_TEXT_CHARS);
      const role = normalizedRole(message.author && message.author.role);
      const normalized = {
        id, role, markdown: cleanString(markdown, MAX_TEXT_CHARS), text: cleanString(text, MAX_TEXT_CHARS),
        html: text ? "<p>" + escapeHtml(text).replace(/\n/g, "<br>") + "</p>" : "",
        ...(message.create_time != null ? { createTime: safeTime(message.create_time) || cleanString(message.create_time, 100) } : {}),
        ...(assetIds.length ? { assetIds } : {})
      };
      messageRecords.set(id, normalized);
    }

    const orderedNodes = [];
    const walked = new Set();
    function walk(nodeId, activePath = new Set()) {
      if (walked.has(nodeId)) return;
      if (activePath.has(nodeId)) {
        structurallyComplete = false;
        return;
      }
      const nextPath = new Set(activePath);
      nextPath.add(nodeId);
      walked.add(nodeId);
      orderedNodes.push(nodeId);
      for (const childId of children.get(nodeId) || []) walk(childId, nextPath);
    }
    const roots = [...nodes.keys()].filter((id) => !parents.get(id) || !nodes.has(parents.get(id)));
    for (const rootId of roots) walk(rootId);
    for (const id of nodes.keys()) {
      if (!walked.has(id)) {
        structurallyComplete = false;
        addWarning(warnings, "节点 " + id + " 无法从对话根节点到达。");
        walk(id);
      }
    }

    const messages = orderedNodes.map((nodeId) => messageIdsByNode.get(nodeId))
      .filter((messageId) => messageId && messageRecords.has(messageId))
      .map((messageId) => messageRecords.get(messageId));
    let leaves = [...nodes.keys()].filter((id) => (children.get(id) || []).length === 0);
    if (!leaves.length && nodes.has(graph.current_node)) leaves = [graph.current_node];

    const branches = [];
    for (const leafId of leaves.slice(0, MAX_NODES)) {
      const path = [];
      const seen = new Set();
      let cursor = leafId;
      let validPath = true;
      while (cursor && nodes.has(cursor)) {
        if (seen.has(cursor)) {
          validPath = false;
          structurallyComplete = false;
          break;
        }
        seen.add(cursor);
        path.push(cursor);
        cursor = parents.get(cursor) || null;
      }
      path.reverse();
      const messageIds = path.map((nodeId) => messageIdsByNode.get(nodeId)).filter(Boolean);
      if (!messageIds.length || branches.some((branch) => branch.messageIds.join("\u0000") === messageIds.join("\u0000"))) continue;
      branches.push({ id: "branch-" + (branches.length + 1), label: "Branch " + (branches.length + 1), leafId: messageIds.at(-1), messageIds });
      if (!validPath) addWarning(warnings, "循环分支已截断。");
    }
    if (leaves.length > MAX_NODES) {
      structurallyComplete = false;
      addWarning(warnings, "分支数量超过处理上限，结果不完整。");
    }

    let activeBranchId = "";
    if (nodes.has(graph.current_node)) {
      let activeNode = graph.current_node;
      const descended = new Set();
      while ((children.get(activeNode) || []).length && !descended.has(activeNode)) {
        descended.add(activeNode);
        activeNode = children.get(activeNode).at(-1);
      }
      const activeMessageId = messageIdsByNode.get(activeNode) || messageIdsByNode.get(graph.current_node);
      const branch = branches.find((candidate) => candidate.leafId === activeMessageId) ||
        branches.find((candidate) => candidate.messageIds.includes(activeMessageId));
      if (branch) activeBranchId = branch.id;
    } else {
      structurallyComplete = false;
      addWarning(warnings, "current_node 缺失或不在 mapping 中，无法确认活动分支。");
    }
    if (!activeBranchId && branches.length) activeBranchId = branches[0].id;
    if (!branches.length && messages.length) {
      structurallyComplete = false;
      branches.push({ id: "branch-1", label: "Branch 1", leafId: messages.at(-1).id, messageIds: messages.map((message) => message.id) });
      activeBranchId = "branch-1";
      addWarning(warnings, "无法从 mapping 重建分支路径，已保留消息列表。");
    }
    if (roots.length !== 1 && nodes.size) {
      structurallyComplete = false;
      addWarning(warnings, "mapping 包含多个根节点，无法确认所有消息属于同一完整对话。");
    }
    if (options.kind === "temporary" && options.complete === false) {
      addWarning(warnings, "临时对话快照可能来自未完成的流，无法确认完整性。");
    } else if (options.complete === false && options.kind !== "dom") {
      addWarning(warnings, "结构化页面桥接快照被标记为部分内容。");
    }

    const requestedComplete = options.complete !== false && options.kind !== "dom";
    const conversationId = cleanString(options.conversationId || graph.shared_conversation_id || graph.share_id || graph.conversation_id, 300);
    return {
      schemaVersion: 2, title, url, exportedAt: new Date().toISOString(), messages,
      branches, activeBranchId,
      source: { kind: options.kind, complete: requestedComplete && structurallyComplete, ...(conversationId ? { conversationId } : {}) },
      assets, warnings
    };
  }

  function normalizeConversation(raw, options = {}) {
    const url = cleanString(options.url || (isRecord(raw) && raw.url) || "", 4000);
    const kind = ["api", "shared", "temporary", "dom"].includes(options.kind) ? options.kind : "api";
    const warnings = [];
    if (isRecord(raw) && Array.isArray(raw.warnings)) for (const warning of raw.warnings) addWarning(warnings, warning);
    const graph = findGraph(raw);
    const title = pageTitle(null, graph || raw);
    if (graph) return normalizeGraph(graph, { ...options, kind }, warnings, title, url);
    if (isRecord(raw) && Array.isArray(raw.messages)) return normalizeV1(raw, { ...options, kind }, warnings, title, url);
    addWarning(warnings, "API 响应中没有找到可读取的 mapping 或 messages。");
    return {
      schemaVersion: 2, title, url, exportedAt: new Date().toISOString(), messages: [],
      branches: [], activeBranchId: "", source: { kind, complete: false, ...(options.conversationId ? { conversationId: cleanString(options.conversationId, 300) } : {}) },
      assets: [], warnings
    };
  }

  function createNonce() {
    const cryptoApi = root.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
    if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
      const bytes = new Uint8Array(24);
      cryptoApi.getRandomValues(bytes);
      return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    }
    return "";
  }

  function requestPageSnapshot(options = {}) {
    const view = root.window || root;
    const currentUrl = cleanString(options.url || (view.location && view.location.href) || "", 4000);
    const page = supportedUrl(currentUrl);
    if (!page || typeof view.postMessage !== "function" || typeof view.addEventListener !== "function") return Promise.resolve(null);
    const nonce = createNonce();
    if (!nonce) return Promise.resolve(null);
    const timeoutMs = Math.max(50, Math.min(Number(options.timeoutMs) || 500, 5000));
    return new Promise((resolve) => {
      let timer;
      const finish = (value) => {
        clearTimeout(timer);
        view.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event) => {
        if ((event.source !== view && event.source !== root) || event.origin !== page.origin) return;
        const data = event.data;
        if (!isRecord(data) || data.type !== SNAPSHOT_RESPONSE || data.nonce !== nonce || data.url !== currentUrl || !isRecord(data.snapshot)) return;
        finish(data.snapshot);
      };
      view.addEventListener("message", onMessage);
      timer = setTimeout(() => finish(null), timeoutMs);
      try {
        view.postMessage({ type: SNAPSHOT_REQUEST, nonce, url: currentUrl }, page.origin);
      } catch (_) {
        finish(null);
      }
    });
  }

  async function readResponseJson(response, maxBytes = MAX_API_BYTES) {
    if (!response || !response.ok) return null;
    try {
      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = "";
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            bytes += result.value.byteLength;
            if (bytes > maxBytes) {
              await reader.cancel();
              return null;
            }
            text += decoder.decode(result.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          try { reader.releaseLock(); } catch (_) {}
        }
        return JSON.parse(text);
      }
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) return null;
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  async function readAssetDataUrl(response, mimeType) {
    if (!response || !response.ok || !response.body || typeof response.body.getReader !== "function") return "";
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > MAX_ASSET_BYTES) {
          await reader.cancel();
          return "";
        }
        chunks.push(result.value);
      }
    } catch (_) {
      return "";
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
    }
    try {
      const encoder = root.btoa || (typeof btoa === "function" ? btoa : null);
      if (!encoder) return "";
      const safeMime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType) ? mimeType : "application/octet-stream";
      return "data:" + safeMime + ";base64," + encoder(binary);
    } catch (_) {
      return "";
    }
  }

  async function withSessionToken(fetchFn, origin, callback) {
    let token = null;
    try {
      try {
        const sessionResponse = await fetchFn(new URL("/api/auth/session", origin).href, {
          credentials: "include", redirect: "error", signal: requestSignal(), headers: { Accept: "application/json" }
        });
        const session = await readResponseJson(sessionResponse, 256 * 1024);
        if (isRecord(session) && typeof session.accessToken === "string") token = session.accessToken;
      } catch (_) {
        token = null;
      }
      return await callback(token);
    } finally {
      token = null;
    }
  }

  async function fetchConversationData(fetchFn, origin, id, token) {
    if (!UUID.test(id)) return null;
    try {
      const url = new URL("/backend-api/conversation/" + encodeURIComponent(id), origin);
      if (url.origin !== origin) return null;
      const headers = { Accept: "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      return await readResponseJson(await fetchFn(url.href, { credentials: "include", redirect: "error", signal: requestSignal(), headers }));
    } catch (_) {
      return null;
    }
  }

  async function fetchShareData(fetchFn, origin, id, token) {
    if (!UUID.test(id)) return null;
    try {
      const url = new URL("/backend-api/share/" + encodeURIComponent(id), origin);
      if (url.origin !== origin) return null;
      const headers = { Accept: "application/json" };
      if (token) headers.Authorization = "Bearer " + token;
      return await readResponseJson(await fetchFn(url.href, { credentials: "include", redirect: "error", signal: requestSignal(), headers }));
    } catch (_) {
      return null;
    }
  }

  function snapshotValue(snapshot, key) {
    if (!isRecord(snapshot)) return null;
    const value = snapshot[key];
    return isRecord(value) || Array.isArray(value) ? value : null;
  }

  function attachWarnings(model, warnings) {
    for (const warning of warnings) addWarning(model.warnings, warning);
    return model;
  }

  function domCandidates(doc) {
    if (!doc || !doc.querySelector) return [];
    const scope = doc.querySelector("main") || doc;
    function visible(element) {
      return !element.closest("aside, nav, [role='navigation'], [aria-hidden='true'], [hidden]");
    }
    const primary = [...scope.querySelectorAll("[data-message-author-role]")]
      .filter((element) => visible(element) && element.parentElement?.closest("[data-message-author-role]") == null)
      .filter((element) => {
        const role = cleanString(element.getAttribute("data-message-author-role"), 40).toLowerCase();
        return ["user", "assistant", "system", "tool", "function", "tool_call", "developer"].includes(role);
      });
    if (primary.length) return primary;
    return [...scope.querySelectorAll("article[data-testid^='conversation-turn']")]
      .filter((article) => visible(article));
  }

  function mediaMimeType(url, fallback, name) {
    const extensionFrom = (value) => {
      const match = cleanString(value, 500).toLowerCase().match(/\.([a-z0-9]{1,10})(?:$|[?#])/);
      return match ? match[1] : "";
    };
    const extension = (() => {
      try { return extensionFrom(new URL(url).pathname) || extensionFrom(name); } catch (_) { return extensionFrom(name); }
    })();
    const types = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
      avif: "image/avif", pdf: "application/pdf", txt: "text/plain", csv: "text/csv", md: "text/markdown",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    };
    return cleanString(fallback, 200) || types[extension] || (extension && extension.startsWith("image") ? "image/*" : "application/octet-stream");
  }

  function addDomAssets(doc, model) {
    if (!doc || !Array.isArray(model.messages) || !Array.isArray(model.assets)) return;
    const candidates = domCandidates(doc);
    const used = new Set();
    for (const [index, element] of candidates.entries()) {
      const explicitId = cleanString(element.getAttribute("data-message-id") || element.getAttribute("data-id"), 300);
      const expectedId = explicitId || "dom-position-" + (index + 1);
      const message = model.messages.find((item) => item.id === expectedId);
      if (!message || used.has(message.id)) continue;
      used.add(message.id);
      const assetIds = new Set(message.assetIds || []);
      const imageAssets = new Map();

      function add(candidateUrl, kind, name, mimeType, fileId = "") {
        const safeUrl = safeAssetUrl(candidateUrl, doc.baseURI || doc.URL || model.url);
        if (!safeUrl || model.assets.length >= MAX_ASSETS) return null;
        const existing = model.assets.find((asset) => asset.url === safeUrl && asset.kind === kind);
        if (existing) {
          assetIds.add(existing.id);
          if (kind === "image") imageAssets.set(safeUrl, existing);
          return existing;
        }
        const asset = {
          id: "dom-asset-" + (model.assets.length + 1),
          messageId: message.id,
          kind,
          name: cleanString(name || (kind === "image" ? "Image" : "Attachment"), 300),
          mimeType: mediaMimeType(safeUrl, mimeType, name),
          ...(fileId ? { fileId } : {}),
          url: safeUrl,
          status: "pending"
        };
        model.assets.push(asset);
        assetIds.add(asset.id);
        if (kind === "image") imageAssets.set(safeUrl, asset);
        return asset;
      }

      for (const image of element.querySelectorAll("img[src], img[data-src]")) {
        if (image.closest("button, aside, nav, [data-testid*='avatar'], [aria-hidden='true'], [hidden]")) continue;
        const rawUrl = image.getAttribute("src") || image.getAttribute("data-src") || "";
        const safeUrl = safeAssetUrl(rawUrl, doc.baseURI || doc.URL || model.url);
        if (!safeUrl) continue;
        const alt = cleanString(image.getAttribute("alt") || "Image", 300).trim() || "Image";
        add(safeUrl, "image", alt, image.getAttribute("type") || "");
      }

      for (const anchor of element.querySelectorAll("a[href]")) {
        const rawUrl = anchor.getAttribute("href") || "";
        const safeUrl = safeAssetUrl(rawUrl, doc.baseURI || doc.URL || model.url);
        if (!safeUrl) continue;
        let parsed;
        try { parsed = new URL(safeUrl); } catch (_) { continue; }
        const fileMatch = parsed.pathname.match(/\/backend-api\/files\/download\/([^/]+)$/i);
        const markedAttachment = anchor.hasAttribute("download") ||
          /attachment|file/i.test(anchor.getAttribute("data-testid") || "") ||
          !!anchor.closest("[data-testid*='attachment'], [data-testid*='file']");
        if (!fileMatch && !markedAttachment) continue;
        let fileId = "";
        if (fileMatch) {
          try { fileId = decodeURIComponent(fileMatch[1]); } catch (_) { fileId = fileMatch[1]; }
        }
        const linkName = cleanString(anchor.getAttribute("download") || anchor.textContent || parsed.pathname.split("/").pop() || "Attachment", 300).trim();
        const asset = add(safeUrl, "attachment", linkName, anchor.getAttribute("type") || "", fileId);
        if (asset && !message.markdown.includes("[Attachment: " + asset.name + "]")) {
          message.markdown += (message.markdown ? "\n\n" : "") + "[Attachment: " + asset.name + "]";
        }
      }

      message.markdown = message.markdown.replace(/!\[([^\]]*)\]\(<([^>]+)>\)/g, (whole, alt, target) => {
        const safeUrl = safeAssetUrl(target, doc.baseURI || doc.URL || model.url);
        if (!safeUrl) return "[" + alt + "](<" + target + ">)";
        const asset = imageAssets.get(safeUrl);
        if (!asset) return "[" + alt + "](<" + safeUrl + ">)";
        return "![" + alt + "](gpt-exporter-asset:" + encodeURIComponent(asset.id) + ")";
      });
      message.assetIds = [...assetIds];
      if (model.assets.length >= MAX_ASSETS) addWarning(model.warnings, "DOM 附件数量超过处理上限，部分附件未列入导出。");
    }
  }

  async function collectConversation(options = {}) {
    const doc = options.document || root.document;
    const url = cleanString(options.url || (doc && doc.location && doc.location.href) || "", 4000);
    const route = pageKind(url);
    const page = supportedUrl(url);
    const fetchFn = typeof options.fetch === "function" ? options.fetch : (typeof root.fetch === "function" ? root.fetch.bind(root) : null);
    const acquisitionWarnings = [];
    let snapshot = null;
    try {
      if (options.bridge) {
        const request = typeof options.bridge === "function" ? options.bridge : options.bridge.requestPageSnapshot;
        if (typeof request === "function") snapshot = await request.call(options.bridge, { url, timeoutMs: 500 });
      } else snapshot = await requestPageSnapshot({ url, timeoutMs: 500 });
    } catch (_) {
      snapshot = null;
    }

    if (route && page) {
      let raw = null;
      if (route.kind === "api") {
        const bridgeRaw = snapshotValue(snapshot, "conversationData");
        const bridgeGraph = findGraph(bridgeRaw);
        raw = bridgeGraph && !snapshot.truncated ? bridgeRaw : null;
        if (!raw && fetchFn) await withSessionToken(fetchFn, page.origin, async (token) => {
          const apiRaw = await fetchConversationData(fetchFn, page.origin, route.id, token);
          if (findGraph(apiRaw)) raw = apiRaw;
        });
        const partialBridgeRaw = !raw && bridgeGraph ? bridgeRaw : null;
        if (!raw) raw = partialBridgeRaw;
        if (raw && findGraph(raw)) {
          const model = normalizeConversation(raw, {
            url, kind: "api", complete: raw !== partialBridgeRaw, conversationId: route.id
          });
          if (model.messages.length) return attachWarnings(model, acquisitionWarnings);
        }
      } else if (route.kind === "shared") {
        const bridgeRaw = snapshotValue(snapshot, "shareData");
        const bridgeGraph = findGraph(bridgeRaw);
        raw = bridgeGraph && !snapshot.truncated ? bridgeRaw : null;
        if (!raw && fetchFn) await withSessionToken(fetchFn, page.origin, async (token) => {
          const apiRaw = await fetchShareData(fetchFn, page.origin, route.id, token);
          if (findGraph(apiRaw)) raw = apiRaw;
        });
        const partialBridgeRaw = !raw && bridgeGraph ? bridgeRaw : null;
        if (!raw) raw = partialBridgeRaw;
        if (raw && findGraph(raw)) {
          const model = normalizeConversation(raw, {
            url, kind: "shared", complete: raw !== partialBridgeRaw, conversationId: route.id
          });
          if (model.messages.length) return attachWarnings(model, acquisitionWarnings);
        }
      } else if (route.kind === "temporary") {
        const temporaryId = cleanString(snapshot && snapshot.temporaryId, 100);
        const partialData = snapshotValue(snapshot, "temporaryData");
        if (UUID.test(temporaryId) && fetchFn) {
          await withSessionToken(fetchFn, page.origin, async (token) => {
            raw = await fetchConversationData(fetchFn, page.origin, temporaryId, token);
          });
          if (raw && findGraph(raw)) {
            const model = normalizeConversation(raw, { url, kind: "temporary", complete: true, conversationId: temporaryId });
            if (model.messages.length) return attachWarnings(model, acquisitionWarnings);
          }
        }
        if (findGraph(partialData)) {
          const model = normalizeConversation(partialData, {
            url, kind: "temporary", complete: false, conversationId: temporaryId || undefined
          });
          if (model.messages.length) return attachWarnings(model, acquisitionWarnings);
        }
        if (snapshot && snapshot.truncated) addWarning(acquisitionWarnings, "页面桥接快照超过大小上限，已忽略不完整快照。");
        addWarning(acquisitionWarnings, "临时对话 API 快照不可用或未返回完整 mapping；使用已加载 DOM 回退。");
      }
      addWarning(acquisitionWarnings, route.kind === "shared"
        ? "共享对话结构化数据不可用；使用已加载 DOM 回退。"
        : "结构化对话数据不可用；使用已加载 DOM 回退。");
    } else if (route && route.kind === "temporary") {
      addWarning(acquisitionWarnings, "临时对话尚无可用的 API 快照；使用已加载 DOM 回退。");
    }

    let domModel;
    if (api.extractConversation && doc) {
      try { domModel = api.extractConversation(doc, url); } catch (_) { domModel = null; }
    }
    if (!domModel) domModel = { title: "ChatGPT conversation", url, messages: [], warnings: [] };
    const model = normalizeConversation(domModel, { url, kind: "dom", complete: false });
    if (snapshot && snapshot.truncated) addWarning(model.warnings, "页面桥接快照超过大小上限，已忽略不完整快照。");
    addWarning(model.warnings, "DOM 回退只包含当前已加载的消息，无法确认完整历史或分支。");
    addDomAssets(doc, model);
    return attachWarnings(model, acquisitionWarnings);
  }

  async function resolveAsset(asset, model, options = {}) {
    if (!isRecord(asset)) return { status: "unavailable", error: "附件信息无效。" };
    const name = cleanString(asset.name || "Attachment", 300);
    const mimeType = cleanString(asset.mimeType || "application/octet-stream", 200);
    const existingUrl = safeAssetUrl(asset.url, model && model.url);
    if (existingUrl && !asset.fileId) return { ...asset, name, mimeType, url: existingUrl, status: "ready" };
    const fileId = cleanString(asset.fileId || "", 500);
    const source = model && isRecord(model.source) ? model.source : {};
    const conversationId = cleanString(source.conversationId || "", 300);
    const page = supportedUrl(model && model.url);
    const fetchFn = typeof options.fetch === "function" ? options.fetch : (typeof root.fetch === "function" ? root.fetch.bind(root) : null);
    if (!fileId || !conversationId || !page || !fetchFn) {
      return { ...asset, name, mimeType, status: "unavailable", error: "无法从当前对话解析此附件。" };
    }
    const parameter = source.kind === "shared" ? "shared_conversation_id" : "conversation_id";
    let result = null;
    let dataUrl = "";
    try {
      await withSessionToken(fetchFn, page.origin, async (token) => {
        const endpoint = new URL("/backend-api/files/download/" + encodeURIComponent(fileId), page.origin);
        endpoint.searchParams.set(parameter, conversationId);
        const headers = { Accept: "application/json" };
        if (token) headers.Authorization = "Bearer " + token;
        result = await readResponseJson(await fetchFn(endpoint.href, {
          credentials: "include", redirect: "error", signal: requestSignal(), headers
        }), 1024 * 1024);
        if (!isRecord(result)) return;
        const candidateUrl = safeAssetUrl(result.download_url || result.public_url || result.url, model.url);
        if (!candidateUrl) return;
        const parsedUrl = new URL(candidateUrl);
        const metadataPath = "/backend-api/files/download/" + encodeURIComponent(fileId);
        if (parsedUrl.origin !== page.origin || !parsedUrl.pathname.startsWith("/backend-api/files/") ||
            (parsedUrl.pathname === metadataPath && parsedUrl.searchParams.has(parameter))) return;
        const mediaHeaders = { Accept: cleanString(result.mime_type || mimeType, 200) || "application/octet-stream" };
        if (token) mediaHeaders.Authorization = "Bearer " + token;
        const mediaResponse = await fetchFn(candidateUrl, {
          credentials: "include", redirect: "error", signal: requestSignal(), headers: mediaHeaders
        });
        dataUrl = await readAssetDataUrl(mediaResponse, cleanString(result.mime_type || mimeType, 200));
      });
    } catch (_) {
      result = null;
    }
    if (!isRecord(result)) return { ...asset, name, mimeType, status: "unavailable", error: "附件元数据不可用。" };
    const resolvedUrl = safeAssetUrl(result.download_url || result.public_url || result.url, model.url);
    if (!resolvedUrl) {
      return { ...asset, name: cleanString(result.file_name || name, 300), mimeType: cleanString(result.mime_type || mimeType, 200), status: "unavailable", error: "附件下载地址不在允许的站点范围内。" };
    }
    return {
      ...asset, name: cleanString(result.file_name || name, 300), mimeType: cleanString(result.mime_type || mimeType, 200),
      ...(Number.isFinite(result.size) ? { size: result.size } : {}), url: resolvedUrl,
      ...(dataUrl ? { dataUrl } : {}), status: "ready"
    };
  }

  api.normalizeConversation = normalizeConversation;
  api.requestPageSnapshot = requestPageSnapshot;
  api.collectConversation = collectConversation;
  api.resolveAsset = resolveAsset;
})(globalThis);
