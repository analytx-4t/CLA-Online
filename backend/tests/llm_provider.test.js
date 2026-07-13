const assert = require('assert');
const test = require('node:test');
const { getLLMProvider } = require('../llm/factory');
const { getProviderHealth } = require('../config');

test('returns the expected provider factory instances', () => {
  const openai = getLLMProvider('openai');
  const deepseek = getLLMProvider('deepseek');
  const gemini = getLLMProvider('gemini');
  const groq = getLLMProvider('groq');

  assert.ok(openai);
  assert.ok(deepseek);
  assert.ok(gemini);
  assert.ok(groq);
});

test('reports provider configuration status without secrets', () => {
  const health = getProviderHealth();
  assert.ok(health.openai);
  assert.ok(health.deepseek);
  assert.ok(health.gemini);
  assert.ok(health.groq);
  assert.strictEqual(typeof health.openai.configured, 'boolean');
});
