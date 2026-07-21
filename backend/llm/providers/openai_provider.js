const {
  BaseLLMProvider,
  LLMConfigurationError,
  LLMAuthenticationError,
  LLMProviderUnavailableError,
} = require('../base');

const { settings } = require('../../config');
const { createChatCompletion } = require('../portkey');

class OpenAIProvider extends BaseLLMProvider {
  constructor({ model } = {}) {
    super({
      providerName: 'openai',
      defaultModel: model || settings.OPENAI_MODEL || 'gpt-4.1-mini',
    });

    this.model = model || this.defaultModel;
  }

  async generate(request = {}) {
    const {
      messages = [],
      systemPrompt = '',
      temperature = 0.2,
      maxTokens = 512,
      modelOverride,
      metadata = {},
      traceId,
      requestContext,
    } = request;

    const model = modelOverride || this.model;

    if (!model) {
      throw new LLMConfigurationError(
        'OpenAI model is not configured.'
      );
    }

    try {
      const response = await createChatCompletion({
        provider: 'openai',
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
        provider: 'openai',
        model,
        usage: {
          input_tokens: response.usage?.prompt_tokens ?? null,
          output_tokens: response.usage?.completion_tokens ?? null,
          total_tokens: response.usage?.total_tokens ?? null,
        },
      };
    } catch (error) {
      if (error?.status === 401) {
        throw new LLMAuthenticationError(
          'Portkey or OpenAI authentication failed.'
        );
      }

      if (error?.status === 429) {
        throw new LLMProviderUnavailableError(
          'OpenAI quota or rate limit reached.'
        );
      }

      throw new LLMProviderUnavailableError(
        'OpenAI request through Portkey failed.',
        { cause: error.message }
      );
    }
  }
}

module.exports = OpenAIProvider;