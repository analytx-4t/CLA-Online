require('dotenv').config();

const { randomUUID } = require('crypto');
const { portkey } = require('../llm/portkey');

async function testCache() {
  console.log('Testing Portkey response caching...');

  const traceId = randomUUID();
  console.log('Trace ID:', traceId);

  const configId = process.env.PORTKEY_CACHE_CONFIG_ID;
  if (!configId) {
    console.error('Environment variable PORTKEY_CACHE_CONFIG_ID is not set.');
    process.exitCode = 1;
    return;
  }

  const model = 'llama-3.3-70b-versatile';
  const messages = [
    {
      role: 'user',
      content: 'Reply exactly: Legal RAG cache demonstration successful',
    },
  ];

  const options = {
    config: configId,
    traceId,
    metadata: {
      session_id: 'cache-test-001',
      query_type: 'cache-test',
      rag_stage: 'final-generation',
      routing_mode: 'cache',
    },
    cacheNamespace: 'cla-legal-rag-cache-demo',
  };

  try {
    const start1 = Date.now();
    const res1 = await portkey.chat.completions.create(
      {
        model,
        messages,
        temperature: 0,
        max_tokens: 50,
      },
      options
    );
    const dur1 = Date.now() - start1;

    const firstContent = res1?.choices?.[0]?.message?.content || res1?.content || res1;

    console.log('First request response:', firstContent);
    console.log('First request duration:', dur1, 'ms');

    // Send the exact same request again (same body, same options)
    const start2 = Date.now();
    const res2 = await portkey.chat.completions.create(
      {
        model,
        messages,
        temperature: 0,
        max_tokens: 50,
      },
      options
    );
    const dur2 = Date.now() - start2;

    const secondContent = res2?.choices?.[0]?.message?.content || res2?.content || res2;

    console.log('Second request response:', secondContent);
    console.log('Second request duration:', dur2, 'ms');

    console.log('Cache demonstration completed');
    process.exitCode = 0;
  } catch (error) {
    console.error('Cache demo failed:');
    console.error(error);
    process.exitCode = 1;
  }
}

testCache();
