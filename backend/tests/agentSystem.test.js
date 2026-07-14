require('dotenv').config();
const assert = require('assert');
const test = require('node:test');
const { runAgentFlow, loadAgentPrompts } = require('../agentSystem');

test('loads and parses agent prompts correctly', () => {
  const prompts = loadAgentPrompts();
  assert.ok(prompts.SHARED_LEGAL_CONTEXT, 'Should have SHARED_LEGAL_CONTEXT');
  assert.ok(prompts.COMMON_RULES, 'Should have COMMON_RULES');
  assert.ok(prompts.Supervisor_Agent, 'Should have Supervisor_Agent');
  assert.ok(prompts.Query_Expansion_Agent, 'Should have Query_Expansion_Agent');
  assert.ok(prompts.Content_Summarizer_Agent, 'Should have Content_Summarizer_Agent');
  assert.ok(prompts.Follow_Up_Question_Agent, 'Should have Follow_Up_Question_Agent');
});

test('routes and processes a DIALOG query correctly without legal pipeline', async () => {
  try {
    const result = await runAgentFlow('Hello! Who are you?');
    assert.strictEqual(result.route, 'DIALOG');
    assert.strictEqual(result.isClarifying, false);
    assert.ok(result.content.length > 0);
    assert.deepStrictEqual(result.follow_up_questions, []);
  } catch (error) {
    console.error('DIALOG test failed:', error);
    throw error;
  }
});

test('routes and processes a LEGAL query correctly with full multi-agent flow', async () => {
  try {
    const result = await runAgentFlow('Our vendor breached the payment terms of a contract worth 15 lakhs in Delhi, India, governed by the Indian Contract Act, 1872. What recovery options do we have? Do not ask any clarifying questions.');
    console.log('\nFinal Response Content:\n', result.content);
    console.log('\nFollow up questions:\n', result.follow_up_questions);
    
    assert.strictEqual(result.route, 'LEGAL');
    assert.ok(result.content.length > 0);
    assert.ok(Array.isArray(result.follow_up_questions));
    
    if (result.isClarifying) {
      console.log('Result intercepted for clarification.');
      assert.strictEqual(result.follow_up_questions.length, 0);
    } else {
      console.log('Result completed full multi-agent flow.');
      assert.ok(result.follow_up_questions.length > 0);
    }
  } catch (error) {
    console.error('LEGAL test failed:', error);
    throw error;
  }
});
