const themeToggle = document.getElementById('themeToggle');
const newChatButton = document.getElementById('newChatButton');
const chatWindow = document.getElementById('chatWindow');
const chatBody = document.querySelector('.chat-body');
const chatList = document.getElementById('chatList');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const uploadBtn = document.getElementById('uploadBtn');
const fileUpload = document.getElementById('fileUpload');
const welcomeCard = document.getElementById('welcomeCard');
const sessionSearchInput = document.getElementById('sessionSearchInput');
const chatPanel = document.getElementById('chatPanel');
const chatMain = document.querySelector('.chat-main');

let sessions = [];
let messagesBySession = {};
let currentSessionId = null;
let sessionSearchQuery = '';
let filteredSessionIds = [];
let searchDebounceTimer = null;
let isLoadingSessions = false;
let isLoadingMessages = false;
let isSendingMessage = false;
let selectedFiles = [];
let activeSessionMenuId = null;
let pendingDeleteSessionId = null;
let isDeletingSession = false;
let sessionMenuPortal = null;
let isAutoScrollEnabled = true; // Track if auto-scroll should be active
let sidebarResizeActive = false;
let activeAbortController = null;

function cleanLoadingText(text) {
  if (!text) return 'Preparing your response';
  return text.replace(/\.\.\.$/, '').replace(/\.$/, '').trim();
}

function setSendButtonState(isProcessing) {
  if (!sendBtn) return;
  if (isProcessing) {
    sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-right:5px;"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>Stop';
    sendBtn.classList.add('stop-btn');
    sendBtn.setAttribute('aria-label', 'Stop generating response');
    sendBtn.setAttribute('title', 'Stop generating response');
  } else {
    sendBtn.innerHTML = 'Send';
    sendBtn.classList.remove('stop-btn');
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.setAttribute('title', 'Send message');
  }
}

function handleStopGenerating() {
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  const sessionId = activeProcessingSessionId || currentSessionId;
  const thinkingId = activeProcessingMessageId;

  clearProcessingIndicator();
  isSendingMessage = false;
  setSendButtonState(false);

  if (sessionId && thinkingId && messagesBySession[sessionId]) {
    messagesBySession[sessionId] = messagesBySession[sessionId].filter(m => m.message_id !== thinkingId);
    messagesBySession[sessionId].push({
      message_id: 'stopped-' + Date.now(),
      session_id: sessionId,
      role: 'assistant',
      content: 'Generation stopped by user.',
      created_at: nowISO(),
      metadata: { isStopped: true }
    });
  }

  renderSessions();
  renderMessages();
  updateWelcomeCard();
}

function getApiBaseUrl() {
  const configuredBaseUrl = (window.__CLA_API_BASE_URL__ || '').toString().trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, '');
  }

  // If served from a static web server on non-3000 port (e.g. 8080, 8081, 5173), redirect API requests to Node backend on port 3000
  if (window.location.port && window.location.port !== '3000') {
    return `${window.location.protocol}//${window.location.hostname}:3000`;
  }

  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  return window.location.origin && window.location.origin !== 'null' ? window.location.origin : 'http://localhost:3000';
}

function getCurrentUserId() {
  let userId = localStorage.getItem('cla-user-id');
  if (!userId) {
    userId = 'user-' + generateId();
    localStorage.setItem('cla-user-id', userId);
  }
  return userId;
}

function getSessionIdentifier(session) {
  if (!session || typeof session !== 'object') return null;
  return session.session_id || session.sessionId || session.id || session._id || null;
}

function getSessionOwnerId(session) {
  if (!session || typeof session !== 'object') return null;
  return session.user_id || session.userId || session.owner_id || session.created_by || session.email || session.username || null;
}

const SESSION_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
};

function generateId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const randomValue = Math.floor(Math.random() * 16);
    const value = character === 'x' ? randomValue : (randomValue & 0x3 | 0x8);
    return value.toString(16);
  });
}

function generateSessionId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  const chunks = Array.from({ length: 3 }, (_, index) => {
    const start = index * 4;
    return Array.from(bytes.slice(start, start + 4), (byte) => alphabet[byte % alphabet.length]).join('');
  });
  return `CLA-${chunks.join('-')}`;
}

function nowISO() {
  return new Date().toISOString();
}

function ensureMessageTimestamp(message) {
  if (!message || typeof message !== 'object') return null;

  const timestampValue = message.timestamp || message.created_at || message.updated_at;
  if (timestampValue) {
    if (!message.created_at) message.created_at = timestampValue;
    if (!message.timestamp) message.timestamp = timestampValue;
    return timestampValue;
  }

  const createdAt = nowISO();
  message.created_at = createdAt;
  message.timestamp = createdAt;
  return createdAt;
}

function formatMessageTimestamp(message) {
  const timestampValue = ensureMessageTimestamp(message);
  if (!timestampValue) return '';

  const date = new Date(timestampValue);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

let activeTypingIntervals = [];
let messagesToAnimate = new Set();
let activeProgressPollTimer = null;
let activeProgressRequestId = null;
let activeProgressStageIndex = 0;
let activeProcessingSessionId = null;
let activeProcessingMessageId = null;

function clearTypingIntervals() {
  activeTypingIntervals.forEach(clearInterval);
  activeTypingIntervals = [];
}

function clearProcessingIndicator() {
  if (activeProgressPollTimer) {
    clearInterval(activeProgressPollTimer);
    activeProgressPollTimer = null;
  }
  activeProgressRequestId = null;
  activeProgressStageIndex = 0;
  activeProcessingSessionId = null;
  activeProcessingMessageId = null;
}

function updateThinkingMessage(sessionId, messageId, messageText, stageIndex) {
  const sessionMessages = messagesBySession[sessionId] || [];
  const thinkingMessage = sessionMessages.find(message => message.message_id === messageId);
  if (!thinkingMessage) return false;

  thinkingMessage.metadata = thinkingMessage.metadata || {};
  thinkingMessage.metadata.isThinking = true;
  thinkingMessage.metadata.processingStage = stageIndex;
  thinkingMessage.content = cleanLoadingText(messageText);
  return true;
}

function startBackendProgressPolling(sessionId, messageId, requestId) {
  clearProcessingIndicator();

  const sessionMessages = messagesBySession[sessionId] || [];
  const thinkingMessage = sessionMessages.find(message => message.message_id === messageId);
  if (!thinkingMessage) return;

  thinkingMessage.metadata = thinkingMessage.metadata || {};
  thinkingMessage.metadata.isThinking = true;
  thinkingMessage.metadata.processingStage = 0;
  thinkingMessage.content = cleanLoadingText('Preparing your response');

  activeProcessingSessionId = sessionId;
  activeProcessingMessageId = messageId;
  activeProgressRequestId = requestId;
  activeProgressStageIndex = 0;

  renderMessages();

  const pollProgress = async () => {
    if (!activeProgressRequestId || !activeProcessingSessionId) return;

    try {
      const response = await fetch(`${getApiBaseUrl()}/api/ask/progress/${encodeURIComponent(activeProgressRequestId)}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': getCurrentUserId(),
        },
      });

      if (!response.ok) {
        return;
      }

      const progress = await response.json();
      const stageIndex = Number(progress?.stageIndex || progress?.stage || 0);
      const messageText = cleanLoadingText(progress?.message || 'Preparing your response');
      const isCompleted = progress?.status === 'completed' || progress?.currentStage === 'completed' || stageIndex >= 5;

      if (!Number.isFinite(stageIndex) || stageIndex <= activeProgressStageIndex) {
        if (isCompleted) {
          clearProcessingIndicator();
        }
        return;
      }

      if (updateThinkingMessage(sessionId, messageId, messageText, stageIndex)) {
        activeProgressStageIndex = stageIndex;
        renderMessages();
      }
    } catch (error) {
      // Ignore polling failures and keep the fallback loading message visible.
    }
  };

  void pollProgress();
  activeProgressPollTimer = setInterval(() => {
    void pollProgress();
  }, 250);
}

function createSession({ title, user_id = getCurrentUserId(), status = SESSION_STATUS.ACTIVE } = {}) {
  const sessionId = generateSessionId();
  const timestamp = nowISO();
  return {
    session_id: sessionId,
    user_id,
    title: title || 'New chat',
    mode: 'chat',
    created_at: timestamp,
    updated_at: timestamp,
    last_message_at: timestamp,
    message_count: 0,
    status,
    isDraft: false,
  };
}

function createDraftSession({ title, user_id = getCurrentUserId(), status = SESSION_STATUS.ACTIVE } = {}) {
  const sessionId = generateSessionId();
  const timestamp = nowISO();
  return {
    session_id: sessionId,
    user_id,
    title: title || 'New chat',
    mode: 'chat',
    created_at: timestamp,
    updated_at: timestamp,
    last_message_at: timestamp,
    message_count: 0,
    status,
    isDraft: true,
  };
}

function createMessage(sessionId, role, content) {
  const existing = messagesBySession[sessionId] || [];
  return {
    message_id: generateId(),
    session_id: sessionId,
    user_id: getCurrentUserId(),
    role,
    content,
    created_at: nowISO(),
    sequence_number: existing.length + 1,
    metadata: {
      sources: [],
      citations: [],
      model: null,
    },
  };
}

function normalizePersistedSession(session, fallbackSession) {
  return {
    ...fallbackSession,
    ...session,
    session_id: getSessionIdentifier(session) || fallbackSession.session_id,
    user_id: getSessionOwnerId(session) || fallbackSession.user_id,
  };
}

async function persistSession(sessionPayload) {
  const persistedSession = await createChatSession(sessionPayload);
  return normalizePersistedSession(persistedSession, sessionPayload);
}

function getCurrentSession() {
  return sessions.find(session => session.session_id === currentSessionId) || null;
}

function getSessionMessages(session) {
  if (!session || !session.session_id) return [];
  return messagesBySession[session.session_id] || [];
}

function isEmptyDraftSession(session) {
  if (!session || !session.isDraft) return false;
  const messages = getSessionMessages(session);
  return !messages.some(message => message.role === 'user');
}

function discardEmptyDraftSession(sessionIdToKeep = null) {
  const draftSessions = sessions.filter(session => isEmptyDraftSession(session) && session.session_id !== sessionIdToKeep);
  if (!draftSessions.length) return false;

  draftSessions.forEach(session => {
    delete messagesBySession[session.session_id];
  });
  sessions = sessions.filter(session => !draftSessions.some(draft => draft.session_id === session.session_id));

  if (currentSessionId && draftSessions.some(session => session.session_id === currentSessionId) && currentSessionId !== sessionIdToKeep) {
    currentSessionId = null;
  }
  return true;
}

function getMessagesForSession(sessionId) {
  return messagesBySession[sessionId] || [];
}

function setCurrentSession(sessionId) {
  currentSessionId = sessionId;
  if (!messagesBySession[sessionId]) {
    messagesBySession[sessionId] = [];
  }
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeToggle.innerHTML = '☾';
  } else {
    document.documentElement.removeAttribute('data-theme');
    themeToggle.innerHTML = '☀';
  }
}

const savedTheme = localStorage.getItem('cla-theme') || 'light';
applyTheme(savedTheme);

themeToggle?.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(current);
  localStorage.setItem('cla-theme', current);
});

// Listen for theme changes from other tabs/windows or Citation page
window.addEventListener('storage', (event) => {
  if (event.key === 'cla-theme' && event.newValue) {
    applyTheme(event.newValue);
  }
});

function escapeHTML(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"]+/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[match]));
}

function formatMarkdown(text) {
  if (!text) return '';

  // Normalize carriage returns to standard newlines
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Escape HTML first to prevent injection
  let html = escapeHTML(text);

  // Parse tables
  const lines = html.split('\n');
  let inTable = false;
  let tableRows = [];
  let processedLines = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (!inTable) {
        inTable = true;
        tableRows = [];
      }
      tableRows.push(trimmed);
    } else {
      if (inTable) {
        processedLines.push(buildHTMLTable(tableRows));
        inTable = false;
      }
      processedLines.push(line);
    }
  }
  if (inTable) {
    processedLines.push(buildHTMLTable(tableRows));
  }

  html = processedLines.join('\n');

  // Parse headings (from h6 down to h1). "##" is a main heading of the answer (Overview,
  // Analysis, Conclusion); "###" and deeper are sub-headings and are styled differently.
  html = html.replace(/^\s*###### (.*?)$/gm, '<h6 class="answer-subheading">$1</h6>');
  html = html.replace(/^\s*##### (.*?)$/gm, '<h5 class="answer-subheading">$1</h5>');
  html = html.replace(/^\s*#### (.*?)$/gm, '<h4 class="answer-subheading">$1</h4>');
  html = html.replace(/^\s*### (.*?)$/gm, '<h3 class="answer-subheading">$1</h3>');
  html = html.replace(/^\s*## (.*?)$/gm, '<h2 class="answer-heading">$1</h2>');
  html = html.replace(/^\s*# (.*?)$/gm, '<h1 class="answer-heading">$1</h1>');

  // Parse lists (unordered)
  html = html.replace(/^\s*[\-\*]\s+(.*?)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*?<\/li>)/gs, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  // Parse lists (ordered)
  html = html.replace(/^\s*\d+\.\s+(.*?)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*?<\/li>)/gs, '<ol>$1</ol>');
  html = html.replace(/<\/ol>\s*<ol>/g, '');

  // Parse bold, italic, code, highlights, blockquotes
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.*?)`/g, '<code>$1</code>');
  html = html.replace(/==(.*?)==/g, '<mark class="answer-highlight">$1</mark>');
  html = html.replace(/^\s*>\s*(.*?)$/gm, '<blockquote class="cited-quote-block">$1</blockquote>');

  // Citation markers: [1], [1][2] -> numbered buttons, one per source. The number is the
  // source's number in the list under the answer.
  // One or two digits only, so law-report years such as [2021] are never read as a marker.
  html = html.replace(/\s*((?:\[\d{1,2}\])+)/g, (match, run) => {
    const numbers = [...new Set((run.match(/\d+/g) || []).map(n => parseInt(n, 10)).filter(n => n > 0))];
    if (!numbers.length) return match;
    const buttons = numbers
      .map(n => `<button type="button" class="cite-ref" data-source-number="${n}" title="View source ${n}" aria-label="Source ${n}">${n}</button>`)
      .join('');
    return `<span class="cite-ref-group">${buttons}</span>`;
  });

  // Handle carriage returns
  html = html.replace(/(<\/h[1-6]>)\n+/g, '$1');
  html = html.replace(/\n\n/g, '<p></p>');
  html = html.replace(/\n/g, '<br>');

  return html;
}


// ---------------------------------------------------------------------------
// Citations: what the chat shows for a message
// ---------------------------------------------------------------------------

const SOURCE_TYPE_LABELS = [
  [/legis/i, 'Legislation'],
  [/case/i, 'Case law'],
  [/notif/i, 'Notification'],
  [/circ/i, 'Circular'],
  [/comm/i, 'Commentary'],
  [/proc/i, 'Procedure'],
  [/art/i, 'Article'],
  [/query/i, 'Expert query'],
  [/book/i, 'Book']
];

function isBookSource(s) {
  return Boolean(s && (s.is_book || s.source_table === 'CLA Books' || /^Pinecone(_Books)?$/.test(s.database_source || '')));
}

function sourceTypeLabel(s) {
  if (s.type_label) return s.type_label;
  if (isBookSource(s)) return 'Book';
  const table = String(s.source_table || '');
  const found = SOURCE_TYPE_LABELS.find(([pattern]) => pattern.test(table));
  return found ? found[1] : (table || 'Source');
}

const MARKER_RUN_PATTERN = /\s*(?:\[\s*(?:Sources?\s*)?\d{1,2}(?:\s*,\s*(?:Sources?\s*)?\d{1,2})*\s*\]\s*)+/gi;
const MAIN_ANSWER_HEADINGS = ['overview', 'analysis', 'conclusion'];
const LEGACY_UNCITED_SOURCES = 5;

// Headings of answers saved before the numbered format: bold lines -> "##" / "###".
function normalizeLegacyHeadings(content) {
  const out = [];
  let skipping = false;
  for (const line of String(content || '').replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.trim();
    const bare = trimmed.replace(/^#{1,6}\s*/, '').replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)\s*:?$/, '$1').replace(/\s*:$/, '').trim();
    const isHeadingLine = /^#{1,6}\s+\S/.test(trimmed) || (/^(?:\*\*|__)[^*_].*?(?:\*\*|__)\s*:?$/.test(trimmed) && trimmed.length <= 140 && !/[.;]$/.test(bare));
    const isMain = MAIN_ANSWER_HEADINGS.includes(bare.toLowerCase()) && trimmed.length <= bare.length + 8;
    if (/^sources?(?:\s+used)?$/i.test(bare) && trimmed.length <= bare.length + 8) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (trimmed.includes('not legal advice')) {
        skipping = false;
        out.push(trimmed);
      }
      continue;
    }
    if (isMain) out.push(`## ${bare.charAt(0).toUpperCase()}${bare.slice(1).toLowerCase()}`);
    else if (isHeadingLine) out.push(`### ${bare}`);
    else out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Source names in older chats were stored as indexed: book file names ("..._PRINT") and
// case names without spaces around "v.". Show them the way new answers do.
function cleanLegacyTitle(s) {
  let title = String(s.title || s.law_title || s.filename || '').replace(/\s+/g, ' ').trim();
  if (isBookSource(s)) {
    return title.replace(/\.pdf$/i, '').replace(/_PRINT(?:\s*\(\d+\))?(?:_\d+)?$/i, '').replace(/_/g, ' ').trim();
  }
  if (/case/i.test(s.source_table || '') && !/\s(?:v|vs|versus)\.?\s/i.test(title)) {
    title = title.replace(/([A-Za-z.)])\s*(v\.|V\.)\s*(?=[A-Z(])/, '$1 $2 ').replace(/\s+/g, ' ').trim();
  }
  return title;
}

// Answers saved before the numbered format list every retrieved chunk and cite them as
// [Source N]. Show them the new way: only the cited sources, numbered to match the text.
function convertLegacyCitations(content, rawSources) {
  const sources = rawSources.filter(s => s && typeof s === 'object');
  const text = normalizeLegacyHeadings(content);
  const keyOf = (s) => (isBookSource(s)
    ? `book|${s.file_name || s.filename || s.title}|${s.page_number || s.parent_id || ''}`
    : `${s.source_table}|${s.record_id}`);

  const citedIndexSet = new Set();
  text.replace(MARKER_RUN_PATTERN, (run) => {
    (run.match(/\d{1,2}/g) || []).forEach(n => {
      const idx = Number(n) - 1;
      if (idx >= 0 && idx < sources.length) citedIndexSet.add(idx);
    });
    return run;
  });

  const hadMarkers = citedIndexSet.size > 0;
  const orderedIndices = hadMarkers
    ? [...citedIndexSet].sort((a, b) => a - b)
    : sources.map((_, idx) => idx);

  const groups = [];
  const groupByKey = new Map();
  for (const idx of orderedIndices) {
    const s = sources[idx];
    const key = keyOf(s);
    if (!groupByKey.has(key)) {
      if (!hadMarkers && groups.length >= LEGACY_UNCITED_SOURCES) continue;
      const group = { key, lead: s, passages: [] };
      groupByKey.set(key, group);
      groups.push(group);
    }
    // Old excerpts can start with the tail of the stored chunk header ("... | File: x.htm] ").
    const excerpt = String(s.excerpt || s.chunk_text || s.content || s.text || '')
      .replace(/^[^\]]{0,400}\|\s*(?:File|Sections?|Section|Court|Judge|Subject):[^\]]*\]\s*/, '');
    if (excerpt) groupByKey.get(key).passages.push({ embedding_id: null, excerpt });
  }

  const numberByIndex = new Map();
  groups.forEach((group, i) => {
    sources.forEach((s, idx) => {
      if (keyOf(s) === group.key) numberByIndex.set(idx, i + 1);
    });
  });

  const rewritten = text.replace(MARKER_RUN_PATTERN, (run) => {
    const numbers = [...new Set((run.match(/\d{1,2}/g) || [])
      .map(n => numberByIndex.get(Number(n) - 1))
      .filter(Boolean))].sort((a, b) => a - b);
    const trailing = (run.match(/\s+$/) || [''])[0];
    return numbers.length ? ` ${numbers.map(n => `[${n}]`).join('')}${trailing}` : trailing;
  }).replace(/[ \t]+([.,;:])/g, '$1');

  return {
    content: rewritten,
    sources: groups.map((group, i) => ({
      ...group.lead,
      number: i + 1,
      title: cleanLegacyTitle(group.lead),
      type_label: sourceTypeLabel(group.lead),
      passages: group.passages,
      excerpt: group.passages.length ? group.passages[0].excerpt : '',
      is_legacy: true
    }))
  };
}

// The text and source list to render for an assistant message (computed once per message).
function getDisplayData(message) {
  const rawContent = message.content || '';
  if (message._display && message._display.forContent === rawContent) return message._display;

  const meta = message.metadata || {};
  const rawSources = Array.isArray(meta.sources) ? meta.sources.filter(s => s && typeof s === 'object') : [];
  const isNumbered = meta.citationFormat === 'numbered' || rawSources.some(s => Number.isFinite(s.number));

  let display;
  if (/could not find authority/i.test(rawContent) && rawContent.length < 400) {
    display = { content: rawContent, sources: [] };
  } else if (isNumbered || meta.isError || meta.isThinking) {
    display = { content: rawContent, sources: rawSources };
  } else {
    display = convertLegacyCitations(rawContent, rawSources);
  }
  display.forContent = rawContent;
  message._display = display;
  return display;
}

// Markers that point at a source that is not in the list are dropped, never shown dead.
function sanitizeCitations(text, maxIndex) {
  if (!text) return '';
  return text.replace(/\s*\[(\d{1,2})\]/g, (match, n) => (maxIndex && Number(n) >= 1 && Number(n) <= maxIndex ? match : ''));
}

// Old chats hold legislation sources under a wrong Act name (an indexing fault since fixed
// on the server). Their correct names are fetched once and applied to the source list.
const legislationTitleCache = new Map();

async function correctLegacyLegislationTitles(message) {
  const display = message._display;
  if (!display || display.titlesChecked) return false;
  display.titlesChecked = true;
  const targets = display.sources.filter(s => s.is_legacy && /legis/i.test(s.source_table || '') && (s.file_name || s.filename));
  if (!targets.length) return false;

  const missing = [...new Set(targets.map(s => String(s.file_name || s.filename).toLowerCase()))]
    .filter(file => !legislationTitleCache.has(file));
  if (missing.length) {
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/legislation-titles?files=${encodeURIComponent(missing.join(','))}`);
      if (response.ok) {
        const data = await response.json();
        missing.forEach(file => legislationTitleCache.set(file, (data.titles && data.titles[file]) || null));
      }
    } catch (error) {
      console.warn('[Citations] Could not load legislation titles:', error);
    }
  }

  let changed = false;
  targets.forEach(s => {
    const title = legislationTitleCache.get(String(s.file_name || s.filename).toLowerCase());
    if (title && title !== s.title) {
      s.title = title;
      changed = true;
    }
  });
  return changed;
}

function buildHTMLTable(rows) {
  if (rows.length < 2) return rows.join('\n');

  const parseCells = (row) => row.split('|').slice(1, -1).map(c => c.trim());
  const headerCells = parseCells(rows[0]);
  const separatorCells = parseCells(rows[1]);

  const hasHeaders = separatorCells.every(c => c.startsWith('-') || c.endsWith('-'));
  let startIdx = 1;
  let headers = [];

  if (hasHeaders) {
    headers = headerCells;
    startIdx = 2;
  } else {
    headers = headerCells.map(() => '');
    startIdx = 0;
  }

  let tableHtml = '<div class="table-container"><table>';
  if (hasHeaders) {
    tableHtml += '<thead><tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr></thead>';
  }
  tableHtml += '<tbody>';
  for (let i = startIdx; i < rows.length; i++) {
    const cells = parseCells(rows[i]);
    tableHtml += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
  }
  tableHtml += '</tbody></table></div>';
  return tableHtml;
}

function highlightMatch(text, query) {
  if (!query) return escapeHTML(text);
  const normalized = text.toLowerCase();
  const needle = query.toLowerCase();
  const index = normalized.indexOf(needle);
  if (index === -1) return escapeHTML(text);
  const before = escapeHTML(text.slice(0, index));
  const match = escapeHTML(text.slice(index, index + needle.length));
  const after = escapeHTML(text.slice(index + needle.length));
  return `${before}<mark>${match}</mark>${after}`;
}

function scrollToBottom() {
  const scrollContainer = chatBody || chatWindow;
  if (!scrollContainer) return;
  if (!isAutoScrollEnabled) return;
  // Use requestAnimationFrame to ensure DOM has updated
  requestAnimationFrame(() => {
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
  });
}

function setupAutoScrollListener() {
  const scrollContainer = chatBody || chatWindow;
  if (!scrollContainer) return;
  
  let scrollTimeout;
  scrollContainer.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    
    // Check if user is scrolled near the bottom (within 100px)
    const isNearBottom = scrollContainer.scrollHeight - (scrollContainer.scrollTop + scrollContainer.clientHeight) < 100;
    isAutoScrollEnabled = isNearBottom;
    
    // Re-enable auto-scroll after 1 second of inactivity
    scrollTimeout = setTimeout(() => {
      isAutoScrollEnabled = true;
    }, 1000);
  });
}

function ensureConversationTracker() {
  if (!chatWindow) return null;
  // Create a collapsed rail + hidden panel if missing
  let rail = document.getElementById('conversationTrackerRail');
  if (!rail) {
    rail = document.createElement('div');
    rail.id = 'conversationTrackerRail';
    rail.className = 'conversation-tracker-rail';

    // Panel that expands on hover (holds chips)
    const panel = document.createElement('div');
    panel.id = 'conversationTrackerPanel';
    panel.className = 'conversation-tracker-panel';
    rail.appendChild(panel);

    document.body.appendChild(rail);

    // Compute scrollbar width and position tracker closer to scrollbar
    const setTrackerPosition = () => {
      // Compute browser scrollbar width (may be 0 on overlay scrollbars)
      const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
      // Place the rail directly to the left of the scrollbar with a small 4px gap
      const gap = 4;
      const offset = scrollbarWidth > 0 ? (scrollbarWidth + gap) : gap + 2;
      rail.style.setProperty('--tracker-right', offset + 'px');

      // Position the expanding panel immediately left of the rail, accounting for rail width
      const panel = document.getElementById('conversationTrackerPanel');
      if (panel) {
        // measure rail width (falls back to 18)
        const railWidth = rail.getBoundingClientRect().width || 18;
        const panelRight = offset + railWidth + 6; // small breathing room
        panel.style.right = `${panelRight}px`;
      }
    };
    setTrackerPosition();
    window.addEventListener('resize', setTrackerPosition);

    // Keep panel open while hovering rail or panel
    const panelEl = document.getElementById('conversationTrackerPanel');
    let openTimeout = null;
    rail.addEventListener('mouseenter', () => {
      clearTimeout(openTimeout);
      rail.classList.add('open');
    });
    rail.addEventListener('mouseleave', () => {
      // delay closing to allow mouse to move into panel
      openTimeout = setTimeout(() => rail.classList.remove('open'), 120);
    });
    if (panelEl) {
      panelEl.addEventListener('mouseenter', () => {
        clearTimeout(openTimeout);
        rail.classList.add('open');
      });
      panelEl.addEventListener('mouseleave', () => {
        openTimeout = setTimeout(() => rail.classList.remove('open'), 120);
      });
    }

    // Create hover preview container appended to body
    let preview = document.getElementById('trackerHoverPreview');
    if (!preview) {
      preview = document.createElement('div');
      preview.id = 'trackerHoverPreview';
      preview.className = 'tracker-hover-preview';
      preview.hidden = true;
      document.body.appendChild(preview);
    }
  }
  return document.getElementById('conversationTrackerPanel');
}

function buildConversationTrackerEntries(messages) {
  const entries = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const assistantMatch = messages.slice(index + 1).find((candidate) => candidate.role === 'assistant' && !candidate.metadata?.isThinking && !candidate.metadata?.isError);
    if (!assistantMatch) continue;
    entries.push({
      userMessage: message,
      assistantMessage: assistantMatch,
    });
  }
  return entries;
}

function renderConversationTracker(messages) {
  const panel = ensureConversationTracker();
  if (!panel) return;
  const entries = buildConversationTrackerEntries(messages);
  if (!entries.length) {
    panel.innerHTML = '';
    // parent rail stays, panel empty
    return;
  }

  panel.innerHTML = '';
  entries.forEach((entry, itemIndex) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tracker-chip';
    const preview = (entry.userMessage.content || '').replace(/\s+/g, ' ').trim();
    chip.innerHTML = `
      <span class="tracker-index">${itemIndex + 1}</span>
      <span class="tracker-text">${escapeHTML(preview.length > 72 ? `${preview.slice(0, 72)}…` : preview)}</span>
    `;
    chip.addEventListener('click', () => scrollToMessage(entry.userMessage.message_id));

    // Hover preview: show full user prompt in the floating preview box
    chip.addEventListener('mouseenter', (ev) => {
      const previewEl = document.getElementById('trackerHoverPreview');
      if (!previewEl) return;
      const fullUserPrompt = (entry.userMessage.content || '').replace(/\s+/g, ' ').trim();
      previewEl.innerHTML = `<div class="preview-title">${escapeHTML(fullUserPrompt)}</div>`;
      const rect = chip.getBoundingClientRect();
      // Position preview to the left of the panel
      previewEl.style.top = Math.max(12, rect.top - 8) + 'px';
      previewEl.style.right = (window.innerWidth - rect.left + 24) + 'px';
      previewEl.hidden = false;
    });
    chip.addEventListener('mouseleave', () => {
      const previewEl = document.getElementById('trackerHoverPreview');
      if (previewEl) previewEl.hidden = true;
    });
    panel.appendChild(chip);
  });

  // Adjust panel height dynamically: grow with number of entries up to 5, then enable vertical scroll
  try {
    const perChip = 52; // approximate chip height including gap
    const visible = Math.min(entries.length, 5);
    if (entries.length === 0) {
      panel.style.height = 'auto';
      panel.style.maxHeight = '200px';
    } else if (entries.length <= 5) {
      panel.style.height = `${visible * perChip + 12}px`;
      panel.style.maxHeight = '';
    } else {
      panel.style.height = '';
      panel.style.maxHeight = `${5 * perChip + 12}px`;
    }
    // ensure only vertical scrollbar
    panel.style.overflowY = 'auto';
    panel.style.overflowX = 'hidden';
  } catch (err) {
    // ignore
  }
}

function scrollToMessage(messageId) {
  if (!messageId || !chatWindow) return;
  const target = chatWindow.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!target) return;

  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.remove('tracker-highlight');
  void target.offsetWidth;
  target.classList.add('tracker-highlight');
  requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function applySidebarWidth(width) {
  if (!chatPanel) return;
  const minWidth = 260;
  const maxWidth = 420;
  const clampedWidth = Math.min(maxWidth, Math.max(minWidth, width));
  chatPanel.style.width = `${clampedWidth}px`;
  chatPanel.style.flexBasis = `${clampedWidth}px`;
  localStorage.setItem('cla-sidebar-width', `${clampedWidth}`);
}

function setupSidebarResizer() {
  if (!chatPanel || !chatMain) return;
  const handle = document.getElementById('chatResizeHandle');
  if (!handle) return;

  const savedWidth = Number(localStorage.getItem('cla-sidebar-width'));
  if (savedWidth) {
    applySidebarWidth(savedWidth);
  }

  handle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    sidebarResizeActive = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = event.clientX;
    const startWidth = chatPanel.getBoundingClientRect().width;

    const onMove = (moveEvent) => {
      if (!sidebarResizeActive) return;
      const nextWidth = startWidth + (moveEvent.clientX - startX);
      applySidebarWidth(nextWidth);
    };

    const onUp = () => {
      sidebarResizeActive = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function truncateTitle(text) {
  if (!text) return 'New chat';
  const value = String(text).trim();
  return value.length > 40 ? value.slice(0, 40) + '...' : value;
}

function ensureSessionMenuPortal() {
  if (sessionMenuPortal) return sessionMenuPortal;
  sessionMenuPortal = document.createElement('div');
  sessionMenuPortal.id = 'sessionMenuPortal';
  sessionMenuPortal.className = 'session-menu-portal';
  document.body.appendChild(sessionMenuPortal);
  return sessionMenuPortal;
}

function renderSessionMenuPortal() {
  const portal = ensureSessionMenuPortal();
  portal.innerHTML = '';
  if (activeSessionMenuId === null) return;

  const session = sessions.find(item => item.session_id === activeSessionMenuId);
  if (!session) {
    activeSessionMenuId = null;
    return;
  }

  const trigger = document.querySelector(`.session-more-btn[data-session-id="${CSS.escape(activeSessionMenuId)}"]`);
  if (!trigger) {
    activeSessionMenuId = null;
    return;
  }

  const rect = trigger.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'session-menu';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'session-menu-item';
  exportBtn.innerHTML = `
    <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path>
    </svg>
    <span>Export chat</span>
  `;
  exportBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    exportSessionChat(session.session_id);
    closeSessionMenu();
  });
  menu.appendChild(exportBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'session-menu-item';
  deleteBtn.innerHTML = `
    <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6H5a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1Zm2 4h2v10h-2V7Zm-3 0h2v10H8V7Zm7 0h-2v10h2V7Z"></path>
    </svg>
    <span>Delete chat</span>
  `;
  deleteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openDeleteDialog(session.session_id);
  });
  menu.appendChild(deleteBtn);
  portal.appendChild(menu);

  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = rect.right - menuRect.width;
    if (top + menuRect.height > window.innerHeight - 8) {
      top = rect.top - menuRect.height - 6;
    }
    if (top < 8) { top = 8; }
    left = Math.min(window.innerWidth - menuRect.width - 8, Math.max(8, left));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  });
}

function renderSessions() {
  if (!chatList) return;
  const visibleSessions = sessionSearchQuery ? filteredSessionIds : sessions.map(session => session.session_id);
  chatList.innerHTML = '';
  visibleSessions.forEach(sessionId => {
    const session = sessions.find(item => item.session_id === sessionId);
    if (!session) return;
    const row = document.createElement('div');
    row.className = 'session-item-row';
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chat-item' + (session.session_id === currentSessionId ? ' active' : '');
    const titleText = truncateTitle(session.title || 'New chat');
    item.setAttribute('title', session.title || 'New chat');
    item.innerHTML = highlightMatch(titleText, sessionSearchQuery);
    item.addEventListener('click', () => selectSession(session.session_id));
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'session-more-btn';
    moreBtn.dataset.sessionId = session.session_id;
    moreBtn.innerHTML = '<img src="../assets/Images/more.png" alt="More options" class="session-more-icon">';
    moreBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSessionMenu(session.session_id);
    });
    row.appendChild(item);
    row.appendChild(moreBtn);
    chatList.appendChild(row);
  });
  renderSessionMenuPortal();
}

function updateWelcomeCard() {
  if (!welcomeCard) return;

  const welcomeTitleEl = welcomeCard.querySelector('.welcome-title');
  const welcomeSubtitleEl = welcomeCard.querySelector('.welcome-subtitle');

  if (welcomeTitleEl) welcomeTitleEl.textContent = 'Ask Legal AI';
  if (welcomeSubtitleEl) welcomeSubtitleEl.textContent = 'Your corporate legal assistant. Ask about company law, case law, circulars, articles and more.';

  const session = getCurrentSession();
  const messages = session ? getMessagesForSession(session.session_id) : [];
  const chatShell = document.querySelector('.chat-window-shell');

  const showWelcome = messages.length === 0;
  welcomeCard.style.display = showWelcome ? 'block' : 'none';

  if (chatShell) {
    chatShell.style.display = showWelcome ? 'none' : '';
  }
}

const CLAIM_STOP_WORDS = new Set('the a an and or of to for in on at by with from as is are was were be been this that these those it its which who what when where how not no but if then than so such can may must shall will would should could has have had do does did under over into upon within without also any all each every other only same'.split(' '));

function claimTokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/[^a-z0-9()\-\s]/g, ' ').split(/\s+/)
    .map(t => t.replace(/^[()\-]+|[()\-]+$/g, ''))
    .filter(t => t && (/\d/.test(t) || (t.length > 3 && !CLAIM_STOP_WORDS.has(t)))));
}

// Of a source's cited passages, the one closest to the sentence the reader clicked from.
function bestPassageFor(source, claim) {
  const passages = Array.isArray(source.passages) && source.passages.length
    ? source.passages
    : [{ embedding_id: source.embedding_id || null, excerpt: source.excerpt || source.chunk_text || source.content || source.text || '' }];
  if (!claim || passages.length === 1) return passages[0];
  const wanted = claimTokens(claim);
  let best = passages[0];
  let bestScore = -1;
  passages.forEach(passage => {
    const score = claimOverlap(wanted, passage.text || passage.excerpt);
    if (score > bestScore) {
      best = passage;
      bestScore = score;
    }
  });
  return best;
}

function claimOverlap(wantedTokens, text) {
  const have = claimTokens(text);
  let score = 0;
  wantedTokens.forEach(token => { if (have.has(token)) score += /\d/.test(token) ? 2 : 1; });
  return score;
}

// The part of a cited passage that supports the sentence the reader clicked from: the
// best-matching sentence and the one after it. Falls back to the start of the passage.
function focusedExcerpt(passage, claim, maxLength = 340) {
  const fallback = passage.excerpt || '';
  const text = passage.text || '';
  if (!claim || !text) return fallback;
  const wanted = claimTokens(claim);
  if (wanted.size < 3) return fallback;
  const sentences = text.split(/(?<=[.;?!])\s+(?=[A-Z(“"\d])/).filter(s => s.trim().length > 0);
  let bestIndex = -1;
  let bestScore = 0;
  sentences.forEach((sentence, i) => {
    const score = claimOverlap(wanted, sentence);
    if (score > bestScore) {
      bestIndex = i;
      bestScore = score;
    }
  });
  if (bestIndex <= 0 || bestScore < 3) return fallback;
  let snippet = sentences[bestIndex];
  if (snippet.length < maxLength * 0.6 && sentences[bestIndex + 1]) snippet += ` ${sentences[bestIndex + 1]}`;
  snippet = snippet.length > maxLength ? `${snippet.slice(0, maxLength).trim()}…` : snippet;
  return `…${snippet}`;
}

// The sentence a citation marker closes: what the reader wants to see supported.
function claimTextBefore(markerEl) {
  const group = markerEl.closest('.cite-ref-group') || markerEl;
  const BLOCK_TAGS = /^(BR|P|UL|OL|LI|H1|H2|H3|H4|H5|H6|DIV|TABLE|BLOCKQUOTE)$/;
  let text = '';
  let node = group.previousSibling;
  while (node && text.length < 600) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (BLOCK_TAGS.test(node.tagName)) break;
      if (node.classList && node.classList.contains('cite-ref-group')) {
        if (text.trim()) break;
      } else {
        text = node.textContent + text;
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      text = node.textContent + text;
    }
    node = node.previousSibling;
  }
  text = text.replace(/\s+/g, ' ').trim();
  const sentences = text.split(/(?<=[.?!])\s+(?=[A-Z(])/);
  return (sentences[sentences.length - 1] || text).slice(-320).trim();
}

// Link to the page that shows a source in full with the cited passage highlighted.
function getSourceViewerUrl(s, claim = '') {
  if (!s || typeof s !== 'object') return null;
  const params = new URLSearchParams();
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const passages = Array.isArray(s.passages) ? s.passages : [];
  const passageIds = passages.map(p => p.embedding_id).filter(Boolean);
  const excerptText = (bestPassageFor(s, claim).excerpt || '').slice(0, 600);

  if (isBookSource(s)) {
    const fileName = s.file_name || s.filename || s.file || '';
    const recordId = passageIds[0] || s.embedding_id || s.record_id || '';
    if (!recordId && !fileName) return null;
    params.set('sourceTable', 'CLA Books');
    if (recordId) params.set('recordId', recordId);
    if (fileName && fileName !== 'Unknown') params.set('file', fileName);
    params.set('page', s.page_number || s.page_no || s.parent_id || 1);
  } else {
    if (!s.source_table || s.record_id === undefined || s.record_id === null) return null;
    params.set('sourceTable', s.source_table);
    params.set('recordId', s.record_id);
  }

  if (passageIds.length) params.set('ids', passageIds.join(','));
  if (excerptText) params.set('highlight', excerptText);
  if (claim) params.set('claim', claim.slice(0, 320));
  if (s.title) params.set('title', String(s.title).slice(0, 200));
  params.set('theme', theme);
  return `${getApiBaseUrl()}/api/citation?${params.toString()}`;
}

function openSourceViewer(s, claim = '') {
  const url = getSourceViewerUrl(s, claim);
  if (url) {
    window.open(url, '_blank');
    return true;
  }
  return false;
}

// One line of context under a source's name: where in the source, which court, what date.
function sourceDetailLine(s) {
  const parts = [];
  if (isBookSource(s) && (s.page_number || s.page_no)) parts.push(`Page ${s.page_number || s.page_no}`);
  if (s.sections && !/^(general|\d+)$/i.test(String(s.sections).trim())) parts.push(String(s.sections));
  if (s.court) parts.push(String(s.court).replace(/[()]/g, ''));
  if (s.doc_date && !/legis/i.test(s.source_table || '') && !isBookSource(s)) {
    const date = new Date(s.doc_date);
    if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }));
  }
  return parts.join(' · ');
}

let activeInlineSourcePopover = null;

function closeInlineSourceModal() {
  if (activeInlineSourcePopover) {
    activeInlineSourcePopover.remove();
    activeInlineSourcePopover = null;
    document.removeEventListener('click', handleOutsidePopoverClick);
    document.removeEventListener('keydown', handlePopoverKeydown);
    window.removeEventListener('resize', updatePopoverPosition);
    window.removeEventListener('scroll', handleChatWindowScroll, true);
  }
}

function handleOutsidePopoverClick(e) {
  if (!activeInlineSourcePopover) return;
  if (!activeInlineSourcePopover.contains(e.target) && !e.target.closest('.cite-ref')) {
    closeInlineSourceModal();
  }
}

function handlePopoverKeydown(e) {
  if (e.key === 'Escape') {
    closeInlineSourceModal();
  }
}

function handleChatWindowScroll(e) {
  if (activeInlineSourcePopover && !(e && activeInlineSourcePopover.contains(e.target))) {
    closeInlineSourceModal();
  }
}

function updatePopoverPosition() {
  if (!activeInlineSourcePopover || !activeInlineSourcePopover._anchorEl) return;
  const anchorEl = activeInlineSourcePopover._anchorEl;
  const popover = activeInlineSourcePopover;

  const rect = anchorEl.getBoundingClientRect();
  const popoverWidth = Math.min(460, window.innerWidth - 32);
  popover.style.width = `${popoverWidth}px`;

  // Center horizontally over anchor button
  let left = rect.left + (rect.width / 2) - (popoverWidth / 2);
  const margin = 16;
  if (left < margin) left = margin;
  if (left + popoverWidth > window.innerWidth - margin) {
    left = window.innerWidth - margin - popoverWidth;
  }

  const popoverHeight = popover.offsetHeight || 220;
  // Position above the anchor button
  let top = rect.top - popoverHeight - 12;
  let isAbove = true;

  if (top < margin) {
    // If not enough room above viewport, flip to below
    top = rect.bottom + 12;
    isAbove = false;
  }

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;

  const arrow = popover.querySelector('.popover-arrow');
  if (arrow) {
    const arrowLeft = Math.max(20, Math.min(popoverWidth - 28, rect.left + (rect.width / 2) - left));
    arrow.style.left = `${Math.round(arrowLeft)}px`;
    arrow.className = `popover-arrow ${isAbove ? 'arrow-down' : 'arrow-up'}`;
  }
}

// Small card shown when a citation marker is clicked: the source's number and name, the
// passage relied on, and a button that opens the source at that passage.
function openInlineSourceModal(anchorEl, source, claim) {
  if (activeInlineSourcePopover && activeInlineSourcePopover._anchorEl === anchorEl) {
    closeInlineSourceModal();
    return;
  }
  closeInlineSourceModal();
  if (!source) return;

  const passage = bestPassageFor(source, claim);
  const preview = focusedExcerpt(passage, claim);
  const detail = sourceDetailLine(source);
  const sourceUrl = getSourceViewerUrl(source, claim);

  const popover = document.createElement('div');
  popover.id = 'inlineSourceModalPopover';
  popover.className = 'inline-source-popover';
  popover._anchorEl = anchorEl;
  popover.innerHTML = `
    <div class="popover-arrow"></div>
    <div class="popover-header">
      <div class="popover-header-title">
        <span class="source-number">${escapeHTML(source.number)}</span>
        <span class="source-type-chip">${escapeHTML(sourceTypeLabel(source))}</span>
      </div>
      <button type="button" class="popover-close-btn" aria-label="Close">&times;</button>
    </div>
    <div class="popover-body">
      <div class="popover-item-title">${escapeHTML(source.title || `Source ${source.number}`)}</div>
      ${detail ? `<div class="source-detail-line">${escapeHTML(detail)}</div>` : ''}
      ${preview ? `<div class="popover-item-excerpt">“${escapeHTML(preview)}”</div>` : ''}
      ${sourceUrl ? `<a href="${escapeHTML(sourceUrl)}" target="_blank" rel="noopener" class="popover-open-btn source-open-btn">Open source at this passage</a>` : ''}
    </div>
  `;

  document.body.appendChild(popover);
  activeInlineSourcePopover = popover;
  updatePopoverPosition();

  const closeBtn = popover.querySelector('.popover-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeInlineSourceModal();
    });
  }

  setTimeout(() => {
    document.addEventListener('click', handleOutsidePopoverClick);
    document.addEventListener('keydown', handlePopoverKeydown);
    window.addEventListener('resize', updatePopoverPosition);
    window.addEventListener('scroll', handleChatWindowScroll, true);
  }, 10);
}

function openUserFeedbackModal(message) {
  let modalOverlay = document.getElementById('userFeedbackModalOverlay');
  if (!modalOverlay) {
    modalOverlay = document.createElement('div');
    modalOverlay.id = 'userFeedbackModalOverlay';
    modalOverlay.className = 'dialog-overlay feedback-modal-overlay';
    document.body.appendChild(modalOverlay);
  }

  // Find user question corresponding to this assistant message
  const session = getCurrentSession();
  const messages = session ? getMessagesForSession(session.session_id) : [];
  const msgIdx = messages.findIndex(m => m.message_id === message.message_id);
  let userQuestion = 'No question available';
  if (msgIdx > 0 && messages[msgIdx - 1].role === 'user') {
    userQuestion = messages[msgIdx - 1].content || '';
  }

  const chunks = message.metadata && Array.isArray(message.metadata.sources) ? message.metadata.sources : [];

  modalOverlay.innerHTML = `
    <div class="dialog-card feedback-modal-card" style="width: min(560px, 94vw); max-height: 90vh; overflow-y: auto;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
        <h3 class="dialog-title" style="margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">
          <span>💬</span> Submit Response Feedback
        </h3>
        <button type="button" class="action-btn" id="closeFeedbackModalBtn" style="font-size: 1.2rem; cursor: pointer;">&times;</button>
      </div>

      <div style="margin-bottom: 12px;">
        <label style="font-size: 0.78rem; font-weight: 700; text-transform: uppercase; color: var(--muted); display: block; margin-bottom: 4px;">User Question:</label>
        <div style="padding: 10px 12px; border-radius: 8px; background: var(--surface-soft); border: 1px solid var(--border); font-size: 0.88rem; font-weight: 600; color: var(--text); max-height: 80px; overflow-y: auto;">
          ${escapeHTML(userQuestion)}
        </div>
      </div>

      <div style="margin-bottom: 12px;">
        <label style="font-size: 0.78rem; font-weight: 700; text-transform: uppercase; color: var(--muted); display: block; margin-bottom: 4px;">Response Preview:</label>
        <div style="padding: 10px 12px; border-radius: 8px; background: var(--surface-soft); border: 1px solid var(--border); font-size: 0.84rem; color: var(--muted); max-height: 100px; overflow-y: auto;">
          ${escapeHTML((message.content || '').slice(0, 300))}${message.content && message.content.length > 300 ? '...' : ''}
        </div>
      </div>

      <div style="margin-bottom: 14px;">
        <label style="font-size: 0.78rem; font-weight: 700; text-transform: uppercase; color: var(--muted); display: block; margin-bottom: 4px;">Cited Sources (${chunks.length}):</label>
        <div style="font-size: 0.8rem; color: var(--muted);">
          ${chunks.length > 0 ? chunks.map((c, i) => `<span style="display: inline-block; padding: 2px 8px; border-radius: 4px; background: var(--surface-soft); border: 1px solid var(--border); margin: 2px 4px 2px 0;">[Source ${i+1}] ${escapeHTML(c.title || c.law_title || c.source_table || 'Document')}</span>`).join('') : 'No cited chunks.'}
        </div>
      </div>

      <div style="margin-bottom: 16px;">
        <label for="feedbackTextInput" style="font-size: 0.78rem; font-weight: 700; text-transform: uppercase; color: var(--muted); display: block; margin-bottom: 4px;">Your Feedback / Notes:</label>
        <textarea id="feedbackTextInput" placeholder="Type your detailed feedback, corrections, or audit comments here..." style="width: 100%; min-height: 100px; padding: 10px; border-radius: 8px; border: 1px solid var(--chat-input-border); background: var(--chat-input-bg); color: var(--text); outline: none; font-size: 0.9rem; resize: vertical;"></textarea>
      </div>

      <div id="feedbackModalNotice" style="margin-bottom: 10px; font-size: 0.85rem; display: none;"></div>

      <div style="display: flex; justify-content: flex-end; gap: 10px;">
        <button type="button" class="dialog-btn secondary" id="cancelFeedbackBtn">Cancel</button>
        <button type="button" class="dialog-btn primary-action" id="submitFeedbackBtn" style="background: var(--primary); color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-weight: 600; cursor: pointer;">Submit Feedback</button>
      </div>
    </div>
  `;

  modalOverlay.removeAttribute('hidden');
  modalOverlay.style.display = 'flex';

  const closeBtn = modalOverlay.querySelector('#closeFeedbackModalBtn');
  const cancelBtn = modalOverlay.querySelector('#cancelFeedbackBtn');
  const submitBtn = modalOverlay.querySelector('#submitFeedbackBtn');
  const noticeEl = modalOverlay.querySelector('#feedbackModalNotice');
  const textInput = modalOverlay.querySelector('#feedbackTextInput');

  const hideModal = () => {
    modalOverlay.style.display = 'none';
    modalOverlay.setAttribute('hidden', 'true');
  };

  if (closeBtn) closeBtn.onclick = hideModal;
  if (cancelBtn) cancelBtn.onclick = hideModal;

  if (submitBtn) {
    submitBtn.onclick = async () => {
      const text = textInput ? textInput.value.trim() : '';
      if (!text) {
        noticeEl.style.display = 'block';
        noticeEl.style.color = '#dc2626';
        noticeEl.textContent = 'Please enter your feedback before submitting.';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';

      try {
        const response = await fetch(`${getApiBaseUrl()}/api/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: userQuestion,
            answer: message.content || '',
            chunks: chunks,
            feedback: text,
            sessionId: message.session_id || currentSessionId
          })
        });

        const data = await response.json();
        if (data.success) {
          noticeEl.style.display = 'block';
          noticeEl.style.color = '#059669';
          noticeEl.textContent = 'Thank you! Your feedback has been saved successfully.';
          setTimeout(() => {
            hideModal();
          }, 1400);
        } else {
          throw new Error(data.error || 'Failed to save feedback');
        }
      } catch (err) {
        noticeEl.style.display = 'block';
        noticeEl.style.color = '#dc2626';
        noticeEl.textContent = err.message || 'Error submitting feedback. Please try again.';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Feedback';
      }
    };
  }

  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) hideModal();
  };
}

const SOURCES_SHOWN_COLLAPSED = 5;

// Numbered source list under an answer: only the sources the answer cites, most relevant
// first. Source n here is the [n] marker in the text.
function renderSourceCitations(container, message) {
  const existing = container.querySelector('.citations-container');
  if (existing) existing.remove();

  const { sources } = getDisplayData(message);
  if (!sources.length) return;

  const panel = document.createElement('div');
  panel.className = 'citations-container sources-panel';
  panel.innerHTML = `
    <div class="sources-panel-header">
      <span class="citations-header-title">Sources (${sources.length})</span>
      <span class="sources-panel-hint">Ranked by relevance</span>
    </div>
    <ol class="sources-list"></ol>
  `;
  const list = panel.querySelector('.sources-list');

  sources.forEach((s, idx) => {
    const number = s.number || idx + 1;
    const excerpt = s.excerpt || '';
    const preview = excerpt.length > 190 ? `${excerpt.slice(0, 190).trim()}…` : excerpt;
    const detail = sourceDetailLine(s);
    const url = getSourceViewerUrl(s);

    const item = document.createElement('li');
    item.className = 'source-row';
    item.id = `source-row-${message.message_id}-${number}`;
    item.dataset.sourceNumber = String(number);
    if (idx >= SOURCES_SHOWN_COLLAPSED) item.classList.add('source-row-extra');
    item.innerHTML = `
      <span class="source-number">${escapeHTML(number)}</span>
      <div class="source-row-main">
        <div class="source-row-title">${escapeHTML(s.title || `Source ${number}`)}</div>
        <div class="source-row-meta">
          <span class="source-type-chip">${escapeHTML(sourceTypeLabel(s))}</span>
          ${detail ? `<span class="source-detail-line">${escapeHTML(detail)}</span>` : ''}
        </div>
        ${preview ? `<div class="source-row-excerpt">${escapeHTML(preview)}</div>` : ''}
      </div>
      ${url ? `<a class="source-open-btn" href="${escapeHTML(url)}" target="_blank" rel="noopener" title="Open this source with the cited passage highlighted">Open</a>` : ''}
    `;
    if (url) {
      item.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        window.open(url, '_blank');
      });
    }
    list.appendChild(item);
  });

  if (sources.length > SOURCES_SHOWN_COLLAPSED) {
    panel.classList.add('is-collapsed');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sources-toggle-btn';
    const setLabel = () => {
      toggle.textContent = panel.classList.contains('is-collapsed')
        ? `Show all ${sources.length} sources`
        : 'Show fewer sources';
    };
    setLabel();
    toggle.addEventListener('click', () => {
      panel.classList.toggle('is-collapsed');
      setLabel();
    });
    panel.appendChild(toggle);
  }

  // The source list sits directly under the answer text, above follow-ups and actions.
  const textContent = container.querySelector('.assistant-text-content');
  if (textContent && textContent.nextSibling) {
    container.insertBefore(panel, textContent.nextSibling);
  } else {
    container.appendChild(panel);
  }

  // Chats saved before the fix can carry a wrong Act name; correct it once it is known.
  correctLegacyLegislationTitles(message).then(changed => {
    if (changed && container.isConnected) renderSourceCitations(container, message);
  });
}


function renderMessageActions(container, message) {
  if (container.querySelector('.message-actions')) {
    return;
  }

  const actionsRow = document.createElement('div');
  actionsRow.className = 'message-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'action-btn';
  copyBtn.setAttribute('data-tooltip', 'Copy text');
  copyBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(getDisplayData(message).content || '').then(() => {
      copyBtn.setAttribute('data-tooltip', 'Copied!');
      copyBtn.classList.add('active');
      setTimeout(() => {
        copyBtn.setAttribute('data-tooltip', 'Copy text');
        copyBtn.classList.remove('active');
      }, 2000);
    });
  });

  const thumbsUpBtn = document.createElement('button');
  thumbsUpBtn.type = 'button';
  thumbsUpBtn.className = 'action-btn';
  if (message.feedback === 'up') {
    thumbsUpBtn.classList.add('active');
  }
  thumbsUpBtn.setAttribute('data-tooltip', 'Helpful');
  thumbsUpBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
    </svg>
  `;

  const thumbsDownBtn = document.createElement('button');
  thumbsDownBtn.type = 'button';
  thumbsDownBtn.className = 'action-btn thumbs-down';
  if (message.feedback === 'down') {
    thumbsDownBtn.classList.add('active');
  }
  thumbsDownBtn.setAttribute('data-tooltip', 'Not helpful');
  thumbsDownBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path>
    </svg>
  `;

  const updateFeedbackUI = (nextFeedback) => {
    const isUp = nextFeedback === 'up';
    const isDown = nextFeedback === 'down';
    thumbsUpBtn.classList.toggle('active', isUp);
    thumbsDownBtn.classList.toggle('active', isDown);
    message.feedback = nextFeedback;
  };

  thumbsUpBtn.addEventListener('click', async () => {
    const previousFeedback = message.feedback;
    const nextFeedback = thumbsUpBtn.classList.contains('active') ? null : 'up';
    updateFeedbackUI(nextFeedback);

    try {
      await sendFeedback(message.session_id, message.message_id, nextFeedback);
    } catch (error) {
      updateFeedbackUI(previousFeedback || null);
      if (window.alert) {
        window.alert('Unable to save your feedback right now.');
      }
    }
  });

  thumbsDownBtn.addEventListener('click', async () => {
    const previousFeedback = message.feedback;
    const nextFeedback = thumbsDownBtn.classList.contains('active') ? null : 'down';
    updateFeedbackUI(nextFeedback);

    try {
      await sendFeedback(message.session_id, message.message_id, nextFeedback);
    } catch (error) {
      updateFeedbackUI(previousFeedback || null);
      if (window.alert) {
        window.alert('Unable to save your feedback right now.');
      }
    }
  });

  const feedbackBtn = document.createElement('button');
  feedbackBtn.type = 'button';
  feedbackBtn.className = 'action-btn feedback-btn';
  feedbackBtn.setAttribute('data-tooltip', 'Submit feedback');
  feedbackBtn.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>
  `;
  feedbackBtn.addEventListener('click', () => {
    openUserFeedbackModal(message);
  });

  actionsRow.appendChild(copyBtn);
  actionsRow.appendChild(thumbsUpBtn);
  actionsRow.appendChild(thumbsDownBtn);
  actionsRow.appendChild(feedbackBtn);

  container.appendChild(actionsRow);

  // Citation markers in the answer text: open a card for that numbered source.
  container.querySelectorAll('.cite-ref').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const number = parseInt(btn.getAttribute('data-source-number'), 10);
      const { sources } = getDisplayData(message);
      const source = sources.find((s, idx) => (s.number || idx + 1) === number);
      if (source) {
        openInlineSourceModal(btn, source, claimTextBefore(btn));
      }
    });
  });
}

function renderMessages() {
  if (!chatWindow) return;
  clearTypingIntervals();

  const session = getCurrentSession();
  const messages = session ? getMessagesForSession(session.session_id) : [];
  chatWindow.innerHTML = '';
  renderConversationTracker(messages);

  messages.forEach(message => {
    const wrapper = document.createElement('div');
    wrapper.className = `message-bubble-wrapper ${message.role === 'user' ? 'user' : 'assistant'}`;
    wrapper.dataset.messageId = message.message_id;
    wrapper.dataset.messageRole = message.role;

    const div = document.createElement('div');
    div.className = message.role === 'user' ? 'user-msg' : 'assistant-msg';
    wrapper.appendChild(div);

    if (message.role === 'assistant') {
      const contentDiv = document.createElement('div');
      contentDiv.className = 'assistant-text-content';
      div.appendChild(contentDiv);

      if (message.metadata?.isThinking) {
        const statusBubble = document.createElement('div');
        statusBubble.className = 'assistant-processing';

        const text = document.createElement('span');
        text.className = 'processing-text';
        text.textContent = cleanLoadingText(message.content || 'Preparing a clear response');

        const dots = document.createElement('span');
        dots.className = 'processing-dots';
        dots.innerHTML = '<span></span><span></span><span></span>';

        statusBubble.appendChild(text); // LIVE TEXT FIRST
        statusBubble.appendChild(dots); // MOVING DOTS AFTER LIVE TEXT
        contentDiv.appendChild(statusBubble);
      } else if (messagesToAnimate.has(message.message_id)) {
        messagesToAnimate.delete(message.message_id); // prevent re-animation
        contentDiv.classList.add('streaming-cursor');

        // Text and sources as displayed: citation markers numbered to match the source list.
        const display = getDisplayData(message);
        const rawText = sanitizeCitations(display.content, display.sources.length);
        let currentLen = 0;
        const typingSpeed = 15; // ms per char

        const interval = setInterval(() => {
          currentLen += 3; // type 3 chars at a time for responsive speed
          if (currentLen >= rawText.length) {
            contentDiv.innerHTML = formatMarkdown(rawText);
            contentDiv.classList.remove('streaming-cursor');
            clearInterval(interval);

            // Render in order: Citations, Follow-up Questions, Message Actions
            renderSourceCitations(div, message);
            renderSuggestedFollowUps(div, message);
            renderMessageActions(div, message);
            scrollToBottom();
          } else {
            contentDiv.innerHTML = formatMarkdown(rawText.slice(0, currentLen));
            scrollToBottom();
          }
        }, typingSpeed);

        activeTypingIntervals.push(interval);
      } else {
        // Display immediately
        const display = getDisplayData(message);
        contentDiv.innerHTML = formatMarkdown(sanitizeCitations(display.content, display.sources.length));
        // Render in order: Citations, Follow-up Questions, Message Actions
        renderSourceCitations(div, message);
        renderSuggestedFollowUps(div, message);
        renderMessageActions(div, message);
      }
    } else {
      const safeContent = escapeHTML(message.content || '');
      div.innerHTML = `<div class="user-message-text">${safeContent}</div>`;

      const attachments = message.metadata && message.metadata.attachments ? message.metadata.attachments : [];
      if (attachments.length) {
        const attachContainer = document.createElement('div');
        attachContainer.className = 'message-attachments';
        attachments.forEach(att => {
          const row = document.createElement('div');
          row.className = 'attachment-row';
          row.innerHTML = `<div class="att-icon">📎</div><div class="file-name">${escapeHTML(att.name)}</div>`;
          attachContainer.appendChild(row);
        });
        div.appendChild(attachContainer);
      }
    }

    const timestampEl = document.createElement('div');
    timestampEl.className = 'message-timestamp';
    timestampEl.textContent = formatMessageTimestamp(message);
    wrapper.appendChild(timestampEl);

    chatWindow.appendChild(wrapper);
  });
  scrollToBottom();
}

function renderSuggestedFollowUps(container, message) {
  const followUps = Array.isArray(message.metadata && message.metadata.follow_up_questions)
    ? message.metadata.follow_up_questions
    : [];
  if (!followUps.length) {
    return;
  }

  const followUpContainer = document.createElement('div');
  followUpContainer.className = 'message-follow-ups';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'follow-up-title';
    titleDiv.textContent = 'Suggested follow-up questions';
    followUpContainer.appendChild(titleDiv);

    const chipsContainer = document.createElement('div');
    chipsContainer.className = 'follow-up-chips-container';
    
    followUps.forEach((q, index) => {
      const chip = document.createElement('button');
      chip.className = 'follow-up-chip';
      chip.innerHTML = `<span class="chip-number">${index + 1}</span><span class="chip-text">${escapeHTML(q)}</span>`;
      chip.addEventListener('click', () => {
        if (!messageInput) return;
        messageInput.value = q;
        resizeTextArea();
        messageInput.focus();
        handleUserSend();
        // Scroll to show new message after a small delay to ensure render
        setTimeout(() => {
          isAutoScrollEnabled = true;
          scrollToBottom();
        }, 100);
      });
      chipsContainer.appendChild(chip);
    });
  followUpContainer.appendChild(chipsContainer);
  container.appendChild(followUpContainer);
}

function updateSessionCounters(session) {
  if (!session) return;
  const messages = getMessagesForSession(session.session_id);
  session.message_count = messages.length;
  session.updated_at = nowISO();
  if (messages.length) {
    session.last_message_at = messages[messages.length - 1].created_at;
  }
}

function addMessage(role, content, metadata) {
  const session = getCurrentSession();
  if (!session) return null;
  const message = createMessage(session.session_id, role, content);
  if (metadata && typeof metadata === 'object') {
    message.metadata = Object.assign(message.metadata || {}, metadata);
  }
  const messages = getMessagesForSession(session.session_id);
  messages.push(message);
  messagesBySession[session.session_id] = messages;
  updateSessionCounters(session);
  renderSessions();
  renderMessages();
  updateWelcomeCard();
  return message;
}

async function addAssistantMessage() {
  const session = getCurrentSession();
  if (!session) return null;

  const assistantMessage = createMessage(
    session.session_id,
    'assistant',
    'Hello! I am CLA, your legal chatbot. I can help you with contract disputes, recovery options, insolvency questions and corporate law guidance.'
  );

  try {
    const savedAssistantMessage = await sendMessageToSession(session.session_id, assistantMessage);
    const messages = getMessagesForSession(session.session_id);
    messages.push(savedAssistantMessage);
    messagesBySession[session.session_id] = messages;
    updateSessionCounters(session);
    renderSessions();
    renderMessages();
    updateWelcomeCard();
    return savedAssistantMessage;
  } catch (error) {
    console.error('Unable to save assistant message', error);
    return null;
  }
}

async function createNewSession() {
  const activeEmptyDraft = currentSessionId && sessions.find(session => session.session_id === currentSessionId && session.isDraft && isEmptyDraftSession(session));
  if (activeEmptyDraft) {
    activeSessionMenuId = null;
    renderSessions();
    renderMessages();
    updateWelcomeCard();
    return;
  }

  discardEmptyDraftSession();

  const session = createDraftSession();
  sessions.unshift(session);
  messagesBySession[session.session_id] = [];
  setCurrentSession(session.session_id);

  activeSessionMenuId = null;
  renderSessions();
  renderMessages();
  updateWelcomeCard();
}

async function selectSession(sessionId) {
  discardEmptyDraftSession(sessionId);
  setCurrentSession(sessionId);

  activeSessionMenuId = null;

  try {
    const messages = await fetchSessionMessages(sessionId);
    messagesBySession[sessionId] = messages;
  } catch (error) {
    console.error('Unable to load session messages', error);
  }

  renderSessions();
  renderMessages();
  updateWelcomeCard();
  
  // Re-enable auto-scroll when switching sessions
  isAutoScrollEnabled = true;
  requestAnimationFrame(() => {
    scrollToBottom();
  });
}

function toggleSessionMenu(sessionId) {
  activeSessionMenuId = activeSessionMenuId === sessionId ? null : sessionId;
  renderSessions();
}

function closeSessionMenu() {
  if (activeSessionMenuId !== null) {
    activeSessionMenuId = null;
    renderSessions();
  }
}

async function persistDraftSessionIfNeeded() {
  const session = getCurrentSession();
  if (!session || !session.isDraft) return session;

  try {
    const persistedSession = await persistSession({
      session_id: session.session_id,
      user_id: session.user_id || getCurrentUserId(),
      title: session.title || 'New chat',
      mode: session.mode || 'chat',
      created_at: session.created_at || nowISO(),
      updated_at: session.updated_at || nowISO(),
      last_message_at: session.last_message_at || nowISO(),
      message_count: session.message_count || 0,
      status: session.status || SESSION_STATUS.ACTIVE,
    });

    const draftMessages = messagesBySession[session.session_id] || [];
    const persistedSessionId = persistedSession.session_id || persistedSession.id || persistedSession._id || session.session_id;
    messagesBySession[persistedSessionId] = draftMessages;
    if (persistedSessionId !== session.session_id) {
      delete messagesBySession[session.session_id];
    }

    const index = sessions.findIndex(item => item.session_id === session.session_id);
    if (index !== -1) {
      sessions[index] = { ...persistedSession, isDraft: false };
    }

    currentSessionId = persistedSessionId;
    return sessions.find(item => item.session_id === persistedSessionId) || null;
  } catch (error) {
    console.error('Unable to persist draft session', error);
    return session;
  }
}

async function handleUserSend() {
  if (!messageInput || isSendingMessage) return;
  const text = messageInput.value.trim();

  if (!text && selectedFiles.length === 0) return;

  if (selectedFiles.some(entry => entry.status === 'uploading')) {
    flashAttachmentNotice('Please wait for the attachment to finish uploading.');
    return;
  }

  isSendingMessage = true;
  setSendButtonState(true);
  activeAbortController = new AbortController();

  const currentSession = getCurrentSession();
  let activeSession = currentSession;
  if (currentSession && currentSession.isDraft) {
    activeSession = await persistDraftSessionIfNeeded();
  }
  if (activeSession) {
    setCurrentSession(activeSession.session_id);
  }

  // Attachment metadata persisted alongside the message (name/size for display in history).
  const attachmentsMeta = selectedFiles.map(entry => ({
    name: entry.file.name,
    size: entry.file.size,
    type: entry.file.type,
    lastModified: entry.file.lastModified,
    key: entry.key,
    status: entry.status
  }));

  // Extracted text sent to the LLM as additional context (not persisted in message history).
  const attachmentsForContext = selectedFiles
    .filter(entry => entry.status === 'ready' && entry.text)
    .map(entry => ({ name: entry.file.name, text: entry.text }));

  // Add the user message locally first and preserve the generated message ID for later persistence.
  const userMsg = addMessage('user', text || '', { attachments: attachmentsMeta });

  // Clear input fields immediately
  messageInput.value = '';
  resizeTextArea();
  selectedFiles = [];
  if (fileUpload) fileUpload.value = '';
  renderAttachmentPreview();

  const thinkingMessageId = 'thinking-' + Date.now();
  const sessionId = currentSessionId;
  const progressRequestId = `req-${generateId()}`;
  const thinkingMsg = {
    message_id: thinkingMessageId,
    session_id: sessionId,
    role: 'assistant',
    content: cleanLoadingText('Preparing your response'),
    created_at: nowISO(),
    metadata: { isThinking: true }
  };

  if (!messagesBySession[sessionId]) {
    messagesBySession[sessionId] = [];
  }
  messagesBySession[sessionId].push(thinkingMsg);
  renderMessages();
  updateWelcomeCard();
  startBackendProgressPolling(sessionId, thinkingMessageId, progressRequestId);

  try {
    const response = await fetch(`${getApiBaseUrl()}/api/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: activeAbortController ? activeAbortController.signal : undefined,
      body: JSON.stringify({ question: text, attachments: attachmentsForContext, requestId: progressRequestId })
    });

    if (!response.ok) {
      throw new Error(`Server returned status ${response.status}`);
    }

    const data = await response.json();
    const answerContent = data.answer || data.response || data.content || '';
    const followUps = Array.isArray(data.follow_up_questions)
      ? data.follow_up_questions
      : (Array.isArray(data.followUpQuestions)
        ? data.followUpQuestions
        : (Array.isArray(data.suggestions)
          ? data.suggestions
          : (Array.isArray(data.followUps)
            ? data.followUps
            : [])));
    const sources = data.sources || data.source || [];
    const evaluation = data.evaluation || data.ragas_evaluation || null;
    const route = data.route || null;
    const searchResults = data.searchResults || data.search_results || [];

    const persistPayload = {
      message_id: userMsg.message_id,
      content: text || '',
      metadata: {
        attachments: attachmentsMeta
      },
      assistantMessage: {
        content: answerContent,
        metadata: {
          follow_up_questions: Array.isArray(followUps) ? followUps : [],
          sources: Array.isArray(sources) ? sources : [],
          citationFormat: data.citationFormat || null,
          query: text || '',
          evaluation,
          route,
          searchResults: Array.isArray(searchResults) ? searchResults : []
        }
      }
    };

    // Render response immediately to user interface
    clearProcessingIndicator();
    messagesBySession[sessionId] = messagesBySession[sessionId].filter(m => m.message_id !== thinkingMessageId);

    const assistantMsgObj = {
      message_id: 'assistant-' + Date.now(),
      session_id: sessionId,
      user_id: getCurrentUserId(),
      role: 'assistant',
      content: answerContent,
      created_at: nowISO(),
      metadata: persistPayload.assistantMessage.metadata
    };

    messagesBySession[sessionId].push(assistantMsgObj);
    messagesToAnimate.add(assistantMsgObj.message_id);
    renderMessages();
    renderSessions();

    // Persist to MongoDB in background without blocking UI rendering
    sendMessageToSession(sessionId, persistPayload).then(saveResult => {
      if (saveResult && saveResult.assistantMessage) {
        // Update local object with persistent backend message_id if available
        assistantMsgObj.message_id = saveResult.assistantMessage.message_id;
      }
      if (saveResult && saveResult.session) {
        const session = getCurrentSession();
        if (session) {
          if (saveResult.session.title) session.title = saveResult.session.title;
          if (saveResult.session.updated_at) session.updated_at = saveResult.session.updated_at;
          if (saveResult.session.last_message_at) session.last_message_at = saveResult.session.last_message_at;
          if (typeof saveResult.session.message_count === 'number') session.message_count = saveResult.session.message_count;
        }
        renderSessions();
      }
    }).catch(err => {
      console.warn('[Chatbot UI] Background message persistence notice:', err);
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('[RAG] Generation request aborted by user.');
      return;
    }
    console.error('Failed to send message:', error);
    clearProcessingIndicator();
    messagesBySession[sessionId] = messagesBySession[sessionId].filter(m => m.message_id !== thinkingMessageId);
    messagesBySession[sessionId].push({
      message_id: 'error-' + Date.now(),
      session_id: sessionId,
      role: 'assistant',
      content: 'I apologize, but I encountered an error while processing your request. Please try again. Error: ' + error.message,
      created_at: nowISO(),
      metadata: { isError: true }
    });
  } finally {
    isSendingMessage = false;
    activeAbortController = null;
    setSendButtonState(false);
    renderSessions();
    renderMessages();
    updateWelcomeCard();
  }
}

function debounceSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(handleSessionSearch, 300);
}

async function handleSessionSearch() {
  sessionSearchQuery = sessionSearchInput?.value.trim() || '';
  if (!sessionSearchQuery) {
    filteredSessionIds = [];
    renderSessions();
    return;
  }

  const query = sessionSearchQuery.toLowerCase();
  filteredSessionIds = sessions.filter(session => {
    if (session.session_id.toLowerCase().includes(query)) return true;
    if (session.title && session.title.toLowerCase().includes(query)) return true;
    const messages = getMessagesForSession(session.session_id);
    return messages.some(message => message.content.toLowerCase().includes(query));
  }).map(session => session.session_id);
  renderSessions();

  const remoteSessionIds = await searchChatSessions(sessionSearchQuery);
  if (remoteSessionIds && remoteSessionIds.length > 0) {
    const merged = new Set([...filteredSessionIds, ...remoteSessionIds]);
    filteredSessionIds = Array.from(merged);
    renderSessions();
  }
}

function resizeTextArea() {
  if (!messageInput) return;
  messageInput.style.height = 'auto';
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

sendBtn?.addEventListener('click', () => {
  if (isSendingMessage) {
    handleStopGenerating();
  } else {
    handleUserSend();
  }
});

messageInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!isSendingMessage) {
      handleUserSend();
    }
  }
});

messageInput?.addEventListener('input', () => {
  resizeTextArea();
});

document.querySelectorAll('.suggestion-btn').forEach(button => {
  button.addEventListener('click', () => {
    if (!messageInput) return;
    messageInput.value = button.textContent.trim();
    resizeTextArea();
    messageInput.focus();
  });
});

newChatButton?.addEventListener('click', () => {
  createNewSession();
});

uploadBtn?.addEventListener('click', () => {
  fileUpload?.click();
});

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB, mirrors backend limit
const SUPPORTED_ATTACHMENT_EXTENSIONS = ['.pdf', '.docx'];

function getFileKey(file) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function isSupportedAttachmentType(file) {
  const lowerName = (file.name || '').toLowerCase();
  return SUPPORTED_ATTACHMENT_EXTENSIONS.some(ext => lowerName.endsWith(ext));
}

function renderAttachmentPreview() {
  const preview = document.getElementById('attachmentPreview');
  if (!preview) return;
  if (selectedFiles.length === 0) {
    preview.style.display = 'none';
    preview.innerHTML = '';
    return;
  }
  const list = document.createElement('div');
  list.className = 'attachment-list';
  selectedFiles.forEach((entry) => {
    const row = document.createElement('div');
    row.className = `attachment-row status-${entry.status}`;
    const statusIcon = entry.status === 'uploading' ? '<div class="att-icon att-spinner" aria-hidden="true"></div>' : '<div class="att-icon">📎</div>';
    const statusText = entry.status === 'error' ? `<div class="file-error">${escapeHTML(entry.error || 'Could not read this file.')}</div>` : '';
    row.innerHTML = `
      ${statusIcon}
      <div class="file-name-wrap">
        <div class="file-name">${escapeHTML(entry.file.name)}</div>
        ${statusText}
      </div>
      <button type="button" class="remove-attachment" data-key="${entry.key}" aria-label="Remove ${escapeHTML(entry.file.name)}">×</button>
    `;
    list.appendChild(row);
  });
  preview.innerHTML = '';
  preview.appendChild(list);
  preview.style.display = 'block';
  preview.querySelectorAll('.remove-attachment').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const key = btn.getAttribute('data-key');
      selectedFiles = selectedFiles.filter(entry => entry.key !== key);
      renderAttachmentPreview();
    });
  });
}

let attachmentNoticeTimeout = null;
function flashAttachmentNotice(message) {
  const preview = document.getElementById('attachmentPreview');
  if (!preview) return;
  let notice = preview.querySelector('.attachment-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.className = 'attachment-notice';
    preview.insertBefore(notice, preview.firstChild);
  }
  notice.textContent = message;
  clearTimeout(attachmentNoticeTimeout);
  attachmentNoticeTimeout = setTimeout(() => notice.remove(), 2500);
}

async function uploadAttachment(entry) {
  const formData = new FormData();
  formData.append('files', entry.file, entry.file.name);

  try {
    const response = await fetch(`${getApiBaseUrl()}/api/attachments/upload`, {
      method: 'POST',
      body: formData
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || 'Upload failed.');
    }
    const result = (data.attachments && data.attachments[0]) || null;
    if (!result || result.status !== 'ready') {
      throw new Error((result && result.error) || 'This file could not be processed.');
    }
    entry.status = 'ready';
    entry.text = result.text;
  } catch (error) {
    entry.status = 'error';
    entry.error = error.message || 'Upload failed. Please try again.';
  }
  renderAttachmentPreview();
}

fileUpload?.addEventListener('change', () => {
  const newFiles = Array.from(fileUpload.files || []);
  if (newFiles.length === 0) return;

  const existingKeys = new Set(selectedFiles.map(entry => entry.key));
  for (const file of newFiles) {
    if (selectedFiles.length >= MAX_ATTACHMENTS) break;
    const key = getFileKey(file);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    if (!isSupportedAttachmentType(file)) {
      selectedFiles.push({ file, key, status: 'error', text: null, error: 'Only PDF and DOCX files are supported.' });
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      selectedFiles.push({ file, key, status: 'error', text: null, error: 'File exceeds the 15MB attachment limit.' });
      continue;
    }

    const entry = { file, key, status: 'uploading', text: null, error: null };
    selectedFiles.push(entry);
    uploadAttachment(entry);
  }

  // reset native input so same files can be selected again
  if (fileUpload) fileUpload.value = '';
  renderAttachmentPreview();
});

sessionSearchInput?.addEventListener('input', () => {
  debounceSearch();
});

document.addEventListener('click', (event) => {
  const clickedMenu = event.target.closest('.session-menu');
  const clickedMoreButton = event.target.closest('.session-more-btn');
  if (activeSessionMenuId && !clickedMenu && !clickedMoreButton) {
    closeSessionMenu();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (activeSessionMenuId) {
      closeSessionMenu();
    } else if (pendingDeleteSessionId) {
      closeDeleteDialog();
    }
  }
});

setupSidebarResizer();

const deleteDialogOverlay = document.getElementById('deleteDialogOverlay');
const deleteDialogTitle = document.getElementById('deleteDialogTitle');
const deleteDialogDescription = document.getElementById('deleteDialogDescription');
const deleteErrorText = document.getElementById('deleteErrorText');
const deleteConfirmBtn = document.getElementById('confirmDeleteBtn');
const deleteCancelBtn = document.getElementById('cancelDeleteBtn');

function openDeleteDialog(sessionId) {
  pendingDeleteSessionId = sessionId;
  activeSessionMenuId = null;
  renderSessions();
  if (deleteDialogOverlay) deleteDialogOverlay.hidden = false;
  if (deleteDialogTitle) deleteDialogTitle.textContent = 'Delete chat?';
  if (deleteDialogDescription) deleteDialogDescription.textContent = 'This chat will be permanently deleted from your chat history.';
  if (deleteErrorText) deleteErrorText.textContent = '';
  if (deleteConfirmBtn) {
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.textContent = 'Delete';
  }
}

function closeDeleteDialog() {
  pendingDeleteSessionId = null;
  if (deleteDialogOverlay) deleteDialogOverlay.hidden = true;
  if (deleteErrorText) deleteErrorText.textContent = '';
  if (deleteConfirmBtn) {
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.textContent = 'Delete';
  }
}

async function deleteSessionFromBackend(sessionId) {
  const debugMode = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (debugMode) {
    console.debug('[deleteSession] sessionId', sessionId);
  }
  const response = await fetch(`${getApiBaseUrl()}/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': getCurrentUserId()
    }
  });
  if (debugMode) {
    console.debug('[deleteSession] status', response.status);
  }
  let payload = {};
  try { payload = await response.json(); } catch (error) { payload = {}; }
  if (!response.ok) {
    throw new Error(payload.error || 'Unable to delete chat right now.');
  }
  return payload;
}

async function removeSessionFromFrontState(sessionId) {
  const sessionIndex = sessions.findIndex(session => session.session_id === sessionId);
  if (sessionIndex === -1) return;
  const remainingSessions = sessions.filter(session => session.session_id !== sessionId);
  delete messagesBySession[sessionId];

  let nextSessions = remainingSessions;
  let nextCurrentSessionId = currentSessionId;

  if (currentSessionId === sessionId) {
    if (remainingSessions.length > 0) {
      const fallbackIndex = Math.min(sessionIndex, remainingSessions.length - 1);
      nextCurrentSessionId = remainingSessions[fallbackIndex].session_id;
    } else {
      const replacement = await persistSession(createSession());
      nextSessions = [replacement];
      nextCurrentSessionId = replacement.session_id;
      messagesBySession[replacement.session_id] = [];
    }
  }

  sessions = nextSessions;
  setCurrentSession(nextCurrentSessionId);

  if (sessionSearchQuery) {
    filteredSessionIds = filteredSessionIds.filter(id => id !== sessionId);
  }
  renderSessions();
  renderMessages();
  updateWelcomeCard();
}

async function handleDeleteConfirm() {
  if (isDeletingSession || !pendingDeleteSessionId) return;
  isDeletingSession = true;
  if (deleteConfirmBtn) {
    deleteConfirmBtn.disabled = true;
    deleteConfirmBtn.textContent = 'Deleting...';
  }
  try {
    await deleteSessionFromBackend(pendingDeleteSessionId);
    await removeSessionFromFrontState(pendingDeleteSessionId);
    closeDeleteDialog();
    activeSessionMenuId = null;
    renderSessions();
  } catch (error) {
    if (deleteErrorText) {
      deleteErrorText.textContent = error.message || 'Unable to delete chat right now.';
    }
  } finally {
    isDeletingSession = false;
    if (deleteConfirmBtn) {
      deleteConfirmBtn.disabled = false;
      deleteConfirmBtn.textContent = 'Delete';
    }
  }
}

deleteCancelBtn?.addEventListener('click', () => {
  closeDeleteDialog();
});

deleteConfirmBtn?.addEventListener('click', () => {
  handleDeleteConfirm();
});
deleteDialogOverlay?.addEventListener('click', (event) => {
  if (event.target === deleteDialogOverlay) {
    closeDeleteDialog();
  }
});

function createSessionFromBackend(sessionData) {
  return {
    session_id: sessionData.session_id || generateId(),
    user_id: sessionData.user_id || getCurrentUserId(),
    title: sessionData.title || 'New chat',
    mode: sessionData.mode || 'chat',
    created_at: sessionData.created_at || nowISO(),
    updated_at: sessionData.updated_at || nowISO(),
    last_message_at: sessionData.last_message_at || nowISO(),
    message_count: sessionData.message_count || 0,
    status: sessionData.status || SESSION_STATUS.ACTIVE,
  };
}

async function fetchChatSessions() {
  isLoadingSessions = true;

  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/chat/sessions`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': getCurrentUserId()
        }
      }
    );

    if (!response.ok) {
      throw new Error('Unable to load chat sessions');
    }

    const data = await response.json();

    return (data.sessions || []).map(
      createSessionFromBackend
    );
  } catch (err) {
    console.error('fetchChatSessions error:', err);
    return [];
  } finally {
    isLoadingSessions = false;
  }
}

async function fetchSessionMessages(sessionId) {
  isLoadingMessages = true;

  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': getCurrentUserId()
        }
      }
    );

    if (!response.ok) {
      throw new Error('Unable to load session messages');
    }

    const data = await response.json();

    return (data.messages || []).map(message => {
      ensureMessageTimestamp(message);
      if (message.role === 'assistant' && message.feedback === undefined) {
        message.feedback = null;
      }
      return message;
    });
  } catch (err) {
    console.error('fetchSessionMessages error:', err);
    return messagesBySession[sessionId] || [];
  } finally {
    isLoadingMessages = false;
  }
}

async function searchChatSessions(query) {
  if (!query || !query.trim()) return [];
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/chat/sessions/search?q=${encodeURIComponent(query.trim())}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': getCurrentUserId()
        }
      }
    );
    if (!response.ok) return [];
    const data = await response.json();
    if (Array.isArray(data.sessions)) {
      data.sessions.forEach(remoteSession => {
        if (!sessions.some(s => s.session_id === remoteSession.session_id)) {
          sessions.push(createSessionFromBackend(remoteSession));
        }
      });
      return data.sessions.map(s => s.session_id);
    }
    return [];
  } catch (err) {
    console.error('searchChatSessions error:', err);
    return [];
  }
}

function exportSessionChat(sessionId) {
  if (!sessionId) return;
  const exportUrl = `${getApiBaseUrl()}/api/chat/sessions/${encodeURIComponent(sessionId)}/export?format=markdown`;
  window.open(exportUrl, '_blank');
}

async function sendFeedback(sessionId, messageId, feedbackType) {
  const response = await fetch(`${getApiBaseUrl()}/api/chat/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': getCurrentUserId()
    },
    body: JSON.stringify({
      session_id: sessionId,
      message_id: messageId,
      feedback: feedbackType
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Failed to save feedback');
  }

  return await response.json().catch(() => ({}));
}

async function sendMessageToSession(sessionId, messagePayload) {
  const response = await fetch(`${getApiBaseUrl()}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': getCurrentUserId(),
    },
    body: JSON.stringify(messagePayload),
  });
  if (!response.ok) {
    throw new Error('Failed to send message');
  }
  return await response.json();
}

async function createChatSession(sessionPayload) {
  const response = await fetch(`${getApiBaseUrl()}/api/chat/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': getCurrentUserId(),
    },
    body: JSON.stringify(sessionPayload),
  });
  if (!response.ok) {
    throw new Error('Failed to create session');
  }
  const payload = await response.json();
  return payload.session || payload;
}

async function initSession() {
  try {
    // Setup auto-scroll listener
    setupAutoScrollListener();
    
    const persistedSessions = await fetchChatSessions();

    if (persistedSessions.length > 0) {
      sessions = persistedSessions;
      const firstSession = persistedSessions[0];
      messagesBySession[firstSession.session_id] = [];
      setCurrentSession(firstSession.session_id);
      await selectSession(firstSession.session_id);
      return;
    }

    await createNewSession();
  } catch (error) {
    console.error('Unable to initialize session state', error);
    const fallbackSession = createSession();
    sessions = [fallbackSession];
    messagesBySession[fallbackSession.session_id] = [];
    setCurrentSession(fallbackSession.session_id);
    renderSessions();
    renderMessages();
    updateWelcomeCard();
  }
}

void initSession();
