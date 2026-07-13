const {
  BaseLLMProvider,
  LLMConfigurationError,
  LLMAuthenticationError,
  LLMProviderUnavailableError,
} = require('../base');

const { settings, getProviderConfig } = require('../../config');
const { createChatCompletion } = require('../portkey');

class DeepSeekProvider extends BaseLLMProvider {
  constructor({ model } = {}) {
    super({
      providerName: 'deepseek',
      defaultModel:
        model || settings.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro',
    });

    this.config = getProviderConfig('deepseek');
    this.defaultModel = model || this.defaultModel;
  }

  async generate(request = {}) {
    const {
      messages = [],
      systemPrompt = '',
      temperature = 0.2,
      maxTokens = 512,
      modelOverride,
      variant = 'pro',
      metadata = {},
      traceId,
    } = request;

    const model =
      modelOverride ||
      (variant === 'flash'
        ? this.config.flashModel
        : this.config.proModel) ||
      this.defaultModel;

    if (!model) {
      throw new LLMConfigurationError(
        'DeepSeek model is not configured.'
      );
    }

    try {
      const response = await createChatCompletion({
        provider: 'deepseek',
        model,
        messages,
        systemPrompt,
        temperature,
        maxTokens,
        metadata,
        traceId,
      });

      return {
        content: response.choices?.[0]?.message?.content || '',
        provider: 'deepseek',
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
          'Portkey or DeepSeek authentication failed.'
        );
      }

      if (error?.status === 429) {
        throw new LLMProviderUnavailableError(
          'DeepSeek rate limit reached.'
        );
      }

      throw new LLMProviderUnavailableError(
        'DeepSeek request through Portkey failed.',
        { cause: error.message }
      );
    }
  }
}

module.exports = DeepSeekProvider;