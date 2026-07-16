const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnswerAndSuggestions, normalizeFollowUpQuestions } = require('../responseParser');

test('parses follow-up suggestions from the marker block', () => {
  const rawAnswer = [
    'Here is the answer',
    '',
    '---SUGGESTIONS---',
    'What is the next step?',
    'How does this apply?',
    'What are the relevant authorities?'
  ].join('\n');

  const { answer, suggestions } = parseAnswerAndSuggestions(rawAnswer);

  assert.equal(answer, 'Here is the answer');
  assert.deepStrictEqual(suggestions, [
    'What is the next step?',
    'How does this apply?',
    'What are the relevant authorities?'
  ]);
});

test('normalizes follow-up questions from common response property names', () => {
  const normalized = normalizeFollowUpQuestions({
    followUpQuestions: ['A', 'B']
  });

  assert.deepStrictEqual(normalized, ['A', 'B']);
});
