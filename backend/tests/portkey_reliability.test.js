require('dotenv').config();

const { randomUUID } = require('crypto');
const { portkey, getPortkeyModel } = require('../llm/portkey');

async function testReliability() {
  console.log('Testing Portkey Retry + Timeout + Fallback...');

  const traceId = randomUUID();
  console.log('Trace ID:', traceId);

  const configId = process.env.PORTKEY_RELIABILITY_CONFIG_ID;
  if (!configId) {
    console.error('Environment variable PORTKEY_RELIABILITY_CONFIG_ID is not set.');
    process.exitCode = 1;
    return;
  }

  try {
    const model = getPortkeyModel('groq', 'llama-3.3-70b-versatile');

    const response = await portkey.chat.completions.create(
      {
        model,
        messages: [
          {
            role: 'user',
            content: 'Reply exactly: Reliability pipeline successful',
          },
        ],
        temperature: 0,
        max_tokens: 150,
      },
      {
        config: configId,
        traceId,
        metadata: {
          session_id: 'reliability-test-001',
          query_type: 'reliability-test',
          rag_stage: 'final-generation',
          routing_mode: 'retry-timeout-fallback',
        },
      }
    );

    const finalContent =
      response?.choices?.[0]?.message?.content || response?.content || response;

    console.log('Final response:', finalContent);
    console.log('Retry + Timeout + Fallback pipeline successful');
    process.exitCode = 0;
  } catch (error) {
    console.error('Reliability demo failed:');
    console.error(error);
    process.exitCode = 1;
  }
}

testReliability();
