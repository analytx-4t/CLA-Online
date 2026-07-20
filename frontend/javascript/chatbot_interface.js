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

function getApiBaseUrl() {
  const configuredBaseUrl = (window.__CLA_API_BASE_URL__ || '').toString().trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/$/, '');
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

let activeTypingIntervals = [];
let messagesToAnimate = new Set();

function clearTypingIntervals() {
  activeTypingIntervals.forEach(clearInterval);
  activeTypingIntervals = [];
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
  return value.replace(/[&<>"]+/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[match]));
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

function sanitizeCitations(text, maxIndex) {
  if (!text) return '';
  // remove citation markers [n] where n > maxIndex or if maxIndex is 0 (no sources)
  return text.replace(/\[(\d+)\]/g, (match, num) => {
    const n = Number(num);
    if (!maxIndex || isNaN(n) || n > maxIndex) return ''; // remove the citation entirely
    return `[${n}]`;
  });
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
    chip.addEventListener('click', () => scrollToMessage(entry.assistantMessage.message_id));

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
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('tracker-highlight');
  void target.offsetWidth;
  target.classList.add('tracker-highlight');
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
  return text.length > 40 ? text.slice(0, 40) + '...' : text;
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
    const titleText = session.title || 'New chat';
    item.setAttribute('title', titleText);
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

function setCitationCardsExpanded(citationsContainer, expanded) {
  if (!citationsContainer) return;
  const toggleBtn = citationsContainer.querySelector('.citation-toggle-btn');

  if (!toggleBtn) {
    citationsContainer.dataset.expanded = 'true';
    return;
  }

  if (expanded) {
    const existingExtra = citationsContainer.querySelectorAll('.citation-card');
    if (existingExtra.length === 1 && Array.isArray(citationsContainer._remainingSources)) {
      citationsContainer._remainingSources.forEach((source, offset) => {
        const idx = offset + 1;
        const card = citationsContainer._renderCitationCard(source, idx);
        citationsContainer.insertBefore(card, toggleBtn);
      });
    }
  } else {
    const remainingCards = Array.from(citationsContainer.querySelectorAll('.citation-card'))
      .filter(card => Number(card.dataset.citationIndex) > 0);
    remainingCards.forEach(card => card.remove());
  }

  const remaining = citationsContainer._remainingSources ? citationsContainer._remainingSources.length : 0;
  toggleBtn.textContent = expanded ? 'Hide Sources' : `Show ${remaining} More Sources`;
  toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  citationsContainer.dataset.expanded = expanded ? 'true' : 'false';
  
  // Scroll to show expanded citations
  requestAnimationFrame(() => {
    scrollToBottom();
  });
}

function ensureCitationVisible(citationsContainer, cardEl) {
  if (!citationsContainer || !cardEl) return;

  if (citationsContainer.dataset.expanded !== 'true' && Number(cardEl.dataset.citationIndex) > 0) {
    setCitationCardsExpanded(citationsContainer, true);
    requestAnimationFrame(() => {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      cardEl.classList.remove('highlight');
      void cardEl.offsetWidth;
      cardEl.classList.add('highlight');
    });
    return;
  }

  cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  cardEl.classList.remove('highlight');
  void cardEl.offsetWidth;
  cardEl.classList.add('highlight');
}

function renderSourceCitations(container, message) {
  if (container.querySelector('.citations-container')) {
    return;
  }

  const sources = message.metadata && message.metadata.sources ? message.metadata.sources : [];
  if (sources.length === 0) {
    return;
  }

  const activeTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const citationsContainer = document.createElement('div');
  citationsContainer.className = 'citations-container';
  citationsContainer.innerHTML = `<div class="citations-header-title">Source Citations (${sources.length})</div>`;
  citationsContainer._remainingSources = sources.slice(1);

  citationsContainer._renderCitationCard = (s, idx) => {
    const sourceNum = idx + 1;
    const card = document.createElement('div');
    card.className = 'citation-card';
    card.id = `citation-card-${message.message_id}-${idx}`;
    card.dataset.citationIndex = String(idx);

    let detailsHtml = '';
    const addDetail = (label, value, extraClass = '') => {
      const safeValue = (value === null || value === undefined) ? 'N/A' : escapeHTML(String(value));
      detailsHtml += `<span class="citation-detail-item${extraClass ? ' ' + extraClass : ''}"><strong class="citation-detail-label">${label}</strong><span class="citation-detail-value">${safeValue}</span></span>`;
    };

    if (s.title) addDetail('Title', s.title, 'is-title');
    if (s.category) addDetail('Category', s.category);
    if (s.subject) addDetail('Subject', s.subject);
    if (s.author) addDetail('Author', s.author);
    if (s.sections) addDetail('Section', s.sections);
    if (s.doc_date) {
      try {
        const formattedDate = new Date(s.doc_date).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        addDetail('Date', formattedDate);
      } catch (e) {
        addDetail('Date', s.doc_date);
      }
    }
    if (s.vol) addDetail('Volume', s.vol);
    if (s.issue_month || s.issue_year) {
      const issueStr = [s.issue_month, s.issue_year].filter(Boolean).join(' ');
      if (issueStr) addDetail('Issue', issueStr);
    }

    let openLinkHtml = '';
    if (s.source_table && s.record_id) {
      const parentParam = s.parent_id ? `&parentId=${encodeURIComponent(s.parent_id)}` : '';
      openLinkHtml = `<a href="${getApiBaseUrl()}/api/citation?sourceTable=${encodeURIComponent(s.source_table)}&recordId=${encodeURIComponent(s.record_id)}${parentParam}&theme=${activeTheme}" target="_blank" class="open-citation-btn"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" style="vertical-align: middle; margin-right: 3px;"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>Open Citation</a>`;
    }

    card.innerHTML = `
      <div class="citation-card-top-row">
        <span class="citation-badge">Source [${sourceNum}]</span>
        ${openLinkHtml}
      </div>
      <div class="citation-title" title="${escapeHTML(s.title || 'Untitled Document')}">${escapeHTML(s.title || 'Untitled Document')}</div>
      ${detailsHtml ? `<div class="citation-details">${detailsHtml}</div>` : ''}
    `;
    return card;
  };

  citationsContainer.appendChild(citationsContainer._renderCitationCard(sources[0], 0));

  if (sources.length > 1) {
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'citation-toggle-btn';
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.textContent = `Show ${sources.length - 1} More Sources`;
    toggleBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const isExpanded = citationsContainer.dataset.expanded === 'true';
      setCitationCardsExpanded(citationsContainer, !isExpanded);
      requestAnimationFrame(() => {
        scrollToBottom();
      });
    });
    citationsContainer.appendChild(toggleBtn);
    setCitationCardsExpanded(citationsContainer, false);
  }

  container.appendChild(citationsContainer);
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
      // If the message metadata for sources contains a passage id, open citation page with passage anchor
      const sources = message.metadata && message.metadata.sources ? message.metadata.sources : [];
      const src = sources[index];
      if (src && src.source_table && src.record_id && src.passage_id) {
        const parentParam = src.parent_id ? `&parentId=${encodeURIComponent(src.parent_id)}` : '';
        const url = `${getApiBaseUrl()}/api/citation?sourceTable=${encodeURIComponent(src.source_table)}&recordId=${encodeURIComponent(src.record_id)}${parentParam}&theme=${document.documentElement.getAttribute('data-theme') || 'light'}&highlight=${encodeURIComponent(src.passage_id)}`;
        window.open(url, '_blank');
        return;
      }

      const citationsContainer = container.querySelector('.citations-container');
      if (!citationsContainer) return;

      const cardEl = container.querySelector(`#citation-card-${message.message_id}-${index}`);
      if (cardEl) {
        ensureCitationVisible(citationsContainer, cardEl);
        return;
      }

      if (index > 0) {
        setCitationCardsExpanded(citationsContainer, true);
        requestAnimationFrame(() => {
          const expandedCardEl = container.querySelector(`#citation-card-${message.message_id}-${index}`);
          if (expandedCardEl) {
            ensureCitationVisible(citationsContainer, expandedCardEl);
          }
        });
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
    wrapper.className = 'message-bubble-wrapper';
    wrapper.dataset.messageId = message.message_id;
    wrapper.dataset.messageRole = message.role;

    const div = document.createElement('div');
    div.className = message.role === 'user' ? 'user-msg' : 'assistant-msg';
    wrapper.appendChild(div);

    if (message.role === 'assistant') {
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
            // Sanitize citations based on available sources for this message
            const sourcesForMessage = message.metadata && Array.isArray(message.metadata.sources) ? message.metadata.sources : [];
            const sanitized = sanitizeCitations(rawText, sourcesForMessage.length);
            contentDiv.innerHTML = formatMarkdown(sanitized);
            contentDiv.classList.remove('streaming-cursor');
            clearInterval(interval);

            // Render in order: Citations, Follow-up Questions, Message Actions
            renderSourceCitations(div, message);
            renderSuggestedFollowUps(div, message);
            renderMessageActions(div, message);
            scrollToBottom();
          } else {
            const sourcesForMessage = message.metadata && Array.isArray(message.metadata.sources) ? message.metadata.sources : [];
            const sanitizedPartial = sanitizeCitations(rawText.slice(0, currentLen), sourcesForMessage.length);
            contentDiv.innerHTML = formatMarkdown(sanitizedPartial);
            scrollToBottom();
          }
        }, typingSpeed);

        activeTypingIntervals.push(interval);
      } else {
        // Display immediately
        const sourcesForMessage = message.metadata && Array.isArray(message.metadata.sources) ? message.metadata.sources : [];
        const sanitizedContent = sanitizeCitations(message.content || '', sourcesForMessage.length);
        contentDiv.innerHTML = formatMarkdown(sanitizedContent);
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
  if (role === 'user' && (!session.title || session.title === 'New chat')) {
    session.title = truncateTitle(content);
  }
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

async function selectSession(sessionId) {
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

async function handleUserSend() {
  if (!messageInput || isSendingMessage) return;
  const text = messageInput.value.trim();

  if (!text && selectedFiles.length === 0) return;

  if (selectedFiles.some(entry => entry.status === 'uploading')) {
    flashAttachmentNotice('Please wait for the attachment to finish uploading.');
    return;
  }

  isSendingMessage = true;

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
  const thinkingMsg = {
    message_id: thinkingMessageId,
    session_id: sessionId,
    role: 'assistant',
    content: 'CLA is analyzing your query and generating a response...',
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
    const response = await fetch(`${getApiBaseUrl()}/api/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ question: text, attachments: attachmentsForContext })
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
          evaluation,
          route,
          searchResults: Array.isArray(searchResults) ? searchResults : []
        }
      }
    };

    const saveResult = await sendMessageToSession(sessionId, persistPayload);
    messagesBySession[sessionId] = messagesBySession[sessionId].filter(m => m.message_id !== thinkingMessageId);

    if (saveResult.userMessage) {
      messagesBySession[sessionId] = messagesBySession[sessionId].filter(m => m.message_id !== userMsg.message_id);
      messagesBySession[sessionId].push(saveResult.userMessage);
    }
    if (saveResult.assistantMessage) {
      messagesBySession[sessionId].push(saveResult.assistantMessage);
      messagesToAnimate.add(saveResult.assistantMessage.message_id);
    } else {
      messagesBySession[sessionId].push({
        message_id: 'assistant-' + Date.now(),
        session_id: sessionId,
        user_id: getCurrentUserId(),
        role: 'assistant',
        content: answerContent,
        created_at: nowISO(),
        metadata: persistPayload.assistantMessage.metadata
      });
    }

    const session = getCurrentSession();
    if (session) {
      session.message_count = messagesBySession[sessionId].length;
      session.updated_at = nowISO();
      if (session.title === 'New chat') {
        session.title = truncateTitle(text);
      }
    }
  } catch (error) {
    console.error('Failed to send message:', error);
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

function debounceSearch() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(handleSessionSearch, 300);
}

function handleSessionSearch() {
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
}

function resizeTextArea() {
  if (!messageInput) return;
  messageInput.style.height = 'auto';
  messageInput.style.height = `${messageInput.scrollHeight}px`;
}

sendBtn?.addEventListener('click', () => {
  handleUserSend();
});

messageInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleUserSend();
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

    return data.messages || [];
  } catch (err) {
    console.error('fetchSessionMessages error:', err);
    return messagesBySession[sessionId] || [];
  } finally {
    isLoadingMessages = false;
  }
}

async function searchChatSessions(query) {
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
