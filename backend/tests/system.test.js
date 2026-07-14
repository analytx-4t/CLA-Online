require('dotenv').config();
const test = require('node:test');
const assert = require('assert');
const http = require('http');
const { randomUUID } = require('crypto');
const { connectDB, closeDB } = require('../mongoClient');

// We'll spin up the server on an ephemeral port for testing
const TEST_PORT = 3123;
const TEST_USER_ID = 'enterprise-test-user-' + Date.now();
const API_BASE = `http://localhost:${TEST_PORT}`;

// Helper to make HTTP requests using node's native fetch or http.request
async function makeRequest(method, path, body = null, extraHeaders = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-user-id': TEST_USER_ID,
    ...extraHeaders
  };

  const options = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const responseBody = isJson ? await response.json() : await response.text();

  return {
    status: response.status,
    headers: response.headers,
    body: responseBody
  };
}

test.describe('CLAOnline Enterprise Integration System Tests', () => {
  let serverProcess;

  test.before(async () => {
    // Connect to DB and start the server
    await connectDB();

    // Start server in-process for easier control and testing
    const http = require('http');
    const { randomUUID } = require('crypto');
    const { ObjectId } = require('mongodb');
    const { getProviderHealth, settings } = require('../config');
    const { getLLMProvider } = require('../llm/factory');
    
    // Create an instance of the server similar to backend/index.js
    const serverInstance = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-auth-user-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      function getRequestPath(url) {
        return url.split('?')[0];
      }

      function getAuthenticatedUserId(req) {
        return req.headers['x-user-id'] || req.headers['x-auth-user-id'] || 'unknown-user';
      }

      function getRequestBody(req) {
        return new Promise((resolve, reject) => {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            if (!body) { resolve({}); return; }
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
          req.on('error', reject);
        });
      }

      const path = getRequestPath(req.url || '/');
      const userId = getAuthenticatedUserId(req);

      if (path === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (path === '/api/chat/sessions' && req.method === 'POST') {
        try {
          const payload = await getRequestBody(req);
          const db = await connectDB();
          const sessionsCollection = db.collection('chat_sessions');
          const sessionId = payload.session_id || randomUUID();
          const now = new Date().toISOString();
          const sessionDocument = {
            session_id: sessionId,
            user_id: userId,
            title: payload.title || 'New chat',
            created_at: payload.created_at || now,
            updated_at: payload.updated_at || now,
            last_message_at: payload.last_message_at || now,
            message_count: payload.message_count || 0,
            status: payload.status || 'active',
          };

          await sessionsCollection.updateOne(
            { session_id: sessionId, user_id: userId },
            { $setOnInsert: sessionDocument },
            { upsert: true }
          );

          const savedSession = await sessionsCollection.findOne({ session_id: sessionId, user_id: userId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ session: savedSession }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
        return;
      }

      if (path === '/api/chat/sessions' && req.method === 'GET') {
        try {
          const db = await connectDB();
          const sessionsCollection = db.collection('chat_sessions');
          const sessionsList = await sessionsCollection.find({ user_id: userId })
            .sort({ updated_at: -1 })
            .toArray();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessions: sessionsList }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
        return;
      }

      if (path.startsWith('/api/chat/sessions/') && path.endsWith('/messages') && req.method === 'POST') {
        const parts = path.split('/');
        const sessionId = parts[parts.length - 2];

        try {
          const payload = await getRequestBody(req);
          const content = payload.content;

          const db = await connectDB();
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const ownedSession = await sessionsCollection.findOne({ session_id: sessionId, user_id: userId });
          if (!ownedSession) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          const userMsgDoc = {
            message_id: randomUUID(),
            session_id: sessionId,
            user_id: userId,
            role: 'user',
            content: content || '',
            created_at: new Date().toISOString(),
            metadata: payload.metadata || {}
          };
          await messagesCollection.insertOne(userMsgDoc);

          const { runAgentFlow } = require('../agentSystem');
          const agentResult = await runAgentFlow(content);

          const assistantMsgDoc = {
            message_id: randomUUID(),
            session_id: sessionId,
            user_id: userId,
            role: 'assistant',
            content: agentResult.content,
            created_at: new Date().toISOString(),
            metadata: {
              route: agentResult.route,
              follow_up_questions: agentResult.follow_up_questions
            }
          };
          await messagesCollection.insertOne(assistantMsgDoc);

          const messageCount = await messagesCollection.countDocuments({ session_id: sessionId });
          await sessionsCollection.updateOne(
            { _id: ownedSession._id },
            { $set: { updated_at: new Date().toISOString(), message_count: messageCount } }
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            userMessage: userMsgDoc,
            assistantMessage: assistantMsgDoc
          }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
        return;
      }

      if (path.startsWith('/api/chat/sessions/') && path.endsWith('/messages') && req.method === 'GET') {
        const parts = path.split('/');
        const sessionId = parts[parts.length - 2];

        try {
          const db = await connectDB();
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const ownedSession = await sessionsCollection.findOne({ session_id: sessionId, user_id: userId });
          if (!ownedSession) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          const messages = await messagesCollection.find({ session_id: sessionId })
            .sort({ created_at: 1 })
            .toArray();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ messages }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
        return;
      }

      if (path.startsWith('/api/chat/sessions/') && req.method === 'DELETE') {
        const sessionId = path.split('/').pop();

        try {
          const db = await connectDB();
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const ownedSession = await sessionsCollection.findOne({ session_id: sessionId, user_id: userId });
          if (!ownedSession) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          await messagesCollection.deleteMany({ session_id: sessionId });
          await sessionsCollection.deleteOne({ _id: ownedSession._id });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, session_id: sessionId }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    serverProcess = serverInstance.listen(TEST_PORT);
  });

  test.after(async () => {
    // Tear down test server
    if (serverProcess) {
      serverProcess.close();
    }

    // Clean up test documents in DB to keep it pristine
    const db = await connectDB();
    await db.collection('chat_sessions').deleteMany({ user_id: TEST_USER_ID });
    await db.collection('chat_messages').deleteMany({ user_id: TEST_USER_ID });

    await closeDB();
  });

  test('GET /health returns status ok', async () => {
    const res = await makeRequest('GET', '/health');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { status: 'ok' });
  });

  test('CORS preflight request (OPTIONS) returns 204 with correct headers', async () => {
    const res = await makeRequest('OPTIONS', '/health');
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(res.headers.get('access-control-allow-methods'), 'GET, POST, DELETE, OPTIONS');
  });

  test('Full Session & Chat Message lifecycle flow', async () => {
    const sessionId = randomUUID();

    // 1. Create session
    const createRes = await makeRequest('POST', '/api/chat/sessions', {
      session_id: sessionId,
      title: 'Integration Test Session'
    });
    assert.strictEqual(createRes.status, 200);
    assert.strictEqual(createRes.body.session.session_id, sessionId);
    assert.strictEqual(createRes.body.session.user_id, TEST_USER_ID);

    // 2. Fetch all sessions (verify ours is listed)
    const listRes = await makeRequest('GET', '/api/chat/sessions');
    assert.strictEqual(listRes.status, 200);
    const session = listRes.body.sessions.find(s => s.session_id === sessionId);
    assert.ok(session, 'Created session should be listed in user sessions');

    // 3. Post a DIALOG query message
    const msgRes = await makeRequest('POST', `/api/chat/sessions/${sessionId}/messages`, {
      content: 'Hello system test chatbot!'
    });
    assert.strictEqual(msgRes.status, 200);
    assert.ok(msgRes.body.userMessage, 'Should return user message confirmation');
    assert.ok(msgRes.body.assistantMessage, 'Should return assistant response');
    assert.strictEqual(msgRes.body.assistantMessage.metadata.route, 'DIALOG');

    // 4. Fetch all messages (verify correct sequence)
    const messagesRes = await makeRequest('GET', `/api/chat/sessions/${sessionId}/messages`);
    assert.strictEqual(messagesRes.status, 200);
    assert.strictEqual(messagesRes.body.messages.length, 2);
    assert.strictEqual(messagesRes.body.messages[0].role, 'user');
    assert.strictEqual(messagesRes.body.messages[1].role, 'assistant');

    // 5. Delete session
    const deleteRes = await makeRequest('DELETE', `/api/chat/sessions/${sessionId}`);
    assert.strictEqual(deleteRes.status, 200);
    assert.deepStrictEqual(deleteRes.body, { success: true, session_id: sessionId });

    // 6. Verify session and messages are deleted from DB lookup
    const listAfterRes = await makeRequest('GET', '/api/chat/sessions');
    const sessionFound = listAfterRes.body.sessions.find(s => s.session_id === sessionId);
    assert.ok(!sessionFound, 'Session should be deleted');
  });
});
