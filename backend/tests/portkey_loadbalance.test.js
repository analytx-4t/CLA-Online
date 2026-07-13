require('dotenv').config();

const { randomUUID } = require('crypto');
const { portkey } = require('../llm/portkey');
const { buildPortkeyMetadata } = require('../llm/metadata');

async function runLoadBalanceDemo() {
  const traceId = randomUUID();
  console.log('Testing Portkey Retry + Load Balancing...');
  console.log('Trace ID:', traceId);

  const configId = 'pc-cla-le-e42e61';

  const message = [{ role: 'user', content: 'Reply exactly: Load balancing request successful' }];

  const metadata = buildPortkeyMetadata({
    session_id: 'loadbalance-test-001',
    query_type: 'loadbalance-test',
    rag_stage: 'final-generation',
    routing_mode: 'loadbalance',
  });

  const options = {
    config: configId,
    traceId,
    metadata,
  };

  const counts = {};
  let total = 0;

  function recordModel(modelStr) {
    const name = modelStr ? String(modelStr).split('/').pop() : 'unknown';
    counts[name] = (counts[name] || 0) + 1;
    total += 1;
  }

  function extractModel(resp) {
    if (!resp) return null;
    if (typeof resp.model === 'string') return resp.model.split('/').pop();
    if (resp?.choices && resp.choices[0]?.model) return String(resp.choices[0].model).split('/').pop();
    if (resp?.provider) return resp.provider;
    return null;
  }

  for (let i = 1; i <= 20; i++) {
    try {
      console.log(`Request ${i}`);

      const resp = await portkey.chat.completions.create(
        {
          model: 'llama-3.3-70b-versatile',
          messages: message,
          temperature: 0,
        },
        options
      );

      const content = resp?.choices?.[0]?.message?.content || resp?.content || JSON.stringify(resp);
      const model = extractModel(resp) || 'unknown';

      console.log('Response:', content);
      console.log('Model:', model);

      recordModel(model);
    } catch (err) {
      console.error(`Request ${i} failed:`, err?.message || err);
      recordModel('failed');
    }
  }

  console.log('\nLoad balancing summary:');
  Object.keys(counts).forEach((k) => {
    console.log(`${k}: ${counts[k]} requests`);
  });
  console.log('Total requests:', total);
}

runLoadBalanceDemo();
