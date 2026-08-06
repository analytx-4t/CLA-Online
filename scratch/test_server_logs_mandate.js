/**
 * UNIT TEST — Change 2: Agent Mandate Fields in serverLogs
 *
 * Validates that each serverLog step (1-4) has the new
 * agentRole, agentMandate, agentInput, agentOutput fields
 * by extracting and inspecting the log-building code directly
 * from backend/index.js (static analysis + mock execution).
 *
 * Run: node scratch/test_server_logs_mandate.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Read backend/index.js source ─────────────────────────────────────────────
const sourceFile = path.resolve(__dirname, '../backend/index.js');
const source = fs.readFileSync(sourceFile, 'utf8');

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
console.log('  UNIT TEST: Agent Mandate Fields in serverLogs (Steps 1-4)');
console.log('══════════════════════════════════════════════════════════\n');

// ─── Extract all serverLogs.push({ ... }) blocks ──────────────────────────────
// We'll use regex to find step assignments and check that mandate fields exist nearby
const stepBlocks = [];
const stepRegex = /serverLogs\.push\(\{([\s\S]*?)\}\);/g;
let match;
while ((match = stepRegex.exec(source)) !== null) {
  stepBlocks.push(match[1]);
}

console.log(`Found ${stepBlocks.length} serverLogs.push() blocks in backend/index.js\n`);
assert(stepBlocks.length >= 4, `At least 4 serverLogs.push() blocks found (got ${stepBlocks.length})`);

// Filter to only blocks that have a step number 1-4
const stepsFound = {};
for (const block of stepBlocks) {
  const stepMatch = block.match(/step:\s*(\d+)/);
  if (stepMatch) {
    const stepNum = parseInt(stepMatch[1], 10);
    if (stepNum >= 1 && stepNum <= 5) {
      stepsFound[stepNum] = block;
    }
  }
}

const MANDATE_FIELDS = ['agentRole', 'agentMandate', 'agentInput', 'agentOutput'];

// ─── Test each step 1-4 ───────────────────────────────────────────────────────
for (let step = 1; step <= 4; step++) {
  console.log(`\n--- Step ${step} ---`);
  const block = stepsFound[step];
  assert(Boolean(block), `Step ${step}: serverLogs.push() block exists in source`);

  if (!block) continue;

  for (const field of MANDATE_FIELDS) {
    const hasField = block.includes(`${field}:`);
    assert(hasField, `Step ${step}: has "${field}" field`);

    if (hasField) {
      // Extract the value (everything between the field colon and next comma/field)
      const valMatch = block.match(new RegExp(`${field}:\\s*['\`]([^'\`]*)['\`]`));
      if (valMatch && valMatch[1]) {
        const preview = valMatch[1].slice(0, 80);
        console.log(`      value preview: "${preview}${valMatch[1].length > 80 ? '...' : ''}"`);
      }
    }
  }
}

// ─── Validate frontend AGENT_DESCRIPTIONS ─────────────────────────────────────
console.log('\n--- Frontend: OnlineEvalPage.jsx static check ---');
const frontendFile = path.resolve(__dirname, '../admin-dashboard/src/pages/OnlineEvalPage.jsx');
const frontendSource = fs.readFileSync(frontendFile, 'utf8');

assert(frontendSource.includes('AGENT_DESCRIPTIONS'),
  'OnlineEvalPage.jsx defines AGENT_DESCRIPTIONS constant');

assert(frontendSource.includes('AgentMandatePanel'),
  'OnlineEvalPage.jsx defines AgentMandatePanel component');

assert(frontendSource.includes('<AgentMandatePanel log={log}'),
  'AgentMandatePanel is rendered inside ServerLogsTimeline');

assert(frontendSource.includes("log.step <= 4"),
  'AgentMandatePanel only shown for steps 1-4');

// Check all 4 steps are described
for (let step = 1; step <= 4; step++) {
  assert(frontendSource.includes(`${step}: {`),
    `AGENT_DESCRIPTIONS has entry for step ${step}`);
}

// Check all required fields are in the frontend descriptions
const frontendFields = ['role:', 'mandate:', 'input:', 'output:', 'badge:', 'color:'];
for (const field of frontendFields) {
  assert(frontendSource.includes(field),
    `AGENT_DESCRIPTIONS contains "${field}" field`);
}

// Check all 4 color themes are present
for (const color of ['emerald', 'blue', 'amber', 'purple']) {
  assert(frontendSource.includes(`color: '${color}'`),
    `Color theme "${color}" is defined`);
}

// Check Input/Output icon imports
assert(frontendSource.includes('ArrowRight'), 'ArrowRight icon imported');
assert(frontendSource.includes('BookOpen'), 'BookOpen icon imported');
assert(frontendSource.includes('Zap'), 'Zap icon imported');

// ─── Change 1: Static verification in performPrioritizedLegalSearch ───────────
console.log('\n--- Change 1: performPrioritizedLegalSearch static check ---');

assert(source.includes('capPerTable'),
  'backend/index.js defines capPerTable helper');

assert(source.includes('TOP_CHUNKS_PER_TABLE = 3'),
  'TOP_CHUNKS_PER_TABLE constant is set to 3');

assert(source.includes('per-table top-3 cap') || source.includes('Top 3 chunks'),
  'Per-table cap comment present in performPrioritizedLegalSearch');

assert(!source.includes('capPerDoc'),
  'Old capPerDoc is removed — replaced by capPerTable');

assert(source.includes('source_table') && source.includes('tableBuckets'),
  'capPerTable groups by source_table using tableBuckets');

// Old logic used rerankSearchResults(..., 5) for legislation
// New logic should use rerankSearchResults(..., 20) or higher
assert(source.includes('rerankSearchResults(targetQuestion, legislationCandidates, 20)'),
  'Legislation candidates passed with wider rerank limit (20)');

assert(source.includes('rerankSearchResults(targetQuestion, otherCandidates, 60)'),
  'Other table candidates passed with wider rerank limit (60)');

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════');
console.log(`  RESULT: ${passed} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
