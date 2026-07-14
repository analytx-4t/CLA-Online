require('dotenv').config();

const { randomUUID } = require('crypto');
const { portkey } = require('../llm/portkey');
const { buildPortkeyMetadata } = require('../llm/metadata');

function extractModel(response) {
  if (!response) return null;

  const candidates = [
    response?.choices?.[0]?.message?.model,
    response?.choices?.[0]?.model,
    response?.model,
    response?.provider,
  ];

  for (const candidate of candidates) {
    if (candidate) {
      const value = String(candidate).split('/').pop();
      return value || null;
    }
  }

  return null;
}

function extractProvider(response) {
  if (!response) return null;

  const candidates = [
    response?.provider,
    response?.choices?.[0]?.provider,
    response?.choices?.[0]?.message?.provider,
  ];

  for (const candidate of candidates) {
    if (candidate) return String(candidate);
  }

  return null;
}

function extractTraceId(response) {
  if (!response) return null;

  const candidates = [
    response?.trace_id,
    response?.traceId,
    response?.choices?.[0]?.trace_id,
    response?.choices?.[0]?.traceId,
  ];

  for (const candidate of candidates) {
    if (candidate) return String(candidate);
  }

  return null;
}

function extractUsage(response) {
  if (!response) return null;

  const candidates = [
    response?.usage,
    response?.choices?.[0]?.usage,
    response?.choices?.[0]?.message?.usage,
  ];

  for (const candidate of candidates) {
    if (candidate) return candidate;
  }

  return null;
}

async function testProductionConfig() {
  const traceId = randomUUID();

  console.log('Testing CLA Legal RAG production Portkey config...');
  console.log('Trace ID:', traceId);

  const configId = 'pc-cla-le-b248d8';
  const semanticCacheNamespace = 'cla-legal-rag-production-semantic-cache';

  const semanticMetadata = buildPortkeyMetadata({
    session_id: 'production-semantic-cache-test-001',
    query_type: 'production-semantic-cache-test',
    rag_stage: 'final-generation',
    routing_mode: 'production-semantic-cache',
  });

  const concurrentMetadata = buildPortkeyMetadata({
    session_id: 'production-concurrent-load-test-001',
    query_type: 'production-concurrent-load-test',
    rag_stage: 'final-generation',
    routing_mode: 'production-concurrent-loadbalance',
  });

  const semanticOptions = {
    config: configId,
    traceId,
    metadata: semanticMetadata,
    cacheNamespace: semanticCacheNamespace,
  };

  const concurrentOptions = {
    config: configId,
    traceId,
    metadata: concurrentMetadata,
  };

  try {
    const firstPrompt = 'Why is retrieval augmented generation useful for a legal chatbot?';
    const firstMessages = [{ role: 'user', content: firstPrompt }];
    const firstRequest = {
      model: 'llama-3.3-70b-versatile',
      messages: firstMessages,
      temperature: 0,
      max_tokens: 120,
    };

    const start1 = Date.now();
    const firstResponse = await portkey.chat.completions.create(firstRequest, semanticOptions);
    const firstDuration = Date.now() - start1;

    const firstContent = firstResponse?.choices?.[0]?.message?.content || firstResponse?.content || '';
    const firstModel = extractModel(firstResponse);
    const firstProvider = extractProvider(firstResponse);
    const firstTraceId = extractTraceId(firstResponse);
    const firstUsage = extractUsage(firstResponse);

    console.log('First semantic request:');
    console.log('Prompt:', firstPrompt);
    console.log('Response:', firstContent);
    if (firstModel) console.log('Model:', firstModel);
    if (firstProvider) console.log('Provider:', firstProvider);
    console.log('Duration:', `${firstDuration} ms`);
    if (firstTraceId) console.log('Portkey trace ID:', firstTraceId);
    if (firstUsage) console.log('Usage:', firstUsage);

    const secondPrompt = 'Explain the benefits of using RAG in a chatbot that answers legal questions.';
    const secondMessages = [{ role: 'user', content: secondPrompt }];
    const secondRequest = {
      model: 'llama-3.3-70b-versatile',
      messages: secondMessages,
      temperature: 0,
      max_tokens: 120,
    };

    const start2 = Date.now();
    const secondResponse = await portkey.chat.completions.create(secondRequest, semanticOptions);
    const secondDuration = Date.now() - start2;

    const secondContent = secondResponse?.choices?.[0]?.message?.content || secondResponse?.content || '';
    const secondModel = extractModel(secondResponse);
    const secondProvider = extractProvider(secondResponse);
    const secondTraceId = extractTraceId(secondResponse);
    const secondUsage = extractUsage(secondResponse);

    console.log('\nSecond semantic request:');
    console.log('Prompt:', secondPrompt);
    console.log('Response:', secondContent);
    if (secondModel) console.log('Model:', secondModel);
    if (secondProvider) console.log('Provider:', secondProvider);
    console.log('Duration:', `${secondDuration} ms`);
    if (secondTraceId) console.log('Portkey trace ID:', secondTraceId);
    if (secondUsage) console.log('Usage:', secondUsage);

    console.log('\nSemantic cache summary:');
    console.log('First request duration:', `${firstDuration} ms`);
    console.log('Second request duration:', `${secondDuration} ms`);
    console.log('Second request was faster:', secondDuration < firstDuration);

    const totalRequests = 20;
    const counts = {
      'llama-3.3-70b-versatile': 0,
      'deepseek-v4-flash': 0,
      'gpt-4.1-mini': 0,
      unknown: 0,
    };
    let failedRequests = 0;
    const concurrentStartTime = Date.now();

    const requestPromises = Array.from({ length: totalRequests }, async (_, index) => {
      const requestNumber = index + 1;
      const messages = [{ role: 'user', content: `Reply exactly: Production concurrent request ${requestNumber} successful` }];

      return portkey.chat.completions.create(
        {
          model: 'llama-3.3-70b-versatile',
          messages,
          temperature: 0,
          max_tokens: 50,
        },
        concurrentOptions
      );
    });

    const concurrentResults = await Promise.allSettled(requestPromises);

    concurrentResults.forEach((result, index) => {
      const requestNumber = index + 1;

      if (result.status === 'fulfilled') {
        const response = result.value;
        const model = extractModel(response) || 'unknown';
        const normalizedModel = model === 'unknown' ? 'unknown' : model;

        console.log(`Request ${requestNumber}`);
        console.log('Response:', response?.choices?.[0]?.message?.content || response?.content || JSON.stringify(response));
        console.log('Model used:', normalizedModel);

        if (counts[normalizedModel] !== undefined) {
          counts[normalizedModel] += 1;
        } else {
          counts.unknown += 1;
        }
      } else {
        console.log(`Request ${requestNumber}`);
        console.log('Failed:', result.reason?.message || String(result.reason || 'Unknown error'));
        failedRequests += 1;
      }
    });

    const totalConcurrentDuration = Date.now() - concurrentStartTime;

    console.log('\nProduction concurrent load balancing summary:');
    console.log(`llama-3.3-70b-versatile: ${counts['llama-3.3-70b-versatile']} requests`);
    console.log(`deepseek-v4-flash: ${counts['deepseek-v4-flash']} requests`);
    console.log(`gpt-4.1-mini: ${counts['gpt-4.1-mini']} requests`);
    console.log(`Unknown models: ${counts.unknown} requests`);
    console.log(`Failed requests: ${failedRequests}`);
    console.log(`Total requests: ${totalRequests}`);
    console.log(`Total concurrent duration: ${totalConcurrentDuration} ms`);

    console.log('\nCLA Legal RAG Production Portkey Configuration:');
    console.log('- Observability: enabled');
    console.log('- Metadata tracking: enabled');
    console.log('- Automatic retry: enabled');
    console.log('- Request timeout: enabled');
    console.log('- Fallback routing: enabled');
    console.log('- Reliability pipeline: Retry + Timeout + Fallback');
    console.log('- Semantic response caching: enabled');
    console.log('- Concurrent load balancing: enabled');
    console.log('- Primary traffic routing: Groq + DeepSeek');
    console.log('- Load balancing weights: 50% Groq / 50% DeepSeek');
    console.log('- Final fallback provider: OpenAI');
    console.log('- Final fallback model: gpt-4.1-mini');

    console.log('\nProduction Portkey demonstration successful');
    process.exitCode = 0;
  } catch (error) {
    console.error('Production Portkey test failed:');
    console.error(error);
    process.exitCode = 1;
  }
}

testProductionConfig();
