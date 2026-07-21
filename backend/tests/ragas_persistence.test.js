require('dotenv').config();

const assert = require('assert');
const { connectDB, closeDB } = require('../mongoClient');
const { buildEvaluationResultDocument, ensureIndexes, persistEvaluationResult } = require('../index');

async function run() {
  const db = await connectDB();
  await ensureIndexes(db);

  const requestContext = {
    requestId: 'req-ragas-test',
    sessionId: 'session-ragas-test',
  };

  const evaluationDocument = buildEvaluationResultDocument({
    requestContext,
    question: 'What is the law?',
    answer: 'This is the answer.',
    evaluation: {
      faithfulness: 0.9,
      answer_relevancy: 0.8,
      context_precision: 0.7,
      context_recall: 0.6,
      answer_correctness: 0.5,
    },
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    contexts: ['context one', 'context two'],
    retrievedChunks: ['context one', 'context two'],
    retrievedChunkIds: ['chunk-1', 'chunk-2'],
    similarityScores: [0.91, 0.84],
    retrievalTime: 123.4,
  });

  assert.strictEqual(evaluationDocument.requestId, 'req-ragas-test');
  assert.strictEqual(evaluationDocument.sessionId, 'session-ragas-test');
  assert.strictEqual(evaluationDocument.question, 'What is the law?');
  assert.strictEqual(evaluationDocument.answer, 'This is the answer.');
  assert.strictEqual(evaluationDocument.timestamp, evaluationDocument.evaluationTimestamp);
  assert.strictEqual(evaluationDocument.answerRelevancy, 0.8);
  assert.strictEqual(evaluationDocument.contextPrecision, 0.7);
  assert.strictEqual(evaluationDocument.contextRecall, 0.6);
  assert.strictEqual(evaluationDocument.answerCorrectness, 0.5);
  assert.deepStrictEqual(evaluationDocument.retrievedChunks, ['context one', 'context two']);
  assert.deepStrictEqual(evaluationDocument.retrievedChunkIds, ['chunk-1', 'chunk-2']);
  assert.deepStrictEqual(evaluationDocument.similarityScores, [0.91, 0.84]);
  assert.strictEqual(evaluationDocument.retrievalTime, 123.4);
  assert.strictEqual(evaluationDocument.evaluationStatus, 'completed');
  assert.strictEqual(evaluationDocument.overallScore, 0.7);
  assert.deepStrictEqual(evaluationDocument.metadata, {
    tokenUsage: null,
    retrievalTime: 123.4,
    llmTime: null,
    ragasVersion: null,
  });

  const evaluationResultsCollection = db.collection('evaluation_results');
  await evaluationResultsCollection.deleteMany({ requestId: 'req-ragas-test' });
  await persistEvaluationResult(db, evaluationDocument);
  await persistEvaluationResult(db, {
    ...evaluationDocument,
    overallScore: 0.75,
    metadata: {
      tokenUsage: { promptTokens: 100, completionTokens: 50 },
      retrievalTime: 125,
      llmTime: 250,
      ragasVersion: '0.1.0',
    },
  });

  const saved = await evaluationResultsCollection.findOne({ requestId: 'req-ragas-test' });
  assert.ok(saved, 'Evaluation result should be stored');
  assert.strictEqual(saved.provider, 'groq');
  assert.strictEqual(saved.model, 'llama-3.3-70b-versatile');
  assert.strictEqual(saved.overallScore, 0.75);
  assert.strictEqual(saved.evaluationStatus, 'completed');
  assert.strictEqual(saved.metadata?.ragasVersion, '0.1.0');
  assert.strictEqual(saved.metadata?.llmTime, 250);

  await evaluationResultsCollection.deleteMany({ requestId: 'req-ragas-test' });
  await closeDB();
  console.log('RAGAS persistence test PASSED');
}

run().catch((error) => {
  console.error('RAGAS persistence test FAILED');
  console.error(error);
  process.exit(1);
});
