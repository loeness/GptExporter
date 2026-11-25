const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const katex = require('katex');

require('../extension/src/static-demos.js');
const { restoreStaticDemos } = global.GptExporter;
const png = 'data:image/png;base64,iVBORw==';

function fixture() {
  const dom = new JSDOM(String.raw`<main><article data-role="assistant"><div class="message-body">
    <p>Example probability density</p>
    <p><span data-ge-display="true" data-ge-tex="f(x)=\lambda e^{-\lambda x},\qquad x\ge0"></span></p>
    <p>Rate <span data-ge-display="false" data-ge-tex="\lambda"></span></p>
    <blockquote>
      <p><strong>滑块</strong></p>
      <p class="current">当前值不可用。</p>
      <p><strong>范围：</strong> 0.01 至 1</p>
      <p><strong>步长：</strong> 0.01</p>
    </blockquote>
    <hr><p>The mean is the reciprocal of the rate.</p>
  </div></article></main>`);
  const container = dom.window.document.querySelector('main');
  for (const formula of container.querySelectorAll('[data-ge-tex]')) {
    formula.innerHTML = katex.renderToString(formula.dataset.geTex, { displayMode: formula.dataset.geDisplay === 'true' });
  }
  const canvas = dom.window.HTMLCanvasElement.prototype;
  const labels = [];
  const points = [];
  canvas.getContext = () => ({
    scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, stroke() {}, setLineDash() {},
    lineTo(x, y) { points.push([x, y]); },
    fillText(label) { labels.push(label); }
  });
  canvas.toDataURL = function (format) {
    assert.equal(format, 'image/png');
    assert.deepEqual([this.width, this.height], [1440, 800]);
    return png;
  };
  return { container, canvas, labels, points };
}

test('replaces the matched control with a local exponential density chart and keeps surrounding math and prose', () => {
  const { container, labels, points } = fixture();
  restoreStaticDemos(container);
  const chart = container.querySelector('figure[data-ge-static-demo="exponential-pdf"]');
  assert.ok(chart);
  assert.equal(chart.querySelector('img').getAttribute('src'), png);
  assert.match(chart.querySelector('img').alt, /示例速率 λ = 0\.10、0\.40、1\.00/);
  assert.match(chart.querySelector('figcaption').textContent, /平均等待时间约为 10、2\.5、1/);
  assert.doesNotMatch(container.textContent, /当前值不可用|滑块/);
  assert.equal(chart.previousElementSibling.querySelector('[data-ge-tex]').dataset.geDisplay, 'true');
  assert.equal(chart.nextElementSibling.localName, 'hr');
  assert.match(container.textContent, /The mean is the reciprocal/);
  assert.deepEqual(labels.filter((label) => label.startsWith('λ')), ['λ = 0.10', 'λ = 0.40', 'λ = 1.00']);
  assert.ok(points.some(([x, y]) => x === 378 && Math.abs(y - (335 - 253 * 0.1 * Math.exp(-1))) < 1e-7));
  restoreStaticDemos(container);
  assert.equal(container.querySelectorAll('figure').length, 1);
});

test('uses an explicit valid current rate and accepts TeX spacing and comparison variants', () => {
  const { container, labels } = fixture();
  container.querySelector('.current').textContent = '当前值：0.23';
  container.querySelector('[data-ge-display="true"]').dataset.geTex =
    String.raw`f(x) = \lambda \, e^{- \lambda \, x}, \quad x \geq 0`;
  restoreStaticDemos(container);
  const chart = container.querySelector('figure');
  assert.ok(chart);
  assert.match(chart.querySelector('figcaption').textContent, /原始速率 λ = 0\.23.*4\.35/);
  assert.deepEqual(labels.filter((label) => label.startsWith('λ')), ['λ = 0.23']);
});

test('preserves unrelated, invalid, or unsupported controls', () => {
  const edits = [
    ({ container }) => { container.querySelector('article').dataset.role = 'user'; },
    ({ container }) => { container.querySelector('[data-ge-display="true"]').dataset.geTex = String.raw`f(x)=\lambda e^{-\lambda x^2},x\ge0`; },
    ({ container }) => { container.querySelector('[data-ge-display="true"]').dataset.geTex = String.raw`f(x)=\lambdae^{-\lambdax},x\ge0`; },
    ({ container }) => { container.querySelector('.current').textContent = '当前值：0.231'; },
    ({ container }) => { container.querySelector('.current').textContent = '当前值：0.00'; },
    ({ container }) => { container.querySelector('blockquote').lastElementChild.append(' with more text'); },
    ({ container }) => { container.querySelector('hr').remove(); },
    ({ canvas }) => { canvas.getContext = () => null; }
  ];
  for (const edit of edits) {
    const page = fixture();
    edit(page);
    const original = page.container.innerHTML;
    restoreStaticDemos(page.container);
    assert.equal(page.container.innerHTML, original);
  }
});
