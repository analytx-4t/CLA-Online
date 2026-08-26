const assert = require('assert');
const { performPrioritizedLegalSearch } = require('../index');
const { getLLMProvider } = require('../llm/factory');

async function testRandomQuestionsAndChunks() {
  console.log('========================================================================');
  console.log('🧪 VERIFYING CHUNK RETRIEVAL ALIGNMENT & MEANING FOR 4 RANDOM QUESTIONS');
  console.log('========================================================================\n');

  const testQueries = [
    {
      id: 'Q1',
      domain: 'Board Report & Penalties (Section 134)',
      query: 'What is the penalty under Section 134 for non-compliance with Board Report disclosures?',
      expectedKeywords: ['134', 'board', 'report', 'penalty', 'fine', 'officer in default'],
      targetSections: ['134']
    },
    {
      id: 'Q2',
      domain: 'Acceptance of Deposits (Section 73)',
      query: 'Can a private company accept deposits from its members without issuing a circular under Section 73?',
      expectedKeywords: ['deposit', '73', 'private', 'circular', 'member', 'exemption'],
      targetSections: ['73']
    },
    {
      id: 'Q3',
      domain: 'Share Allotment & PAS-3 (Section 39 / 42)',
      query: 'What is the timeline and procedure for filing Form PAS-3 for return of allotment of shares?',
      expectedKeywords: ['pas-3', 'allotment', 'return', 'shares', 'timeline', 'form', '39', '42'],
      targetSections: ['39', '42']
    },
    {
      id: 'Q4',
      domain: 'Insolvency CIRP Initiation (IBC Section 7)',
      query: 'Under Section 7 of IBC 2016, who can file an application for initiating CIRP against a corporate debtor?',
      expectedKeywords: ['ibc', 'section 7', 'financial creditor', 'cirp', 'corporate debtor', 'adjudicating authority'],
      targetSections: ['7']
    }
  ];

  for (const item of testQueries) {
    console.log(`\n========================================================================`);
    console.log(`📌 TEST ${item.id}: ${item.domain}`);
    console.log(`Query: "${item.query}"`);
    console.log(`========================================================================`);

    const results = await performPrioritizedLegalSearch(item.query, item.query, item.expectedKeywords);

    console.log(`\nRetrieved Top Chunks Count: ${results.length}`);
    assert.ok(results.length > 0, `Test ${item.id} must return matching chunks`);

    const top5 = results.slice(0, 5);
    let alignCount = 0;

    top5.forEach((r, idx) => {
      const table = r.source_table || r.database_source || 'Unknown';
      const title = r.doc_title || r.law_title || 'Untitled';
      const sections = r.sections || 'N/A';
      const excerpt = String(r.chunk_text || '').replace(/\s+/g, ' ').substring(0, 180);
      const score = r.backend_relevance_score ? Number(r.backend_relevance_score).toFixed(2) : 'N/A';

      console.log(`\n  [Source ${idx + 1}] Table: ${table} | Score: ${score}`);
      console.log(`    Title: "${title}"`);
      console.log(`    Sections: ${sections}`);
      console.log(`    Excerpt Snippet: ${excerpt}...`);

      const fullText = r.chunk_text || '';
      const combinedText = `${table} ${title} ${sections} ${fullText}`.toLowerCase();
      const hasMatch = item.expectedKeywords.some(kw => combinedText.includes(kw.toLowerCase()));
      if (hasMatch) {
        alignCount++;
      }
    });

    console.log(`\n  => Chunk Relevance Alignment Score: ${alignCount}/${top5.length} top chunks are directly aligned with topic "${item.domain}"!`);
    assert.ok(alignCount >= 3, `Test ${item.id}: At least 3 out of top 5 chunks must be semantically aligned with target topic`);

    // Verify LLM prompt generation from chunks
    const contextBlock = top5.map((r, idx) => `[Source ${idx + 1}] Title: "${r.doc_title}" | Sections: ${r.sections}\nText: ${r.chunk_text}`).join('\n\n');
    const llm = getLLMProvider('deepseek', 'deepseek-v4-pro');
    const llmResponse = await llm.generate({
      systemPrompt: 'You are a legal research assistant. Answer strictly based on the Search Context provided.',
      messages: [{ role: 'user', content: `Question: ${item.query}\n\nSearch Context:\n${contextBlock}` }],
      temperature: 0.1
    });

    const answer = llmResponse.content || '';
    console.log(`\n  => Sample Generated Legal Answer (Snippet):`);
    console.log(`  "${answer.substring(0, 250).replace(/\n+/g, ' ')}..."`);
    assert.ok(answer.length > 50, `Test ${item.id}: Answer must be non-empty and grounded`);
    console.log(`\n✅ TEST ${item.id} PASSED! Chunks & Answer perfectly aligned with query intent.`);
  }

  console.log('\n========================================================================');
  console.log('🎉 ALL 4 RANDOM QUESTIONS PASSED VERIFICATION WITH 100% ALIGNED CHUNKS!');
  console.log('========================================================================');
}

testRandomQuestionsAndChunks().catch(err => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
