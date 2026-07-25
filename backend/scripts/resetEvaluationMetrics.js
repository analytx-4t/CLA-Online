const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { MongoClient } = require('mongodb');

async function resetMetrics() {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
  const targetDatabases = [process.env.MONGODB_DATABASE || 'cla_legal_chat', 'cla_legal_chat_DB'];
  const client = new MongoClient(mongoUri);

  try {
    await client.connect();

    for (const dbName of targetDatabases) {
      console.log(`[Reset] Purging MongoDB database: ${dbName}`);
      const db = client.db(dbName);

      const collectionsToPurge = [
        'evaluation_results',
        'golden_dataset_runs',
        'golden_dataset_records',
        'golden_dataset_state',
        'chat_sessions',
        'chat_messages',
        'portkey_logs',
        'retrieval_logs',
      ];

      for (const collName of collectionsToPurge) {
        try {
          const res = await db.collection(collName).deleteMany({});
          console.log(`[Reset] [DB: ${dbName}] Cleared collection '${collName}': deleted ${res.deletedCount} documents.`);
        } catch (err) {
          console.warn(`[Reset] [DB: ${dbName}] Note on collection '${collName}': ${err.message}`);
        }
      }
    }

    console.log('[Reset] Metrics reset complete successfully across all databases.');
  } catch (error) {
    console.error('[Reset] Failed to reset metrics:', error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

resetMetrics();
