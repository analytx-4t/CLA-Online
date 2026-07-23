const busboy = require('busboy');
const { runGoldenDatasetEvaluation } = require('./evalRunner');
const { uploadDataset, listGoldenDataset, getGoldenDatasetById, clearGoldenDataset } = require('./service');

function setJsonHeaders(res, statusCode) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-auth-user-id',
  });
}

async function handleGoldenDatasetRoutes(req, res, db) {
  const path = req.url.split('?')[0] || '/';

  if (path === '/api/admin/golden-dataset' && req.method === 'GET') {
    try {
      const records = await listGoldenDataset();
      const stateCollection = db.collection('golden_dataset_state');
      const state = await stateCollection.findOne({ _id: 'current' });
      setJsonHeaders(res, 200);
      res.end(JSON.stringify({ records, version: state?.version || null, uploadedAt: state?.uploadedAt || null }));
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

            setImmediate(async () => {
              try {
                await runGoldenDatasetEvaluation({ baseUrl: process.env.GOLDEN_DATASET_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`, db });
              } catch (error) {
                console.error('[Golden Dataset] Automatic evaluation failed:', error);
              }
            });
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

          setImmediate(async () => {
            try {
              await runGoldenDatasetEvaluation({ baseUrl: process.env.GOLDEN_DATASET_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`, db });
            } catch (error) {
              console.error('[Golden Dataset] Automatic evaluation failed:', error);
            }
          });
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
  }

  return false;
}

module.exports = {
  handleGoldenDatasetRoutes,
};
