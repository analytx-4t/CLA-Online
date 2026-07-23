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
    if (id && id !== 'golden-dataset' && id !== 'evaluations' && id !== 'evaluate') {
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

  if (path === '/api/admin/golden-dataset/evaluate' && (req.method === 'POST' || (stream && req.method === 'GET'))) {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('retry: 10000\n\n');

      try {
        const evaluationSessionId = requestUrl.searchParams.get('evaluationSessionId') || null;
        const summary = await evaluatePreparedDataset({
          evaluationSessionId,
          onProgress: (payload) => writeSseEvent(res, 'row', payload),
        });

        writeSseEvent(res, 'completion', summary);
        res.end();
      } catch (error) {
        writeSseEvent(res, 'completion', {
          status: 'failed',
          total: 0,
          success: 0,
          failed: 0,
          error: error.message || 'Golden dataset evaluation failed.',
        });
        res.end();
      }
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
