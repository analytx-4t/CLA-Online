/**
 * answerVerifier.js
 *
 * The check an answer passes before it is shown: every sentence that cites a passage is
 * compared with that passage by a second model.
 *
 *   SUPPORTED     a cited passage states the proposition            -> keep (drop any cited passage that does not)
 *   WRONG_SOURCE  another passage states it, the cited one does not -> cite the passage that does
 *   UNSUPPORTED   no passage states it                              -> remove the sentence
 *   NOT_CURRENT   stated as today's law but resting only on material that is not current,
 *                 or on an article / book that the primary text contradicts -> remove the sentence
 *   (figure guard) a threshold or time limit that no cited passage states -> cite the passage
 *                 that states it, or remove the sentence if none does (deterministic, no model)
 *   NOT_AUTHORITY stated as settled law but resting only on a consultation paper, article,
 *                 book or commentary, without saying so                    -> remove the sentence
 *
 * And where a sentence cites binding and non-binding passages together, the non-binding ones
 * are dropped from the citation: the rule is cited to the law, not to an article repeating it.
 *
 * planVerification() and applyVerification() are pure; verifyAnswer() adds the model call.
 */

const { locateCitedSentences, splitSentences, chunkBody, displayTitle, sourceTypeLabel, supportTokens, supportScore } = require('./citations');
const { digitsIn, figuresIn, statesFigure } = require('./legalFigures');

const VERDICTS = ['SUPPORTED', 'WRONG_SOURCE', 'UNSUPPORTED', 'NOT_CURRENT', 'NOT_AUTHORITY'];
const REMOVING_VERDICTS = new Set(['UNSUPPORTED', 'NOT_CURRENT', 'NOT_AUTHORITY']);
// Passages that state or interpret the law with binding force (see legalAuthority.js).
const BINDING_TIERS = new Set(['legislation', 'notification', 'circular', 'caselaw']);
const MAX_PASSAGE_CHARS = 3200;
const MAX_CLAIMS = 60;
// If the checker wants most of the answer removed, something is wrong with the check (or
// the answer has no basis at all). Either way removing sentences one by one is the wrong fix.
const MAX_REMOVED_SHARE = 0.5;
const VERIFIER_MAX_TOKENS = 3000;

const VERIFIER_SYSTEM_PROMPT = `You check a draft legal answer against the passages it was written from. You do not rewrite the answer and you add no law of your own.

You receive PASSAGES (numbered; each has a type, sometimes an "Authority" line and a "Currency" line, and its text) and CLAIMS (numbered sentences from the draft, each with the passage numbers it cites).

First decide what kind of sentence each claim is:
- STATEMENT OF SOURCE: it says what a provision, definition, notification, circular, case or other document provides: its wording, limbs, lists, numbers, thresholds, time limits, dates, provision numbers or holding.
- REASONING: it applies the law to the question, draws a conclusion, says whether something falls within a definition, or links points made elsewhere in the answer.

Then give ONE verdict:
- SUPPORTED: a statement of source that at least one cited passage states (a faithful paraphrase counts); or reasoning that follows from the passages and contradicts none of them. In "sources" list the cited passages that actually bear it out.
- WRONG_SOURCE: a statement of source that no cited passage states but another passage does. In "sources" list the passage(s) that do.
- UNSUPPORTED: a statement of source that no passage states, or that the passages state differently (a different number, threshold, time limit, provision number, or a list item the passage does not contain); or reasoning that contradicts a passage, or that depends on a rule, number, provision or category found in no passage.
- NOT_CURRENT: the claim presents something as the law today, but the only passages stating it carry a Currency line marking them as about a replaced instrument or as pre-dating the governing one; or it rests on an article, book, commentary or regulator paper while a primary-law passage states the point differently (for example a different period or threshold in a later amendment).
- NOT_AUTHORITY: the claim states a rule, test or holding as settled law, but the only passages bearing it out are of type Article, Book, Commentary, Expert query, or a regulator paper (a consultation paper, discussion paper, committee report, press release or guidance note: see the Authority line), and the sentence does not say that this is what such a paper or author proposes or suggests. A sentence that openly attributes the view ("a SEBI discussion paper proposed that ...", "commentary suggests ...") is SUPPORTED.

Rules:
1. Be strict with statements of source. A passage on the same topic that does not state the claim does not support it. A provision number, percentage, amount, period or list in the claim must appear in the passage.
2. Be fair to reasoning. A conclusion, an application of a definition to the question, or a sentence explaining how two provisions relate is SUPPORTED when it is consistent with the passages, even though no passage says it in those words. When unsure about reasoning, choose SUPPORTED.
3. A claim about what a provision or definition says should cite the primary-law passage (type Legislation, Notification or Circular) when one states it: put that passage first in "sources", and leave out an article, book or paper that merely repeats it.
4. A claim that a class of persons is a "category", "type" or "sub-set" of a statutorily defined term is UNSUPPORTED unless the statutory definition itself lists that class. The opposite claim (that such a class is a compliance category and falls within the definition only if a limb is met) is reasoning and is SUPPORTED when the definition does not list the class.
5. Where two passages give different figures for the same thing and one is a later amendment or newer primary text, a claim using the older figure as the current position is NOT_CURRENT.
5B. Wording a passage itself says was replaced is not support: the quoted words in "for the words 'X', the words 'Y' shall be substituted", and anything after "prior to substitution it read as". A claim that states X, or the earlier wording, as the law now is NOT_CURRENT. A claim may combine the current text of the instrument with a later amendment only by applying the amendment to that text (the amended words replace the old ones), never by stating both versions as if both applied.
5A. A claim marked "(cites none)" was written without a citation. If it is a statement of source and a passage states it, give WRONG_SOURCE with that passage in "sources" (primary law first). If it is a statement of source that no passage states, give UNSUPPORTED. If it is reasoning consistent with the passages, give SUPPORTED with "sources": [].
6. Judge the same proposition the same way wherever it appears: a point that is SUPPORTED in one claim is SUPPORTED when the Overview or the Conclusion repeats it.
7. Use only passage numbers that exist.

Reply with JSON only, no prose and no code fence:
{"claims":[{"id":1,"verdict":"SUPPORTED","sources":[2]},{"id":2,"verdict":"UNSUPPORTED","sources":[]}]}`;

function passageBlock(results) {
  return (results || []).map((r, idx) => {
    const lines = [`[${idx + 1}] Type: ${sourceTypeLabel(r.source_table, Boolean(r.is_book))} | Title: "${displayTitle(r)}"${r.provision_ref ? ` | Provision: ${r.provision_ref}` : ''}`];
    if (r.authority_label) lines.push(`Authority: ${r.authority_label}`);
    if (r.currency_note) lines.push(`Currency: ${r.currency_note}`);
    lines.push(`Text: ${chunkBody(r).replace(/\s+/g, ' ').trim().slice(0, MAX_PASSAGE_CHARS)}`);
    return lines.join('\n');
  }).join('\n\n');
}

// A sentence that names a provision or gives a figure states law, whether or not it was cited.
const LEGAL_SPECIFIC_RE = new RegExp([
  '\\b(?:sections?|regulations?|rules?|schedule|clause|article|chapter)\\s*\\d',
  '\\d+(?:\\.\\d+)?\\s*(?:%|per\\s*cent|days?|weeks?|months?|years?|lakhs?|crores?)',
  '\\b(?:one|two|three|five|six|seven|nine|ten|twelve|fifteen|eighteen|twenty|thirty|forty|fifty|sixty|ninety)[- ]?(?:one|two|three|four|five|six|seven|eight|nine)?\\s+(?:per\\s*cent|days?|weeks?|months?|years?)',
  '\\b(?:rs\\.?|inr|usd)\\s*\\d',
].join('|'), 'i');
const ANY_MARKER_RE = /\[\s*(?:Sources?\s*)?\d{1,2}[^\]\n]{0,24}\]/i;
const MIN_UNCITED_SENTENCE_CHARS = 40;

/**
 * Sentences that state something specific about the law (a provision number, a threshold,
 * a time limit) but carry no citation. They are checked like cited ones: a claim nobody
 * attributed to a source is the one most likely to have come from outside the sources.
 */
function locateUncitedStatements(answer) {
  const located = [];
  let offset = 0;
  for (const line of String(answer || '').split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || trimmed.includes('not legal advice')) continue;
    const prefix = (line.match(/^\s*(?:[-*]\s+|\d+[.)]\s+|>\s*)?/) || [''])[0];
    let position = lineStart + prefix.length;
    for (const sentence of splitSentences(line.slice(prefix.length))) {
      const start = position + (sentence.length - sentence.trimStart().length);
      const end = position + sentence.trimEnd().length;
      position += sentence.length;
      const text = sentence.trim();
      if (text.length < MIN_UNCITED_SENTENCE_CHARS || ANY_MARKER_RE.test(text) || !LEGAL_SPECIFIC_RE.test(text)) continue;
      const closing = (text.match(/(?:==)?[.?!]["\u201d)]*$/) || [''])[0];
      located.push({
        start,
        markerStart: end - closing.length,
        end,
        markerRun: '',
        sentence: text.slice(0, text.length - closing.length).replace(/==/g, '').replace(/\s+/g, ' ').trim(),
        numbers: [],
        uncited: true,
      });
    }
  }
  return located;
}

/** The claims to check, numbered, and the user message for the checker. */
function planVerification(answer, results) {
  const passageCount = (results || []).length;
  const cited = locateCitedSentences(answer)
    .map((claim) => ({ ...claim, numbers: claim.numbers.filter((n) => n >= 1 && n <= passageCount) }))
    .filter((claim) => claim.numbers.length > 0 && claim.sentence.length >= 20);
  const claims = [...cited, ...locateUncitedStatements(answer)]
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_CLAIMS)
    .map((claim, index) => ({ ...claim, id: index + 1 }));

  const claimLines = claims.map((c) => `${c.id}. (cites ${c.uncited ? 'none' : c.numbers.join(', ')}) ${c.sentence}`).join('\n');
  const userMessage = `PASSAGES\n\n${passageBlock(results)}\n\nCLAIMS\n\n${claimLines}`;
  return { claims, userMessage };
}

function parseVerdicts(text, claims, passageCount) {
  const raw = String(text || '');
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd <= jsonStart) throw new Error('The checker did not return JSON.');
  const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  if (!parsed || !Array.isArray(parsed.claims)) throw new Error('The checker returned no "claims" array.');

  const byId = new Map();
  for (const item of parsed.claims) {
    const id = Number(item && item.id);
    const verdict = String((item && item.verdict) || '').toUpperCase();
    if (!Number.isInteger(id) || !VERDICTS.includes(verdict)) continue;
    const sources = [...new Set((Array.isArray(item.sources) ? item.sources : []).map(Number))]
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= passageCount);
    byId.set(id, { verdict, sources });
  }
  // A claim the checker skipped is left exactly as the model wrote it.
  return reconcileRepeats(claims.map((claim) => ({ claim, ...(byId.get(claim.id) || { verdict: 'SUPPORTED', sources: claim.numbers }) })));
}

const REPEATED_CLAIM_OVERLAP = 0.75;

/**
 * The same proposition is often stated in the Overview, the Analysis and the Conclusion. If
 * the checker confirmed it once and rejected a repeat of it, the repeat takes the confirmed
 * verdict and its sources: one proposition cannot be both supported and unsupported.
 */
function reconcileRepeats(verdicts) {
  const confirmed = verdicts
    .filter((v) => !REMOVING_VERDICTS.has(v.verdict) && v.sources.length > 0)
    .map((v) => ({ tokens: supportTokens(v.claim.sentence), sources: v.sources }));
  return verdicts.map((item) => {
    if (!REMOVING_VERDICTS.has(item.verdict) && item.sources.length > 0) return item;
    const tokens = supportTokens(item.claim.sentence);
    const match = confirmed.find((c) => supportScore(tokens, c.tokens) >= REPEATED_CLAIM_OVERLAP);
    return match ? { ...item, verdict: 'SUPPORTED', sources: match.sources, reconciled: true } : item;
  });
}

/**
 * The figure guard. Independently of the checker model, every threshold or time limit in a
 * checked sentence ("25%", "nine months") must be stated by a passage the sentence cites.
 * If it is not, the citation moves to a passage that does state it, binding authority first;
 * if no passage states it, the sentence has no basis and is removed. Figures the user gave
 * in the question ("holds 18%", "16 months ago") are facts of the question, not law.
 */
// "for the words 'fifteen months', the words 'nine months' shall be substituted": the first
// quotation is the superseded wording. It is removed before a passage is read as support.
const REPLACED_WORDING_RE = /\bfor the (?:words?|figures?|expressions?|letters?|brackets?)(?:\s*(?:,|and)\s*(?:words?|figures?|letters?))*\s*,?\s*["\u201c\u2018'][^"\u201d\u2019']{1,300}["\u201d\u2019']/gi;
const PRIOR_WORDING_RE = /(?:prior to (?:its |the )?(?:substitution|omission|amendment)|before (?:its )?substitution)[^.]{0,40}?(?:read|stood) as(?: under)?\s*[:\-]?\s*["\u201c][^"\u201d]{1,2000}["\u201d]/gi;

function currentWordingOf(text) {
  return String(text || '').replace(REPLACED_WORDING_RE, ' ').replace(PRIOR_WORDING_RE, ' ');
}

function guardFigures(verdicts, results, question = '') {
  const passages = (results || []).map((r) => digitsIn(currentWordingOf(`${r.provision_ref || ''} ${chunkBody(r)}`)));
  if (!passages.length) return verdicts;
  const given = new Set(figuresIn(question).map((f) => `${f.number} ${f.unit}`));
  const isBinding = (n) => BINDING_TIERS.has(((results || [])[n - 1] || {}).authority_tier);
  const states = (n, figures) => figures.every((figure) => statesFigure(passages[n - 1] || '', figure));

  return verdicts.map((item) => {
    if (REMOVING_VERDICTS.has(item.verdict)) return item;
    const figures = figuresIn(item.claim.sentence).filter((f) => !given.has(`${f.number} ${f.unit}`));
    if (!figures.length) return item;
    const cited = item.sources.length ? item.sources : item.claim.numbers;
    // Each figure has to be in at least one of the cited passages.
    const covered = figures.every((figure) => cited.some((n) => statesFigure(passages[n - 1] || '', figure)));
    if (covered) return item;
    const candidates = passages.map((_, i) => i + 1).filter((n) => states(n, figures))
      .sort((a, b) => Number(isBinding(b)) - Number(isBinding(a)) || a - b);
    if (candidates.length) {
      const keep = cited.filter((n) => figures.some((figure) => statesFigure(passages[n - 1] || '', figure)) && isBinding(n));
      return { ...item, verdict: 'WRONG_SOURCE', sources: [...new Set([candidates[0], ...keep])], figureGuard: 'reattributed' };
    }
    return { ...item, verdict: 'UNSUPPORTED', sources: [], figureGuard: 'no passage states the figure' };
  });
}

const PROTECTED_SECTIONS = ['Overview', 'Conclusion'];
const MIN_SECTION_CHARS = 60;

// [{ name, start, end }] for the "## Heading" sections of an answer.
function sectionRanges(answer) {
  const headings = [...String(answer || '').matchAll(/^##\s+(.+?)\s*$/gm)];
  return headings.map((heading, i) => ({
    name: heading[1].trim(),
    start: heading.index,
    end: i + 1 < headings.length ? headings[i + 1].index : answer.length,
  }));
}

// How much text after a removed claim goes with it. A marker in mid-sentence ("X is a
// non-resident [1], so its purchase is FDI.") leaves a clause that depends on the removed
// one: the sentence is removed to its end. Otherwise only its full stop and trailing space go.
function restOfSentenceLength(rest) {
  const continues = /^(?:==)?[ \t]*[,;:\u2014\u2013-]?[ \t]*[a-z(]/.test(rest);
  if (!continues) return rest.match(/^(?:==)?[.;:]?[ \t]*/)[0].length;
  const end = rest.search(/[.?!]["\u201d)]?(?:[ \t]*\[[^\]\n]{1,40}\])*(?=[ \t]|\n|$)|\n/);
  if (end === -1) return rest.length;
  if (rest[end] === '\n') return end;
  const tail = rest.slice(end).match(/^[.?!]["\u201d)]?(?:[ \t]*\[[^\]\n]{1,40}\])*[ \t]*/)[0];
  return end + tail.length;
}

function tidyAfterRemoval(text) {
  return text
    .split('\n')
    // A list item or paragraph that lost its only sentence leaves a bare bullet behind.
    .filter((line) => !/^\s*(?:[-*]|\d+[.)])\s*(?:==\s*==)?\s*$/.test(line))
    .join('\n')
    .replace(/==\s*==/g, '')
    .replace(/^[ \t]*[.;:][ \t]*/gm, '')
    .replace(/([.;:])[ \t]*\.(?=\s|$)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Applies the verdicts to the draft answer.
 * @returns {{ answer: string, stats: Object }}
 */
function applyVerification(answer, verdicts, results = []) {
  // Passage numbers of binding authority. Unknown when the passages carry no authority tier.
  const bindingNumbers = new Set((results || []).map((r, i) => (BINDING_TIERS.has(r && r.authority_tier) ? i + 1 : null)).filter(Boolean));
  const preferBinding = (numbers) => {
    const binding = numbers.filter((n) => bindingNumbers.has(n));
    return binding.length ? binding : numbers;
  };
  const stats = {
    claims: verdicts.length, supported: 0, reattributed: 0, removed: 0, removedSentences: [],
    skippedRemovals: false, keptToPreserveStructure: 0,
    uncitedChecked: verdicts.filter((v) => v.claim.uncited).length, uncitedAttributed: 0,
  };
  // A cited claim whose citation is wrong and which no other passage supports has no basis.
  const isRemoval = (v) => REMOVING_VERDICTS.has(v.verdict) || (!v.claim.uncited && v.verdict === 'WRONG_SOURCE' && v.sources.length === 0);
  const removals = verdicts.filter(isRemoval);
  const tooManyRemovals = verdicts.length > 0 && removals.length / verdicts.length > MAX_REMOVED_SHARE;
  stats.skippedRemovals = tooManyRemovals;

  // The Overview and the Conclusion must still say something after the check: a section is
  // never emptied. (Its sentences then stay as drafted and the log records it.)
  const protectedClaims = new Set();
  for (const section of sectionRanges(answer)) {
    if (!PROTECTED_SECTIONS.includes(section.name)) continue;
    const inSection = verdicts.filter((v) => v.claim.start >= section.start && v.claim.start < section.end);
    const removedLength = inSection.filter(isRemoval).reduce((sum, v) => sum + (v.claim.end - v.claim.start), 0);
    const bodyLength = answer.slice(section.start, section.end).replace(/^##.*$/m, '').replace(/\s+/g, ' ').trim().length;
    if (bodyLength - removedLength < MIN_SECTION_CHARS) {
      for (const v of inSection.filter(isRemoval)) protectedClaims.add(v.claim.id);
    }
  }

  let rebuilt = '';
  let cursor = 0;
  for (const item of verdicts) {
    const { claim, verdict, sources } = item;
    if (claim.start < cursor) continue; // overlapping claim: already handled with the previous one
    if (isRemoval(item) && protectedClaims.has(claim.id)) stats.keptToPreserveStructure += 1;
    const remove = isRemoval(item) && !tooManyRemovals && !protectedClaims.has(claim.id);
    if (remove) {
      rebuilt += answer.slice(cursor, claim.start);
      cursor = claim.end + restOfSentenceLength(answer.slice(claim.end));
      stats.removed += 1;
      stats.removedSentences.push({ verdict, sentence: claim.sentence.slice(0, 300) });
      continue;
    }
    if (claim.uncited) {
      // Reasoning stays as written. A statement of law gets the citation it was missing.
      if (sources.length === 0) { stats.supported += 1; continue; }
      stats.uncitedAttributed += 1;
      rebuilt += `${answer.slice(cursor, claim.markerStart)} ${preferBinding(sources).map((n) => `[Source ${n}]`).join('')}`;
      cursor = claim.markerStart;
      continue;
    }
    const kept = preferBinding(sources.length ? sources : claim.numbers);
    const changed = kept.length !== claim.numbers.length || kept.some((n) => !claim.numbers.includes(n));
    if (changed) stats.reattributed += 1; else stats.supported += 1;
    const trailing = (claim.markerRun.match(/\s+$/) || [''])[0];
    rebuilt += `${answer.slice(cursor, claim.markerStart)} ${kept.map((n) => `[Source ${n}]`).join('')}${trailing}`;
    cursor = claim.end;
  }
  rebuilt += answer.slice(cursor);
  return { answer: stats.removed ? tidyAfterRemoval(rebuilt) : rebuilt, stats };
}

/**
 * Checks a draft answer against its passages and returns the corrected answer.
 * Never throws: if the check cannot run, the draft is returned unchanged with stats.error set.
 *
 * @param {Object} input
 * @param {string} input.answer    draft with [Source N] / [N] markers
 * @param {Array}  input.results   the passages, numbered as in the context block
 * @param {Function} input.generate async ({ systemPrompt, messages, temperature, maxTokens }) => { content }
 */
async function verifyAnswer({ answer, results, generate, question = '' }) {
  const { claims, userMessage } = planVerification(answer, results);
  if (claims.length === 0) return { answer, stats: { claims: 0, supported: 0, reattributed: 0, removed: 0, removedSentences: [] } };

  try {
    const response = await generate({
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      temperature: 0,
      maxTokens: VERIFIER_MAX_TOKENS,
    });
    const verdicts = guardFigures(parseVerdicts(response && response.content, claims, (results || []).length), results, question);
    const outcome = applyVerification(answer, verdicts, results);
    outcome.stats.figureGuard = verdicts.filter((v) => v.figureGuard).map((v) => `${v.figureGuard}: ${v.claim.sentence.slice(0, 90)}`);
    return outcome;
  } catch (error) {
    console.error('[Answer Verifier] Check could not be completed; the draft is used as written:', error.message);
    return { answer, stats: { claims: claims.length, supported: 0, reattributed: 0, removed: 0, removedSentences: [], error: error.message } };
  }
}

module.exports = {
  VERIFIER_SYSTEM_PROMPT,
  planVerification,
  guardFigures,
  currentWordingOf,
  locateUncitedStatements,
  parseVerdicts,
  applyVerification,
  verifyAnswer,
};
