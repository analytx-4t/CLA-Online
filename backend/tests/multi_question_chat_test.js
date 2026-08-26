const assert = require('assert');
const { contextualizeUserQuery } = require('../contextualizer');

async function runMultiTurnTestSuite() {
  console.log('================================================================');
  console.log('🧪 Comprehensive Multi-Turn Legal Chat Evaluation Suite');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // Scenario 1: Independent Directors & Exemptions & Penalties (3 Turns)
  // -------------------------------------------------------------------------
  console.log('--- SCENARIO 1: Independent Directors & Exemptions & Penalties ---');

  const scenario1_history = [
    {
      role: 'user',
      content: 'What are the statutory requirements for appointment of Independent Directors under Companies Act 2013?'
    },
    {
      role: 'assistant',
      content: 'Under Section 149(4) of Companies Act 2013 read with Rule 4 of Companies (Appointment and Qualification of Directors) Rules 2014, every listed public company must have at least one-third of its total number of directors as independent directors. Specified public unlisted companies with paid-up capital >= 10 crore or turnover >= 100 crore or outstanding loans/deposits > 50 crore must have at least 2 independent directors.'
    }
  ];

  const s1_turn2 = 'is there any exemption for unlisted public companies?';
  console.log(`\nTurn 2 Question: "${s1_turn2}"`);
  const res1_t2 = await contextualizeUserQuery({
    question: s1_turn2,
    chatHistory: scenario1_history
  });
  console.log('Contextualized Output:', JSON.stringify(res1_t2, null, 2));

  assert.strictEqual(res1_t2.isFollowUp, true, 'S1 Turn 2 must be classified as follow-up');
  assert.ok(/independent director|unlisted|section 149/i.test(res1_t2.standaloneQuery), 'S1 Turn 2 query must incorporate Independent Directors context');

  // Update history with Turn 2
  scenario1_history.push({ role: 'user', content: s1_turn2 });
  scenario1_history.push({ role: 'assistant', content: res1_t2.standaloneQuery });

  const s1_turn3 = 'what about the penalty for non-compliance?';
  console.log(`\nTurn 3 Question: "${s1_turn3}"`);
  const res1_t3 = await contextualizeUserQuery({
    question: s1_turn3,
    chatHistory: scenario1_history
  });
  console.log('Contextualized Output:', JSON.stringify(res1_t3, null, 2));

  assert.strictEqual(res1_t3.isFollowUp, true, 'S1 Turn 3 must be classified as follow-up');
  assert.ok(/penalty|independent director|section 172|section 149/i.test(res1_t3.standaloneQuery), 'S1 Turn 3 query must incorporate Independent Directors penalty context');

  console.log('✅ Scenario 1 PASSED!\n');

  // -------------------------------------------------------------------------
  // Scenario 2: CSR Spending & Unspent Funds & Exceptions (3 Turns)
  // -------------------------------------------------------------------------
  console.log('--- SCENARIO 2: CSR Spending & Unspent Funds & Exceptions ---');

  const scenario2_history = [
    {
      role: 'user',
      content: 'How does Section 135 regulate Corporate Social Responsibility (CSR) spending?'
    },
    {
      role: 'assistant',
      content: 'Section 135 of Companies Act 2013 mandates that qualifying companies (net worth >= 500 cr, turnover >= 1000 cr, or net profit >= 5 cr) must spend at least 2% of their average net profits of the preceding three financial years on CSR activities.'
    }
  ];

  const s2_turn2 = 'can unspent CSR funds be carried forward to next financial year?';
  console.log(`\nTurn 2 Question: "${s2_turn2}"`);
  const res2_t2 = await contextualizeUserQuery({
    question: s2_turn2,
    chatHistory: scenario2_history
  });
  console.log('Contextualized Output:', JSON.stringify(res2_t2, null, 2));

  assert.strictEqual(res2_t2.isFollowUp, true, 'S2 Turn 2 must be classified as follow-up');
  assert.ok(/CSR|unspent|Section 135|Unspent CSR Account/i.test(res2_t2.standaloneQuery), 'S2 Turn 2 query must incorporate CSR unspent funds context');

  // Update history with Turn 2
  scenario2_history.push({ role: 'user', content: s2_turn2 });
  scenario2_history.push({ role: 'assistant', content: res2_t2.standaloneQuery });

  const s2_turn3 = 'what if the company has a CSR committee exception?';
  console.log(`\nTurn 3 Question: "${s2_turn3}"`);
  const res2_t3 = await contextualizeUserQuery({
    question: s2_turn3,
    chatHistory: scenario2_history
  });
  console.log('Contextualized Output:', JSON.stringify(res2_t3, null, 2));

  assert.strictEqual(res2_t3.isFollowUp, true, 'S2 Turn 3 must be classified as follow-up');
  assert.ok(/CSR|committee|Section 135|50 lakh/i.test(res2_t3.standaloneQuery), 'S2 Turn 3 query must incorporate CSR committee exemption context');

  console.log('✅ Scenario 2 PASSED!\n');

  // -------------------------------------------------------------------------
  // Scenario 3: Related Party Transactions -> Topic Shift to IBC (3 Turns)
  // -------------------------------------------------------------------------
  console.log('--- SCENARIO 3: Related Party Transactions (RPT) -> Shift to IBC ---');

  const scenario3_history = [
    {
      role: 'user',
      content: 'What is the procedure for approval of Related Party Transactions under Section 188?'
    },
    {
      role: 'assistant',
      content: 'Under Section 188 of Companies Act 2013, related party transactions require prior consent of the Board of Directors given at a meeting, and for transactions exceeding prescribed thresholds, prior approval of shareholders by ordinary resolution is required.'
    }
  ];

  const s3_turn2 = 'does omnibus approval by Audit Committee apply to private companies?';
  console.log(`\nTurn 2 Question: "${s3_turn2}"`);
  const res3_t2 = await contextualizeUserQuery({
    question: s3_turn2,
    chatHistory: scenario3_history
  });
  console.log('Contextualized Output:', JSON.stringify(res3_t2, null, 2));

  assert.strictEqual(res3_t2.isFollowUp, true, 'S3 Turn 2 must be classified as follow-up');
  assert.ok(/omnibus|Audit Committee|Section 177|Section 188|Related Party/i.test(res3_t2.standaloneQuery), 'S3 Turn 2 query must incorporate Related Party / Audit Committee context');

  // Update history with Turn 2
  scenario3_history.push({ role: 'user', content: s3_turn2 });
  scenario3_history.push({ role: 'assistant', content: res3_t2.standaloneQuery });

  const s3_turn3 = 'What is the limitation period for filing insolvency application under IBC Section 7?';
  console.log(`\nTurn 3 Question: "${s3_turn3}"`);
  const res3_t3 = await contextualizeUserQuery({
    question: s3_turn3,
    chatHistory: scenario3_history
  });
  console.log('Contextualized Output:', JSON.stringify(res3_t3, null, 2));

  assert.strictEqual(res3_t3.isFollowUp, false, 'S3 Turn 3 is a NEW topic (IBC Section 7) and must be marked isFollowUp: false');
  assert.ok(/IBC|Section 7|insolvency|limitation/i.test(res3_t3.standaloneQuery), 'S3 Turn 3 query must retain IBC Section 7 question');

  console.log('✅ Scenario 3 PASSED!\n');

  console.log('================================================================');
  console.log('🎉 ALL MULTI-TURN TEST SCENARIOS COMPLETED AND PASSED PERFECTLY!');
  console.log('================================================================');
}

runMultiTurnTestSuite().catch((err) => {
  console.error('❌ Multi-turn test suite failed:', err);
  process.exit(1);
});
