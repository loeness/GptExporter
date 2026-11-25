const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

require('../extension/src/data-charts.js');
const { dataChartPlaceholder, restoreDataCharts } = global.GptExporter;
const png = 'data:image/png;base64,iVBORw==';

function chart(overrides = {}) {
  return JSON.stringify({ charts_widget_v2: { content: {
    chartType: 'line',
    xKey: 'round',
    series: [{ dataKey: 'flow', label: '总流量' }, { dataKey: 'limit', label: '容量上界' }],
    yAxisMin: 0,
    yAxisMax: 12,
    data: [0, 4, 6, 8, 10, 12].map((flow, index) => ({ round: index ? 'R' + index : '初始', flow, limit: 12 })),
    ...overrides
  } } });
}

function fixture(markup) {
  const { window } = new JSDOM('<main>' + markup + '</main>');
  const canvas = window.HTMLCanvasElement.prototype;
  const labels = [];
  const markers = [];
  const dashes = [];
  const segments = [];
  canvas.getContext = () => ({
    scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, stroke() {},
    lineTo(x, y) { segments.push([x, y]); },
    save() {}, rect() {}, clip() {}, restore() {}, fill() {},
    setLineDash(dash) { dashes.push(dash); },
    fillText(label) { labels.push(label); },
    arc(x, y) { markers.push([x, y]); }
  });
  canvas.toDataURL = function (format) {
    assert.equal(format, 'image/png');
    assert.deepEqual([this.width, this.height], [1520, 780]);
    return png;
  };
  return { container: window.document.querySelector('main'), canvas, labels, markers, dashes, segments };
}

test('renders flow labels, values and explicit domain to a local high DPI PNG', () => {
  const escapedPayload = chart().replace('初始', '\\u521d\\u59cb');
  const { container, labels, markers, dashes } = fixture('<p>' + dataChartPlaceholder(escapedPayload) + '</p><p>后续正文</p>');
  restoreDataCharts(container);
  restoreDataCharts(container);
  const figure = container.querySelector('figure.ge-data-chart');
  assert.ok(figure);
  assert.equal(figure.querySelector('img').src, png);
  assert.match(figure.querySelector('img').alt, /初始：0、12.*R5：12、12/);
  assert.equal(figure.querySelector('figcaption').textContent, '折线图（round） · 总流量、容量上界');
  assert.equal(figure.nextElementSibling.textContent, '后续正文');
  assert.equal(container.querySelectorAll('figure, p').length, 2);
  assert.deepEqual(labels.slice(0, 7), ['总流量', '容量上界', '0', '3', '6', '9', '12']);
  assert.equal(markers[0][1], 327);
  assert.equal(markers[5][1], 78);
  assert.ok(dashes.some((dash) => dash.length === 2));
  assert.ok(labels.slice(7).includes('4'));
});

test('clips the line at the interpolated intersection of an explicit bound', () => {
  const { container, segments, markers } = fixture(dataChartPlaceholder(chart({
    yAxisMax: 1,
    series: [{ dataKey: 'flow', label: '总流量' }],
    data: [{ round: 'R1', flow: 0.5 }, { round: 'R2', flow: 2.5 }]
  })));
  restoreDataCharts(container);
  assert.deepEqual(segments.at(-1), [273.5, 78]);
  assert.equal(markers.length, 1);
});

test('keeps labels as text, strips unused payload fields and rejects forged attributes', () => {
  const label = '"><img src=https://evil.test/x onerror="alert(1)"> &';
  const markup = dataChartPlaceholder(chart({
    ignored: 'do not serialize',
    series: [{ dataKey: 'flow', label }]
  }));
  const { container, labels } = fixture(markup + '<span data-ge-data-chart="{&quot;xLabel&quot;:42}">forged</span>');
  assert.equal(container.querySelector('img'), null);
  assert.doesNotMatch(markup, /do not serialize|<img/);
  restoreDataCharts(container);
  assert.equal(container.querySelectorAll('img').length, 1);
  assert.equal(container.querySelector('img').src, png);
  assert.ok(labels.includes(label));
  assert.ok(container.querySelector('figcaption').textContent.includes(label));
  assert.match(container.textContent, /图表不可用/);
  assert.equal(container.querySelector('[data-ge-data-chart]'), null);
});

test('omits unsupported or invalid specifications and handles a constant numeric series', () => {
  const invalid = [
    '{"charts_widget_v2":',
    chart({ chartType: 'bar' }),
    chart({ yAxisMin: 12 }),
    chart({ data: [{ round: '1', flow: '4', limit: 12 }] }),
    chart({ data: Array.from({ length: 61 }, () => ({ round: '1', flow: 1, limit: 12 })) })
  ];
  for (const payload of invalid) {
    assert.equal(dataChartPlaceholder(payload), '<span class="ge-data-chart-unavailable">图表不可用。</span>');
  }
  const markup = dataChartPlaceholder(chart({
    yAxisMin: undefined, yAxisMax: undefined,
    data: [{ round: 1, flow: 0.25, limit: 0.25 }]
  }));
  const { container, markers, labels } = fixture(markup);
  restoreDataCharts(container);
  assert.ok(container.querySelector('figure'));
  assert.ok(labels.includes('0.25'));
  assert.equal(markers.length, 2);
  assert.ok(markers.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
});

test('keeps surrounding prose and removes the payload when Canvas is unavailable', () => {
  const { container, canvas } = fixture('<p>Before ' + dataChartPlaceholder(chart()) + ' after.</p>');
  canvas.getContext = () => null;
  restoreDataCharts(container);
  assert.equal(container.innerHTML, '<p>Before 图表不可用。 after.</p>');
});

test('preserves the order of multiple charts sharing a Markdown paragraph', () => {
  const first = dataChartPlaceholder(chart());
  const second = dataChartPlaceholder(chart({series: [{dataKey: 'limit', label: '第二张图'}]}));
  const {container} = fixture('<p>' + first + second + '</p>');
  restoreDataCharts(container);
  const captions = [...container.querySelectorAll('figcaption')].map(node => node.textContent);
  assert.equal(captions.length, 2);
  assert.doesNotMatch(captions[0], /第二张图/);
  assert.match(captions[1], /第二张图/);
  assert.equal(container.querySelector('p'), null);
});
