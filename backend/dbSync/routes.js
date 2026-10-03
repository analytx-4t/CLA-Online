const { startSync, getStatus } = require('./service');

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

async function handleDbSyncRoutes(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const path = urlObj.pathname;

  // GET /api/admin/db-sync/status (schedule, live progress, last run, history)
  if (path === '/api/admin/db-sync/status' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, data: getStatus() });
    } catch (error) {
      console.error('[DB Sync Route Error]', error);
      sendJson(res, 500, { success: false, error: 'Unable to load database refresh status.' });
    }
    return true;
  }

  // POST /api/admin/db-sync/run (start a refresh now)
  if (path === '/api/admin/db-sync/run' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const result = startSync({ trigger: 'manual', reverify: Boolean(body.reverify) });
      if (result.started) {
        sendJson(res, 202, { success: true, runId: result.runId, message: 'Database refresh started.' });
      } else if (result.reason === 'already_running') {
        sendJson(res, 409, { success: false, error: 'A database refresh is already running.' });
      } else {
        sendJson(res, 500, { success: false, error: result.message || 'Unable to start the database refresh.' });
      }
    } catch (error) {
      console.error('[DB Sync Route Error]', error);
      sendJson(res, 400, { success: false, error: error.message || 'Unable to start the database refresh.' });
    }
    return true;
  }

  return false;
}

module.exports = { handleDbSyncRoutes };
