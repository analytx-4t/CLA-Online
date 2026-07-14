require('dotenv').config();

const { randomUUID } = require('crypto');
const { portkey } = require('../llm/portkey');
const { buildPortkeyMetadata } = require('../llm/metadata');

async function testCache() {
  console.log('Testing Portkey semantic caching...');

  const traceId = randomUUID();
  console.log('Trace ID:', traceId);

  const configId = process.env.PORTKEY_CACHE_CONFIG_ID;
  if (!configId) {
    console.error('Environment variable PORTKEY_CACHE_CONFIG_ID is not set.');
    process.exitCode = 1;
    return;
  }

  const model = 'llama-3.3-70b-versatile';
  const temperature = 0;
  const maxTokens = 120;
  const cacheNamespace = 'cla-legal-rag-semantic-cache-demo';
  const sharedMetadata = buildPortkeyMetadata({
    session_id: 'semantic-cache-test-001',
    query_type: 'semantic-cache-test',
    rag_stage: 'final-generation',
    routing_mode: 'semantic-cache',
  });

  const commonOptions = {
    config: configId,
    traceId,
    metadata: sharedMetadata,
    cacheNamespace,
  };

  const prompts = [
    'Why is retrieval augmented generation useful for a legal chatbot?',
    'Explain the benefits of using RAG in a chatbot that answers legal questions.',
  ];

  try {
    const firstPrompt = prompts[0];
    const firstMessages = [{ role: 'user', content: firstPrompt }];

    const start1 = Date.now();
    const res1 = await portkey.chat.completions.create(
      {
        model,
        messages: firstMessages,
        temperature,
        max_tokens: maxTokens,
      },
      commonOptions
    );
    const dur1 = Date.now() - start1;

    const firstContent = res1?.choices?.[0]?.message?.content || res1?.content || res1;

    console.log('First semantic request:');
    console.log('Prompt:', firstPrompt);
    console.log('Response:', firstContent);
    console.log('Duration:', dur1, 'ms');

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const secondPrompt = prompts[1];
    const secondMessages = [{ role: 'user', content: secondPrompt }];

    const start2 = Date.now();
    const res2 = await portkey.chat.completions.create(
      {
        model,
        messages: secondMessages,
        temperature,
        max_tokens: maxTokens,
      },
      commonOptions
    );
    const dur2 = Date.now() - start2;

    const secondContent = res2?.choices?.[0]?.message?.content || res2?.content || res2;

    console.log('Second semantic request:');
    console.log('Prompt:', secondPrompt);
    console.log('Response:', secondContent);
    console.log('Duration:', dur2, 'ms');

    console.log('Semantic cache demonstration completed');
    process.exitCode = 0;
  } catch (error) {
    console.error('Semantic cache demo failed:');
    console.error(error);
    process.exitCode = 1;
  }
}

testCache();
