require('dotenv').config();
const http = require('http');
const { randomUUID } = require('crypto');
const { ObjectId } = require('mongodb');
const { connectDB, closeDB } = require('./mongoClient');
const { getProviderHealth, settings } = require('./config');
const { getLLMProvider } = require('./llm/factory');

const PORT = process.env.PORT || 3000;

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
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function getSessionLookupFilter(sessionId, userId) {
  return { session_id: sessionId, user_id: userId };
}

async function findOwnedSession(sessionsCollection, sessionId, userId) {
  const filter = getSessionLookupFilter(sessionId, userId);
  let session = await sessionsCollection.findOne(filter);
  if (session) {
    return session;
  }

  if (sessionId && /^[a-fA-F0-9]{24}$/.test(sessionId)) {
    try {
      const objectId = new ObjectId(sessionId);
      session = await sessionsCollection.findOne({ _id: objectId, user_id: userId });
    } catch (error) {
      return null;
    }
  }

  return session;
}

async function startServer() {
  try {
    await connectDB();

    const server = http.createServer(async (req, res) => {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-auth-user-id');

      // Handle preflight OPTIONS request
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const path = getRequestPath(req.url || '/');

      if (path === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (path === '/api/llm/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getProviderHealth()));
        return;
      }

      if (path === '/api/llm/generate' && req.method === 'POST') {
        try {
          const payload = await getRequestBody(req);
          const provider = payload.provider || settings.DEFAULT_LLM_PROVIDER;
          const llm = getLLMProvider(provider, payload.model);
          const response = await llm.generate({
            systemPrompt: payload.systemPrompt || '',
            messages: payload.messages || [],
            temperature: payload.temperature,
            maxTokens: payload.maxTokens,
            modelOverride: payload.modelOverride,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message || 'LLM request failed.' }));
        }
        return;
      }

      if (path === '/api/chat/sessions' && req.method === 'POST') {
        try {
          const payload = await getRequestBody(req);
          const userId = getAuthenticatedUserId(req);
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
          console.error('Create session failed', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unable to create chat session.' }));
        }
        return;
      }

      if (path.startsWith('/api/chat/sessions/') && req.method === 'DELETE') {
        const sessionId = path.split('/').pop();
        const userId = getAuthenticatedUserId(req);

        if (!userId) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Authentication required.' }));
          return;
        }

        try {
          const db = await connectDB();
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const ownedSession = await findOwnedSession(sessionsCollection, sessionId, userId);
          if (!ownedSession) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          await messagesCollection.deleteMany({
            $or: [
              { session_id: sessionId },
              { sessionId },
              { chat_session_id: sessionId },
              { session_id: ownedSession.session_id },
              { sessionId: ownedSession.session_id },
              { chat_session_id: ownedSession.session_id },
            ],
          });
          await sessionsCollection.deleteOne({ _id: ownedSession._id });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, session_id: sessionId }));
        } catch (error) {
          console.error('Delete session failed', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unable to delete chat session.' }));
        }
        return;
      }

      // GET /api/chat/sessions
      if (path === '/api/chat/sessions' && req.method === 'GET') {
        try {
          const userId = getAuthenticatedUserId(req);
          const db = await connectDB();
          const sessionsCollection = db.collection('chat_sessions');
          const sessionsList = await sessionsCollection.find({ user_id: userId })
            .sort({ updated_at: -1 })
            .toArray();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sessions: sessionsList }));
        } catch (error) {
          console.error('List sessions failed', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unable to retrieve chat sessions.' }));
        }
        return;
      }

      // POST /api/chat/sessions/:sessionId/messages
      if (path.startsWith('/api/chat/sessions/') && path.endsWith('/messages') && req.method === 'POST') {
        const parts = path.split('/');
        const sessionId = parts[parts.length - 2];
        const userId = getAuthenticatedUserId(req);

        try {
          const payload = await getRequestBody(req);
          const content = payload.content;

          const db = await connectDB();
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const ownedSession = await findOwnedSession(sessionsCollection, sessionId, userId);
          if (!ownedSession) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          const now = new Date().toISOString();
          const userMsgDoc = {
            message_id: randomUUID(),
            session_id: sessionId,
            user_id: userId,
            role: 'user',
            content: content || '',
            created_at: now,
            metadata: payload.metadata || {}
          };
          await messagesCollection.insertOne(userMsgDoc);

          const previousMessages = await messagesCollection.find({ session_id: sessionId })
            .sort({ created_at: 1 })
            .toArray();

          const { runAgentFlow } = require('./agentSystem');
          const agentResult = await runAgentFlow(content, { history: previousMessages });

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
            {
              $set: {
                updated_at: new Date().toISOString(),
                message_count: messageCount
              }
            }
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            userMessage: userMsgDoc,
            assistantMessage: assistantMsgDoc
          }));
        } catch (error) {
          console.error('Send message failed', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unable to process message.' }));
        }
        return;
      }

      // GET /api/chat/sessions/:sessionId/messages
      if (path.startsWith('/api/chat/sessions/') && path.endsWith('/messages') && req.method === 'GET') {
        const parts = path.split('/');
        const sessionId = parts[parts.length - 2];
        const userId = getAuthenticatedUserId(req);

        try {
          const db = await connectDB();
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const ownedSession = await findOwnedSession(sessionsCollection, sessionId, userId);
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
          console.error('Fetch messages failed', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unable to fetch chat messages.' }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    const shutdown = async () => {
      console.log('Shutting down server...');
      server.close(async () => {
        await closeDB();
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

startServer();
