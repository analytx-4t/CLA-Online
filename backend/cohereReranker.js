/**
 * cohereReranker.js
 * Cohere Rerank Model (rerank-v3.5) integration for CLA Online Legal Chatbot.
 * 
 * Provides state-of-the-art semantic reranking of retrieved legal document chunks,
 * combining statutory metadata, legal sections, document titles, and body content
 * to select the highest quality context for legal queries.
 */

const dotenv = require('dotenv');
const path = require('path');

// Ensure environment variables are loaded
dotenv.config({ path: path.resolve(__dirname, '.env') });

const COHERE_API_ENDPOINT = 'https://api.cohere.com/v2/rerank';
const DEFAULT_MODEL = process.env.COHERE_RERANK_MODEL || 'rerank-v3.5';
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Formats a document chunk into a rich, structured text representation
 * that includes statutory metadata, section references, category, and chunk content.
 * This enables Cohere's cross-encoder to assess deep legal relevance.
 *
 * @param {Object|string} doc - Document chunk object or raw text.
 * @returns {string} Formatted string representation for Cohere Rerank.
 */
function formatChunkForCohere(doc) {
  if (typeof doc === 'string') return doc;
  if (!doc || typeof doc !== 'object') return '';

  const title = doc.law_title || doc.doc_title ||
    (doc.original && doc.original.parent && (doc.original.parent.Title || doc.original.parent.Versus || doc.original.parent.Legislation)) ||
    (doc.original && doc.original.child && (doc.original.child.FileName || doc.original.child.Heading)) || '';

  const parts = [];
  if (title) parts.push(`Title: ${title}`);
  if (doc.sections) parts.push(`Sections: ${doc.sections}`);
  if (doc.category) parts.push(`Category: ${doc.category}`);
  if (doc.subject) parts.push(`Subject: ${doc.subject}`);
  if (doc.source_table) parts.push(`Source: ${doc.source_table}`);

  const text = doc.chunk_text || doc.content || doc.text || '';
  parts.push(`Content: ${text}`);

  return parts.join(' | ');
}

/**
 * Extracts legal section numbers from a query string (e.g. "Section 188", "sec 135").
 *
 * @param {string} query 
 * @returns {string[]} List of normalized section identifiers (e.g. ["188", "135"])
 */
function extractRequestedSections(query) {
  if (!query || typeof query !== 'string') return [];
  const matches = [...query.matchAll(/\b(?:section|sec\.?)\s+(\d+[a-z]?)\b/gi)];
  return matches.map(m => m[1].toLowerCase());
}

/**
 * Reranks candidate document chunks using Cohere Rerank API (v2).
 *
 * @param {string} query - User's legal question or search query.
 * @param {Array<Object>} documents - Candidate chunk objects retrieved from DB.
 * @param {number} topK - Maximum number of top reranked results to return.
 * @param {Object} [options] - Configuration options.
 * @param {string} [options.model] - Cohere model name (default: rerank-v3.5).
 * @param {number} [options.timeoutMs] - Request timeout in ms (default: 5000).
 * @param {number} [options.minScore] - Minimum relevance score threshold (default: 0.005).
 * @param {string} [options.apiKey] - Optional override for Cohere API key.
 * @returns {Promise<Array<Object>>} Reranked array of document chunk objects with score fields.
 */
async function cohereRerank(query, documents, topK = 5, options = {}) {
  if (!Array.isArray(documents) || documents.length === 0) {
    return [];
  }
  if (!query || typeof query !== 'string' || !query.trim()) {
    return documents.slice(0, topK);
  }

  const apiKey = options.apiKey || process.env.COHERE_API_KEY;
  if (!apiKey) {
    throw new Error('COHERE_API_KEY is not set in environment or options');
  }

  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const minScore = typeof options.minScore === 'number' ? options.minScore : 0.005;

  // Format each document for Cohere cross-attention
  const formattedDocs = documents.map(doc => formatChunkForCohere(doc));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(COHERE_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        query: query.trim(),
        documents: formattedDocs,
        top_n: Math.min(documents.length, Math.max(topK * 2, 30)) // Request comprehensive candidate slice
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Cohere API returned HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    if (!data || !Array.isArray(data.results)) {
      throw new Error('Invalid response structure from Cohere Rerank API');
    }

    const requestedSections = extractRequestedSections(query);

    // Map Cohere's indexed results back to document objects with scores
    const scoredDocs = data.results.map(item => {
      const origDoc = documents[item.index];
      const rawScore = typeof item.relevance_score === 'number' ? item.relevance_score : 0;
      
      let sectionBonus = 0;
      if (requestedSections.length > 0 && origDoc) {
        const searchableSections = String(origDoc.sections || '').toLowerCase();
        for (const sec of requestedSections) {
          if (searchableSections.includes(sec)) {
            sectionBonus += 0.05; // 5% bonus for exact statutory section match
          }
        }
      }

      // Legal Table Priority Hierarchy Weighting Bonus
      let tableBonus = 0;
      if (origDoc) {
        const srcTable = String(origDoc.source_table || origDoc.category || '').toLowerCase();
        if (srcTable.includes('legis') || srcTable.includes('statute')) {
          tableBonus = 0.04; // Priority 1: Legislation
        } else if (srcTable.includes('comm')) {
          tableBonus = 0.03; // Priority 2: CLASE Commentary
        } else if (srcTable.includes('case')) {
          tableBonus = 0.02; // Priority 3: Judicial Precedents
        } else if (srcTable.includes('notif') || srcTable.includes('circ')) {
          tableBonus = 0.01; // Priority 4: Notifications & Circulars
        }
      }

      const finalScore = Math.min(1.0, rawScore + sectionBonus + tableBonus);

      return {
        ...origDoc,
        cohere_relevance_score: rawScore,
        cohere_final_score: finalScore,
        backend_relevance_score: finalScore,
        rerank_method: `cohere_${model}`
      };
    });

    // Sort descending by final score
    scoredDocs.sort((a, b) => b.cohere_final_score - a.cohere_final_score);

    // Filter out chunks below minScore threshold if we have strong top candidates
    const bestScore = scoredDocs[0]?.cohere_final_score || 0;
    const effectiveMinScore = Math.min(minScore, bestScore * 0.01);

    const relevantDocs = scoredDocs.filter(d => d.cohere_final_score >= effectiveMinScore);

    const result = (relevantDocs.length > 0 ? relevantDocs : scoredDocs).slice(0, topK);

    console.log(`[Cohere Reranker] Reranked ${documents.length} candidates down to ${result.length} (Model: ${model}, Top Score: ${bestScore.toFixed(4)})`);
    return result;

  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Cohere Rerank API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }
}

module.exports = {
  cohereRerank,
  formatChunkForCohere,
  extractRequestedSections
};
