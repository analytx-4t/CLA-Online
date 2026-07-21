const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPortkeyRequestContextOptions } = require('../llm/metadata');

test('buildPortkeyRequestContextOptions adds request context to Portkey trace and metadata', () => {
  const requestContext = {
    requestId: 'req-123',
    sessionId: 'session-abc',
    messageId: 'msg-789',
  };

  const result = buildPortkeyRequestContextOptions(requestContext, { existing: 'value' });

  assert.equal(result.traceId, 'req-123');
  assert.deepEqual(result.metadata, {
    requestId: 'req-123',
    sessionId: 'session-abc',
    messageId: 'msg-789',
    existing: 'value',
  });
});

test('buildPortkeyRequestContextOptions preserves existing behavior when request context is missing', () => {
  const result = buildPortkeyRequestContextOptions(null, { existing: 'value' }, 'explicit-trace');

  assert.equal(result.traceId, 'explicit-trace');
  assert.deepEqual(result.metadata, { existing: 'value' });
});
