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

function getApiBaseUrl(){
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:3000';
  }
  return window.location.origin && window.location.origin !== 'null' ? window.location.origin : 'http://localhost:3000';
}

function getCurrentUserId(){
  return localStorage.getItem('cla-user-id') || 'unknown-user';
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
  return 'session-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function nowISO(){
  return new Date().toISOString();
}

function createSession({ title = 'New chat', user_id = getCurrentUserId(), status = SESSION_STATUS.ACTIVE } = {}){
  const sessionId = generateId();
  const timestamp = nowISO();
  return {
    session_id: sessionId,
    user_id,
    title,
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
    user_id: 'unknown-user',
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
  let html = escapeHTML(text);
  // Bold: **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italic: *text*
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Inline code: `text`
  html = html.replace(/`(.*?)`/g, '<code>$1</code>');
  return html;
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
  const session = getCurrentSession();
  const messages = session ? getMessagesForSession(session.session_id) : [];
  const chatShell = document.querySelector('.chat-window-shell');

  const showWelcome = messages.length === 0;
  welcomeCard.style.display = showWelcome ? 'block' : 'none';

  // When there are no messages, do not render the empty chat shell visually.
  // Use conditional rendering via DOM styles instead of CSS hacks like opacity.
  if(chatShell){
    chatShell.style.display = showWelcome ? 'none' : '';
  }
}

function renderMessages(){
  if(!chatWindow) return;
  const session = getCurrentSession();
  const messages = session ? getMessagesForSession(session.session_id) : [];
  chatWindow.innerHTML = '';
  messages.forEach(message => {
    const div = document.createElement('div');
    div.className = message.role === 'user' ? 'user-msg' : 'assistant-msg';
    if(message.role === 'assistant'){
      const safeContent = formatMarkdown(message.content || '');
      div.innerHTML = `<div class="msg-title">CLA Online Legal Chatbot</div><p>${safeContent}</p>`;
      
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
        div.appendChild(followUpContainer);
      }
    } else {
      // preserve message bubble styling; inject attachments if present
      const safeContent = escapeHTML(message.content || '');
      const html = `<div class="user-message-text">${safeContent}</div>`;
      div.innerHTML = html;
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
    chatWindow.appendChild(div);
  });
  scrollToBottom();
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

function addAssistantMessage(){
  addMessage('assistant', 'Hello! I am CLA, your legal chatbot. I can help you with contract disputes, recovery options, insolvency questions and corporate law guidance.');
}

async function createNewSession(){
  const session = createSession();
  try {
    const persistedSession = await createChatSession(session);
    const resolvedSession = {
      ...session,
      ...persistedSession,
      session_id: getSessionIdentifier(persistedSession) || session.session_id,
      user_id: getSessionOwnerId(persistedSession) || session.user_id,
    };
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
  renderSessions();
  
  try {
    const msgs = await fetchSessionMessages(sessionId);
    messagesBySession[sessionId] = msgs;
  } catch (error) {
    console.error('Failed to load session messages:', error);
  }
  
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
  const thinkingMsg = {
    message_id: thinkingMessageId,
    session_id: sessionId,
    role: 'assistant',
    content: 'CLA is analyzing your query and searching resources...',
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
    }
    
    // Update session info from database
    const session = getCurrentSession();
    if (session) {
      session.message_count = messagesBySession[sessionId].length;
      session.updated_at = nowISO();
      if (result.assistantMessage && (!session.title || session.title === 'New chat')) {
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

function removeSessionFromFrontState(sessionId){
  const sessionIndex = sessions.findIndex(session => session.session_id === sessionId);
  if(sessionIndex === -1) return;
  const remainingSessions = sessions.filter(session => session.session_id !== sessionId);
  sessions = remainingSessions;
  delete messagesBySession[sessionId];

  if(currentSessionId === sessionId){
    if(remainingSessions.length > 0){
      const fallbackIndex = Math.min(sessionIndex, remainingSessions.length - 1);
      setCurrentSession(remainingSessions[fallbackIndex].session_id);
    } else {
      const replacement = createSession();
      sessions = [replacement];
      messagesBySession[replacement.session_id] = [];
      setCurrentSession(replacement.session_id);
    }
  }

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
    removeSessionFromFrontState(pendingDeleteSessionId);
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
    user_id: sessionData.user_id || 'unknown-user',
    title: sessionData.title || 'New chat',
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
    const response = await fetch(`${getApiBaseUrl()}/api/chat/sessions`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': getCurrentUserId(),
      }
    });
    if (!response.ok) {
      throw new Error('Failed to fetch sessions');
    }
    const data = await response.json();
    return data.sessions || [];
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
    const response = await fetch(`${getApiBaseUrl()}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': getCurrentUserId(),
      }
    });
    if (!response.ok) {
      throw new Error('Failed to fetch messages');
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
  return await response.json();
}

async function initSession(){
  try {
    const fetched = await fetchChatSessions();
    if (fetched && fetched.length > 0) {
      sessions = fetched.map(s => createSessionFromBackend(s));
      const firstSessionId = sessions[0].session_id;
      setCurrentSession(firstSessionId);
      const msgs = await fetchSessionMessages(firstSessionId);
      messagesBySession[firstSessionId] = msgs;
    } else {
      const session = createSession();
      const persistedSession = await createChatSession(session);
      const resolvedSession = {
        ...session,
        ...persistedSession,
        session_id: getSessionIdentifier(persistedSession) || session.session_id,
        user_id: getSessionOwnerId(persistedSession) || session.user_id,
      };
      sessions = [resolvedSession];
      messagesBySession[resolvedSession.session_id] = [];
      setCurrentSession(resolvedSession.session_id);
    }
  } catch (error) {
    console.error('initSession error:', error);
    const session = createSession();
    sessions = [session];
    messagesBySession[session.session_id] = [];
    setCurrentSession(session.session_id);
  }
  renderSessions();
  renderMessages();
  updateWelcomeCard();
}

void initSession();
