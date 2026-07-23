const { traceable } = require('langsmith/traceable');

/**
 * Enhanced LangSmith tracing for the CLA Legal RAG pipeline.
 * 
 * Each trace function produces a complete, observable span with:
 * - Inputs and outputs (no hiding)
 * - Metadata (requestId, sessionId, userId, provider, model)
 * - Latency and token usage
 * - Proper parent-child relationships
 */

// ============================================================
// ROOT TRACE: Complete User Request
// ============================================================

const traceUserRequest = traceable(
  async function ({ requestId, sessionId, userId, question, callback }) {
    return await callback();
  },
  {
    name: 'CLA Legal Chat Request',
    run_type: 'chain',
    tags: ['cla', 'legal-rag', 'chat-request'],
  }
);

// ============================================================
// GUARDRAILS TRACE
// ============================================================

const traceGuardrails = traceable(
  async function ({ question, checkGuardrails }) {
    const startTime = Date.now();
    const result = await checkGuardrails();
    const latencyMs = Date.now() - startTime;

    return {
      ...result,
      _langsmith_metadata: {
        latency_ms: latencyMs,
        component: 'guardrails',
        provider: 'nemo-guardrails',
      },
    };
  },
  {
    name: 'NeMo Guardrails Check',
    run_type: 'tool',
    tags: ['guardrails', 'nemo', 'safety'],
  }
);

// ============================================================
// QUERY EXPANSION TRACE
// ============================================================

const traceQueryExpansion = traceable(
  async function ({
    originalQuestion,
    expandLegalQuery,
  }) {
    const startTime = Date.now();
    const result = await expandLegalQuery();
    const latencyMs = Date.now() - startTime;

    return {
      originalQuestion,
      expandedQuery: result.expandedQuery,
      keywords: result.keywords,
      suggestedFilters: result.suggestedFilters,
      _langsmith_metadata: {
        latency_ms: latencyMs,
        component: 'query_expansion',
        provider: result.provider || 'unknown',
        model: result.model || 'unknown',
        token_input: result.token_input || 0,
        token_output: result.token_output || 0,
      },
    };
  },
  {
    name: 'Query Expansion',
    run_type: 'chain',
    tags: ['query-expansion', 'legal-query'],
  }
);

// ============================================================
// EMBEDDING TRACE
// ============================================================

const traceEmbedding = traceable(
  async function ({
    query,
    getEmbeddingVector,
  }) {
    const startTime = Date.now();
    const vector = await getEmbeddingVector();
    const latencyMs = Date.now() - startTime;

    return {
      query,
      vectorDimensions: vector?.length || 3072,
      vectorMagnitude: Math.sqrt(vector?.reduce((sum, v) => sum + v * v, 0) || 0),
      _langsmith_metadata: {
        latency_ms: latencyMs,
        component: 'embedding',
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 3072,
      },
    };
  },
  {
    name: 'Embedding Generation',
    run_type: 'tool',
    tags: ['embedding', 'vector', 'openai'],
  }
);

// ============================================================
// RETRIEVAL / VECTOR SEARCH TRACE
// ============================================================

const traceRetrieval = traceable(
  async function ({
    query,
    topK,
    performSearch,
  }) {
    const startTime = Date.now();
    const results = await performSearch();
    const latencyMs = Date.now() - startTime;

    const chunkIds = Array.isArray(results)
      ? results.map((r) => r.embedding_id || r.record_id || r.parent_id).filter(Boolean)
      : [];
    const documentIds = Array.isArray(results)
      ? results.map((r) => r.doc_id || r.documentId || r.source).filter(Boolean)
      : [];
    const similarityScores = Array.isArray(results)
      ? results.map((r) => r.score || r.similarity_score).filter((s) => Number.isFinite(s))
      : [];

    return {
      query,
      topK,
      retrievedCount: Array.isArray(results) ? results.length : 0,
      chunkIds,
      documentIds,
      similarityScores,
      _langsmith_metadata: {
        latency_ms: latencyMs,
        component: 'retrieval',
        provider: 'vector-search',
        embedding_model: 'text-embedding-3-large',
        embedding_dimensions: 3072,
        retrieved_documents: Array.isArray(results) ? results.length : 0,
      },
    };
  },
  {
    name: 'Vector Retrieval / Search',
    run_type: 'retriever',
    tags: ['retrieval', 'vector-search', 'rag'],
  }
);

// ============================================================
// RERANKING TRACE
// ============================================================

const traceReranking = traceable(
  async function ({
    originalQuestion,
    candidateCount,
    rerankResults,
  }) {
    const startTime = Date.now();
    const rerankedResults = await rerankResults();
    const latencyMs = Date.now() - startTime;

    return {
      originalQuestion,
      candidateCount,
      rerankedCount: Array.isArray(rerankedResults) ? rerankedResults.length : 0,
      rerankedResults,
      _langsmith_metadata: {
        latency_ms: latencyMs,
        component: 'reranking',
        provider: 'bm25-reranker',
        candidates: candidateCount,
        final_results: Array.isArray(rerankedResults) ? rerankedResults.length : 0,
      },
    };
  },
  {
    name: 'Reranking',
    run_type: 'chain',
    tags: ['reranking', 'ranking'],
  }
);

// ============================================================
// PROMPT CONSTRUCTION TRACE
// ============================================================

const tracePromptConstruction = traceable(
  async function ({
    question,
    systemPrompt,
    retrievedContext,
    attachmentContext,
  }) {
    const startTime = Date.now();
    
    const userContent = [
      `Question: ${question}`,
      retrievedContext ? `Search Context:\n${retrievedContext}` : '',
      attachmentContext ? `ATTACHED DOCUMENT CONTEXT:\n${attachmentContext}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const latencyMs = Date.now() - startTime;

    // Count tokens (rough estimate: ~4 chars = 1 token)
    const systemPromptTokens = Math.ceil(systemPrompt.length / 4);
    const userContentTokens = Math.ceil(userContent.length / 4);
    const totalPromptTokens = systemPromptTokens + userContentTokens;

    return {
      systemPromptLength: systemPrompt.length,
      userContentLength: userContent.length,
      totalPromptLength: systemPrompt.length + userContent.length,
      systemPromptTokensEstimate: systemPromptTokens,
      userContentTokensEstimate: userContentTokens,
      totalPromptTokensEstimate: totalPromptTokens,
      retrievedContextChunks: retrievedContext ? (retrievedContext.match(/\[Source \d+\]/g) || []).length : 0,
      hasAttachmentContext: Boolean(attachmentContext),
      _langsmith_metadata: {
        latency_ms: latencyMs,
        component: 'prompt_construction',
        system_prompt_tokens: systemPromptTokens,
        user_content_tokens: userContentTokens,
        total_tokens: totalPromptTokens,
      },
    };
  },
  {
    name: 'Prompt Construction',
    run_type: 'chain',
    tags: ['prompt', 'construction'],
  }
);

// ============================================================
// LLM GENERATION TRACE
// ============================================================

const traceLLMGeneration = traceable(
  async function ({
    provider,
    model,
    temperature,
    maxTokens,
    systemPrompt,
    userContent,
    generate,
  }) {
    const startTime = Date.now();
    const response = await generate();
    const latencyMs = Date.now() - startTime;

    // Extract usage information
    const inputTokens = response?.usage?.prompt_tokens || 
                       response?.usage?.input_tokens || 
                       Math.ceil(userContent.length / 4);
    const outputTokens = response?.usage?.completion_tokens || 
                        response?.usage?.output_tokens || 
                        Math.ceil((response?.content || response?.text || response?.message?.content || '').length / 4);
    const totalTokens = (response?.usage?.total_tokens) || (inputTokens + outputTokens);

    // Estimate cost (varies by model)
    const costPerInputToken = provider === 'openai' ? 0.0000005 : 0.00001; // rough estimates
    const costPerOutputToken = provider === 'openai' ? 0.0000015 : 0.00002;
    const estimatedCost = (inputTokens * costPerInputToken) + (outputTokens * costPerOutputToken);

    return {
      content: response?.content || response?.text || response?.message?.content,
      provider,
      model,
      finishReason: response?.finish_reason || 'unknown',
      _langsmith_metadata: {
        latency_ms: latencyMs,
        component: 'llm',
        provider,
        model,
        temperature,
        max_tokens: maxTokens,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        estimated_cost_usd: estimatedCost.toFixed(6),
        finish_reason: response?.finish_reason || 'unknown',
      },
    };
  },
  {
    name: 'Portkey LLM Call',
    run_type: 'llm',
    tags: ['llm', 'generation', 'portkey'],
  }
);

// ============================================================
// RAG EVALUATION TRACE
// ============================================================

const traceRAGEvaluation = traceable(
  async function ({
    question,
    answer,
    contexts,
    reference,
    evaluate,
  }) {
    const startTime = Date.now();
    const evaluation = await evaluate();
    const latencyMs = Date.now() - startTime;

    return {
      question,
      answerLength: answer.length,
      contextCount: Array.isArray(contexts) ? contexts.length : 0,
      hasReference: Boolean(reference),
      evaluation,
      _langsmith_metadata: {
        latency_ms: latencyMs,
        component: 'rag_evaluation',
        provider: evaluation?.providers_used ? Object.values(evaluation.providers_used)[0] : 'unknown',
        model: 'ragas-metrics',
        faithfulness: evaluation?.faithfulness || null,
        answer_relevancy: evaluation?.answer_relevancy || null,
        context_precision: evaluation?.context_precision || null,
        context_recall: evaluation?.context_recall || null,
        answer_correctness: evaluation?.answer_correctness || null,
        hallucination_score: evaluation?.hallucination_score || null,
        overall_score: evaluation?.overall_score || null,
      },
    };
  },
  {
    name: 'RAG Evaluation (RAGAS)',
    run_type: 'evaluator',
    tags: ['evaluation', 'ragas', 'quality-metrics'],
  }
);

// ============================================================
// MONGODB PERSISTENCE TRACE
// ============================================================

const traceMongoPersistence = traceable(
  async function ({
    collections,
    persist,
  }) {
    const startTime = Date.now();
    const result = await persist();
    const latencyMs = Date.now() - startTime;

    return {
      collectionsUpdated: collections,
      ...result,
      _langsmith_metadata: {
        latency_ms: latencyMs,
        component: 'mongodb_persistence',
        provider: 'mongodb',
        collections_updated: collections,
      },
    };
  },
  {
    name: 'MongoDB Persistence',
    run_type: 'chain',
    tags: ['mongodb', 'persistence', 'logging'],
  }
);

// ============================================================
// ERROR HANDLING TRACE
// ============================================================

const traceError = traceable(
  async function ({
    errorType,
    errorMessage,
    component,
    requestId,
    sessionId,
  }) {
    return {
      errorType,
      errorMessage,
      component,
      requestId,
      sessionId,
      timestamp: new Date().toISOString(),
    };
  },
  {
    name: 'Error Occurred',
    run_type: 'chain',
    tags: ['error', 'exception'],
  }
);

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Root trace
  traceUserRequest,
  
  // Component traces
  traceGuardrails,
  traceQueryExpansion,
  traceEmbedding,
  traceRetrieval,
  traceReranking,
  tracePromptConstruction,
  traceLLMGeneration,
  traceRAGEvaluation,
  traceMongoPersistence,
  traceError,
};