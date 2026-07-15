

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

    function formatDocumentContent(rawText) {
      if (!rawText) return '<p>No content available.</p>';

      const trimmed = rawText.trim();
      const hasHTML = /<[a-z][\s\S]*>/i.test(trimmed) && (
        trimmed.includes('</') ||
        trimmed.includes('/>') ||
        trimmed.toLowerCase().includes('<br>') ||
        trimmed.toLowerCase().includes('<p>')
      );

      if (hasHTML) {
        let bodyContent = rawText;
        const bodyMatch = rawText.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) {
          bodyContent = bodyMatch[1];
        } else {
          bodyContent = bodyContent.replace(/<head[^>]*>[\s\S]*?<\/head>/i, '');
        }
        bodyContent = bodyContent
          .replace(/<html[^>]*>/gi, '')
          .replace(/<\/html>/gi, '')
          .replace(/<!doctype[^>]*>/gi, '')
          .replace(/<link[^>]*>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

        return bodyContent.trim();
      }

      // Pre-process to separate glued paragraph boundaries
      const preProcessed = rawText
        .replace(/([.!?])([A-Z])/g, '$1\n$2')
        .replace(/([.!?])(\d+(?:\.\d+)?\s+[A-Z])/g, '$1\n$2');

      const lines = preProcessed.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
      let htmlResult = '';

      let inFootnotes = false;
      let inList = false;

      for (let idx = 0; idx < lines.length; idx++) {
        let line = lines[idx].trim();
        if (!line) continue;

        // Detect Footnotes/References section at the end of document
        const isFootnote = line.startsWith('*') || /^\d+\s+[a-zA-Z\[]/.test(line) || /^\d+\s+See\s+/.test(line);

        if (isFootnote && idx > lines.length * 0.6) {
          if (!inFootnotes) {
            if (inList) {
              htmlResult += '</ul>';
              inList = false;
            }
            htmlResult += '<div class="footnotes-section" style="margin-top: 40px; padding-top: 20px; border-top: 1px dashed var(--border);">';
            htmlResult += '<h4 style="font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 12px;">References / Footnotes</h4>';
            inFootnotes = true;
          }

          htmlResult += `<div class="footnote-item" style="font-size: 0.9rem; color: var(--muted); margin-bottom: 8px; line-height: 1.5;">${escapeHTML(line)}</div>`;
          continue;
        }

        if (inFootnotes) {
          htmlResult += `<div class="footnote-item" style="font-size: 0.9rem; color: var(--muted); margin-bottom: 8px; line-height: 1.5;">${escapeHTML(line)}</div>`;
          continue;
        }

        const isBulletMarker = line.startsWith('-') || line.startsWith('•') || line.startsWith('*') ||
          /^[a-z0-9]\)\s+/i.test(line) || /^\([a-z0-9]\)\s+/i.test(line);

        let shouldBeListItem = isBulletMarker;
        if (!shouldBeListItem && idx > 0) {
          const prevLine = lines[idx - 1].trim();
          if (prevLine.endsWith(':') && line.length < 150) {
            shouldBeListItem = true;
          } else if (inList && line.length < 150 && !/^\d+\.\s+/.test(line)) {
            shouldBeListItem = true;
          }
        }

        if (shouldBeListItem) {
          if (!inList) {
            htmlResult += '<ul style="margin-bottom: 1.6em; padding-left: 24px;">';
            inList = true;
          }
          const cleaned = line
            .replace(/^[-•*]\s*/, '')
            .replace(/^[a-z0-9]\)\s+/i, '')
            .replace(/^\([a-z0-9]\)\s+/i, '');
          htmlResult += `<li style="margin-bottom: 0.5em; font-family: var(--font-serif); font-size: 1.15rem; line-height: 1.7; color: var(--text);">${escapeHTML(cleaned)}</li>`;
          continue;
        }

        if (inList) {
          htmlResult += '</ul>';
          inList = false;
        }

        const isAllUpper = line.length < 150 && line === line.toUpperCase() && /[A-Z]/.test(line);
        const isNumberHeader = line.length < 120 && (/^\d+\.\s+[A-Z]/i.test(line) || /^[IVXLCDM]+\.\s+[A-Z]/i.test(line));
        const isShortNoPeriod = line.length < 100 && !line.endsWith('.');
        const isDocHeaderLine = idx < 3 && line.length < 120;

        if (isAllUpper || isNumberHeader || isShortNoPeriod || isDocHeaderLine) {
          let level = 3;
          if (idx === 0) {
            level = 2;
          } else if (isAllUpper && line.length < 60) {
            level = 2;
          }

          htmlResult += `<h${level} style="font-family: var(--font-sans); font-weight: 700; color: var(--text); margin-top: 1.6em; margin-bottom: 0.6em; line-height: 1.3;">${escapeHTML(line)}</h${level}>`;
        } else {
          let formattedLine = escapeHTML(line);
          formattedLine = formattedLine.replace(/^(\d+(?:\.\d+)?\s+)/, '<strong>$1</strong>');

          if ((line.startsWith('“') && line.endsWith('”')) || (line.startsWith('"') && line.endsWith('"')) || (line.startsWith('‘') && line.endsWith('’')) || (line.startsWith("'") && line.endsWith("'"))) {
            htmlResult += `<p style="font-family: var(--font-serif); font-size: 1.15rem; line-height: 1.8; color: var(--text); margin-bottom: 1.6em; font-style: italic; padding-left: 20px; border-left: 3px solid var(--primary-light);">${formattedLine}</p>`;
          } else {
            htmlResult += `<p style="font-family: var(--font-serif); font-size: 1.15rem; line-height: 1.8; color: var(--text); margin-bottom: 1.6em;">${formattedLine}</p>`;
          }
        }
      }

      if (inList) {
        htmlResult += '</ul>';
      }
      if (inFootnotes) {
        htmlResult += '</div>';
      }

      return htmlResult;
    }

    function renderCitationHTML(data, theme = 'light') {
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
        } catch (e) {
          formattedDate = docDate;
        }
      } else if (issueMonth || issueYear) {
        formattedDate = `${issueMonth} ${issueYear}`.trim();
      }

      const docContent = formatDocumentContent(data.html);
      const isDark = theme === 'dark';

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
      --bg: ${isDark ? '#111111' : '#f7f7f7'};
      --surface: ${isDark ? '#151515' : '#ffffff'};
      --text: ${isDark ? '#fdfdfd' : '#111111'};
      --muted: ${isDark ? '#A3A3A3' : '#6e6e6e'};
      --border: ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)'};
      --primary: #0C8742;
      --primary-light: ${isDark ? 'rgba(12, 135, 66, 0.06)' : 'rgba(12, 135, 66, 0.08)'};
      --font-sans: 'Inter', sans-serif;
      --font-serif: 'Lora', Georgia, serif;
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
      padding: 0;
      margin: 0;
      position: relative;
      min-height: 100vh;
    }

    /* Courthouse Background Image & Tint */
    .chat-background-image {
      position: fixed;
      inset: 0;
      background-image: url("/assets/Images/chatbackground_image.png");
      background-repeat: no-repeat;
      background-position: center;
      background-size: cover;
      pointer-events: none;
      z-index: 0;
      opacity: ${isDark ? '0.12' : '0.4'};
    }

    .chat-background-tint {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 1;
      background: ${isDark ? 'rgba(0, 0, 0, 0.72)' : 'transparent'};
    }

    /* Premium Top Header */
    .top-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 60px;
      padding: 0 40px;
      background-color: var(--surface);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    
    .nav-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 700;
      color: var(--primary);
      font-size: 1.1rem;
      letter-spacing: 0.04em;
    }

    .nav-brand img {
      height: 28px;
      width: auto;
      object-fit: contain;
    }

    .main-container {
      position: relative;
      z-index: 2;
      max-width: 1000px;
      margin: 40px auto;
      padding: 0 20px;
    }

    .document-card {
      background-color: var(--surface);
      border: 1px solid var(--border);
      border-top: 4px solid var(--primary);
      border-radius: 16px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.02);
      overflow: hidden;
    }

    .header-bar {
      padding: 40px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(to bottom right, var(--surface), var(--bg));
    }

    .badge-row {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    .badge {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      color: var(--muted);
      background-color: var(--surface);
    }

    .badge.primary-badge {
      background-color: var(--primary-light);
      color: var(--primary);
      border-color: rgba(12, 135, 66, 0.15);
    }

    .document-title {
      font-size: 2rem;
      font-weight: 800;
      line-height: 1.3;
      color: var(--text);
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 20px;
      padding: 30px 40px;
      background-color: var(--surface);
      border-bottom: 1px solid var(--border);
    }

    .meta-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .meta-label {
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }

    .meta-value {
      font-size: 0.92rem;
      font-weight: 600;
      color: var(--text);
    }

    .content-body {
      padding: 40px 50px;
      font-family: var(--font-serif) !important;
      font-size: 1.15rem !important;
      line-height: 1.8 !important;
      color: var(--text) !important;
    }

    .content-body p, .content-body P {
      font-family: var(--font-serif) !important;
      margin-bottom: 1.6em !important;
      color: var(--text) !important;
      font-size: 1.15rem !important;
      line-height: 1.8 !important;
    }

    .content-body h1, .content-body h2, .content-body h3, .content-body h4,
    .content-body H1, .content-body H2, .content-body H3, .content-body H4 {
      font-family: var(--font-sans) !important;
      color: var(--text) !important;
      font-weight: 700 !important;
      margin-top: 1.8em !important;
      margin-bottom: 0.8em !important;
      line-height: 1.3 !important;
      display: block !important;
    }

    .content-body h1, .content-body H1 { font-size: 1.8rem !important; border-bottom: 1px solid var(--border) !important; padding-bottom: 8px !important; }
    .content-body h2, .content-body H2 { font-size: 1.5rem !important; }
    .content-body h3, .content-body H3 { font-size: 1.25rem !important; }
    .content-body h4, .content-body H4 { font-size: 1.1rem !important; }

    .content-body ul, .content-body ol, .content-body UL, .content-body OL {
      margin-bottom: 1.6em !important;
      padding-left: 28px !important;
    }

    .content-body li, .content-body LI {
      margin-bottom: 0.6em !important;
      font-family: var(--font-serif) !important;
      font-size: 1.15rem !important;
    }

    .content-body table, .content-body TABLE {
      width: 100% !important;
      border-collapse: collapse !important;
      margin: 2.5em 0 !important;
      font-family: var(--font-sans) !important;
      font-size: 0.95rem !important;
    }

    .content-body th, .content-body td, .content-body TH, .content-body TD {
      border: 1px solid var(--border) !important;
      padding: 12px 18px !important;
      text-align: left !important;
    }

    .content-body th, .content-body TH {
      background-color: var(--bg) !important;
      font-weight: 700 !important;
      color: var(--text) !important;
    }

    .content-body blockquote, .content-body BLOCKQUOTE {
      border-left: 4px solid var(--primary) !important;
      padding-left: 20px !important;
      font-style: italic !important;
      color: var(--muted) !important;
      margin: 1.6em 0 !important;
    }

    .content-body a, .content-body A {
      color: var(--primary) !important;
      text-decoration: underline !important;
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
      padding: 10px 20px;
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
      .top-nav {
        padding: 0 20px;
      }
      .main-container {
        margin: 20px auto;
      }
      .header-bar {
        padding: 24px;
      }
      .meta-grid {
        padding: 24px;
        grid-template-columns: 1fr;
      }
      .content-body {
        padding: 24px;
        font-size: 1.05rem;
      }
      .footer-actions {
        padding: 24px;
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
      .top-nav {
        display: none;
      }
      .document-card {
        border: none;
        box-shadow: none;
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
  <div class="chat-background-image" aria-hidden="true"></div>
  <div class="chat-background-tint" aria-hidden="true"></div>

  <header class="top-nav">
    <div class="nav-brand">
      <img src="/assets/Images/logo.png" alt="CLA Corporate Law Adviser">
      <span>CLA Online Legal Database</span>
    </div>
  </header>

  <div class="main-container">
    <div class="document-card">
      <div class="header-bar">
        <div class="badge-row">
          <span class="badge primary-badge">${sourceTable}</span>
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
      </div>
    </div>
  </div>
</body>
</html>`;
    }

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

      // Serve static files from frontend directory
      if (req.method === 'GET' && (path.startsWith('/assets/') || path.startsWith('/CSS/') || path.startsWith('/javascript/') || path.startsWith('/HTML/'))) {
        const fs = require('fs');
        const pathModule = require('path');
        const filePath = pathModule.join(__dirname, '..', 'frontend', path);
        fs.stat(filePath, (err, stats) => {
          if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
          }
          const ext = pathModule.extname(filePath).toLowerCase();
          let contentType = 'application/octet-stream';
          if (ext === '.html') contentType = 'text/html';
          else if (ext === '.css') contentType = 'text/css';
          else if (ext === '.js') contentType = 'application/javascript';
          else if (ext === '.png') contentType = 'image/png';
          else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
          else if (ext === '.svg') contentType = 'image/svg+xml';
          else if (ext === '.ico') contentType = 'image/x-icon';

          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Access-Control-Allow-Origin': '*'
          });
          fs.createReadStream(filePath).pipe(res);
        });
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
          const theme = urlParsed.searchParams.get('theme') || 'light';

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

          const htmlResponse = renderCitationHTML(citationData, theme);
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

Style and Tone Requirements:
- Write in a natural, cohesive, humanized legal advisory tone. Do not just copy-paste blocks from the database.
- Present a clear, structured legal explanation.
- Use Markdown formatting for structure: headings (e.g., "### Heading"), bullet points, numbered lists, tables (where data can be formatted in columns), and bold text for key legal terms or sections.
- Avoid printing raw file names or titles inline in the text.
- Use numerical citation tags like [1], [2], [3] to cite which source(s) the information came from. The citation number must correspond to the Source number provided in the context (e.g. use [1] for [Source 1], [2] for [Source 2]).
- Ensure the output is clean and complete.

At the end of your response, add the tag '---SUGGESTIONS---' followed by 3 relevant follow-up questions the user might ask next, one per line.
Example:
---SUGGESTIONS---
What are the requirements for board resolutions under Section 135?
Are private companies exempt from these regulations?
What is the penalty for violating this provision?`;

          const provider = settings.DEFAULT_LLM_PROVIDER;
          const model = settings.DEFAULT_LLM_MODEL;
          const llm = getLLMProvider(provider, model);

          let llmResponse;
          try {
            llmResponse = await llm.generate({
              systemPrompt: systemPrompt,
              messages: [{ role: 'user', content: `Question: ${question}\n\nSearch Context:\n${contextBlock}` }],
              temperature: 0.1,
              maxTokens: 2048
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

          let answerText =
            llmResponse?.content ||
            llmResponse?.text ||
            llmResponse?.response ||
            llmResponse?.message?.content ||
            llmResponse?.choices?.[0]?.message?.content ||
            '';

          let suggestions = [];

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

          // Extract suggestions
          const sugIndex = answerText.indexOf('---SUGGESTIONS---');
          if (sugIndex !== -1) {
            const sugPart = answerText.slice(sugIndex + '---SUGGESTIONS---'.length);
            answerText = answerText.slice(0, sugIndex).trim();
            suggestions = sugPart
              .split('\n')
              .map(line => line.trim().replace(/^-\s*/, '').replace(/^\d+\.\s*/, ''))
              .filter(line => line.length > 0 && !line.includes('---'));
          }

          // Find all bracketed citation numbers, e.g., [1], [2]
          const citationRegex = /\[([1-9])\]/g;
          let match;
          const citedIndices = new Set();
          while ((match = citationRegex.exec(answerText)) !== null) {
            const idx = parseInt(match[1], 10) - 1;
            if (idx >= 0 && idx < results.length) {
              citedIndices.add(idx);
            }
          }

          // Fallback to title/filename matching if no numerical citations found
          if (citedIndices.size === 0) {
            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
              const fileName = (r.original && r.original.child && r.original.child.FileName) ||
                (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
              if (answerText.toLowerCase().includes(title.toLowerCase().slice(0, 30)) ||
                answerText.toLowerCase().includes(fileName.toLowerCase())) {
                citedIndices.add(i);
              }
            }
          }

          const uniqueSources = [];
          const seenSources = new Set();
          citedIndices.forEach(idx => {
            const r = results[idx];
            const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
            const fileName =
              (r.original && r.original.child && r.original.child.FileName) ||
              (r.original && r.original.parent && r.original.parent.FileName) ||
              'Unknown';

            const sourceKey = `${title}:::${fileName}`;

            if (!seenSources.has(sourceKey)) {
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
          });

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
            title: payload.title || (payload.mode === 'rag' ? 'New RAG Search' : 'New chat'),
            mode: payload.mode || 'chat',
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
          const urlParsed = new URL(req.url, 'http://localhost');
          const mode = urlParsed.searchParams.get('mode') || 'chat';
          const sessionsCollection = db.collection('chat_sessions');
          console.log(`[MongoDB] Loading sessions for user: ${userId}, mode: ${mode}`);

          const query = { user_id: userId };
          if (mode === 'rag') {
            query.mode = 'rag';
          } else {
            query.$or = [{ mode: 'chat' }, { mode: { $exists: false } }];
          }

          const sessions = await sessionsCollection
            .find(query)
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

          let assistantMsgDoc;

          if (session.mode === 'rag') {
            console.log(`[RAG Session Flow] Executing search for question: "${payload.content}"`);
            let results = [];
            try {
              results = await runPythonSearch(payload.content, 5, true);
            } catch (searchErr) {
              console.error('[RAG Session Flow] Search execution failed:', searchErr);
              setJsonHeaders(res, 500);
              res.end(JSON.stringify({ error: 'Failed to search legal documents database.' }));
              return;
            }

            let answerText = 'I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question.';
            let uniqueSources = [];
            let suggestions = [];

            if (results && results.length > 0) {
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

              const systemPrompt = `You are a professional legal research assistant for Indian corporate and commercial law.
You must answer the user's question grounding your answer strictly and ONLY in the provided search context.
Do NOT use any external or general knowledge. If the provided context does not contain enough information to answer the question, state: "I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question."

Style and Tone Requirements:
- Write in a natural, cohesive, humanized legal advisory tone. Do not just copy-paste blocks from the database.
- Present a clear, structured legal explanation.
- Use Markdown formatting for structure: headings (e.g., "### Heading"), bullet points, numbered lists, tables (where data can be formatted in columns), and bold text for key legal terms or sections.
- Avoid printing raw file names or titles inline in the text.
- Use numerical citation tags like [1], [2], [3] to cite which source(s) the information came from. The citation number must correspond to the Source number provided in the context (e.g. use [1] for [Source 1], [2] for [Source 2]).
- Ensure the output is clean and complete.

At the end of your response, add the tag '---SUGGESTIONS---' followed by 3 relevant follow-up questions the user might ask next, one per line.
Example:
---SUGGESTIONS---
What are the requirements for board resolutions under Section 135?
Are private companies exempt from these regulations?
What is the penalty for violating this provision?`;

              const provider = settings.DEFAULT_LLM_PROVIDER;
              const model = settings.DEFAULT_LLM_MODEL;
              const llm = getLLMProvider(provider, model);

              let llmResponse;
              try {
                llmResponse = await llm.generate({
                  systemPrompt: systemPrompt,
                  messages: [{ role: 'user', content: `Question: ${payload.content}\n\nSearch Context:\n${contextBlock}` }],
                  temperature: 0.1,
                  maxTokens: 2048
                });
                answerText = llmResponse.content || '';
              } catch (llmErr) {
                console.error('[RAG Session Flow] LLM generation failed:', llmErr);
                setJsonHeaders(res, 500);
                res.end(JSON.stringify({ error: 'LLM generation failed.' }));
                return;
              }

              // Extract suggestions
              const sugIndex = answerText.indexOf('---SUGGESTIONS---');
              if (sugIndex !== -1) {
                const sugPart = answerText.slice(sugIndex + '---SUGGESTIONS---'.length);
                answerText = answerText.slice(0, sugIndex).trim();
                suggestions = sugPart
                  .split('\n')
                  .map(line => line.trim().replace(/^-\s*/, '').replace(/^\d+\.\s*/, ''))
                  .filter(line => line.length > 0 && !line.includes('---'));
              }

              // Find all bracketed citation numbers, e.g., [1], [2]
              const citationRegex = /\[([1-9])\]/g;
              let match;
              const citedIndices = new Set();
              while ((match = citationRegex.exec(answerText)) !== null) {
                const idx = parseInt(match[1], 10) - 1;
                if (idx >= 0 && idx < results.length) {
                  citedIndices.add(idx);
                }
              }

              // Fallback to title/filename matching if no numerical citations found
              if (citedIndices.size === 0) {
                for (let i = 0; i < results.length; i++) {
                  const r = results[i];
                  const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
                  const fileName = (r.original && r.original.child && r.original.child.FileName) ||
                    (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
                  if (answerText.toLowerCase().includes(title.toLowerCase().slice(0, 30)) ||
                    answerText.toLowerCase().includes(fileName.toLowerCase())) {
                    citedIndices.add(i);
                  }
                }
              }

              const seenSources = new Set();
              citedIndices.forEach(idx => {
                const r = results[idx];
                const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
                const fileName = (r.original && r.original.child && r.original.child.FileName) ||
                  (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
                const sourceKey = `${title}:::${fileName}`;
                if (!seenSources.has(sourceKey)) {
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
              });

              if (uniqueSources.length === 0 && results.length > 0) {
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
            }

            assistantMsgDoc = {
              message_id: randomUUID(),
              session_id: session.session_id,
              user_id: userId,
              role: 'assistant',
              content: answerText,
              created_at: new Date().toISOString(),
              sequence_number: session.message_count + 2,
              metadata: {
                follow_up_questions: suggestions,
                sources: uniqueSources,
                model: settings.DEFAULT_LLM_MODEL
              }
            };
          } else {
            const { runAgentFlow } = require('./agentSystem');
            const agentResult = await runAgentFlow(payload.content || '', { history: previousMessages });

            assistantMsgDoc = {
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
          }

          await messagesCollection.insertOne(assistantMsgDoc);

          const sessionUpdate = {
            updated_at: new Date().toISOString(),
            last_message_at: new Date().toISOString(),
            message_count: session.message_count + 2
          };

          if ((session.title === 'New chat' || session.title === 'New RAG Search') && payload.content) {
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

      if (path === '/api/chat/feedback' && req.method === 'POST') {
        const userId = getAuthenticatedUserId(req);
        if (!userId) {
          setJsonHeaders(res, 401);
          res.end(JSON.stringify({ error: 'Authentication required.' }));
          return;
        }

        try {
          const payload = await getRequestBody(req);
          const { session_id, message_id, feedback } = payload;

          if (!session_id || !message_id || !feedback) {
            setJsonHeaders(res, 400);
            res.end(JSON.stringify({ error: 'session_id, message_id, and feedback are required.' }));
            return;
          }

          const messagesCollection = db.collection('chat_messages');
          const result = await messagesCollection.updateOne(
            { session_id, message_id, user_id: userId },
            { $set: { feedback: feedback, updated_at: new Date().toISOString() } }
          );

          if (result.matchedCount === 0) {
            setJsonHeaders(res, 404);
            res.end(JSON.stringify({ error: 'Message not found.' }));
            return;
          }

          setJsonHeaders(res, 200);
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          console.error('Submit feedback failed', error);
          setJsonHeaders(res, 500);
          res.end(JSON.stringify({ error: 'Unable to save feedback.' }));
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

