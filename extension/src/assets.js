((root) => {
  'use strict';
  const api = root.GptExporter || (root.GptExporter = {});
  const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
  const MAX_CONCURRENT_FETCHES = 2;
  const LOAD_BUDGET = 90000;
  const BUDGET_ERROR = '本次媒体超过 40 MB 内存预算。';
  const TIME_ERROR = '本次媒体读取达到 90 秒预算，请单独选择未完成的消息后重试。';
  const inFlight = new WeakMap();
  const cacheUsage = new WeakMap();
  const fetchQueue = [];
  let activeFetches = 0;

  const isReady = asset => asset.status === 'ready' && Boolean(asset.dataUrl);
  const byteEstimate = asset => (asset.dataUrl?.length || 0) * .75;

  function runQueuedFetch() {
    if (activeFetches >= MAX_CONCURRENT_FETCHES || !fetchQueue.length) return;
    activeFetches += 1;
    void fetchQueue.shift()().finally(() => {
      activeFetches -= 1;
      runQueuedFetch();
    });
  }

  function fetchAsset(exportId, asset, deadline) {
    let requests = inFlight.get(asset);
    if (!requests) {
      requests = new Map();
      inFlight.set(asset, requests);
    }
    if (requests.has(exportId)) return requests.get(exportId);
    const request = new Promise((resolve, reject) => {
      fetchQueue.push(async () => {
        try {
          if (Date.now() >= deadline) throw new Error(TIME_ERROR);
          const response = await root.chrome.runtime.sendMessage({
            type: 'GPT_EXPORTER_ASSET',
            exportId,
            assetId: asset.id
          });
          if (!response?.ok) throw new Error(response?.error || '无法取得附件。');
          if (typeof response.asset?.dataUrl !== 'string' || !/^data:[^,]+;base64,/.test(response.asset.dataUrl)) {
            throw new Error('媒体响应格式无效。');
          }
          resolve(response.asset);
        } catch (error) {
          reject(error);
        }
      });
      runQueuedFetch();
    });
    requests.set(exportId, request);
    const forget = () => { requests.delete(exportId); };
    void request.then(forget, forget);
    return request;
  }

  api.loadConversationAssets = async function loadConversationAssets(model, options = {}) {
    const assets = model.assets;
    if (!Array.isArray(assets) || !assets.length) return model;
    // A preview and export may share the complete cache while selecting different subsets.
    const cache = options.cacheAssets || assets;
    let usage = cacheUsage.get(cache);
    if (!usage) {
      usage = { bytes: [...new Set(cache)].reduce((sum, asset) => sum + byteEstimate(asset), 0), callers: 0 };
      cacheUsage.set(cache, usage);
    }
    usage.callers += 1;
    const initialBytes = Math.max(0, Number(options.initialBytes) || 0);
    const deadline = Date.now() + LOAD_BUDGET;
    const pending = [];
    let budgetTimer;
    const budgetExpired = new Promise(resolve => {
      budgetTimer = root.setTimeout(() => resolve({error: new Error(TIME_ERROR)}), LOAD_BUDGET);
    });

    async function prepare(asset) {
      if (isReady(asset) || options.shouldLoad?.(asset) === false) return {};
      if (Date.now() >= deadline) return {error: new Error(TIME_ERROR)};
      if (usage.bytes + initialBytes >= MAX_TOTAL_BYTES) return {error: new Error(BUDGET_ERROR)};
      try {
        const fetched = fetchAsset(model.exportId, asset, deadline).then(media => ({media}));
        return await Promise.race([fetched, budgetExpired]);
      } catch (error) {
        return {error};
      }
    }

    try {
      for (let index = 0; index < assets.length; index += 1) {
        while (pending.length < MAX_CONCURRENT_FETCHES && index + pending.length < assets.length) {
          pending.push(prepare(assets[index + pending.length]));
        }
        const asset = assets[index];
        const {media, error} = await pending.shift();
        if (!isReady(asset)) {
          if (media && usage.bytes + initialBytes + byteEstimate(media) - byteEstimate(asset) <= MAX_TOTAL_BYTES) {
            usage.bytes += byteEstimate(media) - byteEstimate(asset);
            Object.assign(asset, media, {status: 'ready'});
            delete asset.error;
          } else if (media || error) {
            asset.status = 'unavailable';
            asset.error = media ? BUDGET_ERROR : error.message || '读取失败';
          }
        }
        options.onProgress?.({completed: index + 1, total: assets.length, name: asset.name, status: asset.status, asset});
      }
    } finally {
      root.clearTimeout(budgetTimer);
      usage.callers -= 1;
      if (!usage.callers) cacheUsage.delete(cache);
    }
    return model;
  };
})(globalThis);
