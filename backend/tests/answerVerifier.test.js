const test = require('node:test');
const assert = require('assert');
const { planVerification, parseVerdicts, applyVerification, verifyAnswer } = require('../answerVerifier');
const { parseDefinedTerms } = require('../agentSystem');
const { parseAnswerAndSuggestions } = require('../responseParser');

const RESULTS = [
  { source_table: 'Legislation', doc_title: 'SEBI (Prohibition of Insider Trading) Regulations, 2015', provision_ref: 'Regulation 2(1)(g)', chunk_body: '"insider" means any person who is: i) a connected person; or ii) in possession of or having access to unpublished price sensitive information;' },
  { source_table: 'Articles', doc_title: 'Insider Trading in India', chunk_body: 'Designated persons are identified under the code of conduct.' },
  { source_table: 'CLA Books', is_book: true, doc_title: 'Company Finance', chunk_body: 'Regulation 3(ii) of the 1992 regulations prohibited dealing.' },
];

const ANSWER = [
  '## Overview',
  'Regulation 2(1)(g) defines an insider as a connected person or a person with access to unpublished price sensitive information [Source 1].',
  '',
  '## Analysis',
  'The definition has two limbs [Source 2]. Designated persons are a category of insider [Source 2]. Mere communication is not prohibited unless the recipient deals in securities [Source 3].',
  '',
  '## Conclusion',
  'An insider is a connected person or a person with access to such information [Source 1].',
].join('\n');

test('every cited sentence becomes a numbered claim with the passages it cites', () => {
  const { claims, userMessage } = planVerification(ANSWER, RESULTS);
  assert.strictEqual(claims.length, 5);
  assert.deepStrictEqual(claims.map((c) => c.numbers), [[1], [2], [2], [3], [1]]);
  assert.match(userMessage, /\[1\] Type: Legislation .* Provision: Regulation 2\(1\)\(g\)/);
  assert.match(userMessage, /3\. \(cites 2\) Designated persons are a category of insider/);
});

test('wrong citations are corrected and unsupported or outdated sentences are removed', () => {
  const { claims } = planVerification(ANSWER, RESULTS);
  const verdicts = parseVerdicts(JSON.stringify({ claims: [
    { id: 1, verdict: 'SUPPORTED', sources: [1] },
    { id: 2, verdict: 'WRONG_SOURCE', sources: [1] },
    { id: 3, verdict: 'UNSUPPORTED', sources: [] },
    { id: 4, verdict: 'NOT_CURRENT', sources: [3] },
    { id: 5, verdict: 'SUPPORTED', sources: [1] },
  ] }), claims, RESULTS.length);
  const { answer, stats } = applyVerification(ANSWER, verdicts);

  assert.match(answer, /The definition has two limbs \[Source 1\]\./);
  assert.ok(!answer.includes('category of insider'));
  assert.ok(!answer.includes('Mere communication'));
  assert.ok(!/\.\s*\./.test(answer), 'no stray full stops are left behind');
  assert.deepStrictEqual({ supported: stats.supported, reattributed: stats.reattributed, removed: stats.removed }, { supported: 2, reattributed: 1, removed: 2 });
  assert.strictEqual(stats.removedSentences[1].verdict, 'NOT_CURRENT');
});

test('an unsupported clause in mid-sentence takes the rest of its sentence with it', () => {
  const draft = [
    '## Overview',
    'The Rules govern the investment and reporting is on Form FC-GPR [Source 1].',
    '',
    '## Analysis',
    'A Delaware LLC is a person resident outside India [Source 2], so its purchase is foreign direct investment. The issue must be reported within thirty days [Source 1].',
    '',
    '## Conclusion',
    'Report the issue on Form FC-GPR within thirty days [Source 1].',
  ].join('\n');
  const { claims } = planVerification(draft, RESULTS);
  const verdicts = parseVerdicts(JSON.stringify({ claims: [{ id: 2, verdict: 'UNSUPPORTED', sources: [] }] }), claims, RESULTS.length);
  const { answer } = applyVerification(draft, verdicts);
  assert.ok(!answer.includes('so its purchase'), 'the dependent clause is removed too');
  assert.match(answer, /## Analysis\nThe issue must be reported within thirty days \[Source 1\]\./);
});

test('the Overview and the Conclusion are never emptied', () => {
  const { claims } = planVerification(ANSWER, RESULTS);
  const draft = ANSWER.replace(/## Conclusion\n.*$/s, '## Conclusion\nDesignation under a code of conduct therefore decides nothing by itself [Source 2].');
  const { claims: draftClaims } = planVerification(draft, RESULTS);
  const verdicts = parseVerdicts(JSON.stringify({ claims: [
    { id: 1, verdict: 'SUPPORTED', sources: [1] },
    { id: 5, verdict: 'UNSUPPORTED', sources: [] },
  ] }), draftClaims, RESULTS.length);
  const { answer, stats } = applyVerification(draft, verdicts);
  assert.match(answer, /## Conclusion\nDesignation under a code of conduct/);
  assert.strictEqual(stats.removed, 0);
  assert.strictEqual(stats.keptToPreserveStructure, 1);
  assert.strictEqual(claims.length, 5);
});

test('a proposition confirmed once is not removed where the answer repeats it', () => {
  const draft = [
    '## Overview',
    'An acquirer holding 25% or more of the voting rights in a target company must make an open offer [Source 1].',
    '',
    '## Analysis',
    'The acquisition may be direct or indirect [Source 1]. Offer size is a separate matter [Source 2].',
    '',
    '## Conclusion',
    'An open offer must be made by an acquirer holding 25% or more of the voting rights in the target company [Source 1]. The position is settled [Source 1].',
  ].join('\n');
  const { claims } = planVerification(draft, RESULTS);
  const verdicts = parseVerdicts(JSON.stringify({ claims: [
    { id: 1, verdict: 'SUPPORTED', sources: [1] },
    { id: 4, verdict: 'UNSUPPORTED', sources: [] },
  ] }), claims, RESULTS.length);
  assert.strictEqual(verdicts[3].verdict, 'SUPPORTED');
  assert.strictEqual(verdicts[3].reconciled, true);
  const { answer, stats } = applyVerification(draft, verdicts);
  assert.strictEqual(stats.removed, 0);
  assert.match(answer, /## Conclusion\nAn open offer must be made by an acquirer/);
});

test('a check that wants most of the answer gone removes nothing', () => {
  const { claims } = planVerification(ANSWER, RESULTS);
  const verdicts = parseVerdicts(JSON.stringify({ claims: claims.map((c) => ({ id: c.id, verdict: 'UNSUPPORTED', sources: [] })) }), claims, RESULTS.length);
  const { answer, stats } = applyVerification(ANSWER, verdicts);
  assert.strictEqual(stats.skippedRemovals, true);
  assert.strictEqual(stats.removed, 0);
  assert.ok(answer.includes('Designated persons are a category of insider'));
});

test('a failed or unreadable check leaves the draft unchanged', async () => {
  const failed = await verifyAnswer({ answer: ANSWER, results: RESULTS, generate: async () => { throw new Error('provider down'); } });
  assert.strictEqual(failed.answer, ANSWER);
  assert.strictEqual(failed.stats.error, 'provider down');

  const garbled = await verifyAnswer({ answer: ANSWER, results: RESULTS, generate: async () => ({ content: 'I think it looks fine.' }) });
  assert.strictEqual(garbled.answer, ANSWER);
  assert.ok(garbled.stats.error);
});

test('passage numbers that do not exist are ignored, and skipped claims stay as written', () => {
  const { claims } = planVerification(ANSWER, RESULTS);
  const verdicts = parseVerdicts('```json\n{"claims":[{"id":2,"verdict":"WRONG_SOURCE","sources":[9,1]}]}\n```', claims, RESULTS.length);
  assert.deepStrictEqual(verdicts[1].sources, [1]);
  assert.strictEqual(verdicts[0].verdict, 'SUPPORTED');
  assert.deepStrictEqual(verdicts[0].sources, [1]);
});

test('defined terms are read from an arrow or comma list', () => {
  assert.deepStrictEqual(
    parseDefinedTerms('insider -> connected person -> "unpublished price sensitive information" (UPSI)'),
    ['insider', 'connected person', 'unpublished price sensitive information']);
  assert.deepStrictEqual(parseDefinedTerms('related party, relative; key managerial personnel'), ['related party', 'relative', 'key managerial personnel']);
  assert.deepStrictEqual(parseDefinedTerms('NONE'), []);
  assert.deepStrictEqual(parseDefinedTerms(''), []);
});

test('the suggestions tag ends the answer however the model spaces it', () => {
  for (const tag of ['---SUGGESTIONS---', '---SUGGESTIONS ---', '--- SUGGESTIONS ---']) {
    const parsed = parseAnswerAndSuggestions(`The answer.\n\n${tag}\nFirst?\nSecond?\nThird?`);
    assert.strictEqual(parsed.answer, 'The answer.');
    assert.strictEqual(parsed.suggestions.length, 3);
  }
});

test('a statement of law written without a citation is checked too', () => {
  const draft = [
    '## Overview',
    'Regulation 2(1)(g) defines an insider as a connected person or a person with access to unpublished price sensitive information.',
    '',
    '## Analysis',
    'The definition has two limbs [Source 1]. The threshold for an open offer is fifteen per cent of the voting rights. This reading follows from the text of the definition taken as a whole.',
    '',
    '## Conclusion',
    'An insider is a connected person or a person with access to such information [Source 1].',
  ].join('\n');
  const { claims, userMessage } = planVerification(draft, RESULTS);
  const uncited = claims.filter((c) => c.uncited);
  assert.strictEqual(uncited.length, 2, 'the sentence naming a provision and the one giving a figure; not the reasoning sentence');
  assert.match(userMessage, /1\. \(cites none\) Regulation 2\(1\)\(g\) defines an insider/);

  const verdicts = parseVerdicts(JSON.stringify({ claims: [
    { id: 1, verdict: 'WRONG_SOURCE', sources: [1] },
    { id: 3, verdict: 'UNSUPPORTED', sources: [] },
  ] }), claims, RESULTS.length);
  const { answer, stats } = applyVerification(draft, verdicts);
  assert.match(answer, /price sensitive information \[Source 1\]\.\n/, 'the missing citation is added before the full stop');
  assert.ok(!answer.includes('fifteen per cent'), 'the figure no passage states is removed');
  assert.match(answer, /two limbs \[Source 1\]\. This reading follows/);
  assert.strictEqual(stats.uncitedChecked, 2);
  assert.strictEqual(stats.uncitedAttributed, 1);
  assert.strictEqual(stats.removed, 1);
});

test('a rule is cited to the law, not to an article or paper beside it; a bare non-authority claim goes', () => {
  const tiered = [
    { ...RESULTS[0], authority_tier: 'legislation' },
    { ...RESULTS[1], authority_tier: 'article' },
    { source_table: 'Circular', doc_title: 'Discussion Paper on Brightline Tests', authority_tier: 'regulator_paper', chunk_body: 'It is proposed that veto rights be treated as protective.' },
  ];
  const draft = [
    '## Overview',
    'An insider is a connected person or a person with access to unpublished price sensitive information [Source 1][Source 2].',
    '',
    '## Analysis',
    'Veto rights are protective and never amount to control [Source 3]. The definition has two limbs [Source 1].',
    '',
    '## Conclusion',
    'The definition decides the question [Source 1][Source 3].',
  ].join('\n');
  const { claims } = planVerification(draft, tiered);
  const verdicts = parseVerdicts(JSON.stringify({ claims: [
    { id: 1, verdict: 'SUPPORTED', sources: [1, 2] },
    { id: 2, verdict: 'NOT_AUTHORITY', sources: [3] },
    { id: 4, verdict: 'SUPPORTED', sources: [1, 3] },
  ] }), claims, tiered.length);
  const { answer, stats } = applyVerification(draft, verdicts, tiered);
  assert.match(answer, /price sensitive information \[Source 1\]\./, 'the article is dropped from a citation the Regulations already carry');
  assert.ok(!answer.includes('never amount to control'), 'a rule resting only on a discussion paper is removed');
  assert.match(answer, /decides the question \[Source 1\]\./);
  assert.strictEqual(stats.removedSentences[0].verdict, 'NOT_AUTHORITY');
});
