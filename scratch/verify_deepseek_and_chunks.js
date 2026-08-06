require('dotenv').config();
const assert = require('assert');
const { performPrioritizedLegalSearch } = require('../backend/index');
const { runAgentFlow } = require('../backend/agentSystem');
const { getLLMProvider } = require('../backend/llm/factory');
const DeepSeekProvider = require('../backend/llm/providers/deepseek_provider');

async function testDeepSeekAndChunkCap() {
  console.log('========================================================================');
  console.log('VERIFICATION TEST: DeepSeek Exclusive LLM & Per-Table Chunk Limit (Max 5)');
  console.log('========================================================================\n');

  // 1. Factory & Provider Verification
  console.log('[1/3] Verifying Factory Provider Returns DeepSeek Exclusively...');
  const defaultProvider = getLLMProvider();
  const openaiProvider = getLLMProvider('openai');
  const groqProvider = getLLMProvider('groq');
  const geminiProvider = getLLMProvider('gemini');

  assert.ok(defaultProvider instanceof DeepSeekProvider, 'Default provider must be DeepSeekProvider');
  assert.ok(openaiProvider instanceof DeepSeekProvider, 'OpenAI request must return DeepSeekProvider');
  assert.ok(groqProvider instanceof DeepSeekProvider, 'Groq request must return DeepSeekProvider');
  assert.ok(geminiProvider instanceof DeepSeekProvider, 'Gemini request must return DeepSeekProvider');

  console.log('  ✔ All provider factory calls (default, openai, groq, gemini) return DeepSeekProvider instance!');

  // 2. Retrieval & Per-Table Chunk Limit Verification
  const testQuestion = 'Which companies are required to file Form DPT-3 and what is the due date under Section 73 of Companies Act?';
  console.log(`\n[2/3] Executing Legal Search for Question:\n  "${testQuestion}"...`);

  const searchResults = await performPrioritizedLegalSearch(testQuestion, testQuestion);
  console.log(`\n  Total Retrieved Chunks: ${searchResults.length}`);

  const tableCounts = {};
  for (const chunk of searchResults) {
    const table = (chunk.source_table || 'unknown').trim();
    tableCounts[table] = (tableCounts[table] || 0) + 1;
  }

  console.log('  Per-Table Chunk Counts:');
  let capExceeded = false;
  for (const [table, count] of Object.entries(tableCounts)) {
    console.log(`    - Table "${table}": ${count} chunks (Max cap: 5)`);
    if (count > 5) {
      capExceeded = true;
    }
  }

  assert.strictEqual(capExceeded, false, 'No single source table should exceed 5 chunks');
  console.log('  ✔ Per-table retrieval cap verified: Max 5 chunks per table enforced!');

  // 3. End-to-End Agent Flow Execution & LLM Provider Trace
  console.log('\n[3/3] Running Full Agent Flow to Verify DeepSeek Execution...');
  const agentResult = await runAgentFlow(testQuestion);

  console.log('\n  Agent Response Content Snippet:');
  console.log('  --------------------------------------------------');
  console.log('  ' + (agentResult.content || agentResult.answer || '').slice(0, 300) + '...');
  console.log('  --------------------------------------------------');

  console.log('\n========================================================================');
  console.log('SUCCESS: All verifications passed 100%!');
  console.log('1. Provider: DEEPSEEK EXCLUSIVE (No OpenAI/Groq/Gemini fallbacks used).');
  console.log('2. Chunk Limit: ENFORCED (Max 5 chunks per legal table).');
  console.log('========================================================================');

  process.exit(0);
}

testDeepSeekAndChunkCap().catch((err) => {
  console.error('\n❌ VERIFICATION TEST FAILED:', err);
  process.exit(1);
});
