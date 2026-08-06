const { BaseLLMProvider } = require('./base');
const OpenAIProvider = require('./providers/openai_provider');
const DeepSeekProvider = require('./providers/deepseek_provider');
const GeminiProvider = require('./providers/gemini_provider');
const GroqProvider = require('./providers/groq_provider');
const { settings } = require('../config');

const providerCache = new Map();

function getLLMProvider(provider = settings.DEFAULT_LLM_PROVIDER, model = null) {
  const targetModel = model || settings.DEFAULT_LLM_MODEL || 'deepseek-v4-pro';
  const cacheKey = `deepseek:${targetModel}`;

  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey);
  }

  const instance = new DeepSeekProvider({ model: targetModel });
  providerCache.set(cacheKey, instance);
  return instance;
}


module.exports = {
  getLLMProvider,
  BaseLLMProvider,
};
