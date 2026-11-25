(function attachGptExporterDataCharts(root) {
  'use strict';

  const api = root.GptExporter || (root.GptExporter = {});
  const ATTRIBUTE = 'data-ge-data-chart';
  const UNAVAILABLE = '图表不可用。';
  const MAX_PAYLOAD = 65536;
  const MAX_POINTS = 60;
  const MAX_SERIES = 4;
  const WIDTH = 760;
  const HEIGHT = 390;
  const COLORS = ['#135da3', '#176c48', '#793b97', '#a54719'];
  const DASHES = [[], [10, 5], [3, 4], [12, 4, 3, 4]];

  function parseJson(value) {
    if (typeof value !== 'string' || value.length > MAX_PAYLOAD) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function validLabel(value) {
    return typeof value === 'string' && value.length <= 80 && value.trim().length > 0 &&
      !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value);
  }

  function validNumber(value) {
    return Number.isFinite(value) && Math.abs(value) <= 1e15;
  }

  function validList(value, limit) {
    return Array.isArray(value) && value.length > 0 && value.length <= limit;
  }

  function validateSpec(spec) {
    if (!validLabel(spec?.xLabel) || !validList(spec.labels, MAX_SERIES) || !spec.labels.every(validLabel) ||
        !validList(spec.points, MAX_POINTS) || !spec.points.every((row) => Array.isArray(row) &&
          row.length === spec.labels.length + 1 && validLabel(row[0]) && row.slice(1).every(validNumber)) ||
        (spec.min !== undefined && !validNumber(spec.min)) ||
        (spec.max !== undefined && !validNumber(spec.max)) ||
        (spec.min !== undefined && spec.max !== undefined && spec.min >= spec.max)) return null;
    return spec;
  }

  function normalizePayload(payload) {
    const chart = parseJson(payload)?.charts_widget_v2?.content;
    if (chart?.chartType !== 'line' || !validLabel(chart.xKey) || !validList(chart.series, MAX_SERIES) ||
        !chart.series.every((item) => validLabel(item?.dataKey) && validLabel(item.label)) ||
        new Set(chart.series.map((item) => item.dataKey)).size !== chart.series.length ||
        !validList(chart.data, MAX_POINTS)) return null;

    const keys = chart.series.map((item) => item.dataKey);
    return validateSpec({
      xLabel: chart.xKey,
      labels: chart.series.map((item) => item.label),
      points: chart.data.map((row) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
        const category = Object.hasOwn(row, chart.xKey) ? row[chart.xKey] : undefined;
        return [validNumber(category) ? String(category) : category,
          ...keys.map((key) => Object.hasOwn(row, key) ? row[key] : undefined)];
      }),
      min: chart.yAxisMin,
      max: chart.yAxisMax
    });
  }

  function escapeAttribute(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function dataChartPlaceholder(payload) {
    const spec = normalizePayload(payload);
    return spec
      ? '<span class="ge-data-chart-source" ' + ATTRIBUTE + '="' + escapeAttribute(JSON.stringify(spec)) + '">' + UNAVAILABLE + '</span>'
      : '<span class="ge-data-chart-unavailable">' + UNAVAILABLE + '</span>';
  }

  function domain(spec) {
    const values = spec.points.flatMap((row) => row.slice(1));
    let min = spec.min ?? Math.min(...values);
    let max = spec.max ?? Math.max(...values);
    if (min >= max) {
      const padding = Math.max(Math.abs(min), Math.abs(max), 1) / 10;
      if (spec.min === undefined) min = max - padding;
      if (spec.max === undefined) max = min + padding;
    }
    return [min, max];
  }

  function drawChart(document, spec) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = WIDTH * 2;
      canvas.height = HEIGHT * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const left = 110;
      const right = WIDTH - 20;
      const top = 78;
      const bottom = HEIGHT - 63;
      const [min, max] = domain(spec);
      const x = (index) => spec.points.length === 1 ? (left + right) / 2 :
        left + 12 + (right - left - 24) * index / (spec.points.length - 1);
      const y = (value) => bottom - (bottom - top) * (value - min) / (max - min);
      const numberText = (value) => String(Number(value.toPrecision(12)));
      const line = (x1, y1, x2, y2) => {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      };

      ctx.scale(2, 2);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.font = '15px sans-serif';
      ctx.textBaseline = 'middle';
      spec.labels.forEach((label, series) => {
        const start = 28 + 360 * (series % 2);
        const center = 22 + 27 * Math.floor(series / 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = COLORS[series];
        ctx.setLineDash(DASHES[series]);
        line(start, center, start + 32, center);
        ctx.textAlign = 'left';
        ctx.fillStyle = '#172333';
        ctx.fillText(label, start + 42, center, 298);
      });
      ctx.setLineDash([]);

      ctx.lineWidth = 1;
      ctx.strokeStyle = '#cbd5e1';
      ctx.textAlign = 'right';
      for (let tick = 0; tick <= 4; tick += 1) {
        const tickY = bottom - (bottom - top) * tick / 4;
        const value = tick === 4 ? max : min + (max - min) * tick / 4;
        line(left, tickY, right, tickY);
        ctx.fillText(numberText(value), left - 10, tickY, left - 20);
      }
      ctx.strokeStyle = '#64748b';
      line(left, top, left, bottom);
      line(left, bottom, right, bottom);

      const assignedSlots = Math.min(8, spec.points.length);
      const slotWidth = (right - left - 24) / Math.max(1, assignedSlots - 1);
      ctx.textAlign = 'center';
      for (let slot = 0; slot < assignedSlots; slot += 1) {
        const index = Math.round(slot * (spec.points.length - 1) / Math.max(1, assignedSlots - 1));
        const labelX = x(index);
        const labelWidth = Math.min(slotWidth * 0.75, 2 * (labelX - 8), 2 * (WIDTH - labelX - 8));
        ctx.fillText(spec.points[index][0], labelX, bottom + 17, labelWidth);
      }
      ctx.fillText(spec.xLabel, (left + right) / 2, HEIGHT - 16, right - left);

      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top - 4, right - left, bottom - top + 8);
      ctx.clip();
      spec.labels.forEach((_, series) => {
        const values = spec.points.map((row) => row[series + 1]);
        ctx.strokeStyle = COLORS[series];
        ctx.fillStyle = COLORS[series];
        ctx.lineWidth = 3;
        ctx.setLineDash(DASHES[series]);
        ctx.beginPath();
        if (values[0] >= min && values[0] <= max) ctx.moveTo(x(0), y(values[0]));
        for (let index = 1; index < values.length; index += 1) {
          const start = values[index - 1];
          const end = values[index];
          if (Math.max(start, end) < min || Math.min(start, end) > max) continue;
          const clipStart = Math.max(min, Math.min(max, start));
          const clipEnd = Math.max(min, Math.min(max, end));
          const startX = x(index - 1);
          const endX = x(index);
          const atBound = (value) => startX + (endX - startX) * (value - start) / (end - start);
          if (clipStart !== start) ctx.moveTo(atBound(clipStart), y(clipStart));
          ctx.lineTo(clipEnd === end ? endX : atBound(clipEnd), y(clipEnd));
        }
        ctx.stroke();
        if (values.length <= 20) values.forEach((value, index) => {
          if (value < min || value > max) return;
          ctx.beginPath();
          ctx.arc(x(index), y(value), 3.5, 0, 2 * Math.PI);
          ctx.fill();
        });
      });
      ctx.restore();
      if (spec.points.length <= 8 && spec.labels.length <= 2) {
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        spec.labels.forEach((_, series) => {
          const offset = series === 0 ? -13 : 13;
          ctx.fillStyle = COLORS[series];
          spec.points.forEach((row, index) => {
            const value = row[series + 1];
            if (value < min || value > max) return;
            let labelY = y(value) + offset;
            if (labelY > bottom - 2) labelY = bottom - 10 - series * 14;
            ctx.fillText(numberText(value), x(index), labelY, 52);
          });
        });
      }
      const png = canvas.toDataURL('image/png');
      return png.startsWith('data:image/png;base64,') ? png : null;
    } catch {
      return null;
    }
  }

  function restoreDataCharts(container) {
    const lastFigure = new Map();
    for (const placeholder of Array.from(container.querySelectorAll('span[' + ATTRIBUTE + ']'))) {
      const document = placeholder.ownerDocument;
      const spec = validateSpec(parseJson(placeholder.getAttribute(ATTRIBUTE)));
      const png = spec && drawChart(document, spec);
      if (!png) {
        placeholder.replaceWith(document.createTextNode(UNAVAILABLE));
        continue;
      }
      const figure = document.createElement('figure');
      figure.className = 'ge-data-chart';
      const image = document.createElement('img');
      image.width = WIDTH;
      image.height = HEIGHT;
      image.src = png;
      const caption = document.createElement('figcaption');
      caption.textContent = '折线图（' + spec.xLabel + '） · ' + spec.labels.join('、');
      image.alt = caption.textContent;
      if (spec.points.length * spec.labels.length <= 24) {
        image.alt += '。' + spec.points.map(([label, ...values]) => label + '：' + values.join('、')).join('；');
      }
      figure.append(image, caption);
      const paragraph = placeholder.closest('p');
      if (paragraph && !lastFigure.has(paragraph) && paragraph.children.length === 1 &&
          paragraph.textContent.trim() === placeholder.textContent.trim()) {
        paragraph.replaceWith(figure);
      } else if (paragraph) {
        (lastFigure.get(paragraph) || paragraph).after(figure);
        lastFigure.set(paragraph, figure);
        placeholder.remove();
        if (!paragraph.childElementCount && !paragraph.textContent.trim()) paragraph.remove();
      } else {
        placeholder.replaceWith(figure);
      }
    }
  }

  api.dataChartPlaceholder = dataChartPlaceholder;
  api.restoreDataCharts = restoreDataCharts;
})(typeof globalThis === 'object' ? globalThis : this);
