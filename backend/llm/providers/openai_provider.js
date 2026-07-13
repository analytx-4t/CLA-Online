const { BaseLLMProvider, LLMConfigurationError, LLMAuthenticationError, LLMProviderUnavailableError } = require('../base');
const { settings, getProviderConfig } = require('../../config');

class OpenAIProvider extends BaseLLMProvider {
  constructor({ model } = {}) {
    super({ providerName: 'openai', defaultModel: model || settings.OPENAI_MODEL || 'gpt-4.1-mini' });
    this.config = getProviderConfig('openai');
    this.model = model || this.defaultModel;
  }

  async generate(request = {}) {
    if (!this.config.apiKey) {
      throw new LLMConfigurationError('OpenAI API key is not configured.');
    }

    const { messages = [], systemPrompt = '', temperature = 0.2, maxTokens = 512, modelOverride } = request;
    const model = modelOverride || this.model;

    try {
      const { OpenAI } = require('openai');
      const client = new OpenAI({ apiKey: this.config.apiKey });
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
        provider: 'openai',
        model,
        usage: {
          input_tokens: response.usage?.input_tokens ?? null,
          output_tokens: response.usage?.output_tokens ?? null,
          total_tokens: response.usage?.total_tokens ?? null,
        },
      };
    } catch (error) {
      if (error?.status === 401) {
        throw new LLMAuthenticationError('OpenAI authentication failed.');
      }
      if (error?.status === 429) {
        throw new LLMProviderUnavailableError('OpenAI rate limit reached.');
      }
      throw new LLMProviderUnavailableError('OpenAI request failed.', { cause: error.message });
    }
  }
}

module.exports = OpenAIProvider;
