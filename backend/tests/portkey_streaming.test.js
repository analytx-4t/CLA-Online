require('dotenv').config();

const { randomUUID } = require('crypto');
const { portkey } = require('../llm/portkey');
const { buildPortkeyMetadata } = require('../llm/metadata');

async function testStreaming() {
  const traceId = randomUUID();

  console.log('Testing Portkey streaming...');
  console.log('Trace ID:', traceId);

  try {
    const model = '@groq-production/llama-3.3-70b-versatile';

    const metadata = buildPortkeyMetadata({
      session_id: 'streaming-test-001',
      query_type: 'streaming-test',
      rag_stage: 'final-generation',
      routing_mode: 'streaming',
    });

    const req = {
      model,
      messages: [
        {
          role: 'user',
          content:
            'Explain in 3 short sentences why retrieval augmented generation is useful for a legal chatbot.',
        },
      ],
      temperature: 0,
      stream: true,
    };

    const opts = {
      traceId,
      metadata,
    };

    console.log('\nStreaming response:\n');

    const stream = await portkey.chat.completions.create(req, opts);

    let chunks = 0;
    let firstChunkTime = null;
    const start = Date.now();

    for await (const chunk of stream) {
      const content = chunk?.choices?.[0]?.delta?.content;
      if (content) {
        if (firstChunkTime === null) firstChunkTime = Date.now() - start;
        process.stdout.write(content);
        chunks += 1;
      }
    }

    const totalDuration = Date.now() - start;

    console.log('\n\nStreaming statistics:');
    console.log('Content chunks:', chunks);
    console.log('Time to first chunk:', firstChunkTime !== null ? `${firstChunkTime} ms` : 'no chunks');
    console.log('Total duration:', `${totalDuration} ms`);

    console.log('\nStreaming demonstration successful');
    process.exitCode = 0;
  } catch (error) {
    console.error('Streaming test failed:');
    console.error(error);
    process.exitCode = 1;
  }
}

testStreaming();
