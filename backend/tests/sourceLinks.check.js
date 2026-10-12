/**
 * Live check that every source an answer cites actually opens, the way the chat opens it.
 *
 * For each saved /api/ask response it builds the same link the chat UI builds for a source
 * (frontend/javascript/chatbot_interface.js getSourceViewerUrl), requests it, and checks that
 * the page shows the source with the cited passage highlighted. For a book it also follows
 * the PDF link and checks that a PDF comes back. Every book passage that was offered to the
 * answer model is checked too, cited or not.
 *
 *   node tests/sourceLinks.check.js <responses.json>     (in backend/; file written by clientFeedback.check.js with OUT=)
 */
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3099';
const file = process.argv[2];
if (!file) {
  console.error('usage: node tests/sourceLinks.check.js <responses.json>');
  process.exit(2);
}

function viewerUrl(source) {
  const params = new URLSearchParams();
  const passages = Array.isArray(source.passages) ? source.passages : [];
  const passageIds = passages.map((p) => p.embedding_id).filter(Boolean);
  if (source.is_book) {
    params.set('sourceTable', 'CLA Books');
    if (passageIds[0] || source.embedding_id) params.set('recordId', passageIds[0] || source.embedding_id);
    if (source.file_name) params.set('file', source.file_name);
    params.set('page', source.page_number || 1);
  } else {
    params.set('sourceTable', source.source_table);
    params.set('recordId', source.record_id);
  }
  if (passageIds.length) params.set('ids', passageIds.join(','));
  if (passages[0] && passages[0].excerpt) params.set('highlight', passages[0].excerpt.slice(0, 600));
  if (source.title) params.set('title', String(source.title).slice(0, 200));
  params.set('theme', 'light');
  return `${BASE_URL}/api/citation?${params.toString()}`;
}

async function pdfOpens(fileName, page) {
  const redirect = await fetch(`${BASE_URL}/api/view-pdf?file=${encodeURIComponent(fileName)}&page=${encodeURIComponent(page || 1)}`, { redirect: 'manual' });
  const location = redirect.headers.get('location') || '';
  if (redirect.status !== 302 || location.startsWith('/api/citation')) return false;
  const pdf = await fetch(location.split('#')[0], { headers: { Range: 'bytes=0-1023' } });
  return pdf.ok && /pdf/i.test(pdf.headers.get('content-type') || '');
}

const words = (text) => String(text || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').toLowerCase().match(/[a-z]{5,}/g) || [];

(async () => {
  const responses = JSON.parse(fs.readFileSync(file, 'utf8'));
  const checkedSources = new Map();
  const bookFiles = new Map();
  for (const { body } of responses) {
    for (const source of body.sources || []) {
      const key = `${source.source_table}|${source.record_id}|${(source.passages || []).map((p) => p.embedding_id).join(',')}`;
      if (!checkedSources.has(key)) checkedSources.set(key, source);
    }
    for (const passage of body.searchResults || []) {
      if (passage.is_book && passage.file_name) bookFiles.set(passage.file_name, passage);
    }
  }

  let failed = 0;
  const byType = {};
  for (const source of checkedSources.values()) {
    const response = await fetch(viewerUrl(source));
    const html = await response.text();
    const highlighted = /class="[^"]*(?:cited|highlight)[^"]*"/i.test(html) || /<mark/i.test(html);
    // The page must show the passage the answer relied on, not just any page of the document.
    const expected = words((source.passages[0] && source.passages[0].text) || source.excerpt).slice(0, 40);
    const pageWords = new Set(words(html));
    const overlap = expected.length ? expected.filter((w) => pageWords.has(w)).length / expected.length : 0;
    const ok = response.status === 200 && !/could not be (?:found|loaded)|not found in the index/i.test(html) && highlighted && overlap >= 0.8;
    let pdfOk = true;
    if (source.is_book) pdfOk = await pdfOpens(source.file_name, source.page_number);
    byType[source.type_label] = byType[source.type_label] || { opened: 0, failed: 0 };
    byType[source.type_label][ok && pdfOk ? 'opened' : 'failed'] += 1;
    if (!(ok && pdfOk)) {
      failed += 1;
      console.log(`FAIL  ${source.type_label} | ${String(source.title).slice(0, 80)} | status ${response.status}, highlighted ${highlighted}, passage shown ${Math.round(overlap * 100)}%${source.is_book ? `, pdf ${pdfOk}` : ''}`);
    }
  }
  console.log(`Cited sources opened as the chat opens them: ${JSON.stringify(byType)}`);

  let booksFailed = 0;
  for (const [fileName, passage] of bookFiles) {
    if (!(await pdfOpens(fileName, 1))) {
      booksFailed += 1;
      console.log(`FAIL  book offered to the answer model does not open as a PDF: ${fileName} (${passage.doc_title})`);
    }
  }
  console.log(`Books offered to the answer model whose PDF opens: ${bookFiles.size - booksFailed}/${bookFiles.size} (${[...bookFiles.keys()].join('; ') || 'none'})`);

  console.log(`\n${checkedSources.size - failed}/${checkedSources.size} cited sources open with the cited passage shown`);
  process.exit(failed || booksFailed ? 1 : 0);
})().catch((error) => {
  console.error('The check could not run:', error);
  process.exit(2);
});
