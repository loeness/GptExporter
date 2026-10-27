(() => {
  "use strict";

  if (!window || window.__gptExporterPageBridgeV2) return;
  try {
    Object.defineProperty(window, "__gptExporterPageBridgeV2", { value: true, configurable: false });
  } catch (_) {
    window.__gptExporterPageBridgeV2 = true;
  }

  const HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const REQUEST = "GPT_EXPORTER_PAGE_SNAPSHOT_REQUEST";
  const RESPONSE = "GPT_EXPORTER_PAGE_SNAPSHOT_RESPONSE";
  const MAX_JSON_BYTES = 2 * 1024 * 1024;
  const MAX_STREAM_BYTES = 2 * 1024 * 1024;
  const MAX_CLONE_NODES = 50000;
  const CAPTURE_TRUNCATED = Object.freeze({ __gptExporterCaptureTruncated: true });
  let state = {
    url: window.location.href, conversationId: "", conversationData: null, conversationTruncated: false,
    shareId: "", shareData: null, shareTruncated: false,
    temporaryId: "", temporaryData: null, temporaryTruncated: false
  };
  const originalFetch = window.fetch;

  function supportedPage(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !HOSTS.has(url.hostname.toLowerCase())) return null;
      return url;
    } catch (_) {
      return null;
    }
  }

  function routeFor(value) {
    const page = supportedPage(value);
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

  function resetForCurrentUrl() {
    const url = window.location.href;
    if (state.url !== url) {
      state = {
        url, conversationId: "", conversationData: null, conversationTruncated: false,
        shareId: "", shareData: null, shareTruncated: false,
        temporaryId: "", temporaryData: null, temporaryTruncated: false
      };
    }
  }

  function sensitiveKey(key) {
    return /token|authorization|cookie|password|secret|credential/i.test(key);
  }

  function safeUrlValue(value, origin) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const parsed = new URL(value, origin);
      for (const key of parsed.searchParams.keys()) {
        if (/token|auth|signature|(^|_)sig($|_)|credential|api[_-]?key/i.test(key)) return "";
      }
      return parsed.href;
    } catch (_) {
      return "";
    }
  }

  function safeClone(value) {
    let budget = MAX_CLONE_NODES;
    let truncated = false;
    const seen = new Set();
    function copy(item, key = "", depth = 0) {
      if (budget-- <= 0 || depth > 48) {
        truncated = true;
        return undefined;
      }
      if (item == null) return item;
      if (typeof item === "string") {
        if (item.length > 200000) {
          truncated = true;
          return undefined;
        }
        if (/(?:^|_)(?:url|uri)$/i.test(key)) {
          const cleaned = safeUrlValue(item, window.location.origin);
          return cleaned || undefined;
        }
        return item.slice(0, 200000);
      }
      if (typeof item === "number" || typeof item === "boolean") return item;
      if (typeof item !== "object") return undefined;
      if (seen.has(item)) return undefined;
      seen.add(item);
      let output;
      if (Array.isArray(item)) {
        output = [];
        if (item.length > 20000) truncated = true;
        for (const child of item.slice(0, 20000)) {
          const value = copy(child, "", depth + 1);
          if (value !== undefined) output.push(value);
        }
      } else {
        output = {};
        if (Object.keys(item).length > 20000) truncated = true;
        for (const name of Object.keys(item).slice(0, 20000)) {
          if (sensitiveKey(name) || name === "__proto__" || name === "constructor" || name === "prototype") continue;
          const value = copy(item[name], name, depth + 1);
          if (value !== undefined) output[name] = value;
        }
      }
      seen.delete(item);
      return output;
    }
    try {
      const safe = copy(value);
      if (truncated || !safe || typeof safe !== "object") return null;
      const serialized = JSON.stringify(safe);
      if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) return null;
      return JSON.parse(serialized);
    } catch (_) {
      return null;
    }
  }

  function findGraph(value) {
    const queue = [value];
    const seen = new Set();
    let inspected = 0;
    while (queue.length && inspected < 10000) {
      const item = queue.shift();
      if (!item || typeof item !== "object" || seen.has(item)) continue;
      seen.add(item);
      inspected++;
      if (!Array.isArray(item) && item.mapping && typeof item.mapping === "object") return item;
      const values = Array.isArray(item) ? item.slice(0, 2000) : Object.values(item).slice(0, 2000);
      for (const child of values) if (child && typeof child === "object") queue.push(child);
    }
    return null;
  }

  async function readBoundedText(stream, maxBytes, timeoutMs, onChunk) {
    if (!stream || typeof stream.getReader !== "function") return "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let timer;
    let timedOut = false;
    let complete = true;
    timer = setTimeout(() => {
      timedOut = true;
      try { reader.cancel(); } catch (_) {}
    }, timeoutMs);
    try {
      while (true) {
        const result = await reader.read();
        if (result.done || timedOut) break;
        bytes += result.value.byteLength;
        if (bytes > maxBytes) {
          complete = false;
          try { await reader.cancel(); } catch (_) {}
          return false;
        }
        const text = decoder.decode(result.value, { stream: true });
        if (onChunk) onChunk(text);
      }
      const tail = decoder.decode();
      if (tail && onChunk) onChunk(tail);
      if (timedOut) complete = false;
      return complete;
    } catch (_) {
      return "";
    } finally {
      clearTimeout(timer);
      try { reader.releaseLock(); } catch (_) {}
    }
  }

  async function readJsonClone(response) {
    try {
      const clone = response.clone();
      if (!clone.body || typeof clone.body.getReader !== "function") {
        const text = await clone.text();
        if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) return CAPTURE_TRUNCATED;
        const copied = safeClone(JSON.parse(text));
        return copied || CAPTURE_TRUNCATED;
      }
      const chunks = [];
      let size = 0;
      const complete = await readBoundedText(clone.body, MAX_JSON_BYTES, 15000, (chunk) => {
        size += new TextEncoder().encode(chunk).byteLength;
        if (size <= MAX_JSON_BYTES) chunks.push(chunk);
      });
      if (!complete || size > MAX_JSON_BYTES) return CAPTURE_TRUNCATED;
      if (!chunks.length) return null;
      const copied = safeClone(JSON.parse(chunks.join("")));
      return copied || CAPTURE_TRUNCATED;
    } catch (_) {
      return null;
    }
  }

  function findConversationId(value) {
    const queue = [value];
    const seen = new Set();
    let inspected = 0;
    while (queue.length && inspected < 10000) {
      const item = queue.shift();
      if (!item || typeof item !== "object" || seen.has(item)) continue;
      seen.add(item);
      inspected++;
      if (!Array.isArray(item) && typeof item.conversation_id === "string" && UUID.test(item.conversation_id)) return item.conversation_id.toLowerCase();
      if (Array.isArray(item)) queue.push(...item.slice(0, 1000));
      else for (const key of Object.keys(item).slice(0, 1000)) {
        const child = item[key];
        if (child && typeof child === "object") queue.push(child);
      }
    }
    return "";
  }

  function findSseGraph(value) {
    const candidate = findGraph(value);
    if (!candidate) return { value: null, truncated: false };
    const copied = safeClone(candidate);
    return { value: copied, truncated: !copied };
  }

  function parseAccept(input, init) {
    const headers = (init && init.headers) || (input && typeof input === "object" ? input.headers : null);
    try {
      if (headers && typeof headers.get === "function") return String(headers.get("accept") || "").toLowerCase();
      if (Array.isArray(headers)) {
        const item = headers.find((entry) => Array.isArray(entry) && String(entry[0]).toLowerCase() === "accept");
        return item ? String(item[1]).toLowerCase() : "";
      }
      if (headers && typeof headers === "object") {
        const key = Object.keys(headers).find((name) => name.toLowerCase() === "accept");
        return key ? String(headers[key]).toLowerCase() : "";
      }
    } catch (_) {}
    return "";
  }

  function requestUrl(input) {
    try {
      const value = typeof input === "string" ? input : input && input.url;
      if (typeof value !== "string" || !value.trim()) return null;
      return new URL(value, window.location.href);
    } catch (_) {
      return null;
    }
  }

  function observeTemporaryStream(response, observedUrl) {
    try {
      const clone = response.clone();
      if (!clone.body || typeof clone.body.getReader !== "function") return;
      let buffer = "";
      const observeLine = (line) => {
        if (!line.startsWith("data:")) return;
        const value = line.slice(5).trim();
        if (!value || value === "[DONE]") return;
        try {
          const eventData = JSON.parse(value);
          const id = findConversationId(eventData);
          const graph = findSseGraph(eventData);
          if (window.location.href !== observedUrl) return;
          resetForCurrentUrl();
          if (id) state.temporaryId = id;
          if (graph.value) state.temporaryData = graph.value;
          if (graph.truncated) state.temporaryTruncated = true;
        } catch (_) {}
      };
      const onChunk = (chunk) => {
        buffer += chunk;
        let lineEnd = buffer.indexOf("\n");
        while (lineEnd >= 0) {
          observeLine(buffer.slice(0, lineEnd).replace(/\r$/, ""));
          buffer = buffer.slice(lineEnd + 1);
          lineEnd = buffer.indexOf("\n");
        }
      };
      void readBoundedText(clone.body, MAX_STREAM_BYTES, 120000, onChunk).then((complete) => {
        observeLine(buffer.replace(/\r$/, ""));
        if (!complete && window.location.href === observedUrl) {
          resetForCurrentUrl();
          state.temporaryTruncated = true;
        }
      });
    } catch (_) {}
  }

  function selectedShareLoader(route) {
    if (!route || route.kind !== "shared") return { value: null, truncated: false };
    try {
      const loaderData = window.__reactRouterContext && window.__reactRouterContext.state &&
        window.__reactRouterContext.state.loaderData;
      if (!loaderData || typeof loaderData !== "object") return { value: null, truncated: false };
      const routeData = loaderData["routes/share.$shareId.($action)"];
      if (!routeData || typeof routeData !== "object") return { value: null, truncated: false };
      const responseData = routeData.serverResponse && routeData.serverResponse.data;
      const graph = findGraph(responseData) || findGraph(routeData);
      if (!graph) return { value: null, truncated: false };
      const copied = safeClone(graph);
      return { value: copied, truncated: !copied };
    } catch (_) {
      return { value: null, truncated: false };
    }
  }

  function makeSnapshot(url) {
    resetForCurrentUrl();
    const route = routeFor(url);
    const snapshot = {};
    let truncated = false;
    if (route && route.kind === "api" && state.conversationId === route.id) {
      if (state.conversationData) snapshot.conversationData = state.conversationData;
      truncated = truncated || state.conversationTruncated;
    }
    if (route && route.kind === "shared") {
      const loader = selectedShareLoader(route);
      const value = loader.value || (state.shareId === route.id ? state.shareData : null);
      if (value) snapshot.shareData = value;
      truncated = truncated || loader.truncated || (state.shareId === route.id && state.shareTruncated);
    }
    if (route && route.kind === "temporary") {
      if (state.temporaryId) snapshot.temporaryId = state.temporaryId;
      if (state.temporaryData) snapshot.temporaryData = state.temporaryData;
      truncated = truncated || state.temporaryTruncated;
    }
    if (truncated) snapshot.truncated = true;
    return safeClone(snapshot) || { truncated: true };
  }

  window.addEventListener("message", (event) => {
    const page = supportedPage(window.location.href);
    if (!page || event.source !== window || event.origin !== page.origin) return;
    const data = event.data;
    if (!data || data.type !== REQUEST || typeof data.nonce !== "string" ||
        !/^[a-z0-9-]{16,128}$/i.test(data.nonce) || data.url !== window.location.href) return;
    const response = { type: RESPONSE, nonce: data.nonce, url: data.url, snapshot: makeSnapshot(data.url) };
    try { window.postMessage(response, page.origin); } catch (_) {}
  });

  if (typeof originalFetch === "function") {
    window.fetch = function (...args) {
      let result;
      try {
        result = Reflect.apply(originalFetch, this, args);
      } catch (error) {
        throw error;
      }
      try {
        resetForCurrentUrl();
        const observedUrl = window.location.href;
        const route = routeFor(observedUrl);
        const request = requestUrl(args[0]);
        if (!route || !request || request.origin !== window.location.origin || !request.pathname.startsWith("/backend-api/")) return result;
        const conversation = request.pathname.match(/^\/backend-api\/conversation\/([0-9a-f-]{36})\/?$/i);
        const share = request.pathname.match(/^\/backend-api\/share\/([0-9a-f-]{36})\/?$/i);
        const temporaryStream = route.kind === "temporary" && request.pathname === "/backend-api/f/conversation" &&
          parseAccept(args[0], args[1]).includes("text/event-stream");
        const matchingConversation = route.kind === "api" && conversation && UUID.test(conversation[1]) && conversation[1].toLowerCase() === route.id;
        const matchingShare = route.kind === "shared" && share && UUID.test(share[1]) && share[1].toLowerCase() === route.id;
        if (!temporaryStream && !matchingConversation && !matchingShare) return result;
        Promise.resolve(result).then((response) => {
          if (window.location.href !== observedUrl || !response || !response.ok) return;
          if (temporaryStream) {
            observeTemporaryStream(response, observedUrl);
            return;
          }
          void readJsonClone(response).then((value) => {
            if (window.location.href !== observedUrl) return;
            resetForCurrentUrl();
            if (value === CAPTURE_TRUNCATED) {
              if (matchingConversation) {
                state.conversationId = route.id;
                state.conversationTruncated = true;
              } else if (matchingShare) {
                state.shareId = route.id;
                state.shareTruncated = true;
              }
              return;
            }
            if (!value) return;
            const graph = findGraph(value);
            if (!graph) return;
            if (matchingConversation) {
              state.conversationId = route.id;
              state.conversationData = safeClone(graph);
              state.conversationTruncated = !state.conversationData;
            } else if (matchingShare) {
              state.shareId = route.id;
              state.shareData = safeClone(graph);
              state.shareTruncated = !state.shareData;
            }
          }).catch(() => {});
        }).catch(() => {});
      } catch (_) {}
      return result;
    };
  }
})();
