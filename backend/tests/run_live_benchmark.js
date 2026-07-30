require('dotenv').config();
const { performPrioritizedLegalSearch } = require('../index');
const { cohereRerank } = require('../cohereReranker');
const { getLLMProvider } = require('../llm/factory');

async function testQuery(question) {
  console.log('\n==================================================');
  console.log(`TESTING QUESTION: "${question}"`);
  console.log('==================================================');
  
  const startTime = Date.now();

  // 1. Prioritized Legal Retrieval + Cohere Reranking
  const searchStartTime = Date.now();
  const searchResults = await performPrioritizedLegalSearch(question, question);
  const searchTimeMs = Date.now() - searchStartTime;

  console.log(`\n[1. RETRIEVAL & COHERE RERANKING] Completed in ${searchTimeMs} ms (${(searchTimeMs/1000).toFixed(2)} seconds)`);
  console.log(`- Candidates Evaluated: ${searchResults.candidateCount || 0}`);
  console.log(`- Final Extracted Chunks: ${searchResults.length}`);
  
  console.log('\n--- EXTRACTED CHUNKS BREAKDOWN ---');
  searchResults.forEach((chunk, index) => {
    console.log(`Chunk #${index + 1}:`);
    console.log(`  - Table: ${chunk.source_table || 'Legislation'}`);
    console.log(`  - Title: ${chunk.doc_title || chunk.law_title || 'N/A'}`);
    console.log(`  - Section(s): ${chunk.sections || 'N/A'}`);
    console.log(`  - Category: ${chunk.category || 'N/A'}`);
    console.log(`  - Cohere Score: ${chunk.cohere_relevance_score ? chunk.cohere_relevance_score.toFixed(4) : 'N/A'}`);
    console.log(`  - Preview: ${String(chunk.chunk_text || '').substring(0, 150)}...`);
  });

  // 2. Generate Legal Response with LLM
  const llmStartTime = Date.now();
  const providerName = process.env.DEFAULT_LLM_PROVIDER || 'deepseek';
  const modelName = process.env.DEFAULT_LLM_MODEL || 'deepseek-v4-pro';
  
  let answerContent = '';
  try {
    const llm = getLLMProvider(providerName, modelName);
    
    // Build legal context from retrieved chunks
    const contextBlock = searchResults.map((c, i) => `[Source ${i+1}: ${c.source_table} - ${c.law_title || c.doc_title || ''} (${c.sections || ''})]\n${c.chunk_text}`).join('\n\n');
    
    const response = await llm.generate({
      systemPrompt: 'You are an elite Indian Corporate Law AI advisor (CLA Online). Provide a structured, highly authoritative legal analysis based on the retrieved sources.',
      messages: [
        { role: 'user', content: `Context:\n${contextBlock}\n\nQuestion: ${question}` }
      ],
      maxTokens: 1000,
      temperature: 0.2
    });
    answerContent = response.content;
  } catch (err) {
    answerContent = `[LLM Fallback Note: ${err.message}]`;
  }

  const llmTimeMs = Date.now() - llmStartTime;
  const totalTimeMs = Date.now() - startTime;

  console.log(`\n[2. LLM RESPONSE GENERATION] Completed in ${llmTimeMs} ms (${(llmTimeMs/1000).toFixed(2)} seconds)`);
  console.log(`\n[3. TOTAL PIPELINE EXECUTION TIME]: ${totalTimeMs} ms (${(totalTimeMs/1000).toFixed(2)} seconds)`);
  
  console.log('\n--- GENERATED ANSWER ---');
  console.log(answerContent);
  console.log('==================================================\n');
}

async function main() {
  try {
    await testQuery('What are the Corporate Social Responsibility (CSR) compliance requirements and mandatory spending threshold under Section 135 of Companies Act 2013?');
    await testQuery('What is the legal procedure and board approval required for Related Party Transactions under Section 188 of the Companies Act 2013?');
  } catch (err) {
    console.error('Benchmark Error:', err);
  }
  process.exit(0);
}

main();
