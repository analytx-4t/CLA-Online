const busboy = require('busboy');
const { uploadDataset, listGoldenDataset, getGoldenDatasetById, clearGoldenDataset, getDatasetState, evaluatePreparedDataset, listGoldenDatasetEvaluations } = require('./service');

function setJsonHeaders(res, statusCode) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-auth-user-id',
  });
}

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function handleGoldenDatasetRoutes(req, res, db) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const path = requestUrl.pathname || '/';
  const stream = requestUrl.searchParams.get('stream') === 'true' || (req.headers.accept || '').includes('text/event-stream');

  if (path === '/api/admin/golden-dataset' && req.method === 'GET') {
    try {
      const records = await listGoldenDataset();
      const state = await getDatasetState();
      setJsonHeaders(res, 200);
      res.end(JSON.stringify({
        records,
        version: state?.version || null,
        uploadedAt: state?.uploadedAt || null,
        evaluationSessionId: state?.evaluationSessionId || null,
        generationStatus: state?.generationStatus || 'idle',
        totalCount: state?.totalCount ?? records.length,
        completedCount: state?.completedCount ?? records.length,
        failedCount: state?.failedCount ?? 0,
        evaluationState: {
          evaluationInProgress: Boolean(state?.evaluationInProgress),
          lastEvaluationStatus: state?.lastEvaluationStatus || null,
          lastEvaluatedVersion: state?.lastEvaluatedVersion || null,
          evaluationStartedAt: state?.evaluationStartedAt || null,
          recordCount: state?.recordCount ?? records.length,
        },
      }));
      return true;
    } catch (error) {
      setJsonHeaders(res, 500);
      res.end(JSON.stringify({ error: 'Unable to load golden dataset.' }));
      return true;
    }
  }

  if (path === '/api/admin/golden-dataset/upload' && req.method === 'POST') {
    try {
      const contentType = req.headers['content-type'] || '';

      if (contentType.includes('multipart/form-data')) {
        const bb = busboy({ headers: req.headers });
        const chunks = [];
        let fileFound = false;

        bb.on('file', (fieldname, stream, info) => {
          fileFound = true;
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {});
        });

        bb.on('finish', async () => {
          try {
            const body = Buffer.concat(chunks);
            if (!fileFound || !body.length) {
              setJsonHeaders(res, 400);
              res.end(JSON.stringify({ error: 'No file uploaded.' }));
              return;
            }

            const result = await uploadDataset(body);
            setJsonHeaders(res, 200);
            res.end(JSON.stringify(result));
          } catch (error) {
            setJsonHeaders(res, 400);
            res.end(JSON.stringify({ error: error.message || 'Failed to upload golden dataset.' }));
          }
        });

        bb.on('error', () => {
          setJsonHeaders(res, 400);
          res.end(JSON.stringify({ error: 'Upload failed.' }));
        });

        req.pipe(bb);
        return true;
      }

      const bodyChunks = [];
      req.on('data', (chunk) => bodyChunks.push(chunk));
      req.on('end', async () => {
        try {
          const body = Buffer.concat(bodyChunks);
          if (!body.length) {
            setJsonHeaders(res, 400);
            res.end(JSON.stringify({ error: 'No file uploaded.' }));
            return;
          }

          const result = await uploadDataset(body);
          setJsonHeaders(res, 200);
          res.end(JSON.stringify(result));
        } catch (error) {
          setJsonHeaders(res, 400);
          res.end(JSON.stringify({ error: error.message || 'Failed to upload golden dataset.' }));
        }
      });
      req.on('error', () => {
        setJsonHeaders(res, 400);
        res.end(JSON.stringify({ error: 'Upload failed.' }));
      });
      return true;
    } catch (error) {
      setJsonHeaders(res, 500);
      res.end(JSON.stringify({ error: 'Unable to upload golden dataset.' }));
      return true;
    }
  }

  if (path === '/api/admin/golden-dataset/evaluations' && req.method === 'GET') {
    try {
      const evaluations = await listGoldenDatasetEvaluations();
      setJsonHeaders(res, 200);
      res.end(JSON.stringify({ evaluations }));
      return true;
    } catch (error) {
      setJsonHeaders(res, 500);
      res.end(JSON.stringify({ error: 'Unable to load golden dataset evaluations.' }));
      return true;
    }
  }

  if (path.startsWith('/api/admin/golden-dataset/') && req.method === 'GET') {
    const id = path.split('/').filter(Boolean).pop();
    // 'evaluations' is a named sub-route (handled in adminRoutes.js), not a
    // record id — without this exclusion it was being swallowed here as a
    // lookup for a record literally named "evaluations", which always 404s
    // and meant the Evaluation Results table could never load real data.
    if (id && id !== 'golden-dataset' && id !== 'evaluations') {
      try {
        const record = await getGoldenDatasetById(id);
        if (!record) {
          setJsonHeaders(res, 404);
          res.end(JSON.stringify({ error: 'Golden dataset item not found.' }));
          return true;
        }

        setJsonHeaders(res, 200);
        res.end(JSON.stringify(record));
        return true;
      } catch (error) {
        setJsonHeaders(res, 500);
        res.end(JSON.stringify({ error: 'Unable to load golden dataset item.' }));
        return true;
      }
    }
  }

  if (path === '/api/admin/golden-dataset' && req.method === 'DELETE') {
    try {
      const result = await clearGoldenDataset();
      setJsonHeaders(res, 200);
      res.end(JSON.stringify(result));
      return true;
    } catch (error) {
      setJsonHeaders(res, 500);
      res.end(JSON.stringify({ error: 'Unable to delete golden dataset.' }));
      return true;
    }
  }

  if (path === '/api/admin/golden-dataset/evaluate' && req.method === 'POST') {
    try {
      const questionCount = await db.collection('golden_dataset').countDocuments({});

      // Each question here runs a full answer generation plus a 5-metric
      // LLM-judge evaluation (the same one Online Eval uses) — realistically
      // a minute or more per question. Awaiting the whole batch in this
      // request used to hold the HTTP connection open for the entire run,
      // which reads as "stuck" (and risks hitting browser/proxy idle
      // timeouts long before it's actually done). Run it in the background
      // instead and let the dataset table pick up rows as they land.
      setImmediate(async () => {
        try {
          const result = await runGoldenDatasetEvaluation({ baseUrl: process.env.GOLDEN_DATASET_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`, db });
          console.log('[Golden Dataset] Evaluation run finished:', JSON.stringify({ status: result.status, count: result.count }));
        } catch (error) {
          console.error('[Golden Dataset] Evaluation run failed:', error);
        }
      });

      setJsonHeaders(res, 202);
      res.end(JSON.stringify({
        message: `Evaluation started for ${questionCount} question${questionCount === 1 ? '' : 's'}. This runs in the background — results will appear in the table below as each question finishes (roughly a minute or more per question).`,
        questionCount,
      }));
      return true;
    } catch (error) {
      setJsonHeaders(res, 500);
      res.end(JSON.stringify({ error: error.message || 'Unable to run evaluation.' }));
      return true;
    }

    if (req.method === 'POST') {
      try {
        const summary = await evaluatePreparedDataset();
        setJsonHeaders(res, 200);
        res.end(JSON.stringify(summary));
        return true;
      } catch (error) {
        setJsonHeaders(res, 500);
        res.end(JSON.stringify({ error: error.message || 'Golden dataset evaluation failed.' }));
        return true;
      }
    }
  }

  return false;
}

module.exports = {
  handleGoldenDatasetRoutes,
};
