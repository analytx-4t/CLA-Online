const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  TOOL_DB,
  TOOL_BOOKS,
  TOOLS,
  MAX_PASSAGES,
  NO_AUTHORITY_TEXT,
  loadReasoningPrompt,
  buildSystemPrompt,
  formatToday,
  PassageRegister,
  toSearchRequest,
  runReasoningAgent,
  splitAtSources,
} = require('../reasoningAgent');
const { finalizeAnswer, normalizeAnswerStructure } = require('../citations');

const passage = (id, table, title, text) => ({
  embedding_id: id,
  source_table: table,
  record_id: Number(id.split('|')[1]),
  doc_title: title,
  chunk_text: `[${table} | Title: ${title}]\n${text}`,
  backend_relevance_score: 0.8,
});

const ACT_68 = passage('Legislation|1|10', 'Legislation', 'Companies Act, 2013',
  '68. Power of company to purchase its own securities. (1) A company may purchase its own shares out of its free reserves, the securities premium account or the proceeds of the issue of any shares.');
const RULE_17 = passage('Legislation|2|5', 'Legislation', 'Companies (Share Capital and Debentures) Rules, 2014',
  '17. Buy-back of securities. The company shall file a declaration of solvency in Form SH.9 with the Registrar.');
const ARTICLE = passage('Articles|9|0', 'Articles', 'Buy-back or dividend', 'A buy-back is often preferred when reserves are large.');

// A function call as OpenAIProvider.respond() reports it.
const toolCall = (callId, name, args) => ({ callId, name, arguments: JSON.stringify(args) });

test('the client prompt file is loaded verbatim and dated', () => {
  const file = path.resolve(__dirname, '..', '..', 'CLA_Reasoning_Layer_System_Prompt.txt');
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trim();
  assert.equal(loadReasoningPrompt(), raw);

  const system = buildSystemPrompt({ now: new Date('2026-11-16T06:00:00Z'), maxSearches: 14, maxRounds: 4 });
  assert.ok(system.startsWith('You are the legal reasoning layer of CLAOnline'));
  assert.ok(system.includes("Today's date is 16 November 2026."));
  assert.ok(!system.includes('{{current_date}}'));
  // Every part of the client prompt is present, unchanged, ahead of the runtime notes.
  assert.ok(system.includes(raw.split('{{current_date}}')[1].trim()));
  assert.ok(system.indexOf('PART D: WORKED EXAMPLES') < system.indexOf('RUNTIME NOTES FOR THIS DEPLOYMENT'));
  assert.ok(system.includes(TOOL_DB) && system.includes(TOOL_BOOKS));
});

test('today is the date in India', () => {
  assert.equal(formatToday(new Date('2026-11-15T20:00:00Z')), '16 November 2026');
});

test('the two tools carry the names the prompt uses', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['Pinecone_Vector_Store_DB', 'Pinecone_Vector_Store_DB1']);
  // Responses API function tools in strict mode: every property required, nothing else allowed.
  for (const tool of TOOLS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.strict, true);
    assert.deepEqual([...tool.parameters.required].sort(), Object.keys(tool.parameters.properties).sort());
    assert.equal(tool.parameters.additionalProperties, false);
  }
});

test('tool calls become search requests on the right tables', () => {
  assert.deepEqual(
    toSearchRequest(toolCall('a', TOOL_DB, { query: 'section 68 buy-back', content_type: 'Legislation' })).request,
    { tool: 'db', query: 'section 68 buy-back', tables: ['Legislation'], top_k: 6 },
  );
  assert.deepEqual(toSearchRequest(toolCall('b', TOOL_DB, { query: 'notice', content_type: 'notice' })).request.tables, ['Notifications', 'Circular']);
  assert.deepEqual(toSearchRequest(toolCall('c', TOOL_DB, { query: 'x', content_type: 'Caselaws' })).request.tables, ['CaseLaws']);
  assert.deepEqual(toSearchRequest(toolCall('d', TOOL_DB, { query: 'x' })).request.tables, []);
  assert.equal(toSearchRequest(toolCall('e', TOOL_BOOKS, { query: 'buy-back' })).request.tool, 'books');
  assert.ok(toSearchRequest(toolCall('f', TOOL_DB, { query: '  ' })).error);
  assert.ok(toSearchRequest(toolCall('g', 'web_search', { query: 'x' })).error);
  assert.ok(toSearchRequest({ callId: 'h', name: TOOL_DB, arguments: '{not json' }).error);
});

test('the passage register numbers each passage once, up to the marker limit', () => {
  const register = new PassageRegister([ACT_68, RULE_17]);
  const placed = register.add([RULE_17, ARTICLE]);
  assert.deepEqual(placed.map((p) => [p.number, p.isNew]), [[2, false], [3, true]]);

  const many = Array.from({ length: 120 }, (_, i) => passage(`Articles|${100 + i}|0`, 'Articles', `A${i}`, 'text'));
  register.add(many);
  assert.equal(register.list.length, MAX_PASSAGES);
  assert.ok(register.full);
});

test('the agent searches, numbers new passages after the first pass, and returns its answer', async () => {
  const calls = [];
  const searches = [];
  const generate = async (request) => {
    calls.push(request);
    if (calls.length === 1) {
      return {
        content: '',
        toolCalls: [
          toolCall('c1', TOOL_DB, { query: 'Rule 17 buy-back declaration of solvency', content_type: 'Legislation' }),
          toolCall('c2', TOOL_BOOKS, { query: 'buy-back' }),
        ],
        model: 'gpt-6-luna',
        provider: 'openai',
        usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 10 },
      };
    }
    return {
      content: '**Position:** Settled\n**Short answer:** Yes, out of free reserves [1].\n### Sources\n- Companies Act, 2013, section 68(1) [Statute] [1]\n- Rules, rule 17 [Rules] [2]\nThis is legal research, not legal advice.\n---SUGGESTIONS---\nQ1?\nQ2?\nQ3?',
      toolCalls: [],
      model: 'gpt-6-luna',
      provider: 'openai',
      finishReason: 'stop',
      usage: { input_tokens: 300, output_tokens: 200, reasoning_tokens: 50 },
    };
  };
  const search = async (requests) => {
    searches.push(requests);
    return [[RULE_17, ACT_68], []];
  };

  const result = await runReasoningAgent({
    question: 'Can a company buy back shares out of reserves?',
    expansion: { expandedQuery: 'buy-back section 68', primaryAct: 'Companies Act, 2013', keywords: ['buy-back'] },
    initialPassages: [ACT_68],
    search,
    generate,
    limits: { maxRounds: 4, maxSearches: 10, timeBudgetMs: 600000, reasoningEffort: 'medium' },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].toolChoice, 'auto');
  assert.equal(calls[0].reasoningEffort, 'medium');
  assert.ok(calls[0].systemPrompt.startsWith('You are the legal reasoning layer of CLAOnline'));
  const opening = calls[0].input[calls[0].input.length - 1].content;
  assert.ok(opening.includes('QUESTION:\nCan a company buy back shares'));
  assert.ok(opening.includes('Governing instrument: Companies Act, 2013'));
  assert.ok(opening.includes('[Source 1]'));

  assert.equal(searches.length, 1, 'parallel tool calls run as one batch');
  assert.deepEqual(searches[0].map((r) => r.tool), ['db', 'books']);

  // Each function call goes back before its output, as the Responses API requires.
  const turn2 = calls[1].input;
  assert.deepEqual(turn2.filter((i) => i.type === 'function_call').map((i) => i.call_id), ['c1', 'c2']);
  const outputs = turn2.filter((i) => i.type === 'function_call_output');
  assert.deepEqual(outputs.map((o) => o.call_id), ['c1', 'c2']);
  assert.ok(turn2.findIndex((i) => i.call_id === 'c1' && i.type === 'function_call') < turn2.indexOf(outputs[0]));
  assert.ok(outputs[0].output.includes('[Source 2]'), 'new passage continues the numbering');
  assert.ok(outputs[0].output.includes('[Source 1] (already provided above)'));
  assert.ok(outputs[1].output.startsWith('No passages found'));

  assert.deepEqual(result.passages.map((p) => p.embedding_id), [ACT_68.embedding_id, RULE_17.embedding_id]);
  assert.equal(result.trace.rounds, 2);
  assert.equal(result.trace.searches.length, 2);
  assert.deepEqual(result.trace.usage, { input_tokens: 400, output_tokens: 220, reasoning_tokens: 60 });
  assert.ok(result.answer.startsWith('**Position:** Settled'));
});

test('when the search budget is spent the agent is told to answer and may not search again', async () => {
  const calls = [];
  const generate = async (request) => {
    calls.push(request);
    if (request.toolChoice === 'none') return { content: 'Final answer [1].', toolCalls: [], finishReason: 'stop' };
    return { content: '', toolCalls: [toolCall(`c${calls.length}`, TOOL_DB, { query: `q${calls.length}`, content_type: 'Legislation' })] };
  };
  const result = await runReasoningAgent({
    question: 'q',
    initialPassages: [ACT_68],
    search: async (requests) => requests.map(() => [ARTICLE]),
    generate,
    limits: { maxRounds: 2, maxSearches: 10, timeBudgetMs: 600000 },
  });
  assert.equal(result.answer, 'Final answer [1].');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].toolChoice, 'none');
  assert.ok(result.trace.forcedFinalTurn);
  assert.match(calls[2].input[calls[2].input.length - 1].content, /research budget for this question is spent/);
});

test('searches beyond the budget in one turn are refused, not run', async () => {
  let ran = 0;
  const generate = async (request) => {
    if (request.toolChoice === 'none') return { content: 'Answer.', toolCalls: [] };
    return { content: '', toolCalls: [1, 2, 3].map((n) => toolCall(`c${n}`, TOOL_DB, { query: `q${n}`, content_type: 'All' })) };
  };
  const result = await runReasoningAgent({
    question: 'q',
    search: async (requests) => { ran += requests.length; return requests.map(() => []); },
    generate,
    limits: { maxRounds: 3, maxSearches: 2, timeBudgetMs: 600000 },
  });
  assert.equal(ran, 2);
  assert.equal(result.trace.rejectedToolCalls, 1);
});

test('a failed search is reported to the model instead of failing the answer', async () => {
  let turn = 0;
  const generate = async () => {
    turn += 1;
    return turn === 1
      ? { content: '', toolCalls: [toolCall('c1', TOOL_DB, { query: 'q', content_type: 'Legislation' })] }
      : { content: 'Answer [1].', toolCalls: [] };
  };
  const result = await runReasoningAgent({
    question: 'q',
    initialPassages: [ACT_68],
    search: async () => { throw new Error('Pinecone down'); },
    generate,
    limits: { maxRounds: 3, maxSearches: 5, timeBudgetMs: 600000 },
  });
  assert.equal(result.answer, 'Answer [1].');
  assert.equal(result.trace.searches.length, 0);
});

test('a model failure, an empty answer and a truncated answer are errors (the caller falls back)', async () => {
  const base = { question: 'q', search: async () => [], limits: { maxRounds: 2, maxSearches: 2, timeBudgetMs: 600000 } };
  await assert.rejects(runReasoningAgent({ ...base, generate: async () => { throw new Error('quota'); } }), /quota/);
  await assert.rejects(runReasoningAgent({ ...base, generate: async () => ({ content: '', toolCalls: [] }) }), /no answer/);
  await assert.rejects(runReasoningAgent({ ...base, generate: async () => ({ content: 'Half an ans', toolCalls: [], finishReason: 'length' }) }), /cut off/);
  await assert.rejects(runReasoningAgent({ question: 'q', generate: async () => ({}) }), /search function/);
});

test('an empty first turn gets one explicit request for the answer', async () => {
  let turn = 0;
  const result = await runReasoningAgent({
    question: 'q',
    search: async () => [],
    generate: async (request) => {
      turn += 1;
      if (turn === 1) return { content: '', toolCalls: [], finishReason: 'stop' };
      assert.equal(request.toolChoice, 'none');
      return { content: 'Answer.', toolCalls: [] };
    },
    limits: { maxRounds: 3, maxSearches: 3, timeBudgetMs: 600000 },
  });
  assert.equal(result.answer, 'Answer.');
});

test('no new search turn starts once the time budget is nearly used', async () => {
  let clock = 0;
  const calls = [];
  const result = await runReasoningAgent({
    question: 'q',
    search: async (requests) => requests.map(() => []),
    generate: async (request) => {
      calls.push(request.toolChoice);
      clock += 100000;
      return request.toolChoice === 'none'
        ? { content: 'Answer.', toolCalls: [] }
        : { content: '', toolCalls: [toolCall('c', TOOL_DB, { query: 'q', content_type: 'All' })] };
    },
    limits: { maxRounds: 10, maxSearches: 10, timeBudgetMs: 150000 },
    now: () => clock,
  });
  assert.deepEqual(calls, ['auto', 'none']);
  assert.equal(result.answer, 'Answer.');
});

test('the Sources section is split off for verification and kept in the final answer', () => {
  const answer = [
    '**Position:** Settled',
    '**Short answer:** Yes, out of free reserves [1].',
    '### Step-by-step analysis',
    'A declaration of solvency is filed in Form SH.9 [2].',
    '### Sources',
    '- Companies Act, 2013, section 68(1) [Statute] [1]',
    '- Companies (Share Capital and Debentures) Rules, 2014, rule 17 [Rules] [2]',
    'This is legal research, not legal advice.',
  ].join('\n');

  const { body, tail } = splitAtSources(answer);
  assert.ok(body.endsWith('Form SH.9 [2].'));
  assert.ok(tail.startsWith('### Sources'));
  assert.deepEqual(splitAtSources('No sources here.'), { body: 'No sources here.', tail: '' });
  assert.ok(splitAtSources('Text\n**Sources:**\n- a [1]').tail.startsWith('**Sources:**'));

  // The ordinary answer writer's Sources list is still dropped; a Reasoning Agent answer keeps it.
  assert.ok(!normalizeAnswerStructure(answer).includes('### Sources'));
  const finalized = finalizeAnswer(answer, [ACT_68, RULE_17], { keepSourcesSection: true });
  assert.ok(finalized.answer.includes('### Sources'));
  assert.ok(finalized.answer.includes('section 68(1) [Statute] [1]'));
  assert.ok(finalized.answer.includes('rule 17 [Rules] [2]'));
  assert.ok(finalized.answer.startsWith('**Position:** Settled'));
  assert.equal(finalized.sources.length, 2);
});

test('the no-authority reply is the standard one', () => {
  assert.match(NO_AUTHORITY_TEXT, /could not find authority/);
  assert.equal(finalizeAnswer(NO_AUTHORITY_TEXT, [], { keepSourcesSection: true }).sources.length, 0);
});

test('the model\'s own output items (reasoning included) are passed back on the next turn', async () => {
  const reasoningItem = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] };
  const callItem = { type: 'function_call', call_id: 'c9', name: TOOL_DB, arguments: JSON.stringify({ query: 'q', content_type: 'Legislation' }) };
  const calls = [];
  await runReasoningAgent({
    question: 'q',
    search: async (requests) => requests.map(() => [ACT_68]),
    generate: async (request) => {
      calls.push(request);
      return calls.length === 1
        ? { content: '', toolCalls: [toolCall('c9', TOOL_DB, { query: 'q', content_type: 'Legislation' })], outputItems: [reasoningItem, callItem] }
        : { content: 'Answer [1].', toolCalls: [] };
    },
    limits: { maxRounds: 3, maxSearches: 3, timeBudgetMs: 600000 },
  });
  const turn2 = calls[1].input;
  assert.equal(turn2[1], reasoningItem);
  assert.equal(turn2[2], callItem);
  assert.equal(turn2[3].type, 'function_call_output');
});

test('the response parser keeps a Reasoning Agent answer\'s Sources section and closing line', () => {
  const { parseAnswerAndSuggestions } = require('../responseParser');
  const raw = '**Position:** Settled\nAnalysis [1].\n### Sources\n- Companies Act, 2013, section 68 [Statute] [1]\nThis is legal research, not legal advice.\n---SUGGESTIONS---\nA?\nB?\nC?';
  const kept = parseAnswerAndSuggestions(raw, { keepSourcesSection: true });
  assert.ok(kept.answer.includes('### Sources'));
  assert.ok(kept.answer.endsWith('This is legal research, not legal advice.'));
  assert.deepEqual(kept.suggestions.length, 3);
  // The single-pass writer's answers are unchanged: its Sources list is dropped.
  assert.ok(!parseAnswerAndSuggestions(raw).answer.includes('### Sources'));
});

test('sentences about what "the available material" contains are removed', () => {
  const { stripMetaCommentary } = require('../citations');
  const text = 'A special resolution is required [2]. The applicable conditions are not set out in the available material. The loan must be used for principal business activities [2].';
  const cleaned = stripMetaCommentary(text);
  assert.ok(!/available material/.test(cleaned));
  assert.ok(cleaned.includes('special resolution is required [2].'));
  assert.ok(cleaned.includes('principal business activities [2].'));
});
