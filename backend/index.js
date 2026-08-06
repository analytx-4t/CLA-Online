

require('dotenv').config();
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID, randomBytes } = require('crypto');
const { ObjectId } = require('mongodb');
const { connectDB, closeDB } = require('./mongoClient');
const { getProviderHealth, settings, getEmbeddingConfig } = require('./config');
const { getLLMProvider } = require('./llm/factory');
const { traceLLMGeneration, traceRequest, traceRequestStage } = require('./langsmith');
const {
  traceUserRequest,
  traceGuardrails,
  traceQueryExpansion,
  traceEmbedding,
  traceRetrieval,
  traceReranking,
  tracePromptConstruction,
  traceRAGEvaluation,
  traceMongoPersistence,
  traceError,
} = require('./langsmith');
const { runFullEvaluation } = require('./llm/judge');
const { parseAnswerAndSuggestions, normalizeFollowUpQuestions } = require('./responseParser');
const { handleAttachmentUpload, buildAttachmentContextBlock } = require('./attachments');
const { createRequestContext } = require('./requestContext');
const { handleAdminRoutes } = require('./adminRoutes');
const { getEvaluationToggle } = require('./settingsStore');
const { cohereRerank } = require('./cohereReranker');
const { normalizeLegalQuery } = require('./legalQueryNormalizer');
const { Server } = require('socket.io');

let logfire;
const requestProgressStore = new Map();

async function getLogfire() {
  if (!logfire) {
    logfire = await import('@pydantic/logfire-node');
  }

  return logfire;
}

const PORT = process.env.PORT || 3000;

function getRequestPath(url) {
  return url.split('?')[0];
}

function getAuthenticatedUserId(req) {
  return req.headers['x-user-id'] || req.headers['x-auth-user-id'] || 'unknown-user';
}

function setJsonHeaders(res, statusCode) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-auth-user-id',
  });
}

function getProgressStageMeta(stageIndex) {
  const mapping = {
    0: { currentStage: 'queued', message: 'Preparing your response' },
    1: { currentStage: 'understanding', message: 'Understanding your question' },
    2: { currentStage: 'retrieving', message: 'Finding relevant information' },
    3: { currentStage: 'reviewing', message: 'Reviewing the retrieved information' },
    4: { currentStage: 'preparing', message: 'Preparing your answer' },
    5: { currentStage: 'completed', message: 'Finalizing your response' },
  };

  return mapping[stageIndex] || mapping[0];
}

function updateRequestProgress(requestId, patch = {}) {
  const normalizedRequestId = requestId || `req-${randomUUID()}`;
  const previous = requestProgressStore.get(normalizedRequestId) || {
    requestId: normalizedRequestId,
    status: 'in_progress',
    stageIndex: 0,
    currentStage: 'queued',
    message: 'Preparing your response',
    steps: [],
    startedAt: new Date().toISOString(),
  };

  const nextStageIndex = Number.isFinite(patch.stageIndex) ? patch.stageIndex : previous.stageIndex;
  const stageMeta = getProgressStageMeta(nextStageIndex);
  const nextMessage = patch.message || stageMeta.message || previous.message;
  const nextCurrentStage = patch.currentStage || stageMeta.currentStage || previous.currentStage;
  const nextStatus = patch.status || previous.status || 'in_progress';

  const nextSteps = Array.isArray(previous.steps) ? previous.steps.slice() : [];
  if (Number.isFinite(patch.stageIndex) && patch.stageIndex > previous.stageIndex) {
    nextSteps.push({
      stageIndex: patch.stageIndex,
      currentStage: nextCurrentStage,
      message: nextMessage,
      timestamp: new Date().toISOString(),
    });
  }

  const nextState = {
    ...previous,
    requestId: normalizedRequestId,
    status: nextStatus,
    stageIndex: Math.max(previous.stageIndex, nextStageIndex),
    currentStage: nextCurrentStage,
    message: nextMessage,
    steps: nextSteps,
    updatedAt: new Date().toISOString(),
  };

  requestProgressStore.set(normalizedRequestId, nextState);
  return nextState;
}

function getRequestProgress(requestId) {
  const normalizedRequestId = requestId || null;
  if (!normalizedRequestId) {
    return null;
  }

  const state = requestProgressStore.get(normalizedRequestId);
  return state ? { ...state } : null;
}

function clearRequestProgress(requestId) {
  if (!requestId) {
    return;
  }

  requestProgressStore.delete(requestId);
}

function handleCors(req, res) {
  if (req.method === 'OPTIONS') {
    setJsonHeaders(res, 204);
    res.end();
    return true;
  }
  return false;
}

function generateSessionId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const chunks = Array.from({ length: 3 }, (_, index) => {
    const start = index * 4;
    return Array.from(bytes.slice(start, start + 4), (byte) => alphabet[byte % alphabet.length]).join('');
  });
  return `CLA-${chunks.join('-')}`;
}

function getRequestBody(req) {
  if (req._parsedBody !== undefined) {
    return Promise.resolve(req._parsedBody);
  }
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) {
        req._parsedBody = {};
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        req._parsedBody = parsed;
        resolve(parsed);
      } catch (error) {
        console.error('[Request Body] Failed to parse body:', JSON.stringify(body));
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function getSessionLookupFilter(sessionId, userId) {
  return { session_id: sessionId, user_id: userId };
}

function normalizeGeneratedTitle(title) {
  if (typeof title !== 'string') return '';

  const cleaned = title
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ''))
    .filter(Boolean);

  if (!words.length) return '';

  const stopWords = new Set(['the', 'and', 'for', 'with', 'about', 'into', 'from', 'this', 'that', 'your', 'how', 'what', 'when', 'where', 'why', 'can', 'could', 'should', 'would', 'please', 'regarding', 'regard', 'about']);
  const meaningfulWords = words.filter(word => !stopWords.has(word.toLowerCase()));
  const titleWords = (meaningfulWords.length ? meaningfulWords : words).slice(0, 6);

  return titleWords.join(' ');
}

async function generateConversationTitle({ userContent, assistantContent, requestContext }) {
  const prompt = [
    'Create a short conversation title for the following chat.',
    'Requirements:',
    '- 3 to 6 words',
    '- describe the topic, not the full first message',
    '- no punctuation, no quotes, no trailing periods',
    '- make it human readable',
    '',
    'User message:',
    userContent || 'No user message available',
    '',
    'Assistant response:',
    assistantContent || 'No assistant response available',
  ].join('\n');

  try {
    const llm = getLLMProvider(settings.DEFAULT_LLM_PROVIDER, settings.DEFAULT_LLM_MODEL);
    const llmResponse = await llm.generate({
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: 'You create concise, human-readable chat titles.',
      temperature: 0.1,
      maxTokens: 24,
      requestContext,
    });

    const generatedTitle = normalizeGeneratedTitle(llmResponse?.content || '');
    if (generatedTitle) {
      return generatedTitle;
    }
  } catch (error) {
    console.warn('Conversation title generation failed, falling back to placeholder title handling.', error?.message || error);
  }

  const fallbackSource = `${assistantContent || ''}\n${userContent || ''}`;
  const fallbackTitle = normalizeGeneratedTitle(fallbackSource);
  return fallbackTitle || '';
}

async function findOwnedSession(sessionsCollection, sessionId, userId) {
  const filter = getSessionLookupFilter(sessionId, userId);
  let session = await sessionsCollection.findOne(filter);
  if (session) {
    return session;
  }

  if (sessionId && /^[a-fA-F0-9]{24}$/.test(sessionId)) {
    try {
      const objectId = new ObjectId(sessionId);
      session = await sessionsCollection.findOne({ _id: objectId, user_id: userId });
    } catch (error) {
      return null;
    }
  }

  return session;
}

async function ensureIndexes(db) {
  const sessionsCollection = db.collection('chat_sessions');
  const messagesCollection = db.collection('chat_messages');
  const evaluationResultsCollection = db.collection('evaluation_results');
  const retrievalLogsCollection = db.collection('retrieval_logs');
  const goldenDatasetRunsCollection = db.collection('golden_dataset_runs');
  const goldenDatasetCollection = db.collection('golden_dataset');
  const goldenDatasetStateCollection = db.collection('golden_dataset_state');

  try {
    await db.createCollection('evaluation_results');
  } catch (error) {
    if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) {
      throw error;
    }
  }

  try {
    await db.createCollection('retrieval_logs');
  } catch (error) {
    if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) {
      throw error;
    }
  }

  try {
    await db.createCollection('golden_dataset_runs');
  } catch (error) {
    if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) {
      throw error;
    }
  }

  try {
    await db.createCollection('golden_dataset_state');
  } catch (error) {
    if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) {
      throw error;
    }
  }

try {
  await Promise.all([
    sessionsCollection.createIndex({ session_id: 1, user_id: 1 }, { unique: true, name: 'uniq_session_user' }),
    sessionsCollection.createIndex({ user_id: 1, last_message_at: -1 }, { name: 'user_last_message' }),
    messagesCollection.createIndex({ message_id: 1 }, { unique: true, name: 'uniq_message_id' }),
    messagesCollection.createIndex({ session_id: 1, sequence_number: 1 }, { name: 'session_sequence' }),
    evaluationResultsCollection.createIndex({ requestId: 1 }, { name: 'eval_request_id' }),
    evaluationResultsCollection.createIndex({ timestamp: 1 }, { name: 'eval_timestamp' }),
    retrievalLogsCollection.createIndex({ requestId: 1 }, { name: 'retrieval_request_id' }),
    retrievalLogsCollection.createIndex({ timestamp: 1 }, { name: 'retrieval_timestamp' }),
    goldenDatasetCollection.createIndex({ version: 1 }, { name: 'golden_dataset_version' }),
    goldenDatasetCollection.createIndex({ question: 1 }, { name: 'golden_dataset_question' }),
    goldenDatasetCollection.createIndex({ id: 1 }, { name: 'golden_dataset_id' }),
    goldenDatasetRunsCollection.createIndex({ questionId: 1 }, { name: 'golden_dataset_run_question_id' }),
    goldenDatasetRunsCollection.createIndex({ timestamp: 1 }, { name: 'golden_dataset_run_timestamp' }),
    goldenDatasetRunsCollection.createIndex({ datasetVersion: 1 }, { name: 'golden_dataset_run_dataset_version' }),
    evaluationResultsCollection.createIndex({ datasetVersion: 1 }, { name: 'eval_dataset_version' }),
    evaluationResultsCollection.createIndex({ evaluationSessionId: 1 }, { name: 'eval_session_id' }),
    goldenDatasetStateCollection.createIndex({ _id: 1 }, { name: 'golden_dataset_state_id' }),
  ]);
} catch (error) {
  if (error?.codeName === 'IndexKeySpecsConflict' && error?.message?.includes('eval_session_id')) {
    console.log('Found conflicting eval_session_id index, attempting to drop it...');
    try {
      await evaluationResultsCollection.dropIndex('eval_session_id');
      console.log('Successfully dropped conflicting index');
      await evaluationResultsCollection.createIndex(
        { evaluationSessionId: 1 },
        { name: 'eval_session_id' }
      );
    } catch (dropError) {
      console.log('Could not drop index:', dropError.message);
    }
  } else {
    throw error;
  }
}
}

async function getCurrentGoldenDatasetVersion(db) {
  if (!db) {
    return null;
  }

  try {
    const stateCollection = db.collection('golden_dataset_state');
    const state = await stateCollection.findOne({ _id: 'current' });
    return state?.version || null;
  } catch (error) {
    return null;
  }
}

function buildEvaluationResultDocument({
  requestContext,
  question,
  answer,
  goldenAnswer,
  evaluation,
  provider,
  model,
  contexts,
  retrievedChunks,
  retrievedChunkIds,
  similarityScores,
  retrievalTime,
  datasetVersion,
  evaluationSessionId = null,
  userId = null,
  evaluationStatus = null,
  evaluationTimeMs = null,
  suggestions = [],
  metadata = {},
  errorMessage = null,
  source = 'cla_chat',
  serverLogs = [],
}) {
  const evaluationData = evaluation && typeof evaluation === 'object' ? evaluation : {};
  const timestamp = new Date().toISOString();
  const normalizedMetadata = {
    tokenUsage: metadata?.tokenUsage ?? null,
    retrievalTime: Number.isFinite(metadata?.retrievalTime ?? retrievalTime) ? (metadata?.retrievalTime ?? retrievalTime) : (Number.isFinite(retrievalTime) ? retrievalTime : null),
    llmTime: Number.isFinite(metadata?.llmTime) ? metadata.llmTime : null,
    judgeProvider: evaluationData.judgeProvider ?? null,
    judgeModel: evaluationData.judgeModel ?? null,
    judgeFallbackProvider: evaluationData.judgeFallbackProvider ?? null,
    judgeFallbackModel: evaluationData.judgeFallbackModel ?? null,
    guardrailCategory: metadata?.guardrailCategory ?? null,
  };
  const scoredFaithfulness = evaluationData.faithfulness ?? null;
  const scoredAnswerRelevancy = evaluationData.answer_relevancy ?? evaluationData.answerRelevancy ?? null;
  const scoredContextPrecision = evaluationData.context_precision ?? evaluationData.contextPrecision ?? null;
  const scoredContextRecall = evaluationData.context_recall ?? evaluationData.contextRecall ?? null;
  const scoredAnswerCorrectness = evaluationData.answer_correctness ?? evaluationData.answerCorrectness ?? null;

  const allScoresPresent = [
    scoredFaithfulness,
    scoredAnswerRelevancy,
    scoredContextPrecision,
    scoredContextRecall,
    scoredAnswerCorrectness,
  ].every((score) => Number.isFinite(score));

  const calculatedOverallScore = allScoresPresent
    ? Number(
        (
          scoredFaithfulness +
          scoredAnswerRelevancy +
          scoredContextPrecision +
          scoredContextRecall +
          scoredAnswerCorrectness
        ) / 5
      ).toFixed(4)
    : null;

  return {
    requestId: requestContext?.requestId || null,
    sessionId: requestContext?.sessionId || null,
    evaluationSessionId: evaluationSessionId || null,
    userId: userId || null,
    question: question || null,
    answer: answer || null,
    timestamp,
    evaluationTimestamp: timestamp,
    source,
    goldenAnswer: goldenAnswer ?? null,
    faithfulness: evaluationData.faithfulness ?? null,
    faithfulnessReason: evaluationData.faithfulnessReason ?? null,
    answerRelevancy: evaluationData.answerRelevancy ?? null,
    answerRelevancyReason: evaluationData.answerRelevancyReason ?? null,
    contextPrecision: evaluationData.contextPrecision ?? null,
    contextPrecisionReason: evaluationData.contextPrecisionReason ?? null,
    contextRecall: evaluationData.contextRecall ?? null,
    contextRecallReason: evaluationData.contextRecallReason ?? null,
    piiLeakage: evaluationData.piiLeakage ?? null,
    piiLeakageReason: evaluationData.piiLeakageReason ?? null,
    overallScore: evaluationData.overallScore ?? null,
    provider: provider || null,
    model: model || null,
    datasetVersion: datasetVersion || null,
    retrievedContext: Array.isArray(contexts) ? contexts : null,
    retrievedChunks: Array.isArray(retrievedChunks) ? retrievedChunks : [],
    retrievedChunkIds: Array.isArray(retrievedChunkIds) ? retrievedChunkIds : [],
    similarityScores: Array.isArray(similarityScores) ? similarityScores : [],
    retrievalTime: Number.isFinite(retrievalTime) ? retrievalTime : null,
    evaluationStatus: evaluationStatus || (evaluationData?.status === 'failed' ? 'failed' : 'completed'),
    metricsCalculated: evaluationData.metricsCalculated ?? (evaluationData.faithfulness !== null && evaluationData.faithfulness !== undefined),
    evaluationTimeMs: Number.isFinite(evaluationTimeMs) ? evaluationTimeMs : null,
    suggestions: Array.isArray(suggestions) ? suggestions : [],
    errorMessage: errorMessage || (Array.isArray(evaluationData?.errors) && evaluationData.errors.length ? evaluationData.errors.join('; ') : null),
    metadata: normalizedMetadata,
    serverLogs: Array.isArray(serverLogs) ? serverLogs : [],
  };
}

async function persistEvaluationResult(db, document, io = null) {
  if (!db) {
    return;
  }

  try {
    const evaluationResultsCollection = db.collection('evaluation_results');

    if (!document?.requestId) {
      await evaluationResultsCollection.insertOne(document);
      console.log('[RAGAS DB] Save successful.');
      return;
    }

    console.log('[RAGAS DB] Saving evaluation...');
    const { requestId, ...documentWithoutRequestId } = document;
    const result = await evaluationResultsCollection.updateOne(
      { requestId },
      {
        $set: documentWithoutRequestId,
        $setOnInsert: { requestId },
      },
      { upsert: true }
    );

    if (result.upsertedCount > 0) {
      console.log(`[RAGAS DB] Saved new evaluation for requestId ${document.requestId}`);
    } else {
      console.log(`[RAGAS DB] Updated requestId ${document.requestId}`);
    }

    // Only broadcast real end-user chatbot evaluations to the live Online Eval
    // view — golden-dataset benchmark runs still get written to Mongo above
    // (and stay visible on the Golden Dataset page via golden_dataset_runs)
    // but shouldn't flash into the "live" table.
    if (io && document?.requestId && document?.source !== 'golden_dataset') {
      const broadcastPayload = {
        requestId: document.requestId,
        timestamp: document.timestamp || document.evaluationTimestamp || null,
        question: document.question || null,
        provider: document.provider || null,
        model: document.model || null,
        overallScore: document.overallScore ?? null,
        evaluationStatus: document.evaluationStatus || null,
      };
      io.emit('ragas-evaluation-updated', broadcastPayload);
      console.log('[RAGAS Live] Evaluation broadcast');
    }

    console.log('[RAGAS DB] Save successful.');
  } catch (error) {
    console.error('[RAGAS DB] Failed to persist evaluation result:', error);
  }
}

async function persistGoldenDatasetRun(db, document) {
  if (!db) {
    return;
  }

  try {
    const goldenDatasetRunsCollection = db.collection('golden_dataset_runs');
    await goldenDatasetRunsCollection.insertOne(document);
  } catch (error) {
    console.error('[RAGAS] Failed to persist golden dataset run:', error);
  }
}

function buildRetrievalLogDocument({ requestContext, query, retrievalTime, topK, retrievedChunks }) {
  const timestamp = new Date().toISOString();

  return {
    requestId: requestContext?.requestId || null,
    sessionId: requestContext?.sessionId || null,
    query: query || null,
    timestamp,
    retrievalTime: Number.isFinite(retrievalTime) ? retrievalTime : null,
    topK: Number.isFinite(topK) ? topK : null,
    retrievedChunks: Array.isArray(retrievedChunks)
      ? retrievedChunks.map((chunk) => ({
          chunkId: chunk?.chunkId || chunk?.chunk_id || null,
          documentId: chunk?.documentId || chunk?.document_id || chunk?.source || chunk?.sourceId || chunk?.source_id || null,
          rank: chunk?.rank ?? null,
          similarityScore: chunk?.similarityScore ?? chunk?.similarity_score ?? null,
          content: chunk?.content || chunk?.chunk_text || chunk?.text || null,
        }))
      : [],
  };
}

async function persistRetrievalLog(db, document) {
  if (!db) {
    return;
  }

  try {
    const retrievalLogsCollection = db.collection('retrieval_logs');
    await retrievalLogsCollection.insertOne(document);
  } catch (error) {
    console.error('[Retrieval] Failed to persist retrieval metadata:', error);
  }
}

async function validateEmbeddingConfiguration() {
  /**
   * Validates that the embedding model and dimensions are correctly configured.
   * This should be called before any retrieval operation to ensure consistency
   * between the indexed vectors and the current retrieval expectations.
   */
  const embeddingConfig = getEmbeddingConfig();
  
  // Log configuration for debugging
  console.log(
    `[Embedding Validation] Current Config: ${embeddingConfig.model} (${embeddingConfig.dimensions} dims)`
  );
  
  // Expected configuration
  const expectedModel = 'text-embedding-3-large';
  const expectedDimensions = 3072;
  
  if (embeddingConfig.model !== expectedModel) {
    const warning = (
      `[Embedding Validation] WARNING: Expected embedding model '${expectedModel}' ` +
      `but found '${embeddingConfig.model}'. This may cause retrieval failures if the indexed ` +
      `vectors were created with a different model. Please ensure consistency.`
    );
    console.warn(warning);
  }
  
  if (embeddingConfig.dimensions !== expectedDimensions) {
    const warning = (
      `[Embedding Validation] WARNING: Expected embedding dimensions ${expectedDimensions} ` +
      `but found ${embeddingConfig.dimensions}. The vector dimensionality must match the indexed data. ` +
      `Please verify the embeddings were generated with the correct model.`
    );
    console.warn(warning);
  }
}

function runPythonSearch(query, topK = 5, hybrid = true, sourceFilter = null) {
  return new Promise((resolve, reject) => {
    // Validate embedding configuration before retrieval
    validateEmbeddingConfiguration();

    let pythonPath = path.resolve(__dirname, '../embedding/venv/Scripts/python.exe');
    if (!require('fs').existsSync(pythonPath)) {
      pythonPath = path.resolve(__dirname, '../embedding/venv/bin/python');
    }

    const scriptPath = path.resolve(__dirname, '../embedding/search_documents.py');
    if (!require('fs').existsSync(scriptPath)) {
      return reject(new Error(`search_documents.py not found at ${scriptPath}`));
    }

    const child = spawn(pythonPath, [scriptPath, '--json']);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Python process exited with code ${code}. Stderr: ${stderr}`));
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          return reject(new Error(result.error));
        }
        resolve(result.results || []);
      } catch (err) {
        reject(new Error(`Failed to parse Python output: ${err.message}. Raw output: ${stdout}`));
      }
    });

    const inputPayload = JSON.stringify({
      query: query,
      top_k: topK,
      hybrid: hybrid,
      source_filter: sourceFilter
    });

    child.stdin.write(inputPayload);
    child.stdin.end();
  });
}
async function rerankSearchResults(query, results, topK = 5) {
  if (!Array.isArray(results) || results.length === 0) {
    return [];
  }

  // Primary: Cohere Rerank API (v3.5)
  if (process.env.COHERE_API_KEY) {
    try {
      const cohereResults = await cohereRerank(query, results, topK);
      if (Array.isArray(cohereResults) && cohereResults.length > 0) {
        return cohereResults;
      }
    } catch (err) {
      console.warn('[Reranker Warning] Cohere Rerank API failed, falling back to local heuristic reranker:', err.message);
    }
  }

  // Fallback: Local Heuristic Reranker
  return heuristicRerankSearchResults(query, results, topK);
}

function heuristicRerankSearchResults(query, results, topK = 5) {
  if (!Array.isArray(results) || results.length === 0) {
    return [];
  }

  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'for',
    'in', 'on', 'under', 'what', 'which', 'how', 'is',
    'are', 'was', 'were', 'be', 'been', 'with', 'by',
    'from', 'this', 'that'
  ]);

  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const queryText = normalize(query);

  const queryTerms = [
    ...new Set(
      queryText
        .split(' ')
        .filter(term => term.length > 2 && !stopWords.has(term))
    )
  ];

  // Extract legal section references such as:
  // "Section 135", "section 188", etc.
  const sectionMatches = [
    ...queryText.matchAll(/\bsection\s+(\d+[a-z]?)\b/gi)
  ];

  const requestedSections = sectionMatches.map(match =>
    match[1].toLowerCase()
  );

  const ranked = results.map((result, originalIndex) => {
    const searchableText = normalize([
      result.doc_title,
      result.law_title,
      result.category,
      result.subject,
      result.sections,
      result.chunk_text
    ].filter(Boolean).join(' '));

    let relevanceScore = 0;

    // Keyword overlap with the user's query.
    for (const term of queryTerms) {
      if (searchableText.includes(term)) {
        relevanceScore += 1;
      }
    }

    // Strongly reward an exact requested legal section.
    for (const section of requestedSections) {
      const sectionPattern = new RegExp(
        `\\bsection\\s+${section}\\b`,
        'i'
      );

      if (sectionPattern.test(searchableText)) {
        relevanceScore += 10;
      }
    }

    // Preserve the embedding system's own ordering as a
    // secondary signal. Earlier results get a small bonus.
    const retrievalRankBonus =
      (results.length - originalIndex) / results.length;

    return {
      ...result,
      backend_relevance_score:
        relevanceScore + retrievalRankBonus
    };
  });

  ranked.sort(
    (a, b) =>
      b.backend_relevance_score -
      a.backend_relevance_score
  );

  const bestScore =
    ranked[0]?.backend_relevance_score || 0;

  // Keep results that are reasonably close to the strongest
  // backend relevance score. This prevents unrelated documents
  // from being included merely to fill the requested topK.
  const minimumRelativeScore = Math.max(0.1, bestScore * 0.05);

  const relevantResults = ranked.filter(
    result =>
      result.backend_relevance_score >= minimumRelativeScore
  );

  return (relevantResults.length > 0 ? relevantResults : ranked).slice(0, topK);
}

async function performPrioritizedLegalSearch(retrievalQuery, originalQuestion = null, expansionKeywords = []) {
  const normRetrieval = normalizeLegalQuery(retrievalQuery);
  const targetQuestion = normalizeLegalQuery(originalQuestion || retrievalQuery);

  // For keyword (SQL LIKE) fallback, use a focused string: original question + top keywords
  // This avoids the bloated expanded paragraph being tokenized into noise by the Python fallback
  const keywordFocusedQuery = [
    originalQuestion || originalQuestion,
    ...expansionKeywords.slice(0, 8)
  ].filter(Boolean).join(' ');
  const normKeywordQuery = normalizeLegalQuery(keywordFocusedQuery || retrievalQuery);

  console.log(`[Prioritized Search] Keyword-focused query: "${normKeywordQuery.slice(0, 200)}..."`)

  // Step 1: Sequential candidate retrieval (avoids ODBC connection contention)
  // Legislation max 35 candidates, Other tables max 60 candidates
  let legislationCandidates = [];
  let otherCandidates = [];

  try {
    const legRes = await runPythonSearch(normKeywordQuery, 35, true, 'Legislation').catch(err => {
      console.error('[Prioritized Search] Legislation search failed:', err.message);
      return [];
    });
    const othRes = await runPythonSearch(normKeywordQuery, 60, true, '!Legislation').catch(err => {
      console.error('[Prioritized Search] Other tables search failed:', err.message);
      return [];
    });
    legislationCandidates = Array.isArray(legRes) ? legRes : [];
    otherCandidates = Array.isArray(othRes) ? othRes : [];
  } catch (err) {
    console.error('[Prioritized Search] Candidate retrieval failed:', err.message);
  }

  // Step 2: Rerank Legislation (top candidates) and Other tables (top candidates) using Cohere Reranker
  const [legislationResults, otherResults] = await Promise.all([
    legislationCandidates.length > 0
      ? rerankSearchResults(targetQuestion, legislationCandidates, 20)
      : Promise.resolve([]),
    otherCandidates.length > 0
      ? rerankSearchResults(targetQuestion, otherCandidates, 60)
      : Promise.resolve([])
  ]);

  // Step 3: Apply per-table top-5 cap:
  // - Top 5 chunks from Legislation table (if any matched)
  // - Top 5 chunks from EACH other source table independently
  // This ensures every table contributes fairly, and no single table monopolizes context.
  const TOP_CHUNKS_PER_TABLE = 5;


  // Helper: group results by source_table and take top N per group
  const capPerTable = (results, maxPerTable = TOP_CHUNKS_PER_TABLE) => {
    const tableBuckets = {};
    for (const r of results) {
      const tableKey = (r.source_table || 'unknown').trim().toLowerCase();
      if (!tableBuckets[tableKey]) tableBuckets[tableKey] = [];
      if (tableBuckets[tableKey].length < maxPerTable) {
        tableBuckets[tableKey].push(r);
      }
    }
    // Flatten all buckets back into a single array, sorted by relevance score descending
    return Object.values(tableBuckets)
      .flat()
      .sort((a, b) => (b.backend_relevance_score || 0) - (a.backend_relevance_score || 0));
  };

  // Legislation: top 3 chunks from legislation table
  const legSlice = legislationResults.slice(0, TOP_CHUNKS_PER_TABLE);

  // Other tables: top 3 per source_table, flattened
  const otherSlice = capPerTable(otherResults, TOP_CHUNKS_PER_TABLE);

  const combinedResults = [...legSlice, ...otherSlice];
  const candidateCount = legislationCandidates.length + otherCandidates.length;

  combinedResults.legislationResults = legSlice;
  combinedResults.otherResults = otherSlice;
  combinedResults.candidateCount = candidateCount;
  combinedResults.legislationCandidatesCount = legislationCandidates.length;
  combinedResults.otherCandidatesCount = otherCandidates.length;

  return combinedResults;
}

function runPythonCitation(sourceTable, recordId, parentId = null) {
  return new Promise((resolve, reject) => {
    let pythonPath = path.resolve(__dirname, '../embedding/venv/Scripts/python.exe');
    if (!require('fs').existsSync(pythonPath)) {
      pythonPath = path.resolve(__dirname, '../embedding/venv/bin/python');
    }

    const scriptPath = path.resolve(__dirname, '../embedding/search_documents.py');
    if (!require('fs').existsSync(scriptPath)) {
      return reject(new Error(`search_documents.py not found at ${scriptPath}`));
    }

    const child = spawn(pythonPath, [scriptPath, '--json']);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Python process exited with code ${code}. Stderr: ${stderr}`));
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          return reject(new Error(result.error));
        }
        resolve(result);
      } catch (err) {
        reject(new Error(`Failed to parse Python output: ${err.message}. Raw output: ${stdout}`));
      }
    });

    const inputPayload = JSON.stringify({
      action: "get_citation",
      source_table: sourceTable,
      record_id: parseInt(recordId, 10) || recordId,
      parent_id: parentId ? (parseInt(parentId, 10) || parentId) : null
    });

    child.stdin.write(inputPayload);
    child.stdin.end();
  });
}

function escapeHTML(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDocumentContent(rawText) {
  if (!rawText) return '<p>No content available.</p>';

  const trimmed = rawText.trim();
  const hasHTML = /<[a-z][\s\S]*>/i.test(trimmed) && (
    trimmed.includes('</') ||
    trimmed.includes('/>') ||
    trimmed.toLowerCase().includes('<br>') ||
    trimmed.toLowerCase().includes('<p>')
  );

  if (hasHTML) {
    let bodyContent = rawText;
    const bodyMatch = rawText.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      bodyContent = bodyMatch[1];
    } else {
      bodyContent = bodyContent.replace(/<head[^>]*>[\s\S]*?<\/head>/i, '');
    }
    bodyContent = bodyContent
      .replace(/<html[^>]*>/gi, '')
      .replace(/<\/html>/gi, '')
      .replace(/<!doctype[^>]*>/gi, '')
      .replace(/<link[^>]*>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    return bodyContent.trim();
  }

  // Pre-process to separate glued paragraph boundaries
  const preProcessed = rawText
    .replace(/([.!?])([A-Z])/g, '$1\n$2')
    .replace(/([.!?])(\d+(?:\.\d+)?\s+[A-Z])/g, '$1\n$2');

  const lines = preProcessed.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let htmlResult = '';

  let inFootnotes = false;
  let inList = false;

  for (let idx = 0; idx < lines.length; idx++) {
    let line = lines[idx].trim();
    if (!line) continue;

    // Detect Footnotes/References section at the end of document
    const isFootnote = line.startsWith('*') || /^\d+\s+[a-zA-Z\[]/.test(line) || /^\d+\s+See\s+/.test(line);

    if (isFootnote && idx > lines.length * 0.6) {
      if (!inFootnotes) {
        if (inList) {
          htmlResult += '</ul>';
          inList = false;
        }
        htmlResult += '<div class="footnotes-section" style="margin-top: 40px; padding-top: 20px; border-top: 1px dashed var(--border);">';
        htmlResult += '<h4 style="font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 12px;">References / Footnotes</h4>';
        inFootnotes = true;
      }

      htmlResult += `<div class="footnote-item" style="font-size: 0.9rem; color: var(--muted); margin-bottom: 8px; line-height: 1.5;">${escapeHTML(line)}</div>`;
      continue;
    }

    if (inFootnotes) {
      htmlResult += `<div class="footnote-item" style="font-size: 0.9rem; color: var(--muted); margin-bottom: 8px; line-height: 1.5;">${escapeHTML(line)}</div>`;
      continue;
    }

    const isBulletMarker = line.startsWith('-') || line.startsWith('•') || line.startsWith('*') ||
      /^[a-z0-9]\)\s+/i.test(line) || /^\([a-z0-9]\)\s+/i.test(line);

    let shouldBeListItem = isBulletMarker;
    if (!shouldBeListItem && idx > 0) {
      const prevLine = lines[idx - 1].trim();
      if (prevLine.endsWith(':') && line.length < 150) {
        shouldBeListItem = true;
      } else if (inList && line.length < 150 && !/^\d+\.\s+/.test(line)) {
        shouldBeListItem = true;
      }
    }

    if (shouldBeListItem) {
      if (!inList) {
        htmlResult += '<ul style="margin-bottom: 1.6em; padding-left: 24px;">';
        inList = true;
      }
      const cleaned = line
        .replace(/^[-•*]\s*/, '')
        .replace(/^[a-z0-9]\)\s+/i, '')
        .replace(/^\([a-z0-9]\)\s+/i, '');
      htmlResult += `<li style="margin-bottom: 0.5em; font-family: var(--font-serif); font-size: 1.15rem; line-height: 1.7; color: var(--text);">${escapeHTML(cleaned)}</li>`;
      continue;
    }

    if (inList) {
      htmlResult += '</ul>';
      inList = false;
    }

    const isAllUpper = line.length < 150 && line === line.toUpperCase() && /[A-Z]/.test(line);
    const isNumberHeader = line.length < 120 && (/^\d+\.\s+[A-Z]/i.test(line) || /^[IVXLCDM]+\.\s+[A-Z]/i.test(line));
    const isShortNoPeriod = line.length < 100 && !line.endsWith('.');
    const isDocHeaderLine = idx < 3 && line.length < 120;

    if (isAllUpper || isNumberHeader || isShortNoPeriod || isDocHeaderLine) {
      let level = 3;
      if (idx === 0) {
        level = 2;
      } else if (isAllUpper && line.length < 60) {
        level = 2;
      }

      htmlResult += `<h${level} style="font-family: var(--font-sans); font-weight: 700; color: var(--text); margin-top: 1.6em; margin-bottom: 0.6em; line-height: 1.3;">${escapeHTML(line)}</h${level}>`;
    } else {
      let formattedLine = escapeHTML(line);
      formattedLine = formattedLine.replace(/^(\d+(?:\.\d+)?\s+)/, '<strong>$1</strong>');

      // Assign a stable passage id for each paragraph so front-end can deep-link
      const passageId = `p-${idx}-${Math.abs(hashCode(line)).toString(36)}`;
      if ((line.startsWith('“') && line.endsWith('”')) || (line.startsWith('"') && line.endsWith('"')) || (line.startsWith('‘') && line.endsWith('’')) || (line.startsWith("'") && line.endsWith("'"))) {
        htmlResult += `<p data-passage-id="${passageId}" style="font-family: var(--font-serif); font-size: 1.15rem; line-height: 1.8; color: var(--text); margin-bottom: 1.6em; font-style: italic; padding-left: 20px; border-left: 3px solid var(--primary-light);">${formattedLine}</p>`;
      } else {
        htmlResult += `<p data-passage-id="${passageId}" style="font-family: var(--font-serif); font-size: 1.15rem; line-height: 1.8; color: var(--text); margin-bottom: 1.6em;">${formattedLine}</p>`;
      }
    }
  }

  if (inList) {
    htmlResult += '</ul>';
  }
  if (inFootnotes) {
    htmlResult += '</div>';
  }

  return htmlResult;
}

// Simple string hash for generating stable ids
function hashCode(str) {
  let hash = 0;
  if (!str) return hash;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

function highlightTextInHtml(html, query) {
  if (!html || !query) return html;
  const safeQuery = String(query).trim();
  if (!safeQuery) return html;
  const escapedQuery = safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(${escapedQuery})`, 'ig');
  return html.replace(/>([^<]+)</g, (match, content) => {
    const highlighted = content.replace(pattern, '<mark>$1</mark>');
    return `>${highlighted}<`;
  });
}

function normalizeWhitespace(str) {
  return String(str || '').replace(/\s+/g, ' ').trim();
}

// Truncate a retrieved chunk to a citation excerpt without cutting a
// sentence (or word) in half, so it reads cleanly and matches real
// sentence boundaries in the source document for highlighting.
function truncateExcerpt(text, maxLength = 500) {
  if (!text) return null;
  // Indexed chunks carry a leading "[Table | Title: ... | File: ...]" context
  // header for the LLM prompt — strip it for the citation excerpt, since it
  // never appears in the actual document body and would never highlight.
  const trimmed = String(text).replace(/^\s*\[[^\]]*\]\s*/, '').trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLength) return trimmed;

  const slice = trimmed.slice(0, maxLength);
  const lastSentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastSentenceEnd > maxLength * 0.4) {
    return slice.slice(0, lastSentenceEnd + 1).trim();
  }

  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
}

// Split a retrieved excerpt into individual sentences so each one can be
// located and highlighted independently inside the full document — the
// excerpt as a whole almost never appears as one contiguous run of text
// once formatDocumentContent has re-wrapped the source into paragraphs.
function splitIntoSentences(text) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u201c\u2018])/)
    .map(normalizeWhitespace)
    .filter((sentence) => sentence.length >= 15);
}

// Bold + accent a handful of "important" fragments inside an already-matched
// sentence: quoted defined terms and statutory cross-references, the same
// terms the chat answer view already bolds in the CLA brand green.
function markKeyTerms(text) {
  return text
    .replace(/(\u201c[^\u201d]{3,80}\u201d|\u2018[^\u2019]{3,80}\u2019|"[^"]{3,80}")/g, '<span class="key-term">$1</span>')
    .replace(/\b((?:Section|Sub-section|Clause|Rule|Regulation|Article)\s+\d+[A-Za-z]*(?:\(\d+\))?(?:\([a-z]\))?)\b/gi, (m) => `<span class="key-term">${m}</span>`);
}

// Highlight the passage that was actually retrieved and used to answer the
// user's question, sentence by sentence, so it's obvious at a glance why
// this document was cited — falling back to a plain literal match for
// short, non-sentence highlight queries.
function highlightRelevantExcerpt(html, excerptText) {
  if (!html || !excerptText) return html;
  const trimmedQuery = normalizeWhitespace(excerptText);
  if (!trimmedQuery) return html;

  const sentences = splitIntoSentences(trimmedQuery);
  const phrases = sentences.length > 0 ? sentences : [trimmedQuery];

  let matches = 0;
  const highlighted = html.replace(/>([^<]+)</g, (match, content) => {
    let updated = content;
    for (const phrase of phrases) {
      if (!phrase || matches >= 15) continue;
      const fuzzyPattern = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
      let pattern;
      try {
        pattern = new RegExp(`(${fuzzyPattern})`, 'i');
      } catch (e) {
        continue;
      }
      if (pattern.test(updated)) {
        updated = updated.replace(pattern, (m) => `<mark class="cited-mark">${markKeyTerms(m)}</mark>`);
        matches += 1;
      }
    }
    return `>${updated}<`;
  });

  return matches > 0 ? highlighted : highlightTextInHtml(html, trimmedQuery.length <= 120 ? trimmedQuery : phrases[0]);
}

function renderCitationHTML(data, theme = 'dark', highlightQuery = '') {
  const title = escapeHTML(data.title || 'Untitled Document');
  const sourceTable = escapeHTML(data.source_table || '');
  const recordId = escapeHTML(data.record_id || '');

  const child = data.child || {};
  const parent = data.parent || {};

  const fileName = escapeHTML(child.FileName || parent.FileName || 'N/A');
  const category = escapeHTML(child.Category || parent.Category || 'N/A');
  const subject = escapeHTML(child.Subject || parent.Subject || 'N/A');
  const sections = escapeHTML(child.Sections || parent.Sections || 'N/A');
  const author = escapeHTML(parent.Author || 'N/A');
  const issueYear = escapeHTML(parent.IssueYear || '');
  const issueMonth = escapeHTML(parent.IssueMonth || '');
  const docDate = escapeHTML(parent.DocDate || child.DocDate || '');

  let formattedDate = 'N/A';
  if (docDate) {
    try {
      formattedDate = new Date(docDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
      formattedDate = docDate;
    }
  } else if (issueMonth || issueYear) {
    formattedDate = `${issueMonth} ${issueYear}`.trim();
  }

  const docContent = highlightRelevantExcerpt(formatDocumentContent(data.html), highlightQuery);
  const highlightPreview = normalizeWhitespace(highlightQuery);
  const highlightBanner = highlightPreview
    ? `<div class="highlight-banner" id="highlight-banner">Highlighted passage cited in the answer: <strong>${escapeHTML(highlightPreview.length > 160 ? `${highlightPreview.slice(0, 160)}…` : highlightPreview)}</strong></div>`
    : '';

  const isDarkTheme = theme === 'dark';
  const bodyThemeClass = isDarkTheme ? 'dark-theme' : 'light-theme';
  const themeToggleIcon = isDarkTheme ? '☀' : '☾';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | CLA Online Citation</title>
  <link rel="icon" href="/assets/Images/logo.png" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
  <style>
    /* ============================================================================
       CITATION PAGE THEME SYSTEM - COMPLETELY INDEPENDENT
       Uses class-based theming: body.light-theme or body.dark-theme
       Storage key: citation-theme (independent from chat page)
       ========================================================================== */

    /* ============================================================================
       LIGHT THEME VARIABLES
       ========================================================================== */
    body.light-theme {
      --bg: #f7f7f7;
      --surface: #ffffff;
      --text: #111111;
      --muted: #6e6e6e;
      --border: rgba(0,0,0,0.08);
      --primary: #0C8742;
      --primary-light: rgba(12, 135, 66, 0.08);
      --font-sans: 'Inter', sans-serif;
      --font-serif: 'Lora', Georgia, serif;
    }

    /* ============================================================================
       DARK THEME VARIABLES
       ========================================================================== */
    body.dark-theme {
      --bg: #111111;
      --surface: #151515;
      --text: #fdfdfd;
      --muted: #A3A3A3;
      --border: rgba(255,255,255,0.06);
      --primary: #0C8742;
      --primary-light: rgba(12, 135, 66, 0.06);
      --font-sans: 'Inter', sans-serif;
      --font-serif: 'Lora', Georgia, serif;
    }

    /* ============================================================================
       RESET & BASE STYLES
       ========================================================================== */

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      line-height: 1.6;
      padding: 0;
      margin: 0;
      position: relative;
      min-height: 100vh;
      transition: background-color 0.3s ease, color 0.3s ease;
    }

    /* ============================================================================
       BACKGROUND IMAGE & OVERLAY - REACTIVE TO THEME
       ========================================================================== */
    .chat-background-image {
      position: fixed;
      inset: 0;
      background-image: url("/assets/Images/chatbackground_image.png");
      background-repeat: no-repeat;
      background-position: center;
      background-size: cover;
      pointer-events: none;
      z-index: 0;
      transition: opacity 0.3s ease;
    }

    body.light-theme .chat-background-image {
      opacity: 0.4;
    }

    body.dark-theme .chat-background-image {
      opacity: 0.12;
    }

    .chat-background-tint {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 1;
      transition: background 0.3s ease;
    }

    body.light-theme .chat-background-tint {
      background: transparent;
    }

    body.dark-theme .chat-background-tint {
      background: rgba(0, 0, 0, 0.72);
    }

    /* Premium Top Header */
    .top-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 60px;
      padding: 0 40px;
      background-color: var(--surface);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    
    .nav-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 700;
      color: var(--primary);
      font-size: 1.1rem;
      letter-spacing: 0.04em;
    }

    .nav-brand img {
      height: 28px;
      width: auto;
      object-fit: contain;
    }

    .main-container {
      position: relative;
      z-index: 2;
      max-width: 1000px;
      margin: 40px auto;
      padding: 0 20px;
    }

    .document-card {
      background-color: var(--surface);
      border: 1px solid var(--border);
      border-top: 4px solid var(--primary);
      border-radius: 16px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.02);
      overflow: hidden;
    }

    .header-bar {
      padding: 40px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(to bottom right, var(--surface), var(--bg));
    }

    .highlight-banner {
      margin-bottom: 18px;
      padding: 10px 14px;
      border-radius: 10px;
      border: 1px solid rgba(12, 135, 66, 0.22);
      background: rgba(12, 135, 66, 0.08);
      color: var(--primary);
      font-size: 0.92rem;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.25s ease;
    }

    .highlight-banner.is-active {
      transform: translateY(-2px);
      box-shadow: 0 8px 18px rgba(12, 135, 66, 0.12);
    }

    .highlight-banner mark {
      background: rgba(12, 135, 66, 0.18);
      color: inherit;
      padding: 0 2px;
      border-radius: 4px;
    }

    .badge-row {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    .badge {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      color: var(--muted);
      background-color: var(--surface);
    }

    .badge.primary-badge {
      background-color: var(--primary-light);
      color: var(--primary);
      border-color: rgba(12, 135, 66, 0.15);
    }

    .document-title {
      font-size: 2rem;
      font-weight: 800;
      line-height: 1.3;
      color: var(--text);
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 20px;
      padding: 30px 40px;
      background-color: var(--surface);
      border-bottom: 1px solid var(--border);
    }

    .meta-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .meta-label {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }

    .meta-value {
      font-size: 0.92rem;
      font-weight: 600;
      color: var(--text);
    }

    .content-body {
      padding: 40px 50px;
      background-color: var(--surface);
      font-family: var(--font-serif) !important;
      font-size: 1.15rem !important;
      line-height: 1.8 !important;
      color: var(--text) !important;
    }

    .content-body p, .content-body P {
      font-family: var(--font-serif) !important;
      margin-bottom: 1.6em !important;
      color: var(--text) !important;
      font-size: 1.15rem !important;
      line-height: 1.8 !important;
    }

    .content-body h1, .content-body h2, .content-body h3, .content-body h4,
    .content-body H1, .content-body H2, .content-body H3, .content-body H4 {
      font-family: var(--font-sans) !important;
      color: var(--text) !important;
      font-weight: 700 !important;
      margin-top: 1.8em !important;
      margin-bottom: 0.8em !important;
      line-height: 1.3 !important;
      display: block !important;
    }

    .content-body h1, .content-body H1 { font-size: 1.8rem !important; border-bottom: 1px solid var(--border) !important; padding-bottom: 8px !important; }
    .content-body h2, .content-body H2 { font-size: 1.5rem !important; }
    .content-body h3, .content-body H3 { font-size: 1.25rem !important; }
    .content-body h4, .content-body H4 { font-size: 1.1rem !important; }

    .content-body ul, .content-body ol, .content-body UL, .content-body OL {
      margin-bottom: 1.6em !important;
      padding-left: 28px !important;
    }

    .content-body li, .content-body LI {
      margin-bottom: 0.6em !important;
      font-family: var(--font-serif) !important;
      font-size: 1.15rem !important;
    }

    .content-body table, .content-body TABLE {
      width: 100% !important;
      border-collapse: collapse !important;
      margin: 2.5em 0 !important;
      font-family: var(--font-sans) !important;
      font-size: 0.95rem !important;
    }

    .content-body th, .content-body td, .content-body TH, .content-body TD {
      border: 1px solid var(--border) !important;
      padding: 12px 18px !important;
      text-align: left !important;
    }

    .content-body th, .content-body TH {
      background-color: var(--bg) !important;
      font-weight: 700 !important;
      color: var(--text) !important;
    }

    .content-body blockquote, .content-body BLOCKQUOTE {
      border-left: 4px solid var(--primary) !important;
      padding-left: 20px !important;
      font-style: italic !important;
      color: var(--muted) !important;
      margin: 1.6em 0 !important;
    }

    .content-body a, .content-body A {
      color: var(--primary) !important;
      text-decoration: underline !important;
    }

    /* Cited passage / keyword highlighting — same CLA green used for bolded
       key terms in the chat answer view */
    .content-body mark, .content-body .cited-mark {
      background: rgba(12, 135, 66, 0.16) !important;
      color: var(--text) !important;
      box-shadow: inset 0 0 0 1px rgba(12, 135, 66, 0.3);
      border-radius: 4px;
      padding: 0 3px;
    }

    .content-body .key-term {
      color: var(--primary) !important;
      font-weight: 700 !important;
    }

    .content-body p[data-passage-id].persistent-highlight {
      background: rgba(12, 135, 66, 0.1);
      box-shadow: inset 3px 0 0 var(--primary);
      border-radius: 6px;
      padding: 12px 16px 12px 20px !important;
      margin-left: -20px;
      transition: background 1.4s ease;
    }

    .footer-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 24px 40px;
      background-color: var(--bg);
      border-top: 1px solid var(--border);
    }

    /* Theme toggle button styling */
    #themeToggleBtn, .navbar-theme-btn {
      width: 40px;
      height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      font-size: 1rem;
      transition: all 0.2s ease;
    }

    #themeToggleBtn:hover, .navbar-theme-btn:hover {
      border-color: rgba(12,135,66,0.16);
      background: rgba(12,135,66,0.04);
    }

    #themeToggleBtn:active, .navbar-theme-btn:active {
      transform: scale(0.95);
    }

    /* Citation page scrollbars - themed */
    body::-webkit-scrollbar, .content-body::-webkit-scrollbar {
      width: 12px;
    }

    body::-webkit-scrollbar-track, .content-body::-webkit-scrollbar-track {
      background: transparent;
    }

    body::-webkit-scrollbar-thumb, .content-body::-webkit-scrollbar-thumb {
      background: rgba(12,135,66,0.28);
      border-radius: 999px;
    }

    body::-webkit-scrollbar-thumb:hover, .content-body::-webkit-scrollbar-thumb:hover {
      background: rgba(12,135,66,0.4);
    }

    body {
      scrollbar-width: thin;
      scrollbar-color: rgba(12,135,66,0.28) transparent;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      font-size: 0.9rem;
      font-weight: 600;
      font-family: var(--font-sans);
      border-radius: 8px;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s ease;
      border: none;
    }

    .btn-secondary {
      background-color: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover {
      background-color: var(--border);
    }

    .btn-primary {
      background-color: var(--primary);
      color: #ffffff;
    }

    .btn-primary:hover {
      opacity: 0.9;
    }

    .footer-note {
      font-size: 0.8rem;
      color: var(--muted);
    }

    @media (max-width: 600px) {
      .top-nav {
        padding: 0 20px;
      }
      .main-container {
        margin: 20px auto;
      }
      .header-bar {
        padding: 24px;
      }
      .meta-grid {
        padding: 24px;
        grid-template-columns: 1fr;
      }
      .content-body {
        padding: 24px;
        font-size: 1.05rem;
      }
      .footer-actions {
        padding: 24px;
        flex-direction: column;
        gap: 16px;
        align-items: stretch;
        text-align: center;
      }
    }

    @media print {
      body {
        background-color: #ffffff;
        color: #000000;
        padding: 0;
      }
      .top-nav {
        display: none;
      }
      .document-card {
        border: none;
        box-shadow: none;
      }
      .header-bar {
        background: none;
        color: #000000;
        border-bottom: 2px solid #000000;
        padding: 20px 0;
      }
      .badge {
        color: #000000;
        border: 1px solid #000000;
      }
      .meta-grid {
        background: none;
        padding: 20px 0;
        border-bottom: 1px solid #000000;
      }
      .content-body {
        padding: 20px 0;
      }
      .footer-actions {
        display: none;
      }
    }
  </style>
</head>
<body class="${bodyThemeClass}">
  <div class="chat-background-image" aria-hidden="true"></div>
  <div class="chat-background-tint" aria-hidden="true"></div>

  <header class="top-nav">
    <div class="nav-brand">
      <img src="/assets/Images/logo.png" alt="CLA Corporate Law Adviser">
      <span>CLA Online Legal Database</span>
    </div>
    <button class="navbar-theme-btn" id="themeToggleBtn" type="button">${themeToggleIcon}</button>
  </header>

  <div class="main-container">
    <div class="document-card">
      <div class="header-bar">
        ${highlightBanner}
        <div class="badge-row">
          <span class="badge primary-badge">${sourceTable}</span>
        </div>
        <h1 class="document-title">${title}</h1>
      </div>
      
      <div class="meta-grid">
        <div class="meta-item">
          <span class="meta-label">File Name</span>
          <span class="meta-value">${fileName}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Category</span>
          <span class="meta-value">${category}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Subject</span>
          <span class="meta-value">${subject}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Sections</span>
          <span class="meta-value">${sections}</span>
        </div>
        ${author !== 'Unknown' ? `
        <div class="meta-item">
          <span class="meta-label">Author</span>
          <span class="meta-value">${author}</span>
        </div>
        ` : ''}
        <div class="meta-item">
          <span class="meta-label">Document Date</span>
          <span class="meta-value">${formattedDate}</span>
        </div>
      </div>
      
      <div class="content-body">
        ${docContent}
      </div>
      
      <div class="footer-actions">
        <div>
          <button class="btn btn-secondary" onclick="closeCitationTab()">← Back to AI Chatbot</button>
        </div>
        <div class="footer-note">CLA Online - Verified Grounded Database Source</div>
        <div></div>
      </div>
    </div>
  </div>

  <script>
    // This page always opens in a new tab (target="_blank" / window.open), so
    // it has no same-tab history to go "back" to — close the tab instead, and
    // only fall back to redirecting if the browser refuses to close a tab it
    // didn't script-open (e.g. the user opened this URL directly).
    function closeCitationTab() {
      window.close();
      setTimeout(function () {
        if (!window.closed) {
          window.location.href = '/HTML/chatbot_interface.html';
        }
      }, 300);
    }

    /**
     * =========================================================================
     * CITATION PAGE THEME MANAGER - COMPLETELY INDEPENDENT
     * =========================================================================
     * This theme system is completely self-contained and independent.
     * - Uses dedicated localStorage key: 'citation-theme'
     * - Uses class-based theming: body.light-theme / body.dark-theme
     * - NO dependency on chat page, parent, iframe, or shared state
     * - Manages all theme initialization and toggling
     * =========================================================================
     */

    class CitationThemeManager {
      constructor() {
        this.STORAGE_KEY = 'citation-theme';
        this.LIGHT_THEME = 'light';
        this.DARK_THEME = 'dark';
        this.DEFAULT_THEME = this.LIGHT_THEME;
        this.themeToggleBtn = document.getElementById('themeToggleBtn');
        this.currentTheme = null;
      }

      /**
       * Initialize theme on page load
       */
      init() {
        // Read stored theme or use default
        this.currentTheme = this.getSavedTheme();
        
        // Apply theme immediately (before page renders to avoid flash)
        this.applyTheme(this.currentTheme);
        
        // Attach event listener to theme toggle button
        if (this.themeToggleBtn) {
          this.themeToggleBtn.addEventListener('click', () => this.handleToggleClick());
        }

        // Optional: Listen for changes from other tabs (independent theme only)
        window.addEventListener('storage', (event) => {
          if (event.key === this.STORAGE_KEY && event.newValue) {
            this.currentTheme = event.newValue;
            this.applyTheme(this.currentTheme);
          }
        });
      }

      /**
       * Get saved theme from localStorage
       * @returns {string} 'light' or 'dark'
       */
      getSavedTheme() {
        const saved = localStorage.getItem(this.STORAGE_KEY);

        // Return saved theme if valid
        if (saved === this.LIGHT_THEME || saved === this.DARK_THEME) {
          return saved;
        }

        // No stored preference yet: keep whatever theme the server already
        // rendered (matched to the chat's theme at the time this link was
        // opened) instead of snapping back to the default and flashing.
        if (document.body.classList.contains('dark-theme')) {
          return this.DARK_THEME;
        }
        if (document.body.classList.contains('light-theme')) {
          return this.LIGHT_THEME;
        }

        return this.DEFAULT_THEME;
      }

      /**
       * Apply theme to the page
       * @param {string} theme - 'light' or 'dark'
       */
      applyTheme(theme) {
        const isDark = theme === this.DARK_THEME;

        // Update body class. The CSS keys off "light-theme"/"dark-theme",
        // not the bare "light"/"dark" theme values used for localStorage.
        document.body.classList.remove('light-theme', 'dark-theme');
        document.body.classList.add(isDark ? 'dark-theme' : 'light-theme');

        // Update button icon to show next theme (opposite of current)
        if (this.themeToggleBtn) {
          this.themeToggleBtn.textContent = isDark ? '☀' : '☾';
          this.themeToggleBtn.setAttribute('aria-label', 
            isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'
          );
        }

        // Store the current theme
        this.currentTheme = theme;
        localStorage.setItem(this.STORAGE_KEY, theme);
      }

      /**
       * Handle toggle button click
       */
      handleToggleClick() {
        const nextTheme = this.currentTheme === this.DARK_THEME 
          ? this.LIGHT_THEME 
          : this.DARK_THEME;
        
        this.applyTheme(nextTheme);
      }

      /**
       * Get current theme
       * @returns {string}
       */
      getTheme() {
        return this.currentTheme;
      }

      /**
       * Check if dark mode is active
       * @returns {boolean}
       */
      isDarkMode() {
        return this.currentTheme === this.DARK_THEME;
      }
    }

    // Initialize theme manager as soon as DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        const themeManager = new CitationThemeManager();
        themeManager.init();
        window.citationThemeManager = themeManager; // Expose for debugging
      });
    } else {
      const themeManager = new CitationThemeManager();
      themeManager.init();
      window.citationThemeManager = themeManager;
    }

    // Handle highlight functionality (unrelated to theme, but preserve existing behavior)
    window.addEventListener('load', function() {
      const highlightBanner = document.getElementById('highlight-banner');
      if (highlightBanner) {
        highlightBanner.classList.add('is-active');
      }

      // Jump straight to the first cited-passage highlight in the body, if any,
      // and pulse its containing paragraph so it's easy to spot at a glance.
      const firstMark = document.querySelector('.content-body .cited-mark, .content-body mark');
      const target = firstMark ? firstMark.closest('[data-passage-id]') : null;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('persistent-highlight');
        const removeHighlight = () => {
          target.classList.remove('persistent-highlight');
          window.removeEventListener('click', removeHighlight);
        };
        setTimeout(() => window.addEventListener('click', removeHighlight), 200);
      } else if (highlightBanner) {
        highlightBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  </script>
</body>
</html>`;
}
async function startServer() {
  try {
    const db = await connectDB();
    await ensureIndexes(db);

    const server = http.createServer(async (req, res) => {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-auth-user-id');

      // Handle preflight OPTIONS request
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const path = getRequestPath(req.url || '/');

      if (handleCors(req, res)) {
        return;
      }

      if (await handleAdminRoutes(req, res, db)) {
        return;
      }

      // Serve static files from frontend directory
      if (req.method === 'GET' && (path.startsWith('/assets/') || path.startsWith('/CSS/') || path.startsWith('/javascript/') || path.startsWith('/HTML/'))) {
        const fs = require('fs');
        const pathModule = require('path');
        const filePath = pathModule.join(__dirname, '..', 'frontend', path);
        fs.stat(filePath, (err, stats) => {
          if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
          }
          const ext = pathModule.extname(filePath).toLowerCase();
          let contentType = 'application/octet-stream';
          if (ext === '.html') contentType = 'text/html';
          else if (ext === '.css') contentType = 'text/css';
          else if (ext === '.js') contentType = 'application/javascript';
          else if (ext === '.png') contentType = 'image/png';
          else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
          else if (ext === '.svg') contentType = 'image/svg+xml';
          else if (ext === '.ico') contentType = 'image/x-icon';

          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Access-Control-Allow-Origin': '*'
          });
          fs.createReadStream(filePath).pipe(res);
        });
        return;
      }

      if (path === '/api/attachments/upload' && req.method === 'POST') {
        try {
          const result = await handleAttachmentUpload(req);
          setJsonHeaders(res, 200);
          res.end(JSON.stringify(result));
        } catch (error) {
          console.error('[Attachments] Upload failed:', error.message);
          setJsonHeaders(res, error.statusCode || 500);
          res.end(JSON.stringify({ error: error.message || 'Unable to process the uploaded file(s).' }));
        }
        return;
      }

      if (path === '/health' && req.method === 'GET') {
        setJsonHeaders(res, 200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (path === '/api/citation' && req.method === 'GET') {
        try {
          const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const sourceTable = urlParsed.searchParams.get('sourceTable');
          const recordId = urlParsed.searchParams.get('recordId');
          const parentId = urlParsed.searchParams.get('parentId');
          const highlight = urlParsed.searchParams.get('highlight') || '';
          const theme = urlParsed.searchParams.get('theme') || 'light';

          if (!sourceTable || !recordId) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>400 Bad Request</h1><p>sourceTable and recordId parameters are required.</p>');
            return;
          }

          const citationData = await runPythonCitation(sourceTable, recordId, parentId);

          if (citationData.error) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end(`<h1>404 Citation Not Found</h1><p>${escapeHTML(citationData.error)}</p>`);
            return;
          }

          const htmlResponse = renderCitationHTML(citationData, theme, highlight);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(htmlResponse);
        } catch (error) {
          console.error('[Citation Endpoint] Error:', error);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h1>500 Internal Server Error</h1><p>${escapeHTML(error.message)}</p>`);
        }
        return;
      }

      if (path === '/api/llm/health' && req.method === 'GET') {
        setJsonHeaders(res, 200);
        res.end(JSON.stringify(getProviderHealth()));
        return;
      }

      if (path === '/api/llm/generate' && req.method === 'POST') {
        const lf = await getLogfire();

        try {
          const payload = await getRequestBody(req);
          const provider = payload.provider || settings.DEFAULT_LLM_PROVIDER;
          const model = payload.model || 'default';

          const requestMetadata = req.requestContext ? {
            requestId: req.requestContext.requestId,
            sessionId: req.requestContext.sessionId,
            messageId: req.requestContext.messageId,
          } : {};

          const response = await lf.span(
            'LLM generation request',
            {
              provider,
              model,
              message_count: payload.messages?.length || 0,
              ...requestMetadata,
            },
            {},
            async () => {
              const llm = getLLMProvider(provider, payload.model);

              return traceLLMGeneration(
                {
                  provider,
                  model: payload.model || llm.defaultModel || 'default',
                  messageCount: payload.messages?.length || 0,
                  messages: payload.messages || [],
                  systemPrompt: payload.systemPrompt || '',
                  requestContext: req.requestContext,

                  generate: async () => {
                    return llm.generate({
                      systemPrompt: payload.systemPrompt || '',
                      messages: payload.messages || [],
                      temperature: payload.temperature,
                      maxTokens: payload.maxTokens,
                      modelOverride: payload.modelOverride,
                      requestContext: req.requestContext,
                    });
                  },
                },
                { metadata: requestMetadata }
              );
            }
          );

          lf.info('LLM generation completed', {
            provider,
            model,
            ...requestMetadata,
          });

          setJsonHeaders(res, 200);
          res.end(JSON.stringify(response));
        } catch (error) {
          lf.reportError(
            'LLM generation failed',
            error
          );

          setJsonHeaders(res, 500);
          res.end(JSON.stringify({
            error: error.message || 'LLM request failed.'
          }));
        }

        return;
      }

      if (path === '/api/ask/progress' && req.method === 'GET') {
        const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const requestId = urlParsed.searchParams.get('requestId');
        if (!requestId) {
          setJsonHeaders(res, 400);
          res.end(JSON.stringify({ error: 'requestId parameter is required.' }));
          return;
        }

        const progress = getRequestProgress(requestId);
        setJsonHeaders(res, progress ? 200 : 404);
        res.end(JSON.stringify(progress || { requestId, status: 'not_found', stageIndex: 0, currentStage: 'queued', message: 'Preparing your response', steps: [] }));
        return;
      }

      const progressRouteMatch = path.match(/^\/api\/ask\/progress\/([^/]+)$/);
      if (progressRouteMatch && req.method === 'GET') {
        const requestId = decodeURIComponent(progressRouteMatch[1]);
        const progress = getRequestProgress(requestId);
        setJsonHeaders(res, progress ? 200 : 404);
        res.end(JSON.stringify(progress || { requestId, status: 'not_found', stageIndex: 0, currentStage: 'queued', message: 'Preparing your response', steps: [] }));
        return;
      }

      if (path === '/api/ask' && req.method === 'POST') {
        // Wrap entire RAG request in comprehensive tracing
        const executeRAGRequest = async () => {
          const payload = await getRequestBody(req);
          const requestId = payload?.requestId || payload?.request_id || null;
          req.requestContext = createRequestContext({
            sessionId: payload?.session_id || null,
            messageId: null,
            requestId,
          });
          const question = payload.question;
          // Distinguishes real end-user chatbot traffic from internal callers
          // (currently: the Golden Dataset offline benchmark runner, which
          // drives this same endpoint in a loop) so evaluations they produce
          // never mix into the live Online Eval view — see requestSource use
          // in buildEvaluationResultDocument below.
          const requestSource = payload?.source === 'golden_dataset' ? 'golden_dataset' : 'cla_chat';

          if (!question || typeof question !== 'string' || !question.trim()) {
            setJsonHeaders(res, 400);
            res.end(JSON.stringify({ error: 'Question parameter is required and cannot be empty.' }));
            return;
          }

          const progressRequestId = requestId || req.requestContext?.requestId || `req-${randomUUID()}`;
          req.requestContext.requestId = progressRequestId;
          updateRequestProgress(progressRequestId, {
            stageIndex: 0,
            currentStage: 'queued',
            message: 'Preparing your response...',
            status: 'in_progress',
          });

          console.log(`[RAG Endpoint] Received question: "${question.trim()}"`);

          const attachmentContext = buildAttachmentContextBlock(payload.attachments);
          if (attachmentContext) {
            console.log(`[RAG Endpoint] Using ${payload.attachments.length} attachment(s) as supplementary context.`);
          }

          const serverLogs = [];

          // Run guardrails early to avoid expensive operations for blocked requests.
          let guardrailResult = null;
          const guardrailStartedAt = Date.now();
          try {
            const { checkGuardrails } = require('./guardrails');
            guardrailResult = await traceGuardrails({
              question: question.trim(),
              checkGuardrails: async () => {
                return await checkGuardrails(question.trim());
              },
              requestContext: req.requestContext,
              metadata: {
                component: 'guardrails',
                requestId: req.requestContext.requestId,
                sessionId: req.requestContext.sessionId,
              },
            });

            const guardrailTimeMs = Date.now() - guardrailStartedAt;
            serverLogs.push({
              step: 1,
              agent: 'Safety Guardrail Agent',
              title: 'Step 1: Safety & Compliance Check',
              status: guardrailResult?.action === 'RESPOND' ? 'blocked' : 'completed',
              timeMs: guardrailTimeMs,
              provider: 'groq',
              model: 'llama-3.3-70b-versatile',
              agentRole: 'Intent Router & Safety Filter',
              agentMandate: 'Acts as the first line of defense. Classifies the user message into one of five routes: OFF_TOPIC (not Indian corporate/commercial law), JAILBREAK (attempts to extract prompts or break rules), SENSITIVE (personal legal advice or harmful content), DIALOG (greetings/help/bye), or LEGAL (genuine legal research). Blocks non-LEGAL queries immediately before any retrieval or generation runs.',
              agentInput: 'Raw user question (verbatim)',
              agentOutput: 'Route decision (LEGAL / OFF_TOPIC / JAILBREAK / SENSITIVE / DIALOG). If LEGAL, passes to Query Expansion Agent.',
              summary: guardrailResult?.action === 'RESPOND'
                ? `Safety system flagged query in category "${guardrailResult.category || 'policy'}". Workflow stopped.`
                : 'Checked user question for safety, tone, and corporate law relevance. Approved to proceed.',
              details: {
                action: guardrailResult?.action || 'PASS',
                category: guardrailResult?.category || guardrailResult?.route || 'PASS',
                response: guardrailResult?.response || null,
              },
            });

            if (guardrailResult) {
              console.log('[NeMo Guardrails] Action:', guardrailResult.action, 'Category:', guardrailResult.category);
              if (guardrailResult.action === 'RESPOND') {
                console.log('[RAG Endpoint] Guardrail handled request. Skipping retrieval and generation.');

                // Guardrail-blocked turns never reach retrieval/generation, so
                // there's no context or answer to run RAGAS against — persist
                // with a distinct 'blocked' status and null metrics instead of
                // scoring nothing. Still recorded so every chatbot question
                // (not just the ones that hit cache/DB) shows up in Online Eval.
                try {
                  const guardrailEvaluation = {
                    faithfulness: null,
                    faithfulnessReason: 'Guardrail blocked query: zero chunks retrieved.',
                    contextPrecision: null,
                    contextPrecisionReason: 'Guardrail blocked query: zero chunks retrieved.',
                    contextRecall: null,
                    contextRecallReason: 'Guardrail blocked query: zero chunks retrieved.',
                    answerRelevancy: null,
                    answerRelevancyReason: 'Guardrail blocked query: zero chunks retrieved.',
                    piiLeakage: null,
                    piiLeakageReason: 'Guardrail blocked query: zero chunks retrieved.',
                    overallScore: null,
                    status: 'blocked',
                  };

                  const guardrailDocument = buildEvaluationResultDocument({
                    requestContext: req.requestContext,
                    question: question.trim(),
                    answer: guardrailResult.response || null,
                    evaluation: guardrailEvaluation,
                    provider: null,
                    model: null,
                    contexts: [],
                    evaluationStatus: 'blocked',
                    metadata: { guardrailCategory: guardrailResult.category || guardrailResult.route || null },
                    source: requestSource,
                    serverLogs,
                  });
                  persistEvaluationResult(db, guardrailDocument, io).catch((persistError) => {
                    console.error('[RAG Endpoint] Failed to persist guardrail-blocked evaluation:', persistError);
                  });
                } catch (buildError) {
                  console.error('[RAG Endpoint] Failed to build guardrail-blocked evaluation document:', buildError);
                }

                updateRequestProgress(progressRequestId, {
                  stageIndex: 5,
                  currentStage: 'completed',
                  message: 'Finalizing your response...',
                  status: 'completed',
                });

                setJsonHeaders(res, 200);
                res.end(JSON.stringify({
                  answer: guardrailResult.response || 'Your request cannot be processed.',
                  route: guardrailResult.route || guardrailResult.category || 'REFUSE',
                  guardrail: {
                    triggered: true,
                    category: guardrailResult.category || guardrailResult.route
                  },
                  suggestions: [],
                  sources: [],
                  searchResults: [],
                  evaluation: null
                }));
                return;
              }
            }
          } catch (gErr) {
            console.error('[RAG Endpoint] Guardrails error:', gErr?.message || gErr);
            updateRequestProgress(progressRequestId, {
              stageIndex: 5,
              currentStage: 'completed',
              message: 'Finalizing your response...',
              status: 'failed',
            });
            await traceError({
              errorType: 'GuardrailsError',
              errorMessage: gErr?.message || String(gErr),
              component: 'guardrails',
              requestId: req.requestContext.requestId,
              sessionId: req.requestContext.sessionId,
            });
            setJsonHeaders(res, 500);
            res.end(JSON.stringify({ error: 'Guardrails check failed.' }));
            return;
          }
          let results;
          let retrievalStartedAt = null;
          let retrievalTimeMs = null;

          try {
            // ----------------------------------------------------------
            // Query Expansion Agent
            // ----------------------------------------------------------
            // Expand the user's legal query before retrieval.
            // If expansion fails, expandLegalQuery() safely falls back
            // to the original user question.
            const { expandLegalQuery } = require('./agentSystem');

            updateRequestProgress(progressRequestId, {
              stageIndex: 1,
              currentStage: 'understanding',
              message: 'Understanding your question',
              status: 'in_progress',
            });

            const expansionStartedAt = Date.now();
            const queryExpansion = await traceQueryExpansion({
              originalQuestion: question.trim(),
              expandLegalQuery: async () => {
                return await expandLegalQuery(question.trim());
              },
              requestContext: req.requestContext,
              metadata: {
                component: 'query_expansion',
                requestId: req.requestContext.requestId,
                sessionId: req.requestContext.sessionId,
              },
            });
            const expansionTimeMs = Date.now() - expansionStartedAt;

            const expandedQuery =
              queryExpansion.expandedQuery || question.trim();

            const expansionKeywords =
              Array.isArray(queryExpansion.keywords)
                ? queryExpansion.keywords
                : [];

            serverLogs.push({
              step: 2,
              agent: 'Query Expansion Agent',
              title: 'Step 2: Query Expansion & Legal Understanding',
              status: 'completed',
              timeMs: expansionTimeMs,
              provider: settings.DEFAULT_LLM_PROVIDER || 'deepseek',
              model: settings.DEFAULT_LLM_MODEL || 'deepseek-v4-pro',
              agentRole: 'Legal NLP & Semantic Enrichment Specialist',
              agentMandate: 'Transforms the raw user question into a canonical, statutory-enriched query paragraph optimized for hybrid (Dense Vector + BM25) retrieval. Maps informal or misspelled terms to exact statutory titles (e.g. "company act" → "Companies Act, 2013"), bridges section numbers to their topic names (e.g. Section 135 ↔ CSR), and extracts structured metadata filters (Act, Regulator, Court). Never answers the question — solely enriches it for the retrieval engine.',
              agentInput: 'Classified user question (route = LEGAL) from Safety Guardrail Agent',
              agentOutput: 'EXPANDED_QUERY (rich canonical paragraph), KEYWORDS (statutory terms list), SUGGESTED_FILTERS (Act/Regulator/Court), CLARIFYING_QUESTION (if needed)',
              summary: 'Analyzed your question and expanded it with key Indian statutory section numbers, legal synonyms, and technical keywords for maximum database coverage.',
              details: {
                originalQuery: question.trim(),
                expandedQuery: expandedQuery,
                keywords: expansionKeywords,
                suggestedFilters: queryExpansion.suggestedFilters || 'None',
              },
            });

            console.log(
              '[RAG Endpoint] Query expansion result:',
              {
                originalQuery: question.trim(),
                expandedQuery,
                keywords: expansionKeywords,
                suggestedFilters:
                  queryExpansion.suggestedFilters || ''
              }
            );

            // Build a retrieval query using the expanded legal query
            // together with the extracted legal keywords.
            const retrievalQuery = [
              expandedQuery,
              ...expansionKeywords
            ]
              .filter(Boolean)
              .join(' ');

            console.log(
              `[RAG Endpoint] Retrieval query: "${retrievalQuery}"`
            );

            // Prioritized legal document retrieval: Legislation table (max 3-4 chunks) + all other tables (max 5 chunks)
            updateRequestProgress(progressRequestId, {
              stageIndex: 2,
              currentStage: 'retrieving',
              message: 'Finding relevant information',
              status: 'in_progress',
            });
            retrievalStartedAt = Date.now();
            results = await traceRetrieval({
              query: retrievalQuery,
              topK: 9,
              performSearch: async () => {
                return await performPrioritizedLegalSearch(retrievalQuery, question, expansionKeywords);
              },
              requestContext: req.requestContext,
              metadata: {
                component: 'prioritized_retrieval',
                requestId: req.requestContext.requestId,
                sessionId: req.requestContext.sessionId,
              },
            });
            retrievalTimeMs = Date.now() - retrievalStartedAt;

            const legislationResults = results?.legislationResults || [];
            const otherResults = results?.otherResults || [];
            const candidateCount = results?.candidateCount || 0;

            serverLogs.push({
              step: 3,
              agent: 'Document Retrieval & Legal Reranker Agent',
              title: 'Step 3: Database Search & Prioritized Legal Reranking',
              status: Array.isArray(results) && results.length > 0 ? 'completed' : 'failed',
              timeMs: retrievalTimeMs,
              provider: 'FastEmbed / Cohere Reranker',
              model: 'text-embedding-3-large',
              agentRole: 'Multi-Table Retrieval & Per-Table Reranker',
              agentMandate: 'Searches all 8 legal source tables (Article, Caselaw, Circular, Commentary, Procedure, Legislation, Notification, Query) using the expanded query. Applies a per-table cap of top 5 most relevant chunks per table, ensuring balanced coverage across all source types. Uses Cohere Rerank API (v3.5) for semantic relevance scoring, with a local heuristic reranker as fallback.',
              agentInput: 'Expanded legal query + keywords from Query Expansion Agent',
              agentOutput: 'Ranked list of top-5 chunks per source table, passed as context to the CLA Legal Advisor Agent',
              summary: `Per-table retrieval: top 5 chunks from Legislation + top 5 per other table (${otherResults.length} chunks across other tables). Total ${results.length} verified legal sources fed to answer generation.`,

              details: {
                retrievalQuery: retrievalQuery,
                candidatesFound: candidateCount,
                legislationCount: legislationResults.length,
                otherTablesCount: otherResults.length,
                topRerankedCount: results.length,
                topSourcesPreview: Array.isArray(results) ? results.map((r, idx) => ({
                  rank: idx + 1,
                  table: r.source_table || 'Unknown',
                  title: r.doc_title || 'Untitled',
                  sections: r.sections || 'General',
                  score: r.backend_relevance_score ? Number(r.backend_relevance_score).toFixed(2) : '—'
                })) : []
              },
            });

            console.log(
              `[RAG Endpoint] Retrieved ${candidateCount} candidates (${legislationResults.length} legislation + ${otherResults.length} other tables) and reranked to ${results.length} results.`
            );

            const retrievalLogDocument = buildRetrievalLogDocument({
              requestContext: req.requestContext,
              query: retrievalQuery,
              retrievalTime: null,
              topK: Array.isArray(results) ? results.length : null,
              retrievedChunks: Array.isArray(results)
                ? results.map((result, index) => ({
                    chunkId: result?.chunk_id || result?.chunkId || null,
                    documentId: result?.doc_id || result?.documentId || result?.source || null,
                    rank: index + 1,
                    similarityScore: result?.score ?? result?.similarity_score ?? null,
                    content: result?.chunk_text || result?.content || result?.text || null,
                  }))
                : [],
            });

            persistRetrievalLog(db, retrievalLogDocument).catch((error) => {
              console.error('[Retrieval] Background logging failed:', error);
            });

            console.log(
              '[RAG Endpoint] Backend reranked results:',
              results.map((result, index) => ({
                rank: index + 1,
                title: result.doc_title || 'Untitled',
                sections: result.sections || null,
                backend_relevance_score:
                  result.backend_relevance_score,
                retrieval_score:
                  result.score || result.rrf_score || null
              }))
            );
          } catch (searchErr) {
            console.error('[RAG Endpoint] Search execution failed:', searchErr);
            setJsonHeaders(res, 500);
            res.end(JSON.stringify({ error: 'Failed to search legal documents database.' }));
            return;
          }

          try {
            if ((!results || results.length === 0) && !attachmentContext) {
            console.log('[RAG Endpoint] No documents matched the query and no attachment context available.');
            setJsonHeaders(res, 200);
            res.end(JSON.stringify({
              answer: 'I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question.',
              sources: []
            }));
            return;
          }

          console.log(`[RAG Endpoint] Found ${results.length} matching document chunks. Generating answer...`);

          // Format search context
          const contextBlock = results.map((r, idx) => {
            const sourceIndex = idx + 1;
            const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
            const fileName = (r.original && r.original.child && r.original.child.FileName) ||
              (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
            const category = r.category || 'Unknown';
            const subject = r.subject || 'Unknown';
            const sections = r.sections || 'Unknown';

            return `[Source ${sourceIndex}] Title: "${title}" | File: ${fileName} | Sections: ${sections} | Category: ${category} | Subject: ${subject}\nContent: ${r.chunk_text}`;
          }).join('\n\n---\n\n');

          // Build Grounded LLM Prompt
          const attachmentPromptRules = attachmentContext
            ? `\n\nThe user has also attached one or more documents (see ATTACHED DOCUMENT CONTEXT below). You may draw on their content, but only to the extent it concerns corporate/commercial law matters within your scope as CLA. If an attached document is unrelated to corporate law (e.g. personal, unrelated business, or off-topic content), disregard it and rely on the Search Context alone. Do not use numbered citation tags like [1] for attached document content — those are reserved for the Search Context sources; refer to attached material in prose instead (e.g. "the agreement you attached").`
            : '';

          const { loadAgentPrompts } = require('./agentSystem');
          const agentPrompts = loadAgentPrompts();
          const baseSummarizerPrompt = agentPrompts.Content_Summarizer_Agent || `You are a professional legal research assistant for Indian corporate and commercial law. Answer STRICTLY from the Search Context only — never from your own knowledge. Read ALL chunks and combine relevant information into one answer. Write in a clean, flowing legal-memo style: start directly with a 2-3 sentence legal answer, use bold thematic section headers, cite [Source N] inline (max 1-2 citations per bracket), and end with "This is legal research, not legal advice. Please verify against the primary source." Only output "I could not find authority on this in the CLAOnline database." if every chunk is completely unrelated to the question.`;

          const formattingRules = `

CRITICAL READABILITY & FORMATTING RULES:
1. NO META OPENING: NEVER start your answer with "Based solely on...", "Based on the retrieved...", "According to the database...", or any meta-disclaimer. Start IMMEDIATELY with a direct 2-3 sentence legal answer.
2. MINIMAL CLEAN INLINE CITATIONS: Keep inline citations concise. Cite at most 1 to 2 specific source numbers per statement (e.g. [Source 1] or [Source 1, 2]). NEVER output long strings or ranges of citations like [Source 6, 7, 8, 9, 10, 11, 12...].
3. NO MANUAL SOURCES SECTION: Do NOT output a manual "**Sources:**" text section or bullet list at the end of your answer. The user interface automatically renders the interactive Source Citations panel below your message.
4. MANDATORY FOLLOW-UP QUESTIONS: At the very end of your response, ALWAYS append the exact tag '---SUGGESTIONS---' followed by 3 relevant follow-up questions the user might ask next, one per line.
Example:
---SUGGESTIONS---
What are the requirements for board resolutions under Section 135?
Are private companies exempt from these regulations?
What is the penalty for violating this provision?`;

          const systemPrompt = `${baseSummarizerPrompt}${attachmentPromptRules}${formattingRules}`;

          // Answer synthesis: DeepSeek v4 Pro primary
          const llm = getLLMProvider('deepseek', settings.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro');


          const userContentParts = [`Question: ${question}`];
          if (contextBlock) {
            userContentParts.push(`Search Context:\n${contextBlock}`);
          }
          if (attachmentContext) {
            userContentParts.push(`ATTACHED DOCUMENT CONTEXT:\n${attachmentContext}`);
          }

          // Trace prompt construction
          await tracePromptConstruction({
            question: question,
            systemPrompt: systemPrompt,
            context: contextBlock || '(no retrieved context)',
            attachmentContext: attachmentContext || '(no attachments)',
            requestContext: req.requestContext,
            metadata: {
              component: 'prompt_construction',
              requestId: req.requestContext.requestId,
              sessionId: req.requestContext.sessionId,
            },
          });

          let llmResponse = null;
          let llmStartedAt = null;
          let llmTimeMs = null;
          let answerText = '';
          let suggestions = [];

          const userContent = userContentParts.join('\n\n');

          const endpointFallbackTiers = [
            { provider: 'deepseek', model: settings.DEFAULT_LLM_MODEL || 'deepseek-v4-pro' },
          ];

          const uniqueTiers = [];
          const seenTiers = new Set();
          for (const tier of endpointFallbackTiers) {
            const key = `${tier.provider}:${tier.model}`;
            if (!seenTiers.has(key)) {
              seenTiers.add(key);
              uniqueTiers.push(tier);
            }
          }

          let lastLLMErr = null;

          for (const tier of uniqueTiers) {
            try {
              llmStartedAt = Date.now();
              const currentLlm = getLLMProvider(tier.provider, tier.model);

              llmResponse = await traceLLMGeneration({
                provider: currentLlm.constructor.name,
                model: tier.model,
                systemPrompt: systemPrompt,
                userContent: userContent,
                temperature: 0.1,
                maxTokens: 2048,
                generate: async () => {
                  return await currentLlm.generate({
                    systemPrompt: systemPrompt,
                    messages: [{ role: 'user', content: userContent }],
                    temperature: 0.1,
                    maxTokens: 2048
                  });
                },
                requestContext: req.requestContext,
                metadata: {
                  component: 'llm_generation',
                  requestId: req.requestContext.requestId,
                  sessionId: req.requestContext.sessionId,
                },
              });
              llmTimeMs = Date.now() - llmStartedAt;

              const candidateText =
                llmResponse?.content ||
                llmResponse?.text ||
                llmResponse?.response ||
                llmResponse?.message?.content ||
                llmResponse?.choices?.[0]?.message?.content ||
                '';

              if (candidateText && candidateText.trim().length > 0) {
                answerText = candidateText;
                console.log(
                  '[RAG Endpoint] Raw LLM response:',
                  JSON.stringify(llmResponse, null, 2)
                );
                console.log(
                  '[RAG Endpoint] Extracted answer length:',
                  answerText.length
                );
                console.log(`[RAG Endpoint] Answer generated successfully using ${llmResponse?.provider || tier.provider} (${llmResponse?.model || tier.model}).`);
                break;
              }

              console.warn(`[RAG Endpoint] Provider ${tier.provider} (${tier.model}) returned empty answer. Trying fallback tier...`);
            } catch (err) {
              lastLLMErr = err;
              console.warn(`[RAG Endpoint] LLM generation failed for ${tier.provider} (${tier.model}): ${err?.message || err}. Trying fallback tier...`);
            }
          }

          if (!answerText || !answerText.trim()) {
            console.error(
              '[RAG Endpoint] All LLM provider fallbacks failed or returned empty answers. RAGAS evaluation skipped.'
            );
            await traceError({
              errorType: 'LLMGenerationError',
              errorMessage: lastLLMErr?.message || 'All LLM providers returned empty answers.',
              component: 'llm_generation',
              requestId: req.requestContext.requestId,
              sessionId: req.requestContext.sessionId,
            });
            setJsonHeaders(res, 502);
            res.end(JSON.stringify({
              error: 'All LLM providers failed or returned an empty answer.',
              provider: llmResponse?.provider || settings.DEFAULT_LLM_PROVIDER,
              model: llmResponse?.model || settings.DEFAULT_LLM_MODEL
            }));
            return;
          }
          console.log('[RAG Endpoint] Answer generated successfully.');

          updateRequestProgress(progressRequestId, {
            stageIndex: 4,
            currentStage: 'preparing',
            message: 'Preparing your answer',
            status: 'in_progress',
          });

          const parsedResponse =
            parseAnswerAndSuggestions(answerText);

          answerText = parsedResponse.answer;
          suggestions = parsedResponse.suggestions;

          console.log(
            `[RAG Endpoint] Extracted ${suggestions.length} suggestions.`
          );

          serverLogs.push({
            step: 4,
            agent: 'CLA Legal Advisor Agent',
            title: 'Step 4: CLA Answer Generation & Citation',
            status: 'completed',
            timeMs: llmTimeMs,
            provider: llmResponse?.provider || settings.DEFAULT_LLM_PROVIDER,
            model: llmResponse?.model || settings.DEFAULT_LLM_MODEL,
            agentRole: 'Content Summarizer & Legal Answer Writer (Content_Summarizer_Agent)',
            agentMandate: 'Synthesizes the final legal answer STRICTLY from the retrieved document chunks — never from its own training knowledge. Reads ALL retrieved chunks and combines relevant information into one coherent answer written in legal-memo style. Respects the authority hierarchy (Primary Legislation > Notification > Circular > Judicial decisions by court rank > Secondary/editorial). Cites inline using [Source N] (max 1–2 citations per bracket). Also generates 3–4 follow-up questions via the Follow_Up_Question_Agent.',
            agentInput: 'Top-3-per-table reranked document chunks + user question + Content_Summarizer_Agent system prompt',
            agentOutput: 'Structured legal answer with inline citations + 3 suggested follow-up questions',
            summary: 'Synthesized a clear, grounded legal answer with inline numerical citations [1], [2] based strictly on the retrieved document context.',
            details: {
              provider: llmResponse?.provider || settings.DEFAULT_LLM_PROVIDER,
              model: llmResponse?.model || settings.DEFAULT_LLM_MODEL,
              sourcesUsed: results.length,
              suggestionsGenerated: suggestions.length,
              answerLength: answerText.length,
              systemPrompt: systemPrompt,
              userPrompt: userContent,
            },
          });

          const ragasContexts = results
            .map(r => r.chunk_text || r.content || r.text || '')
            .filter(context => context && context.trim());

          const goldenDataset = db.collection('golden_dataset');
          const goldenRecord = await goldenDataset.findOne({ question });
          const currentDatasetVersion = await getCurrentGoldenDatasetVersion(db);

          let evaluation = { status: 'pending' };

          const runEvaluationAndPersist = async () => {
              const evaluationStartedAt = Date.now();
              const isEvaluationEnabled = await getEvaluationToggle(db);

              if (!isEvaluationEnabled) {
                console.log('[Eval] Online evaluation toggle is turned OFF by Admin (Token Saver Active). Skipping LLM Judge evaluation.');
                evaluation = {
                  status: 'completed',
                  metricsCalculated: false,
                  faithfulness: null,
                  answerRelevancy: null,
                  contextPrecision: null,
                  contextRecall: null,
                  piiLeakage: null,
                  overallScore: null,
                  judgeProvider: 'deepseek',
                  judgeModel: 'deepseek-chat',
                  evaluationTimeMs: 0,
                };

                serverLogs.push({
                  step: 5,
                  agent: 'AI Quality Judge Agent',
                  title: 'Step 5: Quality Assessment (Skipped - Token Saver Active)',
                  status: 'completed',
                  timeMs: 0,
                  provider: 'deepseek',
                  model: 'deepseek-chat',
                  summary: 'RAGAS quality metrics scoring was disabled by Admin to save LLM tokens. Execution completed without judge evaluation.',
                  details: {
                    metricsCalculated: false,
                    reason: 'Admin Evaluation Toggle is turned OFF (Token Saver Mode)',
                  },
                });
              } else {
                try {
                  console.log(
                    `[Eval] Starting 5-metric evaluation with ${ragasContexts.length} contexts...`
                  );

                  evaluation = await runFullEvaluation({
                    question,
                    answer: answerText,
                    contexts: ragasContexts,
                    groundTruth: goldenRecord?.answer || null,
                    requestContext: req.requestContext,
                  });

                  evaluation.metricsCalculated = true;

                  console.log(
                    '[Eval] Evaluation completed:',
                    JSON.stringify(evaluation, null, 2)
                  );
                } catch (evaluationError) {
                  console.error(
                    '[Eval] Evaluation failed:',
                    evaluationError
                  );

                  evaluation = {
                    status: 'failed',
                    metricsCalculated: false,
                    errors: [evaluationError.message],
                  };
                }

                const evaluationTimeMs = Number.isFinite(evaluation?.evaluationTimeMs) ? evaluation.evaluationTimeMs : (Date.now() - evaluationStartedAt);
                const evaluationStatus = evaluation?.status === 'failed' ? 'failed' : 'completed';

                serverLogs.push({
                  step: 5,
                  agent: 'AI Quality Judge Agent',
                  title: 'Step 5: Quality Assessment & RAGAS Metric Scoring',
                  status: evaluationStatus,
                  timeMs: evaluationTimeMs,
                  provider: evaluation?.judgeProvider || 'deepseek',
                  model: evaluation?.judgeModel || 'deepseek-chat',
                  summary: evaluationStatus === 'completed'
                    ? 'Evaluated response accuracy across 5 key quality metrics (Faithfulness, Relevancy, Context Precision, Recall, and PII Protection).'
                    : 'Metric quality evaluation failed or did not finish.',
                  details: {
                    metricsCalculated: true,
                    faithfulness: evaluation?.faithfulness ?? null,
                    answerRelevancy: evaluation?.answerRelevancy ?? null,
                    contextPrecision: evaluation?.contextPrecision ?? null,
                    contextRecall: evaluation?.contextRecall ?? null,
                    piiLeakage: evaluation?.piiLeakage ?? null,
                    reasons: {
                      faithfulnessReason: evaluation?.faithfulnessReason || null,
                      answerRelevancyReason: evaluation?.answerRelevancyReason || null,
                      contextPrecisionReason: evaluation?.contextPrecisionReason || null,
                      contextRecallReason: evaluation?.contextRecallReason || null,
                      piiLeakageReason: evaluation?.piiLeakageReason || null,
                    },
                  },
                });
              }

              try {
                const evaluationDocument = buildEvaluationResultDocument({
                  requestContext: req.requestContext,
                  question,
                  answer: answerText,
                  goldenAnswer: payload?.goldenAnswer || payload?.golden_answer || null,
                  evaluation,
                  provider: llmResponse?.provider || settings.DEFAULT_LLM_PROVIDER,
                  model: llmResponse?.model || settings.DEFAULT_LLM_MODEL,
                  contexts: ragasContexts,
                  retrievedChunks: ragasContexts,
                  retrievedChunkIds: Array.isArray(results) ? results.map((result) => result.embedding_id || result.record_id || result.parent_id || null).filter(Boolean) : [],
                  similarityScores: Array.isArray(results) ? results.map((result) => (Number.isFinite(result?.score) ? result.score : (Number.isFinite(result?.rrf_score) ? result.rrf_score : null))).filter((value) => value !== null) : [],
                  retrievalTime: retrievalTimeMs ?? null,
                  datasetVersion: currentDatasetVersion || goldenRecord?.version || null,
                  userId: getAuthenticatedUserId(req),
                  evaluationStatus,
                  evaluationTimeMs,
                  suggestions,
                  metadata: {
                    retrievalTime: retrievalTimeMs ?? null,
                    llmTime: llmTimeMs ?? null,
                  },
                  source: requestSource,
                  serverLogs,
                });

                await persistEvaluationResult(db, evaluationDocument, io);

                if (goldenRecord) {
                  const goldenRunDocument = {
                    datasetVersion: goldenRecord.version || null,
                    questionId: goldenRecord.id || null,
                    question: goldenRecord.question || question,
                    chatbotAnswer: answerText,
                    referenceAnswer: goldenRecord.answer || null,
                    retrievedChunks: ragasContexts,
                    retrievedChunkIds: Array.isArray(results) ? results.map((result) => result.embedding_id || result.record_id || result.parent_id || null).filter(Boolean) : [],
                    similarityScores: Array.isArray(results) ? results.map((result) => (Number.isFinite(result?.score) ? result.score : (Number.isFinite(result?.rrf_score) ? result.rrf_score : null))).filter((value) => value !== null) : [],
                    ragasMetrics: {
                      faithfulness: evaluation.faithfulness ?? null,
                      answerRelevancy: evaluation.answerRelevancy ?? null,
                      contextPrecision: evaluation.contextPrecision ?? null,
                      contextRecall: evaluation.contextRecall ?? null,
                      piiLeakage: evaluation.piiLeakage ?? null,
                    },
                    retrievalTime: retrievalTimeMs ?? null,
                    llmTime: llmTimeMs ?? null,
                    datasetVersion: currentDatasetVersion || goldenRecord?.version || null,
                    provider: llmResponse?.provider || settings.DEFAULT_LLM_PROVIDER || null,
                    model: llmResponse?.model || settings.DEFAULT_LLM_MODEL || null,
                    timestamp: new Date().toISOString(),
                    status: 'completed',
                  };

                  await persistGoldenDatasetRun(db, goldenRunDocument);
                }
              } catch (persistError) {
                console.error('[Eval] Persist evaluation document failed:', persistError);
              }
          };

          // Real end-user chat traffic gets a fast response — evaluation runs
          // in the background so it never delays the answer. The Golden
          // Dataset benchmark runner, on the other hand, explicitly needs the
          // finished evaluation back in this response (that's the whole point
          // of an offline benchmark run) and already waits out the full
          // batch — so for that source only, run and persist evaluation
          // inline before responding, instead of via fire-and-forget
          // setImmediate.
          if (requestSource === 'golden_dataset') {
            console.log('[Eval] Running evaluation synchronously (golden_dataset source)...');
            await runEvaluationAndPersist();
          } else {
            setImmediate(() => {
              console.log('[Eval] Background evaluation started...');
              runEvaluationAndPersist().catch((backgroundError) => {
                console.error('[Eval] Background evaluation crashed:', backgroundError);
              });
            });
          }
          // Build sources array for all retrieved chunks (preserves 1-to-1 mapping with text sources list)
          const allSources = [];

          if (Array.isArray(results)) {
            results.forEach((r, idx) => {
              const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
              const fileName =
                (r.original && r.original.child && r.original.child.FileName) ||
                (r.original && r.original.parent && r.original.parent.FileName) ||
                'Unknown';

              const getCategory = (res) => {
                const cat = res.category || (res.original && res.original.parent && res.original.parent.Category) || null;
                if (cat && (String(cat).includes('text-embedding') || String(cat).includes('embedding-3'))) return null;
                return cat;
              };

              allSources.push({
                title,
                filename: fileName,
                source_table: r.source_table,
                record_id: r.record_id,
                parent_id: r.parent_id,
                excerpt: truncateExcerpt(r.chunk_text),
                author: (r.original && r.original.parent && r.original.parent.Author) || null,
                sections: r.sections || (r.original && r.original.parent && r.original.parent.Sections) || null,
                category: getCategory(r),
                subject: r.subject || (r.original && r.original.parent && r.original.parent.Subject) || null,
                doc_date: r.doc_date || (r.original && r.original.parent && r.original.parent.DocDate) || null,
                vol: (r.original && r.original.parent && r.original.parent.Vol) || null,
                issue_month: (r.original && r.original.parent && r.original.parent.IssueMonth) || null,
                issue_year: (r.original && r.original.parent && r.original.parent.IssueYear) || null
              });
            });
          }

          updateRequestProgress(progressRequestId, {
            stageIndex: 5,
            currentStage: 'completed',
            message: 'Finalizing your response',
            status: 'completed',
          });

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({
            requestId: req.requestContext?.requestId || null,
            answer: answerText,
            suggestions: normalizeFollowUpQuestions({ follow_up_questions: suggestions }),
            follow_up_questions: normalizeFollowUpQuestions({ follow_up_questions: suggestions }),
            sources: allSources,
            searchResults: results.map(r => ({
              embedding_id: r.embedding_id,
              source_table: r.source_table,
              record_id: r.record_id,
              parent_id: r.parent_id,
              chunk_text: r.chunk_text,
              category: r.category,
              subject: r.subject,
              sections: r.sections,
              doc_title: r.doc_title,
              law_title: r.law_title,
              doc_date: r.doc_date,
              score: r.score || r.rrf_score,
            })),
            evaluation: evaluation
          }));
        } catch (err) {
          console.error('[RAG Endpoint] Request handler failed:', err);
          await traceError({
            errorType: err?.name || 'UnknownError',
            errorMessage: err?.message || String(err),
            component: 'rag-endpoint',
            requestId: req.requestContext?.requestId,
            sessionId: req.requestContext?.sessionId,
          });
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Internal server error.' }));
        }
        }; // Close executeRAGRequest function

        // Execute with root tracing
        try {
          await executeRAGRequest();
        } catch (rootErr) {
          console.error('[RAG Endpoint] Root execution error:', rootErr);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Request processing failed.' }));
        }
        return;
      }

      if (path === '/api/chat/sessions' && req.method === 'POST') {
        try {
          const payload = await getRequestBody(req);
          const userId = getAuthenticatedUserId(req);
          const sessionsCollection = db.collection('chat_sessions');
          const sessionId = payload.session_id || generateSessionId();
          console.log(`[MongoDB] Creating session: ${sessionId}`);
          const now = new Date().toISOString();
          console.log(`[AI Chatbot] Received message for session ${sessionId} from user ${userId}`);
          const requestContextMetadata = req.requestContext ? {
            requestId: req.requestContext.requestId,
            timestamp: req.requestContext.timestamp,
          } : {};
          const sessionDocument = {
            session_id: sessionId,
            user_id: userId,
            title: payload.title || (payload.mode === 'rag' ? 'New RAG Search' : 'New chat'),
            mode: payload.mode || 'chat',
            created_at: payload.created_at || now,
            updated_at: payload.updated_at || now,
            last_message_at: payload.last_message_at || now,
            message_count: payload.message_count || 0,
            status: payload.status || 'active',
            ...requestContextMetadata,
          };

          await sessionsCollection.updateOne(
            { session_id: sessionId, user_id: userId },
            { $setOnInsert: sessionDocument },
            { upsert: true }
          );

          const savedSession = await sessionsCollection.findOne({ session_id: sessionId, user_id: userId });
          console.log('[MongoDB] Session saved');
          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ session: savedSession }));
        } catch (error) {
          console.error('Create session failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to create chat session.' }));
        }
        return;
      }

      if (path === '/api/chat/sessions' && req.method === 'GET') {
        try {
          const userId = getAuthenticatedUserId(req);
          const urlParsed = new URL(req.url, 'http://localhost');
          const mode = urlParsed.searchParams.get('mode');
          const sessionsCollection = db.collection('chat_sessions');
          console.log(`[MongoDB] Loading sessions for user: ${userId}, mode: ${mode || 'all'}`);

          const query = { user_id: userId };
          if (mode === 'rag') {
            query.mode = 'rag';
          } else if (mode === 'chat') {
            query.$or = [{ mode: 'chat' }, { mode: { $exists: false } }];
          }

          const sessions = await sessionsCollection
            .find(query)
            .sort({ last_message_at: -1, updated_at: -1 })
            .toArray();

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ sessions }));
        } catch (error) {
          console.error('Fetch sessions failed', error);

          setJsonHeaders(res, 500);
          res.end(JSON.stringify({
            error: 'Unable to fetch chat sessions.'
          }));
        }

        return;
      }

      const sessionMessagesMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
      if (sessionMessagesMatch && req.method === 'GET') {
        try {
          const sessionId = sessionMessagesMatch[1];
          req.requestContext = createRequestContext({
            sessionId,
            messageId: null,
          });
          const userId = getAuthenticatedUserId(req);
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');
          console.log(`[MongoDB] Loading messages for session: ${sessionId}`);

          const session = await findOwnedSession(sessionsCollection, sessionId, userId);
          if (!session) {
            setJsonHeaders(res, 404);
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          const messages = await messagesCollection
            .find({ session_id: session.session_id, user_id: userId })
            .sort({ sequence_number: 1, created_at: 1 })
            .toArray();

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ session_id: session.session_id, messages }));
        } catch (error) {
          console.error('Fetch messages failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to fetch session messages.' }));
        }

        return;
      }

      if (sessionMessagesMatch && req.method === 'POST') {
        try {
          const sessionId = sessionMessagesMatch[1];
          const payload = await getRequestBody(req);
          req.requestContext = createRequestContext({
            sessionId,
            messageId: null,
          });
          const userId = getAuthenticatedUserId(req);

          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const session = await findOwnedSession(sessionsCollection, sessionId, userId);
          if (!session) {
            setJsonHeaders(res, 404);
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          const now = new Date().toISOString();
          const requestContextMetadata = req.requestContext ? {
            requestId: req.requestContext.requestId,
            timestamp: req.requestContext.timestamp,
          } : {};
          const userMsgDoc = {
            message_id: payload.message_id || randomUUID(),
            session_id: session.session_id,
            user_id: userId,
            role: 'user',
            content: payload.content || '',
            created_at: now,
            sequence_number: session.message_count + 1,
            metadata: payload.metadata || {},
            ...requestContextMetadata,
          };
          await messagesCollection.insertOne(userMsgDoc);

          const previousMessages = await messagesCollection.find({ session_id: session.session_id })
            .sort({ sequence_number: 1, created_at: 1 })
            .toArray();

          let assistantMsgDoc;

          if (payload.assistantMessage && typeof payload.assistantMessage === 'object') {
            const assistantContent = payload.assistantMessage.content || '';
            const assistantMetadata = payload.assistantMessage.metadata || {};
            console.log('[AI Chatbot] Persisting assistantMessage provided by client (likely from /api/ask)');
            assistantMsgDoc = {
              message_id: payload.assistantMessage.message_id || randomUUID(),
              session_id: session.session_id,
              user_id: userId,
              role: 'assistant',
              content: assistantContent,
              created_at: new Date().toISOString(),
              sequence_number: session.message_count + 2,
              metadata: assistantMetadata,
              ...requestContextMetadata,
            };
          } else if (session.mode === 'rag') {
            console.log(`[RAG Session Flow] Executing search for question: "${payload.content}"`);
            let results = [];
            try {
              const prioritizedOutcome = await performPrioritizedLegalSearch(payload.content, payload.content);
              results = prioritizedOutcome.results || [];
            } catch (searchErr) {
              console.error('[RAG Session Flow] Search execution failed:', searchErr);
              setJsonHeaders(res, 500);
              res.end(JSON.stringify({ error: 'Failed to search legal documents database.' }));
              return;
            }

            let answerText = 'I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question.';
            let uniqueSources = [];
            let suggestions = [];

            if (results && results.length > 0) {
              const contextBlock = results.map((r, idx) => {
                const sourceIndex = idx + 1;
                const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
                const fileName = (r.original && r.original.child && r.original.child.FileName) ||
                  (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
                const category = r.category || 'Unknown';
                const subject = r.subject || 'Unknown';
                const sections = r.sections || 'Unknown';

                return `[Source ${sourceIndex}] Title: "${title}" | File: ${fileName} | Sections: ${sections} | Category: ${category} | Subject: ${subject}\nContent: ${r.chunk_text}`;
              }).join('\n\n---\n\n');

              const systemPrompt = `You are a professional legal research assistant for Indian corporate and commercial law.
You must answer the user's question grounding your answer strictly and ONLY in the provided search context.
Do NOT use any external or general knowledge. If the provided context does not contain enough information to answer the question, state: "I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question."

Style and Tone Requirements:
- Write in a natural, cohesive, humanized legal advisory tone. Do not just copy-paste blocks from the database.
- Present a clear, structured legal explanation.
- Use Markdown formatting for structure: headings (e.g., "### Heading"), bullet points, numbered lists, tables (where data can be formatted in columns), and bold text for key legal terms or sections.
- Avoid printing raw file names or titles inline in the text.
- Use numerical citation tags like [1], [2], [3] to cite which source(s) the information came from. The citation number must correspond to the Source number provided in the context (e.g. use [1] for [Source 1], [2] for [Source 2]).
- Ensure the output is clean and complete.

At the end of your response, add the tag '---SUGGESTIONS---' followed by 3 relevant follow-up questions the user might ask next, one per line.
Example:
---SUGGESTIONS---
What are the requirements for board resolutions under Section 135?
Are private companies exempt from these regulations?
What is the penalty for violating this provision?`;

              const provider = settings.DEFAULT_LLM_PROVIDER;
              const model = settings.DEFAULT_LLM_MODEL;
              const llm = getLLMProvider(provider, model);

              let llmResponse;
              try {
                llmResponse = await llm.generate({
                  systemPrompt: systemPrompt,
                  messages: [{ role: 'user', content: `Question: ${payload.content}\n\nSearch Context:\n${contextBlock}` }],
                  temperature: 0.1,
                  maxTokens: 2048,
                  requestContext: req.requestContext,
                });
                answerText = llmResponse.content || '';
              } catch (llmErr) {
                console.error('[RAG Session Flow] LLM generation failed:', llmErr);
                setJsonHeaders(res, 500);
                res.end(JSON.stringify({ error: 'LLM generation failed.' }));
                return;
              }

              // Extract suggestions
              const parsedResponse =
                parseAnswerAndSuggestions(answerText);

              answerText = parsedResponse.answer;
              suggestions = parsedResponse.suggestions;
              // Find all bracketed citation numbers, e.g., [1], [2]
              const citationRegex = /\[([1-9])\]/g;
              let match;
              const citedIndices = new Set();
              while ((match = citationRegex.exec(answerText)) !== null) {
                const idx = parseInt(match[1], 10) - 1;
                if (idx >= 0 && idx < results.length) {
                  citedIndices.add(idx);
                }
              }

              // Fallback to title/filename matching if no numerical citations found
              if (citedIndices.size === 0) {
                for (let i = 0; i < results.length; i++) {
                  const r = results[i];
                  const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
                  const fileName = (r.original && r.original.child && r.original.child.FileName) ||
                    (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
                  if (answerText.toLowerCase().includes(title.toLowerCase().slice(0, 30)) ||
                    answerText.toLowerCase().includes(fileName.toLowerCase())) {
                    citedIndices.add(i);
                  }
                }
              }

              const seenSources = new Set();
              citedIndices.forEach(idx => {
                const r = results[idx];
                const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
                const fileName = (r.original && r.original.child && r.original.child.FileName) ||
                  (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
                const sourceKey = `${title}:::${fileName}`;
                if (!seenSources.has(sourceKey)) {
                  seenSources.add(sourceKey);
                  uniqueSources.push({
                    title,
                    filename: fileName,
                    source_table: r.source_table,
                    record_id: r.record_id,
                    parent_id: r.parent_id,
                    excerpt: truncateExcerpt(r.chunk_text),
                    author: (r.original && r.original.parent && r.original.parent.Author) || null,
                    sections: r.sections || (r.original && r.original.parent && r.original.parent.Sections) || null,
                    category: r.category || (r.original && r.original.parent && r.original.parent.Category) || null,
                    subject: r.subject || (r.original && r.original.parent && r.original.parent.Subject) || null,
                    doc_date: r.doc_date || (r.original && r.original.parent && r.original.parent.DocDate) || null,
                    vol: (r.original && r.original.parent && r.original.parent.Vol) || null,
                    issue_month: (r.original && r.original.parent && r.original.parent.IssueMonth) || null,
                    issue_year: (r.original && r.original.parent && r.original.parent.IssueYear) || null
                  });
                }
              });

              if (uniqueSources.length === 0 && results.length > 0) {
                const r = results[0];
                const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
                const fileName = (r.original && r.original.child && r.original.child.FileName) ||
                  (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
                uniqueSources.push({
                  title,
                  filename: fileName,
                  source_table: r.source_table,
                  record_id: r.record_id,
                  parent_id: r.parent_id,
                  excerpt: truncateExcerpt(r.chunk_text),
                  author: (r.original && r.original.parent && r.original.parent.Author) || null,
                  sections: r.sections || (r.original && r.original.parent && r.original.parent.Sections) || null,
                  category: r.category || (r.original && r.original.parent && r.original.parent.Category) || null,
                  subject: r.subject || (r.original && r.original.parent && r.original.parent.Subject) || null,
                  doc_date: r.doc_date || (r.original && r.original.parent && r.original.parent.DocDate) || null,
                  vol: (r.original && r.original.parent && r.original.parent.Vol) || null,
                  issue_month: (r.original && r.original.parent && r.original.parent.IssueMonth) || null,
                  issue_year: (r.original && r.original.parent && r.original.parent.IssueYear) || null
                });
              }
            }

            assistantMsgDoc = {
              message_id: randomUUID(),
              session_id: session.session_id,
              user_id: userId,
              role: 'assistant',
              content: answerText,
              created_at: new Date().toISOString(),
              sequence_number: session.message_count + 2,
              metadata: {
                follow_up_questions: suggestions,
                sources: uniqueSources,
                model: settings.DEFAULT_LLM_MODEL
              }
            };
          } else {
            const { runAgentFlow } = require('./agentSystem');
            const agentResult = await runAgentFlow(payload.content || '', { history: previousMessages });

            assistantMsgDoc = {
              message_id: randomUUID(),
              session_id: session.session_id,
              user_id: userId,
              role: 'assistant',
              content: agentResult.content,
              created_at: new Date().toISOString(),
              sequence_number: session.message_count + 2,
              metadata: {
                route: agentResult.route,
                follow_up_questions: agentResult.follow_up_questions,
                sources: agentResult.sources || [],
                citations: agentResult.citations || [],
                model: agentResult.model || null
              }
            };
          }

          await messagesCollection.insertOne(assistantMsgDoc);

          const sessionUpdate = {
            updated_at: new Date().toISOString(),
            last_message_at: new Date().toISOString(),
            message_count: session.message_count + 2
          };

          const shouldGenerateTitle = !session.title || session.title === 'New chat' || session.title === 'New RAG Search' || session.title === '';
          if (shouldGenerateTitle && payload.content) {
            const generatedTitle = await generateConversationTitle({
              userContent: payload.content,
              assistantContent: assistantMsgDoc.content,
              requestContext: req.requestContext,
            });

            if (generatedTitle) {
              sessionUpdate.title = generatedTitle;
            }
          }

          await sessionsCollection.updateOne(
            { _id: session._id, user_id: userId },
            { $set: sessionUpdate }
          );

          const updatedSession = await sessionsCollection.findOne({ _id: session._id, user_id: userId });

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({
            userMessage: userMsgDoc,
            assistantMessage: assistantMsgDoc,
            session: updatedSession ? {
              session_id: updatedSession.session_id,
              title: updatedSession.title || 'New chat',
              mode: updatedSession.mode || 'chat',
              created_at: updatedSession.created_at,
              updated_at: updatedSession.updated_at,
              last_message_at: updatedSession.last_message_at,
              message_count: updatedSession.message_count,
              status: updatedSession.status || 'active',
            } : null,
          }));
        } catch (error) {
          console.error('Send message failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to process message.' }));
        }
        return;
      }

      if (path === '/api/chat/feedback' && req.method === 'POST') {
        const userId = getAuthenticatedUserId(req);
        if (!userId) {
          setJsonHeaders(res, 401);
          res.end(JSON.stringify({ error: 'Authentication required.' }));
          return;
        }

        try {
          const payload = await getRequestBody(req);
          const { session_id, message_id, feedback } = payload;

          if (!session_id || !message_id) {
            setJsonHeaders(res, 400);
            res.end(JSON.stringify({ error: 'session_id and message_id are required.' }));
            return;
          }

          const validFeedback = feedback === null || feedback === 'up' || feedback === 'down' || feedback === undefined;
          if (!validFeedback) {
            setJsonHeaders(res, 400);
            res.end(JSON.stringify({ error: 'feedback must be "up", "down", or null.' }));
            return;
          }

          const messagesCollection = db.collection('chat_messages');
          const updatePayload = {
            updated_at: new Date().toISOString(),
          };
          if (feedback === undefined || feedback === null) {
            updatePayload.feedback = null;
          } else {
            updatePayload.feedback = feedback;
          }

          const result = await messagesCollection.updateOne(
            { session_id, message_id, user_id: userId },
            { $set: updatePayload }
          );

          if (result.matchedCount === 0) {
            setJsonHeaders(res, 404);
            res.end(JSON.stringify({ error: 'Message not found.' }));
            return;
          }

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ success: true, feedback: updatePayload.feedback }));
        } catch (error) {
          console.error('Submit feedback failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to save feedback.' }));
        }
        return;
      }

      const sessionDeleteMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)$/);
      if (sessionDeleteMatch && req.method === 'DELETE') {
        const sessionId = sessionDeleteMatch[1];
        const userId = getAuthenticatedUserId(req);

        if (!userId) {
          setJsonHeaders(res, 401);
          res.end(JSON.stringify({ error: 'Authentication required.' }));
          return;
        }

        try {
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const ownedSession = await findOwnedSession(sessionsCollection, sessionId, userId);
          if (!ownedSession) {
            setJsonHeaders(res, 404);
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          await messagesCollection.deleteMany({ session_id: ownedSession.session_id, user_id: userId });
          await sessionsCollection.deleteOne({ _id: ownedSession._id, user_id: userId });

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ success: true, session_id: sessionId }));
        } catch (error) {
          console.error('Delete session failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to delete chat session.' }));
        }
        return;
      }

      setJsonHeaders(res, 404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    const io = new Server(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    });

    io.on('connection', (socket) => {
      console.log('[RAGAS Live] Client connected');
      socket.on('disconnect', () => {
        console.log('[RAGAS Live] Client disconnected');
      });
    });

    server.listen(PORT, () => {
      const embeddingConfig = getEmbeddingConfig();
      console.log("\n=== RAG Pipeline Configuration ===");
      console.log(`Embedding Model      : ${embeddingConfig.model}`);
      console.log(`Embedding Dimensions : ${embeddingConfig.dimensions}`);
      console.log(`==================================\n`);
      console.log(`Server running on port ${PORT}`);
    });
    const shutdown = async () => {
      console.log('Shutting down server...');
      server.close(async () => {
        await closeDB();
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildEvaluationResultDocument,
  persistEvaluationResult,
  buildRetrievalLogDocument,
  persistRetrievalLog,
  ensureIndexes,
  startServer,
  runPythonSearch,
  performPrioritizedLegalSearch,
};

