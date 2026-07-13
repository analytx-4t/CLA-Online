require('dotenv').config();

const { randomUUID } = require('crypto');
const { getLLMProvider } = require('../llm/factory');

async function testPortkeyMetadata() {
  try {
    const provider = getLLMProvider(
      'groq',
      'llama-3.3-70b-versatile'
    );

    const traceId = randomUUID();

    console.log('Trace ID:', traceId);
    console.log('Testing Groq through Portkey...');

    const response = await provider.generate({
      messages: [
        {
          role: 'user',
          content: 'Reply exactly: Legal RAG metadata test successful',
        },
      ],

      temperature: 0,
      maxTokens: 50,

      traceId,

      metadata: {
        session_id: 'test-session-001',
        query_type: 'legal-rag-test',
        rag_stage: 'final-generation',
        jurisdiction: 'india',
        retrieval_strategy: 'hybrid',
        retrieved_chunk_count: 8,
        cache_status: 'miss',
      },
    });

    console.log('Response:', response.content);
    console.log('Provider:', response.provider);
    console.log('Model:', response.model);
    console.log('Usage:', response.usage);
  } catch (error) {
    console.error('Portkey metadata test failed:');
    console.error(error);
    process.exitCode = 1;
  }
}

testPortkeyMetadata();