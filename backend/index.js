

require('dotenv').config();
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID, randomBytes } = require('crypto');
const { ObjectId } = require('mongodb');
const { connectDB, closeDB } = require('./mongoClient');
const { getProviderHealth, settings } = require('./config');
const { getLLMProvider } = require('./llm/factory');
const { traceLLMGeneration } = require('./langsmith');

let logfire;

async function getLogfire() {
  if (!logfire) {
    logfire = await import('@pydantic/logfire-node');
  }

  return logfire;
}

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

function runPythonSearch(query, topK = 5, hybrid = true, sourceFilter = null) {
  return new Promise((resolve, reject) => {
    let pythonPath = path.resolve(__dirname, '../embedding/venv/Scripts/python.exe');
    if (!require('fs').existsSync(pythonPath)) {
      pythonPath = path.resolve(__dirname, '../embedding/venv/bin/python');
    }

    const scriptPath = path.resolve(__dirname, '../embedding/search_documents.py');
    if (!require('fs').existsSync(scriptPath)) {
      return reject(new Error(`search_documents.py not found at ${scriptPath}`));
    }

    const child = spawn(pythonPath, [scriptPath, '--json']);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Python process exited with code ${code}. Stderr: ${stderr}`));
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) {
          return reject(new Error(result.error));
        }
        resolve(result.results || []);
      } catch (err) {
        reject(new Error(`Failed to parse Python output: ${err.message}. Raw output: ${stdout}`));
      }
    });

    const inputPayload = JSON.stringify({
      query: query,
      top_k: topK,
      hybrid: hybrid,
      source_filter: sourceFilter
    });

    child.stdin.write(inputPayload);
    child.stdin.end();
  });
}
function runRagasEvaluation(question, answer, contexts) {
  return new Promise((resolve) => {
    const evaluationScript = path.join(
      __dirname,
      '..',
      'evaluation',
      'live_evaluator.py'
    );

    const evaluationPython = path.join(
      __dirname,
      '..',
      'evaluation',
      '.venv',
      'Scripts',
      'python.exe'
    );

    const pythonProcess = spawn(evaluationPython, [evaluationScript], {
      cwd: path.join(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('error', (error) => {
      console.error('[RAGAS] Failed to start evaluator:', error);

      resolve({
        status: 'failed',
        error: error.message,
      });
    });

    pythonProcess.on('close', (code) => {
      if (stderr.trim()) {
        console.error('[RAGAS stderr]', stderr.trim());
      }

      try {
        const result = JSON.parse(stdout.trim());

        if (code !== 0) {
          console.error('[RAGAS] Evaluator exited with code:', code);
        }

        resolve(result);
      } catch (error) {
        console.error(
          '[RAGAS] Failed to parse evaluator output:',
          stdout
        );

        resolve({
          status: 'failed',
          error: 'Failed to parse RAGAS evaluation output.',
        });
      }
    });

    const payload = {
      question,
      answer,
      contexts,
    };

    pythonProcess.stdin.write(JSON.stringify(payload));
    pythonProcess.stdin.end();
  });
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
        const lf = await getLogfire();

        try {
          const payload = await getRequestBody(req);
          const provider = payload.provider || settings.DEFAULT_LLM_PROVIDER;
          const model = payload.model || 'default';

          const response = await lf.span(
            'LLM generation request',
            {
              provider,
              model,
              message_count: payload.messages?.length || 0,
            },
            {},
            async () => {
              const llm = getLLMProvider(provider, payload.model);

              return traceLLMGeneration({
                provider,
                model: payload.model || llm.defaultModel || 'default',
                messageCount: payload.messages?.length || 0,

                generate: async () => {
                  return llm.generate({
                    systemPrompt: payload.systemPrompt || '',
                    messages: payload.messages || [],
                    temperature: payload.temperature,
                    maxTokens: payload.maxTokens,
                    modelOverride: payload.modelOverride,
                  });
                },
              });
            }
          );

          lf.info('LLM generation completed', {
            provider,
            model,
          });

          setJsonHeaders(res, 200);
          res.end(JSON.stringify(response));
        } catch (error) {
          lf.reportError(
            'LLM generation failed',
            error
          );

          setJsonHeaders(res, 500);
          res.end(JSON.stringify({
            error: error.message || 'LLM request failed.'
          }));
        }

        return;
      }

      if (path === '/api/ask' && req.method === 'POST') {
        try {
          const payload = await getRequestBody(req);
          const question = payload.question;

          if (!question || typeof question !== 'string' || !question.trim()) {
            setJsonHeaders(res, 400);
            res.end(JSON.stringify({ error: 'Question parameter is required and cannot be empty.' }));
            return;
          }

          console.log(`[RAG Endpoint] Received question: "${question.trim()}"`);

          let results;
          try {
            results = await runPythonSearch(question, 5, true);
          } catch (searchErr) {
            console.error('[RAG Endpoint] Search execution failed:', searchErr);
            setJsonHeaders(res, 500);
            res.end(JSON.stringify({ error: 'Failed to search legal documents database.' }));
            return;
          }

          if (!results || results.length === 0) {
            console.log('[RAG Endpoint] No documents matched the query.');
            setJsonHeaders(res, 200);
            res.end(JSON.stringify({
              answer: 'I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question.',
              sources: []
            }));
            return;
          }

          console.log(`[RAG Endpoint] Found ${results.length} matching document chunks. Generating answer...`);

          // Format search context
          const contextBlock = results.map((r, idx) => {
            const sourceIndex = idx + 1;
            const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
            const fileName = (r.original && r.original.child && r.original.child.FileName) ||
              (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
            const category = r.category || 'Unknown';
            const subject = r.subject || 'Unknown';
            const sections = r.sections || 'Unknown';

            return `[Source ${sourceIndex}] Title: "${title}" | File: ${fileName} | Sections: ${sections} | Category: ${category} | Subject: ${subject}\nContent: ${r.chunk_text}`;
          }).join('\n\n---\n\n');

          // Build Grounded LLM Prompt
          const systemPrompt = `You are a professional legal research assistant for Indian corporate and commercial law.
You must answer the user's question grounding your answer strictly and ONLY in the provided search context.
Do NOT use any external or general knowledge. If the provided context does not contain enough information to answer the question, state: "I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question."

Citing Sources:
For every fact or statement you make, you must cite which source(s) it came from.
Use the exact citation format: [Title (FileName)], where:
- Title is the DocTitle/Title of the document (e.g., THE NITTY-GRITTY OF COMPANY LAW...)
- FileName is the FileName of the source file (e.g., CompanyLaw_A.pdf or similar)
These details are specified at the start of each source section in the context as: Title: "..." | File: ...

Example citation: ...managing directors must be in the employment of the company [THE NITTY-GRITTY OF COMPANY LAW (CompanyLaw_Article.pdf)].

Keep your answer clear, precise, and professional.`;

          const provider = settings.DEFAULT_LLM_PROVIDER;
          const model = settings.DEFAULT_LLM_MODEL;
          const llm = getLLMProvider(provider, model);

          let llmResponse;
          try {
            llmResponse = await llm.generate({
              systemPrompt: systemPrompt,
              messages: [{ role: 'user', content: `Question: ${question}\n\nSearch Context:\n${contextBlock}` }],
              temperature: 0.1,
            });
          } catch (llmErr) {
            console.error('[RAG Endpoint] LLM generation failed:', llmErr);
            setJsonHeaders(res, 500);
            res.end(JSON.stringify({ error: 'LLM generation failed.' }));
            return;
          }

          console.log(
            '[RAG Endpoint] Raw LLM response:',
            JSON.stringify(llmResponse, null, 2)
          );

          const answerText =
            llmResponse?.content ||
            llmResponse?.text ||
            llmResponse?.response ||
            llmResponse?.message?.content ||
            llmResponse?.choices?.[0]?.message?.content ||
            '';

          console.log(
            '[RAG Endpoint] Extracted answer length:',
            answerText.length
          );

          if (!answerText.trim()) {
            console.error(
              '[RAG Endpoint] LLM returned an empty answer. RAGAS evaluation skipped.'
            );

            setJsonHeaders(res, 502);
            res.end(JSON.stringify({
              error: 'The LLM provider returned an empty answer.',
              provider: llmResponse?.provider || settings.DEFAULT_LLM_PROVIDER,
              model: llmResponse?.model || settings.DEFAULT_LLM_MODEL
            }));

            return;
          }

          console.log('[RAG Endpoint] Answer generated successfully.');

          // Parse and extract the unique sources actually cited in the generated answer
          const uniqueSources = [];
          const seenSources = new Set();

          for (const r of results) {
            const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
            const fileName = (r.original && r.original.child && r.original.child.FileName) ||
              (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';

            const sourceKey = `${title}:::${fileName}`;
            if (seenSources.has(sourceKey)) continue;

            const isCited = answerText.toLowerCase().includes(title.toLowerCase().slice(0, 30)) ||
              answerText.toLowerCase().includes(fileName.toLowerCase());

            if (isCited) {
              seenSources.add(sourceKey);
              uniqueSources.push({
                title,
                filename: fileName,
                author: (r.original && r.original.parent && r.original.parent.Author) || null,
                sections: r.sections || (r.original && r.original.parent && r.original.parent.Sections) || null,
                category: r.category || (r.original && r.original.parent && r.original.parent.Category) || null,
                subject: r.subject || (r.original && r.original.parent && r.original.parent.Subject) || null,
                doc_date: r.doc_date || (r.original && r.original.parent && r.original.parent.DocDate) || null,
                vol: (r.original && r.original.parent && r.original.parent.Vol) || null,
                issue_month: (r.original && r.original.parent && r.original.parent.IssueMonth) || null,
                issue_year: (r.original && r.original.parent && r.original.parent.IssueYear) || null
              });
            }
          }

          // Fallback to top result's source if no explicit citation found in answer (and answer isn't no-match)
          if (uniqueSources.length === 0 && results.length > 0 &&
            !answerText.toLowerCase().includes("nothing relevant found") &&
            !answerText.toLowerCase().includes("could not find authority")) {
            const r = results[0];
            const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
            const fileName = (r.original && r.original.child && r.original.child.FileName) ||
              (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
            uniqueSources.push({
              title,
              filename: fileName,
              author: (r.original && r.original.parent && r.original.parent.Author) || null,
              sections: r.sections || (r.original && r.original.parent && r.original.parent.Sections) || null,
              category: r.category || (r.original && r.original.parent && r.original.parent.Category) || null,
              subject: r.subject || (r.original && r.original.parent && r.original.parent.Subject) || null,
              doc_date: r.doc_date || (r.original && r.original.parent && r.original.parent.DocDate) || null,
              vol: (r.original && r.original.parent && r.original.parent.Vol) || null,
              issue_month: (r.original && r.original.parent && r.original.parent.IssueMonth) || null,
              issue_year: (r.original && r.original.parent && r.original.parent.IssueYear) || null
            });
          }

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({
            answer: answerText,
            sources: uniqueSources,
            searchResults: results.map(r => ({
              embedding_id: r.embedding_id,
              source_table: r.source_table,
              record_id: r.record_id,
              parent_id: r.parent_id,
              chunk_text: r.chunk_text,
              category: r.category,
              subject: r.subject,
              sections: r.sections,
              doc_title: r.doc_title,
              law_title: r.law_title,
              doc_date: r.doc_date,
              score: r.score || r.rrf_score
            })),
            evaluation: evaluation
          }));
        } catch (err) {
          console.error('[RAG Endpoint] Request handler failed:', err);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Internal server error.' }));
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

