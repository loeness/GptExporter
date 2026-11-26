const assert = require('node:assert/strict');
const test = require('node:test');

globalThis.acorn = require('acorn');
require('../extension/src/comparison-extractor.js');
const { extractDilComparisons } = globalThis.GptExporter;

const options = [
  { label: 'Direct Mapped', value: '1' },
  { label: '2-way', value: '2' },
  { label: '3-way', value: '3' }
];

const control = `__dilSafe(() => __dil.jsx('segmented-control', {
  options: __dilConstants['262'], value: ways, onChange: setWays
}), null)`;

function payload(contents, extra = {}) {
  return {
    constants: { 262: options, 263: 'Slots' },
    viewState: { root: { ways: '3', suffix: 'captured' } },
    code: `
      function __dilSafe(evaluate, failureValue) {
        try { return evaluate(); } catch { return failureValue; }
      }
      globalThis.comparisonTestTracker?.push('outer source was run');
      DIL.render(__dil.jsx(() => {
        const __dilConstants = DIL.useConstants();
        const __dilModelDataBindings = DIL.useAppData((data) => data.opGenui?.modelDataBindings ?? {});
        const [ways, setWays] = DIL.useState('1', { key: 'ways' });
        const [suffix, setSuffix] = DIL.useState('default', { key: 'suffix' });
        return __dil.jsx('column', null, ${contents});
      }));
    `,
    ...extra
  };
}

function card(content) {
  return `__dil.jsx('card', { gap: 3 }, ${control}, ${content})`;
}

test('renders every option using the selected state and nested static calculations', () => {
  const content = `
    __dil.jsx('caption', null, __dilConstants['263']),
    __dil.jsx('box', {}, __dilSafe(() =>
      ['A', 'B', 'C'].map((item, i) => __dilSafe(() =>
        __dil.jsx('row', {},
          __dil.jsx('text', {}, i + 1),
          __dil.jsx('text', {}, item),
          Array.from({ length: Number(ways) }, (_, j) => j).map(j =>
            __dil.jsx('text', {}, j < Math.min(i + 1, Number(ways))
              ? ['A', 'B', 'C'][((i - j) % 3 + 3) % 3] : 'empty')),
          __dil.jsx('badge',
            { color: Number(ways) === 3 && i >= 2 ? 'success' : 'danger' },
            Number(ways) === 3 && i >= 2 ? 'Hit' : 'Miss')
        ), null))
    , [])),
    __dil.jsx('divider', null),
    __dil.jsx('caption', null, ways === '3' ? 'three-' + suffix : 'other-' + suffix)
  `;
  const input = payload(card(content));
  input.constants.unrelated = Array.from({ length: 1000 }, () => 'ignored');
  const [comparison] = extractDilComparisons(input);
  assert.deepEqual(comparison.options.map(option => option.label), options.map(option => option.label));
  assert.deepEqual(comparison.options.map(option => option.nodes[0].children.map(node => node.type)),
    Array.from({ length: 3 }, () => ['caption', 'box', 'divider', 'caption']));
  const byOption = comparison.options.map(option => option.nodes[0].children);
  assert.deepEqual(byOption.map(children => children[1].children[0].children.slice(2, -1)
    .map(cell => cell.children[0])), [['A'], ['A', 'empty'], ['A', 'empty', 'empty']]);
  assert.deepEqual(byOption[2][1].children[2].children.at(-1),
    { type: 'badge', props: { color: 'success' }, children: ['Hit'] });
  assert.deepEqual(byOption.map(children => children.at(-1).children[0]),
    ['other-captured', 'other-captured', 'three-captured']);
});

test('uses literal state defaults and keeps the nearest box or card in declaration order', () => {
  const results = extractDilComparisons(payload(`
    __dil.jsx('card', null, 'outside', __dil.jsx('box', null, ${control}, suffix + ways)),
    ${card('ways')}
  `, { viewState: {} }));
  assert.deepEqual(results.map(comparison => comparison.options[0].nodes[0]), [
    { type: 'box', props: {}, children: ['default1'] },
    { type: 'card', props: {}, children: ['1'] }
  ]);
});

test('drops a card on a forbidden expression in any option and never runs source', () => {
  globalThis.comparisonTestTracker = [];
  try {
    const unsafe = [
      "globalThis.comparisonTestTracker.push('run')",
      "__dilConstants['262'].constructor",
      "__dilConstants['__proto__']",
      "['x']['map'](() => 'x')",
      "(() => 'x')()",
      "setWays('3')",
      "Array.from({ length: 129 }, (_, i) => i)",
      "Number('Infinity')",
      "__dil.jsx('iframe', null, 'x')",
      "Array.from({ length: 128 }, (_, i) => Array.from({ length: 128 }, (_, j) => i + j))",
      "[__dil.jsx('box', null, Array.from({ length: 20 }, () => 'slot'))]"
        + ".map(box => Array.from({ length: 128 }, () => box))"
    ];
    for (const expression of unsafe) {
      const input = payload(`
        ${card(`__dilSafe(() => ways === '3' ? (${expression}) : 'ok', 'fallback')`)},
        ${card("'following card'")}
      `);
      const comparisons = extractDilComparisons(input);
      assert.equal(comparisons.length, 1, expression);
      assert.deepEqual(comparisons[0].options[2].nodes[0].children, ['following card']);
    }
    assert.deepEqual(globalThis.comparisonTestTracker, []);
  } finally {
    delete globalThis.comparisonTestTracker;
  }
});

test('rejects duplicates, malformed options, mismatched setters, and repeated controls', () => {
  for (const values of [
    [{ label: 'only one', value: '1' }],
    [{ label: 'same', value: '1' }, { label: 'same', value: '2' }],
    [{ label: 'one', value: '1' }, { label: 'two', value: '1' }],
    [{ label: ['nested'], value: '1' }, { label: 'two', value: '2' }],
    Array.from({ length: 7 }, (_, index) => ({ label: String(index), value: index }))
  ]) {
    assert.deepEqual(extractDilComparisons(payload(card('ways'), { constants: { 262: values } })), []);
  }
  assert.deepEqual(extractDilComparisons(payload(card('ways').replace('onChange: setWays', 'onChange: setSuffix'))), []);
  assert.deepEqual(extractDilComparisons(payload(card(control))), []);
});

test('discovers only cards in rendered JSX and known wrappers', () => {
  const hidden = card("'hidden'");
  const visible = card("'visible'");
  const comparisons = extractDilComparisons(payload([
    "false ? " + hidden + " : null",
    "unrecognizedCallback(" + hidden + ")",
    "__dilSafe(() => null, " + hidden + ")",
    "__dilSafe(() => " + visible + ", null)"
  ].join(",\n")));
  assert.equal(comparisons.length, 1);
  assert.deepEqual(comparisons[0].options[0].nodes[0].children, ['visible']);
});

test('rejects malformed or oversized source and does not read data accessors', () => {
  assert.deepEqual(extractDilComparisons({ code: 'DIL.render(' }), []);
  assert.deepEqual(extractDilComparisons(payload(card('ways'), { code: ' '.repeat(256 * 1024 + 1) })), []);
  assert.deepEqual(extractDilComparisons(payload(card('ways'), { code: '// ' + '中'.repeat(90000) })), []);
  let reads = 0;
  const constants = {};
  Object.defineProperty(constants, '262', {
    get() {
      reads += 1;
      return options;
    }
  });
  assert.deepEqual(extractDilComparisons(payload(card('ways'), { constants })), []);
  assert.equal(reads, 0);
});
