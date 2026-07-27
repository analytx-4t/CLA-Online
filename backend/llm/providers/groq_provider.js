const {
  BaseLLMProvider,
  LLMConfigurationError,
  LLMAuthenticationError,
  LLMProviderUnavailableError,
} = require('../base');

const { settings, getProviderConfig } = require('../../config');
const { createChatCompletion } = require('../portkey');

class GroqProvider extends BaseLLMProvider {
  constructor({ model } = {}) {
    super({
      providerName: 'groq',
      defaultModel: model || settings.DEFAULT_LLM_MODEL || '',
    });

    this.config = getProviderConfig('groq');
    this.model = model || this.defaultModel;
  }

  async generate(request = {}) {
    const {
      messages = [],
      systemPrompt = '',
      temperature = 0.2,
      maxTokens = 512,
      modelOverride,
      family = 'llama',
      metadata = {},
      traceId,
      requestContext,
    } = request;

    const model =
      modelOverride ||
      (family === 'mistral'
        ? this.config.mistralModel
        : this.config.llamaModel) ||
      this.model;

    if (!model) {
      throw new LLMConfigurationError(
        'Groq model is not configured.'
      );
    }

    try {
      const response = await createChatCompletion({
        provider: 'groq',
        model,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        metadata,
        traceId,
        requestContext,
      });

      return {
        content: response.choices?.[0]?.message?.content || '',
        provider: response._actualProvider || 'groq',
        model: response._actualModel || model,
        usage: {
          input_tokens: response.usage?.prompt_tokens ?? null,
          output_tokens: response.usage?.completion_tokens ?? null,
          total_tokens: response.usage?.total_tokens ?? null,
        },
      };
    } catch (error) {
      if (error?.status === 401) {
        throw new LLMAuthenticationError(
          'Portkey or Groq authentication failed.'
        );
      }

      if (error?.status === 429) {
        throw new LLMProviderUnavailableError(
          'Groq rate limit reached.'
        );
      }

      throw new LLMProviderUnavailableError(
        'Groq request through Portkey failed.',
        { cause: error.message }
      );
    }
  }
}

module.exports = GroqProvider;