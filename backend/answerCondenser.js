/**
 * answerCondenser.js
 *
 * Keeps answers to the length the client asked for. The answer model is told the limit, but
 * it overshoots on some runs; an instruction is not a guarantee. When a draft is over the
 * limit, a second model shortens it, and the shortened text is accepted only if it is
 * provably a cut-down of the draft: same headings, no citation marker that was not in the
 * draft, and no provision number or figure that was not in the draft. Otherwise the draft
 * is kept as written. The shortened answer then goes through the citation check like any other.
 */

const { figuresIn } = require('./legalFigures');

const SINGLE_ISSUE_WORD_LIMIT = 400;
const MULTI_PART_WORD_LIMIT = 650;
const TOLERANCE = 1.05;          // a draft a few words over is left alone
const TARGET_SHARE = 0.8;        // what each shortening pass aims for, as a share of the limit
const MAX_ATTEMPTS = 2;
const MIN_KEPT_SHARE = 0.45;     // a "shortened" answer under this share of the draft has lost substance
const CONDENSER_MAX_TOKENS = 2200;
const MAIN_HEADINGS = ['## Overview', '## Analysis', '## Conclusion'];

// Two questions in one ("What is X and what are the restrictions on it?"), or a request for a
// procedure. A follow-up that merely opens with "And who ..." is still a single question.
const MULTI_PART_RE = /\?.*\?|\w,?\s+and\s+(?:what|how|when|who|whether)\b|\b(?:procedure|steps?|process|how (?:do|does|can|to|should)|what (?:do|should) (?:we|i) (?:need|do)|comply with)\b/i;

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

/** A question with two parts, or one asking for a procedure, is allowed a longer answer. */
function wordLimitFor(question) {
  return MULTI_PART_RE.test(String(question || '')) ? MULTI_PART_WORD_LIMIT : SINGLE_ISSUE_WORD_LIMIT;
}

const MARKER_RE = /\[\s*(?:Sources?\s*)?(\d{1,2})\s*\]/gi;
const PROVISION_RE = /\b(?:section|regulation|rule|schedule|article)\s+(\d{1,3}[A-Z]{0,2}(?:\(\w{1,3}\))*)/gi;

function markersOf(text) {
  return new Set([...String(text || '').matchAll(MARKER_RE)].map((m) => m[1]));
}

// Provision numbers and figures: the specifics a shortened answer must not invent.
function specificsOf(text) {
  const specifics = new Set();
  for (const match of String(text || '').matchAll(PROVISION_RE)) specifics.add(`provision ${match[1].toLowerCase()}`);
  for (const figure of figuresIn(text)) specifics.add(`figure ${figure.number} ${figure.unit}`);
  return specifics;
}

function condenserPrompt(target, currentWords) {
  return `You shorten a legal research answer without changing what it says.

The answer below is ${currentWords} words. Rewrite it in at most ${target} words: about ${Math.max(20, currentWords - target)} words have to go. Cutting one sentence is not enough.
Cut in this order until you are under the limit:
1. Sentences in the Conclusion that repeat the Analysis: the Conclusion is one or two sentences.
2. The second statement of anything said twice, including an Analysis sentence that repeats the Overview.
3. Explanatory notes, background, rationale and anything the question did not ask for.
4. Long enumerations: say what kinds of item the list holds and name only the items the question turns on.
Keep:
- The three headings exactly as written: "## Overview", "## Analysis", "## Conclusion". Keep a "### " sub-heading only if text remains under it.
- The first sentence of the Overview as it is.
- Each statutory definition with its provision number, and for each defined term the statement that certain persons or things are deemed to fall within it (you may shorten the list of them, not drop the point).
- Citation markers ([Source 3], [3]) exactly as written on every sentence that states law. Do not invent or renumber a marker.
- ==highlight== marks and the closing line about legal research.
Do not add anything: no fact, provision number, figure, case name or opinion that is not already in the answer.
Return only the shortened answer.`;
}

/**
 * Why a shortened answer cannot be used, or null when it can.
 */
function rejectionReason(draft, shortened, previous = draft) {
  const text = String(shortened || '').trim();
  if (!text) return 'empty';
  for (const heading of MAIN_HEADINGS) {
    if (draft.includes(heading) && !text.includes(heading)) return `heading lost: ${heading}`;
  }
  const after = wordCount(text);
  if (after >= wordCount(previous)) return 'not shorter';
  if (after < wordCount(draft) * MIN_KEPT_SHARE) return 'too much removed';
  const draftMarkers = markersOf(draft);
  const newMarkers = [...markersOf(text)].filter((m) => !draftMarkers.has(m));
  if (newMarkers.length) return `new citation marker: ${newMarkers.join(',')}`;
  if (draftMarkers.size > 0 && markersOf(text).size === 0) return 'all citations lost';
  const draftSpecifics = specificsOf(draft);
  const added = [...specificsOf(text)].filter((s) => !draftSpecifics.has(s));
  if (added.length) return `added ${added.slice(0, 3).join('; ')}`;
  return null;
}

/**
 * Shortens an answer that is over its word limit. Never throws; on any doubt the draft stays.
 *
 * @param {Object} input
 * @param {string} input.answer    the draft (structure already normalised)
 * @param {string} input.question
 * @param {Function} input.generate async ({ systemPrompt, messages, temperature, maxTokens }) => { content }
 * @returns {Promise<{ answer: string, stats: { limit: number, before: number, after: number, applied: boolean, reason?: string } }>}
 */
async function condenseIfLong({ answer, question, generate }) {
  const limit = wordLimitFor(question);
  const before = wordCount(answer);
  const stats = { limit, before, after: before, applied: false, attempts: 0 };
  if (before <= limit * TOLERANCE) return { answer, stats };

  // Models undercount words, so each pass aims a little below the limit; a pass that leaves
  // the answer over the limit is followed by one more on its own output.
  const target = Math.round(limit * TARGET_SHARE);
  let current = answer;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      stats.attempts = attempt;
      const response = await generate({
        systemPrompt: condenserPrompt(target, wordCount(current)),
        messages: [{ role: 'user', content: `QUESTION\n${question}\n\nANSWER\n${current}` }],
        temperature: 0,
        maxTokens: CONDENSER_MAX_TOKENS,
      });
      const shortened = String((response && response.content) || '').replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
      const reason = rejectionReason(answer, shortened, current);
      if (reason) {
        stats.reason = reason;
        break;
      }
      current = shortened;
      if (wordCount(current) <= limit * TOLERANCE) break;
    }
  } catch (error) {
    console.error('[Answer Condenser] Shortening failed; the text reached so far is used:', error.message);
    stats.reason = error.message;
  }
  return { answer: current, stats: { ...stats, after: wordCount(current), applied: current !== answer } };
}

module.exports = {
  SINGLE_ISSUE_WORD_LIMIT,
  MULTI_PART_WORD_LIMIT,
  wordCount,
  wordLimitFor,
  rejectionReason,
  condenseIfLong,
};
