const test = require('node:test');
const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { cohereRerank, formatChunkForCohere, extractRequestedSections } = require('../cohereReranker');

test.describe('Cohere Reranker Unit Tests', () => {

  test('extractRequestedSections parses section numbers correctly', () => {
    assert.deepStrictEqual(extractRequestedSections('What is Section 188 of Companies Act?'), ['188']);
    assert.deepStrictEqual(extractRequestedSections('Explain sec. 135 and section 184(1)'), ['135', '184']);
    assert.deepStrictEqual(extractRequestedSections('General question without sections'), []);
  });

  test('formatChunkForCohere prepares structured document text', () => {
    const chunk = {
      law_title: 'Companies Act 2013',
      sections: 'Section 188',
      category: 'Statute',
      subject: 'Related Party Transactions',
      chunk_text: 'No company shall enter into any contract or arrangement with a related party...'
    };

    const formatted = formatChunkForCohere(chunk);
    assert.ok(formatted.includes('Title: Companies Act 2013'));
    assert.ok(formatted.includes('Sections: Section 188'));
    assert.ok(formatted.includes('Category: Statute'));
    assert.ok(formatted.includes('Subject: Related Party Transactions'));
    assert.ok(formatted.includes('Content: No company shall enter into any contract or arrangement'));
  });

  test('cohereRerank returns top reranked items with cohere_relevance_score', async () => {
    const query = 'What is the corporate social responsibility CSR requirement under Companies Act 2013?';
    const documents = [
      {
        embedding_id: 101,
        law_title: 'Companies Act 2013',
        sections: 'Section 188',
        chunk_text: 'Section 188 relates to related party transactions and requires board approval for contracts with directors.'
      },
      {
        embedding_id: 102,
        law_title: 'Companies Act 2013',
        sections: 'Section 135',
        chunk_text: 'Every company having net worth of rupees five hundred crore or more, or turnover of rupees one thousand crore or more, shall constitute a Corporate Social Responsibility Committee.'
      },
      {
        embedding_id: 103,
        law_title: 'Companies Act 2013',
        sections: 'Section 184',
        chunk_text: 'Disclosure of interest by directors during board meetings.'
      }
    ];

    const reranked = await cohereRerank(query, documents, 2);

    assert.strictEqual(reranked.length, 2, 'Should return top 2 documents');
    assert.strictEqual(reranked[0].embedding_id, 102, 'Top ranked document should be Section 135 CSR');
    assert.ok(typeof reranked[0].cohere_relevance_score === 'number', 'Should have cohere_relevance_score');
    assert.ok(reranked[0].cohere_relevance_score > reranked[1].cohere_relevance_score, 'Scores should be sorted descending');
    console.log(`Top result: ${reranked[0].law_title} (${reranked[0].sections}) - Score: ${reranked[0].cohere_relevance_score}`);
  });

  test('cohereRerank fails gracefully with invalid API key', async () => {
    const query = 'Test query';
    const docs = [{ chunk_text: 'Some test text' }];

    await assert.rejects(
      async () => {
        await cohereRerank(query, docs, 1, { apiKey: 'invalid_key_12345' });
      },
      (err) => {
        assert.ok(err.message.includes('Cohere API returned HTTP 401') || err.message.includes('invalid') || err.message.includes('401'));
        return true;
      }
    );
  });
});
