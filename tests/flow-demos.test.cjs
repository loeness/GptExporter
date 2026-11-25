const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(require.resolve('../extension/src/flow-demos.js'), 'utf8');
const backward = String.raw`\overset{\text{backward}}{\longrightarrow}`;
const rounds = [
  [String.raw`s\to a\to x\to t`, '5,4,4', 4],
  [String.raw`s\rightarrow c\rightarrow y\rightarrow t`, '3,3,5', 3],
  [String.raw`s\to a\to y\to t`, '5-4,5,5-3', 1],
  [String.raw`s\to b\to x ${backward} a\to y\to t`, '4,4,4,4,1', 1],
  [String.raw`s\to b\to x ${backward} a\to y ${backward} c\to z\to t`, '3,3,3,3,3,3,3', 3]
];

function fixture(options = {}) {
  const dom = new JSDOM(`
    <article data-role="${options.role || 'assistant'}"><div class="message-body">
      <p>这个例子有 8 个顶点、${options.edgeCount || 11} 条边。</p>
      <h2>1. 初始网络</h2>
      <p>所有边初始 Flow = 0，数字表示 Capacity</p>
      <h2>2. 逐轮执行 Ford–Fulkerson</h2>
      <p>当前总流量</p>
      <h1>/ 12</h1>
      <p>增广进度： / 5 轮</p>
      <p>增加流量</p>
      <p>撤销流量</p>
      <hr>
      <p>[上一轮] [重置] [下一轮]</p>
      <h2>3. 检验</h2>
      <p>最终结果应为 12。</p>
    </div></article>`, { runScripts: 'outside-only' });
  const { document } = dom.window;
  const nextSection = document.querySelector('h2:last-of-type');
  function math(tex) {
    const p = document.createElement('p');
    const span = document.createElement('span');
    span.setAttribute('data-ge-tex', tex);
    span.setAttribute('data-ge-display', 'true');
    span.textContent = tex;
    p.append(span);
    return p;
  }
  for (const [index, [path, residuals, amount]] of rounds.entries()) {
    const round = index + 1;
    const h3 = document.createElement('h3');
    h3.textContent = 'Round ' + round + '：增广';
    const explanation = document.createElement('p');
    explanation.textContent = '本轮增广路径与瓶颈如下。';
    const changed = options.badResidual && round === 5 ? '3,3,4,3,3,3,3' : residuals;
    const formula = String.raw`b_{${round}}=\min(${changed})=${amount}`;
    nextSection.before(h3, explanation, math(path), math(formula));
  }
  const drawings = [];
  dom.window.HTMLCanvasElement.prototype.getContext = () => {
    if (options.noCanvas) return null;
    const drawing = { labels: [], lineDashes: [] };
    drawings.push(drawing);
    return {
      scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      closePath() {}, fill() {}, arc() {},
      setLineDash(value) { drawing.lineDashes.push(Array.from(value)); },
      fillText(value) { drawing.labels.push(value); }
    };
  };
  dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
  dom.window.eval(source);
  return { dom, document, drawings, restore: () => dom.window.GptExporter.restoreFlowDemos(document.body) };
}

test('reconstructs the full network, including backward residual updates', () => {
  const { dom, document, drawings, restore } = fixture();
  restore();
  const figures = Array.from(document.querySelectorAll('[data-ge-static-demo="flow-network"]'));
  assert.equal(figures.length, 6);
  assert.deepEqual(figures.map((figure) => Number(figure.dataset.geFlowRound)), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(figures.map((figure) => Number(/当前总流量 (\d+)/.exec(figure.textContent)[1])), [0, 4, 7, 8, 9, 12]);
  assert.match(figures[0].querySelector('img').alt, /c → z 0\/3/);
  assert.match(figures[4].querySelector('img').alt, /a → x 3\/4/);
  assert.match(figures[5].querySelector('img').alt, /a → x 0\/4/);
  assert.match(figures[5].querySelector('img').alt, /c → y 0\/3/);
  assert.match(figures[5].querySelector('img').alt, /a → y 5\/5/);
  assert.equal(drawings[5].lineDashes.filter((dash) => dash.length > 0).length, 2);
  assert.ok(drawings[5].labels.includes('− 0/4'));
  assert.equal(document.querySelector('h1'), null);
  assert.doesNotMatch(document.body.textContent, /\[下一轮\]/);
  assert.match(document.body.textContent, /本轮增广路径与瓶颈如下/);
  assert.equal(document.querySelectorAll('[data-ge-tex]').length, 10);
  restore();
  assert.equal(document.querySelectorAll('figure').length, 6);
  dom.window.close();
});

test('preserves the DOM when residuals, declarations, author or canvas fail verification', () => {
  for (const options of [{ badResidual: true }, { edgeCount: 10 }, { role: 'user' }, { noCanvas: true }]) {
    const { dom, document, restore } = fixture(options);
    const before = document.body.innerHTML;
    restore();
    assert.equal(document.body.innerHTML, before);
    dom.window.close();
  }
});
