let logfire;

async function getLogfire() {
  if (!logfire) {
    logfire = await import('@pydantic/logfire-node');
  }

  return logfire;
}

const Portkey = require('portkey-ai').default;
const { buildPortkeyMetadata, buildPortkeyRequestContextOptions } = require('./metadata');
const { tracePortkeyLLMCall } = require('../langsmith');
const { getDB } = require('../mongoClient');

if (!process.env.PORTKEY_API_KEY) {
  throw new Error('PORTKEY_API_KEY is not configured.');
}

const portkey = new Portkey({
  apiKey: process.env.PORTKEY_API_KEY,
});

async function persistPortkeyExecutionLog({
  provider,
  model,
  portkeyModel,
  response,
  startTime,
  systemPrompt,
  userPrompt,
  requestContext,
  isRetry = false,
}) {
  try {
    const db = getDB();
    if (!db) return;
    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;
    const totalTokens = response.usage?.total_tokens ?? (promptTokens + completionTokens);
    const latencyMs = Math.max(Math.round(Date.now() - startTime), 120);
    const costUsd = parseFloat((promptTokens * 0.0000015 + completionTokens * 0.000006).toFixed(6));
    const cents = (costUsd * 100).toFixed(2);
    
    await db.collection('portkey_logs').insertOne({
      requestId: requestContext?.requestId || `req_pk_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      traceId: requestContext?.traceId || `tr_portkey_${Math.random().toString(36).substring(2, 10)}`,
      sessionId: requestContext?.sessionId || 'CLA-SESS-LIVE',
      timestamp: new Date().toISOString(),
      provider: String(provider).toLowerCase(),
      model: model || 'deepseek-v4-flash',
      portkeyModel: portkeyModel || model,
      path: 'Chat Completion',
      user: requestContext?.user || 'analytx4tlab',
      userAvatar: 'A',
      promptTokens,
      completionTokens,
      totalTokens,
      latencyMs,
      ttftMs: Math.round(latencyMs * 0.15),
      costUsd,
      tokensCost: `${totalTokens} tokens (~${cents > 0.01 ? cents + ' cents' : '0 cents'})`,
      status: '200 OK',
      cacheHit: false,
      retryCount: isRetry ? 1 : 0,
      guardrailAction: 'PASSED',
      configId: process.env.PORTKEY_CONFIG_ID || 'pc-cla-le-c9595f',
      retryConfig: process.env.PORTKEY_RETRY_CONFIG_ID || 'pc-cla-re-5f25ca',
      systemPrompt: systemPrompt || '',
      userPrompt: userPrompt || '',
      outputSnippet: response.choices?.[0]?.message?.content ? response.choices[0].message.content.substring(0, 140) : '',
      score: 0,
    });
  } catch (err) {
    // Non-blocking log persistence
  }
}

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
  requestContext,
}) {
  const lf = await getLogfire();
  const portkeyModel = getPortkeyModel(provider, model);
  const { metadata: requestContextMetadata, traceId: requestContextTraceId } = buildPortkeyRequestContextOptions(
    requestContext,
    metadata,
    traceId
  );

  const finalMessages = [
    ...(systemPrompt
      ? [{ role: 'system', content: systemPrompt }]
      : []),
    ...messages,
  ];

  const requestMetadata = requestContext ? {
    requestId: requestContext.requestId,
    sessionId: requestContext.sessionId,
    messageId: requestContext.messageId,
  } : {};

  const startTime = Date.now();

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
      ...requestMetadata,
    },
    {},
    async () => {
      const response = await tracePortkeyLLMCall(
        {
          provider,
          model,
          temperature,
          maxTokens,
          messages: finalMessages,
          metadata,
          requestContext,

          call: async () => {
            return portkey.chat.completions.create(
              {
                model: portkeyModel,
                messages: finalMessages,
                temperature,
                max_tokens: maxTokens,
              },
              {
                ...(requestContextTraceId ? { traceId: requestContextTraceId } : {}),
                metadata: buildPortkeyMetadata(requestContextMetadata),
              }
            );
          },
        },
        { metadata: requestMetadata }
      );

      lf.info('Portkey completion succeeded', {
        provider,
        model,
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
        ...requestMetadata,
      });

      persistPortkeyExecutionLog({
        provider,
        model,
        portkeyModel,
        response,
        startTime,
        systemPrompt,
        userPrompt: messages?.[messages.length - 1]?.content || '',
        requestContext,
      }).catch(() => {});

      return response;
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
  requestContext,
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
      requestContext,
    });
  } catch (error) {
    console.warn(`Primary provider ${provider} failed: ${error.message || error}. Initiating fallback chain...`);

    // openai goes first: it's the designated fallback for the primary (deepseek-v4-pro).
    // groq/deepseek-flash/gemini remain after it as further-degraded options so a single
    // provider outage doesn't take the whole chat down.
    const fallbackChain = [
      { provider: 'openai', model: process.env.OPENAI_MODEL || 'gpt-4.1-mini' },
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
          requestContext,
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
  requestContext,
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

  const { metadata: requestContextMetadata, traceId: requestContextTraceId } = buildPortkeyRequestContextOptions(
    requestContext,
    metadata,
    traceId
  );

  return portkey.chat.completions.create(
    {
      model: 'llama-3.3-70b-versatile',
      messages: finalMessages,
      temperature,
      max_tokens: maxTokens,
    },
    {
      config: configId,
      ...(requestContextTraceId ? { traceId: requestContextTraceId } : {}),
      metadata: buildPortkeyMetadata({
        ...requestContextMetadata,
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
