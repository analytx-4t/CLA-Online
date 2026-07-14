require('dotenv').config();
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
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

function runPythonCitation(sourceTable, recordId, parentId = null) {
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
        resolve(result);
      } catch (err) {
        reject(new Error(`Failed to parse Python output: ${err.message}. Raw output: ${stdout}`));
      }
    });

    const inputPayload = JSON.stringify({
      action: "get_citation",
      source_table: sourceTable,
      record_id: parseInt(recordId, 10) || recordId,
      parent_id: parentId ? (parseInt(parentId, 10) || parentId) : null
    });
    
    child.stdin.write(inputPayload);
    child.stdin.end();
  });
}

function escapeHTML(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderCitationHTML(data) {
  const title = escapeHTML(data.title || 'Untitled Document');
  const sourceTable = escapeHTML(data.source_table || '');
  const recordId = escapeHTML(data.record_id || '');
  
  const child = data.child || {};
  const parent = data.parent || {};
  
  const fileName = escapeHTML(child.FileName || parent.FileName || 'Unknown');
  const category = escapeHTML(child.Category || parent.Category || 'Unknown');
  const subject = escapeHTML(child.Subject || parent.Subject || 'Unknown');
  const sections = escapeHTML(child.Sections || parent.Sections || 'Unknown');
  const author = escapeHTML(parent.Author || 'Unknown');
  const issueYear = escapeHTML(parent.IssueYear || '');
  const issueMonth = escapeHTML(parent.IssueMonth || '');
  const docDate = escapeHTML(parent.DocDate || child.DocDate || '');
  
  let formattedDate = 'Unknown';
  if (docDate) {
    try {
      formattedDate = new Date(docDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch(e) {
      formattedDate = docDate;
    }
  } else if (issueMonth || issueYear) {
    formattedDate = `${issueMonth} ${issueYear}`.trim();
  }

  const docContent = data.html || '<p>No content available.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} | CLA Online Citation</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --border: #e2e8f0;
      --primary: #0c8742;
      --primary-light: rgba(12, 135, 66, 0.08);
      --font-sans: 'Inter', sans-serif;
      --font-serif: 'Lora', Georgia, serif;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0b0f19;
        --surface: #151e2e;
        --text: #f1f5f9;
        --muted: #94a3b8;
        --border: #1e293b;
        --primary: #10b981;
        --primary-light: rgba(16, 185, 129, 0.1);
      }
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      line-height: 1.6;
      padding: 40px 20px;
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
      background-color: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05);
      overflow: hidden;
    }

    .header-bar {
      background: linear-gradient(135deg, var(--primary), #065f2c);
      color: #ffffff;
      padding: 30px 40px;
      position: relative;
    }

    @media (prefers-color-scheme: dark) {
      .header-bar {
        background: linear-gradient(135deg, #064e3b, #022c22);
      }
    }

    .badge-row {
      display: flex;
      gap: 10px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }

    .badge {
      background-color: rgba(255, 255, 255, 0.15);
      color: #ffffff;
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .badge.primary-badge {
      background-color: #ffffff;
      color: #065f2c;
    }

    .document-title {
      font-size: 1.8rem;
      font-weight: 800;
      line-height: 1.3;
      margin-bottom: 8px;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      padding: 24px 40px;
      background-color: var(--bg);
      border-bottom: 1px solid var(--border);
    }

    .meta-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .meta-label {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
    }

    .meta-value {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text);
    }

    .content-body {
      padding: 40px;
      font-family: var(--font-serif);
      font-size: 1.15rem;
      line-height: 1.75;
      color: var(--text);
    }

    .content-body p {
      margin-bottom: 1.5em;
    }

    .content-body h1, .content-body h2, .content-body h3, .content-body h4 {
      font-family: var(--font-sans);
      color: var(--text);
      font-weight: 700;
      margin-top: 1.8em;
      margin-bottom: 0.8em;
      line-height: 1.25;
    }

    .content-body h1 { font-size: 1.8rem; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .content-body h2 { font-size: 1.5rem; }
    .content-body h3 { font-size: 1.25rem; }

    .content-body ul, .content-body ol {
      margin-bottom: 1.5em;
      padding-left: 24px;
    }

    .content-body li {
      margin-bottom: 0.5em;
    }

    .content-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 2em 0;
      font-family: var(--font-sans);
      font-size: 0.95rem;
    }

    .content-body th, .content-body td {
      border: 1px solid var(--border);
      padding: 12px 16px;
      text-align: left;
    }

    .content-body th {
      background-color: var(--bg);
      font-weight: 700;
    }

    .content-body blockquote {
      border-left: 4px solid var(--primary);
      padding-left: 20px;
      font-style: italic;
      color: var(--muted);
      margin: 1.5em 0;
    }

    .content-body a {
      color: var(--primary);
      text-decoration: underline;
    }

    .footer-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 24px 40px;
      background-color: var(--bg);
      border-top: 1px solid var(--border);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 18px;
      font-size: 0.9rem;
      font-weight: 600;
      font-family: var(--font-sans);
      border-radius: 8px;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s ease;
      border: none;
    }

    .btn-secondary {
      background-color: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
    }

    .btn-secondary:hover {
      background-color: var(--border);
    }

    .btn-primary {
      background-color: var(--primary);
      color: #ffffff;
    }

    .btn-primary:hover {
      opacity: 0.9;
    }

    .footer-note {
      font-size: 0.8rem;
      color: var(--muted);
    }

    @media (max-width: 600px) {
      body {
        padding: 10px 5px;
      }
      .header-bar {
        padding: 20px;
      }
      .meta-grid {
        padding: 20px;
      }
      .content-body {
        padding: 20px;
        font-size: 1.05rem;
      }
      .footer-actions {
        padding: 20px;
        flex-direction: column;
        gap: 16px;
        align-items: stretch;
        text-align: center;
      }
    }

    @media print {
      body {
        background-color: #ffffff;
        color: #000000;
        padding: 0;
      }
      .container {
        border: none;
        box-shadow: none;
        max-width: 100%;
      }
      .header-bar {
        background: none;
        color: #000000;
        border-bottom: 2px solid #000000;
        padding: 20px 0;
      }
      .badge {
        color: #000000;
        border: 1px solid #000000;
      }
      .meta-grid {
        background: none;
        padding: 20px 0;
        border-bottom: 1px solid #000000;
      }
      .content-body {
        padding: 20px 0;
      }
      .footer-actions {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <div class="badge-row">
        <span class="badge primary-badge">${sourceTable}</span>
        <span class="badge">ID: ${recordId}</span>
      </div>
      <h1 class="document-title">${title}</h1>
    </div>
    
    <div class="meta-grid">
      <div class="meta-item">
        <span class="meta-label">File Name</span>
        <span class="meta-value">${fileName}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Category</span>
        <span class="meta-value">${category}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Subject</span>
        <span class="meta-value">${subject}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Sections</span>
        <span class="meta-value">${sections}</span>
      </div>
      ${author !== 'Unknown' ? `
      <div class="meta-item">
        <span class="meta-label">Author</span>
        <span class="meta-value">${author}</span>
      </div>
      ` : ''}
      <div class="meta-item">
        <span class="meta-label">Document Date</span>
        <span class="meta-value">${formattedDate}</span>
      </div>
    </div>
    
    <div class="content-body">
      ${docContent}
    </div>
    
    <div class="footer-actions">
      <button class="btn btn-secondary" onclick="window.close()">Close Tab</button>
      <div class="footer-note">CLA Online - Verified Grounded Database Source</div>
      <button class="btn btn-primary" onclick="window.print()">Print Document</button>
    </div>
  </div>
</body>
</html>`;
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

      if (path === '/api/citation' && req.method === 'GET') {
        try {
          const urlParsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const sourceTable = urlParsed.searchParams.get('sourceTable');
          const recordId = urlParsed.searchParams.get('recordId');
          const parentId = urlParsed.searchParams.get('parentId');

          if (!sourceTable || !recordId) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h1>400 Bad Request</h1><p>sourceTable and recordId parameters are required.</p>');
            return;
          }

          const citationData = await runPythonCitation(sourceTable, recordId, parentId);

          if (citationData.error) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end(`<h1>404 Citation Not Found</h1><p>${escapeHTML(citationData.error)}</p>`);
            return;
          }

          const htmlResponse = renderCitationHTML(citationData);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(htmlResponse);
        } catch (error) {
          console.error('[Citation Endpoint] Error:', error);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h1>500 Internal Server Error</h1><p>${escapeHTML(error.message)}</p>`);
        }
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

          const answerText = llmResponse.content || '';
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
                source_table: r.source_table,
                record_id: r.record_id,
                parent_id: r.parent_id,
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
              source_table: r.source_table,
              record_id: r.record_id,
              parent_id: r.parent_id,
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
            }))
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