const { BaseLLMProvider, LLMConfigurationError, LLMAuthenticationError, LLMProviderUnavailableError } = require('../base');
const { settings, getProviderConfig } = require('../../config');

class DeepSeekProvider extends BaseLLMProvider {
  constructor({ model } = {}) {
    super({ providerName: 'deepseek', defaultModel: model || settings.DEFAULT_LLM_MODEL || 'deepseek-v4-pro' });
    this.config = getProviderConfig('deepseek');
    this.defaultModel = model || this.defaultModel;
  }

  async generate(request = {}) {
    if (!this.config.apiKey) {
      throw new LLMConfigurationError('DeepSeek API key is not configured.');
    }

    const { messages = [], systemPrompt = '', temperature = 0.2, maxTokens = 512, modelOverride, variant = 'pro' } = request;
    const model = modelOverride || (variant === 'flash' ? this.config.flashModel : this.config.proModel) || this.defaultModel;

    try {
      const { default: OpenAI } = require('openai');
      const client = new OpenAI({ apiKey: this.config.apiKey, baseURL: 'https://api.deepseek.com' });
      const response = await client.responses.create({
        model,
        instructions: systemPrompt,
        input: messages.map((m) => ({ role: m.role || 'user', content: m.content || '' })),
        temperature,
        max_output_tokens: maxTokens,
      });

      const outputText = response.output_text || '';
      return {
        content: outputText,
        provider: 'deepseek',
        model,
        usage: {
          input_tokens: response.usage?.input_tokens ?? null,
          output_tokens: response.usage?.output_tokens ?? null,
          total_tokens: response.usage?.total_tokens ?? null,
        },
      };
    } catch (error) {
      if (error?.status === 401) {
        throw new LLMAuthenticationError('DeepSeek authentication failed.');
      }
      if (error?.status === 429) {
        throw new LLMProviderUnavailableError('DeepSeek rate limit reached.');
      }
      throw new LLMProviderUnavailableError('DeepSeek request failed.', { cause: error.message });
    }
  }
}

module.exports = DeepSeekProvider;
