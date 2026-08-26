const {
  evaluateRetrieval,
  listRetrievalEvaluations,
  deleteRetrievalEvaluation,
  clearAllRetrievalEvaluations
} = require('./service');

function setJsonHeaders(res, statusCode) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-auth-user-id',
  });
}

function sendJson(res, statusCode, payload) {
  setJsonHeaders(res, statusCode);
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (err) { reject(err); }
    });
    req.on('error', (err) => reject(err));
  });
}

async function handleRetrievalEvalRoutes(req, res, db) {
  const urlObj = new URL(req.url, 'http://localhost');
  const path = urlObj.pathname;

  if (req.method === 'OPTIONS' && path.startsWith('/api/admin/eval/retrieval')) {
    setJsonHeaders(res, 204);
    res.end();
    return true;
  }

  // POST /api/admin/eval/retrieval (Run & Save new evaluation)
  if (path === '/api/admin/eval/retrieval' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const record = await evaluateRetrieval({
        question: body.question,
        expectedAnswer: body.expectedAnswer,
        generatedAnswer: body.generatedAnswer,
        db
      });
      sendJson(res, 200, { success: true, data: record });
    } catch (error) {
      console.error('[RetrievalEval Route Error]', error);
      sendJson(res, 400, { success: false, error: error.message || 'Unable to evaluate retrieval.' });
    }
    return true;
  }

  // GET /api/admin/eval/retrieval (Fetch history list)
  if (path === '/api/admin/eval/retrieval' && req.method === 'GET') {
    try {
      const search = urlObj.searchParams.get('search') || '';
      const items = await listRetrievalEvaluations(db, { search });
      sendJson(res, 200, { success: true, data: items, count: items.length });
    } catch (error) {
      sendJson(res, 500, { success: false, error: 'Unable to list retrieval evaluations.' });
    }
    return true;
  }

  // DELETE /api/admin/eval/retrieval/clear (Clear all history)
  if (path === '/api/admin/eval/retrieval/clear' && req.method === 'DELETE') {
    try {
      await clearAllRetrievalEvaluations(db);
      sendJson(res, 200, { success: true, message: 'All retrieval evaluations cleared.' });
    } catch (error) {
      sendJson(res, 500, { success: false, error: 'Unable to clear retrieval evaluations.' });
    }
    return true;
  }

  // DELETE /api/admin/eval/retrieval/:id (Delete single record)
  if (path.startsWith('/api/admin/eval/retrieval/') && req.method === 'DELETE') {
    try {
      const id = path.split('/').pop();
      const deleted = await deleteRetrievalEvaluation(db, id);
      if (deleted) {
        sendJson(res, 200, { success: true, message: 'Retrieval evaluation deleted.' });
      } else {
        sendJson(res, 404, { success: false, error: 'Evaluation record not found.' });
      }
    } catch (error) {
      sendJson(res, 500, { success: false, error: 'Unable to delete retrieval evaluation.' });
    }
    return true;
  }

  return false;
}

module.exports = { handleRetrievalEvalRoutes };
