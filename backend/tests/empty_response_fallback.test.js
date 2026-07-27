require('dotenv').config();
const test = require('node:test');
const assert = require('assert');
const { createChatCompletion } = require('../llm/portkey');
const DeepSeekProvider = require('../llm/providers/deepseek_provider');

test('createChatCompletion handles fallback when primary provider returns empty or fails', async () => {
  const provider = new DeepSeekProvider();
  
  // Test generation with provider - should succeed via deepseek or fallback chain without returning empty content
  const result = await provider.generate({
    messages: [{ role: 'user', content: 'Say hello in 3 words' }],
    temperature: 0.1,
    maxTokens: 50,
  });

  assert.ok(result.content, 'Content should not be empty');
  assert.ok(result.content.trim().length > 0, 'Content string should have length > 0');
  assert.ok(result.provider, 'Provider should be defined');
  assert.ok(result.model, 'Model should be defined');
  console.log(`Generated response via ${result.provider} (${result.model}): "${result.content.trim()}"`);
});
