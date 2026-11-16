const { BaseLLMProvider } = require('./base');
const OpenAIProvider = require('./providers/openai_provider');
const DeepSeekProvider = require('./providers/deepseek_provider');
const GeminiProvider = require('./providers/gemini_provider');
const GroqProvider = require('./providers/groq_provider');
const { settings } = require('../config');

const PROVIDERS = {
  openai: OpenAIProvider,
  deepseek: DeepSeekProvider,
  gemini: GeminiProvider,
  groq: GroqProvider,
};

const providerCache = new Map();

/**
 * Returns the provider client for `provider`, routed through Portkey.
 *
 * `model` is the model to request; when it is omitted each provider uses its own configured
 * default (OPENAI_MODEL, DEEPSEEK_PRO_MODEL, ...).
 */
function getLLMProvider(provider = settings.DEFAULT_LLM_PROVIDER, model = null) {
  const providerName = String(provider || settings.DEFAULT_LLM_PROVIDER || 'deepseek').toLowerCase();
  const ProviderClass = PROVIDERS[providerName];
  if (!ProviderClass) {
    throw new Error(`Unsupported LLM provider: ${provider}`);
  }

  const cacheKey = `${providerName}:${model || 'default'}`;
  if (!providerCache.has(cacheKey)) {
    providerCache.set(cacheKey, new ProviderClass({ model: model || undefined }));
  }
  return providerCache.get(cacheKey);
}

module.exports = {
  getLLMProvider,
  BaseLLMProvider,
};
