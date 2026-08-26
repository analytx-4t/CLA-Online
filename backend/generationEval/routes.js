const {
  evaluateGeneration,
  listGenerationEvaluations,
  deleteGenerationEvaluation,
  clearAllGenerationEvaluations
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

async function handleGenerationEvalRoutes(req, res, db) {
  const urlObj = new URL(req.url, 'http://localhost');
  const path = urlObj.pathname;

  if (req.method === 'OPTIONS' && path.startsWith('/api/admin/eval/generation')) {
    setJsonHeaders(res, 204);
    res.end();
    return true;
  }

  // POST /api/admin/eval/generation (Run & Save new evaluation)
  if (path === '/api/admin/eval/generation' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const record = await evaluateGeneration({
        question: body.question,
        expectedAnswer: body.expectedAnswer,
        generatedAnswer: body.generatedAnswer,
        db
      });
      sendJson(res, 200, { success: true, data: record });
    } catch (error) {
      console.error('[GenerationEval Route Error]', error);
      sendJson(res, 400, { success: false, error: error.message || 'Unable to evaluate generation.' });
    }
    return true;
  }

  // GET /api/admin/eval/generation (Fetch history list)
  if (path === '/api/admin/eval/generation' && req.method === 'GET') {
    try {
      const search = urlObj.searchParams.get('search') || '';
      const items = await listGenerationEvaluations(db, { search });
      sendJson(res, 200, { success: true, data: items, count: items.length });
    } catch (error) {
      sendJson(res, 500, { success: false, error: 'Unable to list generation evaluations.' });
    }
    return true;
  }

  // DELETE /api/admin/eval/generation/clear (Clear all history)
  if (path === '/api/admin/eval/generation/clear' && req.method === 'DELETE') {
    try {
      await clearAllGenerationEvaluations(db);
      sendJson(res, 200, { success: true, message: 'All generation evaluations cleared.' });
    } catch (error) {
      sendJson(res, 500, { success: false, error: 'Unable to clear generation evaluations.' });
    }
    return true;
  }

  // DELETE /api/admin/eval/generation/:id (Delete single record)
  if (path.startsWith('/api/admin/eval/generation/') && req.method === 'DELETE') {
    try {
      const id = path.split('/').pop();
      const deleted = await deleteGenerationEvaluation(db, id);
      if (deleted) {
        sendJson(res, 200, { success: true, message: 'Generation evaluation deleted.' });
      } else {
        sendJson(res, 404, { success: false, error: 'Evaluation record not found.' });
      }
    } catch (error) {
      sendJson(res, 500, { success: false, error: 'Unable to delete generation evaluation.' });
    }
    return true;
  }

  return false;
}

module.exports = { handleGenerationEvalRoutes };
