const themeToggle = document.getElementById('themeToggle');
const newChatButton = document.getElementById('newChatButton');
const chatWindow = document.getElementById('chatWindow');
const chatList = document.getElementById('chatList');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const uploadBtn = document.getElementById('uploadBtn');
const fileUpload = document.getElementById('fileUpload');
const welcomeCard = document.getElementById('welcomeCard');
const sessionSearchInput = document.getElementById('sessionSearchInput');

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

let activeMode = 'chat'; // 'chat' or 'rag'

function getApiBaseUrl(){
  const configuredBaseUrl = (window.__CLA_API_BASE_URL__ || '').toString().trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, '');
  }

  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  return window.location.origin && window.location.origin !== 'null' ? window.location.origin : 'http://localhost:3000';
}

function getCurrentUserId(){
  let userId = localStorage.getItem('cla-user-id');
  if (!userId) {
    userId = 'user-' + generateId();
    localStorage.setItem('cla-user-id', userId);
  }
  return userId;
}

function getSessionIdentifier(session){
  if(!session || typeof session !== 'object') return null;
  return session.session_id || session.sessionId || session.id || session._id || null;
}

function getSessionOwnerId(session){
  if(!session || typeof session !== 'object') return null;
  return session.user_id || session.userId || session.owner_id || session.created_by || session.email || session.username || null;
}

const SESSION_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived',
};

function generateId(){
  if(window.crypto && typeof window.crypto.randomUUID === 'function'){
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const randomValue = Math.floor(Math.random() * 16);
    const value = character === 'x' ? randomValue : (randomValue & 0x3 | 0x8);
    return value.toString(16);
  });
}

function generateSessionId(){
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(12);
  window.crypto.getRandomValues(bytes);
  const chunks = Array.from({ length: 3 }, (_, index) => {
    const start = index * 4;
    return Array.from(bytes.slice(start, start + 4), (byte) => alphabet[byte % alphabet.length]).join('');
  });
  return `CLA-${chunks.join('-')}`;
}

function nowISO(){
  return new Date().toISOString();
}

let activeTypingIntervals = [];
let messagesToAnimate = new Set();

function clearTypingIntervals() {
  activeTypingIntervals.forEach(clearInterval);
  activeTypingIntervals = [];
}

function createSession({ title, user_id = getCurrentUserId(), status = SESSION_STATUS.ACTIVE } = {}){
  const sessionId = generateSessionId();
  const timestamp = nowISO();
  const defaultTitle = activeMode === 'rag' ? 'New RAG Search' : 'New chat';
  return {
    session_id: sessionId,
    user_id,
    title: title || defaultTitle,
    mode: activeMode,
    created_at: timestamp,
    updated_at: timestamp,
    last_message_at: timestamp,
    message_count: 0,
    status,
  };
}

function createMessage(sessionId, role, content){
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

function normalizePersistedSession(session, fallbackSession){
  return {
    ...fallbackSession,
    ...session,
    session_id: getSessionIdentifier(session) || fallbackSession.session_id,
    user_id: getSessionOwnerId(session) || fallbackSession.user_id,
  };
}

async function persistSession(sessionPayload){
  const persistedSession = await createChatSession(sessionPayload);
  return normalizePersistedSession(persistedSession, sessionPayload);
}

function getCurrentSession(){
  return sessions.find(session => session.session_id === currentSessionId) || null;
}

function getMessagesForSession(sessionId){
  return messagesBySession[sessionId] || [];
}

function setCurrentSession(sessionId){
  currentSessionId = sessionId;
  if(!messagesBySession[sessionId]){
    messagesBySession[sessionId] = [];
  }
}

function applyTheme(theme){
  if(theme === 'dark'){
    document.documentElement.setAttribute('data-theme','dark');
    themeToggle.innerHTML = '☾';
  } else {
    document.documentElement.removeAttribute('data-theme');
    themeToggle.innerHTML = '☀';
  }
}

const savedTheme = localStorage.getItem('cla-theme') || 'light';
applyTheme(savedTheme);

themeToggle?.addEventListener('click', ()=>{
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(current);
  localStorage.setItem('cla-theme', current);
});

function escapeHTML(value){
  return value.replace(/[&<>"]+/g, match => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[match]));
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
  
  // Parse headings (from h6 down to h1)
  html = html.replace(/^\s*###### (.*?)$/gm, '<h6>$1</h6>');
  html = html.replace(/^\s*##### (.*?)$/gm, '<h5>$1</h5>');
  html = html.replace(/^\s*#### (.*?)$/gm, '<h4>$1</h4>');
  html = html.replace(/^\s*### (.*?)$/gm, '<h3>$1</h3>');
  html = html.replace(/^\s*## (.*?)$/gm, '<h2>$1</h2>');
  html = html.replace(/^\s*# (.*?)$/gm, '<h1>$1</h1>');
  
  // Parse lists (unordered)
  html = html.replace(/^\s*[\-\*]\s+(.*?)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*?<\/li>)/gs, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');
  
  // Parse lists (ordered)
  html = html.replace(/^\s*\d+\.\s+(.*?)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*?<\/li>)/gs, '<ol>$1</ol>');
  html = html.replace(/<\/ol>\s*<ol>/g, '');
  
  // Parse bold, italic, code
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/`(.*?)`/g, '<code>$1</code>');
  
  // Parse citation tags: [1] -> superscript link
  html = html.replace(/\[([1-9])\]/g, '<a href="#citation-$1" class="citation-ref-link" data-citation-index="$1">[$1]</a>');
  
  // Handle carriage returns
  html = html.replace(/\n\n/g, '<p></p>');
  html = html.replace(/\n/g, '<br>');
  
  return html;
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

function highlightMatch(text, query){
  if(!query) return escapeHTML(text);
  const normalized = text.toLowerCase();
  const needle = query.toLowerCase();
  const index = normalized.indexOf(needle);
  if(index === -1) return escapeHTML(text);
  const before = escapeHTML(text.slice(0, index));
  const match = escapeHTML(text.slice(index, index + needle.length));
  const after = escapeHTML(text.slice(index + needle.length));
  return `${before}<mark>${match}</mark>${after}`;
}

function scrollToBottom(){
  if(!chatWindow) return;
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function truncateTitle(text){
  return text.length > 40 ? text.slice(0, 40) + '...' : text;
}

function ensureSessionMenuPortal(){
  if(sessionMenuPortal) return sessionMenuPortal;
  sessionMenuPortal = document.createElement('div');
  sessionMenuPortal.id = 'sessionMenuPortal';
  sessionMenuPortal.className = 'session-menu-portal';
  document.body.appendChild(sessionMenuPortal);
  return sessionMenuPortal;
}

function renderSessionMenuPortal(){
  const portal = ensureSessionMenuPortal();
  portal.innerHTML = '';
  if(activeSessionMenuId === null) return;

  const session = sessions.find(item => item.session_id === activeSessionMenuId);
  if(!session) {
    activeSessionMenuId = null;
    return;
  }

  const trigger = document.querySelector(`.session-more-btn[data-session-id="${CSS.escape(activeSessionMenuId)}"]`);
  if(!trigger) {
    activeSessionMenuId = null;
    return;
  }

  const rect = trigger.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'session-menu';
  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'session-menu-item';
  deleteBtn.innerHTML = `
    <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M9 3h6a1 1 0 0 1 1 1v1h4a1 1 0 1 1 0 2h-1v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6H5a1 1 0 1 1 0-2h4V4a1 1 0 0 1 1-1Zm2 4h2v10h-2V7Zm-3 0h2v10H8V7Zm7 0h-2v10h2V7Z"></path>
    </svg>
    <span>Delete chat</span>
  `;
  deleteBtn.addEventListener('click', (event)=>{
    event.stopPropagation();
    openDeleteDialog(session.session_id);
  });
  menu.appendChild(deleteBtn);
  portal.appendChild(menu);

  requestAnimationFrame(() => {
    const menuRect = menu.getBoundingClientRect();
    let top = rect.bottom + 6;
    let left = rect.right - menuRect.width;
    if(top + menuRect.height > window.innerHeight - 8){
      top = rect.top - menuRect.height - 6;
    }
    if(top < 8){ top = 8; }
    left = Math.min(window.innerWidth - menuRect.width - 8, Math.max(8, left));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
  });
}

function renderSessions(){
  if(!chatList) return;
  const visibleSessions = sessionSearchQuery ? filteredSessionIds : sessions.map(session => session.session_id);
  chatList.innerHTML = '';
  visibleSessions.forEach(sessionId => {
    const session = sessions.find(item => item.session_id === sessionId);
    if(!session) return;
    const row = document.createElement('div');
    row.className = 'session-item-row';
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chat-item' + (session.session_id === currentSessionId ? ' active' : '');
    item.innerHTML = highlightMatch(session.title || 'New chat', sessionSearchQuery);
    item.addEventListener('click', ()=> selectSession(session.session_id));
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'session-more-btn';
    moreBtn.dataset.sessionId = session.session_id;
    moreBtn.innerHTML = '<img src="../assets/Images/more.png" alt="More options" class="session-more-icon">';
    moreBtn.addEventListener('click', (event)=>{
      event.stopPropagation();
      toggleSessionMenu(session.session_id);
    });
    row.appendChild(item);
    row.appendChild(moreBtn);
    chatList.appendChild(row);
  });
  renderSessionMenuPortal();
}

function updateWelcomeCard(){
  if(!welcomeCard) return;

  const welcomeTitleEl = welcomeCard.querySelector('.welcome-title');
  const welcomeSubtitleEl = welcomeCard.querySelector('.welcome-subtitle');

  if (activeMode === 'rag') {
    if (welcomeTitleEl) welcomeTitleEl.textContent = 'Ask Legal RAG AI';
    if (welcomeSubtitleEl) welcomeSubtitleEl.textContent = 'Search the legal database with hybrid vector & keyword retrieval. Answers are strictly grounded in Articles with source citations.';
  } else {
    if (welcomeTitleEl) welcomeTitleEl.textContent = 'Ask Legal AI';
    if (welcomeSubtitleEl) welcomeSubtitleEl.textContent = 'Your corporate legal assistant. Ask about company law, case law, circulars, articles and more.';
  }

  const session = getCurrentSession();
  const messages = session ? getMessagesForSession(session.session_id) : [];
  const chatShell = document.querySelector('.chat-window-shell');

  const showWelcome = messages.length === 0;
  welcomeCard.style.display = showWelcome ? 'block' : 'none';

  if(chatShell){
    chatShell.style.display = showWelcome ? 'none' : '';
  }
}

function renderCitationsAndActions(container, message) {
  if (container.querySelector('.citations-breadcrumbs') || container.querySelector('.message-actions')) {
    return;
  }
  
  const sources = message.metadata && message.metadata.sources ? message.metadata.sources : [];
  
  // Render breadcrumbs and citation cards
  if (sources.length > 0) {
    const activeTheme = document.documentElement.getAttribute('data-theme') || 'light';
    
    // Render breadcrumb chain only if multiple sources exist
    if (sources.length > 1) {
      const breadcrumbsRow = document.createElement('div');
      breadcrumbsRow.className = 'citations-breadcrumbs';
      
      sources.forEach((s, idx) => {
        if (idx > 0) {
          const separator = document.createElement('span');
          separator.className = 'citation-breadcrumb-separator';
          separator.innerHTML = ' &gt; ';
          breadcrumbsRow.appendChild(separator);
        }

        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'citation-breadcrumb-item-chain';
        pill.innerHTML = `source ${idx + 1}`;
        pill.title = s.title || 'Untitled Source';
        
        pill.addEventListener('click', () => {
          const cardEl = container.querySelector(`#citation-card-${message.message_id}-${idx}`);
          if (cardEl) {
            cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            cardEl.classList.remove('highlight');
            void cardEl.offsetWidth; // trigger reflow
            cardEl.classList.add('highlight');
          }
        });
        breadcrumbsRow.appendChild(pill);
      });
      container.appendChild(breadcrumbsRow);
    }

    const citationsContainer = document.createElement('div');
    citationsContainer.className = 'citations-container';
    citationsContainer.innerHTML = `<div class="citations-header-title">Source Citations (${sources.length})</div>`;
    
    sources.forEach((s, idx) => {
      const sourceNum = idx + 1;
      
      // Citation Card
      const card = document.createElement('div');
      card.className = 'citation-card';
      card.id = `citation-card-${message.message_id}-${idx}`;
      
      let detailsHtml = '';
      if (s.author) detailsHtml += `<span><strong>Author:</strong> ${escapeHTML(s.author)}</span>`;
      if (s.filename) detailsHtml += `<span><strong>File:</strong> ${escapeHTML(s.filename)}</span>`;
      if (s.sections) detailsHtml += `<span><strong>Sections:</strong> ${escapeHTML(s.sections)}</span>`;
      if (s.subject) detailsHtml += `<span><strong>Subject:</strong> ${escapeHTML(s.subject)}</span>`;
      if (s.doc_date) {
        try {
          const formattedDate = new Date(s.doc_date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
          detailsHtml += `<span><strong>Date:</strong> ${formattedDate}</span>`;
        } catch (e) {
          detailsHtml += `<span><strong>Date:</strong> ${escapeHTML(s.doc_date)}</span>`;
        }
      }
      
      let openLinkHtml = '';
      if (s.source_table && s.record_id) {
        const parentParam = s.parent_id ? `&parentId=${encodeURIComponent(s.parent_id)}` : '';
        openLinkHtml = `<a href="${getApiBaseUrl()}/api/citation?sourceTable=${encodeURIComponent(s.source_table)}&recordId=${encodeURIComponent(s.record_id)}${parentParam}&theme=${activeTheme}" target="_blank" class="open-citation-btn"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" style="vertical-align: middle; margin-right: 3px;"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>Open Citation</a>`;
      }
      
      card.innerHTML = `
        <div class="citation-card-top-row">
          <span class="citation-badge">Source [${sourceNum}] - ${escapeHTML(s.source_table || 'Article')}</span>
          ${openLinkHtml}
        </div>
        <div class="citation-title">${escapeHTML(s.title || 'Untitled Document')}</div>
        ${detailsHtml ? `<div class="citation-details">${detailsHtml}</div>` : ''}
      `;
      
      citationsContainer.appendChild(card);
    });
    
    container.appendChild(citationsContainer);
  }
  
  // Feedback Action Buttons (Copy, Helpful, Not Helpful)
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
    navigator.clipboard.writeText(message.content || '').then(() => {
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
  
  thumbsUpBtn.addEventListener('click', () => {
    const isActive = thumbsUpBtn.classList.toggle('active');
    thumbsDownBtn.classList.remove('active');
    sendFeedback(message.session_id, message.message_id, isActive ? 'up' : 'none');
    message.feedback = isActive ? 'up' : 'none';
  });
  
  thumbsDownBtn.addEventListener('click', () => {
    const isActive = thumbsDownBtn.classList.toggle('active');
    thumbsUpBtn.classList.remove('active');
    sendFeedback(message.session_id, message.message_id, isActive ? 'down' : 'none');
    message.feedback = isActive ? 'down' : 'none';
  });
  
  actionsRow.appendChild(copyBtn);
  actionsRow.appendChild(thumbsUpBtn);
  actionsRow.appendChild(thumbsDownBtn);
  
  container.appendChild(actionsRow);

  // Setup click listeners for inline superscript citation links in the text
  container.querySelectorAll('.citation-ref-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const index = parseInt(link.getAttribute('data-citation-index'), 10) - 1;
      const cardEl = container.querySelector(`#citation-card-${message.message_id}-${index}`);
      if (cardEl) {
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        cardEl.classList.remove('highlight');
        void cardEl.offsetWidth; // trigger reflow
        cardEl.classList.add('highlight');
      }
    });
  });
}

function renderMessages(){
  if(!chatWindow) return;
  clearTypingIntervals();
  
  const session = getCurrentSession();
  const messages = session ? getMessagesForSession(session.session_id) : [];
  chatWindow.innerHTML = '';
  
  messages.forEach(message => {
    const wrapper = document.createElement('div');
    wrapper.className = 'message-bubble-wrapper';

    const div = document.createElement('div');
    div.className = message.role === 'user' ? 'user-msg' : 'assistant-msg';
    wrapper.appendChild(div);

    if(message.role === 'assistant'){
      const titleText = activeMode === 'rag' ? 'CLA Legal RAG Search' : 'CLA Online Legal Chatbot';
      const titleDiv = document.createElement('div');
      titleDiv.className = 'msg-title';
      titleDiv.textContent = titleText;
      div.appendChild(titleDiv);

      const contentDiv = document.createElement('div');
      contentDiv.className = 'assistant-text-content';
      div.appendChild(contentDiv);

      // Check if we need to animate/stream this message
      if (messagesToAnimate.has(message.message_id)) {
        messagesToAnimate.delete(message.message_id); // prevent re-animation
        contentDiv.classList.add('streaming-cursor');
        
        const rawText = message.content || '';
        let currentLen = 0;
        const typingSpeed = 15; // ms per char
        
        const interval = setInterval(() => {
          currentLen += 3; // type 3 chars at a time for responsive speed
          if (currentLen >= rawText.length) {
            contentDiv.innerHTML = formatMarkdown(rawText);
            contentDiv.classList.remove('streaming-cursor');
            clearInterval(interval);
            
            renderCitationsAndActions(div, message);
            
            // Render suggested follow-ups after typing finishes
            renderSuggestedFollowUps(div, message);
            scrollToBottom();
          } else {
            contentDiv.innerHTML = formatMarkdown(rawText.slice(0, currentLen));
            scrollToBottom();
          }
        }, typingSpeed);
        
        activeTypingIntervals.push(interval);
      } else {
        // Display immediately
        contentDiv.innerHTML = formatMarkdown(message.content || '');
        renderCitationsAndActions(div, message);
        renderSuggestedFollowUps(div, message);
      }
    } else {
      const safeContent = escapeHTML(message.content || '');
      div.innerHTML = `<div class="user-message-text">${safeContent}</div>`;
      
      const attachments = message.metadata && message.metadata.attachments ? message.metadata.attachments : [];
      if(attachments.length){
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
    chatWindow.appendChild(wrapper);
  });
  scrollToBottom();
}

function renderSuggestedFollowUps(container, message) {
  const followUps = message.metadata && message.metadata.follow_up_questions ? message.metadata.follow_up_questions : [];
  if(followUps.length){
    const followUpContainer = document.createElement('div');
    followUpContainer.className = 'message-follow-ups';
    
    const titleDiv = document.createElement('div');
    titleDiv.className = 'follow-up-title';
    titleDiv.textContent = 'Suggested follow-up questions:';
    followUpContainer.appendChild(titleDiv);
    
    followUps.forEach(q => {
      const btn = document.createElement('button');
      btn.className = 'follow-up-btn';
      btn.textContent = q;
      btn.addEventListener('click', () => {
        if(!messageInput) return;
        messageInput.value = q;
        resizeTextArea();
        messageInput.focus();
        handleUserSend();
      });
      followUpContainer.appendChild(btn);
    });
    container.appendChild(followUpContainer);
  }
}

function updateSessionCounters(session){
  if(!session) return;
  const messages = getMessagesForSession(session.session_id);
  session.message_count = messages.length;
  session.updated_at = nowISO();
  if(messages.length){
    session.last_message_at = messages[messages.length - 1].created_at;
  }
}

function addMessage(role, content, metadata){
  const session = getCurrentSession();
  if(!session) return null;
  const message = createMessage(session.session_id, role, content);
  if(metadata && typeof metadata === 'object'){
    message.metadata = Object.assign(message.metadata || {}, metadata);
  }
  const messages = getMessagesForSession(session.session_id);
  messages.push(message);
  messagesBySession[session.session_id] = messages;
  updateSessionCounters(session);
  if(role === 'user' && (!session.title || session.title === 'New chat')){
    session.title = truncateTitle(content);
  }
  renderSessions();
  renderMessages();
  updateWelcomeCard();
  return message;
}

async function addAssistantMessage(){
  const session = getCurrentSession();
  if(!session) return null;

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

async function createNewSession(){
  const session = createSession();
  try {
    const resolvedSession = await persistSession(session);
    sessions.unshift(resolvedSession);
    messagesBySession[resolvedSession.session_id] = [];
    setCurrentSession(resolvedSession.session_id);
  } catch (error) {
    sessions.unshift(session);
    messagesBySession[session.session_id] = [];
    setCurrentSession(session.session_id);
    console.error('Unable to persist new chat session', error);
  }
  activeSessionMenuId = null;
  renderSessions();
  renderMessages();
  updateWelcomeCard();
}

async function selectSession(sessionId){
  setCurrentSession(sessionId);

  activeSessionMenuId = null;

  try {
    const messages = await fetchSessionMessages(sessionId);
    messagesBySession[sessionId] = messages;
  } catch(error) {
    console.error('Unable to load session messages', error);
  }

  renderSessions();
  renderMessages();
  updateWelcomeCard();
}

function toggleSessionMenu(sessionId){
  activeSessionMenuId = activeSessionMenuId === sessionId ? null : sessionId;
  renderSessions();
}

function closeSessionMenu(){
  if(activeSessionMenuId !== null){
    activeSessionMenuId = null;
    renderSessions();
  }
}

async function handleUserSend(){
  if(!messageInput || isSendingMessage) return;
  const text = messageInput.value.trim();

  if(!text && selectedFiles.length === 0) return;
  
  isSendingMessage = true;
  
  // prepare attachments metadata
  const attachmentsMeta = selectedFiles.length ? selectedFiles.map(f => ({
    name: f.name,
    size: f.size,
    type: f.type,
    lastModified: f.lastModified,
    key: `${f.name}-${f.size}-${f.lastModified}`
  })) : [];

  // Add the user message locally first
  const userMsg = addMessage('user', text || '', { attachments: attachmentsMeta });
  
  // Clear input fields immediately
  messageInput.value = '';
  resizeTextArea();
  selectedFiles = [];
  if(fileUpload) fileUpload.value = '';
  renderAttachmentPreview();

  // Add a temporary thinking message to show loading state
  const thinkingMessageId = 'thinking-' + Date.now();
  const sessionId = currentSessionId;
  const thinkingText = activeMode === 'rag' 
    ? 'CLA is searching the legal database and generating a grounded answer...'
    : 'CLA is analyzing your query and generating a response...';

  const thinkingMsg = {
    message_id: thinkingMessageId,
    session_id: sessionId,
    role: 'assistant',
    content: thinkingText,
    created_at: nowISO(),
    metadata: { isThinking: true }
  };
  
  if (!messagesBySession[sessionId]) {
    messagesBySession[sessionId] = [];
  }
  messagesBySession[sessionId].push(thinkingMsg);
  renderMessages();
  updateWelcomeCard();

  try {
    const payload = {
      content: text || '',
      metadata: { attachments: attachmentsMeta }
    };
    
    // Call the backend API to generate response using the agent flow
    const result = await sendMessageToSession(sessionId, payload);
    
    // Remove the thinking message
    messagesBySession[sessionId] = messagesBySession[sessionId].filter(m => m.message_id !== thinkingMessageId);
    
    // Push the finalized messages from backend
    if (result.userMessage) {
      messagesBySession[sessionId] = messagesBySession[sessionId].filter(m => m.message_id !== userMsg.message_id);
      messagesBySession[sessionId].push(result.userMessage);
    }
    if (result.assistantMessage) {
      messagesBySession[sessionId].push(result.assistantMessage);
      // Mark assistant response to animate/type it out
      messagesToAnimate.add(result.assistantMessage.message_id);
    }
    
    // Update session info from database
    const session = getCurrentSession();
    if (session) {
      session.message_count = messagesBySession[sessionId].length;
      session.updated_at = nowISO();
      const defaultTitle = activeMode === 'rag' ? 'New RAG Search' : 'New chat';
      if (result.assistantMessage && (!session.title || session.title === defaultTitle || session.title === 'New chat')) {
        session.title = truncateTitle(text);
      }
    }
  } catch (error) {
    console.error('Failed to send message:', error);
    // Replace thinking message with error description
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
    renderSessions();
    renderMessages();
    updateWelcomeCard();
  }
}

function debounceSearch(){
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(handleSessionSearch, 300);
}

function handleSessionSearch(){
  sessionSearchQuery = sessionSearchInput?.value.trim() || '';
  if(!sessionSearchQuery){
    filteredSessionIds = [];
    renderSessions();
    return;
  }

  const query = sessionSearchQuery.toLowerCase();
  filteredSessionIds = sessions.filter(session => {
    if(session.session_id.toLowerCase().includes(query)) return true;
    if(session.title && session.title.toLowerCase().includes(query)) return true;
    const messages = getMessagesForSession(session.session_id);
    return messages.some(message => message.content.toLowerCase().includes(query));
  }).map(session => session.session_id);
  renderSessions();
}

function resizeTextArea(){
  if(!messageInput) return;
  messageInput.style.height = 'auto';
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

sendBtn?.addEventListener('click', ()=>{
  handleUserSend();
});

messageInput?.addEventListener('keydown', event => {
  if(event.key === 'Enter' && !event.shiftKey){
    event.preventDefault();
    handleUserSend();
  }
});

messageInput?.addEventListener('input', ()=>{
  resizeTextArea();
});

document.querySelectorAll('.suggestion-btn').forEach(button => {
  button.addEventListener('click', () => {
    if(!messageInput) return;
    messageInput.value = button.textContent.trim();
    resizeTextArea();
    messageInput.focus();
  });
});

newChatButton?.addEventListener('click', ()=>{
  createNewSession();
});

uploadBtn?.addEventListener('click', ()=>{
  fileUpload?.click();
});

const chatModeTab = document.getElementById('chatModeTab');
const ragModeTab = document.getElementById('ragModeTab');

chatModeTab?.addEventListener('click', (e) => {
  e.preventDefault();
  if (activeMode === 'chat') return;
  activeMode = 'chat';
  chatModeTab.classList.add('active');
  ragModeTab.classList.remove('active');
  
  // Set title back
  const pageTitle = document.querySelector('.chat-page-title');
  if (pageTitle) pageTitle.textContent = 'CLA Legal Chatbot';
  
  // Reload sessions for chat mode
  initSession();
});

ragModeTab?.addEventListener('click', (e) => {
  e.preventDefault();
  if (activeMode === 'rag') return;
  activeMode = 'rag';
  ragModeTab.classList.add('active');
  chatModeTab.classList.remove('active');
  
  // Set title to RAG
  const pageTitle = document.querySelector('.chat-page-title');
  if (pageTitle) pageTitle.textContent = 'CLA Legal RAG Search';
  
  // Reload sessions for RAG mode
  initSession();
});

function getFileKey(file){
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function renderAttachmentPreview(){
  const preview = document.getElementById('attachmentPreview');
  if(!preview) return;
  if(selectedFiles.length === 0){
    preview.style.display = 'none';
    preview.innerHTML = '';
    return;
  }
  // render compact list
  const list = document.createElement('div');
  list.className = 'attachment-list';
  selectedFiles.forEach((file)=>{
    const row = document.createElement('div');
    row.className = 'attachment-row';
    row.innerHTML = `
      <div class="att-icon">📎</div>
      <div class="file-name">${escapeHTML(file.name)}</div>
      <button type="button" class="remove-attachment" data-key="${getFileKey(file)}" aria-label="Remove">×</button>
    `;
    list.appendChild(row);
  });
  preview.innerHTML = '';
  preview.appendChild(list);
  preview.style.display = 'block';
  // attach handlers for remove buttons
  preview.querySelectorAll('.remove-attachment').forEach(btn => {
    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      const key = btn.getAttribute('data-key');
      selectedFiles = selectedFiles.filter(f => getFileKey(f) !== key);
      renderAttachmentPreview();
    });
  });
}

fileUpload?.addEventListener('change', ()=>{
  const newFiles = Array.from(fileUpload.files || []);
  if(newFiles.length === 0) return;
  // merge with selectedFiles, avoid duplicates, limit to 10
  const existingKeys = new Set(selectedFiles.map(f => getFileKey(f)));
  for(const f of newFiles){
    if(selectedFiles.length >= 10) break; // max limit
    const key = getFileKey(f);
    if(existingKeys.has(key)) continue;
    selectedFiles.push(f);
    existingKeys.add(key);
  }
  // reset native input so same files can be selected again
  if(fileUpload) fileUpload.value = '';
  renderAttachmentPreview();
});

sessionSearchInput?.addEventListener('input', ()=>{
  debounceSearch();
});

document.addEventListener('click', (event)=>{
  const clickedMenu = event.target.closest('.session-menu');
  const clickedMoreButton = event.target.closest('.session-more-btn');
  if(activeSessionMenuId && !clickedMenu && !clickedMoreButton){
    closeSessionMenu();
  }
});

document.addEventListener('keydown', (event)=>{
  if(event.key === 'Escape'){
    if(activeSessionMenuId){
      closeSessionMenu();
    } else if(pendingDeleteSessionId){
      closeDeleteDialog();
    }
  }
});

const deleteDialogOverlay = document.getElementById('deleteDialogOverlay');
const deleteDialogTitle = document.getElementById('deleteDialogTitle');
const deleteDialogDescription = document.getElementById('deleteDialogDescription');
const deleteErrorText = document.getElementById('deleteErrorText');
const deleteConfirmBtn = document.getElementById('confirmDeleteBtn');
const deleteCancelBtn = document.getElementById('cancelDeleteBtn');

function openDeleteDialog(sessionId){
  pendingDeleteSessionId = sessionId;
  activeSessionMenuId = null;
  renderSessions();
  if(deleteDialogOverlay) deleteDialogOverlay.hidden = false;
  if(deleteDialogTitle) deleteDialogTitle.textContent = 'Delete chat?';
  if(deleteDialogDescription) deleteDialogDescription.textContent = 'This chat will be permanently deleted from your chat history.';
  if(deleteErrorText) deleteErrorText.textContent = '';
  if(deleteConfirmBtn){
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.textContent = 'Delete';
  }
}

function closeDeleteDialog(){
  pendingDeleteSessionId = null;
  if(deleteDialogOverlay) deleteDialogOverlay.hidden = true;
  if(deleteErrorText) deleteErrorText.textContent = '';
  if(deleteConfirmBtn){
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.textContent = 'Delete';
  }
}

async function deleteSessionFromBackend(sessionId){
  const debugMode = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if(debugMode){
    console.debug('[deleteSession] sessionId', sessionId);
  }
  const response = await fetch(`${getApiBaseUrl()}/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': getCurrentUserId()
    }
  });
  if(debugMode){
    console.debug('[deleteSession] status', response.status);
  }
  let payload = {};
  try { payload = await response.json(); } catch (error) { payload = {}; }
  if(!response.ok){
    throw new Error(payload.error || 'Unable to delete chat right now.');
  }
  return payload;
}

async function removeSessionFromFrontState(sessionId){
  const sessionIndex = sessions.findIndex(session => session.session_id === sessionId);
  if(sessionIndex === -1) return;
  const remainingSessions = sessions.filter(session => session.session_id !== sessionId);
  delete messagesBySession[sessionId];

  let nextSessions = remainingSessions;
  let nextCurrentSessionId = currentSessionId;

  if(currentSessionId === sessionId){
    if(remainingSessions.length > 0){
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

  if(sessionSearchQuery){
    filteredSessionIds = filteredSessionIds.filter(id => id !== sessionId);
  }
  renderSessions();
  renderMessages();
  updateWelcomeCard();
}

async function handleDeleteConfirm(){
  if(isDeletingSession || !pendingDeleteSessionId) return;
  isDeletingSession = true;
  if(deleteConfirmBtn){
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
    if(deleteErrorText){
      deleteErrorText.textContent = error.message || 'Unable to delete chat right now.';
    }
  } finally {
    isDeletingSession = false;
    if(deleteConfirmBtn){
      deleteConfirmBtn.disabled = false;
      deleteConfirmBtn.textContent = 'Delete';
    }
  }
}

deleteCancelBtn?.addEventListener('click', ()=>{
  closeDeleteDialog();
});

deleteConfirmBtn?.addEventListener('click', ()=>{
  handleDeleteConfirm();
});
deleteDialogOverlay?.addEventListener('click', (event)=>{
  if(event.target === deleteDialogOverlay){
    closeDeleteDialog();
  }
});

function createSessionFromBackend(sessionData){
  return {
    session_id: sessionData.session_id || generateId(),
    user_id: sessionData.user_id || getCurrentUserId(),
    title: sessionData.title || (sessionData.mode === 'rag' ? 'New RAG Search' : 'New chat'),
    mode: sessionData.mode || 'chat',
    created_at: sessionData.created_at || nowISO(),
    updated_at: sessionData.updated_at || nowISO(),
    last_message_at: sessionData.last_message_at || nowISO(),
    message_count: sessionData.message_count || 0,
    status: sessionData.status || SESSION_STATUS.ACTIVE,
  };
}

async function fetchChatSessions(){
  isLoadingSessions = true;

  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/chat/sessions?mode=${activeMode}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': getCurrentUserId()
        }
      }
    );

    if(!response.ok){
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

async function fetchSessionMessages(sessionId){
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

    if(!response.ok){
      throw new Error('Unable to load session messages');
    }

    const data = await response.json();

    return data.messages || [];
  } catch (err) {
    console.error('fetchSessionMessages error:', err);
    return messagesBySession[sessionId] || [];
  } finally {
    isLoadingMessages = false;
  }
}

async function searchChatSessions(query){
  // TODO: replace with API call to GET /api/chat/sessions/search?q=
  return [];
}

async function sendFeedback(sessionId, messageId, feedbackType) {
  try {
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
      console.error('Failed to save feedback');
    }
  } catch (err) {
    console.error('sendFeedback error:', err);
  }
}

async function sendMessageToSession(sessionId, messagePayload){
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

async function createChatSession(sessionPayload){
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

async function initSession(){
  try {
    const persistedSessions = await fetchChatSessions();

    if(persistedSessions.length > 0){
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
