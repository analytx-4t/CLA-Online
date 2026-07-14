const Portkey = require('portkey-ai').default;
const { buildPortkeyMetadata } = require('./metadata');

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

async function executeChatCompletionDirect({
  provider,
  model,
  messages = [],
  systemPrompt = '',
  temperature = 0.2,
  maxTokens = 512,
  metadata = {},
  traceId,
}) {
  const portkeyModel = getPortkeyModel(provider, model);

  const finalMessages = [
    ...(systemPrompt
      ? [{ role: 'system', content: systemPrompt }]
      : []),
    ...messages,
  ];

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
  try {
    return await executeChatCompletionDirect({
      provider,
      model,
      messages,
      systemPrompt,
      temperature,
      maxTokens,
      metadata,
      traceId,
    });
  } catch (error) {
    console.warn(`Primary provider ${provider} failed: ${error.message || error}. Initiating fallback chain...`);

    const fallbackChain = [
      { provider: 'groq', model: process.env.GROQ_LLAMA_MODEL || 'llama-3.3-70b-versatile' },
      { provider: 'deepseek', model: process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash' },
      { provider: 'gemini', model: process.env.GEMINI_MODEL || 'gemini-3.5-flash' },
    ];

    const remainingFallbacks = fallbackChain.filter(f => f.provider !== provider);

    for (const fallback of remainingFallbacks) {
      if (!providerSlugs[fallback.provider]) {
        continue;
      }
      try {
        console.log(`Attempting fallback to ${fallback.provider} (${fallback.model})...`);
        const response = await executeChatCompletionDirect({
          provider: fallback.provider,
          model: fallback.model,
          messages,
          systemPrompt,
          temperature,
          maxTokens,
          metadata,
          traceId,
        });
        console.log(`Fallback to ${fallback.provider} successful.`);
        return response;
      } catch (fallbackError) {
        console.warn(`Fallback to ${fallback.provider} failed: ${fallbackError.message || fallbackError}`);
      }
    }

    throw error;
  }
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
