const test = require('node:test');
const assert = require('assert');
const { handleAdminRoutes } = require('../adminRoutes');
const { getEvaluationToggle, setEvaluationToggle } = require('../settingsStore');

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

function createMockDb(settingsItems = [], ragasItems = []) {
  const settingsStoreMap = new Map(settingsItems.map(item => [item.key, item]));

  return {
    collection(name) {
      if (name === 'system_settings') {
        return {
          async findOne(query) {
            return settingsStoreMap.get(query.key) || null;
          },
          async updateOne(query, update, options) {
            const existing = settingsStoreMap.get(query.key) || {};
            const updated = { ...existing, ...update.$set };
            settingsStoreMap.set(query.key, updated);
            return { acknowledged: true, modifiedCount: 1 };
          },
        };
      }

      if (name === 'evaluation_results') {
        return {
          aggregate(pipeline) {
            return {
              async toArray() {
                if (pipeline.some(stage => stage.$facet)) {
                  const evaluated = ragasItems.filter(i => i.evaluationStatus === 'completed' && i.metricsCalculated !== false && i.faithfulness !== null);
                  const totalCount = ragasItems.length;
                  const skippedCount = ragasItems.filter(i => i.metricsCalculated === false || i.faithfulness === null).length;
                  
                  const sumFaithfulness = evaluated.reduce((acc, i) => acc + (i.faithfulness || 0), 0);
                  const avgFaithfulness = evaluated.length > 0 ? sumFaithfulness / evaluated.length : null;

                  return [{
                    totals: [{
                      totalEvaluations: totalCount,
                      successCount: ragasItems.filter(i => i.evaluationStatus === 'completed').length,
                      failedCount: ragasItems.filter(i => i.evaluationStatus === 'failed').length,
                      skippedCount: skippedCount,
                      avgEvaluationTime: 120,
                    }],
                    scores: [{
                      avgFaithfulness: avgFaithfulness,
                      avgAnswerRelevancy: 0.95,
                      avgContextPrecision: 0.88,
                      avgContextRecall: 0.90,
                      avgPiiLeakage: 0.0,
                      avgOverallScore: 0.91,
                      evaluatedCount: evaluated.length,
                    }],
                  }];
                }

                if (pipeline.some(stage => stage.$group && stage.$group._id === '$provider')) {
                  return [{ _id: 'deepseek', count: ragasItems.length }];
                }

                if (pipeline.some(stage => stage.$group && stage.$group._id === '$model')) {
                  return [{ _id: 'deepseek-chat', count: ragasItems.length }];
                }

                return [];
              },
            };
          },
          async countDocuments() {
            return ragasItems.length;
          },
        };
      }

      return {
        async findOne() { return null; },
        async updateOne() { return {}; },
        async countDocuments() { return 0; },
      };
    },
  };
}

test('SettingsStore: Defaults to true and persists setting when toggled', async () => {
  const db = createMockDb();
  
  // Default check
  const defaultState = await getEvaluationToggle(db);
  assert.strictEqual(defaultState, true);

  // Turn OFF
  const updatedOff = await setEvaluationToggle(db, false);
  assert.strictEqual(updatedOff, false);
  const fetchedOff = await getEvaluationToggle(db);
  assert.strictEqual(fetchedOff, false);

  // Turn ON
  const updatedOn = await setEvaluationToggle(db, true);
  assert.strictEqual(updatedOn, true);
  const fetchedOn = await getEvaluationToggle(db);
  assert.strictEqual(fetchedOn, true);
});

test('AdminRoutes: GET /api/admin/settings/evaluation-toggle returns current state', async () => {
  const db = createMockDb([{ key: 'online_evaluation_enabled', enabled: true }]);
  const req = { url: '/api/admin/settings/evaluation-toggle', method: 'GET' };
  const res = createResponse();

  const handled = await handleAdminRoutes(req, res, db);
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 200);

  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.enabled, true);
});

test('AdminRoutes: POST /api/admin/settings/evaluation-toggle updates toggle state', async () => {
  const db = createMockDb();
  const req = {
    url: '/api/admin/settings/evaluation-toggle',
    method: 'POST',
    on(event, handler) {
      if (event === 'data') {
        handler(JSON.stringify({ enabled: false }));
      }
      if (event === 'end') {
        handler();
      }
    },
  };
  const res = createResponse();

  const handled = await handleAdminRoutes(req, res, db);
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 200);

  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.enabled, false);

  // Verify in-memory/DB state
  const currentState = await getEvaluationToggle(db);
  assert.strictEqual(currentState, false);
});

test('AdminRoutes: GET /api/admin/ragas/stats excludes skipped items from averages but includes in totalEvaluations', async () => {
  const ragasItems = [
    { requestId: 'req-1', evaluationStatus: 'completed', metricsCalculated: true, faithfulness: 0.90 },
    { requestId: 'req-2', evaluationStatus: 'completed', metricsCalculated: false, faithfulness: null }, // Skipped
  ];
  const db = createMockDb([], ragasItems);
  const req = { url: '/api/admin/ragas/stats', method: 'GET' };
  const res = createResponse();

  const handled = await handleAdminRoutes(req, res, db);
  assert.strictEqual(handled, true);
  assert.strictEqual(res.statusCode, 200);

  const payload = JSON.parse(res.body);
  assert.strictEqual(payload.success, true);
  assert.strictEqual(payload.data.totalEvaluations, 2);
  assert.strictEqual(payload.data.evaluatedCount, 1);
  assert.strictEqual(payload.data.skippedCount, 1);
  assert.strictEqual(payload.data.avgFaithfulness, 0.90); // Preserved accuracy!
});
