const assert = require('assert');
const { contextualizeUserQuery } = require('../contextualizer');

async function testMultiturnContextualizer() {
  console.log('====================================================');
  console.log('🧪 Testing Multi-Turn Follow-Up Query Contextualizer');
  console.log('====================================================');

  // Test 1: User asks initial question, then asks a dependent follow-up question
  console.log('\n--- Test 1: Dependent Follow-Up Question ---');
  const chatHistory1 = [
    {
      role: 'user',
      content: 'Can an indian company take loan from its foreign parent to expand its factory? statutory compliance'
    },
    {
      role: 'assistant',
      content: 'Under the Companies Act 2013 and RBI External Commercial Borrowings (ECB) Framework, an Indian company can raise loans from its foreign parent subject to Section 185/186 compliance and ECB Master Directions.'
    }
  ];
  const followUpQuestion1 = 'are there any relaxation for private companies';

  console.log(`Original Follow-up Question: "${followUpQuestion1}"`);
  const result1 = await contextualizeUserQuery({
    question: followUpQuestion1,
    chatHistory: chatHistory1
  });

  console.log('Contextualizer Output:', JSON.stringify(result1, null, 2));

  assert.strictEqual(result1.isFollowUp, true, 'Result 1 should be marked as isFollowUp: true');
  assert.ok(result1.standaloneQuery.length > followUpQuestion1.length, 'Standalone query should be rephrased and richer than original follow-up');
  assert.ok(/private|loan|foreign|parent|company|section 185/i.test(result1.standaloneQuery), 'Standalone query should incorporate statutory foreign loan context');
  console.log('✅ Test 1 PASSED: Dependent follow-up successfully rephrased into canonical legal query!');

  // Test 2: User asks an independent question after previous context
  console.log('\n--- Test 2: Independent New Question ---');
  const followUpQuestion2 = 'What is the threshold limit for CSR applicability under Section 135?';

  console.log(`Original Independent Question: "${followUpQuestion2}"`);
  const result2 = await contextualizeUserQuery({
    question: followUpQuestion2,
    chatHistory: chatHistory1
  });

  console.log('Contextualizer Output:', JSON.stringify(result2, null, 2));
  assert.strictEqual(result2.isFollowUp, false, 'Result 2 should be marked as isFollowUp: false');
  assert.ok(/CSR|Section 135/i.test(result2.standaloneQuery), 'Standalone query should retain CSR subject matter');
  console.log('✅ Test 2 PASSED: Independent question correctly detected!');

  console.log('\n🎉 ALL MULTI-TURN CONTEXTUALIZER TESTS PASSED SUCCESSFULLY!');
}

testMultiturnContextualizer().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
