const {
  BaseLLMProvider,
  LLMConfigurationError,
  LLMAuthenticationError,
  LLMProviderUnavailableError,
} = require('../base');

const { settings } = require('../../config');
const { createChatCompletion, executeResponseDirect } = require('../portkey');

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
        provider: response._actualProvider || 'openai',
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

  /**
   * One turn on the OpenAI Responses API (reasoning plus function tools; see
   * executeResponseDirect). Returns the answer text, the function calls the model asked for and
   * every output item, which the caller passes back as input on the next turn.
   */
  async respond(request = {}) {
    const {
      systemPrompt = '',
      input = [],
      tools,
      toolChoice,
      reasoningEffort,
      maxTokens = 4000,
      modelOverride,
      metadata = {},
      traceId,
      requestContext,
    } = request;

    const model = modelOverride || this.model;
    if (!model) {
      throw new LLMConfigurationError('OpenAI model is not configured.');
    }

    let response;
    try {
      response = await executeResponseDirect({
        provider: 'openai',
        model,
        instructions: systemPrompt,
        input,
        tools,
        toolChoice,
        reasoningEffort,
        maxOutputTokens: maxTokens,
        metadata,
        traceId,
        requestContext,
      });
    } catch (error) {
      if (error?.status === 401) {
        throw new LLMAuthenticationError('Portkey or OpenAI authentication failed.');
      }
      if (error?.status === 429) {
        throw new LLMProviderUnavailableError('OpenAI quota or rate limit reached.');
      }
      throw new LLMProviderUnavailableError(
        `OpenAI Responses request through Portkey failed: ${error.message}`,
        { cause: error.message }
      );
    }

    const output = Array.isArray(response?.output) ? response.output : [];
    const content = output
      .filter((item) => item.type === 'message')
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join('');
    const incompleteReason = response?.incomplete_details?.reason || null;

    return {
      content,
      toolCalls: output
        .filter((item) => item.type === 'function_call')
        .map((item) => ({ callId: item.call_id, name: item.name, arguments: item.arguments })),
      outputItems: output,
      // "length" when the answer was cut off at max_output_tokens, as on chat completions.
      finishReason: response?.status === 'incomplete'
        ? (incompleteReason === 'max_output_tokens' ? 'length' : (incompleteReason || 'incomplete'))
        : (response?.status || null),
      provider: 'openai',
      model: response?.model || model,
      usage: {
        input_tokens: response?.usage?.input_tokens ?? null,
        output_tokens: response?.usage?.output_tokens ?? null,
        total_tokens: response?.usage?.total_tokens ?? null,
        reasoning_tokens: response?.usage?.output_tokens_details?.reasoning_tokens ?? null,
      },
    };
  }
}

module.exports = OpenAIProvider;
