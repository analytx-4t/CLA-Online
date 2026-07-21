require('dotenv').config();
const assert = require('assert');
const test = require('node:test');
const { getPortkeyModel } = require('../llm/portkey');
const { getLLMProvider } = require('../llm/factory');
const DeepSeekProvider = require('../llm/providers/deepseek_provider');

test('getPortkeyModel returns valid portkey string for deepseek', () => {
  const deepseekSlug = process.env.PORTKEY_DEEPSEEK_PROVIDER || '@deepseek-production';
  const modelStr = getPortkeyModel('deepseek', 'deepseek-chat');
  assert.strictEqual(modelStr, `${deepseekSlug}/deepseek-chat`);
});

test('DeepSeekProvider instantiates correctly with Portkey integration', () => {
  const provider = getLLMProvider('deepseek', 'deepseek-chat');
  assert.ok(provider instanceof DeepSeekProvider);
  assert.strictEqual(provider.providerName, 'deepseek');
  assert.strictEqual(provider.defaultModel, 'deepseek-chat');
});

test('Admin route for Portkey includes deepseek provider statistics and logs', async () => {
  const { handleAdminRoutes } = require('../adminRoutes');

  let responseData = null;
  let statusCode = null;

  const req = { url: '/api/admin/portkey', method: 'GET' };
  const res = {
    writeHead: (code) => { statusCode = code; },
    end: (str) => { responseData = JSON.parse(str); },
  };

  const dummyDb = {
    collection: () => ({
      find: () => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => [
              {
                requestId: 'req_ds_test_1',
                sessionId: 'CLA-SESS-DS1',
                question: 'Legal enquiry for DeepSeek',
                answer: 'DeepSeek response content',
                provider: 'deepseek',
                model: 'deepseek-chat',
                timestamp: new Date().toISOString(),
              },
            ],
          }),
        }),
      }),
    }),
  };

  const handled = await handleAdminRoutes(req, res, dummyDb);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 200);
  assert.ok(responseData);
  assert.ok(responseData.providerStats.deepseek);
  assert.strictEqual(responseData.providerStats.deepseek.count > 0, true);

  const hasDeepseekLog = responseData.recentLogs.some((log) => log.provider === 'deepseek');
  assert.strictEqual(hasDeepseekLog, true);
});
