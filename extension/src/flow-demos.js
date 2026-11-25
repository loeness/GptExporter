(function attachGptExporterFlowDemos(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const WIDTH = 760;
  const HEIGHT = 330;
  const MAX_ROUNDS = 10;
  const MAX_VERTICES = 12;
  const MAX_EDGES = 24;
  const MAX_CAPACITY = 999;
  const FORWARD = '→';
  const BACKWARD = '←';

  function parsePath(tex) {
    const path = tex.replace(/\\overset\s*\{\s*\\text\s*\{\s*backward\s*\}\s*\}\s*\{\s*\\(?:longrightarrow|rightarrow|to)\s*\}/g, BACKWARD)
      .replace(/\\(?:longrightarrow|rightarrow|to)(?![a-zA-Z])/g, FORWARD)
      .replace(/\s+/g, '');
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,2}(?:[→←][a-zA-Z][a-zA-Z0-9]{0,2})+$/.test(path)) return null;
    const parts = path.split(/([→←])/);
    const vertices = parts.filter((_, index) => index % 2 === 0);
    if (vertices.length > MAX_VERTICES || new Set(vertices).size !== vertices.length) return null;
    return vertices.slice(1).map((to, index) => ({
      from: vertices[index], to, backward: parts[index * 2 + 1] === BACKWARD
    }));
  }

  function parseBottleneck(tex, round) {
    const formula = tex.replace(/\s+|\\(?:left|right)(?![a-zA-Z])/g, '');
    const match = /^b_(?:\{(\d+)\}|(\d+))=\\min[({]([\d,-]+)[)}]=(\d{1,3})$/.exec(formula);
    if (!match || Number(match[1] || match[2]) !== round) return null;
    const residuals = match[3].split(',').map((item) => {
      if (!/^\d{1,3}(?:-\d{1,3})?$/.test(item)) return NaN;
      const [capacity, flow = 0] = item.split('-').map(Number);
      return capacity - flow;
    });
    const amount = Number(match[4]);
    return amount > 0 && Math.min(...residuals) === amount ? { residuals, amount } : null;
  }

  function standaloneTex(element) {
    const math = element.firstElementChild;
    if (!element.matches('p') || element.childElementCount !== 1 ||
        !math.matches('[data-ge-tex][data-ge-display="true"]') ||
        Array.from(element.childNodes).some((node) => node !== math && node.textContent.trim())) return '';
    const tex = math.getAttribute('data-ge-tex') || '';
    return tex.length <= 400 ? tex : '';
  }

  function matchControls(elements) {
    const text = elements.map((element) => element.textContent).join(' ')
      .replace(/[：:]/g, ':').replace(/\s+/g, '');
    return /^当前总流量(?::)?[#0]?\/(\d{1,4})增广进度:(?:[#0])?\/(\d{1,2})轮增加流量撤销流量\[上一轮\]\[重置\]\[下一轮\]$/.exec(text);
  }

  function inferNetwork(rounds, vertexCount, edgeCount, expectedTotal) {
    const firstPath = rounds[0].path;
    const source = firstPath[0].from;
    const sink = firstPath.at(-1).to;
    const edgesByKey = new Map();
    const vertices = new Set([source, sink]);
    const snapshots = [{ total: 0, flow: new Map(), changes: new Map() }];
    let total = 0;
    for (const { path, residuals, amount } of rounds) {
      if (path[0].from !== source || path.at(-1).to !== sink || path.length !== residuals.length) return null;
      const changes = new Map();
      for (const [index, { from, to, backward }] of path.entries()) {
        const start = backward ? to : from;
        const end = backward ? from : to;
        if (end === source || start === sink) return null;
        const key = start + '>' + end;
        const residual = residuals[index];
        let edge = edgesByKey.get(key);
        if (!edge) {
          if (backward || residual > MAX_CAPACITY || edgesByKey.size === MAX_EDGES) return null;
          edge = { key, from: start, to: end, capacity: residual, flow: 0 };
          edgesByKey.set(key, edge);
          vertices.add(start);
          vertices.add(end);
        }
        if (residual !== (backward ? edge.flow : edge.capacity - edge.flow)) return null;
        edge.flow += backward ? -amount : amount;
        changes.set(key, backward ? -1 : 1);
      }
      total += amount;
      snapshots.push({ total, flow: new Map(Array.from(edgesByKey, ([key, edge]) => [key, edge.flow])), changes });
    }
    if (vertices.size !== vertexCount || edgesByKey.size !== edgeCount || total !== expectedTotal) return null;

    const edges = Array.from(edgesByKey.values());
    const reachable = new Set([source]);
    for (const from of reachable) {
      for (const edge of edges) {
        if (edge.from === from && edge.flow < edge.capacity) reachable.add(edge.to);
        if (edge.to === from && edge.flow > 0) reachable.add(edge.from);
      }
    }
    if (reachable.has(sink)) return null;
    return { vertices, edges, source, sink, snapshots };
  }

  function matchDemo(body) {
    const blocks = Array.from(body.children);
    const initial = blocks.findIndex((element) => element.matches('h2') && /^1[.、]\s*初始网络$/.test(element.textContent.trim()));
    const widget = blocks.findIndex((element, index) => index > initial &&
      element.matches('h2') && /^2[.、]\s*逐轮执行 Ford[–—-]Fulkerson$/.test(element.textContent.trim()));
    if (initial < 0 || widget < 0) return null;

    const declared = blocks.slice(0, initial + 1).map((element) => element.textContent).join(' ')
      .match(/\b(\d{1,2})\s*个顶点\s*[、，,]\s*(\d{1,2})\s*条边/);
    if (!declared) return null;
    const [, vertexCount, edgeCount] = declared.map(Number);
    if (vertexCount < 2 || vertexCount > MAX_VERTICES || edgeCount < 1 || edgeCount > MAX_EDGES) return null;

    const stepStart = blocks.findIndex((element, index) => index > widget && element.matches('h2, h3'));
    if (stepStart < 0) return null;
    const controls = blocks.slice(widget + 1, stepStart);
    if (controls.filter((element) => element.matches('hr')).length !== 1) return null;
    if (!controls.every((element) => element.matches('p, hr, h1') && !element.querySelector('a, img, [data-ge-tex]'))) return null;
    const controlValues = matchControls(controls);
    if (!controlValues) return null;
    const [, total, count] = controlValues.map(Number);
    if (count < 1 || count > MAX_ROUNDS || total < 1) return null;

    const rounds = [];
    for (let start = stepStart; start < blocks.length;) {
      const heading = blocks[start];
      if (!heading.matches('h3') || !/^Round\s+\d+\b/i.test(heading.textContent.trim())) break;
      const round = rounds.length + 1;
      if (round > count || Number(/^Round\s+(\d+)/i.exec(heading.textContent.trim())[1]) !== round) return null;
      let end = start + 1;
      while (end < blocks.length && !blocks[end].matches('h2, h3')) end++;
      let path;
      let bottleneck;
      for (const element of blocks.slice(start + 1, end)) {
        const tex = standaloneTex(element);
        const steps = parsePath(tex);
        if (steps) {
          if (path) return null;
          path = steps;
        }
        const parsed = parseBottleneck(tex, round);
        if (parsed) {
          if (bottleneck) return null;
          bottleneck = parsed;
        }
      }
      if (!path || !bottleneck) return null;
      rounds.push({ heading, path, ...bottleneck });
      start = end;
    }
    if (rounds.length !== count) return null;

    const network = inferNetwork(rounds, vertexCount, edgeCount, total);
    if (!network) return null;
    const fallback = blocks.slice(initial + 1, widget).find((element) =>
      element.matches('p, blockquote') && /^(?:Graph|\[Graph\])(?:[:：]?\s*图表数据不可用[。.]?)?$/i.test(element.textContent.trim()));
    return { ...network, initial: blocks[initial], controls, fallback, rounds };
  }

  function layoutNetwork({ vertices, edges, source, sink }) {
    // Topological depth preserves the direction of the original network.
    const layerByVertex = new Map([[source, 0]]);
    const incoming = new Map(Array.from(vertices, (vertex) => [vertex, 0]));
    for (const edge of edges) incoming.set(edge.to, incoming.get(edge.to) + 1);
    const queue = [source];
    for (const vertex of queue) {
      for (const edge of edges) {
        if (edge.from !== vertex) continue;
        layerByVertex.set(edge.to, Math.max(layerByVertex.get(edge.to) || 0, layerByVertex.get(vertex) + 1));
        const remaining = incoming.get(edge.to) - 1;
        incoming.set(edge.to, remaining);
        if (remaining === 0) queue.push(edge.to);
      }
    }
    // Every reconstructed edge lies on an augmentation. Use source distance if there are cycles.
    if (queue.length !== vertices.size) {
      layerByVertex.clear();
      layerByVertex.set(source, 0);
      for (const [vertex, layer] of layerByVertex) {
        for (const edge of edges) {
          if (edge.from === vertex && !layerByVertex.has(edge.to)) layerByVertex.set(edge.to, layer + 1);
        }
      }
      if (layerByVertex.size !== vertices.size) return null;
      layerByVertex.set(sink, Math.max(...layerByVertex.values()) + 1);
    }
    const layers = new Map();
    for (const vertex of vertices) {
      const layer = layerByVertex.get(vertex);
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer).push(vertex);
    }
    const finalLayer = layerByVertex.get(sink);
    const nodes = new Map();
    const lanes = new Map();
    // Prefer lanes near the successor nodes so adjacent columns cross less often.
    for (const [layer, members] of [...layers].sort(([left], [right]) => right - left)) {
      const scores = new Map(members.map(vertex => {
        const next = edges.filter(edge => edge.from === vertex && lanes.has(edge.to));
        const score = next.length ? next.reduce((sum, edge) => sum + lanes.get(edge.to), 0) / next.length : 0.5;
        return [vertex, score];
      }));
      members.sort((a, b) => scores.get(a) - scores.get(b) || a.localeCompare(b));
      for (const [index, vertex] of members.entries()) {
        const x = 45 + layer * (WIDTH - 90) / finalLayer;
        const lane = members.length === 1 ? 0.5 : index / (members.length - 1);
        const y = 42 + lane * (HEIGHT - 84);
        lanes.set(vertex, lane);
        nodes.set(vertex, { x, y });
      }
    }
    return nodes;
  }

  function edgeGeometries(edges, nodes) {
    const rectangles = Array.from(nodes.values(), ({ x, y }) => ({ x, y, rx: 38, ry: 34 }));
    const geometries = edges.map((edge) => {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const dx = (to.x - from.x) / length;
      const dy = (to.y - from.y) / length;
      const shift = edges.some((other) => other.from === edge.to && other.to === edge.from) ? 10 : 0;
      const x = from.x + dx * 23 - dy * shift;
      const y = from.y + dy * 23 + dx * shift;
      const tipX = to.x - dx * 23 - dy * shift;
      const tipY = to.y - dy * 23 + dx * shift;
      return { edge, x, y, tipX, tipY, dx, dy };
    });
    for (const geometry of geometries) {
      const { x, y, tipX, tipY, dx, dy } = geometry;
      const rx = 13 + String(geometry.edge.capacity).length * 9;
      let label;
      let best = Infinity;
      for (const fraction of [0.48, 0.35, 0.62, 0.25, 0.75, 0.15, 0.85]) {
        const clearance = Math.ceil(13 * Math.abs(dx) + rx * Math.abs(dy)) + 2;
        for (const offset of [-clearance, clearance, -clearance - 10, clearance + 10]) {
          const lx = x + (tipX - x) * fraction - dy * offset;
          const ly = y + (tipY - y) * fraction + dx * offset;
          if (lx < rx || lx > WIDTH - rx || ly < 15 || ly > HEIGHT - 15) continue;
          let score = Math.abs(fraction - 0.48) * 20 + Math.abs(offset) / 10;
          for (const rect of rectangles) {
            if (Math.abs(lx - rect.x) < rx + rect.rx && Math.abs(ly - rect.y) < 13 + rect.ry) score += 100;
          }
          for (const other of geometries) {
            if (other === geometry) continue;
            const projected = (lx - other.x) * other.dx + (ly - other.y) * other.dy;
            const distance = Math.abs((lx - other.x) * other.dy - (ly - other.y) * other.dx);
            if (projected > 0 && projected < Math.hypot(other.tipX - other.x, other.tipY - other.y) &&
                distance < 12 * Math.abs(other.dx) + rx * Math.abs(other.dy)) score += 12;
          }
          if (score < best) {
            best = score;
            label = { x: lx, y: ly, rx, ry: 13 };
          }
        }
      }
      geometry.label = label || { x: (x + tipX) / 2, y: (y + tipY) / 2, rx, ry: 13 };
      rectangles.push(geometry.label);
    }
    return geometries;
  }

  function drawFigure(document, snapshot, nodes, geometry, round) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH * 2;
      canvas.height = HEIGHT * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.scale(2, 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      const edgeColor = (edge) => {
        const change = snapshot.changes.get(edge.key);
        if (change === -1) return '#a34021';
        return change === 1 ? '#165e92' : '#46566a';
      };
      for (const { edge, x, y, tipX, tipY, dx, dy } of geometry) {
        const changed = snapshot.changes.get(edge.key);
        const spurX = tipX - dx * 13;
        const spurY = tipY - dy * 13;
        const color = edgeColor(edge);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = changed ? 3.2 : 1.7;
        ctx.setLineDash(changed === -1 ? [8, 5] : []);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(spurX, spurY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(spurX - dy * 5, spurY + dx * 5);
        ctx.lineTo(spurX + dy * 5, spurY - dx * 5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.setLineDash([]);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 19px system-ui, sans-serif';
      for (const [vertex, { x, y }] of nodes) {
        ctx.beginPath();
        ctx.arc(x, y, 21, 0, 2 * Math.PI);
        ctx.fillStyle = '#eef4f8';
        ctx.fill();
        ctx.strokeStyle = '#2c4159';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#203048';
        ctx.fillText(vertex, x, y);
      }
      ctx.font = '600 16px system-ui, sans-serif';
      const descriptions = [];
      for (const { edge, label } of geometry) {
        const flow = snapshot.flow.get(edge.key) || 0;
        const change = snapshot.changes.get(edge.key);
        const value = flow + '/' + edge.capacity;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(label.x - label.rx, label.y - label.ry, label.rx * 2, label.ry * 2);
        ctx.fillStyle = edgeColor(edge);
        ctx.fillText((change === -1 ? '− ' : change === 1 ? '+ ' : '') + value, label.x, label.y);
        descriptions.push(edge.from + ' → ' + edge.to + ' ' + value);
      }

      const dataUrl = canvas.toDataURL('image/png');
      if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) return null;
      const figure = document.createElement('figure');
      figure.className = 'ge-static-demo';
      figure.setAttribute('data-ge-static-demo', 'flow-network');
      figure.setAttribute('data-ge-flow-round', String(round));
      const detail = round === 0 ? '初始网络' : '第 ' + round + ' 轮增广后';
      const heading = detail + ' · 当前总流量 ' + snapshot.total;
      const image = document.createElement('img');
      image.className = 'ge-static-demo-image';
      image.src = dataUrl;
      image.width = WIDTH;
      image.height = HEIGHT;
      image.alt = heading + '。各边流量 / 容量：' + descriptions.join('、');
      const caption = document.createElement('figcaption');
      caption.className = 'ge-static-demo-caption';
      caption.textContent = heading + '。边标签为流量 / 容量。' + (round ? ' + 表示增加，− 表示撤销。' : '');
      figure.append(image, caption);
      return figure;
    } catch (_) {
      return null;
    }
  }

  function restoreFlowDemos(container) {
    if (!container?.ownerDocument) return;
    for (const body of container.querySelectorAll('article[data-role="assistant"] > .message-body')) {
      if (body.querySelector('[data-ge-static-demo="flow-network"]')) continue;
      const demo = matchDemo(body);
      if (!demo) continue;
      const nodes = layoutNetwork(demo);
      if (!nodes) continue;
      const geometry = edgeGeometries(demo.edges, nodes);
      const figures = demo.snapshots.map((snapshot, round) => drawFigure(container.ownerDocument, snapshot, nodes, geometry, round));
      if (figures.some((figure) => !figure)) continue;
      if (demo.fallback) demo.fallback.replaceWith(figures[0]);
      else demo.initial.after(figures[0]);
      for (const [index, { heading }] of demo.rounds.entries()) heading.after(figures[index + 1]);
      for (const control of demo.controls) control.remove();
    }
  }

  api.restoreFlowDemos = restoreFlowDemos;
})(globalThis);
