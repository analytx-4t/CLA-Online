

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
const { parseAnswerAndSuggestions, normalizeFollowUpQuestions } = require('./responseParser');
const { handleAttachmentUpload, buildAttachmentContextBlock } = require('./attachments');
const { createRequestContext } = require('./requestContext');
const { handleAdminRoutes } = require('./adminRoutes');
const { Server } = require('socket.io');

let logfire;

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
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function getSessionLookupFilter(sessionId, userId) {
  return { session_id: sessionId, user_id: userId };
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
    // Handle index key conflict by dropping the old index
    if (error?.codeName === 'IndexKeySpecsConflict' && error?.message?.includes('eval_session_id')) {
      console.log('Found conflicting eval_session_id index, attempting to drop it...');
      try {
        await evaluationResultsCollection.dropIndex('eval_session_id');
        console.log('Successfully dropped conflicting index');
        // Retry creating the correct index
        await evaluationResultsCollection.createIndex({ evaluationSessionId: 1 }, { name: 'eval_session_id' });
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
}) {
  const evaluationData = evaluation && typeof evaluation === 'object' ? evaluation : {};
  const timestamp = new Date().toISOString();
  const normalizedMetadata = {
    tokenUsage: metadata?.tokenUsage ?? null,
    retrievalTime: Number.isFinite(metadata?.retrievalTime ?? retrievalTime) ? (metadata?.retrievalTime ?? retrievalTime) : (Number.isFinite(retrievalTime) ? retrievalTime : null),
    llmTime: Number.isFinite(metadata?.llmTime) ? metadata.llmTime : null,
    ragasVersion: metadata?.ragasVersion ?? null,
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
    goldenAnswer: goldenAnswer ?? null,
    faithfulness: evaluationData.faithfulness ?? null,
    answerRelevancy: evaluationData.answer_relevancy ?? evaluationData.answerRelevancy ?? null,
    contextPrecision: evaluationData.context_precision ?? evaluationData.contextPrecision ?? null,
    contextRecall: evaluationData.context_recall ?? evaluationData.contextRecall ?? null,
    answerCorrectness: evaluationData.answer_correctness ?? evaluationData.answerCorrectness ?? null,
    overallScore: evaluationData.overall_score ?? evaluationData.overallScore ?? calculatedOverallScore,
    provider: provider || null,
    model: model || null,
    datasetVersion: datasetVersion || null,
    retrievedContext: Array.isArray(contexts) ? contexts : null,
    retrievedChunks: Array.isArray(retrievedChunks) ? retrievedChunks : [],
    retrievedChunkIds: Array.isArray(retrievedChunkIds) ? retrievedChunkIds : [],
    similarityScores: Array.isArray(similarityScores) ? similarityScores : [],
    retrievalTime: Number.isFinite(retrievalTime) ? retrievalTime : null,
    evaluationStatus: evaluationStatus || (evaluationData?.status === 'failed' || evaluationData?.error ? 'failed' : 'completed'),
    evaluationTimeMs: Number.isFinite(evaluationTimeMs) ? evaluationTimeMs : null,
    suggestions: Array.isArray(suggestions) ? suggestions : [],
    errorMessage: errorMessage || (evaluationData?.error ? String(evaluationData.error) : null),
    metadata: normalizedMetadata,
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

    if (io && document?.requestId) {
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
function rerankSearchResults(query, results, topK = 5) {
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
  const minimumRelativeScore = bestScore * 0.5;

  const relevantResults = ranked.filter(
    result =>
      result.backend_relevance_score >= minimumRelativeScore
  );

  return relevantResults.slice(0, topK);
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
        htmlResult += `<p style="font-family: var(--font-serif); font-size: 1.15rem; line-height: 1.8; color: var(--text); margin-bottom: 1.6em; font-style: italic; padding-left: 20px; border-left: 3px solid var(--primary-light);">${formattedLine}</p>`;
      } else {
        htmlResult += `<p style="font-family: var(--font-serif); font-size: 1.15rem; line-height: 1.8; color: var(--text); margin-bottom: 1.6em;">${formattedLine}</p>`;
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

  const docContent = highlightTextInHtml(formatDocumentContent(data.html), highlightQuery);
  const highlightBanner = highlightQuery ? `<div class="highlight-banner" id="highlight-banner">Highlighted passage: <strong>${escapeHTML(highlightQuery)}</strong></div>` : '';

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
          <button class="btn btn-secondary" onclick="window.history.back()">← Back to AI Chatbot</button>
        </div>
        <div class="footer-note">CLA Online - Verified Grounded Database Source</div>
        <div></div>
      </div>
    </div>
  </div>

  <script>
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
        highlightBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      // Handle passage ID highlighting from URL params
      const urlParams = new URLSearchParams(window.location.search || '');
      const passageId = urlParams.get('highlight') || '';
      if (passageId) {
        const selector = "[data-passage-id='" + passageId.replace(/[^a-zA-Z0-9-_:.]/g, '') + "']";
        const target = document.querySelector(selector);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('persistent-highlight');
          const removeHighlight = () => {
            target.classList.remove('persistent-highlight');
            window.removeEventListener('click', removeHighlight);
          };
          setTimeout(() => window.addEventListener('click', removeHighlight), 200);
        }
      }
    });
  </script>
</body>
</html>`;
}

    const payload = {
      question,
      answer,
      contexts: trimmedContexts,
      reference: referenceAnswer || null,
    };

    console.log('[RAGAS] Payload prepared for evaluator.');

    const pythonProcess = spawn(evaluationPython, [evaluationScript], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const startTime = Date.now();

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('error', (error) => {
      console.error('[RAGAS] FAILED AT: Launching Python evaluator');
      console.error('[RAGAS] Python launch error:', error);
      resolve({
        status: 'failed',
        error: error.message,
      });
    });

    pythonProcess.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      console.log('[RAGAS] Python exited with code', code, 'in', `${durationMs}ms`);
      console.log('[RAGAS] Raw stdout:');
      console.log(stdout.trim() || '<empty>');
      console.log('[RAGAS] Raw stderr:');
      console.log(stderr.trim() || '<empty>');

      if (stderr.trim() && code === 0) {
        console.warn('[RAGAS] Python emitted stderr despite successful exit.');
      }

      try {
        const result = JSON.parse(stdout.trim());

        if (code !== 0) {
          console.error('[RAGAS] FAILED AT: Python evaluator returned non-zero exit code.');
        }

        console.log('[RAGAS] Parsed metrics:');
        console.log('  Faithfulness:', result.faithfulness ?? null);
        console.log('  Answer Relevancy:', result.answer_relevancy ?? result.answerRelevancy ?? null);
        console.log('  Context Precision:', result.context_precision ?? result.contextPrecision ?? null);
        console.log('  Context Recall:', result.context_recall ?? result.contextRecall ?? null);
        console.log('  Answer Correctness:', result.answer_correctness ?? result.answerCorrectness ?? null);

        resolve(result);
      } catch (error) {
        console.error('[RAGAS] FAILED AT: Parsing Python JSON');
        console.error('[RAGAS] Python stdout (raw):', stdout);
        console.error('[RAGAS] JSON parse error:', error.message);
        resolve({
          status: 'failed',
          error: 'Failed to parse RAGAS evaluation output.',
        });
      }
  });

    pythonProcess.stdin.write(JSON.stringify(payload));
    pythonProcess.stdin.end();
  });
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

      if (path === '/api/ask' && req.method === 'POST') {
        // Wrap entire RAG request in comprehensive tracing
        const executeRAGRequest = async () => {
          const payload = await getRequestBody(req);
          req.requestContext = createRequestContext({
            sessionId: payload?.session_id || null,
            messageId: null,
          });
          const question = payload.question;

          if (!question || typeof question !== 'string' || !question.trim()) {
            setJsonHeaders(res, 400);
            res.end(JSON.stringify({ error: 'Question parameter is required and cannot be empty.' }));
            return;
          }

          console.log(`[RAG Endpoint] Received question: "${question.trim()}"`);

          const attachmentContext = buildAttachmentContextBlock(payload.attachments);
          if (attachmentContext) {
            console.log(`[RAG Endpoint] Using ${payload.attachments.length} attachment(s) as supplementary context.`);
          }

          // Run guardrails early to avoid expensive operations for blocked requests.
          let guardrailResult = null;
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

            if (guardrailResult) {
              console.log('[NeMo Guardrails] Action:', guardrailResult.action, 'Category:', guardrailResult.category);
              if (guardrailResult.action === 'RESPOND') {
                console.log('[RAG Endpoint] Guardrail handled request. Skipping retrieval and generation.');
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

            const expandedQuery =
              queryExpansion.expandedQuery || question.trim();

            const expansionKeywords =
              Array.isArray(queryExpansion.keywords)
                ? queryExpansion.keywords
                : [];

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

            // Existing embedding search remains completely unchanged.
            retrievalStartedAt = Date.now();
            const candidateResults = await traceRetrieval({
              query: retrievalQuery,
              topK: 15,
              performSearch: async () => {
                return await runPythonSearch(retrievalQuery, 15, true);
              },
              requestContext: req.requestContext,
              metadata: {
                component: 'retrieval',
                requestId: req.requestContext.requestId,
                sessionId: req.requestContext.sessionId,
              },
            });
            retrievalTimeMs = Date.now() - retrievalStartedAt;

            // Rerank against the ORIGINAL user question.
            // This prevents query expansion from changing the user's intent.
            results = await traceReranking({
              originalQuestion: question,
              candidateCount: Array.isArray(candidateResults) ? candidateResults.length : 0,
              rerankResults: async () => {
                return rerankSearchResults(question, candidateResults, 5);
              },
              requestContext: req.requestContext,
              metadata: {
                component: 'reranking',
                requestId: req.requestContext.requestId,
                sessionId: req.requestContext.sessionId,
              },
            });

            console.log(
              `[RAG Endpoint] Retrieved ${candidateResults.length} candidates and reranked to ${results.length} results.`
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

          const systemPrompt = `You are a professional legal research assistant for Indian corporate and commercial law.
You must answer the user's question grounding your answer strictly and ONLY in the provided context (the Search Context below, and any ATTACHED DOCUMENT CONTEXT).
Do NOT use any external or general knowledge. If the provided context does not contain enough information to answer the question, state: "I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question."${attachmentPromptRules}

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

          let llmResponse;
          let llmStartedAt = null;
          let llmTimeMs = null;
          try {
            llmStartedAt = Date.now();
            const userContent = userContentParts.join('\n\n');
            
            llmResponse = await traceLLMGeneration({
              provider: llm.constructor.name,
              model: model,
              systemPrompt: systemPrompt,
              userContent: userContent,
              temperature: 0.1,
              maxTokens: 2048,
              generate: async () => {
                return await llm.generate({
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
          } catch (llmErr) {
            console.error('[RAG Endpoint] LLM generation failed:', llmErr);
            await traceError({
              errorType: 'LLMGenerationError',
              errorMessage: llmErr?.message || String(llmErr),
              component: 'llm_generation',
              requestId: req.requestContext.requestId,
              sessionId: req.requestContext.sessionId,
            });
            setJsonHeaders(res, 500);
            res.end(JSON.stringify({ error: 'LLM generation failed.' }));
            return;
          }

          console.log(
            '[RAG Endpoint] Raw LLM response:',
            JSON.stringify(llmResponse, null, 2)
          );

          let answerText =
            llmResponse?.content ||
            llmResponse?.text ||
            llmResponse?.response ||
            llmResponse?.message?.content ||
            llmResponse?.choices?.[0]?.message?.content ||
            '';

          let suggestions = [];

          console.log(
            '[RAG Endpoint] Extracted answer length:',
            answerText.length
          );

          if (!answerText.trim()) {
            console.error(
              '[RAG Endpoint] LLM returned an empty answer. RAGAS evaluation skipped.'
            );

            setJsonHeaders(res, 502);
            res.end(JSON.stringify({
              error: 'The LLM provider returned an empty answer.',
              provider: llmResponse?.provider || settings.DEFAULT_LLM_PROVIDER,
              model: llmResponse?.model || settings.DEFAULT_LLM_MODEL
            }));

            return;
          }
          console.log('[RAG Endpoint] Answer generated successfully.');

          const parsedResponse =
            parseAnswerAndSuggestions(answerText);

          answerText = parsedResponse.answer;
          suggestions = parsedResponse.suggestions;

          console.log(
            `[RAG Endpoint] Extracted ${suggestions.length} suggestions.`
          );
          const ragasContexts = results
            .map(r => r.chunk_text || r.content || r.text || '')
            .filter(context => context && context.trim());

          const evaluation = {
            status: 'disabled',
            message: 'RAGAS evaluation is handled by the dedicated golden dataset flow.',
          };
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

          const uniqueSources = [];
          const seenSources = new Set();
          citedIndices.forEach(idx => {
            const r = results[idx];
            const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
            const fileName =
              (r.original && r.original.child && r.original.child.FileName) ||
              (r.original && r.original.parent && r.original.parent.FileName) ||
              'Unknown';

            const sourceKey = `${title}:::${fileName}`;

            if (!seenSources.has(sourceKey)) {
              seenSources.add(sourceKey);
              uniqueSources.push({
                title,
                filename: fileName,
                source_table: r.source_table,
                record_id: r.record_id,
                parent_id: r.parent_id,
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

          // Fallback to top result's source if no explicit citation found in answer (and answer isn't no-match).
          // Skipped when the answer was grounded in an attachment instead — attaching an unrelated DB
          // source to an answer that only describes the user's own document would be misleading.
          if (uniqueSources.length === 0 && results.length > 0 && !attachmentContext &&
            !answerText.toLowerCase().includes("nothing relevant found") &&
            !answerText.toLowerCase().includes("could not find authority")) {
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

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({
            answer: answerText,
            suggestions: normalizeFollowUpQuestions({ follow_up_questions: suggestions }),
            follow_up_questions: normalizeFollowUpQuestions({ follow_up_questions: suggestions }),
            sources: uniqueSources,
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
          const payload = await getRequestBody(req);
          const requestId = req.requestContext?.requestId || `req-${Date.now()}`;
          const sessionId = payload?.session_id || req.requestContext?.sessionId || null;
          const userId = getAuthenticatedUserId(req);
          const question = payload?.question || '';

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
              results = await runPythonSearch(payload.content, 5, true);
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

          if ((session.title === 'New chat' || session.title === 'New RAG Search') && payload.content) {
            sessionUpdate.title = payload.content.trim().slice(0, 50);
          }

          await sessionsCollection.updateOne(
            { _id: session._id, user_id: userId },
            { $set: sessionUpdate }
          );

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({
            userMessage: userMsgDoc,
            assistantMessage: assistantMsgDoc
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

          if (!session_id || !message_id || !feedback) {
            setJsonHeaders(res, 400);
            res.end(JSON.stringify({ error: 'session_id, message_id, and feedback are required.' }));
            return;
          }

          const messagesCollection = db.collection('chat_messages');
          const result = await messagesCollection.updateOne(
            { session_id, message_id, user_id: userId },
            { $set: { feedback: feedback, updated_at: new Date().toISOString() } }
          );

          if (result.matchedCount === 0) {
            setJsonHeaders(res, 404);
            res.end(JSON.stringify({ error: 'Message not found.' }));
            return;
          }

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ success: true }));
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
  runRagasEvaluation,
  startServer,
};

