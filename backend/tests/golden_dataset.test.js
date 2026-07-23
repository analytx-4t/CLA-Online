const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const XLSX = require('xlsx');
const { parseWorkbookBuffer } = require('../goldenDataset/parser');
const { clearGoldenDataset, uploadDataset, evaluatePreparedDataset, listGoldenDataset, listGoldenDatasetEvaluations } = require('../goldenDataset/service');

test('parseWorkbookBuffer ignores README sheet and reads the dataset sheet', () => {
  const workbook = XLSX.utils.book_new();

  const data = [
    ['id', 'question', 'intent', 'reference', 'source_table', 'source_column', 'row_id', 'notes'],
    ['1', 'What is the law?', 'legal', 'The law says so.', 'cases', 'summary', '42', 'Example note'],
  ];

  const sheet = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Dataset');

  const readmeSheet = XLSX.utils.aoa_to_sheet([['ignore me']]);
  XLSX.utils.book_append_sheet(workbook, readmeSheet, 'README');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const records = parseWorkbookBuffer(buffer);

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    question: 'What is the law?',
    reference: 'The law says so.',
  });
});

test('upload stages rows and evaluation invokes the chatbot pipeline once per question', async () => {
  const askCalls = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/ask' && req.method === 'POST') {
      askCalls.push(req.url);
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          answer: 'generated answer',
          searchResults: [{ chunk_text: 'context' }],
        }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(3997, resolve));
  process.env.GOLDEN_DATASET_ASK_PORT = '3997';
  process.env.GOLDEN_DATASET_EVALUATION_MOCK = '1';

  try {
    await clearGoldenDataset();

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['question', 'reference'],
      ['What is the law?', 'Reference law'],
      ['Another question', 'Reference two'],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    await uploadDataset(buffer);

    let preparedRows = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      preparedRows = await listGoldenDataset();
      if (preparedRows.length === 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(preparedRows.length, 2);

    assert.equal(askCalls.length, 0);
    const result = await evaluatePreparedDataset({ evaluationSessionId: 'test-eval' });
    assert.equal(result.total, 2);
    assert.equal(result.success, 2);
    assert.equal(askCalls.length, 2);
  } finally {
    delete process.env.GOLDEN_DATASET_ASK_PORT;
    delete process.env.GOLDEN_DATASET_EVALUATION_MOCK;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('evaluatePreparedDataset reports failed rows when chatbot generation fails', async () => {
  await clearGoldenDataset();
  process.env.GOLDEN_DATASET_EVALUATION_MOCK = '1';

  try {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['question', 'reference'],
      ['What is the law?', 'Reference law'],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    await uploadDataset(buffer);

    let preparedRows = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      preparedRows = await listGoldenDataset();
      if (preparedRows.length === 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const result = await evaluatePreparedDataset({ evaluationSessionId: 'test-eval-failure' });
    assert.equal(result.total, 1);
    assert.equal(result.success, 0);
    assert.equal(result.failed, 1);
  } finally {
    delete process.env.GOLDEN_DATASET_EVALUATION_MOCK;
  }
});

test('listGoldenDatasetEvaluations exposes streamed evaluation results for the dashboard', async () => {
  await clearGoldenDataset();
  process.env.GOLDEN_DATASET_EVALUATION_MOCK = '1';

  try {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ['question', 'reference'],
      ['What is the law?', 'Reference law'],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    await uploadDataset(buffer);

    let preparedRows = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      preparedRows = await listGoldenDataset();
      if (preparedRows.length === 1) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await evaluatePreparedDataset({ evaluationSessionId: 'test-eval-results' });
    const evaluations = await listGoldenDatasetEvaluations();

    assert.equal(evaluations.length, 1);
    assert.equal(evaluations[0].question, 'What is the law?');
    assert.equal(evaluations[0].status, 'completed');
    assert.deepEqual(evaluations[0].contexts, []);
  } finally {
    delete process.env.GOLDEN_DATASET_EVALUATION_MOCK;
  }
});
