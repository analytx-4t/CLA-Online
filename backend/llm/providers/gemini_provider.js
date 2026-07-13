const { BaseLLMProvider, LLMConfigurationError, LLMAuthenticationError, LLMProviderUnavailableError } = require('../base');
const { settings, getProviderConfig } = require('../../config');

class GeminiProvider extends BaseLLMProvider {
  constructor({ model } = {}) {
    super({ providerName: 'gemini', defaultModel: model || settings.GEMINI_MODEL || '' });
    this.config = getProviderConfig('gemini');
    this.model = model || this.config.model || this.defaultModel;
  }

  async generate(request = {}) {
    if (!this.config.apiKey) {
      throw new LLMConfigurationError('Gemini API key is not configured.');
    }
    if (!this.model) {
      throw new LLMConfigurationError('Gemini model is not configured. Set GEMINI_MODEL in the backend environment.');
    }

    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const client = new GoogleGenerativeAI(this.config.apiKey);
      const modelInstance = client.getGenerativeModel({ model: this.model });
      const prompt = request.messages?.map((m) => `${m.role || 'user'}: ${m.content || ''}`).join('\n') || '';
      const result = await modelInstance.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${request.systemPrompt ? request.systemPrompt + '\n\n' : ''}${prompt}` }] }],
      });
      const responseText = result.response?.text?.() || '';
      return {
        content: responseText,
        provider: 'gemini',
        model: this.model,
        usage: {
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
        },
      };
    } catch (error) {
      if (error?.status === 401) {
        throw new LLMAuthenticationError('Gemini authentication failed.');
      }
      if (error?.status === 429) {
        throw new LLMProviderUnavailableError('Gemini rate limit reached.');
      }
      throw new LLMProviderUnavailableError('Gemini request failed.', { cause: error.message });
    }
  }
}

module.exports = GeminiProvider;
