/**
 * Live acceptance check for the client feedback of October 2026.
 *
 * Asks real questions of a running backend and asserts, sub-point by sub-point, what the
 * client asked for: current law, primary sources first, correct legislation, supported
 * citations, concise synthesis, statutory definitions resolved through their defined terms,
 * and no compliance category passed off as a statutory one.
 *
 *   PORT=3099 DB_SYNC_ENABLED=false node index.js        (in backend/)
 *   node tests/clientFeedback.check.js                   (in backend/)
 *
 * BASE_URL  backend to test (default http://localhost:3099)
 * REPEAT    how many times each definition question is asked (default 2): the answer model
 *           varies between runs, so one good answer proves little
 * OUT       file to save every response to (optional)
 */
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3099';
const REPEAT = Number(process.env.REPEAT || 2);
const SINGLE_ISSUE_WORD_LIMIT = 450;
const PRIMARY_TYPES = ['Legislation', 'Notification', 'Circular'];
const LABELS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../embedding/legislation_labels.json'), 'utf8'));

const results = [];
const saved = [];

function record(point, name, pass, detail = '') {
  results.push({ point, name, pass: Boolean(pass), detail: String(detail || '') });
}

async function ask(question, history) {
  const started = Date.now();
  const response = await fetch(`${BASE_URL}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, history, requestId: `fb-check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }),
  });
  const body = await response.json();
  saved.push({ question, seconds: Math.round((Date.now() - started) / 1000), body });
  return body;
}

// ---------------------------------------------------------------------------
// Reading an answer
// ---------------------------------------------------------------------------

const wordCount = (text) => String(text || '').split(/\s+/).filter(Boolean).length;
const section = (answer, name) => ((String(answer).match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |\\n\\nThis is legal research|$)`)) || [])[1] || '').trim();
const typeOf = (source) => source.type_label;
const isPrimary = (source) => PRIMARY_TYPES.includes(typeOf(source));

// [{ sentence, numbers }] for every sentence that carries [n] markers.
function citedSentences(answer) {
  const out = [];
  for (const line of String(answer || '').split('\n')) {
    const re = /([^\n]*?)((?:\s*\[\d{1,2}\])+)/g;
    let match;
    while ((match = re.exec(line)) !== null) {
      const before = match[1];
      const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('] '), before.lastIndexOf('; ')) + 1;
      const sentence = before.slice(start).replace(/^[\s\-*\d.)=]+/, '').replace(/==/g, '').trim();
      const numbers = [...match[2].matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
      if (sentence.length > 15) out.push({ sentence, numbers });
    }
  }
  return out;
}

const NUMBER_WORDS = { five: 5, six: 6, seven: 7, nine: 9, ten: 10, twelve: 12, fifteen: 15, eighteen: 18, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90 };
const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
function digitsIn(text) {
  let normalized = String(text || '').toLowerCase();
  normalized = normalized.replace(/\b(twenty|thirty|forty|fifty|sixty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b/g, (_, tens, unit) => String(NUMBER_WORDS[tens] + UNITS[unit]));
  normalized = normalized.replace(new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'g'), (word) => String(NUMBER_WORDS[word]));
  return normalized;
}

// Figures with a unit in a sentence: "25%", "nine months", "sixty days".
function figuresIn(sentence) {
  const text = digitsIn(sentence);
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*(%|per\s*cent|days?|weeks?|months?|years?)/g)].map((m) => ({
    number: m[1],
    unit: /%|per/.test(m[2]) ? 'percent' : m[2].replace(/s$/, ''),
  }));
}

function passageTextOf(source, body) {
  const byId = new Map((body.searchResults || []).map((r) => [String(r.embedding_id), r]));
  const fromSearch = (source.passages || []).map((p) => byId.get(String(p.embedding_id))).filter(Boolean).map((r) => r.chunk_text);
  // Every retrieved passage of the same record counts: chunks of one document are one source.
  const sameRecord = (body.searchResults || []).filter((r) => String(r.record_id) === String(source.record_id) && r.source_table === source.source_table).map((r) => r.chunk_text);
  return [...fromSearch, ...sameRecord, ...(source.passages || []).map((p) => p.text)].join('\n');
}

/**
 * Independent of the verifier model: every figure in a cited sentence must appear, with its
 * unit, in the passages of the sources that sentence cites.
 */
function auditFigures(body) {
  const failures = [];
  let checked = 0;
  // Figures the user supplied ("holds only 18%", "16 months ago") come from the question.
  const given = new Set(figuresIn(body.question || '').map((f) => `${f.number} ${f.unit}`));
  for (const { sentence, numbers } of citedSentences(body.answer)) {
    const sources = numbers.map((n) => (body.sources || [])[n - 1]).filter(Boolean);
    if (!sources.length) continue;
    const text = digitsIn(sources.map((s) => passageTextOf(s, body)).join('\n'));
    for (const figure of figuresIn(sentence)) {
      if (given.has(`${figure.number} ${figure.unit}`)) continue;
      checked += 1;
      const unitPattern = figure.unit === 'percent' ? '(?:%|per\\s*cent)' : `${figure.unit}s?`;
      if (!new RegExp(`\\b${figure.number.replace('.', '\\.')}\\s*${unitPattern}`).test(text)) {
        failures.push(`"${figure.number} ${figure.unit}" in: ${sentence.slice(0, 110)}`);
      }
    }
  }
  return { checked, failures };
}

// ---------------------------------------------------------------------------
// Checks shared by every current-law answer
// ---------------------------------------------------------------------------

// A cited book must open: the link has to lead to the PDF itself, not to the text fallback.
async function bookPdfOpens(source) {
  const link = `${BASE_URL}/api/view-pdf?file=${encodeURIComponent(source.file_name || source.filename || '')}&page=${encodeURIComponent(source.page_number || 1)}`;
  const redirect = await fetch(link, { redirect: 'manual' });
  const location = redirect.headers.get('location') || '';
  if (redirect.status !== 302 || location.startsWith('/api/citation')) return false;
  const pdf = await fetch(location.split('#')[0], { headers: { Range: 'bytes=0-1023' } });
  return pdf.ok && /pdf/i.test(pdf.headers.get('content-type') || '');
}

async function checkCommon(tag, body, { singleIssue = true, governing = null } = {}) {
  const answer = body.answer || '';
  const sources = body.sources || [];
  const context = body.searchResults || [];

  // 1 / C1 / C6: nothing superseded or pre-dating reaches the answer as current law
  const staleContext = context.filter((r) => ['superseded', 'predates_current_law'].includes(r.currency_status) && !['caselaw', 'notification', 'circular'].includes(r.authority_tier));
  record('1', `${tag}: no superseded or pre-dating passage among those the answer was written from`, staleContext.length === 0, staleContext.map((r) => r.doc_title).join('; '));
  const staleSources = sources.filter((s) => ['superseded', 'predates_current_law'].includes(s.currency_status) && s.authority_tier !== 'caselaw');
  record('1', `${tag}: no cited source is superseded or pre-dates the governing instrument`, staleSources.length === 0, staleSources.map((s) => s.title).join('; '));

  // 2 / C1: primary law leads; old articles and books do not carry the answer
  record('2', `${tag}: the first source is primary law`, sources.length > 0 && isPrimary(sources[0]), sources[0] ? `${typeOf(sources[0])}: ${sources[0].title}` : 'no sources');
  const primaryShare = sources.length ? sources.filter(isPrimary).length / sources.length : 0;
  record('2', `${tag}: at least half the cited sources are primary law`, primaryShare >= 0.5, `${Math.round(primaryShare * 100)}% of ${sources.length}`);
  const NON_BINDING = ['regulator_paper', 'article', 'book', 'commentary', 'query'];
  const BINDING = ['legislation', 'notification', 'circular', 'caselaw'];
  const tierOf = (n) => (sources[n - 1] || {}).authority_tier;
  const propped = citedSentences(answer).filter((c) => c.numbers.some((n) => BINDING.includes(tierOf(n))) && c.numbers.some((n) => NON_BINDING.includes(tierOf(n))));
  record('2', `${tag}: no rule is cited to an article, book or paper alongside the law that states it`, propped.length === 0, propped.map((c) => c.sentence.slice(0, 80)).join(' | '));
  const ranks = context.filter((r) => !r.pinned).map((r) => r.authority_rank);
  record('C1', `${tag}: passages are ordered primary law -> notifications/circulars -> case law -> commentary -> articles -> books`, ranks.every((rank, i) => i === 0 || rank >= ranks[i - 1]), ranks.join(','));

  // 3 / C2: the legislation shown is the right instrument, verified, with its metadata
  const legislation = context.filter((r) => r.source_table === 'Legislation');
  const wrongTitle = legislation.filter((r) => {
    const label = LABELS[String(r.file_name || '').toLowerCase()];
    return !label || label.title !== r.doc_title;
  });
  record('3', `${tag}: every legislation passage carries the verified title of its file`, wrongTitle.length === 0 && legislation.every((r) => r.title_verified), wrongTitle.map((r) => `${r.file_name}=${r.doc_title}`).join('; '));
  if (governing) {
    const top = sources.find((s) => typeOf(s) === 'Legislation');
    record('3', `${tag}: the legislation at the top is ${governing.source}`, Boolean(top) && governing.test(top.title), top ? top.title : 'no legislation source');
  }
  const legislationSources = sources.filter((s) => typeOf(s) === 'Legislation');
  record('C2', `${tag}: legislation sources carry status and amendment metadata`, legislationSources.length > 0 && legislationSources.every((s) => s.currency_status && s.authority_tier === 'legislation' && s.instrument_year), legislationSources.map((s) => `${s.currency_status}/${s.instrument_year}/${s.last_amended}`).join('; '));

  // 4 / C3: citations are supported
  const verification = body.verification || {};
  record('4', `${tag}: the citation check ran on this answer`, Number.isInteger(verification.claims) && !verification.error, JSON.stringify({ claims: verification.claims, removed: verification.removed, reattributed: verification.reattributed, uncited: verification.uncitedChecked }));
  const audit = auditFigures(body);
  record('4', `${tag}: every figure in a cited sentence appears in the cited source (${audit.checked} checked)`, audit.failures.length === 0, audit.failures.join(' | '));
  const books = sources.filter((s) => s.is_book);
  const unopened = [];
  for (const book of books) {
    if (!(await bookPdfOpens(book))) unopened.push(book.title);
  }
  record('4', `${tag}: every cited book opens as a PDF (${books.length} cited)`, unopened.length === 0, unopened.join('; '));

  // 5 / C5: concise synthesis
  record('5', `${tag}: no source-by-source narration`, !/\b(?:the|this) (?:article|book|commentary|paper|source)\s+(?:says|states|notes|explains|observes|mentions)\b|\bSource \d+ (?:says|states)\b|\baccording to (?:the|an) (?:article|book)\b/i.test(answer), '');
  if (singleIssue) record('5', `${tag}: within ${SINGLE_ISSUE_WORD_LIMIT} words`, wordCount(answer) <= SINGLE_ISSUE_WORD_LIMIT, `${wordCount(answer)} words`);
  record('5', `${tag}: no "sources" list or talk about the database`, !/\b(?:database|retrieved material|sources (?:provided|used))\b/i.test(answer), '');
}

const firstSentence = (text) => (String(text).match(/^[\s\S]*?[.?!](?=\s|\[|$)(?:\s*\[\d+\])*/) || [String(text)])[0];

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

const PIT = { source: 'the 2015 insider-trading regulations', test: (title) => /insider trading/i.test(title) && /2015/.test(title) };

async function checkInsider(run) {
  const tag = `"Who is an insider?" run ${run}`;
  const body = await ask('Who is an insider?');
  const answer = body.answer || '';
  await checkCommon(tag, body, { governing: PIT });
  const overview = section(answer, 'Overview');
  record('6', `${tag}: opens with the statutory definition and its provision`, /Regulation 2\(1\)\(g\)/.test(firstSentence(overview)), firstSentence(overview).slice(0, 160));
  const first = citedSentences(overview)[0];
  record('6', `${tag}: the definition is cited to the Regulations, not to an article`, Boolean(first) && first.numbers.every((n) => typeOf(body.sources[n - 1]) === 'Legislation'), first ? first.numbers.map((n) => typeOf(body.sources[n - 1])).join(',') : 'no citation');
  record('6', `${tag}: resolves "connected person" with its provision`, /Regulation 2\(1\)\(d\)/.test(answer), '');
  record('6', `${tag}: covers the persons deemed to be connected`, /\bdeem(?:s|ed|ing)?\b/i.test(answer), '');
  record('6', `${tag}: resolves "unpublished price sensitive information" with its provision`, /Regulation 2\(1\)\(n\)/.test(answer), '');
  const pinned = (body.searchResults || []).filter((r) => r.pinned);
  record('C4', `${tag}: the definitions were read whole from the instrument`, ['insider', 'connected person', 'unpublished price sensitive information'].every((term) => pinned.some((p) => String(p.defined_term).toLowerCase() === term)), pinned.map((p) => `${p.defined_term} (${p.provision_ref})`).join('; '));
  const connected = pinned.find((p) => String(p.defined_term).toLowerCase() === 'connected person');
  record('3', `${tag}: the "connected person" provision is complete (first limb to last deemed category)`, Boolean(connected) && /six months/.test(connected.chunk_text) && /sharing household/.test(connected.chunk_text), connected ? `${connected.chunk_text.length} characters` : 'missing');
  record('1', `${tag}: does not bring in the repealed 1992 regulations`, !/1992/.test(answer), '');
  record('5', `${tag}: no unasked sections on penalties, codes of conduct or trading windows`, !/^###.*(penalt|code of conduct|trading window|disclosure|pre-clearance)/im.test(answer), '');
  record('7', `${tag}: designated persons are not listed as a category of insider`, !/designated persons?[^.]{0,60}\b(?:are|is|as)\b[^.]{0,30}\b(?:categor|type|kind|class|sub-?set)[^.]{0,20}insider/i.test(answer) || /not[^.]{0,40}(?:categor|limb|type)/i.test(answer), '');
  return body;
}

async function checkDesignated(run) {
  const tag = `"Are designated persons insiders?" run ${run}`;
  const body = await ask('Are designated persons insiders under the SEBI insider trading regulations?');
  const answer = body.answer || '';
  await checkCommon(tag, body, { governing: PIT });
  record('7', `${tag}: explained as a compliance category`, /compliance (?:category|class|measure|mechanism)|code of conduct/i.test(answer), '');
  const positive = [...answer.matchAll(/[^.]*designated persons?[^.]*\b(?:sub-?set|category|type|kind|class) of insiders?[^.]*\./gi)].map((m) => m[0]).filter((s) => !/\bnot\b|\bneither\b|\bno\b/i.test(s));
  record('7', `${tag}: never called a category, type or sub-set of insider`, positive.length === 0, positive.join(' | ').slice(0, 300));
  record('7', `${tag}: status tested against the limbs of Regulation 2(1)(g)`, /Regulation 2\(1\)\(g\)/.test(answer) && /limb|connected person/i.test(answer), '');
}

async function checkUpsi(run) {
  const tag = `"What is UPSI and the restrictions on communicating it?" run ${run}`;
  const body = await ask('What is UPSI and what are the restrictions on communicating it?');
  const answer = body.answer || '';
  await checkCommon(tag, body, { singleIssue: false, governing: PIT });
  // The definition (Regulation 2(1)(n)) must come before the first statement of the restriction.
  const definitionAt = answer.search(/Regulation 2\(1\)\(n\)/);
  const restrictionAt = answer.search(/###[^\n]*(?:restrict|communicat)|Regulation 3\(1\)|No insider shall/i);
  const headings = [...answer.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  const definitionHeading = headings.findIndex((h) => /what is|defin|unpublished price|UPSI/i.test(h) && !/restrict|communicat/i.test(h));
  const restrictionHeading = headings.findIndex((h) => /restrict|communicat/i.test(h));
  record('7', `${tag}: UPSI is defined (Regulation 2(1)(n)) before the restrictions are discussed`,
    definitionAt !== -1 && (restrictionAt === -1 || definitionAt < restrictionAt) && (restrictionHeading === -1 || definitionHeading === -1 || definitionHeading < restrictionHeading),
    `definition at ${definitionAt}, restriction at ${restrictionAt}; sections: ${headings.join(' | ')}`);
  record('1', `${tag}: the restriction is the general rule in Regulation 3, from the current Regulations`, /Regulation 3(?:\(1\))?/.test(answer), '');
  const definitionSentence = citedSentences(answer).find((c) => /2\(1\)\(n\)/.test(c.sentence));
  record('2', `${tag}: the UPSI definition is cited to the Regulations, not to a consultation paper or book`, Boolean(definitionSentence) && definitionSentence.numbers.every((n) => typeOf(body.sources[n - 1]) === 'Legislation'), definitionSentence ? definitionSentence.numbers.map((n) => typeOf(body.sources[n - 1])).join(',') : 'definition sentence not cited');
}

async function checkExporter() {
  const tag = '"Exporter unpaid for 16 months"';
  const body = await ask('An Indian exporter shipped goods 16 months ago and has still not received payment. What is the position?');
  const answer = body.answer || '';
  await checkCommon(tag, body, { singleIssue: false });
  record('1', `${tag}: states the period as amended (nine months)`, /nine months|9 months/i.test(answer), '');
  record('1', `${tag}: does not give the pre-amendment period as the current one`, !/(?:within|period of|is)\s+(?:fifteen|15|twelve|12)\s+months/i.test(section(answer, 'Conclusion')), section(answer, 'Conclusion').slice(0, 200));
  record('C1', `${tag}: the amendment notification is among the cited sources`, (body.sources || []).some((s) => /amendment/i.test(s.title) && /2026|2025/.test(String(s.doc_date || s.title))), (body.sources || []).map((s) => s.title).join(' | ').slice(0, 300));
  record('C1', `${tag}: recent amendments were retrieved and flagged`, (body.searchResults || []).some((r) => r.is_amendment), '');
}

async function checkOpenOffer() {
  const tag = '"Open offer threshold"';
  const body = await ask('At what shareholding does an acquirer have to make an open offer under the takeover regulations?');
  const answer = body.answer || '';
  await checkCommon(tag, body, { singleIssue: false, governing: { source: 'the 2011 takeover regulations', test: (title) => /takeovers/i.test(title) && /2011/.test(title) } });
  record('1', `${tag}: gives the current threshold (25%)`, /twenty-five per cent|25\s*%|25 per cent/i.test(answer), '');
  record('1', `${tag}: does not give the repealed 1997 threshold (15%)`, !/fifteen per cent|15\s*%|15 per cent/i.test(answer), '');
  record('3', `${tag}: the provision that sets the threshold was retrieved`, (body.searchResults || []).some((r) => /twenty-five per cent or more of the voting rights/.test(r.chunk_text) && /No acquirer shall acquire/.test(r.chunk_text)), '');
}

async function checkHistorical() {
  const tag = '"How did the 1992 regulations define an insider?"';
  const body = await ask('How did the 1992 insider trading regulations define an insider?');
  const sources = body.sources || [];
  record('C1', `${tag}: a question about earlier law is answered from the earlier law`, sources.some((s) => /1992/.test(s.title)), sources.map((s) => s.title).join(' | ').slice(0, 200));
  record('1', `${tag}: the earlier law is labelled as earlier, not as current`, /1992/.test(body.answer || '') && /\b(?:defined|was|were|had|earlier|replaced)\b/i.test(body.answer || ''), '');
}

async function checkNoAuthority() {
  const tag = '"GST rate on restaurant services"';
  const body = await ask('What is the GST rate on restaurant services?');
  record('4', `${tag}: no answer is built when nothing on point exists`, /could not find authority/i.test(body.answer || '') && (body.sources || []).length === 0, (body.answer || '').slice(0, 120));
}

async function checkControl() {
  const tag = '"18% investor with veto rights: control?"';
  const body = await ask('An investor holds only 18% of a listed company but has veto rights over large borrowings and acquisitions. Does it have control?');
  const answer = body.answer || '';
  await checkCommon(tag, body, { singleIssue: false });
  const opening = firstSentence(section(answer, 'Overview'));
  record('6', `${tag}: opens with a statutory definition of control and its provision`, /Section 2\(27\)|Regulation 2\(1\)\(e\)/.test(opening), opening.slice(0, 160));
  const papers = (body.sources || []).filter((s) => s.authority_tier === 'regulator_paper');
  record('2', `${tag}: a consultation or discussion paper is not treated as law`, papers.length === 0 || /not law|propos|consultation paper|discussion paper/i.test(answer), papers.map((s) => s.title).join('; '));
}

async function checkFollowUp(firstAnswer) {
  const tag = 'follow-up "And who is a connected person?"';
  const body = await ask('And who is a connected person?', [
    { role: 'user', content: 'Who is an insider?' },
    { role: 'assistant', content: String(firstAnswer || '').slice(0, 1500) },
  ]);
  const answer = body.answer || '';
  await checkCommon(tag, body, { governing: PIT });
  record('6', `${tag}: answered from Regulation 2(1)(d)`, /Regulation 2\(1\)\(d\)/.test(answer), firstSentence(section(answer, 'Overview')).slice(0, 160));
}

(async () => {
  let insiderAnswer = '';
  for (let run = 1; run <= REPEAT; run += 1) {
    const [insider] = await Promise.all([checkInsider(run), checkDesignated(run), checkUpsi(run)]);
    insiderAnswer = insider.answer;
  }
  await Promise.all([checkExporter(), checkOpenOffer(), checkHistorical(), checkNoAuthority()]);
  await Promise.all([checkControl(), checkFollowUp(insiderAnswer)]);

  if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(saved, null, 2));

  const byPoint = new Map();
  for (const item of results) {
    if (!byPoint.has(item.point)) byPoint.set(item.point, []);
    byPoint.get(item.point).push(item);
  }
  const TITLES = {
    1: 'Outdated / incorrect legal provisions', 2: 'Source prioritisation', 3: 'Legislation retrieval',
    4: 'Citation / source grounding', 5: 'Verbosity', 6: 'Legal-definition handling', 7: 'Conceptual categorisation',
    C1: 'Retrieval layer (priority, version filtering, amendments)', C2: 'Legislation metadata', C4: 'Definitions read from the instrument',
  };
  let failed = 0;
  for (const point of [...byPoint.keys()].sort()) {
    const items = byPoint.get(point);
    const passes = items.filter((i) => i.pass).length;
    console.log(`\n${point}. ${TITLES[point] || ''}  —  ${passes}/${items.length} passed`);
    for (const item of items) {
      if (!item.pass) failed += 1;
      console.log(`  ${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass && !/words|checked|%/.test(item.detail) ? '' : item.detail ? `  [${item.detail}]` : ''}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error('The check could not run:', error);
  process.exit(2);
});
