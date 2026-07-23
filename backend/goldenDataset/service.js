const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { parseWorkbookBuffer } = require('./parser');

let inMemoryDataset = [];
let rowStatusMap = new Map();
let evaluationResults = [];
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

async function uploadDataset(buffer) {
  const records = parseWorkbookBuffer(buffer);
  const now = new Date();
  const version = createVersionStamp();

  inMemoryDataset = [];
  evaluationResults = [];
  rowStatusMap = new Map();
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

async function evaluatePreparedDataset({ onProgress, evaluationSessionId } = {}) {
  const preparedRows = await waitForPreparedDatasetReady();
  const total = preparedRows.length;
  const activeEvaluationSessionId = evaluationSessionId || createVersionStamp();
  const results = [];
  const evaluationStartedAt = Date.now();

  datasetState.evaluationInProgress = true;
  datasetState.generationStatus = 'evaluating';
  datasetState.evaluationSessionId = activeEvaluationSessionId;
  datasetState.lastEvaluationStatus = 'running';
  datasetState.evaluationStartedAt = new Date().toISOString();
  datasetState.lastEvaluatedVersion = datasetState.version;

  for (let index = 0; index < preparedRows.length; index += 1) {
    const row = await generateDatasetRow(index);
    let evaluationPayload;
    if (process.env.GOLDEN_DATASET_EVALUATION_MOCK === '1') {
      evaluationPayload = [{
        faithfulness: 0.92,
        answer_relevancy: 0.9,
        context_precision: 0.88,
        context_recall: 0.86,
        answer_correctness: 0.9,
        overall_score: 0.89,
      }];
    } else if (rowStatusMap.get(String(index + 1))?.status === 'failed') {
      evaluationPayload = { status: 'failed', error: rowStatusMap.get(String(index + 1))?.error || 'Generation failed' };
    } else {
      evaluationPayload = await runEvaluationProcess([row]);
    }
    const evaluationFailure = evaluationPayload && typeof evaluationPayload === 'object' && (evaluationPayload.status === 'failed' || evaluationPayload.error);
    const evaluationFailureMessage = evaluationFailure ? evaluationPayload.error || null : null;
    const timestamp = new Date().toISOString();
    const evaluationRow = Array.isArray(evaluationPayload) ? evaluationPayload[0] || {} : {};
    const rowStatus = evaluationFailure
      ? 'failed'
      : evaluationRow?.status === 'failed' || evaluationRow?.error
        ? 'failed'
        : 'completed';
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
      faithfulness: evaluationRow?.faithfulness ?? null,
      answerRelevancy: evaluationRow?.answer_relevancy ?? evaluationRow?.answerRelevancy ?? null,
      contextPrecision: evaluationRow?.context_precision ?? evaluationRow?.contextPrecision ?? null,
      contextRecall: evaluationRow?.context_recall ?? evaluationRow?.contextRecall ?? null,
      answerCorrectness: evaluationRow?.answer_correctness ?? evaluationRow?.answerCorrectness ?? null,
      overallScore: evaluationRow?.overall_score ?? evaluationRow?.overallScore ?? null,
      timestamp,
      status: rowStatus,
      error: rowStatus === 'failed' ? evaluationRow?.error || evaluationFailureMessage : null,
      evaluationSessionId: activeEvaluationSessionId,
    };

    results.push(rowResult);
    evaluationResults.push(rowResult);
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

  return {
    status: failedCount === results.length && results.length > 0 ? 'failed' : 'completed',
    total: results.length,
    success: successCount,
    failed: failedCount,
    count: results.length,
    results,
  };
}

async function listGoldenDataset() {
  return getPreparedDatasetRows();
}

async function listGoldenDatasetEvaluations() {
  return evaluationResults.map((row) => ({
    ...row,
    contexts: Array.isArray(row.contexts) ? row.contexts : [],
  }));
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

async function clearGoldenDataset() {
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

  return { deletedCount };
}

async function getDatasetState() {
  return { ...datasetState };
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
