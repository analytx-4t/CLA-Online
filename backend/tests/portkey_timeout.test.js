require('dotenv').config();

const { randomUUID } = require('crypto');
const { portkey, getPortkeyModel } = require('../llm/portkey');

async function testTimeout() {
  console.log('Testing Portkey request timeout...');

  const traceId = randomUUID();
  console.log('Trace ID:', traceId);

  const configId = process.env.PORTKEY_TIMEOUT_CONFIG_ID;
  if (!configId) {
    console.error('Environment variable PORTKEY_TIMEOUT_CONFIG_ID is not set.');
    process.exitCode = 1;
    return;
  }

  try {
    // Use a normal model; the Portkey config should enforce a request timeout
    const model = getPortkeyModel('groq', 'llama-3.3-70b-versatile');

    const response = await portkey.chat.completions.create(
      {
        model,
        messages: [
          {
            role: 'user',
            content: 'Reply exactly: Portkey timeout demonstration',
          },
        ],
        temperature: 0,
        max_tokens: 50,
      },
      {
        config: configId,
        traceId,
        metadata: {
          session_id: 'timeout-test-001',
          query_type: 'timeout-test',
          rag_stage: 'final-generation',
          routing_mode: 'timeout',
        },
      }
    );

    // If request succeeds unexpectedly, print response and fail
    console.error('Unexpected success for timeout demo:', response);
    process.exitCode = 1;
  } catch (error) {
    console.log('Request timed out as expected');

    const status = error?.status || error?.response?.status || error?.statusCode || null;
    const message = error?.message || error?.response?.data?.message || null;
    const pkTrace = error?.traceId || error?.response?.data?.traceId || traceId;

    if (status) console.log('Error status:', status);
    if (message) console.log('Error message:', message);
    if (pkTrace) console.log('Portkey trace ID:', pkTrace);

    process.exitCode = 0;
  }
}

testTimeout();
