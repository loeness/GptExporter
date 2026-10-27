"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

require("../extension/src/conversation.js");
require("../extension/src/history.js");

const IDS = {
  conversation: "11111111-1111-4111-8111-111111111111",
  temporary: "22222222-2222-4222-8222-222222222222",
  share: "33333333-3333-4333-8333-333333333333"
};
const FENCE = String.fromCharCode(96).repeat(3);

test('accepts only signed Azure media URLs and rejects userinfo or empty URLs',async()=>{
  const model={url:'https://chatgpt.com/c/'+IDS.conversation,source:{conversationId:IDS.conversation}};
  const safe='https://abc123.blob.core.windows.net/container/image.png?sv=2025-01-01&se=2030-01-01&sig=fixture';
  const result=await globalThis.GptExporter.resolveAsset({id:'azure',url:safe,kind:'image'},model);
  assert.equal(result.url,safe);assert.equal(result.status,'ready');
  for(const url of [undefined,'','https://abc123.blob.core.windows.net/container/image.png','https://user:password@chatgpt.com/file']){
    const denied=await globalThis.GptExporter.resolveAsset({id:'bad',url,kind:'image'},model,{fetch:async()=>{throw new Error('network disabled');}});
    assert.equal(denied.status,'unavailable');
  }
});

function graph(overrides = {}) {
  const fence = String.fromCharCode(96).repeat(3);
  return {
    conversation_id: IDS.conversation,
    title: "Synthetic branches",
    current_node: "assistant-a",
    mapping: {
      root: { parent: null, children: ["user-a"], message: null },
      "user-a": {
        parent: "root",
        children: ["assistant-a", "assistant-b"],
        message: {
          id: "user-a",
          author: { role: "user" },
          content: {
            content_type: "text",
            parts: [
              "Please keep the formula $x^2 + 1$ and diagram source.",
              { content_type: "image_asset_pointer", asset_pointer: "sediment://synthetic-image-1?variant=small" }
            ],
            attachments: [{ id: "synthetic-file-1", name: "chart.png", mime_type: "image/png" }]
          },
          create_time: 1700000000
        }
      },
      "assistant-a": {
        parent: "user-a",
        children: ["user-b"],
        message: {
          id: "assistant-a",
          author: { role: "assistant" },
          content: { content_type: "text", parts: [fence + "mermaid\nflowchart LR\nA-->B\n" + fence] }
        }
      },
      "user-b": {
        parent: "assistant-a",
        children: [],
        message: { id: "user-b", author: { role: "user" }, content: { content_type: "text", parts: ["Continue"] } }
      },
      "assistant-b": {
        parent: "user-a",
        children: [],
        message: { id: "assistant-b", author: { role: "assistant" }, content: { content_type: "text", parts: ["Alternate answer"] } }
      }
    },
    ...overrides
  };
}

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("normalizes the complete mapping, all branches, raw Markdown, and media metadata", () => {
  const model = globalThis.GptExporter.normalizeConversation(graph(), {
    url: "https://chatgpt.com/c/" + IDS.conversation,
    kind: "api",
    complete: true
  });

  assert.equal(model.schemaVersion, 2);
  assert.deepEqual(model.messages.map((message) => message.id), ["user-a", "assistant-a", "user-b", "assistant-b"]);
  assert.equal(model.branches.length, 2);
  assert.deepEqual(model.branches[0].messageIds, ["user-a", "assistant-a", "user-b"]);
  assert.deepEqual(model.branches[1].messageIds, ["user-a", "assistant-b"]);
  assert.equal(model.activeBranchId, "branch-1");
  assert.equal(model.source.complete, true);
  assert.match(model.messages[0].markdown, /\$x\^2 \+ 1\$/);
  assert.ok(model.messages[1].markdown.includes(FENCE + "mermaid"));
  assert.match(model.messages[0].markdown, /gpt-exporter-asset:asset-/);
  assert.equal(model.assets.length, 2);
  assert.deepEqual(model.messages[0].assetIds, model.assets.map((asset) => asset.id));
  assert.equal(model.assets[0].fileId, "synthetic-image-1");
  assert.equal(model.assets[0].url, undefined);
  assert.equal(model.assets[1].mimeType, "image/png");
  assert.equal(model.assets[0].status, "pending");
  assert.equal(model.messages[0].createTime, new Date(1700000000 * 1000).toISOString());
});

test("marks cycles, missing parents, and flat message payloads incomplete", () => {
  const cyclic = graph({
    current_node: "assistant-a",
    mapping: {
      "assistant-a": { parent: "assistant-b", children: ["assistant-b"], message: { id: "assistant-a", author: { role: "assistant" }, content: { parts: ["A"] } } },
      "assistant-b": { parent: "assistant-a", children: ["assistant-a"], message: { id: "assistant-b", author: { role: "assistant" }, content: { parts: ["B"] } } }
    }
  });
  const cycleModel = globalThis.GptExporter.normalizeConversation(cyclic, { url: "https://chatgpt.com/c/" + IDS.conversation, kind: "api" });
  assert.equal(cycleModel.source.complete, false);
  assert.ok(cycleModel.warnings.some((warning) => /循环/.test(warning)));
  assert.equal(cycleModel.messages.length, 2);

  const missingParent = graph({
    mapping: {
      orphan: { parent: "absent-parent", children: [], message: { id: "orphan", author: { role: "user" }, content: { parts: ["Orphan"] } } }
    },
    current_node: "orphan"
  });
  const missingModel = globalThis.GptExporter.normalizeConversation(missingParent, { url: "https://chatgpt.com/c/" + IDS.conversation, kind: "api" });
  assert.equal(missingModel.source.complete, false);
  assert.ok(missingModel.warnings.some((warning) => /缺失的父节点/.test(warning)));

  const noCurrentNode = graph({ current_node: undefined });
  const noCurrentNodeModel = globalThis.GptExporter.normalizeConversation(noCurrentNode, {
    url: "https://chatgpt.com/c/" + IDS.conversation,
    kind: "api"
  });
  assert.equal(noCurrentNodeModel.source.complete, false);
  assert.equal(noCurrentNodeModel.messages.length, 4);
  assert.ok(noCurrentNodeModel.warnings.some((warning) => /current_node/.test(warning)));

  const flat = globalThis.GptExporter.normalizeConversation({ messages: [{ id: "one", role: "user", markdown: "flat", text: "flat" }] }, {
    url: "https://chatgpt.com/c/" + IDS.conversation,
    kind: "api"
  });
  assert.equal(flat.source.complete, false);
  assert.equal(flat.branches.length, 1);
  assert.ok(flat.warnings.some((warning) => /扁平消息/.test(warning)));
});

test("collects a persistent conversation with ephemeral session token", async () => {
  const url = "https://chatgpt.com/c/" + IDS.conversation;
  const dom = new JSDOM("<main><h1>Loaded fallback</h1><div data-message-author-role='user'>Loaded</div></main>", { url });
  const calls = [];
  const fakeFetch = async (requestUrl, init = {}) => {
    calls.push({ url: requestUrl, headers: init.headers || {}, signal: init.signal });
    if (requestUrl.endsWith("/api/auth/session")) return response({ accessToken: "synthetic-access-token" });
    if (requestUrl.endsWith("/backend-api/conversation/" + IDS.conversation)) return response(graph());
    return response({}, 404);
  };
  const model = await globalThis.GptExporter.collectConversation({
    document: dom.window.document,
    url,
    fetch: fakeFetch,
    bridge: async () => null
  });

  assert.equal(model.source.kind, "api");
  assert.equal(model.source.complete, true);
  assert.equal(model.messages.length, 4);
  assert.ok(calls.some((call) => call.url.endsWith("/backend-api/conversation/" + IDS.conversation) &&
    call.headers.Authorization === "Bearer synthetic-access-token"));
  assert.ok(calls.every((call) => call.signal && call.signal.aborted === false));
  assert.ok(!JSON.stringify(model).includes("synthetic-access-token"));
  assert.ok(!JSON.stringify(model).includes("Authorization"));
  dom.window.close();
});

test("uses share snapshots on both supported shared route shapes", async () => {
  for (const url of [
    "https://chatgpt.com/share/" + IDS.share,
    "https://chatgpt.com/g/custom-gpt/shared/c/" + IDS.share
  ]) {
    const dom = new JSDOM("<main></main>", { url });
    const model = await globalThis.GptExporter.collectConversation({
      document: dom.window.document,
      url,
      fetch: async () => { throw new Error("share snapshot should avoid fetch"); },
      bridge: async () => ({ shareData: graph({ share_id: IDS.share, conversation_id: undefined }) })
    });
    assert.equal(model.source.kind, "shared");
    assert.equal(model.source.complete, true);
    assert.equal(model.messages.length, 4);
    dom.window.close();
  }
});

test("a bridge truncation flag prevents complete status and still tries the API", async () => {
  const url = "https://chatgpt.com/c/" + IDS.conversation;
  const dom = new JSDOM("<main></main>", { url });
  const calls = [];
  const model = await globalThis.GptExporter.collectConversation({
    document: dom.window.document,
    url,
    fetch: async (requestUrl, init = {}) => {
      calls.push(requestUrl);
      if (requestUrl.endsWith("/api/auth/session")) return response({});
      return response({}, 404);
    },
    bridge: async () => ({ conversationData: graph(), truncated: true })
  });
  assert.ok(calls.some((requestUrl) => requestUrl.endsWith("/backend-api/conversation/" + IDS.conversation)));
  assert.equal(model.source.kind, "api");
  assert.equal(model.source.complete, false);
  assert.equal(model.messages.length, 4);
  assert.ok(model.warnings.some((warning) => /标记为部分内容/.test(warning)));
  dom.window.close();
});

test("temporary stream ID is exchanged for a full conversation API snapshot", async () => {
  const url = "https://chatgpt.com/?temporary-chat=true";
  const dom = new JSDOM("<main></main>", { url });
  const calls = [];
  const temporaryGraph = graph({ conversation_id: IDS.temporary });
  const fakeFetch = async (requestUrl, init = {}) => {
    calls.push({ url: requestUrl, headers: init.headers || {}, signal: init.signal });
    if (requestUrl.endsWith("/api/auth/session")) return response({ accessToken: "temporary-fixture-token" });
    if (requestUrl.endsWith("/backend-api/conversation/" + IDS.temporary)) return response(temporaryGraph);
    return response({}, 404);
  };
  const model = await globalThis.GptExporter.collectConversation({
    document: dom.window.document,
    url,
    fetch: fakeFetch,
    bridge: async () => ({ temporaryId: IDS.temporary })
  });
  assert.equal(model.source.kind, "temporary");
  assert.equal(model.source.complete, true);
  assert.equal(model.source.conversationId, IDS.temporary);
  assert.equal(model.messages.length, 4);
  assert.ok(!JSON.stringify(model).includes("temporary-fixture-token"));
  dom.window.close();
});

test("falls back to DOM with incomplete source when temporary API data is unavailable", async () => {
  const url = "https://chatgpt.com/?temporary-chat=true";
  const dom = new JSDOM("<main><div data-message-author-role='user' data-message-id='loaded'>Loaded only</div></main>", { url });
  const model = await globalThis.GptExporter.collectConversation({
    document: dom.window.document,
    url,
    fetch: async () => response({}, 404),
    bridge: async () => ({ temporaryId: "" })
  });
  assert.equal(model.source.kind, "dom");
  assert.equal(model.source.complete, false);
  assert.equal(model.messages.length, 1);
  assert.ok(model.warnings.some((warning) => /临时对话/.test(warning)));
  assert.ok(model.warnings.some((warning) => /DOM 回退/.test(warning)));
  dom.window.close();
});

test("tries the temporary conversation API before returning an SSE partial graph", async () => {
  const url = "https://chatgpt.com/?temporary-chat=true";
  const dom = new JSDOM("<main></main>", { url });
  const calls = [];
  const fakeFetch = async (requestUrl, init = {}) => {
    calls.push({ url: requestUrl, headers: init.headers || {}, signal: init.signal });
    if (requestUrl.endsWith("/api/auth/session")) return response({ accessToken: "partial-fixture-token" });
    return response({}, 404);
  };
  const model = await globalThis.GptExporter.collectConversation({
    document: dom.window.document,
    url,
    fetch: fakeFetch,
    bridge: async () => ({ temporaryId: IDS.temporary, temporaryData: graph({ conversation_id: IDS.temporary }) })
  });
  assert.ok(calls.some((call) => call.url.endsWith("/backend-api/conversation/" + IDS.temporary)));
  assert.equal(model.source.kind, "temporary");
  assert.equal(model.source.complete, false);
  assert.equal(model.source.conversationId, IDS.temporary);
  assert.equal(model.messages.length, 4);
  assert.ok(model.warnings.some((warning) => /临时对话快照可能/.test(warning)));
  assert.ok(!JSON.stringify(model).includes("partial-fixture-token"));
  assert.ok(calls.every((call) => call.signal && call.signal.aborted === false));
  dom.window.close();
});

test("DOM fallback adds only approved image and attachment URLs and demotes external images", async () => {
  const url = "https://chatgpt.com/c/" + IDS.conversation;
  const markup = "<main><div data-message-author-role=\"user\" data-message-id=\"dom-user\">" +
    "<p>See these files.</p>" +
    "<img src=\"https://files.oaiusercontent.com/synthetic/plot.png\" alt=\"Plot\">" +
    "<img src=\"https://attacker.example/remote.png\" alt=\"Remote\">" +
    "<a download=\"notes.pdf\" href=\"/backend-api/files/download/dom-file?conversation_id=" + IDS.conversation + "\">notes.pdf</a>" +
    "</div></main>";
  const dom = new JSDOM(markup, { url });
  const calls = [];
  const fakeFetch = async (requestUrl, init = {}) => {
    calls.push(requestUrl);
    return response({}, 404);
  };
  const model = await globalThis.GptExporter.collectConversation({
    document: dom.window.document,
    url,
    fetch: fakeFetch,
    bridge: async () => null
  });
  assert.equal(model.source.kind, "dom");
  assert.equal(model.source.complete, false);
  assert.equal(model.assets.length, 2);
  assert.equal(model.assets[0].url, "https://files.oaiusercontent.com/synthetic/plot.png");
  assert.equal(model.assets[0].kind, "image");
  assert.equal(model.assets[1].fileId, "dom-file");
  assert.equal(model.assets[1].mimeType, "application/pdf");
  assert.equal(model.messages[0].assetIds.length, 2);
  assert.match(model.messages[0].markdown, /gpt-exporter-asset:dom-asset-/);
  assert.match(model.messages[0].markdown, /\[Remote\]\(<https:\/\/attacker\.example\/remote\.png>\)/);
  assert.doesNotMatch(model.messages[0].markdown, /!\[Remote\]/);
  assert.ok(!model.assets.some((asset) => asset.url.includes("attacker.example")));
  assert.ok(!model.assets.some((asset) => asset.url.endsWith("/c/undefined")));
  assert.ok(calls.every((requestUrl) => !requestUrl.includes("attacker.example")));
  dom.window.close();
});

test("resolves file metadata only for permitted signed URL hosts", async () => {
  const url = "https://chatgpt.com/c/" + IDS.conversation;
  const calls = [];
  const fakeFetch = async (requestUrl, init = {}) => {
    calls.push({ url: requestUrl, headers: init.headers || {}, signal: init.signal });
    if (requestUrl.endsWith("/api/auth/session")) return response({ accessToken: "asset-fixture-token" });
    if (requestUrl.includes("/backend-api/files/download/synthetic-file-1")) {
      return response({
        file_name: "chart.png",
        mime_type: "image/png",
        size: 123,
        download_url: "https://files.oaiusercontent.com/synthetic/chart.png?opaque=signed"
      });
    }
    return response({}, 404);
  };
  const model = { url, source: { kind: "api", conversationId: IDS.conversation } };
  const resolved = await globalThis.GptExporter.resolveAsset({
    id: "asset-1", messageId: "user-a", kind: "image", fileId: "synthetic-file-1", name: "chart.png", mimeType: "image/png", status: "pending"
  }, model, { fetch: fakeFetch });
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.url, "https://files.oaiusercontent.com/synthetic/chart.png?opaque=signed");
  assert.equal(resolved.size, 123);
  assert.ok(calls.some((call) => call.url.includes("conversation_id=" + IDS.conversation) &&
    call.headers.Authorization === "Bearer asset-fixture-token"));
  assert.ok(calls.every((call) => call.signal && call.signal.aborted === false));
  assert.ok(!JSON.stringify(resolved).includes("asset-fixture-token"));

  let externalFetchCount = 0;
  const rejected = await globalThis.GptExporter.resolveAsset({
    id: "asset-external", messageId: "user-a", kind: "image", url: "https://attacker.example/image.png", status: "pending"
  }, model, { fetch: async () => { externalFetchCount++; return response({}); } });
  assert.equal(rejected.status, "unavailable");
  assert.equal(externalFetchCount, 0);
});

test("keeps same-origin attachment Authorization local and returns only its bounded data URL", async () => {
  const url = "https://chatgpt.com/c/" + IDS.conversation;
  const calls = [];
  const fakeFetch = async (requestUrl, init = {}) => {
    calls.push({ url: requestUrl, headers: init.headers || {}, signal: init.signal });
    if (requestUrl.endsWith("/api/auth/session")) return response({ accessToken: "local-only-attachment-token" });
    if (requestUrl.includes("/backend-api/files/download/synthetic-file-1")) {
      return response({
        file_name: "chart.png",
        mime_type: "image/png",
        download_url: "https://chatgpt.com/backend-api/files/content/synthetic-file-1"
      });
    }
    if (requestUrl.endsWith("/backend-api/files/content/synthetic-file-1")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } });
    }
    return response({}, 404);
  };
  const model = { url, source: { kind: "api", conversationId: IDS.conversation } };
  const resolved = await globalThis.GptExporter.resolveAsset({
    id: "asset-1", messageId: "user-a", kind: "image", fileId: "synthetic-file-1", name: "chart.png", mimeType: "image/png", status: "pending"
  }, model, { fetch: fakeFetch });
  assert.equal(resolved.dataUrl, "data:image/png;base64,AQID");
  assert.ok(calls.some((call) => call.url.endsWith("/backend-api/files/content/synthetic-file-1") &&
    call.headers.Authorization === "Bearer local-only-attachment-token"));
  assert.ok(calls.every((call) => call.signal && call.signal.aborted === false));
  assert.ok(!JSON.stringify(resolved).includes("local-only-attachment-token"));
});
