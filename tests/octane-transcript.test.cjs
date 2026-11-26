const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

require('../extension/src/octane-transcript.js');
const { readOctaneTranscript } = global.GptExporter;

const shareId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const assistantId = '33333333-3333-4333-8333-333333333333';

function fixture(content, { type = 'application/json', id = 'octane-conversation-transcript' } = {}) {
  const window = new JSDOM('').window;
  const script = window.document.createElement('script');
  script.id = id;
  script.type = type;
  script.textContent = typeof content === 'string' ? content : JSON.stringify(content);
  window.document.head.append(script);
  return window.document;
}

function row(id, role, text, source) {
  return { key: id, origin: 'server', frame: { id, role, text }, source };
}

test('reads messages in transcript order and projects just the export fields', () => {
  const code = 'function __dilSafe() {}\nDIL.render({})';
  const constants = { values: [1, 2] };
  const root = { kind: 'text', value: 'Snapshot' };
  const document = fixture({ rows: [
    row(userId, 'user', 'Question'),
    row(assistantId, 'assistant', null, {
      messageId: assistantId,
      postData: { internal: true },
      publicShareId: shareId,
      revision: 1,
      status: 'complete',
      markdown: '  **Answer**\n',
      dil: {
        kind: 'dil', renderer: 'dil-v2', status: 'pending', code, constants,
        fallbackMarkdown: 'Snapshot transcript', references: ['private'],
        viewState: { root, appData: { internal: true }, session: 'private' }
      }
    })
  ] });
  assert.deepEqual(readOctaneTranscript(document, { shareId }), [
    { id: userId, role: 'user', markdown: 'Question' },
    { id: assistantId, role: 'assistant', markdown: '  **Answer**\n', dil: { code, constants, viewState: { root } } }
  ]);
});

test('rejects mismatched identities and skips internal, non-server, and duplicate rows', () => {
  const document = fixture({ rows: [
    { ...row(userId, 'user', 'Wrong row key'), key: assistantId },
    row(userId, 'user', 'Wrong source ID', { messageId: assistantId }),
    row(userId, 'user', 'Wrong share ID', { messageId: userId, publicShareId: assistantId }),
    row(userId, 'tool', 'Internal'),
    { ...row(userId, 'user', 'Client row'), origin: 'client' },
    row(userId, 'user', 'First valid message'),
    row(userId, 'user', 'Duplicate'),
    row(assistantId, 'assistant', 'Reply')
  ] });
  assert.deepEqual(readOctaneTranscript(document, { shareId }), [
    { id: userId, role: 'user', markdown: 'First valid message' },
    { id: assistantId, role: 'assistant', markdown: 'Reply' }
  ]);
});

test('preserves static prose when DIL data is unusable', () => {
  const document = fixture({ rows: [
    row(userId, 'user', 'Question'),
    row(assistantId, 'assistant', null, {
      messageId: assistantId,
      markdown: ' '.repeat(512 * 1024 + 1),
      dil: {
        kind: 'dil', renderer: 'dil-v2', code: 'x'.repeat(256 * 1024 + 1), constants: {},
        fallbackMarkdown: '**Plain fallback**'
      }
    })
  ] });
  assert.deepEqual(readOctaneTranscript(document), [
    { id: userId, role: 'user', markdown: 'Question' },
    { id: assistantId, role: 'assistant', markdown: '**Plain fallback**' }
  ]);
});

test('reads only the bounded JSON transcript script', () => {
  const valid = { rows: [row(userId, 'user', 'Question')] };
  assert.deepEqual(readOctaneTranscript(fixture(valid, { type: 'text/javascript' })), []);
  assert.deepEqual(readOctaneTranscript(fixture(valid, { id: 'some-other-id' })), []);
  assert.deepEqual(readOctaneTranscript(fixture('{garbled')), []);
  assert.deepEqual(readOctaneTranscript(fixture({ rows: Array(10001).fill(null) })), []);
  assert.deepEqual(readOctaneTranscript(fixture({ ...valid, padding: '界'.repeat(3 * 1024 * 1024) })), []);
});
