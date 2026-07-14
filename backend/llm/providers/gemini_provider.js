const {
  BaseLLMProvider,
  LLMConfigurationError,
  LLMAuthenticationError,
  LLMProviderUnavailableError,
} = require('../base');

const { settings, getProviderConfig } = require('../../config');

class GeminiProvider extends BaseLLMProvider {
  constructor({ model } = {}) {
    super({
      providerName: 'gemini',
      defaultModel: model || settings.GEMINI_MODEL || '',
    });

    this.config = getProviderConfig('gemini');
    this.model = model || this.config.model || this.defaultModel;
  }

  async generate(request = {}) {
    if (!this.config.apiKey) {
      throw new LLMConfigurationError(
        'Gemini API key is not configured.'
      );
    }

    if (!this.model) {
      throw new LLMConfigurationError(
        'Gemini model is not configured.'
      );
    }

    try {
      const { GoogleGenAI } = require('@google/genai');

      const ai = new GoogleGenAI({
        apiKey: this.config.apiKey,
      });

      const messages = request.messages || [];

      const contents = messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [
          {
            text: String(message.content || ''),
          },
        ],
      }));

      const config = {};

      if (request.systemPrompt) {
        config.systemInstruction = request.systemPrompt;
      }

      if (request.temperature !== undefined) {
        config.temperature = request.temperature;
      }

      if (request.maxTokens !== undefined) {
        config.maxOutputTokens = request.maxTokens;
      }

      const response = await ai.models.generateContent({
        model: this.model,
        contents,
        config,
      });

      const usage = response.usageMetadata || {};

      return {
        content: response.text || '',
        provider: 'gemini',
        model: this.model,
        usage: {
          input_tokens: usage.promptTokenCount ?? null,
          output_tokens: usage.candidatesTokenCount ?? null,
          total_tokens: usage.totalTokenCount ?? null,
        },
      };
    } catch (error) {
      console.error('[Gemini] Request failed:', {
        status: error?.status || error?.code || null,
        name: error?.name || null,
        message: error?.message || 'Unknown Gemini error',
      });

      if (error?.status === 401 || error?.status === 403) {
        throw new LLMAuthenticationError(
          'Gemini authentication failed.'
        );
      }

      if (error?.status === 429) {
        throw new LLMProviderUnavailableError(
          'Gemini rate limit reached.'
        );
      }

      throw new LLMProviderUnavailableError(
        'Gemini request failed.',
        { cause: error?.message }
      );
    }
  }
}

module.exports = GeminiProvider;