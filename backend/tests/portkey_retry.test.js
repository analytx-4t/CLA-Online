require('dotenv').config();

const { randomUUID } = require('crypto');
const { portkey, getPortkeyModel } = require('../llm/portkey');

async function testRetry() {
  console.log('Testing Portkey automatic retry...');

  const traceId = randomUUID();
  console.log('Trace ID:', traceId);

  const configId = process.env.PORTKEY_RETRY_CONFIG_ID;
  if (!configId) {
    console.error('Environment variable PORTKEY_RETRY_CONFIG_ID is not set.');
    process.exitCode = 1;
    return;
  }

  try {
    // Intentionally use an invalid model for the Groq provider so the first request fails
    const model = getPortkeyModel('groq', 'invalid-model-for-retry-demo');

    const response = await portkey.chat.completions.create(
      {
        model,
        messages: [
          {
            role: 'user',
            content: 'Reply exactly: Portkey retry demonstration',
          },
        ],
        temperature: 0,
        max_tokens: 50,
      },
      {
        config: configId,
        traceId,
        metadata: {
          session_id: 'retry-test-001',
          query_type: 'retry-test',
          rag_stage: 'final-generation',
          routing_mode: 'retry',
        },
      }
    );

    // If we get here, the request unexpectedly succeeded
    console.error('Unexpected success for retry demo:', response);
    process.exitCode = 1;
  } catch (error) {
    console.log('Retry attempts exhausted as expected');

    // Attempt to print useful diagnostic fields if available
    const status = error?.status || error?.response?.status || error?.statusCode || null;
    const pkTrace = error?.traceId || error?.response?.data?.traceId || traceId;
    const attempts = error?.attempts || error?.response?.data?.attempts || error?.retries || null;

    if (status) console.log('Error status:', status);
    if (pkTrace) console.log('Portkey trace ID:', pkTrace);
    if (attempts !== null) console.log('Retry attempt count:', attempts);
    else console.log('Retry attempt count not available in error object');

    // This demo is expected to exhaust retries; exit code 0 indicates demonstration success
    process.exitCode = 0;
  }
}

testRetry();
