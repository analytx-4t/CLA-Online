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

async function handleGoldenDatasetRoutes(req, res, db) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const path = requestUrl.pathname || '/';

  if (path === '/api/admin/golden-dataset' && req.method === 'GET') {
    try {
      const records = await listGoldenDataset(db);
      const state = await getDatasetState(db);
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
        totalUploadsCount: state?.totalUploadsCount ?? 0,
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

            const result = await uploadDataset(body, db);
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

          const result = await uploadDataset(body, db);
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
      const evaluations = await listGoldenDatasetEvaluations(db);
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
      const result = await clearGoldenDataset(db);
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
      const state = await getDatasetState(db);
      const questionCount = state.totalCount ?? state.recordCount ?? 0;

      setImmediate(async () => {
        try {
          const result = await evaluatePreparedDataset({ db });
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
  }

  return false;
}

module.exports = {
  handleGoldenDatasetRoutes,
};
