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

    for (const row of rows) {
      try {
        const response = await postJson(`${baseUrl}/api/ask`, {
          question: row.question,
          session_id: row.session_id || null,
        });

        const runDocument = {
          datasetVersion: row.version || null,
          questionId: row.id || row._id?.toString() || null,
          question: row.question,
          chatbotAnswer: response.data?.answer || null,
          referenceAnswer: row.answer || null,
          status: response.statusCode && response.statusCode >= 400 ? 'failed' : 'completed',
          statusCode: response.statusCode || null,
          ragasMetrics: response.data?.evaluation && typeof response.data.evaluation === 'object'
            ? {
                faithfulness: response.data.evaluation.faithfulness ?? null,
                answerRelevancy: response.data.evaluation.answer_relevancy ?? response.data.evaluation.answerRelevancy ?? null,
                contextPrecision: response.data.evaluation.context_precision ?? response.data.evaluation.contextPrecision ?? null,
                contextRecall: response.data.evaluation.context_recall ?? response.data.evaluation.contextRecall ?? null,
                answerCorrectness: response.data.evaluation.answer_correctness ?? response.data.evaluation.answerCorrectness ?? null,
              }
            : null,
          timestamp: new Date().toISOString(),
          error: response.data?.error || null,
        };

        await goldenRunsCollection.insertOne(runDocument);

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
