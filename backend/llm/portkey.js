let logfire;

async function getLogfire() {
  if (!logfire) {
    logfire = await import('@pydantic/logfire-node');
  }

  return logfire;
}

const Portkey = require('portkey-ai').default;
const { buildPortkeyMetadata } = require('./metadata');
const { tracePortkeyLLMCall } = require('../langsmith');

if (!process.env.PORTKEY_API_KEY) {
  throw new Error('PORTKEY_API_KEY is not configured.');
}

const portkey = new Portkey({
  apiKey: process.env.PORTKEY_API_KEY,
});

const providerSlugs = {
  openai: process.env.PORTKEY_OPENAI_PROVIDER,
  groq: process.env.PORTKEY_GROQ_PROVIDER,
  deepseek: process.env.PORTKEY_DEEPSEEK_PROVIDER,
  gemini: process.env.PORTKEY_GEMINI_PROVIDER,
};

function getPortkeyModel(provider, model) {
  const providerSlug = providerSlugs[provider];

  if (!providerSlug) {
    throw new Error(
      `Portkey provider is not configured: ${provider}`
    );
  }

  if (!model) {
    throw new Error(
      `Model is not configured for provider: ${provider}`
    );
  }

  return `${providerSlug}/${model}`;
}

async function createChatCompletion({
  provider,
  model,
  messages = [],
  systemPrompt = '',
  temperature = 0.2,
  maxTokens = 512,
  metadata = {},
  traceId,
}) {
  const lf = await getLogfire();
  const portkeyModel = getPortkeyModel(provider, model);

  const finalMessages = [
    ...(systemPrompt
      ? [{ role: 'system', content: systemPrompt }]
      : []),
    ...messages,
  ];

  return lf.span(
    'Portkey completion',
    {
      provider,
      model,
      portkey_model: portkeyModel,
      routing_mode: 'direct',
      message_count: messages.length,
      has_system_prompt: Boolean(systemPrompt),
      max_tokens: maxTokens,
    },
    {},
    async () => {
      const response = await tracePortkeyLLMCall({
        provider,
        model,
        temperature,
        maxTokens,

        call: async () => {
          return portkey.chat.completions.create(
            {
              model: portkeyModel,
              messages: finalMessages,
              temperature,
              max_tokens: maxTokens,
            },
            {
              ...(traceId ? { traceId } : {}),
              metadata: buildPortkeyMetadata(metadata),
            }
          );
        },
      });

      lf.info('Portkey completion succeeded', {
        provider,
        model,
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
      });

      return response;
    }
  );
}

async function createFallbackChatCompletion({
  messages = [],
  systemPrompt = '',
  temperature = 0.2,
  maxTokens = 512,
  metadata = {},
  traceId,
  configId = process.env.PORTKEY_CONFIG_ID,
}) {
  if (!configId) {
    throw new Error('Portkey Config ID is not configured.');
  }

  const finalMessages = [
    ...(systemPrompt
      ? [{ role: 'system', content: systemPrompt }]
      : []),
    ...messages,
  ];

  return portkey.chat.completions.create(
    {
      model: 'llama-3.3-70b-versatile',
      messages: finalMessages,
      temperature,
      max_tokens: maxTokens,
    },
    {
      config: configId,
      ...(traceId ? { traceId } : {}),
      metadata: buildPortkeyMetadata({
        ...metadata,
        routing_mode: 'fallback',
      }),
    }
  );
}

module.exports = {
  portkey,
  getPortkeyModel,
  createChatCompletion,
  createFallbackChatCompletion,
};
