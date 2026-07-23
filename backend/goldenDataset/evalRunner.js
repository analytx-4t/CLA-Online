const http = require('http');
const { connectDB, closeDB } = require('../mongoClient');

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsedUrl = new URL(url);
    const request = http.request({
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => {
      let responseBody = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        try {
          const parsed = responseBody ? JSON.parse(responseBody) : {};
          resolve({ statusCode: response.statusCode, data: parsed });
        } catch (error) {
          resolve({ statusCode: response.statusCode, data: responseBody });
        }
      });
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function runGoldenDatasetEvaluation({ baseUrl = process.env.GOLDEN_DATASET_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`, db } = {}) {
  const database = db || await connectDB();

  try {
    const collection = database.collection('golden_dataset');
    const rows = await collection.find({}).toArray();

    if (!rows.length) {
      return { status: 'empty', count: 0 };
    }

    const stateCollection = database.collection('golden_dataset_state');
    const state = await stateCollection.findOne({ _id: 'current' });
    const currentVersion = state?.version || null;

    if (state?.lastEvaluatedVersion === currentVersion && state?.lastEvaluationStatus === 'completed') {
      return { status: 'skipped', count: 0, reason: 'already evaluated for current dataset version' };
    }

    await stateCollection.updateOne(
      { _id: 'current' },
      {
        $set: {
          evaluationInProgress: true,
          evaluationVersion: currentVersion,
          evaluationStartedAt: new Date().toISOString(),
          lastEvaluationStatus: 'running',
        },
      },
      { upsert: true }
    );

    const results = [];
    const goldenRunsCollection = database.collection('golden_dataset_runs');
    let rowIndex = 0;

    for (const row of rows) {
      rowIndex += 1;
      console.log(`[Golden Dataset] Evaluating ${rowIndex}/${rows.length}: "${String(row.question || '').slice(0, 80)}"`);

      try {
        const response = await postJson(`${baseUrl}/api/ask`, {
          question: row.question,
          session_id: row.session_id || null,
          // Marks this call as an internal benchmark run rather than real
          // end-user traffic, so its evaluation doesn't show up on the
          // live Online Eval page (see requestSource in backend/index.js).
          source: 'golden_dataset',
        });

        const evaluationResult = response.data?.evaluation && typeof response.data.evaluation === 'object' ? response.data.evaluation : null;

        const runDocument = {
          datasetVersion: row.version || null,
          questionId: row.id || row._id?.toString() || null,
          question: row.question,
          chatbotAnswer: response.data?.answer || null,
          referenceAnswer: row.answer || null,
          status: response.statusCode && response.statusCode >= 400 ? 'failed' : (evaluationResult?.status || 'completed'),
          statusCode: response.statusCode || null,
          ragasMetrics: evaluationResult
            ? {
                faithfulness: evaluationResult.faithfulness ?? null,
                answerRelevancy: evaluationResult.answerRelevancy ?? null,
                contextPrecision: evaluationResult.contextPrecision ?? null,
                contextRecall: evaluationResult.contextRecall ?? null,
                piiLeakage: evaluationResult.piiLeakage ?? null,
              }
            : null,
          overallScore: evaluationResult?.overallScore ?? null,
          timestamp: new Date().toISOString(),
          error: response.data?.error || null,
        };

        await goldenRunsCollection.insertOne(runDocument);
        console.log(`[Golden Dataset] ${rowIndex}/${rows.length} done — status=${runDocument.status}, overallScore=${runDocument.overallScore ?? 'n/a'}`);

        results.push({
          questionId: row.id || row._id?.toString() || null,
          question: row.question,
          referenceAnswer: row.answer || null,
          statusCode: response.statusCode,
          response: response.data,
          savedRunId: runDocument._id?.toString?.() || null,
        });
      } catch (error) {
        const failedRunDocument = {
          datasetVersion: row.version || null,
          questionId: row.id || row._id?.toString() || null,
          question: row.question,
          chatbotAnswer: null,
          referenceAnswer: row.answer || null,
          status: 'failed',
          error: error.message,
          timestamp: new Date().toISOString(),
        };

        await goldenRunsCollection.insertOne(failedRunDocument);
        console.error(`[Golden Dataset] ${rowIndex}/${rows.length} failed:`, error.message);

        results.push({
          questionId: row.id || row._id?.toString() || null,
          question: row.question,
          referenceAnswer: row.answer || null,
          error: error.message,
          savedRunId: failedRunDocument._id?.toString?.() || null,
        });
      }
    }

    await stateCollection.updateOne(
      { _id: 'current' },
      {
        $set: {
          lastEvaluatedVersion: currentVersion,
          lastEvaluationStatus: 'completed',
          lastEvaluationCompletedAt: new Date().toISOString(),
          evaluationInProgress: false,
        },
      },
      { upsert: true }
    );

    return { status: 'completed', count: results.length, results };
  } catch (error) {
    if (db) {
      const stateCollection = database.collection('golden_dataset_state');
      await stateCollection.updateOne(
        { _id: 'current' },
        {
          $set: {
            lastEvaluationStatus: 'failed',
            evaluationInProgress: false,
            lastEvaluationError: error.message,
          },
        },
        { upsert: true }
      );
    }
    throw error;
  } finally {
    if (!db) {
      await closeDB();
    }
  }
}

if (require.main === module) {
  runGoldenDatasetEvaluation()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  runGoldenDatasetEvaluation,
};
