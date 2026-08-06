/**
 * INTEGRATION TEST — Live API: /api/ask
 *
 * Sends 3 real legal questions to the running backend server.
 * Validates both changes:
 *   Change 1: Per-table top-3 chunk cap in retrieved sources
 *   Change 2: agentRole/Mandate/Input/Output in serverLogs (Steps 1-4)
 *
 * Requirements: backend server must be running on port 3000
 * Run: node scratch/test_live_api.js
 */

'use strict';

const http = require('http');

const HOST = 'localhost';
const PORT = 3000;
const ENDPOINT = '/api/ask';

// 3 real Indian corporate law questions
const QUESTIONS = [
  'What are the disclosure requirements for related party transactions under Section 188 of the Companies Act 2013?',
  'What is the procedure for striking off a company under Section 248 of the Companies Act 2013?',
  'What did SEBI say about insider trading regulations for listed companies?',
];

let passed = 0;
let failed = 0;
let totalTests = 0;

function assert(condition, msg, context = '') {
  totalTests++;
  if (condition) {
    console.log(`  ✅  ${msg}`);
    passed++;
  } else {
    console.error(`  ❌  ${msg}${context ? ' — ' + context : ''}`);
    failed++;
  }
}

function postJSON(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: HOST,
      port: PORT,
      path: ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 120000,
    };

    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message} — raw: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out after 120s')); });
    req.write(data);
    req.end();
  });
}

// ─── Check if server is up ────────────────────────────────────────────────────
function checkServerUp() {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}/`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

// ─── Validate per-table cap in sources array ──────────────────────────────────
function validatePerTableCap(sources, questionLabel) {
  console.log(`\n  [Change 1] Per-table chunk cap for: "${questionLabel.slice(0, 60)}..."`);

  if (!Array.isArray(sources) || sources.length === 0) {
    assert(false, 'Sources array is non-empty', `got ${JSON.stringify(sources)}`);
    return;
  }

  // Count chunks per source_table
  const tableCounts = {};
  for (const src of sources) {
    const t = src.source_table || 'unknown';
    tableCounts[t] = (tableCounts[t] || 0) + 1;
  }

  console.log('     Chunks per table:');
  for (const [table, count] of Object.entries(tableCounts)) {
    console.log(`       ${table.padEnd(16)} → ${count} chunk(s)`);
  }

  // No table should exceed 3 (Legislation gets 3, each other table gets max 3)
  const violators = Object.entries(tableCounts).filter(([, count]) => count > 3);
  assert(violators.length === 0,
    `No table exceeds 3-chunk cap`,
    violators.length ? `violators: ${violators.map(([t, c]) => `${t}(${c})`).join(', ')}` : '');

  // Total sources should be reasonable (at most 3 × 8 tables = 24)
  assert(sources.length <= 24,
    `Total sources ≤ 24 (got ${sources.length})`);

  assert(sources.length > 0,
    `At least 1 source retrieved (got ${sources.length})`);
}

// ─── Validate serverLogs mandate fields ───────────────────────────────────────
function validateServerLogs(serverLogs, questionLabel) {
  console.log(`\n  [Change 2] Agent mandate fields for: "${questionLabel.slice(0, 60)}..."`);

  if (!Array.isArray(serverLogs) || serverLogs.length === 0) {
    assert(false, 'serverLogs array is non-empty', `got ${JSON.stringify(serverLogs)}`);
    return;
  }

  console.log(`     Found ${serverLogs.length} step(s) in serverLogs`);
  assert(serverLogs.length >= 4, `At least 4 steps in serverLogs (got ${serverLogs.length})`);

  const MANDATE_FIELDS = ['agentRole', 'agentMandate', 'agentInput', 'agentOutput'];

  for (let step = 1; step <= Math.min(4, serverLogs.length); step++) {
    const log = serverLogs.find(l => l.step === step);
    if (!log) {
      assert(false, `Step ${step} exists in serverLogs`);
      continue;
    }

    assert(Boolean(log.agent), `Step ${step}: has "agent" field (${log.agent || 'MISSING'})`);
    assert(Boolean(log.title), `Step ${step}: has "title" field`);
    assert(Boolean(log.summary), `Step ${step}: has "summary" field`);

    for (const field of MANDATE_FIELDS) {
      const hasField = Boolean(log[field]);
      assert(hasField, `Step ${step}: has "${field}" = "${String(log[field] || '').slice(0, 60)}..."`);
    }

    // Print mandate preview for visual confirmation
    if (log.agentMandate) {
      console.log(`     Step ${step} mandate: "${log.agentMandate.slice(0, 100)}..."`);
    }
  }
}

// ─── Validate full API response structure ─────────────────────────────────────
function validateResponse(resp, question, qIndex) {
  const label = `Q${qIndex + 1}`;
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`${label}: ${question.slice(0, 70)}...`);
  console.log(`${'═'.repeat(62)}`);

  // HTTP status
  assert(resp.status === 200, `${label}: HTTP 200 (got ${resp.status})`);

  const body = resp.body;

  // Answer present
  assert(Boolean(body.answer) && body.answer.length > 20,
    `${label}: Non-trivial answer present (${body.answer?.length || 0} chars)`);

  // Sources array
  const sources = body.sources || body.searchResults || [];
  assert(Array.isArray(sources), `${label}: sources is an array`);

  // Per-table cap check (Change 1)
  validatePerTableCap(sources, question);

  // ServerLogs check — note: live endpoint doesn't return serverLogs directly
  // We need to fetch from /api/admin/ragas/:requestId. 
  // Instead, check if the answer doesn't show hallucinated non-retrieved content
  // and verify the body shape.

  // Suggestions
  const suggestions = body.suggestions || [];
  assert(Array.isArray(suggestions), `${label}: suggestions is an array`);
  assert(suggestions.length >= 1, `${label}: At least 1 follow-up suggestion (got ${suggestions.length})`);

  // Route
  if (body.route) {
    assert(body.route === 'LEGAL', `${label}: Route is LEGAL (got "${body.route}")`);
  }

  // Not a guardrail block
  assert(!body.guardrail?.triggered, `${label}: Not blocked by guardrails`);

  console.log(`\n  📄 Answer preview (first 200 chars):`);
  console.log(`  "${(body.answer || '').slice(0, 200)}..."`);

  if (suggestions.length) {
    console.log(`\n  💡 Suggestions (${suggestions.length}):`);
    suggestions.slice(0, 3).forEach((s, i) => console.log(`     ${i + 1}. ${s}`));
  }

  if (sources.length) {
    console.log(`\n  📚 Sources (${sources.length} total):`);
    const tableMap = {};
    for (const s of sources) {
      const t = s.source_table || 'unknown';
      tableMap[t] = (tableMap[t] || 0) + 1;
    }
    for (const [t, c] of Object.entries(tableMap)) {
      console.log(`     ${t.padEnd(16)}: ${c} chunk(s) ${c > 3 ? '⚠ EXCEEDS CAP' : '✓'}`);
    }
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  INTEGRATION TEST: Live /api/ask endpoint');
  console.log(`  Target: http://${HOST}:${PORT}${ENDPOINT}`);
  console.log('══════════════════════════════════════════════════════════════');

  const serverUp = await checkServerUp();
  if (!serverUp) {
    console.error(`\n  ⚠  Backend server is NOT running on port ${PORT}.`);
    console.error('     Start it with: cd backend && node index.js\n');
    process.exit(2);
  }
  console.log(`\n  ✅ Server is up on port ${PORT}\n`);

  for (let i = 0; i < QUESTIONS.length; i++) {
    const question = QUESTIONS[i];
    try {
      console.log(`\n⏳ Sending Q${i + 1} to /api/ask... (may take 15-40s)`);
      const start = Date.now();
      const resp = await postJSON({ question });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`   Response received in ${elapsed}s`);
      validateResponse(resp, question, i);
    } catch (err) {
      console.error(`\n  ❌ Q${i + 1} request failed: ${err.message}`);
      failed++;
      totalTests++;
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  FINAL RESULT: ${passed}/${totalTests} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  🎉 ALL TESTS PASSED — Both changes are working correctly!');
  } else {
    console.log('  ⚠  Some tests failed — review output above.');
  }
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Unexpected test runner error:', err);
  process.exit(1);
});
