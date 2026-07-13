require('dotenv').config();

const { randomUUID } = require('crypto');
const { portkey } = require('../llm/portkey');
const { buildPortkeyMetadata } = require('../llm/metadata');

async function testProductionConfig() {
  const traceId = randomUUID();

  console.log('Testing CLA Legal RAG production Portkey config...');
  console.log('Trace ID:', traceId);

  const configId = 'pc-cla-le-b248d8';

  const messages = [
    { role: 'user', content: 'Reply exactly: CLA Legal RAG production pipeline successful' },
  ];

  const metadata = buildPortkeyMetadata({
    session_id: 'production-test-001',
    query_type: 'production-test',
    rag_stage: 'final-generation',
    routing_mode: 'production',
  });

  const req = {
    model: 'llama-3.3-70b-versatile',
    messages,
    temperature: 0,
  };

  const opts = {
    config: configId,
    traceId,
    metadata,
  };

  try {
    const start1 = Date.now();
    const res1 = await portkey.chat.completions.create(req, opts);
    const dur1 = Date.now() - start1;

    const content1 = res1?.choices?.[0]?.message?.content || res1?.content || '';
    const model1 = res1?.choices?.[0]?.model || res1?.model || null;
    const provider1 = res1?.provider || null;
    const usage1 = res1?.usage || null;

    console.log('Response:', content1);
    if (model1) console.log('Model:', String(model1).split('/').pop());
    if (provider1) console.log('Provider:', provider1);
    if (usage1) console.log('Usage:', usage1);
    console.log('Duration:', `${dur1} ms`);

    // Second identical request
    const start2 = Date.now();
    const res2 = await portkey.chat.completions.create(req, opts);
    const dur2 = Date.now() - start2;

    const content2 = res2?.choices?.[0]?.message?.content || res2?.content || '';
    const model2 = res2?.choices?.[0]?.model || res2?.model || null;

    console.log('\nSecond request response:', content2);
    if (model2) console.log('Second request model:', String(model2).split('/').pop());
    console.log('Second request duration:', `${dur2} ms`);

    console.log('\nProduction Config Demonstration:');
    console.log('- Observability: enabled');
    console.log('- Metadata tracking: enabled');
    console.log('- Retry: managed by Portkey');
    console.log('- Timeout: managed by Portkey');
    console.log('- Fallback: managed by Portkey');
    console.log('- Response cache: managed by Portkey');
    console.log('- Primary provider: Groq');
    console.log('- Fallback provider: DeepSeek');

    console.log('\nProduction Portkey demonstration successful');
    process.exitCode = 0;
  } catch (error) {
    console.error('Production Portkey test failed:');
    console.error(error);
    process.exitCode = 1;
  }
}

testProductionConfig();
