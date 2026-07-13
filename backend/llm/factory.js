const { BaseLLMProvider } = require('./base');
const OpenAIProvider = require('./providers/openai_provider');
const DeepSeekProvider = require('./providers/deepseek_provider');
const GeminiProvider = require('./providers/gemini_provider');
const GroqProvider = require('./providers/groq_provider');
const { settings } = require('../config');

const providerCache = new Map();

function getLLMProvider(provider = settings.DEFAULT_LLM_PROVIDER, model = null) {
  const normalizedProvider = (provider || settings.DEFAULT_LLM_PROVIDER || 'openai').toLowerCase();
  const cacheKey = `${normalizedProvider}:${model || settings.DEFAULT_LLM_MODEL || 'default'}`;

  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey);
  }

  let instance;
  switch (normalizedProvider) {
    case 'openai':
      instance = new OpenAIProvider({ model });
      break;
    case 'deepseek':
      instance = new DeepSeekProvider({ model });
      break;
    case 'gemini':
      instance = new GeminiProvider({ model });
      break;
    case 'groq':
      instance = new GroqProvider({ model });
      break;
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }

  providerCache.set(cacheKey, instance);
  return instance;
}

module.exports = {
  getLLMProvider,
  BaseLLMProvider,
};
