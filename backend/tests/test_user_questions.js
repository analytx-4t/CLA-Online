require('dotenv').config();
const { checkGuardrails } = require('../guardrails');
const { performPrioritizedLegalSearch } = require('../index');

async function testQuestion(label, question) {
  console.log(`\n======================================================`);
  console.log(`TESTING ${label}: "${question}"`);
  console.log(`======================================================`);

  const startTime = Date.now();

  // 1. Guardrail Test
  const guardResult = await checkGuardrails(question);
  console.log(`Guardrail Result: Action=${guardResult?.action || 'CONTINUE'}, Category=${guardResult?.category || 'NONE'}`);
  if (guardResult?.action === 'RESPOND') {
    console.log(`BLOCKED BY GUARDRAIL! Response:\n${guardResult.response}`);
    return;
  }

  // 2. Search & Cohere Rerank Test
  console.log(`Performing Prioritized Search & Cohere Rerank...`);
  const results = await performPrioritizedLegalSearch(question, question);
  const elapsedMs = Date.now() - startTime;

  console.log(`\n[Search Completed in ${elapsedMs} ms]`);
  console.log(`Retrieved & Reranked Chunks Count: ${results.length}`);
  
  results.forEach((r, idx) => {
    console.log(`  [${idx + 1}] SourceTable: ${r.source_table} | Title: ${r.doc_title || 'N/A'} | Sec: ${r.sections || 'N/A'}`);
    console.log(`      Snippet: ${(r.chunk_text || r.content || '').substring(0, 140).replace(/\n/g, ' ')}...`);
  });
}

async function runAll() {
  await testQuestion('QUESTION 1 (Buy Back Shares u/s 68)', 'Unlisted co wants to buy back some shares. What resolution do we need u/s 68, and is there anything in law that could block it?');
  await testQuestion('QUESTION 2 (Co-op Society in CIRP & Bye-laws)', 'Our multi-state co-op society invested in a company now in CIRP. RP says we\'re not in the "same line of business". Is that read off our bye-laws or off actual turnover and profit?');
  process.exit(0);
}

runAll().catch(console.error);
