const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildContextBlock,
  finalizeAnswer,
  normalizeAnswerStructure,
  stripMetaCommentary,
  displayTitle,
  cleanBookTitle,
  NO_ANSWER_TEXT,
} = require('../citations');
const { renderCitationPage, findCitedChunks } = require('../citationPage');
const { parseAnswerAndSuggestions } = require('../responseParser');

// Retrieved chunks in the order the model sees them: [Source 1] .. [Source 5].
const results = [
  {
    embedding_id: 'Articles|367|2', source_table: 'Articles', record_id: 367, chunk_index: 2,
    doc_title: 'Company incorporation in 24 hours in India',
    chunk_text: '[Articles | Title: Company incorporation in 24 hours in India | File: 2012_356.htm]\nThe Ministry announced that a company could be incorporated within 24 hours once the digital signature and DIN are in place.',
    cohere_relevance_score: 0.86, backend_relevance_score: 0.86,
  },
  {
    embedding_id: 'Legislation|79|33', source_table: 'Legislation', record_id: 79, chunk_index: 33,
    doc_title: 'Companies (Incorporation) Rules, 2014', file_name: 'CIR_2014.htm',
    chunk_text: '[Legislation | Title: Companies (Incorporation) Rules, 2014 | File: CIR_2014.htm]\n17. Particulars of first directors of the company and their consent to act as such. The particulars of each person mentioned in the articles as first director shall be filed in Form DIR.12 along with the fee.',
    cohere_relevance_score: 0.53, backend_relevance_score: 0.61,
  },
  {
    embedding_id: 'Legislation|79|130', source_table: 'Legislation', record_id: 79, chunk_index: 130,
    doc_title: 'Companies (Incorporation) Rules, 2014', file_name: 'CIR_2014.htm',
    chunk_text: '[Legislation | Title: Companies (Incorporation) Rules, 2014 | File: CIR_2014.htm]\nThe application for incorporation of a company shall be filed in Form INC-32 (SPICe) along with the fee as provided in the Companies (Registration Offices and Fees) Rules, 2014.',
    cohere_relevance_score: 0.47, backend_relevance_score: 0.55,
  },
  {
    embedding_id: 'CaseLaws|12988|0', source_table: 'CaseLaws', record_id: 12988, chunk_index: 0,
    doc_title: 'Dmitry Rosnin v. Registrar of Companies', citation: '[2013] 112 CLA 107 (Bom.)',
    chunk_text: '[CaseLaws | Versus: Dmitry Rosnin v. Registrar of Companies | Citation: [2013] 112 CLA 107 (Bom.) | Court: (BOM)]\nForeign subscribers are not required to furnish their local address in India as a pre-condition to registration and incorporation of a private limited company.',
    cohere_relevance_score: 0.79, backend_relevance_score: 0.84,
  },
  {
    embedding_id: 'Basic_Concepts_p249_c0', source_table: 'CLA Books', record_id: 'Basic_Concepts_p249_c0', is_book: true,
    doc_title: "Basic Concepts of Company & It's Structure_PRINT", file_name: "Basic Concepts of Company & It's Structure_PRINT.pdf", page_number: 249,
    chunk_text: "[Book: Basic Concepts | Page: 249/938]\nThe name of a private limited company must end with the words Private Limited.",
    chunk_body: 'The name of a private limited company must end with the words Private Limited.',
    cohere_relevance_score: 0.54, backend_relevance_score: 0.54,
  },
];

test('context block numbers each chunk and leaves out the stored header', () => {
  const block = buildContextBlock(results);
  assert.match(block, /^\[Source 1\] \| Type: Article \| Title: "Company incorporation in 24 hours in India"/);
  assert.match(block, /\[Source 2\] \| Type: Legislation \| Title: "Companies \(Incorporation\) Rules, 2014"/);
  assert.match(block, /\[Source 4\] \| Type: Case law \| Title: "Dmitry Rosnin v\. Registrar of Companies \[2013\] 112 CLA 107 \(Bom\.\)"/);
  assert.ok(!block.includes('[Legislation | Title:'), 'stored chunk header must not be repeated');
});

test('only cited sources are listed, ranked by relevance, and markers are renumbered to match', () => {
  const draft = [
    '**Overview**',
    'The first directors\' particulars and consent are filed in Form DIR.12 [Source 2]. The incorporation application is filed in Form INC-32 (SPICe) with the prescribed fee [Source 3].',
    '',
    '**Analysis**',
    '',
    '**Foreign subscribers**',
    'Foreign subscribers are not required to furnish a local address in India as a pre-condition to incorporation of a private limited company [Source 4].',
    '',
    '**Conclusion**',
    'Incorporation is applied for in Form INC-32 (SPICe) [Source 2, 3].',
  ].join('\n');

  const { answer, sources } = finalizeAnswer(draft, results);

  // Sources 1 (article) and 5 (book) were retrieved but never cited: they are not listed.
  assert.equal(sources.length, 2);
  assert.deepEqual(sources.map((s) => s.number), [1, 2]);
  // The case has the higher relevance score, so it is source 1; both rule chunks are one source.
  assert.equal(sources[0].title, 'Dmitry Rosnin v. Registrar of Companies [2013] 112 CLA 107 (Bom.)');
  assert.equal(sources[1].title, 'Companies (Incorporation) Rules, 2014');
  assert.deepEqual(sources[1].passages.map((p) => p.embedding_id).sort(), ['Legislation|79|130', 'Legislation|79|33']);
  assert.equal(sources[1].type_label, 'Legislation');

  assert.match(answer, /Form DIR\.12 \[2\]\./);
  assert.match(answer, /private limited company \[1\]\./);
  assert.match(answer, /\(SPICe\) \[2\]\./, 'two chunks of one document collapse to one marker');
  assert.ok(!/\[Source/i.test(answer), 'no raw [Source N] placeholder is left');

  // Two heading levels.
  assert.match(answer, /^## Overview$/m);
  assert.match(answer, /^## Analysis$/m);
  assert.match(answer, /^### Foreign subscribers$/m);
  assert.match(answer, /^## Conclusion$/m);
  assert.match(answer, /not legal advice/);
});

test('a citation to a passage that does not support the sentence is moved to the one that does', () => {
  const draft = 'The incorporation application is filed in Form INC-32 (SPICe) along with the fee under the Companies (Registration Offices and Fees) Rules, 2014 [Source 1].';
  const { sources, stats } = finalizeAnswer(draft, results);
  assert.equal(stats.reattributed, 1);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].title, 'Companies (Incorporation) Rules, 2014');
});

test('markers that point past the retrieved list are removed, law-report years are left alone', () => {
  const draft = 'The court so held in [2013] 112 CLA 107 [Source 4]. An unrelated statement [Source 42].';
  const { answer, sources } = finalizeAnswer(draft, results);
  assert.equal(sources.length, 1);
  assert.ok(answer.includes('[2013] 112 CLA 107 [1].'));
  assert.ok(!answer.includes('42'));
});

test('a no-answer reply carries no sources', () => {
  const { answer, sources } = finalizeAnswer(NO_ANSWER_TEXT, results);
  assert.equal(answer, NO_ANSWER_TEXT);
  assert.deepEqual(sources, []);
});

test('sentences about the database or gaps are removed; the law stays', () => {
  const draft = [
    '## Analysis',
    '### Timing',
    'Section 7 governs incorporation [Source 2]. The database does not contain the full checklist of documents under Rules 8 to 18. The certificate is issued in Form INC-11.',
    '### Practical note',
    'The retrieved material on the 24-hour scheme relates to the earlier regime. That material is historical and does not reflect the current process.',
    '## Conclusion',
    'Incorporation is governed by Section 7.',
  ].join('\n');
  const cleaned = stripMetaCommentary(draft);
  assert.ok(!/database/i.test(cleaned));
  assert.ok(!/retrieved material/i.test(cleaned));
  assert.ok(!/That material/.test(cleaned));
  assert.ok(!cleaned.includes('### Practical note'), 'a sub-heading left with no content is removed');
  assert.ok(cleaned.includes('Section 7 governs incorporation [Source 2].'));
  assert.ok(cleaned.includes('The certificate is issued in Form INC-11.'));
});

test('an answer that only says what is missing becomes the plain no-answer reply', () => {
  const draft = [
    '## Overview',
    'The relevant framework is the Insolvency and Bankruptcy Code, 2016 [Source 4].',
    '',
    '## Analysis',
    'The passages provided do not address the specific test for the "same line of business" question. The material describes the CIRP framework, but does not set out the legal test for the question you have raised.',
    '',
    '## Conclusion',
    'The database does not contain the specific provision that determines this.',
    '',
    'This is legal research, not legal advice. Please verify against the primary source.',
  ].join('\n');
  const { answer, sources, stats } = finalizeAnswer(draft, results);
  assert.equal(answer, NO_ANSWER_TEXT);
  assert.deepEqual(sources, []);
  assert.equal(stats.hollow, true);
});

test('a trailing "Sources Used" list is dropped and plain headings are recognised', () => {
  const normalized = normalizeAnswerStructure([
    'Overview',
    'Text.',
    '### Analysis',
    'More text.',
    'Sources Used',
    'Legislation: Companies Act, 2013 (s.7).',
    'This is legal research, not legal advice. Please verify against the primary source.',
  ].join('\n'));
  assert.match(normalized, /^## Overview$/m);
  assert.match(normalized, /^## Analysis$/m);
  assert.ok(!normalized.includes('Sources Used'));
  assert.ok(!normalized.includes('Legislation: Companies Act'));
  assert.ok(normalized.endsWith('Please verify against the primary source.'));
});

test('the response parser no longer cuts an answer at a sentence starting with "Sources"', () => {
  const { answer } = parseAnswerAndSuggestions('First point.\nSources of funds for a buy-back are free reserves.\nSecond point.');
  assert.ok(answer.includes('Second point.'));
  const stripped = parseAnswerAndSuggestions('Answer text.\n\n**Sources Used**\nLegislation: X').answer;
  assert.equal(stripped, 'Answer text.');
});

test('book titles and case titles are shown the way a reader knows them', () => {
  assert.equal(cleanBookTitle("Basic Concepts of Company & It's Structure_PRINT.pdf"), "Basic Concepts of Company & It's Structure");
  assert.equal(cleanBookTitle('Share Capital & Securities Law_PRINT (1).pdf'), 'Share Capital & Securities Law');
  assert.equal(displayTitle(results[4]), "Basic Concepts of Company & It's Structure");
});

test('source page: correct title, cited passage highlighted, found by id or by excerpt text', () => {
  const details = {
    document: { title: 'Companies (Incorporation) Rules, 2014', source_table: 'Legislation', record_id: 79, file_name: 'CIR_2014.htm', instrument_type: 'Rules' },
    chunks: [
      { id: 'Legislation|79|0', index: 0, text: 'Companies (Incorporation) Rules, 2014', full_text: 'Companies (Incorporation) Rules, 2014' },
      { id: 'Legislation|79|33', index: 33, text: '17. Particulars of first directors of the company and their consent to act as such. The particulars shall be filed in Form DIR.12.', full_text: '17. Particulars of first directors of the company and their consent to act as such. The particulars shall be filed in Form DIR.12.' },
      { id: 'Legislation|79|34', index: 34, text: '18. Certificate of incorporation shall be issued in Form INC-11.', full_text: '18. Certificate of incorporation shall be issued in Form INC-11.' },
    ],
    complete: true,
  };

  const html = renderCitationPage(details, { theme: 'light', citedIds: ['Legislation|79|33'], claim: 'The particulars of first directors are filed in Form DIR.12.' });
  assert.match(html, /<h1 class="document-title">Companies \(Incorporation\) Rules, 2014<\/h1>/);
  assert.equal((html.match(/class="passage cited"/g) || []).length, 1);
  assert.match(html, /id="cited-focus"[\s\S]*Particulars of first directors/);
  assert.match(html, /<mark class="claim-match">/);

  // Links saved in older chats only carry the excerpt text.
  assert.deepEqual(findCitedChunks(details.chunks, [], '18. Certificate of incorporation shall be issued in Form INC-11.'), [2]);
  assert.deepEqual(findCitedChunks(details.chunks, [], 'text that is not in the document at all, anywhere'), []);
});
