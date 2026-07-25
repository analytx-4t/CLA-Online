const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { parseWorkbookBuffer } = require('./parser');
const { runFullEvaluation } = require('../llm/judge');

let inMemoryDataset = [];
let rowStatusMap = new Map();
let evaluationResults = [];
// Tracks how many times a dataset file has been uploaded this server
// session — deliberately NOT reset by clearGoldenDataset(), since it's a
// running "uploads so far" counter, not part of the current dataset's
// state. Like the rest of this module, it resets only on server restart.
let totalUploadsCount = 0;
let datasetState = {
  version: null,
  uploadedAt: null,
  recordCount: 0,
  completedCount: 0,
  failedCount: 0,
  totalCount: 0,
  generationStatus: 'idle',
  evaluationSessionId: null,
  evaluationInProgress: false,
  lastEvaluationStatus: null,
  lastEvaluatedVersion: null,
  evaluationStartedAt: null,
};

function createVersionStamp() {
  const now = new Date();
  return `${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getEvaluationPythonExecutable() {
  if (process.env.GOLDEN_DATASET_EVALUATION_PYTHON) {
    return process.env.GOLDEN_DATASET_EVALUATION_PYTHON;
  }

  const pythonExecutableName = process.platform === 'win32' ? 'python.exe' : 'python';
  const pythonExecutablePath = path.join(
    __dirname,
    '..',
    'evaluation_v2',
    '.venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    pythonExecutableName
  );

  if (fs.existsSync(pythonExecutablePath)) {
    return pythonExecutablePath;
  }

  return 'python';
}

function getEvaluationScriptPath() {
  if (process.env.GOLDEN_DATASET_EVALUATION_SCRIPT) {
    return process.env.GOLDEN_DATASET_EVALUATION_SCRIPT;
  }

  return path.join(__dirname, '..', 'evaluation_v2', 'ragas_runner.py');
}

function postToAskEndpoint(question) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ question });
    const askPort = Number(process.env.GOLDEN_DATASET_ASK_PORT || 3000);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: askPort,
        path: '/api/ask',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Chatbot pipeline request failed with status ${res.statusCode}: ${body}`));
            return;
          }

          try {
            const data = JSON.parse(body || '{}');
            resolve(data);
          } catch (error) {
            reject(new Error(`Failed to parse chatbot pipeline response: ${error.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function uploadDataset(buffer, db) {
  const records = parseWorkbookBuffer(buffer);
  const now = new Date();
  const version = createVersionStamp();

  inMemoryDataset = [];
  evaluationResults = [];
  rowStatusMap = new Map();
  totalUploadsCount += 1;
  datasetState = {
    version,
    uploadedAt: now.toISOString(),
    recordCount: records.length,
    completedCount: records.length,
    failedCount: 0,
    totalCount: records.length,
    generationStatus: 'uploaded',
    evaluationSessionId: null,
    evaluationInProgress: false,
    lastEvaluationStatus: null,
    lastEvaluatedVersion: null,
    evaluationStartedAt: null,
  };

  inMemoryDataset = records
    .filter((record) => String(record.question || '').trim())
    .map((record) => ({
      question: String(record.question || '').trim(),
      answer: '',
      reference: String(record.reference || '').trim(),
      contexts: [],
    }));
  datasetState.recordCount = inMemoryDataset.length;
  datasetState.totalCount = inMemoryDataset.length;
  for (let index = 0; index < inMemoryDataset.length; index += 1) {
    rowStatusMap.set(String(index + 1), { status: 'uploaded', error: null });
  }

  if (db) {
    try {
      await db.collection('golden_dataset_records').deleteMany({});
      await db.collection('golden_dataset_runs').deleteMany({});
      if (inMemoryDataset.length > 0) {
        await db.collection('golden_dataset_records').insertMany(inMemoryDataset.map((r, i) => ({ ...r, rowIndex: i + 1, version })));
      }
      await db.collection('golden_dataset_state').updateOne(
        { _id: 'current_state' },
        { $set: { state: datasetState, totalUploadsCount, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    } catch (err) {
      console.warn('[Golden Dataset] Failed to persist uploaded dataset to DB:', err.message);
    }
  }

  return {
    message: 'Golden dataset uploaded. Click Run Evaluation to generate answers and evaluate the dataset.',
    count: inMemoryDataset.length,
    version,
    evaluationSessionId: null,
    generationStatus: 'uploaded',
  };
}

function getPreparedDatasetRows() {
  return inMemoryDataset.map((record, index) => {
    const rowId = String(index + 1);
    const rowStatus = rowStatusMap.get(rowId) || { status: 'completed', error: null };

    return {
      question: record.question,
      answer: record.answer,
      reference: record.reference,
      contexts: Array.isArray(record.contexts) ? record.contexts : [],
      status: rowStatus.status,
      error: rowStatus.error || null,
    };
  });
}

async function waitForPreparedDatasetReady(timeoutMs = 10000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const rows = getPreparedDatasetRows();
    if (datasetState.generationStatus !== 'processing' || rows.length > 0) {
      return rows;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return getPreparedDatasetRows();
}

async function generateDatasetRow(index) {
  const row = inMemoryDataset[index];
  if (!row) return null;

  rowStatusMap.set(String(index + 1), { status: 'generating', error: null });
  try {
    const pipelineResponse = await postToAskEndpoint(row.question);
    row.answer = String(pipelineResponse?.answer || '').trim();
    row.contexts = Array.isArray(pipelineResponse?.searchResults)
      ? pipelineResponse.searchResults
          .map((result) => result?.chunk_text || result?.content || result?.text || '')
          .filter((context) => typeof context === 'string' && context.trim())
      : [];
    rowStatusMap.set(String(index + 1), { status: 'generated', error: null });
  } catch (error) {
    row.answer = '';
    row.contexts = [];
    rowStatusMap.set(String(index + 1), { status: 'failed', error: error?.message || 'Generation failed' });
  }
  return row;
}

function runEvaluationProcess(rows) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      dataset: rows.map((row) => ({
        question: row.question || '',
        answer: row.answer || '',
        reference: row.reference || '',
        contexts: Array.isArray(row.contexts) ? row.contexts : [],
      })),
    });
    const evaluatorProcess = spawn(getEvaluationPythonExecutable(), [getEvaluationScriptPath()], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    evaluatorProcess.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    evaluatorProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    evaluatorProcess.on('error', () => resolve({ status: 'failed', error: 'Unable to launch the evaluation process.' }));
    evaluatorProcess.on('close', (code) => {
      if (code !== 0) {
        resolve({ status: 'failed', error: stderr.trim() || 'Evaluation process exited with an error.' });
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        resolve({ status: 'failed', error: error.message || 'Unable to parse evaluation output.' });
      }
    });
    evaluatorProcess.stdin.end(payload);
  });
}

async function evaluatePreparedDataset({ onProgress, evaluationSessionId, db } = {}) {
  const preparedRows = await waitForPreparedDatasetReady();
  const total = preparedRows.length;
  const activeEvaluationSessionId = evaluationSessionId || createVersionStamp();
  const results = [];
  evaluationResults = [];
  if (db) {
    try {
      await db.collection('golden_dataset_runs').deleteMany({});
    } catch (err) {
      console.warn('[Golden Dataset] Failed to clear DB runs at eval start:', err.message);
    }
  }
  const evaluationStartedAt = Date.now();

  datasetState.evaluationInProgress = true;
  datasetState.generationStatus = 'evaluating';
  datasetState.evaluationSessionId = activeEvaluationSessionId;
  datasetState.lastEvaluationStatus = 'running';
  datasetState.evaluationStartedAt = new Date().toISOString();
  datasetState.lastEvaluatedVersion = datasetState.version;

  for (let index = 0; index < preparedRows.length; index += 1) {
    const row = await generateDatasetRow(index);
    let evalResult;
    if (process.env.GOLDEN_DATASET_EVALUATION_MOCK === '1') {
      evalResult = {
        faithfulness: 0.92,
        answerRelevancy: 0.9,
        contextPrecision: 0.88,
        contextRecall: 0.86,
        overallScore: 0.89,
        status: 'completed',
      };
    } else if (rowStatusMap.get(String(index + 1))?.status === 'failed') {
      evalResult = { status: 'failed', errors: [rowStatusMap.get(String(index + 1))?.error || 'Generation failed'] };
    } else {
      try {
        evalResult = await runFullEvaluation({
          question: row.question,
          answer: row.answer,
          contexts: row.contexts,
          groundTruth: row.reference || null,
        });
      } catch (evalErr) {
        console.error('[Golden Dataset] Evaluation failed for row:', evalErr);
        evalResult = { status: 'failed', errors: [evalErr?.message || 'Evaluation failed'] };
      }
    }

    const evaluationFailure = evalResult?.status === 'failed';
    const timestamp = new Date().toISOString();
    const completedRows = index + 1;
    const elapsedMs = Date.now() - evaluationStartedAt;
    const averageMsPerRow = completedRows > 0 ? elapsedMs / completedRows : 0;
    const remainingRows = Math.max(0, total - completedRows);
    const estimatedTimeMs = remainingRows > 0 ? Math.round(averageMsPerRow * remainingRows) : 0;
    const estimatedTimeSeconds = Math.max(0, Math.ceil(estimatedTimeMs / 1000));

    const rowResult = {
      question: row.question,
      referenceAnswer: row.reference || null,
      generatedAnswer: row.answer || null,
      chatbotAnswer: row.answer || null,
      contexts: Array.isArray(row.contexts) ? row.contexts : [],
      retrievedChunks: Array.isArray(row.contexts) ? row.contexts : [],
      faithfulness: evalResult?.faithfulness ?? null,
      answerRelevancy: evalResult?.answerRelevancy ?? null,
      contextPrecision: evalResult?.contextPrecision ?? null,
      contextRecall: evalResult?.contextRecall ?? null,
      answerCorrectness: evalResult?.overallScore ?? evalResult?.answerRelevancy ?? null,
      overallScore: evalResult?.overallScore ?? null,
      timestamp,
      status: evaluationFailure ? 'failed' : 'completed',
      error: evaluationFailure ? (evalResult?.errors?.join('; ') || 'Evaluation failed') : null,
      evaluationSessionId: activeEvaluationSessionId,
    };

    results.push(rowResult);
    evaluationResults.push(rowResult);

    if (db) {
      try {
        await db.collection('golden_dataset_runs').insertOne({ ...rowResult });
      } catch (dbErr) {
        console.warn('[Golden Dataset] Failed to insert golden_dataset_run to DB:', dbErr.message);
      }
    }

    onProgress?.({
      current: completedRows,
      currentRow: completedRows,
      total,
      percentage: total ? Math.round((completedRows / total) * 100) : 100,
      completed: true,
      completedRows,
      remainingRows,
      estimatedTimeSeconds,
      elapsedSeconds: Math.max(0, Math.ceil(elapsedMs / 1000)),
      result: rowResult,
    });
  }

  const successCount = results.filter((result) => result.status === 'completed').length;
  const failedCount = results.length - successCount;

  datasetState.lastEvaluationStatus = failedCount === results.length && results.length > 0 ? 'failed' : 'completed';
  datasetState.evaluationInProgress = false;
  datasetState.lastEvaluationCompletedAt = new Date().toISOString();
  datasetState.generationStatus = 'completed';

  if (db) {
    try {
      await db.collection('golden_dataset_state').updateOne(
        { _id: 'current_state' },
        { $set: { state: datasetState, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    } catch (dbErr) {
      console.warn('[Golden Dataset] Failed to update golden_dataset_state in DB:', dbErr.message);
    }
  }

  return {
    status: failedCount === results.length && results.length > 0 ? 'failed' : 'completed',
    total: results.length,
    success: successCount,
    failed: failedCount,
    count: results.length,
    results,
  };
}

async function listGoldenDataset(db) {
  const prepared = getPreparedDatasetRows();
  if (prepared.length > 0) {
    return prepared;
  }
  if (db) {
    try {
      const docs = await db.collection('golden_dataset_records').find({}).toArray();
      if (docs.length > 0) {
        return docs.map((doc) => ({
          question: doc.question || null,
          answer: doc.answer || null,
          reference: doc.reference || null,
          contexts: Array.isArray(doc.contexts) ? doc.contexts : [],
        }));
      }
    } catch (err) {
      console.warn('[Golden Dataset] Failed to read golden_dataset_records from db:', err.message);
    }
  }
  return prepared;
}

async function listGoldenDatasetEvaluations(db) {
  const mapEvalRow = (item) => {
    const faithfulness = item.faithfulness ?? item.ragasMetrics?.faithfulness ?? null;
    const answerRelevancy = item.answerRelevancy ?? item.answer_relevancy ?? item.ragasMetrics?.answerRelevancy ?? item.ragasMetrics?.answer_relevancy ?? null;
    const contextPrecision = item.contextPrecision ?? item.context_precision ?? item.ragasMetrics?.contextPrecision ?? item.ragasMetrics?.context_precision ?? null;
    const contextRecall = item.contextRecall ?? item.context_recall ?? item.ragasMetrics?.contextRecall ?? item.ragasMetrics?.context_recall ?? null;
    const answerCorrectness = item.answerCorrectness ?? item.answer_correctness ?? item.ragasMetrics?.answerCorrectness ?? item.ragasMetrics?.answer_correctness ?? null;
    let overallScore = item.overallScore ?? item.overall_score ?? item.ragasMetrics?.overallScore ?? null;

    if (overallScore === null && (faithfulness !== null || answerRelevancy !== null)) {
      const vals = [faithfulness, answerRelevancy, contextPrecision, contextRecall].filter((v) => typeof v === 'number');
      if (vals.length > 0) {
        overallScore = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
      }
    }

    return {
      id: item._id?.toString() || item.id || null,
      question: item.question || null,
      status: item.status || 'completed',
      faithfulness,
      answerRelevancy,
      contextPrecision,
      contextRecall,
      answerCorrectness: answerCorrectness ?? overallScore,
      overallScore,
      retrievedChunks: Array.isArray(item.retrievedChunks) && item.retrievedChunks.length ? item.retrievedChunks : (Array.isArray(item.contexts) ? item.contexts : []),
      contexts: Array.isArray(item.contexts) && item.contexts.length ? item.contexts : (Array.isArray(item.retrievedChunks) ? item.retrievedChunks : []),
      chatbotAnswer: item.chatbotAnswer || item.generatedAnswer || item.generated_answer || item.answer || null,
      referenceAnswer: item.referenceAnswer || item.reference_answer || item.reference || null,
      timestamp: item.timestamp || null,
      evaluationSessionId: item.evaluationSessionId || null,
      error: item.error || null,
    };
  };

  if (db) {
    try {
      const docs = await db.collection('golden_dataset_runs').find({}).sort({ timestamp: -1 }).toArray();
      if (docs.length > 0) {
        return docs.map(mapEvalRow);
      }
    } catch (err) {
      console.warn('[Golden Dataset] Failed to read golden_dataset_runs from db:', err.message);
    }
  }
  return evaluationResults.map(mapEvalRow);
}

async function getGoldenDatasetById(id) {
  const rowIndex = Number(id) - 1;
  const record = inMemoryDataset[rowIndex] || null;
  if (!record) {
    return null;
  }

  const rowStatus = rowStatusMap.get(String(rowIndex + 1)) || { status: 'completed', error: null };

  return {
    question: record.question,
    answer: record.answer,
    reference: record.reference,
    contexts: Array.isArray(record.contexts) ? record.contexts : [],
    status: rowStatus.status,
    error: rowStatus.error || null,
  };
}

async function clearGoldenDataset(db) {
  const deletedCount = inMemoryDataset.length;
  inMemoryDataset = [];
  rowStatusMap = new Map();
  evaluationResults = [];
  datasetState = {
    version: null,
    uploadedAt: null,
    recordCount: 0,
    completedCount: 0,
    failedCount: 0,
    totalCount: 0,
    generationStatus: 'idle',
    evaluationSessionId: null,
    evaluationInProgress: false,
    lastEvaluationStatus: null,
    lastEvaluatedVersion: null,
    evaluationStartedAt: null,
  };

  if (db) {
    try {
      await db.collection('golden_dataset_records').deleteMany({});
      await db.collection('golden_dataset_runs').deleteMany({});
      await db.collection('golden_dataset_state').deleteMany({});
    } catch (err) {
      console.warn('[Golden Dataset] Failed to clear DB collections:', err.message);
    }
  }

  return { deletedCount };
}

async function getDatasetState(db) {
  if (!datasetState.version && db) {
    try {
      const stateDoc = await db.collection('golden_dataset_state').findOne({ _id: 'current_state' });
      if (stateDoc) {
        datasetState = { ...stateDoc.state };
      }
    } catch (err) {
      console.warn('[Golden Dataset] Failed to read dataset state from db:', err.message);
    }
  }
  return { ...datasetState, totalUploadsCount };
}

module.exports = {
  uploadDataset,
  listGoldenDataset,
  listGoldenDatasetEvaluations,
  getGoldenDatasetById,
  clearGoldenDataset,
  getDatasetState,
  evaluatePreparedDataset,
};
