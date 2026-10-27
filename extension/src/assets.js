((root) => {
  'use strict';
  const api = root.GptExporter || (root.GptExporter = {});
  const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
  api.loadConversationAssets = async function loadConversationAssets(model, options = {}) {
    if (!Array.isArray(model.assets) || !model.assets.length) return model;
    let bytes = model.assets.reduce((sum, asset) => sum + (asset.dataUrl?.length || 0) * .75, 0);
    let completed = 0;
    const deadline=Date.now()+90000;
    // Sequential fetches bound transient memory and avoid burst requests to signed-media endpoints.
    for (const asset of model.assets) {
      if (asset.status !== 'ready' || !asset.dataUrl) {
        try {
          if(Date.now()>deadline)throw new Error('本次媒体读取达到 90 秒预算，请单独选择未完成的消息后重试。');
          if (bytes >= MAX_TOTAL_BYTES) throw new Error('本次媒体超过 40 MB 内存预算。');
          const response = await root.chrome.runtime.sendMessage({type:'GPT_EXPORTER_ASSET',exportId:model.exportId,assetId:asset.id});
          if (!response?.ok) throw new Error(response?.error || '无法取得附件。');
          if (typeof response.asset.dataUrl !== 'string' || !/^data:[^,]+;base64,/.test(response.asset.dataUrl)) throw new Error('媒体响应格式无效。');
          const amount = response.asset.dataUrl.length * .75;
          if (bytes + amount > MAX_TOTAL_BYTES) throw new Error('本次媒体超过 40 MB 内存预算。');
          Object.assign(asset, response.asset, {status:'ready'}); bytes += amount;
        } catch (error) { asset.status = 'unavailable'; asset.error = error.message || '读取失败'; }
      }
      completed++;
      options.onProgress?.({completed,total:model.assets.length,name:asset.name,status:asset.status});
    }
    return model;
  };
})(globalThis);
