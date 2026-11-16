/**
 * reasoningAgent.js
 *
 * The Reasoning Agent (the "reasoning layer" of CLAOnline).
 *
 * Position in the /api/ask pipeline:
 *
 *   guardrails -> Query Expansion Agent -> first retrieval pass -> REASONING AGENT
 *              -> citation & currency verifier -> cited-only sources -> answer
 *
 * The agent runs on the system prompt the client validated, kept verbatim in
 * CLA_Reasoning_Layer_System_Prompt.txt (repo root). That prompt describes a research method in
 * which the model reasons first and then uses two search tools to confirm and complete its
 * reasoning. This module supplies:
 *
 *   - those two tools, under the names the prompt uses:
 *       Pinecone_Vector_Store_DB   the primary legal database (one content type per search)
 *       Pinecone_Vector_Store_DB1  the books index
 *   - the first retrieval pass (already ranked by authority and currency) as the opening
 *     research material, so the agent's own searches go to what that pass lacks
 *   - a running register of every passage the agent has seen, numbered [Source N] for the whole
 *     conversation, which is what the answer cites and what the verifier checks against
 *   - search, turn and time budgets, after which the agent is asked to write its answer
 *   - short runtime notes appended to the prompt that explain the passage numbering, the
 *     citation markers and the chat formatting. They do not change the prompt's method.
 *
 * The model call and the search are injected (`generate`, `search`) so the loop can be tested
 * without network access. When the agent fails, the caller falls back to the earlier
 * single-pass answer writer, so a provider outage never leaves the user without an answer.
 */

const fs = require('fs');
const path = require('path');
const { settings } = require('./config');
const { formatContextPassage } = require('./citations');

const TOOL_DB = 'Pinecone_Vector_Store_DB';
const TOOL_BOOKS = 'Pinecone_Vector_Store_DB1';

// Content types the prompt names (A2), mapped to the tables of the cla-online-db index.
// The index has no separate notice table: notices are filed with notifications and circulars.
const CONTENT_TYPE_TABLES = {
  Legislation: ['Legislation'],
  Notification: ['Notifications'],
  Circular: ['Circular'],
  Notice: ['Notifications', 'Circular'],
  Caselaws: ['CaseLaws'],
  Commentary: ['CLASE_Commentary'],
  Article: ['Articles'],
  Query: ['Query'],
  Procedure: ['CLASE_Procedure_Details'],
  All: [],
};
const CONTENT_TYPES = Object.keys(CONTENT_TYPE_TABLES);

// Citation markers are one or two digits ([1] .. [99]); see citations.js.
const MAX_PASSAGES = 99;
const RESULTS_PER_SEARCH = 6;
// Time kept back for the final answer: once less than this is left, no new search turn starts.
const FINAL_ANSWER_RESERVE_MS = 55000;
// A single model call that runs past the budget by more than this is abandoned.
const CALL_GRACE_MS = 45000;
const MAX_QUERY_CHARS = 400;

const NO_AUTHORITY_TEXT = 'I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question.';

// Function tools in the OpenAI Responses API format (gpt-6-luna takes tools together with a
// reasoning effort only on that API; see executeResponseDirect in llm/portkey.js).
const TOOLS = [
  {
    type: 'function',
    name: TOOL_DB,
    description:
      'Primary legal database of CLAOnline: Acts, Rules, Regulations and Schedules (Legislation), '
      + 'notifications, circulars and notices, case law, commentary, articles and expert Q&A. '
      + 'Runs ONE search for one instrument or issue and returns the most similar passages, each numbered [Source N].',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'One instrument or issue, written in the language of the source: section / rule / regulation numbers, '
            + 'defined terms, statutory phrases and the regulator\'s own title wording.',
        },
        content_type: {
          type: 'string',
          enum: CONTENT_TYPES,
          description:
            'The table to search: Legislation, Notification, Circular, Notice, Caselaws, Commentary, Article, Query '
            + '(expert Q&A) or Procedure (procedural guides). Use All only when no single type fits.',
        },
      },
      required: ['query', 'content_type'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: 'function',
    name: TOOL_BOOKS,
    description:
      'CLA books: treatises, commentaries and annotated texts. For depth, background and cross-checking, and as a '
      + 'fallback when the primary database has nothing on a point that should exist. Returns passages numbered [Source N].',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'One topic or provision to look up in the books.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  },
];

let promptCache = null;

function promptFilePath() {
  return path.resolve(__dirname, '..', settings.REASONING_AGENT_PROMPT_FILE);
}

/** The client's Reasoning Layer System Prompt, exactly as validated. */
function loadReasoningPrompt() {
  const filePath = promptFilePath();
  const mtime = fs.statSync(filePath).mtimeMs;
  if (!promptCache || promptCache.filePath !== filePath || promptCache.mtime !== mtime) {
    const text = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
    if (!text.includes('{{current_date}}')) {
      throw new Error(`${path.basename(filePath)} has no {{current_date}} placeholder; is it the Reasoning Layer prompt?`);
    }
    promptCache = { filePath, mtime, text };
  }
  return promptCache.text;
}

/** "16 November 2026", in Indian time: the date the prompt treats as today. */
function formatToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(now);
}

function runtimeNotes({ maxSearches, maxRounds }) {
  return `════════════════════════════════════════
RUNTIME NOTES FOR THIS DEPLOYMENT
════════════════════════════════════════
These notes explain how your tools and the chat interface work. They do not change Parts A to D.

R1. Tools. ${TOOL_DB} is Tool 1 and ${TOOL_BOOKS} is Tool 2. Each call runs one search; to run independent searches in parallel, make several tool calls in the same turn. For Tool 1, set content_type to the table you want. The first message already contains a first search pass over both tools for the question, so spend your searches on what that pass lacks: the definitions clause, the subordinate law, the replacing or consolidating instrument, later amendments, the remaining sub-paragraphs of an entry you rely on, a dedicated regulator rule, an appellate or larger-bench decision. You have about ${maxSearches} searches over ${maxRounds} turns. When they are spent you will be asked to write the answer.

R2. Passages. Every passage you receive, in the first message or from a tool, is labelled "[Source N]" with its type and title and, where known, an "Authority:" line (its weight) and a "Currency:" line (whether it is current law). Numbers are unique for the whole conversation. These numbered passages are the material retrieved in this conversation (A1). Use the Currency line in Step 6.

R3. Citing. End every sentence or list item that states law taken from a passage with that passage's number in square brackets, for example "... by special resolution [3]." Cite only the passage that states the point; where two do, write [3][7]. Never invent a number and never cite a passage you were not given. In the Sources section (Part C item 9), write one entry per line with its pinpoint, date and tag, and end the entry with its number, for example "- Companies Act, 2013, section 68(2) [Statute] [3]".

R4. Format. The chat renders Markdown. Begin with the line "**Position:** <position>" and then "**Short answer:** <the answer>" on the same line as its label. Give each later item of Part C a "### " heading (for example "### Assumptions and pivot facts", "### Route map", "### Step-by-step analysis", "### Parallel regimes and other requirements", "### Consequences of breach", "### Conflicts, currency and what changed", "### Sources") and leave out any item that the question does not raise. A LOOKUP question takes the shorter LOOKUP format, still with "### Sources". Put grids in Markdown tables. Do not use "#" or "##" headings.

R5. Close with the line "This is legal research, not legal advice." Then, on a new line, write ---SUGGESTIONS--- followed by three follow-up questions the user might ask next, one per line.

R6. Attached documents, when present, are the user's own material: use them for facts only, never as a source of law, and give them no [N] number.

R7. If, after searching, no numbered passage addresses the core of the question at all, reply with exactly this sentence and nothing else: "${NO_AUTHORITY_TEXT}"

R8. Plan your searches so the budget covers every item the answer depends on (the governing entry, its conditions, exemptions and the replacing instrument first). If the budget ends before you find an item, A5 and A7 still apply: never write that "the available material", "the available text" or "the passages" do or do not contain something, and never write "I cannot conclude". Answer every branch you can from the passages and use, at most, the single specific "Please note" line at the end that A7 allows.`;
}

/** The full system prompt: the validated prompt with today's date, then the runtime notes. */
function buildSystemPrompt({ now = new Date(), maxSearches, maxRounds } = {}) {
  const prompt = loadReasoningPrompt().split('{{current_date}}').join(formatToday(now));
  return `${prompt}\n\n${runtimeNotes({ maxSearches, maxRounds })}`;
}

// ---------------------------------------------------------------------------
// Passage register
// ---------------------------------------------------------------------------

function passageKey(r) {
  if (r.embedding_id) return `id|${r.embedding_id}`;
  if (r.record_id !== undefined && r.record_id !== null) return `rec|${r.source_table}|${r.record_id}|${r.chunk_index ?? ''}|${r.page_number ?? ''}`;
  return `text|${String(r.chunk_text || r.content || '').slice(0, 120)}`;
}

/** Every passage shown to the agent, numbered in the order it was first seen (Source N = list[N - 1]). */
class PassageRegister {
  constructor(initial = []) {
    this.list = [];
    this.numberByKey = new Map();
    this.add(initial);
  }

  get full() {
    return this.list.length >= MAX_PASSAGES;
  }

  /** Adds new passages; returns [{ number, passage, isNew }] for every passage it was given that has a number. */
  add(passages) {
    const placed = [];
    for (const passage of passages || []) {
      if (!passage) continue;
      const key = passageKey(passage);
      if (this.numberByKey.has(key)) {
        placed.push({ number: this.numberByKey.get(key), passage: this.list[this.numberByKey.get(key) - 1], isNew: false });
        continue;
      }
      if (this.full) continue;
      this.list.push(passage);
      this.numberByKey.set(key, this.list.length);
      placed.push({ number: this.list.length, passage, isNew: true });
    }
    return placed;
  }
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return {};
  }
}

/** A tool call as a search request for the search back end, or an error message for the model. */
function toSearchRequest(call) {
  const name = call?.name;
  const args = parseArguments(call?.arguments);
  const query = String(args.query || '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
  if (!query) return { error: 'The search needs a non-empty "query".' };
  if (name === TOOL_BOOKS) return { request: { tool: 'books', query, top_k: RESULTS_PER_SEARCH }, label: `books: ${query}` };
  if (name !== TOOL_DB) return { error: `Unknown tool "${name}". Use ${TOOL_DB} or ${TOOL_BOOKS}.` };
  const contentType = CONTENT_TYPES.find((t) => t.toLowerCase() === String(args.content_type || 'All').trim().toLowerCase()) || 'All';
  return {
    request: { tool: 'db', query, tables: CONTENT_TYPE_TABLES[contentType], top_k: RESULTS_PER_SEARCH },
    label: `${contentType}: ${query}`,
  };
}

function toolResultText(placed, { registerFull }) {
  if (!placed.length) {
    return registerFull
      ? 'No further passages can be added in this conversation. Write the answer from the passages you have.'
      : 'No passages found for this search. Try the instrument\'s exact title, the provision number, the statutory phrase or another content type.';
  }
  return placed
    .map(({ number, passage, isNew }) => (isNew
      ? formatContextPassage(passage, number)
      : `[Source ${number}] (already provided above)`))
    .join('\n\n---\n\n');
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// The opening message
// ---------------------------------------------------------------------------

function describeExpansion(expansion = {}) {
  const lines = [];
  const add = (label, value) => {
    const text = Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value || '').trim();
    if (text && !/^none$/i.test(text)) lines.push(`${label}: ${text}`);
  };
  add('Expanded query', expansion.expandedQuery);
  add('Governing instrument', expansion.primaryAct);
  add('Provisions indicated', expansion.inferredSections);
  add('Key terms', expansion.keywords);
  add('Defined terms', expansion.definedTerms);
  add('Relevant date', expansion.currencyRequirement);
  add('Suggested filters', expansion.suggestedFilters);
  return lines.join('\n');
}

function buildOpeningMessage({ question, standaloneQuestion, expansion, openingPlaced, attachmentContext }) {
  const parts = [`QUESTION:\n${question}`];
  if (standaloneQuestion && standaloneQuestion.trim() !== String(question || '').trim()) {
    parts.push(`THE QUESTION READ WITH THE EARLIER CONVERSATION:\n${standaloneQuestion}`);
  }
  const analysis = describeExpansion(expansion);
  if (analysis) {
    parts.push(`QUERY ANALYSIS (from the Query Expansion Agent; a lead for what to search, never a source of law):\n${analysis}`);
  }
  parts.push(openingPlaced.length
    ? `FIRST SEARCH PASS (both tools, ranked by authority and currency):\n\n${toolResultText(openingPlaced, { registerFull: false })}`
    : 'FIRST SEARCH PASS: no passages were found. Search with the tools before answering.');
  if (attachmentContext) {
    parts.push(`ATTACHED DOCUMENT CONTEXT (the user's own material; see R6):\n${attachmentContext}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// The agent loop
// ---------------------------------------------------------------------------

function defaultGenerate(request) {
  // Required lazily: the provider modules connect to Portkey when they load.
  const { getLLMProvider } = require('./llm/factory');
  const provider = getLLMProvider(settings.REASONING_AGENT_PROVIDER, settings.REASONING_AGENT_MODEL);
  if (typeof provider.respond !== 'function') {
    throw new Error(`REASONING_AGENT_PROVIDER "${settings.REASONING_AGENT_PROVIDER}" has no Responses API support; use "openai".`);
  }
  return provider.respond(request);
}

function addUsage(total, usage = {}) {
  for (const key of ['input_tokens', 'output_tokens', 'reasoning_tokens']) {
    if (Number.isFinite(usage[key])) total[key] = (total[key] || 0) + usage[key];
  }
}

/**
 * Runs the Reasoning Agent for one question.
 *
 * @param {Object}   input
 * @param {string}   input.question            The question as the user asked it.
 * @param {string}   [input.standaloneQuestion] The question rewritten to stand alone (follow-ups).
 * @param {Object}   [input.expansion]         Output of expandLegalQuery().
 * @param {Array}    [input.initialPassages]   The first retrieval pass, in authority order.
 * @param {Array}    [input.history]           Earlier turns: [{ role, content }].
 * @param {string}   [input.attachmentContext] Text of documents the user attached.
 * @param {Function} input.search              async (requests[]) => results[][] (one list per request).
 * @param {Function} [input.generate]          async (request) => { content, toolCalls, outputItems, finishReason,
 *                                             usage, model, provider }: one Responses API turn
 *                                             (OpenAIProvider.respond).
 * @param {Object}   [input.requestContext]    Passed to the provider for tracing.
 * @param {Object}   [input.limits]            Overrides: { maxRounds, maxSearches, timeBudgetMs, maxOutputTokens, reasoningEffort }.
 * @param {Function} [input.onProgress]        Called with a short status line after each turn.
 * @returns {Promise<{answer: string, passages: Array, trace: Object}>}
 */
async function runReasoningAgent({
  question,
  standaloneQuestion = '',
  expansion = {},
  initialPassages = [],
  history = [],
  attachmentContext = '',
  search,
  generate = defaultGenerate,
  requestContext,
  limits = {},
  onProgress = () => {},
  now = () => Date.now(),
}) {
  if (typeof search !== 'function') throw new Error('runReasoningAgent needs a search function.');

  const maxRounds = limits.maxRounds ?? settings.REASONING_AGENT_MAX_TOOL_ROUNDS;
  const maxSearches = limits.maxSearches ?? settings.REASONING_AGENT_MAX_SEARCHES;
  const timeBudgetMs = limits.timeBudgetMs ?? settings.REASONING_AGENT_TIME_BUDGET_MS;
  const maxOutputTokens = limits.maxOutputTokens ?? settings.REASONING_AGENT_MAX_OUTPUT_TOKENS;
  const reasoningEffort = limits.reasoningEffort ?? settings.REASONING_AGENT_EFFORT;

  const startedAt = now();
  const deadline = startedAt + timeBudgetMs;
  const systemPrompt = buildSystemPrompt({ maxSearches, maxRounds });
  const register = new PassageRegister();
  const openingPlaced = register.add(initialPassages);

  // The conversation, as Responses API input items: earlier turns, the opening message, then each
  // model turn's output items (reasoning, function calls) and the function call outputs.
  const input = [];
  for (const turn of (history || []).slice(-6)) {
    const content = String(turn?.content || '').trim();
    if (content) input.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: content.slice(0, 1500) });
  }
  input.push({
    role: 'user',
    content: buildOpeningMessage({ question, standaloneQuestion, expansion, openingPlaced, attachmentContext }),
  });

  const trace = {
    model: null,
    provider: null,
    rounds: 0,
    searches: [],
    rejectedToolCalls: 0,
    initialPassages: openingPlaced.length,
    usage: {},
    finishReason: null,
    forcedFinalTurn: false,
    timeMs: 0,
  };

  let answerRequested = false;
  for (let round = 0; ; round += 1) {
    const outOfTime = now() > deadline - FINAL_ANSWER_RESERVE_MS;
    const finalTurn = answerRequested || round >= maxRounds || trace.searches.length >= maxSearches || outOfTime || register.full;
    if (finalTurn && round > 0 && !trace.forcedFinalTurn && input[input.length - 1]?.type === 'function_call_output') {
      trace.forcedFinalTurn = true;
      input.push({
        role: 'user',
        content: 'The research budget for this question is spent. Write the final answer now, from the numbered passages above, in the Part C format.',
      });
    }

    const callBudget = Math.max(deadline - now(), 0) + CALL_GRACE_MS;
    const response = await withTimeout(generate({
      systemPrompt,
      // A snapshot: the conversation keeps growing after this call returns.
      input: [...input],
      tools: TOOLS,
      // On the final turn the tools stay defined (the conversation contains tool calls) but may not be used.
      toolChoice: finalTurn ? 'none' : 'auto',
      reasoningEffort,
      maxTokens: maxOutputTokens,
      requestContext,
    }), callBudget, 'Reasoning Agent model call');

    trace.rounds += 1;
    trace.model = response?.model || trace.model;
    trace.provider = response?.provider || trace.provider;
    trace.finishReason = response?.finishReason || null;
    addUsage(trace.usage, response?.usage);

    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    const content = String(response?.content || '').trim();

    if (toolCalls.length && !finalTurn) {
      // The model's own output items go back in unchanged: the encrypted reasoning items carry
      // its reasoning into the next turn, and each function call must precede its output.
      if (Array.isArray(response.outputItems) && response.outputItems.length) {
        input.push(...response.outputItems);
      } else {
        input.push(...toolCalls.map((call) => ({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments })));
      }

      const remaining = Math.max(maxSearches - trace.searches.length, 0);
      const planned = toolCalls.map((call, index) => {
        const parsed = toSearchRequest(call);
        if (!parsed.error && index >= remaining) {
          return { call, error: 'Search budget reached: this search was not run. Answer from the passages you have.' };
        }
        return { call, ...parsed };
      });
      const runnable = planned.filter((p) => p.request);
      let batches = [];
      if (runnable.length) {
        try {
          batches = await search(runnable.map((p) => p.request));
        } catch (error) {
          console.warn(`[Reasoning Agent] Search failed: ${error.message}`);
          batches = runnable.map(() => null);
        }
      }

      let batchIndex = 0;
      for (const item of planned) {
        let text;
        if (item.error) {
          trace.rejectedToolCalls += 1;
          text = item.error;
        } else {
          const results = batches[batchIndex];
          batchIndex += 1;
          if (results === null || results === undefined) {
            text = 'The search could not be completed. Try again with a different query, or answer from the passages you have.';
          } else {
            const placed = register.add(results);
            trace.searches.push({ query: item.label, results: results.length, newPassages: placed.filter((p) => p.isNew).length });
            text = toolResultText(placed, { registerFull: register.full });
          }
        }
        input.push({ type: 'function_call_output', call_id: item.call.callId, output: text });
      }

      onProgress(`Reasoning: ${trace.searches.length} searches, ${register.list.length} passages reviewed`);
      continue;
    }

    if (!content) {
      if (!answerRequested && trace.finishReason !== 'length') {
        // An empty turn: ask once, explicitly, for the answer itself.
        answerRequested = true;
        trace.forcedFinalTurn = true;
        input.push({ role: 'user', content: 'Write the final answer now, from the numbered passages above, in the Part C format.' });
        continue;
      }
      throw new Error(`Reasoning Agent returned no answer (finish reason: ${trace.finishReason || 'unknown'}).`);
    }
    if (trace.finishReason === 'length') {
      throw new Error('Reasoning Agent answer was cut off at the output token limit.');
    }

    trace.timeMs = now() - startedAt;
    trace.passages = register.list.length;
    return { answer: content, passages: register.list, trace };
  }
}

// ---------------------------------------------------------------------------
// Answer sections
// ---------------------------------------------------------------------------

const SOURCES_HEADING_RE = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*sources(?:\s+(?:used|relied\s+on|cited))?\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;

/**
 * Splits a Reasoning Agent answer at its Sources heading. The body holds the legal analysis
 * (what the citation verifier checks); the tail holds the Sources list and the closing lines,
 * which state no new law and are kept as written.
 */
function splitAtSources(answer) {
  const text = String(answer || '');
  const lines = text.split('\n');
  const index = lines.findIndex((line) => SOURCES_HEADING_RE.test(line));
  if (index === -1) return { body: text, tail: '' };
  return { body: lines.slice(0, index).join('\n').trimEnd(), tail: lines.slice(index).join('\n') };
}

module.exports = {
  TOOL_DB,
  TOOL_BOOKS,
  TOOLS,
  CONTENT_TYPE_TABLES,
  MAX_PASSAGES,
  NO_AUTHORITY_TEXT,
  loadReasoningPrompt,
  buildSystemPrompt,
  formatToday,
  PassageRegister,
  toSearchRequest,
  buildOpeningMessage,
  runReasoningAgent,
  splitAtSources,
};
