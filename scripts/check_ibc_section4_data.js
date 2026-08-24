const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });

const { performPrioritizedLegalSearch } = require('../backend/index');

async function testQuery() {
  const query = "What is the threshold limit of default for initiating Corporate Insolvency Resolution Process (CIRP) under Section 4 of the Insolvency and Bankruptcy Code, 2016?";
  console.log('Testing query:', query);

  const results = await performPrioritizedLegalSearch(query, query);
  console.log(`\nRetrieved ${results.length} chunks from database:`);

  results.forEach((r, i) => {
    console.log(`\n--- [Result ${i+1}] ---`);
    console.log(`Title: ${r.doc_title || 'N/A'}`);
    console.log(`Table: ${r.source_table || 'N/A'}`);
    console.log(`Sections: ${r.sections || 'N/A'}`);
    console.log(`Excerpt: ${(r.chunk_text || '').slice(0, 300)}...`);
  });

  process.exit(0);
}

testQuery().catch(err => {
  console.error(err);
  process.exit(1);
});
