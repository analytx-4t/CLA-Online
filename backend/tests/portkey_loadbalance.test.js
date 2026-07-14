require('dotenv').config();

const { randomUUID } = require('crypto');
const { portkey } = require('../llm/portkey');
const { buildPortkeyMetadata } = require('../llm/metadata');

async function runLoadBalanceDemo() {
  const traceId = randomUUID();
  console.log('Testing Portkey concurrent load balancing...');
  console.log('Trace ID:', traceId);

  const configId = 'pc-cla-le-e42e61';

  const metadata = buildPortkeyMetadata({
    session_id: 'concurrent-loadbalance-test-001',
    query_type: 'concurrent-loadbalance-test',
    rag_stage: 'final-generation',
    routing_mode: 'concurrent-loadbalance',
  });

  const options = {
    config: configId,
    traceId,
    metadata,
  };

  const counts = {
    'llama-3.3-70b-versatile': 0,
    'deepseek-v4-flash': 0,
  };
  let failedRequests = 0;
  const totalRequests = 20;
  const startTime = Date.now();

  function extractModel(resp) {
    if (!resp) return null;
    if (typeof resp.model === 'string') return resp.model.split('/').pop();
    if (resp?.choices && resp.choices[0]?.model) return String(resp.choices[0].model).split('/').pop();
    if (resp?.provider) return resp.provider;
    return null;
  }

  function recordModel(modelStr) {
    const name = modelStr ? String(modelStr).split('/').pop() : 'unknown';
    if (counts[name] !== undefined) {
      counts[name] += 1;
    }
  }

  const requestPromises = Array.from({ length: totalRequests }, async (_, index) => {
    const requestNumber = index + 1;
    const messages = [{ role: 'user', content: `Reply exactly: Concurrent load balancing request ${requestNumber} successful` }];

    return portkey.chat.completions.create(
      {
        model: 'llama-3.3-70b-versatile',
        messages,
        temperature: 0,
        max_tokens: 50,
      },
      options
    );
  });

  const results = await Promise.allSettled(requestPromises);

  results.forEach((result, index) => {
    const requestNumber = index + 1;

    if (result.status === 'fulfilled') {
      const resp = result.value;
      const content = resp?.choices?.[0]?.message?.content || resp?.content || JSON.stringify(resp);
      const model = extractModel(resp) || 'unknown';

      console.log(`Request ${requestNumber}`);
      console.log('Response:', content);
      console.log('Model:', model);

      recordModel(model);
    } else {
      const errorMessage = result.reason?.message || String(result.reason || 'Unknown error');
      console.log(`Request ${requestNumber}`);
      console.log('Failed:', errorMessage);
      failedRequests += 1;
    }
  });

  console.log('\nConcurrent load balancing summary:');
  console.log(`llama-3.3-70b-versatile: ${counts['llama-3.3-70b-versatile']} requests`);
  console.log(`deepseek-v4-flash: ${counts['deepseek-v4-flash']} requests`);
  console.log(`Failed requests: ${failedRequests}`);
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Total concurrent duration: ${Date.now() - startTime} ms`);

  if (counts['llama-3.3-70b-versatile'] > 0 && counts['deepseek-v4-flash'] > 0) {
    console.log('Concurrent load balancing demonstration successful');
  } else {
    console.log('Concurrent test completed but both load balancing targets were not observed. Run the test again.');
  }
}

runLoadBalanceDemo();
