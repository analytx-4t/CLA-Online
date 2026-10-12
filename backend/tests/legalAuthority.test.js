const test = require('node:test');
const assert = require('assert');
const {
  tierKeyOf,
  buildSupersededCatalogue,
  amendedVersion,
  currencyOf,
  rankByAuthority,
  selectContext,
  CURRENCY,
} = require('../legalAuthority');

const LABELS = {
  'pit_1992.htm': { title: 'SEBI (Prohibition of Insider Trading) Regulations, 1992' },
  'pit_2015.htm': { title: 'SEBI (PROHIBITION OF INSIDER TRADING) REGULATIONS, 2015' },
  'tispro_2000.htm': { title: 'Foreign Exchange Management (Transfer or Issue of Security by a Person Resident Outside India) Regulations, 2000' },
  'tispro_2017.htm': { title: 'Foreign Exchange Management (Transfer or Issue of Security by a Person Resident Outside India) Regulations, 2017' },
  'export_2015.htm': { title: 'Foreign Exchange Management (Export of Goods and Services) Regulations, 2015' },
  'ca_amend.htm': { title: 'Companies (Amendment) Act, 2017' },
  'typo.htm': { title: 'Securities and Exchange Board of India (Mutual Funds) Regulations, 2072' },
};
const MANUAL = [{
  title: 'Foreign Exchange Management (Transfer or Issue of Security by a Person Resident Outside India) Regulations, 2017',
  successor: 'Foreign Exchange Management (Non-debt Instruments) Rules, 2019',
  mention: 'transfer or issue of security by a person resident outside india\\)?\\s*regulations,?\\s*(?:2000|2017)',
  unless: 'non-?debt instruments?\\)?\\s*rules',
}];
const catalogue = buildSupersededCatalogue(LABELS, MANUAL, 2026);
const PIT_2015 = 'SEBI (Prohibition of Insider Trading) Regulations, 2015';
const ctx = { catalogue, primaryAct: PIT_2015, mode: 'as_of: today; mode = CURRENT', question: 'Who is an insider?', currentYear: 2026 };

const chunk = (fields) => ({ chunk_body: '', cohere_relevance_score: 0.6, ...fields });

test('authority tiers follow the source table, and regulator papers are not treated as law', () => {
  assert.strictEqual(tierKeyOf({ source_table: 'Legislation' }), 'legislation');
  assert.strictEqual(tierKeyOf({ source_table: 'Notifications', doc_title: 'X (Amendment) Regulations, 2024' }), 'notification');
  assert.strictEqual(tierKeyOf({ source_table: 'Circular', doc_title: 'Consultation Paper on review of UPSI' }), 'regulator_paper');
  assert.strictEqual(tierKeyOf({ source_table: 'Notifications', doc_title: 'Guidance Note on SEBI (PIT) Regulations' }), 'regulator_paper');
  assert.strictEqual(tierKeyOf({ source_table: 'CLA Books', is_book: true }), 'book');
  assert.strictEqual(tierKeyOf({ source_table: 'Articles' }), 'article');
});

test('an earlier instrument of the same name is superseded; amendment Acts and impossible years are ignored', () => {
  const superseded = [...catalogue.byTitleKey.values()].map((v) => v.title);
  assert.ok(superseded.includes('SEBI (Prohibition of Insider Trading) Regulations, 1992'));
  assert.ok(!superseded.includes('SEBI (PROHIBITION OF INSIDER TRADING) REGULATIONS, 2015'));
  assert.ok(!superseded.some((t) => /Amendment/.test(t)));
  assert.ok(!superseded.some((t) => /Mutual Funds/.test(t)));
});

test('superseded legislation is not current law and is kept out of a current-law answer', () => {
  const [old, current] = rankByAuthority([
    chunk({ source_table: 'Legislation', doc_title: 'SEBI (Prohibition of Insider Trading) Regulations, 1992', cohere_relevance_score: 0.9 }),
    chunk({ source_table: 'Legislation', doc_title: 'SEBI (PROHIBITION OF INSIDER TRADING) REGULATIONS, 2015', cohere_relevance_score: 0.7 }),
  ], ctx);
  assert.strictEqual(old.currency_status, CURRENCY.SUPERSEDED);
  assert.strictEqual(old.excluded_as_stale, true);
  assert.strictEqual(current.currency_status, CURRENCY.CURRENT);
  assert.strictEqual(current.excluded_as_stale, false);
});

test('an article written before the governing instrument existed is excluded; a recent one is kept', () => {
  const [oldArticle, newArticle] = rankByAuthority([
    chunk({ source_table: 'Articles', doc_title: 'Insider trading - SEBI Regulations', doc_date: '2011-04-11' }),
    chunk({ source_table: 'Articles', doc_title: 'Insider Trading in India', doc_date: '2026-01-15' }),
  ], ctx);
  assert.strictEqual(oldArticle.currency_status, CURRENCY.PREDATES);
  assert.strictEqual(oldArticle.excluded_as_stale, true);
  assert.strictEqual(newArticle.excluded_as_stale, false);
});

test('a question about the earlier law keeps the earlier law', () => {
  const [old] = rankByAuthority([
    chunk({ source_table: 'Legislation', doc_title: 'SEBI (Prohibition of Insider Trading) Regulations, 1992' }),
  ], { ...ctx, question: 'How did the SEBI (Prohibition of Insider Trading) Regulations, 1992 define insider?' });
  assert.strictEqual(old.currency_status, CURRENCY.SUPERSEDED);
  assert.strictEqual(old.excluded_as_stale, false);

  const [comparison] = rankByAuthority([
    chunk({ source_table: 'Legislation', doc_title: 'SEBI (Prohibition of Insider Trading) Regulations, 1992' }),
  ], { ...ctx, mode: 'as_of: today; mode = COMPARISON' });
  assert.strictEqual(comparison.excluded_as_stale, false);
});

test('case law decided under a replaced instrument is kept and labelled, not dropped', () => {
  const [decided] = rankByAuthority([
    chunk({ source_table: 'CaseLaws', doc_title: 'A v. SEBI', chunk_body: 'under the SEBI (Prohibition of Insider Trading) Regulations, 1992 the appellant' }),
  ], ctx);
  assert.strictEqual(decided.currency_status, CURRENCY.SUPERSEDED);
  assert.strictEqual(decided.excluded_as_stale, false);
  assert.match(decided.currency_note, /Decided under/);
});

test('an amendment is judged by the version it amended', () => {
  const ninth = 'Foreign Exchange Management (Transfer or Issue of Security by A Person Resident Outside India) (Ninth Amendment) Regulations, 2013';
  assert.strictEqual(amendedVersion(ninth, 2013, catalogue).year, 2000);
  const dead = currencyOf({ source_table: 'Notifications', doc_title: ninth, doc_date: '2013-06-07' }, { ...ctx, primaryAct: 'FEMA 1999' });
  assert.strictEqual(dead.status, CURRENCY.SUPERSEDED);
  assert.strictEqual(dead.drop, true);

  const live = currencyOf({
    source_table: 'Notifications',
    doc_title: 'Securities and Exchange Board of India (Prohibition of Insider Trading) (Amendment) Regulations, 2019',
    doc_date: '2019-01-15',
  }, ctx);
  assert.strictEqual(live.status, CURRENCY.CURRENT);

  // Replaced under a different name: listed in supersededInstruments.json.
  const amends2017 = currencyOf({
    source_table: 'Notifications',
    doc_title: 'Foreign Exchange Management (Transfer or Issue of Security by a Person Resident Outside India) (Amendment) Regulations, 2018',
    doc_date: '2018-03-26',
  }, { ...ctx, primaryAct: 'FEMA 1999' });
  assert.strictEqual(amends2017.status, CURRENCY.SUPERSEDED);
});

test('primary law outranks an equally relevant article, and statutory definitions come first', () => {
  const ranked = rankByAuthority([
    chunk({ embedding_id: 'a', source_table: 'Articles', doc_title: 'Recent article', doc_date: '2025-06-01', cohere_relevance_score: 0.8 }),
    chunk({ embedding_id: 'l', source_table: 'Legislation', doc_title: PIT_2015, record_id: 60, cohere_relevance_score: 0.8 }),
    { embedding_id: 'd1', source_table: 'Legislation', doc_title: PIT_2015, record_id: 60, pinned: true, definition_depth: 1, defined_term: 'connected person', chunk_body: '' },
    { embedding_id: 'd0', source_table: 'Legislation', doc_title: PIT_2015, record_id: 60, pinned: true, definition_depth: 0, defined_term: 'insider', chunk_body: '' },
  ], ctx);
  const { context } = selectContext(ranked, {});
  assert.deepStrictEqual(context.map((c) => c.embedding_id), ['d0', 'd1', 'l', 'a']);
});

test('a book that cannot be opened is never offered to the answer model', () => {
  const ranked = rankByAuthority([
    chunk({ embedding_id: 'l', source_table: 'Legislation', doc_title: PIT_2015, record_id: 60, cohere_relevance_score: 0.8 }),
    chunk({ embedding_id: 'b1', source_table: 'CLA Books', is_book: true, file_name: 'Open.pdf', cohere_relevance_score: 0.8 }),
    chunk({ embedding_id: 'b2', source_table: 'CLA Books', is_book: true, file_name: 'Missing.pdf', cohere_relevance_score: 0.8 }),
  ], ctx);
  const { context, stats } = selectContext(ranked, { usableBooks: new Set(['Open.pdf']) });
  assert.ok(context.some((c) => c.embedding_id === 'b1'));
  assert.ok(!context.some((c) => c.embedding_id === 'b2'));
  assert.strictEqual(stats.droppedInaccessibleBooks, 1);
});

test('legislation whose title could not be verified is kept out', () => {
  const ranked = rankByAuthority([
    chunk({ embedding_id: 'ok', source_table: 'Legislation', doc_title: PIT_2015, record_id: 60, cohere_relevance_score: 0.8 }),
    chunk({ embedding_id: 'bad', source_table: 'Legislation', doc_title: 'Indian Contract Act 1872', record_id: 9, title_verified: false, cohere_relevance_score: 0.9 }),
  ], ctx);
  const { context, stats } = selectContext(ranked, {});
  assert.deepStrictEqual(context.map((c) => c.embedding_id), ['ok']);
  assert.strictEqual(stats.droppedUnverifiedLegislation, 1);
});

test('when nothing retrieved is on point there is no context at all', () => {
  const ranked = rankByAuthority([
    chunk({ embedding_id: 'x', source_table: 'Articles', doc_title: 'Unrelated', doc_date: '2024-01-01', cohere_relevance_score: 0.2 }),
  ], ctx);
  const { context, stats } = selectContext(ranked, {});
  assert.strictEqual(context.length, 0);
  assert.strictEqual(stats.nothingOnPoint, true);
});

test('an old circular is left out once enough current primary law is on point', () => {
  const fema = { ...ctx, primaryAct: 'Foreign Exchange Management Act, 1999', question: 'Exporter unpaid for 16 months' };
  const ranked = rankByAuthority([
    chunk({ embedding_id: 'c2007', source_table: 'Circular', doc_title: 'Export of goods and services', doc_date: '2007-07-02', record_id: 1, cohere_relevance_score: 0.66 }),
    chunk({ embedding_id: 'reg', source_table: 'Legislation', doc_title: 'Foreign Exchange Management (Export of Goods and Services) Regulations, 2015', record_id: 2, cohere_relevance_score: 0.4 }),
    chunk({ embedding_id: 'reg2', source_table: 'Legislation', doc_title: 'Foreign Exchange Management (Export of Goods and Services) Regulations, 2015', record_id: 2, cohere_relevance_score: 0.3 }),
    chunk({ embedding_id: 'am', source_table: 'Notifications', doc_title: 'Foreign Exchange Management (Export of Goods and Services) (First Amendment) Regulations, 2026', doc_date: '2026-06-06', record_id: 3, is_amendment: true, cohere_relevance_score: 0.23 }),
  ], fema);
  const { context, stats } = selectContext(ranked, {});
  assert.ok(!context.some((c) => c.embedding_id === 'c2007'));
  assert.ok(context.some((c) => c.embedding_id === 'am'), 'the latest amendment is kept despite its low relevance score');
  assert.strictEqual(stats.droppedOldInstruments, 1);
});

test('definitions are read only for a term the question asks about', () => {
  const { definedTermsAskedAbout } = require('../legalAuthority');
  assert.deepStrictEqual(definedTermsAskedAbout(['insider', 'connected person'], 'Who is an insider?'), ['insider', 'connected person']);
  assert.deepStrictEqual(
    definedTermsAskedAbout(['generally available information', 'unpublished price sensitive information'], 'What is UPSI?'),
    ['unpublished price sensitive information', 'generally available information']);
  assert.deepStrictEqual(definedTermsAskedAbout(['person resident in india'], 'An exporter shipped goods 16 months ago and is unpaid.'), []);
  assert.deepStrictEqual(definedTermsAskedAbout([], 'Who is an insider?'), []);
});

test('the passage that opens a provision named by the query analysis is ranked ahead', () => {
  const [plain, named] = rankByAuthority([
    chunk({ embedding_id: 'p', source_table: 'Legislation', doc_title: PIT_2015, record_id: 60, cohere_relevance_score: 0.85 }),
    chunk({ embedding_id: 'n', source_table: 'Legislation', doc_title: PIT_2015, record_id: 60, cohere_relevance_score: 0.8, named_provision: '3' }),
  ], ctx);
  assert.ok(named.backend_relevance_score > plain.backend_relevance_score);
});

test('"X read with Y" names one governing instrument and one related instrument', () => {
  const { splitInstruments, describeRequest } = require('../legalAuthority');
  assert.deepStrictEqual(
    splitInstruments('SEBI (Prohibition of Insider Trading) Regulations, 2015 read with SEBI Act, 1992'),
    ['SEBI (Prohibition of Insider Trading) Regulations, 2015', 'SEBI Act, 1992']);
  assert.deepStrictEqual(splitInstruments('Companies Act 2013'), ['Companies Act 2013']);
  assert.deepStrictEqual(splitInstruments(null), []);
  // The governing year is that of the governing instrument, not of the Act it is read with.
  assert.strictEqual(describeRequest({ catalogue, primaryAct: 'SEBI (Prohibition of Insider Trading) Regulations, 2015 read with SEBI Act, 1992', question: 'Who is an insider?' }).governingYear, 2015);
});

test('a definition read from a replaced instrument is not pinned into a current-law answer', () => {
  const ranked = rankByAuthority([
    { embedding_id: 'new', source_table: 'Legislation', doc_title: PIT_2015, record_id: 60, pinned: true, definition_depth: 0, defined_term: 'insider', chunk_body: '' },
    { embedding_id: 'old', source_table: 'Legislation', doc_title: 'SEBI (Prohibition of Insider Trading) Regulations, 1992', record_id: 7, pinned: true, definition_depth: 1, defined_term: 'insider', chunk_body: '' },
  ], ctx);
  const { context, stats } = selectContext(ranked, {});
  assert.deepStrictEqual(context.map((c) => c.embedding_id), ['new']);
  assert.strictEqual(stats.droppedStale, 1);
});

test('an amendment already in the current text is dropped; a newer one is kept and flagged', () => {
  const withDates = buildSupersededCatalogue(LABELS, MANUAL, 2026, {
    'export_2015.htm': { title: 'Foreign Exchange Management (Export of Goods and Services) Regulations, 2015', last_amended: '2025-11-15' },
  });
  const fema = { ...ctx, catalogue: withDates, primaryAct: 'Foreign Exchange Management Act, 1999' };
  const older = currencyOf({ source_table: 'Notifications', doc_title: 'Foreign Exchange Management (Export of Goods and Services) (Amendment) Regulations, 2021', doc_date: '2021-01-14' }, fema);
  assert.strictEqual(older.status, CURRENCY.INCORPORATED);
  assert.strictEqual(older.drop, true);
  const newer = currencyOf({ source_table: 'Notifications', doc_title: 'Foreign Exchange Management (Export of Goods and Services) (First Amendment) Regulations, 2026', doc_date: '2026-06-06' }, fema);
  assert.strictEqual(newer.status, CURRENCY.CURRENT);
  assert.strictEqual(newer.newerThanText, true);
  const ranked = rankByAuthority([{ source_table: 'Notifications', doc_title: 'Foreign Exchange Management (Export of Goods and Services) (Amendment) Regulations, 2021', doc_date: '2021-01-14', chunk_body: '', cohere_relevance_score: 0.8 }], fema);
  assert.strictEqual(ranked[0].excluded_as_stale, true);
});

test('footnote text of superseded wording never reaches the answer', () => {
  const ranked = rankByAuthority([
    chunk({ embedding_id: 'law', source_table: 'Legislation', doc_title: PIT_2015, record_id: 60, cohere_relevance_score: 0.8 }),
    chunk({ embedding_id: 'note', source_table: 'Legislation', doc_title: PIT_2015, record_id: 60, amendment_history: true, cohere_relevance_score: 0.9 }),
  ], ctx);
  const { context, stats } = selectContext(ranked, {});
  assert.deepStrictEqual(context.map((c) => c.embedding_id), ['law']);
  assert.strictEqual(stats.droppedAmendmentHistory, 1);
});
