(function attachGptExporterStaticDemos(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const WIDTH = 720;
  const HEIGHT = 400;
  const SERIES_COLORS = ['#1565a8', '#733f99', '#b24d15'];
  const SERIES_DASHES = [[], [10, 5], [3, 5]];
  const EXAMPLE_RATES = [0.1, 0.4, 1];

  function compactTex(tex) {
    return tex.replace(/\\lambda(?![a-zA-Z])/g, 'λ')
      .replace(/\\geq?(?![a-zA-Z])/g, '≥')
      .replace(/\\(?:qquad|quad)(?![a-zA-Z])|\\[,;:! ]|\s+/g, '');
  }

  function parseSlider(block) {
    // Match the structure of the exported control, including all three labels.
    // Extra prose or a different range belongs to the original message.
    if (!block.matches('blockquote') ||
        !Array.from(block.querySelectorAll('*')).every((element) => element.matches('p, strong, br'))) return null;
    const labels = Array.from(block.querySelectorAll('strong'), (element) => element.textContent.trim());
    if (labels.length !== 3 || !/^滑块[:：]?$/.test(labels[0]) ||
        !/^范围[:：]$/.test(labels[1]) || !/^步长[:：]$/.test(labels[2])) return null;
    const text = block.textContent.replace(/\s+/g, '').replace(/：/g, ':');
    const match = /^滑块:?(?:当前值不可用[。.]?|当前值:(0(?:\.\d{1,2})?|1(?:\.0{1,2})?)[。.]?)范围:0\.01至1(?:\.0{1,2})?步长:0\.01[。.]?$/.exec(text);
    if (!match) return null;
    const currentRate = match[1] === undefined ? null : Number(match[1]);
    if (currentRate !== null && (currentRate < 0.01 || currentRate > 1)) return null;
    return { currentRate };
  }

  function matchExponentialDemo(block) {
    const label = block.previousElementSibling;
    const formula = label?.previousElementSibling;
    if (!label?.matches('p') || !formula?.matches('p') || !block.nextElementSibling?.matches('hr')) return null;

    const inlineMath = label.firstElementChild;
    if (label.childElementCount !== 1 || !inlineMath.matches('[data-ge-tex][data-ge-display="false"]') ||
        compactTex(inlineMath.getAttribute('data-ge-tex')) !== 'λ' ||
        Array.from(label.childNodes).filter((node) => node !== inlineMath).map((node) => node.textContent).join('').trim() !== 'Rate' ||
        !inlineMath.previousSibling?.textContent.trim()) return null;

    const displayMath = formula.firstElementChild;
    if (formula.childElementCount !== 1 || !displayMath.matches('[data-ge-tex][data-ge-display="true"]') ||
        Array.from(formula.childNodes).some((node) => node !== displayMath && node.textContent.trim())) return null;
    const equation = compactTex(displayMath.getAttribute('data-ge-tex'));
    if (equation !== 'f(x)=λe^{-λx},x≥0') return null;

    const slider = parseSlider(block);
    return slider && { label, ...slider };
  }

  function drawChart(document, rates) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH * 2;
      canvas.height = HEIGHT * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const left = 76;
      const right = 680;
      const top = 82;
      const bottom = 335;
      const maxX = 20;
      const maxY = rates.length === 1 ? rates[0] : 1;
      const plotX = (x) => left + (x / maxX) * (right - left);
      const plotY = (y) => bottom - (y / maxY) * (bottom - top);

      ctx.scale(2, 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.font = '17px system-ui, sans-serif';
      ctx.fillStyle = '#23313e';
      ctx.fillText('f(x)', left, 53);

      function line(x1, y1, x2, y2) {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      ctx.strokeStyle = '#d8e1e8';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      for (let tick = 0; tick <= 4; tick++) {
        const value = maxY * tick / 4;
        const y = plotY(value);
        line(left, y, right, y);
        ctx.fillText(String(Number(value.toFixed(4))), left - 13, y);
      }
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      for (let tick = 0; tick <= maxX; tick += 5) {
        const x = plotX(tick);
        line(x, top, x, bottom);
        ctx.fillText(String(tick), x, bottom + 10);
      }
      ctx.fillText('x', (left + right) / 2, bottom + 37);
      ctx.strokeStyle = '#526273';
      line(left, top, left, bottom);
      line(left, bottom, right, bottom);

      ctx.lineWidth = 3.5;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (const [index, rate] of rates.entries()) {
        ctx.strokeStyle = SERIES_COLORS[index];
        ctx.setLineDash(SERIES_DASHES[index]);
        ctx.beginPath();
        ctx.moveTo(left, plotY(rate));
        for (let sample = 1; sample <= 400; sample++) {
          const x = sample * maxX / 400;
          ctx.lineTo(plotX(x), plotY(rate * Math.exp(-rate * x)));
        }
        ctx.stroke();
        const legendX = right - rates.length * 116 + index * 116;
        line(legendX, 45, legendX + 24, 45);
        ctx.fillText('λ = ' + rate.toFixed(2), legendX + 31, 45);
      }

      const dataUrl = canvas.toDataURL('image/png');
      return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl) ? dataUrl : null;
    } catch (_) {
      return null;
    }
  }

  function restoreStaticDemos(container) {
    if (!container?.ownerDocument) return;
    const document = container.ownerDocument;
    const charts = new Map();
    for (const block of container.querySelectorAll('article[data-role="assistant"] > .message-body > blockquote')) {
      const demo = matchExponentialDemo(block);
      if (!demo) continue;
      const { label, currentRate } = demo;
      const rates = currentRate === null ? EXAMPLE_RATES : [currentRate];
      if (!charts.has(currentRate)) charts.set(currentRate, drawChart(document, rates));
      const dataUrl = charts.get(currentRate);
      if (!dataUrl) continue;

      const rateList = rates.map((rate) => rate.toFixed(2)).join('、');
      const meanList = rates.map((rate) => Number((1 / rate).toFixed(2))).join('、');
      const description = currentRate === null ? '示例速率 λ = ' + rateList : '原始速率 λ = ' + rateList;
      const figure = document.createElement('figure');
      figure.className = 'ge-static-demo';
      figure.setAttribute('data-ge-static-demo', 'exponential-pdf');
      const image = document.createElement('img');
      image.className = 'ge-static-demo-image';
      image.src = dataUrl;
      image.width = WIDTH;
      image.height = HEIGHT;
      image.alt = '指数分布概率密度曲线。' + description + '。';
      const caption = document.createElement('figcaption');
      caption.className = 'ge-static-demo-caption';
      caption.textContent = '指数分布概率密度（静态图）。' + description +
        '，对应平均等待时间约为 ' + meanList + '。';
      figure.append(image, caption);
      label.replaceWith(figure);
      block.remove();
    }
  }

  api.restoreStaticDemos = restoreStaticDemos;
})(globalThis);
