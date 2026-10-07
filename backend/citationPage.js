/**
 * citationPage.js
 *
 * Renders the page a reader lands on when they open a cited source: the correct name of the
 * source at the top, its full text in reading order, and the passage the answer relied on
 * highlighted and scrolled into view.
 */

const { repairLostCharacters, sourceTypeLabel, cleanBookTitle, supportTokens, supportScore } = require('./citations');

function escapeHTML(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function collapse(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Which chunks of the document the answer cited.
 * New links carry the chunk ids. Links saved in older chats only carry the excerpt text, so
 * for those the chunk is found by looking for that text in the document.
 */
function findCitedChunks(chunks, citedIds, highlightText) {
  const idSet = new Set((citedIds || []).map(String));
  let cited = chunks.map((chunk, position) => (idSet.has(String(chunk.id)) ? position : -1)).filter((p) => p >= 0);
  if (cited.length || !highlightText) return cited;

  const needle = collapse(highlightText).toLowerCase();
  const probes = [0, 80, 160, 240]
    .map((offset) => needle.slice(offset, offset + 60))
    .filter((probe) => probe.length >= 30);
  for (const probe of probes) {
    cited = chunks
      .map((chunk, position) => (collapse(chunk.full_text || chunk.text).toLowerCase().includes(probe) ? position : -1))
      .filter((p) => p >= 0);
    if (cited.length) return cited.slice(0, 2);
  }
  return [];
}

// Of several cited chunks, the one that best matches the sentence the reader clicked from.
function pickFocusChunk(chunks, citedPositions, claim) {
  if (!citedPositions.length) return -1;
  if (!claim || citedPositions.length === 1) return citedPositions[0];
  const claimTokens = supportTokens(claim);
  let best = citedPositions[0];
  let bestScore = -1;
  for (const position of citedPositions) {
    const score = supportScore(claimTokens, supportTokens(chunks[position].full_text || chunks[position].text));
    if (score > bestScore) {
      best = position;
      bestScore = score;
    }
  }
  return best;
}

const SENTENCE_SPLIT_RE = /(?<=[.;:?!])\s+(?=[A-Z(“"\d])/;

// Inside the cited passage, the sentences closest to the claim get the stronger highlight.
function claimSentenceSet(text, claim) {
  const matches = new Set();
  if (!claim) return matches;
  const claimTokens = supportTokens(claim);
  if (claimTokens.size < 3) return matches;
  const scored = [];
  for (const line of String(text).split(/\n+/)) {
    for (const sentence of line.split(SENTENCE_SPLIT_RE)) {
      const clean = collapse(sentence);
      if (clean.length < 25) continue;
      scored.push({ sentence: clean, score: supportScore(claimTokens, supportTokens(clean)) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  for (const item of scored.slice(0, 2)) {
    if (item.score >= 0.3) matches.add(item.sentence);
  }
  return matches;
}

function renderParagraphs(text, strongSentences, { reflow = false } = {}) {
  let source = repairLostCharacters(String(text || '')).replace(/\r\n?/g, '\n');
  // Book text comes from PDF pages, where every printed line ends in a line break. Those are
  // joined back into running text; only a blank line starts a new paragraph.
  if (reflow) source = source.replace(/[ \t]*\n(?!\s*\n)[ \t]*/g, ' ');
  const lines = source.split(/\n+/);
  let html = '';
  for (const rawLine of lines) {
    const line = collapse(rawLine);
    if (!line) continue;
    const isHeading = !reflow && line.length <= 90 && !/[.;:,]$/.test(line) && /[A-Za-z]/.test(line) &&
      (line === line.toUpperCase() || /^(?:chapter|part|schedule|section|rule|regulation|form|table|annexure)\b/i.test(line));
    if (isHeading) {
      html += `<p class="doc-heading">${escapeHTML(line)}</p>`;
      continue;
    }
    let body = '';
    if (strongSentences && strongSentences.size) {
      for (const sentence of line.split(SENTENCE_SPLIT_RE)) {
        const clean = collapse(sentence);
        body += strongSentences.has(clean)
          ? `<mark class="claim-match">${escapeHTML(clean)}</mark> `
          : `${escapeHTML(clean)} `;
      }
      body = body.trim();
    } else {
      body = escapeHTML(line);
    }
    html += `<p>${body}</p>`;
  }
  return html;
}

function metaItem(label, value) {
  if (!value) return '';
  return `<div class="meta-item"><span class="meta-label">${escapeHTML(label)}</span><span class="meta-value">${escapeHTML(value)}</span></div>`;
}

const PAGE_STYLES = `
    body.light-theme { --bg:#f7f7f7; --surface:#ffffff; --text:#111111; --muted:#5f6368; --border:rgba(0,0,0,0.09); --primary:#0C8742; --primary-soft:rgba(12,135,66,0.08); --cite-bg:#fff7d1; --cite-border:#e0b400; --claim-bg:#ffe27a; --claim-text:#1c1a00; }
    body.dark-theme { --bg:#111111; --surface:#171717; --text:#f4f4f4; --muted:#a3a3a3; --border:rgba(255,255,255,0.09); --primary:#27b36a; --primary-soft:rgba(39,179,106,0.12); --cite-bg:rgba(234,179,8,0.13); --cite-border:#d9a400; --claim-bg:rgba(234,179,8,0.5); --claim-text:#fffbe0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: 'Inter', system-ui, sans-serif; line-height: 1.6; min-height: 100vh; }
    .top-nav { display:flex; align-items:center; justify-content:space-between; gap:12px; height:60px; padding:0 32px; background:var(--surface); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:100; }
    .nav-brand { display:flex; align-items:center; gap:12px; font-weight:700; color:var(--primary); font-size:1.02rem; }
    .nav-brand img { height:28px; width:auto; }
    .nav-actions { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
    .nav-brand { flex:0 0 auto; }
    /* The source's name stays in view while the page sits on the cited passage. */
    .nav-doc { flex:1 1 auto; min-width:0; display:flex; align-items:center; justify-content:center; gap:10px; }
    .nav-doc .badge { margin-bottom:0; flex:0 0 auto; }
    .nav-doc-title { font-weight:700; font-size:0.95rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    @media (max-width:760px) { .nav-brand-name { display:none; } }
    .btn { display:inline-flex; align-items:center; gap:6px; padding:8px 14px; font:600 0.86rem 'Inter', system-ui, sans-serif; border-radius:8px; cursor:pointer; text-decoration:none; border:1px solid var(--border); background:var(--surface); color:var(--text); }
    .btn:hover { border-color:var(--primary); }
    .btn-primary { background:var(--primary); border-color:var(--primary); color:#fff; }
    .btn-primary:hover { filter:brightness(1.06); }
    .main-container { max-width:940px; margin:32px auto 60px; padding:0 20px; }
    .document-card { background:var(--surface); border:1px solid var(--border); border-top:4px solid var(--primary); border-radius:14px; overflow:hidden; }
    .header-bar { padding:32px 40px 24px; border-bottom:1px solid var(--border); }
    .badge { display:inline-block; font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; padding:4px 10px; border-radius:6px; background:var(--primary-soft); color:var(--primary); margin-bottom:14px; }
    .document-title { font-size:1.7rem; font-weight:800; line-height:1.3; overflow-wrap:anywhere; }
    .document-subtitle { margin-top:8px; color:var(--muted); font-size:0.98rem; font-weight:500; }
    .meta-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(190px, 1fr)); gap:16px 24px; padding:20px 40px; border-bottom:1px solid var(--border); }
    .meta-item { display:flex; flex-direction:column; gap:3px; min-width:0; }
    .meta-label { font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); }
    .meta-value { font-size:0.9rem; font-weight:600; overflow-wrap:anywhere; }
    .cite-banner { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; padding:14px 40px; background:var(--cite-bg); border-bottom:1px solid var(--border); font-size:0.92rem; font-weight:600; }
    .cite-banner.muted { background:var(--primary-soft); font-weight:500; }
    .content-body { padding:30px 40px 40px; font-family:'Lora', Georgia, serif; font-size:1.07rem; line-height:1.8; }
    .content-body p { margin-bottom:1.05em; overflow-wrap:anywhere; }
    .content-body p.doc-heading { font-family:'Inter', system-ui, sans-serif; font-weight:700; font-size:0.98rem; margin-top:1.5em; }
    .page-label { font:700 0.74rem 'Inter', system-ui, sans-serif; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); border-top:1px solid var(--border); padding-top:14px; margin:26px 0 14px; }
    .passage { scroll-margin-top:84px; }
    .passage.cited { background:var(--cite-bg); border-left:4px solid var(--cite-border); border-radius:0 8px 8px 0; padding:14px 18px 4px 18px; margin:18px 0 18px -22px; }
    .passage.cited .cited-label { display:block; font:700 0.72rem 'Inter', system-ui, sans-serif; text-transform:uppercase; letter-spacing:0.08em; color:var(--cite-border); margin-bottom:8px; }
    mark.claim-match { background:var(--claim-bg); color:var(--claim-text); padding:1px 2px; border-radius:3px; }
    .doc-note { font:500 0.86rem 'Inter', system-ui, sans-serif; color:var(--muted); padding:14px 40px; border-top:1px solid var(--border); }
    .footer-actions { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:18px 40px; background:var(--bg); border-top:1px solid var(--border); font-size:0.8rem; color:var(--muted); }
    @media (max-width:640px) { .top-nav { padding:0 16px; } .header-bar, .meta-grid, .cite-banner, .content-body, .doc-note, .footer-actions { padding-left:20px; padding-right:20px; } .passage.cited { margin-left:-12px; } .document-title { font-size:1.35rem; } }
    @media print { .top-nav, .footer-actions, .cite-banner .btn { display:none; } .document-card { border:none; } }
`;

const PAGE_SCRIPT = `
    function closeCitationTab() {
      window.close();
      setTimeout(function () { if (!window.closed) { window.location.href = '/HTML/chatbot_interface.html'; } }, 300);
    }
    (function () {
      var KEY = 'citation-theme';
      var button = document.getElementById('themeToggleBtn');
      function apply(theme) {
        document.body.classList.remove('light-theme', 'dark-theme');
        document.body.classList.add(theme === 'dark' ? 'dark-theme' : 'light-theme');
        if (button) button.textContent = theme === 'dark' ? '\\u2600' : '\\u263E';
      }
      var saved = null;
      try { saved = localStorage.getItem(KEY); } catch (e) {}
      var current = (saved === 'light' || saved === 'dark') ? saved : (document.body.classList.contains('dark-theme') ? 'dark' : 'light');
      apply(current);
      if (button) button.addEventListener('click', function () {
        current = current === 'dark' ? 'light' : 'dark';
        apply(current);
        try { localStorage.setItem(KEY, current); } catch (e) {}
      });

      var cited = Array.prototype.slice.call(document.querySelectorAll('.passage.cited'));
      var position = Math.max(0, cited.findIndex(function (el) { return el.id === 'cited-focus'; }));
      function show(index, smooth) {
        if (!cited.length) return;
        position = (index + cited.length) % cited.length;
        cited[position].scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
      }
      var jump = document.getElementById('jumpToCited');
      if (jump) jump.addEventListener('click', function () { show(position, true); });
      var next = document.getElementById('nextCited');
      if (next) next.addEventListener('click', function () { show(position + 1, true); });
      // Land on the cited passage straight away, and again once the fonts have settled the
      // layout (a long statute shifts by several screens when the text font arrives).
      show(position, false);
      window.addEventListener('load', function () { show(position, false); });
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { show(position, false); });
      }
    })();
`;

function pageShell({ title, theme, body, typeLabel }) {
  const isDark = theme === 'dark';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(title)} | CLA Online Source</title>
  <link rel="icon" href="/assets/Images/logo.png" type="image/png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
  <style>${PAGE_STYLES}</style>
</head>
<body class="${isDark ? 'dark-theme' : 'light-theme'}">
  <header class="top-nav">
    <div class="nav-brand">
      <img src="/assets/Images/logo.png" alt="CLA Corporate Law Adviser">
      <span class="nav-brand-name">CLA Online</span>
    </div>
    <div class="nav-doc" title="${escapeHTML(title)}">${typeLabel ? `<span class="badge">${escapeHTML(typeLabel)}</span>` : ''}<span class="nav-doc-title">${escapeHTML(title)}</span></div>
    <div class="nav-actions">
      <button class="btn" type="button" onclick="closeCitationTab()">&larr; Back to chat</button>
      <button class="btn" id="themeToggleBtn" type="button" aria-label="Switch theme">${isDark ? '☀' : '☾'}</button>
    </div>
  </header>
  <div class="main-container">
    <div class="document-card">
${body}
      <div class="footer-actions">
        <span>CLA Online &mdash; source text as held in the CLA Online database</span>
      </div>
    </div>
  </div>
  <script>${PAGE_SCRIPT}</script>
</body>
</html>`;
}

/**
 * @param {Object} details   { document, chunks, complete } from search_documents.py get_citation
 * @param {Object} options   { theme, citedIds, highlightText, claim, pdfUrl }
 */
function renderCitationPage(details, options = {}) {
  const doc = details.document || {};
  const chunks = Array.isArray(details.chunks) ? details.chunks : [];
  const isBook = Boolean(doc.is_book);
  const typeLabel = doc.instrument_type || sourceTypeLabel(doc.source_table, isBook);
  const title = repairLostCharacters(isBook ? cleanBookTitle(doc.title) : collapse(doc.title)) || 'Source document';

  const citedPositions = findCitedChunks(chunks, options.citedIds, options.highlightText);
  const focus = pickFocusChunk(chunks, citedPositions, options.claim);
  const citedSet = new Set(citedPositions);

  let content = '';
  let lastPage = null;
  chunks.forEach((chunk, position) => {
    if (isBook && chunk.page !== lastPage) {
      lastPage = chunk.page;
      content += `<div class="page-label">Page ${escapeHTML(chunk.page)}${doc.total_pages ? ` of ${escapeHTML(doc.total_pages)}` : ''}</div>`;
    }
    if (citedSet.has(position)) {
      const strong = position === focus ? claimSentenceSet(chunk.full_text || chunk.text, options.claim) : null;
      // The cited passage is shown whole, even where its start repeats the previous passage.
      content += `<section class="passage cited" ${position === focus ? 'id="cited-focus"' : ''}>` +
        '<span class="cited-label">Passage cited in the answer</span>' +
        `${renderParagraphs(chunk.full_text || chunk.text, strong, { reflow: isBook })}</section>`;
    } else {
      content += `<section class="passage">${renderParagraphs(chunk.text, null, { reflow: isBook })}</section>`;
    }
  });
  if (!content) content = '<p>No text is available for this source.</p>';

  let subtitle = '';
  if (/case/i.test(String(doc.source_table || '')) && doc.citation) subtitle = doc.citation;
  else if (isBook && doc.page_number) subtitle = `Page ${doc.page_number}${doc.total_pages ? ` of ${doc.total_pages}` : ''}`;
  else if (/comm/i.test(String(doc.source_table || '')) && doc.law_title && doc.law_title !== doc.title) subtitle = doc.law_title;

  const isLegislation = /legis/i.test(String(doc.source_table || ''));
  const sections = doc.sections && !/^(general|\d+)$/i.test(String(doc.sections).trim()) ? repairLostCharacters(collapse(doc.sections)) : null;
  const meta = [
    metaItem('Source type', typeLabel),
    metaItem('Court', doc.court ? String(doc.court).replace(/[()]/g, '') : null),
    metaItem('Bench', doc.judge ? String(doc.judge).split('#').map(collapse).filter(Boolean).join(', ') : null),
    metaItem(isBook ? 'Topic' : 'Section', sections),
    metaItem('Subject', !isBook && doc.subject && doc.subject !== doc.title ? collapse(doc.subject) : null),
    metaItem('Date', !isLegislation && !isBook ? formatDate(doc.doc_date) : null),
    metaItem('Reference file', doc.file_name),
  ].join('');

  let banner;
  if (citedPositions.length) {
    const many = citedPositions.length > 1;
    banner = '<div class="cite-banner">' +
      `<span>${many ? `${citedPositions.length} passages cited in the answer are highlighted below.` : 'The passage cited in the answer is highlighted below.'}</span>` +
      '<span class="nav-actions">' +
      '<button class="btn btn-primary" id="jumpToCited" type="button">Go to cited passage</button>' +
      (many ? '<button class="btn" id="nextCited" type="button">Next passage</button>' : '') +
      '</span></div>';
  } else {
    banner = '<div class="cite-banner muted"><span>Full text of the cited source.</span></div>';
  }

  let note = '';
  if (isBook) {
    const pages = [...new Set(chunks.map((c) => c.page).filter(Boolean))];
    const range = pages.length > 1 ? `pages ${pages[0]}–${pages[pages.length - 1]}` : `page ${pages[0] || doc.page_number}`;
    note = `<div class="doc-note">Showing ${escapeHTML(range)} of this book. ` +
      (options.pdfUrl
        ? `<a class="btn" href="${escapeHTML(options.pdfUrl)}" target="_blank" rel="noopener" style="margin-left:8px;">Open the book PDF at page ${escapeHTML(doc.page_number)}</a>`
        : 'The PDF edition of this book is not available at the moment, so the page text is shown here.') +
      '</div>';
  } else if (details.complete === false) {
    note = '<div class="doc-note">This is a very long document, so the part around the cited passage is shown.</div>';
  }

  const body = `      <div class="header-bar">
        <span class="badge">${escapeHTML(typeLabel)}</span>
        <h1 class="document-title">${escapeHTML(title)}</h1>
        ${subtitle ? `<div class="document-subtitle">${escapeHTML(subtitle)}</div>` : ''}
      </div>
      <div class="meta-grid">${meta}</div>
      ${banner}
      <div class="content-body">${content}</div>
      ${note}`;

  return pageShell({ title, theme: options.theme, body, typeLabel });
}

/**
 * Shown when the source can no longer be loaded. The reader still gets the passage the
 * answer cited, which the chat passes along with the link.
 */
function renderCitationNotFound({ theme, sourceTable, highlightText, title }) {
  const passage = collapse(highlightText);
  const body = `      <div class="header-bar">
        <span class="badge">${escapeHTML(sourceTypeLabel(sourceTable, /book/i.test(String(sourceTable || ''))))}</span>
        <h1 class="document-title">${escapeHTML(collapse(title) || 'Cited source')}</h1>
      </div>
      <div class="cite-banner muted"><span>The full text of this source could not be loaded just now.${passage ? ' The passage cited in the answer is shown below.' : ' Please try again in a moment.'}</span></div>
      <div class="content-body">${passage ? `<section class="passage cited" id="cited-focus"><span class="cited-label">Passage cited in the answer</span>${renderParagraphs(passage)}</section>` : ''}</div>`;
  return pageShell({ title: collapse(title) || 'Cited source', theme, body });
}

module.exports = {
  renderCitationPage,
  renderCitationNotFound,
  findCitedChunks,
  escapeHTML,
};
