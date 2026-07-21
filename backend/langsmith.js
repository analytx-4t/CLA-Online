const { traceable } = require('langsmith/traceable');

const tracePortkeyLLMCall = traceable(
  async function ({
    provider,
    model,
    temperature,
    maxTokens,
    call,
    requestContext,
  }) {
    const response = await call();

    return {
      ...response,
      usage_metadata: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
      },
    };
  },
  {
    name: 'Portkey LLM Call',
    run_type: 'llm',
    metadata: {
      component: 'llm',
    },
    tags: ['legal-rag', 'portkey', 'llm'],
  }
);

const traceLLMGeneration = traceable(
  async function ({
    provider,
    model,
    messageCount,
    generate,
    requestContext,
  }) {
    return generate();
  },
  {
    name: 'LLM Generation',
    run_type: 'chain',
    metadata: {
      component: 'llm',
      system: 'cla-legal-rag',
    },
    tags: ['legal-rag', 'llm'],
  }
);

module.exports = {
  traceLLMGeneration,
  tracePortkeyLLMCall,
};