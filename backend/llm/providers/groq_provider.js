const { BaseLLMProvider, LLMConfigurationError, LLMAuthenticationError, LLMProviderUnavailableError } = require('../base');
const { settings, getProviderConfig } = require('../../config');

class GroqProvider extends BaseLLMProvider {
  constructor({ model } = {}) {
    super({ providerName: 'groq', defaultModel: model || settings.DEFAULT_LLM_MODEL || '' });
    this.config = getProviderConfig('groq');
    this.model = model || this.defaultModel;
  }

  async generate(request = {}) {
    if (!this.config.apiKey) {
      throw new LLMConfigurationError('Groq API key is not configured.');
    }

    const { messages = [], systemPrompt = '', temperature = 0.2, maxTokens = 512, modelOverride, family = 'llama' } = request;
    const model = modelOverride || (family === 'mistral' ? this.config.mistralModel : this.config.llamaModel) || this.model;

    if (!model) {
      throw new LLMConfigurationError('Groq model is not configured. Set GROQ_LLAMA_MODEL or GROQ_MISTRAL_MODEL in the backend environment.');
    }

    try {
      const { default: Groq } = require('groq-sdk');
      const client = new Groq({ apiKey: this.config.apiKey });
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages].filter(Boolean),
        temperature,
        max_tokens: maxTokens,
      });

      const outputText = response.choices?.[0]?.message?.content || '';
      return {
        content: outputText,
        provider: 'groq',
        model,
        usage: {
          input_tokens: response.usage?.prompt_tokens ?? null,
          output_tokens: response.usage?.completion_tokens ?? null,
          total_tokens: response.usage?.total_tokens ?? null,
        },
      };
    } catch (error) {
      if (error?.status === 401) {
        throw new LLMAuthenticationError('Groq authentication failed.');
      }
      if (error?.status === 429) {
        throw new LLMProviderUnavailableError('Groq rate limit reached.');
      }
      throw new LLMProviderUnavailableError('Groq request failed.', { cause: error.message });
    }
  }
}

module.exports = GroqProvider;
