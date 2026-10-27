"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "../extension/src/page-bridge.js"), "utf8");
const IDS = {
  conversation: "11111111-1111-4111-8111-111111111111",
  share: "33333333-3333-4333-8333-333333333333",
  temporary: "22222222-2222-4222-8222-222222222222"
};
const REQUEST = "GPT_EXPORTER_PAGE_SNAPSHOT_REQUEST";

function graph() {
  return {
    conversation_id: IDS.conversation,
    current_node: "message-1",
    mapping: {
      root: { parent: null, children: ["message-1"], message: null },
      "message-1": {
        parent: "root",
        children: [],
        message: {
          id: "message-1",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["Synthetic response"] }
        }
      }
    }
  };
}

function setup({ url = "https://chatgpt.com/c/" + IDS.conversation, fetch: fetchFn, loaderData } = {}) {
  const listeners = new Map();
  const sent = [];
  const location = new URL(url);
  const window = {
    location,
    crypto: webcrypto,
    fetch: fetchFn || (async () => new Response("{}", { status: 200 })),
    __reactRouterContext: { state: { loaderData: loaderData || {} } },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      if (listeners.has(type)) listeners.get(type).delete(handler);
    },
    postMessage(data, targetOrigin) {
      sent.push({ data, targetOrigin });
    }
  };
  const context = vm.createContext({
    window,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Set,
    Map,
    Array,
    Object,
    String,
    JSON,
    Promise,
    Reflect,
    Error,
    RegExp,
    Date,
    setTimeout,
    clearTimeout,
    console: { error() {}, warn() {}, log() {} }
  });
  vm.runInContext(source, context, { filename: "page-bridge.js" });
  function dispatch(data, { origin = location.origin, eventSource = window } = {}) {
    const event = { data, origin, source: eventSource };
    for (const handler of [...(listeners.get("message") || [])]) handler(event);
  }
  function requestSnapshot(nonce = "0123456789abcdef") {
    dispatch({ type: REQUEST, nonce, url: location.href });
    return sent.at(-1);
  }
  return { window, sent, dispatch, requestSnapshot, listeners };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test("captures only the current same-origin conversation API response", async () => {
  const env = setup({
    fetch: async () => new Response(JSON.stringify({
      ...graph(),
      accessToken: "synthetic-should-not-escape",
      asset_url: "https://files.oaiusercontent.com/image.png?token=synthetic-secret"
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  let authorizationReads = 0;
  const headers = {};
  Object.defineProperty(headers, "Authorization", {
    get() { authorizationReads++; throw new Error("bridge must not read authorization"); }
  });
  await env.window.fetch("https://example.com/backend-api/conversation/" + IDS.conversation, { headers });
  await settle();
  const empty = env.requestSnapshot();
  assert.equal(empty.data.snapshot.conversationData, undefined);

  await env.window.fetch("/backend-api/conversation/" + IDS.conversation, { headers });
  await settle();
  const captured = env.requestSnapshot("fedcba9876543210");
  assert.equal(captured.targetOrigin, "https://chatgpt.com");
  assert.equal(captured.data.snapshot.conversationData.conversation_id, IDS.conversation);
  assert.equal(captured.data.snapshot.conversationData.accessToken, undefined);
  assert.equal(captured.data.snapshot.conversationData.asset_url, undefined);
  assert.equal(authorizationReads, 0);
});

test("snapshots only the selected shared route loader and rejects wrong origin or source", () => {
  const shared = { ...graph(), share_id: IDS.share };
  const env = setup({
    url: "https://chatgpt.com/share/" + IDS.share,
    loaderData: {
      "routes/share.$shareId.($action)": { serverResponse: { data: shared } },
      unrelated: { mapping: { secret: true }, current_node: "secret" }
    }
  });
  env.dispatch({ type: REQUEST, nonce: "0123456789abcdef", url: env.window.location.href }, { origin: "https://evil.example" });
  env.dispatch({ type: REQUEST, nonce: "0123456789abcdef", url: env.window.location.href }, { eventSource: {} });
  assert.equal(env.sent.length, 0);

  const result = env.requestSnapshot();
  assert.equal(result.data.snapshot.shareData.share_id, IDS.share);
  assert.equal(result.data.snapshot.unrelated, undefined);
});

test("shared route without loader context returns an empty snapshot safely", () => {
  const env = setup({ url: "https://chatgpt.com/share/" + IDS.share });
  const result = env.requestSnapshot();
  assert.equal(Object.keys(result.data.snapshot).length, 0);
});

test("loader data over the clone budget returns a visible truncation flag", () => {
  const oversized = graph();
  oversized.mapping["message-1"].message.content.parts = ["x".repeat(200001)];
  const env = setup({
    url: "https://chatgpt.com/share/" + IDS.share,
    loaderData: { "routes/share.$shareId.($action)": { serverResponse: { data: oversized } } }
  });
  const result = env.requestSnapshot();
  assert.equal(result.data.snapshot.shareData, undefined);
  assert.equal(result.data.snapshot.truncated, true);
});

test("captures a temporary conversation ID from a bounded SSE clone without reading authorization", async () => {
  let authorizationReads = 0;
  const headers = { Accept: "text/event-stream" };
  Object.defineProperty(headers, "Authorization", {
    get() { authorizationReads++; throw new Error("bridge must not read authorization"); }
  });
  const sse = "data: {\"message\":{\"conversation_id\":\"" + IDS.temporary + "\"}}\n\n";
  const env = setup({
    url: "https://chatgpt.com/?temporary-chat=true",
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      }
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
  });
  await env.window.fetch("/backend-api/f/conversation", { headers });
  await settle();
  const result = env.requestSnapshot();
  assert.equal(result.data.snapshot.temporaryId, IDS.temporary);
  assert.equal(result.data.snapshot.temporaryData, undefined);
  assert.equal(authorizationReads, 0);
});

test("ignores invalid snapshot nonces and unsupported page origins", () => {
  const env = setup({ url: "https://example.com/c/" + IDS.conversation });
  env.dispatch({ type: REQUEST, nonce: "short", url: env.window.location.href }, { origin: "https://example.com" });
  assert.equal(env.sent.length, 0);
});
