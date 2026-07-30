/**
 * Legal Query Normalizer for CLA Online RAG Pipeline
 *
 * Automatically expands Indian legal shorthand, section number references,
 * and corporate abbreviations so both vector search and SQL keyword search
 * accurately match relevant legal database chunks. Also sanitizes smart quotes.
 */

function normalizeLegalQuery(queryText) {
  if (!queryText || typeof queryText !== 'string') return queryText;
  let normalized = queryText;

  // 0. Sanitize unicode smart quotes / curly quotes
  normalized = normalized
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2013|\u2014/g, '-');

  // 1. Section & Article number shorthand:
  // u/s 68, u/s. 68, u/sec 68, sec. 68, sec 68 -> Section 68
  normalized = normalized.replace(/\bu\/s\.?\s*(\d+[A-Za-z]?)\b/gi, 'Section $1');
  normalized = normalized.replace(/\bu\/sec\.?\s*(\d+[A-Za-z]?)\b/gi, 'Section $1');
  normalized = normalized.replace(/\bsec\.?\s*(\d+[A-Za-z]?)\b/gi, 'Section $1');
  normalized = normalized.replace(/\bart\.?\s*(\d+[A-Za-z]?)\b/gi, 'Article $1');
  normalized = normalized.replace(/\br\/w\b/gi, 'read with');

  // 2. Expand common Indian corporate & insolvency abbreviations:
  normalized = normalized.replace(/\bunlisted co\b/gi, 'unlisted company');
  normalized = normalized.replace(/\bpvt ltd\b/gi, 'private limited');
  normalized = normalized.replace(/\bcirp\b/gi, 'Corporate Insolvency Resolution Process (CIRP)');
  normalized = normalized.replace(/\brp\b/gi, 'Resolution Professional (RP)');
  normalized = normalized.replace(/\bcoc\b/gi, 'Committee of Creditors (CoC)');
  normalized = normalized.replace(/\bnclt\b/gi, 'National Company Law Tribunal (NCLT)');
  normalized = normalized.replace(/\bnclat\b/gi, 'National Company Law Appellate Tribunal (NCLAT)');
  normalized = normalized.replace(/\bsebi\b/gi, 'Securities and Exchange Board of India (SEBI)');
  normalized = normalized.replace(/\bmca\b/gi, 'Ministry of Corporate Affairs (MCA)');

  return normalized;
}

module.exports = { normalizeLegalQuery };
