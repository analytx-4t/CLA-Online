/**
 * citations.js
 *
 * Turns the retrieved chunks and the model's draft answer into what the chat shows:
 *   - the numbered context block the model answers from ([Source N] per retrieved chunk)
 *   - an answer whose inline markers are [1], [2] ... matching a numbered source list
 *   - a source list holding only the documents the answer actually cites, most relevant first
 *
 * Everything here is pure (no network, no database) so it can be unit-tested.
 */

const NO_ANSWER_TEXT = 'I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question.';
const DISCLAIMER_TEXT = 'This is legal research, not legal advice. Please verify against the primary source.';

const SOURCE_TYPE_LABELS = [
  [/legis/i, 'Legislation'],
  [/case/i, 'Case law'],
  [/notif/i, 'Notification'],
  [/circ/i, 'Circular'],
  [/comm/i, 'Commentary'],
  [/proc/i, 'Procedure'],
  [/art/i, 'Article'],
  [/query/i, 'Expert query'],
  [/book/i, 'Book'],
];

// Sources shown when the model answered from the context but wrote no inline markers.
const UNCITED_FALLBACK_SOURCES = 3;
const EXCERPT_LENGTH = 320;
const PASSAGE_TEXT_LENGTH = 1600;

function isNoAnswer(text) {
  return /could not find authority/i.test(String(text || ''));
}

function sourceTypeLabel(sourceTable, isBook) {
  if (isBook) return 'Book';
  const table = String(sourceTable || '');
  for (const [pattern, label] of SOURCE_TYPE_LABELS) {
    if (pattern.test(table)) return label;
  }
  return table || 'Source';
}

function isBookResult(r) {
  return Boolean(r && (r.is_book || r.source_table === 'CLA Books' || r.database_source === 'Pinecone_Books'));
}

// The source data has characters that were lost before indexing and now read as U+FFFD.
// Restore the likeliest punctuation so excerpts and source pages read cleanly.
function repairLostCharacters(text) {
  return String(text || '')
    .replace(/(\p{L})�(\p{L})/gu, '$1’$2')
    .replace(/�(?=\p{L}|\d)/gu, '“')
    .replace(/(?<=\p{L}|\d|[.,;:)])�/gu, '”')
    .replace(/\s�(?=\s|$)/gu, ' —')
    .replace(/�/g, '');
}

function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// Passage text of a retrieved chunk without the "[Table | Title: ... ]" context header.
function chunkBody(r) {
  if (!r) return '';
  if (typeof r.chunk_body === 'string' && r.chunk_body.trim()) return r.chunk_body;
  const text = String(r.chunk_text || r.content || r.text || '');
  if (!text.startsWith('[')) return text;
  const end = text.indexOf(']\n');
  return end === -1 ? text : text.slice(end + 1).replace(/^[\r\n]+/, '');
}

function truncateAtSentence(text, maxLength = EXCERPT_LENGTH) {
  const clean = collapseWhitespace(repairLostCharacters(text));
  if (clean.length <= maxLength) return clean;
  const slice = clean.slice(0, maxLength);
  const lastSentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('; '), slice.lastIndexOf('? '));
  if (lastSentenceEnd > maxLength * 0.5) return slice.slice(0, lastSentenceEnd + 1).trim();
  const lastSpace = slice.lastIndexOf(' ');
  return `${(lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim()}…`;
}

function cleanBookTitle(name) {
  return collapseWhitespace(String(name || '').replace(/\.pdf$/i, '').replace(/_PRINT(?:\s*\(\d+\))?(?:_\d+)?$/i, '').replace(/_/g, ' '));
}

// The name a reader would recognise the source by.
function displayTitle(r) {
  const title = collapseWhitespace(r.doc_title || r.law_title || r.subject || '');
  if (isBookResult(r)) return cleanBookTitle(r.doc_title || r.file_name || 'CLA reference book');
  const table = String(r.source_table || '');
  if (/case/i.test(table) && r.citation && !title.includes(r.citation)) return `${title} ${r.citation}`;
  if (/comm/i.test(table) && r.law_title && r.law_title !== r.doc_title) {
    return `${collapseWhitespace(r.law_title)} — ${collapseWhitespace(r.sections || title)}`;
  }
  return title || `${table} #${r.record_id}`;
}

// Chunks of the same document (or the same book page) are one source.
function documentKey(r) {
  if (isBookResult(r)) return `book|${r.file_name || r.doc_title}|${r.page_number || r.parent_id || ''}`;
  return `${r.source_table}|${r.record_id}`;
}

function relevanceOf(r) {
  for (const value of [r.cohere_relevance_score, r.backend_relevance_score, r.score]) {
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function rankingScoreOf(r) {
  return Number.isFinite(r.backend_relevance_score) ? r.backend_relevance_score : relevanceOf(r);
}

/**
 * The numbered context the model answers from. Source N is results[N - 1].
 */
function buildContextBlock(results) {
  return (results || []).map((r, idx) => {
    const parts = [`[Source ${idx + 1}]`, `Type: ${sourceTypeLabel(r.source_table, isBookResult(r))}`, `Title: "${displayTitle(r)}"`];
    if (r.sections && !/^(general|\d+)$/i.test(String(r.sections).trim())) parts.push(`Sections: ${collapseWhitespace(r.sections)}`);
    if (isBookResult(r) && (r.page_number || r.parent_id)) parts.push(`Page: ${r.page_number || r.parent_id}`);
    if (r.doc_date && !/legis/i.test(String(r.source_table || '')) && !isBookResult(r)) parts.push(`Date: ${String(r.doc_date).slice(0, 10)}`);
    return `${parts.join(' | ')}\nContent: ${chunkBody(r)}`;
  }).join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Inline markers
// ---------------------------------------------------------------------------

// [Source 3], [Sources 3, 4], [Source 3, Source 4], [3], [3, 4], [3-5] and runs of them.
// One or two digits only, so law-report years such as [2013] are never read as a marker.
const MARKER_BODY = '(?:Sources?\\s*)?\\d{1,2}(?:\\s*(?:,|;|&|and|-|\\u2013)\\s*(?:Sources?\\s*)?\\d{1,2})*';
const MARKER_RUN_RE = new RegExp(`\\s*(?:\\[\\s*${MARKER_BODY}\\s*\\]\\s*)+`, 'gi');
const SINGLE_MARKER_RE = new RegExp(`\\[\\s*(${MARKER_BODY})\\s*\\]`, 'gi');

function numbersInMarkerRun(run) {
  const numbers = [];
  SINGLE_MARKER_RE.lastIndex = 0;
  let match;
  while ((match = SINGLE_MARKER_RE.exec(run)) !== null) {
    const body = match[1];
    const rangeRe = /(\d{1,2})\s*(?:-|–)\s*(?:Sources?\s*)?(\d{1,2})/g;
    let range;
    const covered = new Set();
    while ((range = rangeRe.exec(body)) !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to >= from && to - from <= 6) {
        for (let n = from; n <= to; n += 1) numbers.push(n);
        covered.add(range[1]).add(range[2]);
      }
    }
    for (const n of body.match(/\d{1,2}/g) || []) numbers.push(Number(n));
  }
  return [...new Set(numbers)];
}

// ---------------------------------------------------------------------------
// Does the cited passage actually support the sentence?
// ---------------------------------------------------------------------------

const SUPPORT_STOP_WORDS = new Set((
  'the a an and or of to for in on at by with from as is are was were be been being this that these those it its ' +
  'which who whom whose what when where how why not no nor but if then than so such can may must shall will would ' +
  'should could has have had do does did under over into upon within without also any all each every other more most ' +
  'only same own per about after before between through during above below there here their them they his her our your ' +
  'act section sections rule rules company companies law provides provided means where applicable accordance respect ' +
  'case held court person persons one two made make given'
).split(/\s+/));

function supportTokens(text) {
  const tokens = new Map();
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/\*\*|==|__|`/g, ' ')
    .replace(/[^a-z0-9()\-\s]/g, ' ');
  for (const raw of normalized.split(/\s+/)) {
    const token = raw.replace(/^[()\-]+|[()\-]+$/g, '');
    if (!token) continue;
    const hasDigit = /\d/.test(token);
    if (!hasDigit && (token.length < 4 || SUPPORT_STOP_WORDS.has(token))) continue;
    // Section numbers, form numbers and years are what make a legal sentence specific.
    tokens.set(token, hasDigit ? 2 : 1);
    if (!hasDigit && token.length > 6) tokens.set(token.slice(0, 6), 1);
  }
  return tokens;
}

function supportScore(sentenceTokens, passageTokens) {
  let total = 0;
  let matched = 0;
  for (const [token, weight] of sentenceTokens) {
    total += weight;
    if (passageTokens.has(token)) matched += weight;
  }
  return total > 0 ? matched / total : 0;
}

// The sentence (or list item) a marker closes.
function sentenceBefore(text, position) {
  const before = text.slice(Math.max(0, position - 700), position);
  const lineStart = before.lastIndexOf('\n') + 1;
  let segment = before.slice(lineStart);
  const previousMarker = [...segment.matchAll(/\]\s*[.;]?\s+(?=[A-Z(“"*=])/g)].pop();
  const sentenceBreaks = [...segment.matchAll(/(?<![A-Z]|\b(?:v|vs|s|ss|no|nos|sec|reg|cl|art|ltd|co|pvt|p|pp|etc|viz|ie|eg|mr|dr|bom|del|cal|mad|ker|guj))[.?!]["”)]?\s+(?=[A-Z(“"*=])/gi)];
  const lastBreak = sentenceBreaks.pop();
  const cut = Math.max(
    lastBreak ? lastBreak.index + lastBreak[0].length : 0,
    previousMarker ? previousMarker.index + previousMarker[0].length : 0
  );
  segment = segment.slice(cut);
  return collapseWhitespace(segment.replace(/^[-*\d.)\s]+/, ''));
}

const REATTRIBUTE_MIN_SCORE = 0.5;   // another passage must cover at least half the sentence
const REATTRIBUTE_MARGIN = 0.3;      // ...and clearly beat the cited one
const UNSUPPORTED_MAX_SCORE = 0.12;  // below this the cited passage shares almost nothing with the sentence
const MIN_TOKENS_TO_JUDGE = 4;

/**
 * Checks one marker against the passages it cites. Keeps supported citations, swaps in a
 * passage that plainly supports the sentence better, and drops a citation only when the
 * cited passage shares essentially nothing with the sentence.
 */
function verifyMarker(sentence, citedIndices, passageTokenList) {
  const sentenceTokens = supportTokens(sentence);
  let weight = 0;
  for (const w of sentenceTokens.values()) weight += w;
  if (sentenceTokens.size < MIN_TOKENS_TO_JUDGE || weight < 5) return citedIndices;

  const scores = passageTokenList.map((tokens) => supportScore(sentenceTokens, tokens));
  const kept = citedIndices.filter((idx) => scores[idx] > UNSUPPORTED_MAX_SCORE);
  if (kept.length === citedIndices.length) return citedIndices;

  const bestCited = Math.max(0, ...citedIndices.map((idx) => scores[idx]));
  let bestOther = -1;
  for (let idx = 0; idx < scores.length; idx += 1) {
    if (citedIndices.includes(idx)) continue;
    if (bestOther === -1 || scores[idx] > scores[bestOther]) bestOther = idx;
  }
  if (bestOther !== -1 && scores[bestOther] >= REATTRIBUTE_MIN_SCORE && scores[bestOther] - bestCited >= REATTRIBUTE_MARGIN) {
    return [...kept, bestOther];
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Answer text clean-up
// ---------------------------------------------------------------------------

const MAIN_HEADINGS = ['Overview', 'Analysis', 'Conclusion'];

function headingText(line) {
  return line.trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)\s*:?$/, '$1')
    .replace(/\s*:$/, '')
    .trim();
}

function isStandaloneHeadingLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 140) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  return /^(?:\*\*|__)[^*_].*?(?:\*\*|__)\s*:?$/.test(trimmed) && !/[.;]$/.test(headingText(trimmed));
}

/**
 * Main headings (Overview / Analysis / Conclusion) become "## Heading"; any other standalone
 * heading becomes "### Heading", so the chat can style the two levels differently.
 * A trailing "Sources Used" list is dropped: the chat renders the source list itself.
 */
function normalizeAnswerStructure(answer) {
  const lines = String(answer || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let skippingSources = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const bare = headingText(trimmed);
    const main = MAIN_HEADINGS.find((h) => h.toLowerCase() === bare.toLowerCase());
    const looksLikeHeading = isStandaloneHeadingLine(line) || (main && trimmed.length <= bare.length + 8);

    if (/^sources?(?:\s+used|\s+relied\s+on|\s+cited)?$/i.test(bare) && (looksLikeHeading || trimmed.length <= bare.length + 8)) {
      skippingSources = true;
      continue;
    }
    if (skippingSources) {
      if (trimmed.includes('not legal advice')) {
        skippingSources = false;
        out.push(trimmed);
      } else if (main && looksLikeHeading) {
        skippingSources = false;
        out.push(`## ${main}`);
      }
      continue;
    }

    if (main && looksLikeHeading) {
      out.push(`## ${main}`);
    } else if (isStandaloneHeadingLine(line)) {
      out.push(`### ${bare}`);
    } else {
      out.push(line);
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Sentences that talk about the research process instead of the law. The answer has to read
// as a standalone piece, so these are removed if the model writes them anyway.
const META_SENTENCE_PATTERNS = [
  /\b(?:the|this|our)\s+(?:CLAOnline\s+)?database\b/i,
  /\bCLAOnline\s+database\b/i,
  /\b(?:retrieved|supplied)\s+(?:material|materials|sources?|documents?|chunks?|context|excerpts?|text|authorit(?:y|ies))\b/i,
  /\b(?:search|provided|supplied)\s+context\b/i,
  /\bsource\s+agents?\b/i,
  /\bgaps?\s+in\s+(?:the|this)\s+(?:analysis|answer|research|sources?|material|record|authorit(?:y|ies))\b/i,
  /\bsources?\s+(?:provided|available|supplied)\s+(?:here\s+)?(?:do|does|did)\s+not\b/i,
  /\b(?:not|nothing)\s+(?:covered|contained|available|found|addressed|located)\s+(?:in|by|among)\s+(?:the\s+)?(?:available\s+|provided\s+)?(?:sources?|material|materials|documents?)\b/i,
  /\bcould\s+not\s+be\s+(?:confirmed|verified|located|found)\s+(?:in|from|among)\s+(?:the\s+)?(?:available\s+|provided\s+)?(?:sources?|material|materials|documents?)\b/i,
  /\bbased\s+(?:solely\s+)?on\s+the\s+(?:provided|available|retrieved|supplied)\b/i,
  /\b(?:passages?|materials?|sources?|documents?|excerpts?|extracts?)\s+(?:provided|supplied|available|given|above|cited|here)\b[^.]*\b(?:do(?:es)?|did)\s+not\b/i,
  /\bthe\s+(?:material|passages?|excerpts?|extracts?)\s+(?:describes?|addresses?|covers?|sets?\s+out|deals?\s+with|do(?:es)?\s+not)\b/i,
  /\b(?:do|does|did)\s+not\s+(?:address|set\s+out|contain|cover|deal\s+with|state|specify|answer)\b[^.]*\b(?:you\s+have\s+raised|your\s+question|the\s+question\s+(?:asked|raised))\b/i,
  /\b(?:cannot|can\s+not|could\s+not)\s+be\s+answered\s+from\b/i,
];
const DANGLING_FOLLOW_UP = /^(?:that|this|such)\s+(?:material|note|source|content)\b/i;

const SENTENCE_BOUNDARY_RE = /(?<![A-Z]|\b(?:v|vs|s|ss|no|nos|sec|reg|cl|art|ltd|co|pvt|p|pp|etc|viz|ie|eg|mr|dr|bom|del|cal|mad|ker|guj))[.?!]["”)]*(?:\s*\[[^\]]{1,40}\])*(?=\s+[A-Z(“"*=[]|\s*$)/gi;

function splitSentences(text) {
  const sentences = [];
  let start = 0;
  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  let match;
  while ((match = SENTENCE_BOUNDARY_RE.exec(text)) !== null) {
    const end = match.index + match[0].length;
    sentences.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) sentences.push(text.slice(start));
  return sentences;
}

function stripMetaCommentary(answer) {
  if (isNoAnswer(answer) && String(answer).trim().length < 200) return answer;

  const lines = String(answer || '').split('\n');
  const kept = [];
  for (const line of lines) {
    if (!line.trim() || /^#{1,6}\s/.test(line.trim()) || line.includes('not legal advice')) {
      kept.push(line);
      continue;
    }
    if (!META_SENTENCE_PATTERNS.some((pattern) => pattern.test(line))) {
      kept.push(line);
      continue;
    }
    const prefix = (line.match(/^\s*(?:[-*]\s+|\d+[.)]\s+|>\s*)/) || [''])[0];
    const sentences = splitSentences(line.slice(prefix.length));
    const survivors = [];
    let removedPrevious = false;
    for (const sentence of sentences) {
      const text = sentence.trim().replace(/^\(/, '');
      const isMeta = META_SENTENCE_PATTERNS.some((pattern) => pattern.test(sentence));
      if (isMeta || (removedPrevious && DANGLING_FOLLOW_UP.test(text))) {
        removedPrevious = true;
        continue;
      }
      removedPrevious = false;
      survivors.push(sentence);
    }
    const rebuilt = survivors.join('').trim();
    if (rebuilt) kept.push(prefix + rebuilt);
  }

  // A heading whose content was removed entirely goes too.
  const result = [];
  for (let i = 0; i < kept.length; i += 1) {
    const line = kept[i];
    if (/^###\s/.test(line.trim())) {
      let j = i + 1;
      while (j < kept.length && !kept[j].trim()) j += 1;
      if (j >= kept.length || /^#{1,6}\s/.test(kept[j].trim()) || kept[j].includes('not legal advice')) continue;
    }
    result.push(line);
  }
  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// True when a structured answer has nothing left under Analysis or Conclusion. That happens
// when the model had no on-point material and wrote only about what was missing: the reader
// should get the plain "could not find authority" reply, not an empty shell.
function isHollowAnswer(answer) {
  const text = String(answer || '');
  const bodyOf = (heading) => {
    const start = text.search(new RegExp(`^## ${heading}\\s*$`, 'm'));
    if (start === -1) return null;
    const rest = text.slice(start).replace(/^## .*\n?/, '');
    const next = rest.search(/^## /m);
    return (next === -1 ? rest : rest.slice(0, next))
      .split('\n')
      .filter((line) => !/^#{1,6}\s/.test(line.trim()) && !line.includes('not legal advice'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  };
  const analysis = bodyOf('Analysis');
  const conclusion = bodyOf('Conclusion');
  return (analysis !== null && analysis.length < 60) || (conclusion !== null && conclusion.length < 30);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function buildSource(group, number) {
  const lead = group.chunks[0];
  const isBook = isBookResult(lead);
  const fileName = lead.file_name || lead.filename || null;
  const pageNumber = isBook ? (lead.page_number || lead.parent_id || 1) : null;
  const passages = group.chunks.map((r) => ({
    embedding_id: r.embedding_id || null,
    chunk_index: Number.isFinite(r.chunk_index) ? r.chunk_index : null,
    excerpt: truncateAtSentence(chunkBody(r)),
    // The whole passage, so the chat can show the sentence that supports a given claim.
    text: collapseWhitespace(repairLostCharacters(chunkBody(r))).slice(0, PASSAGE_TEXT_LENGTH),
    relevance: Number(relevanceOf(r).toFixed(4)),
  }));
  const meaningfulSections = lead.sections && !/^(general|\d+)$/i.test(String(lead.sections).trim())
    ? collapseWhitespace(repairLostCharacters(lead.sections)) : null;

  return {
    number,
    title: repairLostCharacters(displayTitle(lead)),
    type_label: sourceTypeLabel(lead.source_table, isBook),
    source_table: isBook ? 'CLA Books' : (lead.source_table || 'Unknown'),
    record_id: lead.record_id,
    parent_id: lead.parent_id,
    embedding_id: passages[0].embedding_id,
    passages,
    excerpt: passages[0].excerpt,
    is_book: isBook,
    filename: fileName,
    file_name: fileName,
    page_number: pageNumber,
    page_no: pageNumber,
    s3_url: null,
    database_source: lead.database_source || (isBook ? 'Pinecone_Books' : 'Pinecone_DB'),
    law_title: lead.law_title || null,
    citation: lead.citation || null,
    court: lead.court || null,
    sections: meaningfulSections,
    category: isBook ? 'Book' : (lead.category || null),
    subject: isBook ? null : (lead.subject && lead.subject !== lead.doc_title ? lead.subject : null),
    doc_date: /legis/i.test(String(lead.source_table || '')) || isBook ? null : (lead.doc_date || null),
    author: lead.author || null,
    score: Number(group.relevance.toFixed(4)),
  };
}

/**
 * Final answer + source list.
 *
 * @param {string} answerText  Model answer with [Source N] / [N] markers (N = position in results).
 * @param {Array}  results     The retrieved chunks exactly as numbered in the context block.
 * @returns {{answer: string, sources: Array, stats: Object}}
 */
function finalizeAnswer(answerText, results = []) {
  const chunks = Array.isArray(results) ? results : [];
  let answer = normalizeAnswerStructure(String(answerText || ''));

  if (!answer.trim() || (isNoAnswer(answer) && answer.length < 400)) {
    return { answer: answer.trim() || NO_ANSWER_TEXT, sources: [], stats: { cited: 0, noAnswer: true } };
  }

  answer = stripMetaCommentary(answer);
  if (isHollowAnswer(answer)) {
    return { answer: NO_ANSWER_TEXT, sources: [], stats: { cited: 0, noAnswer: true, hollow: true } };
  }

  const passageTokenList = chunks.map((r) => supportTokens(`${displayTitle(r)} ${r.sections || ''} ${chunkBody(r)}`));
  const stats = { markers: 0, dropped: 0, reattributed: 0, cited: 0, noAnswer: false };

  // Pass 1: read every marker, verify it, and remember which chunks it ends up citing.
  const markerPlan = [];
  MARKER_RUN_RE.lastIndex = 0;
  let match;
  while ((match = MARKER_RUN_RE.exec(answer)) !== null) {
    const run = match[0];
    const numbers = numbersInMarkerRun(run);
    const cited = numbers.map((n) => n - 1).filter((idx) => idx >= 0 && idx < chunks.length);
    let verified = cited;
    if (cited.length) {
      stats.markers += 1;
      verified = verifyMarker(sentenceBefore(answer, match.index), cited, passageTokenList);
      const lost = cited.filter((idx) => !verified.includes(idx)).length;
      const gained = verified.filter((idx) => !cited.includes(idx)).length;
      stats.reattributed += gained;
      stats.dropped += Math.max(0, lost - gained);
    }
    markerPlan.push({ start: match.index, end: match.index + run.length, run, chunkIndices: verified });
  }

  // Group the cited chunks into documents and rank the documents by relevance.
  const groups = new Map();
  for (const marker of markerPlan) {
    for (const idx of marker.chunkIndices) {
      const key = documentKey(chunks[idx]);
      if (!groups.has(key)) groups.set(key, { key, chunkIndexSet: new Set(), citeCount: 0 });
      groups.get(key).chunkIndexSet.add(idx);
    }
    for (const key of new Set(marker.chunkIndices.map((idx) => documentKey(chunks[idx])))) {
      groups.get(key).citeCount += 1;
    }
  }

  let ranked = [...groups.values()].map((group) => {
    const groupChunks = [...group.chunkIndexSet].sort((a, b) => relevanceOf(chunks[b]) - relevanceOf(chunks[a])).map((idx) => chunks[idx]);
    return {
      ...group,
      chunks: groupChunks,
      relevance: Math.max(...groupChunks.map(relevanceOf)),
      ranking: Math.max(...groupChunks.map(rankingScoreOf)),
    };
  }).sort((a, b) => (b.ranking - a.ranking) || (b.citeCount - a.citeCount));

  // The model answered from the context but left out markers: list the top documents.
  if (ranked.length === 0 && chunks.length > 0) {
    const seen = new Set();
    for (const r of [...chunks].sort((a, b) => rankingScoreOf(b) - rankingScoreOf(a))) {
      const key = documentKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push({ key, chunks: [r], relevance: relevanceOf(r), ranking: rankingScoreOf(r), citeCount: 0 });
      if (ranked.length >= UNCITED_FALLBACK_SOURCES) break;
    }
  }

  const numberByKey = new Map(ranked.map((group, i) => [group.key, i + 1]));
  const sources = ranked.map((group, i) => buildSource(group, i + 1));

  // Pass 2: rewrite the markers as [n] using the final numbering.
  let rebuilt = '';
  let cursor = 0;
  for (const marker of markerPlan) {
    rebuilt += answer.slice(cursor, marker.start);
    const numbers = [...new Set(marker.chunkIndices.map((idx) => numberByKey.get(documentKey(chunks[idx]))))]
      .filter(Boolean)
      .sort((a, b) => a - b);
    const trailingSpace = /\s$/.test(marker.run) ? marker.run.match(/\s+$/)[0] : '';
    rebuilt += numbers.length ? ` ${numbers.map((n) => `[${n}]`).join('')}${trailingSpace}` : trailingSpace;
    cursor = marker.end;
  }
  rebuilt += answer.slice(cursor);

  answer = rebuilt
    .replace(/[ \t]+([.,;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!answer.includes('not legal advice')) {
    answer = `${answer}\n\n${DISCLAIMER_TEXT}`;
  }

  stats.cited = sources.length;
  return { answer, sources, stats };
}

module.exports = {
  NO_ANSWER_TEXT,
  DISCLAIMER_TEXT,
  isNoAnswer,
  sourceTypeLabel,
  repairLostCharacters,
  cleanBookTitle,
  displayTitle,
  chunkBody,
  truncateAtSentence,
  buildContextBlock,
  normalizeAnswerStructure,
  stripMetaCommentary,
  isHollowAnswer,
  supportTokens,
  supportScore,
  finalizeAnswer,
};
