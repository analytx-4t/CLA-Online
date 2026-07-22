const test = require('node:test');
const assert = require('assert');
const { handleAdminRoutes } = require('../adminRoutes');

function createResponse() {
  const response = {
    statusCode: null,
    body: null,
    headers: {},
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload;
    },
  };

  return response;
}

function createDb(items = []) {
  const collection = {
    aggregate(pipeline) {
      return {
        async toArray() {
          if (pipeline.some((stage) => stage.$group)) {
            return [{ totalEvaluations: items.length, successRate: 0.5, failureRate: 0.5, avgFaithfulness: 0.8, avgAnswerRelevancy: 0.7, avgContextPrecision: 0.6, avgContextRecall: 0.5, avgAnswerCorrectness: 0.4, avgOverallScore: 0.6, avgEvaluationTime: 100, successCount: 1, failedCount: 0 }];
          }
          return items;
        },
      };
    },
    countDocuments() {
      return Promise.resolve(items.length);
    },
    findOne(query) {
      return Promise.resolve(items.find((item) => item.requestId === query.requestId) || null);
    },
    find() {
      const cursor = {
        sort() {
          return this;
        },
        skip() {
          return this;
        },
        limit() {
          return this;
        },
        project() {
          return this;
        },
        async toArray() {
          return items;
        },
      };
      return cursor;
    },
  };

  return {
    collection(name) {
      return collection;
    },
  };
}

test('GET /api/admin/ragas returns paginated summary data', async () => {
  const items = [
    {
      requestId: 'req-1',
      timestamp: '2024-01-01T00:00:00.000Z',
      question: 'What is the law?',
      overallScore: 0.82,
      evaluationStatus: 'completed',
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      retrievedContext: ['hidden'],
    },
  ];
  const req = { url: '/api/admin/ragas?page=1&limit=10&search=law&status=completed&provider=groq&model=llama', method: 'GET' };
  const res = createResponse();

  const handled = await handleAdminRoutes(req, res, createDb(items));

  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.data));
  assert.strictEqual(body.data[0].requestId, 'req-1');
  assert.strictEqual(body.data[0].question, 'What is the law?');
  assert.strictEqual(body.data[0].overallScore, 0.82);
  assert.strictEqual(body.data[0].evaluationStatus, 'completed');
  assert.strictEqual(body.data[0].provider, 'groq');
  assert.strictEqual(body.data[0].model, 'llama-3.3-70b-versatile');
  assert.ok(!Object.prototype.hasOwnProperty.call(body.data[0], 'retrievedContext'));
});

test('GET /api/admin/ragas/:requestId returns full evaluation payload', async () => {
  const items = [{
    requestId: 'req-2',
    question: 'How does this work?',
    answer: 'Here is the answer.',
    retrievedContext: ['context'],
    faithfulness: 0.9,
    answerRelevancy: 0.8,
    contextPrecision: 0.7,
    contextRecall: 0.6,
    answerCorrectness: 0.5,
    overallScore: 0.7,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    evaluationTimeMs: 420,
    metadata: { ragasVersion: '0.1.0' },
    suggestions: ['Follow up'],
    evaluationStatus: 'completed',
  }];
  const req = { url: '/api/admin/ragas/req-2', method: 'GET' };
  const res = createResponse();

  const handled = await handleAdminRoutes(req, res, createDb(items));

  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.data.requestId, 'req-2');
  assert.strictEqual(body.data.answer, 'Here is the answer.');
  assert.deepStrictEqual(body.data.retrievedContext, ['context']);
  assert.strictEqual(body.data.overallScore, 0.7);
});

test('GET /api/admin/ragas returns an empty array instead of an error when there are no records', async () => {
  const req = { url: '/api/admin/ragas?page=1&limit=10', method: 'GET' };
  const res = createResponse();

  const handled = await handleAdminRoutes(req, res, createDb([]));

  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.success, true);
  assert.deepStrictEqual(body.data, []);
  assert.strictEqual(body.pagination.total, 0);
  assert.strictEqual(body.pagination.totalPages, 1);
});

test('GET /api/admin/ragas skips malformed records gracefully', async () => {
  const items = [
    null,
    'bad-record',
    { requestId: 'req-3', timestamp: '2024-01-01T00:00:00.000Z', question: 'Question', overallScore: 0.8, evaluationStatus: 'completed', provider: 'groq', model: 'llama' },
  ];
  const req = { url: '/api/admin/ragas?page=1&limit=10', method: 'GET' };
  const res = createResponse();

  const handled = await handleAdminRoutes(req, res, createDb(items));

  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.data.length, 1);
  assert.strictEqual(body.data[0].requestId, 'req-3');
});

test('GET /api/admin/ragas/stats returns aggregate metrics', async () => {
  const req = { url: '/api/admin/ragas/stats', method: 'GET' };
  const res = createResponse();

  const handled = await handleAdminRoutes(req, res, createDb([]));

  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.data.totalEvaluations, 0);
  assert.strictEqual(body.data.successRate, 0);
  assert.strictEqual(body.data.failureRate, 0);
});
