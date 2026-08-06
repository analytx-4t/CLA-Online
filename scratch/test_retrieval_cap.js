/**
 * UNIT TEST — Change 1: Per-Table Top-3 Chunk Cap Logic
 *
 * Tests the capPerTable helper in isolation using mock data
 * that simulates what rerankSearchResults() returns.
 *
 * Run: node scratch/test_retrieval_cap.js
 */

'use strict';

// ─── Reproduce the exact capPerTable logic from backend/index.js ──────────────
const TOP_CHUNKS_PER_TABLE = 3;

function capPerTable(results, maxPerTable = TOP_CHUNKS_PER_TABLE) {
  const tableBuckets = {};
  for (const r of results) {
    const tableKey = (r.source_table || 'unknown').trim().toLowerCase();
    if (!tableBuckets[tableKey]) tableBuckets[tableKey] = [];
    if (tableBuckets[tableKey].length < maxPerTable) {
      tableBuckets[tableKey].push(r);
    }
  }
  return Object.values(tableBuckets)
    .flat()
    .sort((a, b) => (b.backend_relevance_score || 0) - (a.backend_relevance_score || 0));
}

// ─── Mock reranked result set (simulates Cohere reranker output) ──────────────
// 7 tables, varying number of results per table, already sorted by score descending
function makeMock(table, id, score) {
  return { source_table: table, doc_title: `Doc-${table}-${id}`, backend_relevance_score: score };
}

const mockOtherResults = [
  // Caselaw — 6 results (should be capped to 3)
  makeMock('Caselaw',      1, 9.8),
  makeMock('Caselaw',      2, 9.5),
  makeMock('Caselaw',      3, 9.1),
  makeMock('Caselaw',      4, 8.7),
  makeMock('Caselaw',      5, 8.2),
  makeMock('Caselaw',      6, 7.9),
  // Circular — 4 results (should be capped to 3)
  makeMock('Circular',     1, 8.9),
  makeMock('Circular',     2, 8.4),
  makeMock('Circular',     3, 7.6),
  makeMock('Circular',     4, 7.1),
  // Commentary — 3 results (exactly 3, no cap needed)
  makeMock('Commentary',   1, 7.8),
  makeMock('Commentary',   2, 7.2),
  makeMock('Commentary',   3, 6.9),
  // Article — 2 results (under cap)
  makeMock('Article',      1, 7.4),
  makeMock('Article',      2, 6.8),
  // Notification — 1 result
  makeMock('Notification', 1, 8.1),
  // Query — 5 results (should be capped to 3)
  makeMock('Query',        1, 8.6),
  makeMock('Query',        2, 8.0),
  makeMock('Query',        3, 7.5),
  makeMock('Query',        4, 7.0),
  makeMock('Query',        5, 6.5),
  // Procedure — 0 results (nothing from this table)
];

const mockLegislationResults = [
  // Legislation — 8 results (should be capped to 3)
  makeMock('Legislation',  1, 10.0),
  makeMock('Legislation',  2, 9.9),
  makeMock('Legislation',  3, 9.6),
  makeMock('Legislation',  4, 9.3),
  makeMock('Legislation',  5, 9.0),
  makeMock('Legislation',  6, 8.5),
  makeMock('Legislation',  7, 8.1),
  makeMock('Legislation',  8, 7.8),
];

// ─── Apply the new logic ──────────────────────────────────────────────────────
const legSlice    = mockLegislationResults.slice(0, TOP_CHUNKS_PER_TABLE);
const otherSlice  = capPerTable(mockOtherResults, TOP_CHUNKS_PER_TABLE);
const combined    = [...legSlice, ...otherSlice];

// ─── Assertions ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅  ${msg}`);
    passed++;
  } else {
    console.error(`  ❌  ${msg}`);
    failed++;
  }
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('  UNIT TEST: Per-Table Top-3 Chunk Cap');
console.log('══════════════════════════════════════════════════════════\n');

// Count results per table in the final combined set
const tableCounts = {};
for (const r of combined) {
  const t = r.source_table;
  tableCounts[t] = (tableCounts[t] || 0) + 1;
}

console.log('--- Table counts in final combined result set ---');
for (const [table, count] of Object.entries(tableCounts)) {
  console.log(`  ${table.padEnd(14)} → ${count} chunks`);
}
console.log('');

// Test 1: Legislation capped at 3
assert(tableCounts['Legislation'] === 3,
  `Legislation: got ${tableCounts['Legislation']} (expected 3 — had 8 candidates)`);

// Test 2: Caselaw capped at 3 (had 6)
assert(tableCounts['Caselaw'] === 3,
  `Caselaw: got ${tableCounts['Caselaw']} (expected 3 — had 6 candidates)`);

// Test 3: Circular capped at 3 (had 4)
assert(tableCounts['Circular'] === 3,
  `Circular: got ${tableCounts['Circular']} (expected 3 — had 4 candidates)`);

// Test 4: Commentary exactly 3 (had 3)
assert(tableCounts['Commentary'] === 3,
  `Commentary: got ${tableCounts['Commentary']} (expected 3 — had 3 candidates)`);

// Test 5: Article stays at 2 (had only 2)
assert(tableCounts['Article'] === 2,
  `Article: got ${tableCounts['Article']} (expected 2 — had only 2 candidates)`);

// Test 6: Notification stays at 1 (had only 1)
assert(tableCounts['Notification'] === 1,
  `Notification: got ${tableCounts['Notification']} (expected 1 — had only 1 candidate)`);

// Test 7: Query capped at 3 (had 5)
assert(tableCounts['Query'] === 3,
  `Query: got ${tableCounts['Query']} (expected 3 — had 5 candidates)`);

// Test 8: Procedure absent (had 0 results)
assert(tableCounts['Procedure'] === undefined,
  `Procedure: correctly absent (had 0 candidates)`);

// Test 9: Total count
const expectedTotal = 3 + 3 + 3 + 3 + 2 + 1 + 3; // = 18
assert(combined.length === expectedTotal,
  `Total chunks: got ${combined.length} (expected ${expectedTotal})`);

// Test 10: No table exceeds the cap of 3
const violators = Object.entries(tableCounts).filter(([, count]) => count > 3);
assert(violators.length === 0,
  `No table exceeds cap of 3${violators.length ? ' — VIOLATORS: ' + violators.map(v => v[0]).join(', ') : ''}`);

// Test 11: Top scores are correct (highest score per leg = 10.0, highest other = 9.8)
assert(legSlice[0].backend_relevance_score === 10.0,
  `Legislation top chunk score is 10.0`);
assert(otherSlice[0].backend_relevance_score === 9.8,
  `Other tables top chunk (Caselaw) score is 9.8`);

// Test 12: Scores within each table bucket are in descending order (best first)
let orderedCorrectly = true;
const tableOrder = {};
for (const r of combined) {
  const t = r.source_table;
  if (!tableOrder[t]) tableOrder[t] = [];
  tableOrder[t].push(r.backend_relevance_score);
}
for (const [table, scores] of Object.entries(tableOrder)) {
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[i - 1]) {
      orderedCorrectly = false;
      console.error(`  ⚠  ${table} scores out of order: ${scores.join(', ')}`);
    }
  }
}
assert(orderedCorrectly, 'Scores within each table are in descending order');

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
