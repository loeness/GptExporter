(function attachVisualCapture(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const MAX_FRAMES = 24;
  const MAX_BYTES = 24 * 1024 * 1024;
  const CAPTURE_INTERVAL = 950;
  const CAPTURE_TIMEOUT = 12000;
  const RECORDING_TIMEOUT = 120000;
  const MIN_SIDE = 8;

  let route = '';
  let frames = [];
  let view = null;
  let pending = false;
  let lastRequest = 0;
  let watching = false;

  function syncRoute() {
    const current = root.location.href;
    if (route === current) return;
    close();
    route = current;
    frames = [];
  }

  function viewport() {
    return { viewportWidth: root.innerWidth, viewportHeight: root.innerHeight };
  }

  function status(message) {
    if (view) view.status.textContent = message;
  }

  function close() {
    if (!view) return;
    stopRecording(view);
    view.host.remove();
    view = null;
  }

  function stopRecording(current) {
    clearTimeout(current.timer);
    clearTimeout(current.deadline);
    current.recording = false;
    current.candidate = null;
    current.revision++;
    update(current);
  }

  function update(current) {
    current.count.textContent = `已保存 ${frames.length} / ${MAX_FRAMES} 帧`;
    current.save.disabled = !current.region || current.selecting || current.recording || pending;
    current.record.disabled = !current.recording && (!current.region || current.selecting || pending);
    current.record.textContent = current.recording ? '停止录制' : '录制步骤';
    current.undo.disabled = !frames.length || current.recording;
    current.clear.disabled = !frames.length || current.recording;
    current.select.textContent = current.selecting ? '取消框选' : (current.region ? '重新框选' : '框选区域');
  }

  function showRegion(current, region) {
    current.outline.hidden = !region;
    if (!region) return;
    Object.assign(current.outline.style, {
      left: `${region.x}px`, top: `${region.y}px`, width: `${region.width}px`, height: `${region.height}px`
    });
  }

  function setSelecting(current, selecting) {
    current.selecting = selecting;
    current.dragStart = null;
    current.selector.hidden = !selecting;
    showRegion(current, current.region);
    update(current);
  }

  function regionFrom(start, event) {
    const dimensions = viewport();
    const endX = Math.max(0, Math.min(event.clientX, dimensions.viewportWidth));
    const endY = Math.max(0, Math.min(event.clientY, dimensions.viewportHeight));
    return {
      x: Math.min(start.x, endX), y: Math.min(start.y, endY),
      width: Math.abs(start.x - endX), height: Math.abs(start.y - endY),
      ...dimensions
    };
  }

  function forgetRegion(message) {
    if (!view) return;
    stopRecording(view);
    view.region = null;
    setSelecting(view, false);
    status(message);
  }

  function hide(element) {
    if (!element?.style) return () => {};
    const style = element.style;
    const value = style.getPropertyValue('visibility');
    const priority = style.getPropertyPriority('visibility');
    style.setProperty('visibility', 'hidden', 'important');
    return () => {
      if (value) style.setProperty('visibility', value, priority);
      else style.removeProperty('visibility');
    };
  }

  function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function isCurrent(current, revision) {
    syncRoute();
    return view === current && current.revision === revision && !document.hidden;
  }

  async function requestCapture(region) {
    let timer;
    try {
      return await Promise.race([
        root.chrome.runtime.sendMessage({ type: 'GPT_EXPORTER_CAPTURE_REGION', url: route, region }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('截图超时，请重试。')), CAPTURE_TIMEOUT);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function capture(current, revision) {
    if (pending) return;
    pending = true;
    update(current);
    let restorePanel = () => {};
    let restoreOutline = () => {};
    let restoreLauncher = () => {};
    try {
      await delay(Math.max(0, lastRequest + CAPTURE_INTERVAL - Date.now()));
      if (!isCurrent(current, revision)) return;
      const region = current.region;
      const { viewportWidth, viewportHeight } = viewport();
      if (region.viewportWidth !== viewportWidth || region.viewportHeight !== viewportHeight) {
        forgetRegion('窗口大小已变化，请重新框选。');
        return;
      }
      const panel = current.panel.getBoundingClientRect();
      if (panel.right + 30 > region.x && panel.bottom + 30 > region.y &&
          panel.left - 30 < region.x + region.width && panel.top - 30 < region.y + region.height) {
        restorePanel = hide(current.panel);
      }
      restoreOutline = hide(current.outline);
      restoreLauncher = hide(current.launcher);
      // Give the compositor time to paint the viewport without the extension UI.
      await delay(90);
      if (!isCurrent(current, revision)) return;
      lastRequest = Date.now();
      const response = await requestCapture({ ...region, devicePixelRatio: root.devicePixelRatio });
      if (!isCurrent(current, revision)) return;
      if (!response?.ok) throw new Error(response?.error || '截图失败，请重试。');
      if (typeof response.dataUrl !== 'string' || !response.dataUrl.startsWith('data:image/png;base64,') ||
          !Number.isSafeInteger(response.size) || response.size <= 0) {
        throw new Error('截图数据无效，请重试。');
      }
      return response;
    } catch (error) {
      if (isCurrent(current, revision)) {
        stopRecording(current);
        const message = error?.message || '截图失败，请重试。';
        status(/选区过小|像素.*上限/.test(message) ? `${message} 请重新框选并调整区域大小。` : message);
      }
    } finally {
      restoreLauncher();
      restoreOutline();
      restorePanel();
      pending = false;
      if (view) update(view);
    }
  }

  function save(response) {
    if (frames.at(-1)?.dataUrl === response.dataUrl) return 'duplicate';
    const bytes = frames.reduce((total, frame) => total + frame.size, 0);
    if (frames.length >= MAX_FRAMES || bytes + response.size > MAX_BYTES) return 'limit';
    frames.push({
      id: `visual-capture-${root.crypto.randomUUID()}`,
      name: `可视化截图 ${frames.length + 1}.png`,
      dataUrl: response.dataUrl, mimeType: 'image/png', size: response.size
    });
    return 'saved';
  }

  function saveFrame(current, response) {
    const result = save(response);
    if (result === 'limit') {
      stopRecording(current);
      status('已达到 24 帧或 24 MiB 上限。可撤销最后一帧或清空后再试。');
    } else if (!current.recording) {
      status(result === 'saved' ? '已保存当前帧。' : '相同画面已保存。');
    } else if (frames.length === MAX_FRAMES) {
      stopRecording(current);
      status('已保存 24 帧，录制已停止。');
      return 'limit';
    }
    update(current);
    return result;
  }

  async function captureOnce(current) {
    const revision = current.revision;
    status('正在截图…');
    const response = await capture(current, revision);
    if (response && isCurrent(current, revision)) saveFrame(current, response);
  }

  async function record(current, revision, initial = false) {
    const response = await capture(current, revision);
    if (!response || !isCurrent(current, revision)) return;
    if (frames.at(-1)?.dataUrl === response.dataUrl) {
      current.candidate = null;
    } else if (initial || current.candidate === response.dataUrl) {
      if (saveFrame(current, response) === 'limit') return;
      current.candidate = null;
    } else {
      current.candidate = response.dataUrl;
    }
    current.timer = setTimeout(() => record(current, revision), CAPTURE_INTERVAL);
  }

  function onVisibility() {
    if (!document.hidden || !view) return;
    stopRecording(view);
    if (view.selecting) setSelecting(view, false);
    status('页面已切换。返回后可继续截图或重新开始录制。');
  }

  function onScroll(event) {
    const region = view?.region;
    if (!region && !view?.selecting) return;
    if (region && event.target instanceof Element && event.target !== document.documentElement) {
      const rect = event.target.getBoundingClientRect();
      if (rect.right <= region.x || rect.bottom <= region.y ||
          rect.left >= region.x + region.width || rect.top >= region.y + region.height) return;
    }
    forgetRegion('页面滚动后，请重新框选。');
  }

  function watchPage() {
    if (watching) return;
    watching = true;
    root.addEventListener('popstate', syncRoute);
    root.addEventListener('hashchange', syncRoute);
    root.navigation?.addEventListener('currententrychange', syncRoute);
    root.addEventListener('resize', () => forgetRegion('窗口大小已变化，请重新框选。'));
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    root.addEventListener('pagehide', () => {
      close();
      frames = [];
    });
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !view?.selecting) return;
      event.preventDefault();
      setSelecting(view, false);
      status('已取消框选。');
    });
  }

  function buildView(launcher) {
    const host = document.createElement('div');
    host.id = 'gpt-exporter-visual-capture';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { color-scheme: light; }
        [hidden] { display: none !important; }
        #selector { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; touch-action:none; background: rgba(0,0,0,.14); }
        #outline { position: fixed; outline: 2px solid #2a76ec; pointer-events: none; }
        #panel { position: fixed; bottom: 12px; left: 12px; width: min(370px,calc(100vw - 24px)); box-sizing: border-box;
          padding: 12px; background:#fff; color:#172033; border:1px solid #d8deea; border-radius:12px;
          box-shadow:0 4px 24px #15284633; font: 13px/1.45 system-ui,sans-serif; pointer-events: auto; }
        #panel.at-top { top:12px; bottom:auto; }
        header, footer { display:flex; align-items:center; justify-content:space-between; gap:8px; }
        p { margin:7px 0; }
        .actions { display:flex; flex-wrap:wrap; gap:6px; }
        button { border:1px solid #c1ccdf; border-radius:6px; padding:4px 8px; background:#f8faff; color:inherit; font:inherit; cursor:pointer; }
        button:hover:not(:disabled) { background:#e8f0fd; }
        button:disabled { opacity:.48; cursor:default; }
        #status { min-height:1.45em; color:#294269; }
      </style>
      <div id="selector" hidden></div>
      <div id="outline" hidden></div>
      <section id="panel" aria-label="可视化截图">
        <header><strong>可视化截图</strong><div class="actions">
          <button id="move" type="button">移至顶部</button>
          <button id="close" type="button">关闭</button>
        </div></header>
        <p>先拖选图表或演示区域，再操作源页面。录制会保存初始和稳定变化的画面。动画可手动保存。</p>
        <div class="actions">
          <button id="select" type="button">框选区域</button>
          <button id="save" type="button">保存当前帧</button>
          <button id="record" type="button">录制步骤</button>
        </div>
        <p id="status" role="status"></p>
        <footer><span id="count"></span><div class="actions">
          <button id="undo" type="button">撤销</button>
          <button id="clear" type="button">清空</button>
        </div></footer>
        <p>最多 24 帧，共 24 MiB。保持对话页打开，然后用 SELECT 导出。</p>
      </section>
    `;
    const current = { host, launcher, region: null, revision: 0, recording: false, selecting: false };
    for (const id of ['panel', 'selector', 'outline', 'status', 'count', 'select', 'save', 'record', 'undo', 'clear']) {
      current[id] = shadow.getElementById(id);
    }
    const selector = current.selector;
    selector.addEventListener('pointerdown', event => {
      if (!event.isTrusted || event.button !== 0 || current.dragStart) return;
      event.preventDefault();
      selector.setPointerCapture(event.pointerId);
      current.dragStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    });
    selector.addEventListener('pointermove', event => {
      if (current.dragStart?.pointerId === event.pointerId) showRegion(current, regionFrom(current.dragStart, event));
    });
    selector.addEventListener('pointerup', event => {
      if (!event.isTrusted || current.dragStart?.pointerId !== event.pointerId) return;
      const region = regionFrom(current.dragStart, event);
      current.dragStart = null;
      if (region.width < MIN_SIDE || region.height < MIN_SIDE) {
        showRegion(current, current.region);
        status('框选范围太小，请重新拖选。');
        return;
      }
      current.region = region;
      setSelecting(current, false);
      status('区域已选定。可操作页面，然后保存或录制。');
    });
    selector.addEventListener('lostpointercapture', event => {
      if (current.dragStart?.pointerId !== event.pointerId) return;
      current.dragStart = null;
      showRegion(current, current.region);
    });
    shadow.getElementById('close').addEventListener('click', close);
    shadow.getElementById('move').addEventListener('click', event => {
      const atTop = shadow.getElementById('panel').classList.toggle('at-top');
      event.currentTarget.textContent = atTop ? '移至底部' : '移至顶部';
    });
    current.select.addEventListener('click', () => {
      stopRecording(current);
      setSelecting(current, !current.selecting);
      status(current.selecting ? '拖动鼠标框选要保存的区域。' : '已取消框选。');
    });
    current.save.addEventListener('click', event => {
      if (event.isTrusted) void captureOnce(current);
    });
    current.record.addEventListener('click', event => {
      if (!event.isTrusted) return;
      if (current.recording) {
        stopRecording(current);
        status('已停止录制。');
      } else {
        current.recording = true;
        current.deadline = setTimeout(() => {
          stopRecording(current);
          status('已录制两分钟。可以继续录制或导出已保存的画面。');
        }, RECORDING_TIMEOUT);
        update(current);
        status('正在录制。每步停留约 2 秒，看到计数增加后再继续。');
        record(current, current.revision, true);
      }
    });
    current.undo.addEventListener('click', () => {
      current.revision++;
      frames.pop();
      status('已撤销最后一帧。');
      update(current);
    });
    current.clear.addEventListener('click', () => {
      current.revision++;
      frames = [];
      status('已清空截图。');
      update(current);
    });
    return current;
  }

  api.visualCapture = {
    start({ launcher } = {}) {
      syncRoute();
      watchPage();
      if (!view) {
        view = buildView(launcher);
        document.documentElement.appendChild(view.host);
        status('点击框选区域开始。');
        update(view);
      }
      return { ok: true };
    },
    getFrames() {
      syncRoute();
      return frames.map(({ id, name, size }) => ({ id, name, size }));
    },
    getFrame(assetId, url) {
      syncRoute();
      if (url !== route) return undefined;
      const frame = frames.find(frame => frame.id === assetId);
      if (!frame) return undefined;
      const { dataUrl, mimeType, size, name } = frame;
      return { dataUrl, mimeType, size, name };
    }
  };
})(globalThis);
