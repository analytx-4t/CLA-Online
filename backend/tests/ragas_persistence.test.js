require('dotenv').config();

const assert = require('assert');
const { connectDB, closeDB } = require('../mongoClient');
const { buildEvaluationResultDocument, ensureIndexes } = require('../index');

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

  const evaluationResultsCollection = db.collection('evaluation_results');
  await evaluationResultsCollection.deleteMany({ requestId: 'req-ragas-test' });
  await evaluationResultsCollection.insertOne(evaluationDocument);

  const saved = await evaluationResultsCollection.findOne({ requestId: 'req-ragas-test' });
  assert.ok(saved, 'Evaluation result should be stored');
  assert.strictEqual(saved.provider, 'groq');
  assert.strictEqual(saved.model, 'llama-3.3-70b-versatile');

  await evaluationResultsCollection.deleteMany({ requestId: 'req-ragas-test' });
  await closeDB();
  console.log('RAGAS persistence test PASSED');
}

run().catch((error) => {
  console.error('RAGAS persistence test FAILED');
  console.error(error);
  process.exit(1);
});
