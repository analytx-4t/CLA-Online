

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
const { startDbSyncScheduler } = require('./dbSync/service');
const { getEvaluationToggle } = require('./settingsStore');
const { cohereRerank } = require('./cohereReranker');
const { buildContextBlock, finalizeAnswer } = require('./citations');
const { renderCitationPage, renderCitationNotFound } = require('./citationPage');
const { checkBookPdf, presignBookPdf } = require('./bookPdf');
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
  const expectedModel = 'text-embedding-3-small';
  const expectedDimensions = 1536;

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

let legislationLabelsCache = null;

// file name (lower case) -> { title, type }, built by embedding/build_legislation_labels.py
function getLegislationLabels() {
  if (!legislationLabelsCache) {
    try {
      legislationLabelsCache = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../embedding/legislation_labels.json'), 'utf8'));
    } catch (error) {
      console.warn('[Legislation Labels] legislation_labels.json could not be read:', error.message);
      return {};
    }
  }
  return legislationLabelsCache;
}

function getPythonExecutable() {
  const venvUnix = path.resolve(__dirname, '../embedding/venv/bin/python');
  const venvWin = path.resolve(__dirname, '../embedding/venv/Scripts/python.exe');
  if (fs.existsSync(venvUnix)) return venvUnix;
  if (fs.existsSync(venvWin)) return venvWin;
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) return process.env.PYTHON_PATH;

  if (process.platform === 'win32') {
    const localPy312 = 'C:\\Users\\hp\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
    if (fs.existsSync(localPy312)) return localPy312;
  }
  return 'python3';
}

function runPythonSearch(query, topK = 5, hybrid = true, sourceFilter = null, inferredSections = [], primaryAct = null) {
  return new Promise((resolve, reject) => {
    // Validate embedding configuration before retrieval
    validateEmbeddingConfiguration();

    const pythonPath = getPythonExecutable();
    const scriptPath = path.resolve(__dirname, '../embedding/search_documents.py');
    if (!fs.existsSync(scriptPath)) {
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
      source_filter: sourceFilter,
      inferred_sections: inferredSections,
      primary_act: primaryAct
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
        relevanceScore += 20;
      }
    }

    // ------------------------------------------------------------------
    // STATUTORY SOURCE PRIORITY BOOST (Tier Hierarchy)
    // ------------------------------------------------------------------
    // Primary Statutory Law (Legislation) & Official Commentary are
    // legally authoritative and must always outrank generic articles.
    const tableStr = (result.source_table || '').toLowerCase();
    const categoryStr = (result.category || '').toLowerCase();

    if (tableStr.includes('legis') || categoryStr.includes('statute') || categoryStr.includes('primary legislation')) {
      relevanceScore += 15; // Tier 1: Primary Legislation / Acts
    } else if (tableStr.includes('comm') || categoryStr.includes('commentary')) {
      relevanceScore += 12; // Tier 2: Official Statutory Commentary
    } else if (tableStr.includes('book') || result.is_book || categoryStr.includes('publication')) {
      relevanceScore += 10; // Tier 3: Core CLA Books & Reference Texts
    } else if (tableStr.includes('notif') || tableStr.includes('circ') || categoryStr.includes('government')) {
      relevanceScore += 8;  // Tier 4: Regulatory Notifications & Circulars
    } else if (tableStr.includes('case') || categoryStr.includes('precedent')) {
      relevanceScore += 6;  // Tier 5: Judicial Precedents
    } else if (tableStr.includes('proc') || tableStr.includes('query')) {
      relevanceScore += 4;  // Tier 6: Compliance Procedures & Q&A
    } else if (tableStr.includes('art')) {
      relevanceScore += 1;  // Tier 7: Secondary Articles (lowest priority)
    }

    // Penalize legacy 1956 Act material if not mentioning Companies Act 2013
    if (searchableText.includes('1956 act') || searchableText.includes('act, 1956')) {
      if (!searchableText.includes('2013')) {
        relevanceScore -= 5;
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

async function performPrioritizedLegalSearch(retrievalQuery, originalQuestion = null, expansionKeywords = [], inferredSections = [], primaryAct = null) {
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
  let candidateChunks = [];

  try {
    const rawRes = await runPythonSearch(normKeywordQuery, 60, true, null, inferredSections, primaryAct).catch(err => {
      console.error('[Prioritized Search] Retrieval failed:', err.message);
      return [];
    });
    candidateChunks = Array.isArray(rawRes) ? rawRes : [];
  } catch (err) {
    console.error('[Prioritized Search] Candidate retrieval failed:', err.message);
  }

  // Step 2: Rerank candidate chunks using Cohere / Heuristic Reranker
  const rerankedResults = candidateChunks.length > 0
    ? await rerankSearchResults(targetQuestion, candidateChunks, 60)
    : [];

  // Step 3: Relevance filter. Only passages the reranker judges on point reach the answer
  // model, so only relevant sources can ever be cited. Caps keep one table or one long
  // document from crowding out the rest.
  const TOP_CHUNKS_PER_TABLE = 5;
  const TOP_CHUNKS_PER_DOCUMENT = 3;
  const MAX_CONTEXT_CHUNKS = 16;
  const MIN_CONTEXT_CHUNKS = 4;

  // Cohere's raw score is the relevance signal when the reranker ran; the heuristic fallback
  // only produces backend_relevance_score.
  const hasCohereScores = rerankedResults.some(r => Number.isFinite(r.cohere_relevance_score));
  const relevanceOf = (r) => (hasCohereScores ? (r.cohere_relevance_score || 0) : (r.backend_relevance_score || 0));
  const topRelevance = rerankedResults.reduce((max, r) => Math.max(max, relevanceOf(r)), 0);
  const minRelevance = hasCohereScores
    ? Math.max(0.12, topRelevance * 0.4)
    : Math.max(0.20, topRelevance * 0.35);

  // When even the best passage scores this low, nothing retrieved is on point: answer
  // "could not find authority" instead of building an answer on unrelated material.
  // (Measured on real questions: answerable ones top out at 0.8 or more, questions the
  // database does not cover at 0.27 or less.)
  const NO_AUTHORITY_RELEVANCE = 0.30;
  const nothingOnPoint = hasCohereScores && topRelevance < NO_AUTHORITY_RELEVANCE;

  let filteredRerankedResults = nothingOnPoint ? [] : rerankedResults.filter(r => relevanceOf(r) >= minRelevance);
  if (!nothingOnPoint && filteredRerankedResults.length < MIN_CONTEXT_CHUNKS) {
    // A very strong single hit must not starve the answer of supporting context.
    filteredRerankedResults = [...rerankedResults]
      .sort((a, b) => relevanceOf(b) - relevanceOf(a))
      .slice(0, Math.min(MIN_CONTEXT_CHUNKS, rerankedResults.length));
  }

  const applyCaps = (results) => {
    const perTable = {};
    const perDocument = {};
    const kept = [];
    const ordered = [...results].sort((a, b) => (b.backend_relevance_score || 0) - (a.backend_relevance_score || 0));
    for (const r of ordered) {
      if (kept.length >= MAX_CONTEXT_CHUNKS) break;
      const tableKey = (r.source_table || 'unknown').trim().toLowerCase();
      const documentKey = r.is_book
        ? `${tableKey}|${r.file_name}|${r.page_number || r.parent_id}`
        : `${tableKey}|${r.record_id}`;
      if ((perTable[tableKey] || 0) >= TOP_CHUNKS_PER_TABLE) continue;
      if ((perDocument[documentKey] || 0) >= TOP_CHUNKS_PER_DOCUMENT) continue;
      perTable[tableKey] = (perTable[tableKey] || 0) + 1;
      perDocument[documentKey] = (perDocument[documentKey] || 0) + 1;
      kept.push(r);
    }
    return kept;
  };

  const combinedResults = applyCaps(filteredRerankedResults);
  console.log(`[Prioritized Search] Relevance filter kept ${filteredRerankedResults.length}/${rerankedResults.length} chunks (min relevance ${minRelevance.toFixed(2)}, top ${topRelevance.toFixed(2)}); ${combinedResults.length} sent to the answer model.`);

  // Attach object properties to array for backwards compatibility
  combinedResults.results = combinedResults;
  combinedResults.legislationResults = combinedResults.filter(r => (r.source_table || '').toLowerCase().includes('legis'));
  combinedResults.otherResults = combinedResults.filter(r => !(r.source_table || '').toLowerCase().includes('legis'));
  combinedResults.candidateCount = candidateChunks.length;

  return combinedResults;
}

function runPythonCitation(sourceTable, recordId, parentId = null, fileName = null, focusIndices = []) {
  return new Promise((resolve, reject) => {
    const pythonPath = getPythonExecutable();
    const scriptPath = path.resolve(__dirname, '../embedding/search_documents.py');
    if (!fs.existsSync(scriptPath)) {
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
        resolve(result.results);
      } catch (err) {
        reject(new Error(`Failed to parse Python output: ${err.message}. Raw output: ${stdout.slice(0, 300)}`));
      }
    });

    // Record ids are numeric for the structured tables and strings for book chunks.
    const isNumericId = /^\d+$/.test(String(recordId || ''));
    const inputPayload = JSON.stringify({
      action: "get_citation",
      source_table: sourceTable,
      record_id: isNumericId ? parseInt(recordId, 10) : (recordId || null),
      parent_id: parentId ? (parseInt(parentId, 10) || parentId) : null,
      file_name: fileName || null,
      focus_indices: focusIndices
    });

    child.stdin.write(inputPayload);
    child.stdin.end();
  });
}

// A reader usually opens several citations of the same document in a row, so loaded
// sources are kept for a while instead of being fetched again for every click.
const CITATION_CACHE_TTL_MS = 30 * 60 * 1000;
const CITATION_CACHE_MAX_ENTRIES = 40;
const citationSourceCache = new Map();

async function loadCitationSource(sourceTable, recordId, parentId, fileName, citedIds = []) {
  const isBook = /book|pinecone/i.test(String(sourceTable || ''));
  const key = isBook
    ? `book|${recordId || ''}|${fileName || ''}|${parentId || ''}`
    : `${sourceTable}|${recordId}`;
  const cached = citationSourceCache.get(key);
  if (cached && cached.expires > Date.now()) {
    // A very long statute is cached as the part around earlier citations; it only serves
    // this request if it already holds the passages cited now.
    const loadedIds = new Set(cached.details.chunks.map(chunk => String(chunk.id)));
    if (isBook || cached.details.complete !== false || (citedIds.length > 0 && citedIds.every(id => loadedIds.has(String(id))))) {
      return cached.details;
    }
  }
  // Vector ids end in the chunk's position ("Legislation|79|33"), which tells the lookup
  // where to read in a record too long to load whole.
  const focusIndices = citedIds
    .map(id => parseInt(String(id).split('|').pop(), 10))
    .filter(Number.isFinite);
  const details = await runPythonCitation(sourceTable, recordId, parentId, fileName, focusIndices);
  if (details && Array.isArray(details.chunks) && details.chunks.length > 0) {
    citationSourceCache.delete(key);
    if (citationSourceCache.size >= CITATION_CACHE_MAX_ENTRIES) {
      citationSourceCache.delete(citationSourceCache.keys().next().value);
    }
    citationSourceCache.set(key, { details, expires: Date.now() + CITATION_CACHE_TTL_MS });
  }
  return details;
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

      // Correct Act names for legislation files. Chats saved before the label fix hold some
      // legislation sources under another Act's name; the chat page uses this to repair them.
      if (path === '/api/legislation-titles' && req.method === 'GET') {
        const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const files = (urlParsed.searchParams.get('files') || '').split(',').map(f => f.trim().toLowerCase()).filter(Boolean).slice(0, 100);
        const labels = getLegislationLabels();
        const titles = {};
        for (const file of files) {
          if (labels[file] && labels[file].title) titles[file] = labels[file].title;
        }
        setJsonHeaders(res, 200);
        res.end(JSON.stringify({ titles }));
        return;
      }

      if (path === '/api/citation' && req.method === 'GET') {
        try {
          const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const params = urlParsed.searchParams;
          const sourceTable = params.get('sourceTable');
          const recordId = params.get('recordId');
          const parentId = params.get('parentId') || params.get('page');
          const fileName = params.get('file');
          const highlight = params.get('highlight') || '';
          const claim = params.get('claim') || '';
          const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
          // ids of the cited chunks, e.g. "Legislation|79|33,Legislation|79|120"
          const citedIds = (params.get('ids') || '').split(',').map(id => id.trim()).filter(Boolean);

          if (!sourceTable || (!recordId && !fileName)) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>400 Bad Request</h1><p>sourceTable and recordId parameters are required.</p>');
            return;
          }

          let details = null;
          try {
            details = await loadCitationSource(sourceTable, recordId, parentId, fileName, citedIds);
          } catch (pyErr) {
            console.warn('[Citation Endpoint] Source lookup failed:', pyErr.message);
          }

          let htmlResponse;
          if (!details || !Array.isArray(details.chunks) || details.chunks.length === 0) {
            htmlResponse = renderCitationNotFound({ theme, sourceTable, highlightText: highlight, title: params.get('title') || '' });
          } else {
            let pdfUrl = null;
            if (details.document && details.document.is_book) {
              const pdf = await checkBookPdf(details.document.file_name);
              if (pdf.available) {
                pdfUrl = `/api/view-pdf?file=${encodeURIComponent(details.document.file_name)}&page=${encodeURIComponent(details.document.page_number || 1)}`;
              }
              // A book chunk is one source; its id is the record id itself.
              if (!citedIds.length && recordId) citedIds.push(recordId);
            }
            htmlResponse = renderCitationPage(details, { theme, citedIds, highlightText: highlight, claim, pdfUrl });
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(htmlResponse);
        } catch (error) {
          console.error('[Citation Endpoint] Error:', error);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h1>500 Internal Server Error</h1><p>${escapeHTML(error.message)}</p>`);
        }
        return;
      }

      if ((path === '/api/view-pdf' || path === '/api/pdf') && req.method === 'GET') {
        try {
          const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const params = urlParsed.searchParams;
          const fileName = (params.get('file') || params.get('fileName') || params.get('file_name') || '').trim();
          const page = String(parseInt(params.get('page') || params.get('page_number') || '1', 10) || 1);
          const highlight = params.get('highlight') || params.get('text') || params.get('excerpt') || '';

          const pdf = await checkBookPdf(fileName);
          if (pdf.available) {
            const presignedUrl = await presignBookPdf(pdf.key);
            res.writeHead(302, { 'Location': `${presignedUrl}#page=${page}` });
            res.end();
            return;
          }

          // The PDF cannot be served (missing file or S3 credentials): show the same book
          // page as text instead of an S3 error.
          console.warn(`[PDF Endpoint] PDF unavailable for "${fileName}" (${pdf.reason}). Falling back to the book page text view.`);
          const fallbackParams = new URLSearchParams({ sourceTable: 'CLA Books', file: fileName, page });
          const theme = params.get('theme');
          if (theme) fallbackParams.set('theme', theme);
          if (highlight) fallbackParams.set('highlight', highlight.slice(0, 1500));
          res.writeHead(302, { 'Location': `/api/citation?${fallbackParams.toString()}` });
          res.end();
        } catch (pdfErr) {
          console.error('[PDF Endpoint] Error:', pdfErr.message);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h1>500 Internal Server Error</h1><p>Unable to open requested PDF: ${escapeHTML(pdfErr.message)}</p>`);
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

          // Conversational Contextualizer: rephrase follow-up questions using session history
          const { contextualizeUserQuery } = require('./contextualizer');
          const contextualResult = await contextualizeUserQuery({
            question: question.trim(),
            chatHistory: payload.history || payload.chatHistory || [],
            db,
            sessionId: req.requestContext.sessionId
          });

          const activeQuery = contextualResult.standaloneQuery || question.trim();
          const chatSessionHistory = contextualResult.history || [];
          if (contextualResult.isFollowUp) {
            console.log(`[RAG Endpoint] Follow-up query detected. Contextualized query: "${activeQuery}"`);
          }

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
              question: activeQuery,
              checkGuardrails: async () => {
                return await checkGuardrails(activeQuery);
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
              originalQuestion: activeQuery,
              expandLegalQuery: async () => {
                return await expandLegalQuery(activeQuery);
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
              queryExpansion.expandedQuery || activeQuery;

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
                inferredSections: queryExpansion.inferredSections || [],
                primaryAct: queryExpansion.primaryAct || null,
                actFilter: queryExpansion.actFilter || null,
                currencyRequirement: queryExpansion.currencyRequirement || '',
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
                return await performPrioritizedLegalSearch(
                  retrievalQuery, 
                  question, 
                  expansionKeywords,
                  queryExpansion.inferredSections || [],
                  queryExpansion.primaryAct || null
                );
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

            // Numbered search context: "[Source N]" is results[N - 1], which is how the
            // inline citation markers are mapped back to sources after generation.
            const contextBlock = buildContextBlock(results);

            // Build Grounded LLM Prompt
            const attachmentPromptRules = attachmentContext
              ? `\n\nThe user has also attached one or more documents (see ATTACHED DOCUMENT CONTEXT below). You may draw on their content, but only to the extent it concerns corporate/commercial law matters within your scope as CLA. If an attached document is unrelated to corporate law (e.g. personal, unrelated business, or off-topic content), disregard it and rely on the Search Context alone. Do not use numbered citation tags like [1] for attached document content — those are reserved for the Search Context sources; refer to attached material in prose instead (e.g. "the agreement you attached").`
              : '';

            const { loadAgentPrompts } = require('./agentSystem');
            const agentPrompts = loadAgentPrompts();
            const baseSummarizerPrompt = agentPrompts.Content_Summarizer_Agent || `You are a professional legal research assistant for Indian corporate and commercial law. Answer STRICTLY from the Search Context only — never from your own knowledge. Read ALL chunks and combine relevant information into one answer. Write in a clean, flowing legal-memo style: start directly with a 2-3 sentence legal answer, use bold thematic section headers, cite [Source N] inline (max 1-2 citations per bracket), and end with "This is legal research, not legal advice. Please verify against the primary source." Only output "I could not find authority on this in the CLAOnline database." if every chunk is completely unrelated to the question.`;

            const formattingRules = `

OUTPUT RULES FOR THIS CONVERSATION (these override anything above that conflicts with them):
The user message holds the question and a Search Context of numbered passages, each starting with "[Source N]". Those passages are the only material you may answer from.

1. CITATIONS. End every sentence or list item that states law, a holding, a procedural step or a fact taken from the Search Context with the number of the passage it came from, in square brackets, e.g. "...by special resolution [3]." Use the number N from that passage's "[Source N]" label. Cite only the passage that actually states the point; when two passages state it, write [3][7]. Never cite a passage only because it is on the same topic, never invent a number, and never write a range or a long run of numbers. A sentence that merely links or sums up points already cited needs no marker. Do not put a source's title or file name in place of the marker, and do not write a "Sources" or "Sources Used" list: the interface shows the numbered sources under your answer.
2. STRUCTURE. Use exactly three main headings, each on its own line in exactly this form: "## Overview", "## Analysis", "## Conclusion". Every sub-heading inside the Analysis goes on its own line as "### Sub-heading text". Never use bold text as a heading and never add any other "##" heading.
3. STANDALONE ANSWER. Write a finished piece of legal analysis for the reader. Never describe how it was produced: do not mention "the database", "the sources provided", "the retrieved material", "the context", source agents, or what was or was not found, and do not write about gaps, missing material or what "could not be confirmed". Where the passages do not support a point, leave that point out without comment and answer the rest fully. Only if the passages do not address the core of the question at all, reply with exactly this one sentence and nothing else: "I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question."
4. OPENING. Begin the Overview with the legal position itself. No preamble such as "Based on...".
5. HIGHLIGHT. Wrap one to three key rules or holdings in double equal signs, e.g. ==Section 135 requires qualifying companies to spend 2% of average net profits on CSR==.
6. CLOSING. End the answer with this line: "This is legal research, not legal advice. Please verify against the primary source."
7. FOLLOW-UPS. After that line, add the exact tag '---SUGGESTIONS---' followed by 3 follow-up questions the user might ask next, one per line.
Example:
---SUGGESTIONS---
What are the requirements for board resolutions under Section 135?
Are private companies exempt from these regulations?
What is the penalty for violating this provision?`;

            // The summarizer prompt is written for the multi-agent flow; its shared-context
            // placeholder has no content in this single-call flow, so it is removed.
            const summarizerPromptForContext = baseSummarizerPrompt.replace(/\[SHARED LEGAL CONTEXT\]\s*/g, '').replace(/\[COMMON RULES\]\s*/g, '');
            const systemPrompt = `${summarizerPromptForContext}${attachmentPromptRules}${formattingRules}`;

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

            const llmMessages = [];
            if (Array.isArray(chatSessionHistory) && chatSessionHistory.length > 0) {
              for (const h of chatSessionHistory.slice(-6)) {
                llmMessages.push({
                  role: h.role === 'assistant' ? 'assistant' : 'user',
                  content: String(h.content || '').substring(0, 500)
                });
              }
            }
            llmMessages.push({ role: 'user', content: userContent });

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
                  maxTokens: 3500,
                  generate: async () => {
                    return await currentLlm.generate({
                      systemPrompt: systemPrompt,
                      messages: llmMessages,
                      temperature: 0.1,
                      maxTokens: 3500
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

            suggestions = parsedResponse.suggestions;

            // Keep only the sources the answer cites, rank them by relevance, and renumber
            // the inline markers to match: [1] in the text is source 1 in the list.
            const finalized = finalizeAnswer(parsedResponse.answer, results);
            answerText = finalized.answer;
            const citedSources = finalized.sources;

            console.log(
              `[RAG Endpoint] Extracted ${suggestions.length} suggestions. Citations: ${JSON.stringify(finalized.stats)} from ${results.length} retrieved chunks.`
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
              let evaluationTimeMs = 0;
              let evaluationStatus = 'completed';
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

                evaluationTimeMs = Number.isFinite(evaluation?.evaluationTimeMs) ? evaluation.evaluationTimeMs : (Date.now() - evaluationStartedAt);
                evaluationStatus = evaluation?.status === 'failed' ? 'failed' : 'completed';

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
            // Only the sources the answer cites, already ranked and numbered by finalizeAnswer.
            const allSources = citedSources;

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
              question: question.trim(),
              citationFormat: 'numbered',
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
          const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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

      if (path === '/api/chat/sessions/search' && req.method === 'GET') {
        try {
          const userId = getAuthenticatedUserId(req);
          const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const searchQuery = (urlParsed.searchParams.get('q') || urlParsed.searchParams.get('query') || '').trim();
          if (!searchQuery) {
            setJsonHeaders(res, 200);
            res.end(JSON.stringify({ sessions: [] }));
            return;
          }

          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');
          const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

          const titleMatchedSessions = await sessionsCollection
            .find({ user_id: userId, title: { $regex: regex } })
            .toArray();

          const matchedMessages = await messagesCollection
            .find({ user_id: userId, content: { $regex: regex } })
            .sort({ created_at: -1 })
            .limit(50)
            .toArray();

          const matchedSessionIds = new Set(titleMatchedSessions.map(s => s.session_id));
          matchedMessages.forEach(m => matchedSessionIds.add(m.session_id));

          const allMatchedSessions = await sessionsCollection
            .find({ user_id: userId, session_id: { $in: Array.from(matchedSessionIds) } })
            .sort({ last_message_at: -1, updated_at: -1 })
            .toArray();

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({
            query: searchQuery,
            sessions: allMatchedSessions
          }));
        } catch (error) {
          console.error('Search sessions failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to search chat sessions.' }));
        }
        return;
      }

      const sessionExportMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/export$/);
      if (sessionExportMatch && req.method === 'GET') {
        try {
          const sessionId = decodeURIComponent(sessionExportMatch[1]);
          const userId = getAuthenticatedUserId(req);
          const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const format = (urlParsed.searchParams.get('format') || 'markdown').toLowerCase();

          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

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

          if (format === 'json') {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Content-Disposition': `attachment; filename="chat-${sessionId}.json"`
            });
            res.end(JSON.stringify({ session, messages }, null, 2));
            return;
          }

          let mdContent = `# Chat Log: ${session.title || 'Untitled Chat'}\n`;
          mdContent += `**Session ID:** ${session.session_id}\n`;
          mdContent += `**Date:** ${session.created_at || new Date().toISOString()}\n`;
          mdContent += `**Total Messages:** ${messages.length}\n\n---\n\n`;

          messages.forEach((msg) => {
            const sender = msg.role === 'user' ? '👤 User' : '🤖 CLA Legal Assistant';
            const timestamp = msg.created_at ? new Date(msg.created_at).toLocaleString() : '';
            mdContent += `### ${sender} (${timestamp})\n\n${msg.content}\n\n`;
            if (msg.metadata && Array.isArray(msg.metadata.sources) && msg.metadata.sources.length > 0) {
              mdContent += `**Sources:**\n`;
              msg.metadata.sources.forEach((src, sIdx) => {
                mdContent += `- [${sIdx + 1}] ${src.title || src.filename || 'Source'} (${src.source_table || ''})\n`;
              });
              mdContent += `\n`;
            }
            mdContent += `---\n\n`;
          });

          res.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="chat-${sessionId}.md"`
          });
          res.end(mdContent);
        } catch (error) {
          console.error('Export session failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to export chat session.' }));
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
            };
          }

          let searchResults = [];
          if (!assistantMsgDoc) {
            if (session.mode === 'rag') {
              const { contextualizeUserQuery } = require('./contextualizer');
              const contextHistory = previousMessages.slice(0, -1);
              const contextualResult = await contextualizeUserQuery({
                question: payload.content,
                chatHistory: contextHistory,
                db,
                sessionId: session.session_id
              });

              const activeSessionQuery = contextualResult.standaloneQuery || payload.content;
              if (contextualResult.isFollowUp) {
                console.log(`[RAG Session Flow] Follow-up query detected. Contextualized query: "${activeSessionQuery}"`);
              }

              console.log(`[RAG Session Flow] Executing search for question: "${activeSessionQuery}"`);
              let results = [];
              try {
                const prioritizedOutcome = await performPrioritizedLegalSearch(activeSessionQuery, payload.content);
                results = Array.isArray(prioritizedOutcome) ? prioritizedOutcome : (prioritizedOutcome.results || []);
                searchResults = results;
                console.log(`[RAG Session Flow] Search results count: ${results.length}`);
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
                const contextBlock = buildContextBlock(results);

                const systemPrompt = `You are a professional legal research assistant for Indian corporate and commercial law.
You must answer the user's question grounding your answer strictly and ONLY in the provided search context.
Do NOT use any external or general knowledge. If the provided context does not contain enough information to answer the question, state: "I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question."

Style and Tone Requirements:
- Write in a natural, cohesive, humanized legal advisory tone. Do not just copy-paste blocks from the database.
- Present a clear, structured legal explanation.
- Use Markdown formatting for structure: headings (e.g., "### Heading"), bullet points, numbered lists, tables (where data can be formatted in columns), and bold text for key legal terms or sections.
- Avoid printing raw file names or titles inline in the text.
- End every sentence that states law, a holding or a fact from the context with the number of the source it came from in square brackets, e.g. [3] for [Source 3]. Cite only the source that actually states the point; never cite a source only because it is on the same topic.
- Use "## Overview", "## Analysis" and "## Conclusion" as the main headings and "### " for any sub-heading inside the Analysis.
- Write a standalone answer: never mention the database, the context, the sources provided, or gaps in them, and do not add a Sources list.
- Highlight 1 to 3 key statutory rules, holdings, or core answers using double equal signs (e.g., ==Section 135 mandates 2% CSR allocation==) for visual clarity.
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

                const sessionLLmMessages = [];
                for (const m of contextHistory.slice(-6)) {
                  sessionLLmMessages.push({
                    role: m.role === 'assistant' ? 'assistant' : 'user',
                    content: String(m.content || '').substring(0, 500)
                  });
                }
                sessionLLmMessages.push({
                  role: 'user',
                  content: `Question: ${payload.content}\n\nSearch Context:\n${contextBlock}`
                });

                let llmResponse;
                try {
                  llmResponse = await llm.generate({
                    systemPrompt: systemPrompt,
                    messages: sessionLLmMessages,
                    temperature: 0.1,
                    maxTokens: 3500,
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

                suggestions = parsedResponse.suggestions;
                // Same citation step as /api/ask: cited sources only, ranked, numbered [1], [2] ...
                const finalized = finalizeAnswer(parsedResponse.answer, results);
                answerText = finalized.answer;
                uniqueSources = finalized.sources;
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
          }

          // No-answer responses must not carry source citations
          if (/could not find authority/i.test(assistantMsgDoc.content || '') && assistantMsgDoc.metadata) {
            assistantMsgDoc.metadata.sources = [];
            assistantMsgDoc.metadata.citations = [];
          }

          await messagesCollection.insertOne(assistantMsgDoc);

          // Persist evaluation result so queries sent via chat session endpoint appear in Online Eval
          try {
            const evalContexts = Array.isArray(searchResults) ? searchResults.map(r => r.chunk_text || '') : [];
            const evalDoc = buildEvaluationResultDocument({
              requestContext: req.requestContext || { requestId: `req-${randomUUID()}`, sessionId: session.session_id },
              question: payload.content || '',
              answer: assistantMsgDoc.content || '',
              evaluation: { status: 'completed', metricsCalculated: false },
              provider: settings.DEFAULT_LLM_PROVIDER || 'openai',
              model: assistantMsgDoc.metadata?.model || settings.DEFAULT_LLM_MODEL || 'gpt-4o-mini',
              contexts: evalContexts,
              retrievedChunks: evalContexts,
              retrievedChunkIds: Array.isArray(searchResults) ? searchResults.map(r => r.embedding_id || r.record_id || r.parent_id || null).filter(Boolean) : [],
              similarityScores: Array.isArray(searchResults) ? searchResults.map(r => (Number.isFinite(r.score) ? r.score : null)).filter(v => v !== null) : [],
              userId: userId,
              evaluationStatus: 'completed',
              suggestions: assistantMsgDoc.metadata?.follow_up_questions || [],
              source: 'cla_chat',
              metadata: {
                sources: assistantMsgDoc.metadata?.sources || []
              }
            });

            await persistEvaluationResult(db, evalDoc, io);
          } catch (evalErr) {
            console.error('[Chat Session] Failed to persist evaluation record:', evalErr);
          }

          const sessionUpdate = {
            updated_at: new Date().toISOString(),
            last_message_at: new Date().toISOString(),
            message_count: session.message_count + 2
          };

          const shouldGenerateTitle = !session.title || session.title === 'New chat' || session.title === 'New RAG Search' || session.title === '';
          if (shouldGenerateTitle && payload.content) {
            const quickTitle = normalizeGeneratedTitle(payload.content);
            if (quickTitle) {
              sessionUpdate.title = quickTitle;
            }

            // Async background LLM title refinement
            const targetSessionId = session._id;
            setImmediate(async () => {
              try {
                const generatedTitle = await generateConversationTitle({
                  userContent: payload.content,
                  assistantContent: assistantMsgDoc.content,
                  requestContext: req.requestContext,
                });
                if (generatedTitle) {
                  await sessionsCollection.updateOne(
                    { _id: targetSessionId, user_id: userId },
                    { $set: { title: generatedTitle } }
                  );
                }
              } catch (bgTitleErr) {
                console.warn('[Session Title] Background refinement failed:', bgTitleErr?.message);
              }
            });
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

      const sessionDeleteMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)$/);
      if (sessionDeleteMatch && req.method === 'DELETE') {
        try {
          const sessionId = decodeURIComponent(sessionDeleteMatch[1]);
          const userId = getAuthenticatedUserId(req);
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const session = await findOwnedSession(sessionsCollection, sessionId, userId);
          if (!session) {
            setJsonHeaders(res, 404);
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          await sessionsCollection.deleteOne({ _id: session._id });
          await messagesCollection.deleteMany({ session_id: session.session_id, user_id: userId });

          console.log(`[MongoDB] Session ${sessionId} and its messages successfully deleted for user ${userId}`);
          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ success: true, message: 'Session deleted successfully.' }));
        } catch (error) {
          console.error('Delete session failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to delete chat session.' }));
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
          const targetSessionId = payload.session_id || payload.sessionId;
          const targetMessageId = payload.message_id || payload.messageId;
          const feedback = payload.feedback;

          if (!targetSessionId || !targetMessageId) {
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

          await messagesCollection.updateOne(
            {
              session_id: targetSessionId,
              message_id: targetMessageId
            },
            {
              $set: updatePayload,
              $setOnInsert: {
                created_at: new Date().toISOString(),
                user_id: userId,
                role: 'assistant'
              }
            },
            { upsert: true }
          );

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ success: true, feedback: updatePayload.feedback }));
        } catch (error) {
          console.error('Submit feedback failed', error);
          setJsonHeaders(res, 500);
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
      startDbSyncScheduler();
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

