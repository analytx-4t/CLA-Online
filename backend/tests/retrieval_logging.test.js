require('dotenv').config();

const assert = require('assert');
const { connectDB, closeDB } = require('../mongoClient');
const { buildRetrievalLogDocument, persistRetrievalLog, ensureIndexes } = require('../index');

async function run() {
  const db = await connectDB();
  await ensureIndexes(db);

  const requestContext = {
    requestId: 'req-retrieval-test',
    sessionId: 'session-retrieval-test',
  };

  const retrievalLogDocument = buildRetrievalLogDocument({
    requestContext,
    query: 'What is the law?',
    retrievalTime: 123,
    topK: 3,
    retrievedChunks: [
      {
        chunkId: 'chunk-1',
        documentId: 'doc-1',
        rank: 1,
        similarityScore: 0.91,
        content: 'Relevant content',
      },
    ],
  });

  assert.strictEqual(retrievalLogDocument.requestId, 'req-retrieval-test');
  assert.strictEqual(retrievalLogDocument.sessionId, 'session-retrieval-test');
  assert.strictEqual(retrievalLogDocument.query, 'What is the law?');
  assert.strictEqual(retrievalLogDocument.topK, 3);
  assert.strictEqual(retrievalLogDocument.retrievedChunks[0].chunkId, 'chunk-1');

  const retrievalLogsCollection = db.collection('retrieval_logs');
  await retrievalLogsCollection.deleteMany({ requestId: 'req-retrieval-test' });
  await persistRetrievalLog(db, retrievalLogDocument);

  const saved = await retrievalLogsCollection.findOne({ requestId: 'req-retrieval-test' });
  assert.ok(saved, 'Retrieval log should be stored');
  assert.strictEqual(saved.retrievedChunks.length, 1);
  assert.strictEqual(saved.retrievedChunks[0].content, 'Relevant content');

  await retrievalLogsCollection.deleteMany({ requestId: 'req-retrieval-test' });
  await closeDB();
  console.log('Retrieval logging test PASSED');
}

run().catch((error) => {
  console.error('Retrieval logging test FAILED');
  console.error(error);
  process.exit(1);
});
