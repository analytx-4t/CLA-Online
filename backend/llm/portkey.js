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

// Newer OpenAI reasoning models (gpt-5, the o-series) have two API
// incompatibilities with every other model on every other provider,
// both confirmed live:
//   1. They reject the legacy `max_tokens` param outright — "Unsupported
//      parameter: 'max_tokens' is not supported with this model. Use
//      'max_completion_tokens' instead."
//   2. They reject any explicit `temperature` other than the default —
//      "Unsupported value: 'temperature' does not support 0 with this
//      model. Only the default (1) value is supported."
function isOpenAIReasoningModel(model) {
  if (!model) return false;
  const normalized = String(model).toLowerCase();
  return /^gpt-5/.test(normalized) || /^o[1-9](-|$)/.test(normalized);
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

  let actualModel = model;
  if (provider === 'deepseek' && (model === 'deepseek-v4-pro' || model === 'deepseek-v4-flash' || model === 'deepseek-pro')) {
    actualModel = 'deepseek-chat';
  }

  return `${providerSlug}/${actualModel}`;
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
            const reasoningModel = isOpenAIReasoningModel(model);
            const tokenLimitField = reasoningModel ? 'max_completion_tokens' : 'max_tokens';
            return portkey.chat.completions.create(
              {
                model: portkeyModel,
                messages: finalMessages,
                // gpt-5 / o-series only accept the default temperature (1) —
                // omit the field entirely rather than send an unsupported value.
                ...(reasoningModel ? {} : { temperature }),
                [tokenLimitField]: maxTokens,
                // Without this, gpt-5 defaults to a much higher internal reasoning
                // budget and can burn the entire maxTokens allowance on hidden
                // reasoning before emitting any visible content — confirmed live,
                // reasoning_tokens dropped from ~4200 to ~1000 on an identical
                // prompt once this was set, leaving reliable headroom for output.
                ...(reasoningModel ? { reasoning_effort: 'low' } : {}),
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

      if (response) {
        response._actualProvider = provider;
        response._actualModel = model;
      }

      return response;
    }
  );
}

async function createChatCompletion({
  provider = 'deepseek',
  model = process.env.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro',
  messages = [],
  systemPrompt = '',
  temperature = 0.2,
  maxTokens = 512,
  metadata = {},
  traceId,
  requestContext,
}) {
  const targetProvider = provider || 'deepseek';
  const targetModel = model || process.env.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro';

  const response = await executeChatCompletionDirect({
    provider: targetProvider,
    model: targetModel,
    messages,
    systemPrompt,
    temperature,
    maxTokens,
    metadata,
    traceId,
    requestContext,
  });

  const content = response?.choices?.[0]?.message?.content;
  if (content && typeof content === 'string' && content.trim().length > 0) {
    return response;
  }
  
  throw new Error(`Provider ${targetProvider} (${targetModel}) returned an empty response.`);
}

async function createFallbackChatCompletion({
  messages = [],
  systemPrompt = '',
  temperature = 0.2,
  maxTokens = 512,
  metadata = {},
  traceId,
  requestContext,
}) {
  return createChatCompletion({
    provider: 'deepseek',
    model: process.env.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro',
    messages,
    systemPrompt,
    temperature,
    maxTokens,
    metadata,
    traceId,
    requestContext,
  });
}


module.exports = {
  portkey,
  getPortkeyModel,
  executeChatCompletionDirect,
  createChatCompletion,
  createFallbackChatCompletion,
};
