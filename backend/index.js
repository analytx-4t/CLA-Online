require('dotenv').config();
const http = require('http');
const { randomUUID, randomBytes } = require('crypto');
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

function setJsonHeaders(res, statusCode) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-auth-user-id',
  });
}

function handleCors(req, res) {
  if (req.method === 'OPTIONS') {
    setJsonHeaders(res, 204);
    res.end();
    return true;
  }
  return false;
}

function generateSessionId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const chunks = Array.from({ length: 3 }, (_, index) => {
    const start = index * 4;
    return Array.from(bytes.slice(start, start + 4), (byte) => alphabet[byte % alphabet.length]).join('');
  });
  return `CLA-${chunks.join('-')}`;
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

async function ensureIndexes(db) {
  const sessionsCollection = db.collection('chat_sessions');
  const messagesCollection = db.collection('chat_messages');

  await Promise.all([
    sessionsCollection.createIndex({ session_id: 1, user_id: 1 }, { unique: true, name: 'uniq_session_user' }),
    sessionsCollection.createIndex({ user_id: 1, last_message_at: -1 }, { name: 'user_last_message' }),
    messagesCollection.createIndex({ message_id: 1 }, { unique: true, name: 'uniq_message_id' }),
    messagesCollection.createIndex({ session_id: 1, sequence_number: 1 }, { name: 'session_sequence' }),
  ]);
}

async function startServer() {
  try {
    const db = await connectDB();
    await ensureIndexes(db);

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

      if (handleCors(req, res)) {
        return;
      }

      if (path === '/health' && req.method === 'GET') {
        setJsonHeaders(res, 200);
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (path === '/api/llm/health' && req.method === 'GET') {
        setJsonHeaders(res, 200);
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
          setJsonHeaders(res, 200);
          res.end(JSON.stringify(response));
        } catch (error) {
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: error.message || 'LLM request failed.' }));
        }
        return;
      }

      if (path === '/api/chat/sessions' && req.method === 'POST') {
        try {
          const payload = await getRequestBody(req);
          const userId = getAuthenticatedUserId(req);
          const sessionsCollection = db.collection('chat_sessions');
          const sessionId = payload.session_id || generateSessionId();
          console.log(`[MongoDB] Creating session: ${sessionId}`);
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
          console.log('[MongoDB] Session saved');
          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ session: savedSession }));
        } catch (error) {
          console.error('Create session failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to create chat session.' }));
        }
        return;
      }

      if (path === '/api/chat/sessions' && req.method === 'GET') {
        try {
          const userId = getAuthenticatedUserId(req);
          const sessionsCollection = db.collection('chat_sessions');
          console.log(`[MongoDB] Loading sessions for user: ${userId}`);

          const sessions = await sessionsCollection
            .find({ user_id: userId })
            .sort({ last_message_at: -1, updated_at: -1 })
            .toArray();

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ sessions }));
        } catch (error) {
          console.error('Fetch sessions failed', error);

          setJsonHeaders(res, 500);
          res.end(JSON.stringify({
            error: 'Unable to fetch chat sessions.'
          }));
        }

        return;
      }

      const sessionMessagesMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)\/messages$/);
      if (sessionMessagesMatch && req.method === 'GET') {
        try {
          const sessionId = sessionMessagesMatch[1];
          const userId = getAuthenticatedUserId(req);
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');
          console.log(`[MongoDB] Loading messages for session: ${sessionId}`);

          const session = await findOwnedSession(sessionsCollection, sessionId, userId);
          if (!session) {
            setJsonHeaders(res, 404);
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          const messages = await messagesCollection
            .find({ session_id: session.session_id, user_id: userId })
            .sort({ sequence_number: 1, created_at: 1 })
            .toArray();

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ session_id: session.session_id, messages }));
        } catch (error) {
          console.error('Fetch messages failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to fetch session messages.' }));
        }

        return;
      }

      if (sessionMessagesMatch && req.method === 'POST') {
        try {
          const sessionId = sessionMessagesMatch[1];
          const payload = await getRequestBody(req);
          const userId = getAuthenticatedUserId(req);

          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const session = await findOwnedSession(sessionsCollection, sessionId, userId);
          if (!session) {
            setJsonHeaders(res, 404);
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          const now = new Date().toISOString();
          const userMsgDoc = {
            message_id: payload.message_id || randomUUID(),
            session_id: session.session_id,
            user_id: userId,
            role: 'user',
            content: payload.content || '',
            created_at: now,
            sequence_number: session.message_count + 1,
            metadata: payload.metadata || {}
          };
          await messagesCollection.insertOne(userMsgDoc);

          const previousMessages = await messagesCollection.find({ session_id: session.session_id })
            .sort({ sequence_number: 1, created_at: 1 })
            .toArray();

          const { runAgentFlow } = require('./agentSystem');
          const agentResult = await runAgentFlow(payload.content || '', { history: previousMessages });

          const assistantMsgDoc = {
            message_id: randomUUID(),
            session_id: session.session_id,
            user_id: userId,
            role: 'assistant',
            content: agentResult.content,
            created_at: new Date().toISOString(),
            sequence_number: session.message_count + 2,
            metadata: {
              route: agentResult.route,
              follow_up_questions: agentResult.follow_up_questions,
              sources: agentResult.sources || [],
              citations: agentResult.citations || [],
              model: agentResult.model || null
            }
          };
          await messagesCollection.insertOne(assistantMsgDoc);

          const sessionUpdate = {
            updated_at: new Date().toISOString(),
            last_message_at: new Date().toISOString(),
            message_count: session.message_count + 2
          };

          if (session.title === 'New chat' && payload.content) {
            sessionUpdate.title = payload.content.trim().slice(0, 50);
          }

          await sessionsCollection.updateOne(
            { _id: session._id, user_id: userId },
            { $set: sessionUpdate }
          );

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({
            userMessage: userMsgDoc,
            assistantMessage: assistantMsgDoc
          }));
        } catch (error) {
          console.error('Send message failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to process message.' }));
        }
        return;
      }

      const sessionDeleteMatch = path.match(/^\/api\/chat\/sessions\/([^/]+)$/);
      if (sessionDeleteMatch && req.method === 'DELETE') {
        const sessionId = sessionDeleteMatch[1];
        const userId = getAuthenticatedUserId(req);

        if (!userId) {
          setJsonHeaders(res, 401);
          res.end(JSON.stringify({ error: 'Authentication required.' }));
          return;
        }

        try {
          const sessionsCollection = db.collection('chat_sessions');
          const messagesCollection = db.collection('chat_messages');

          const ownedSession = await findOwnedSession(sessionsCollection, sessionId, userId);
          if (!ownedSession) {
            setJsonHeaders(res, 404);
            res.end(JSON.stringify({ error: 'Chat session not found.' }));
            return;
          }

          await messagesCollection.deleteMany({ session_id: ownedSession.session_id, user_id: userId });
          await sessionsCollection.deleteOne({ _id: ownedSession._id, user_id: userId });

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ success: true, session_id: sessionId }));
        } catch (error) {
          console.error('Delete session failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to delete chat session.' }));
        }
        return;
      }

      setJsonHeaders(res, 404);
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