const test = require('node:test');
const assert = require('assert');
const { digitsIn, figuresIn, statesFigure } = require('../legalFigures');
const { guardFigures, planVerification, parseVerdicts, applyVerification } = require('../answerVerifier');
const { wordLimitFor, wordCount, rejectionReason, condenseIfLong } = require('../answerCondenser');

test('figures written in words and in digits are the same figure', () => {
  assert.strictEqual(digitsIn('twenty-five per cent within one hundred and eighty-two days'), '25 per cent within 182 days');
  assert.deepStrictEqual(figuresIn('25% of the voting rights, and more than five per cent in a year'), [
    { number: '25', unit: 'percent' }, { number: '5', unit: 'percent' },
  ]);
  assert.ok(statesFigure(digitsIn('within nine months from the date of export'), { number: '9', unit: 'month' }));
  assert.ok(!statesFigure(digitsIn('within nineteen months'), { number: '9', unit: 'month' }));
  assert.ok(!statesFigure(digitsIn('exceeds 125 per cent'), { number: '25', unit: 'percent' }));
  assert.deepStrictEqual(figuresIn('in the last three financial years'), [], 'a number is a figure only with its unit beside it');
});

const PASSAGES = [
  { source_table: 'Legislation', authority_tier: 'legislation', doc_title: 'Takeover Regulations, 2011', provision_ref: 'Regulation 3',
    chunk_body: 'No acquirer shall acquire shares which entitle them to exercise twenty-five per cent or more of the voting rights unless the acquirer makes a public announcement of an open offer.' },
  { source_table: 'Circular', authority_tier: 'regulator_paper', doc_title: 'Discussion Paper on amendments', chunk_body: 'The committee considered the open offer obligations of acquirers.' },
  { source_table: 'Articles', authority_tier: 'article', doc_title: 'Takeover Code', chunk_body: 'An acquirer crossing fifteen per cent had to make an offer under the 1997 code.' },
];
const DRAFT = [
  '## Overview',
  'An open offer is required once the acquirer crosses the statutory threshold [Source 1].',
  '',
  '## Analysis',
  'The obligation is triggered at the 25% voting-rights threshold [Source 2]. The offer must be completed within 45 days [Source 1]. An 18% holder is below the threshold [Source 1].',
  '',
  '## Conclusion',
  'The trigger is twenty-five per cent of the voting rights [Source 1].',
].join('\n');

function guarded(question) {
  const { claims } = planVerification(DRAFT, PASSAGES);
  const verdicts = parseVerdicts(JSON.stringify({ claims: claims.map((c) => ({ id: c.id, verdict: 'SUPPORTED', sources: c.numbers })) }), claims, PASSAGES.length);
  return guardFigures(verdicts, PASSAGES, question);
}

test('a figure cited to a passage that does not state it is re-cited to the law that does', () => {
  const verdicts = guarded('An investor holds 18%. Does it have to make an open offer?');
  const threshold = verdicts.find((v) => /25% voting-rights/.test(v.claim.sentence));
  assert.strictEqual(threshold.figureGuard, 'reattributed');
  assert.deepStrictEqual(threshold.sources, [1]);
  const { answer } = applyVerification(DRAFT, verdicts, PASSAGES);
  assert.match(answer, /25% voting-rights threshold \[Source 1\]\./);
});

test('a figure no passage states is removed; a figure from the question is left alone', () => {
  const verdicts = guarded('An investor holds 18%. Does it have to make an open offer?');
  const invented = verdicts.find((v) => /45 days/.test(v.claim.sentence));
  assert.strictEqual(invented.verdict, 'UNSUPPORTED');
  const fromQuestion = verdicts.find((v) => /18% holder/.test(v.claim.sentence));
  assert.strictEqual(fromQuestion.verdict, 'SUPPORTED');
  const { answer, stats } = applyVerification(DRAFT, verdicts, PASSAGES);
  assert.ok(!answer.includes('45 days'));
  assert.ok(answer.includes('An 18% holder is below the threshold'));
  assert.strictEqual(stats.removed, 1);
});

test('a single question gets 400 words, a two-part or procedural one 650', () => {
  assert.strictEqual(wordLimitFor('Who is an insider?'), 400);
  assert.strictEqual(wordLimitFor('And who is a connected person?'), 400);
  assert.strictEqual(wordLimitFor('What is UPSI and what are the restrictions on communicating it?'), 650);
  assert.strictEqual(wordLimitFor('How can the company regularise this?'), 650);
});

const LONG = ['## Overview', 'Regulation 2(1)(g) defines an insider [Source 1].', '', '## Analysis', `${'The definition has two limbs [Source 1]. '.repeat(90)}`, '', '## Conclusion', 'An insider is a connected person or a person with access to the information [Source 1].'].join('\n');
const SHORT = ['## Overview', 'Regulation 2(1)(g) defines an insider [Source 1].', '', '## Analysis', `${'The definition has two limbs [Source 1]. '.repeat(40)}`, '', '## Conclusion', 'An insider is a connected person or a person with access to the information [Source 1].'].join('\n');

test('a shortened answer is accepted only if it adds nothing', async () => {
  assert.strictEqual(rejectionReason(LONG, SHORT), null);
  assert.match(rejectionReason(LONG, SHORT.replace('two limbs', 'two limbs under Regulation 4')), /added provision 4/);
  assert.match(rejectionReason(LONG, SHORT.replace('two limbs', 'two limbs within 30 days')), /added figure 30 day/);
  assert.match(rejectionReason(LONG, SHORT.replace('[Source 1]. ', '[Source 7]. ')), /new citation marker/);
  assert.match(rejectionReason(LONG, SHORT.replace('## Conclusion', 'Conclusion')), /heading lost/);
  assert.strictEqual(rejectionReason(LONG, LONG), 'not shorter');

  const used = await condenseIfLong({ answer: LONG, question: 'Who is an insider?', generate: async () => ({ content: SHORT }) });
  assert.strictEqual(used.stats.applied, true);
  assert.ok(wordCount(used.answer) < wordCount(LONG));

  const refused = await condenseIfLong({ answer: LONG, question: 'Who is an insider?', generate: async () => ({ content: SHORT.replace('two limbs', 'three limbs under Section 9') }) });
  assert.strictEqual(refused.stats.applied, false);
  assert.strictEqual(refused.answer, LONG);

  const failed = await condenseIfLong({ answer: LONG, question: 'Who is an insider?', generate: async () => { throw new Error('down'); } });
  assert.strictEqual(failed.answer, LONG);
});

test('an answer within its limit is not touched', async () => {
  let called = false;
  const result = await condenseIfLong({ answer: SHORT.replace(/(The definition has two limbs \[Source 1\]\. ){40}/, 'The definition has two limbs [Source 1]. '), question: 'Who is an insider?', generate: async () => { called = true; return { content: '' }; } });
  assert.strictEqual(called, false);
  assert.strictEqual(result.stats.applied, false);
});
