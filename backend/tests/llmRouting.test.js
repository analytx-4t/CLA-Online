// Provider routing and request shaping. No network calls: Portkey is never reached.
process.env.PORTKEY_API_KEY = process.env.PORTKEY_API_KEY || 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getLLMProvider } = require('../llm/factory');
const { isOpenAIReasoningModel } = require('../llm/portkey');
const OpenAIProvider = require('../llm/providers/openai_provider');
const DeepSeekProvider = require('../llm/providers/deepseek_provider');

test('getLLMProvider returns the provider that was asked for', () => {
  assert.ok(getLLMProvider('openai', 'gpt-6-luna') instanceof OpenAIProvider);
  assert.ok(getLLMProvider('deepseek', 'deepseek-v4-pro') instanceof DeepSeekProvider);
  assert.equal(getLLMProvider('openai', 'gpt-6-luna').model, 'gpt-6-luna');
  assert.equal(getLLMProvider('OpenAI', 'gpt-6-luna'), getLLMProvider('openai', 'gpt-6-luna'), 'cached per provider and model');
  assert.throws(() => getLLMProvider('unknown-provider', 'x'), /Unsupported LLM provider/);
});

test('gpt-5 and later (gpt-6-luna) and the o-series are sent reasoning-model parameters', () => {
  for (const model of ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-5', 'gpt-5.5-pro', 'o3', 'o4-mini']) {
    assert.equal(isOpenAIReasoningModel(model), true, model);
  }
  for (const model of ['gpt-4.1-mini', 'gpt-4o', 'deepseek-v4-pro', '', null]) {
    assert.equal(Boolean(isOpenAIReasoningModel(model)), false, String(model));
  }
});
