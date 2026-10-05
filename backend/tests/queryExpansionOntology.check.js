// Live check: Query_Expansion_Agent uses the combined Companies Act "control" + FEMA ontology.
// Run: node tests/queryExpansionOntology.check.js   (from backend/, needs OPENAI_API_KEY)
require('dotenv').config();
const { loadAgentPrompts, assembleExpansionPrompt, expandLegalQuery } = require('../agentSystem');
const { getLLMProvider } = require('../llm/factory');
const { settings } = require('../config');

const CASES = [
  {
    query: 'An investor holds only 18% of a listed company but has veto rights over large borrowings and acquisitions. Does it have control?',
    expect: [/2\(27\)/, /2\(1\)\(e\)/, /SAST/i, /ArcelorMittal/i, /protective|negative right/i, /positive/i]
  },
  {
    query: 'A Delaware LLC wants to buy 30% shares in our Indian software startup. What do we need to comply with?',
    expect: [/Non-Debt Instruments Rules/i, /Rule 21/i, /FC-GPR/i, /FIRMS/i, /capital account/i, /(person resident outside India|PROI)/i, /Authori[sz]ed Dealer|AD Category/i]
  },
  {
    query: 'Our Indian company is 60% owned by a Singapore fund. We now want to invest in another Indian company. Any FEMA issue?',
    expect: [/downstream/i, /Rule 23/i, /(FOCC|foreign-owned or controlled)/i, /Form DI/i, /indirect foreign investment/i]
  },
  {
    query: 'We filed the FC-GPR form late. How can the company regularise this?',
    expect: [/compounding/i, /Compounding Proceedings\) Rules, 2024|Compounding Proceedings Rules/i, /Master Direction.*Compounding|Compounding of Contraventions/i, /contravention/i]
  },
  {
    query: 'An Indian exporter shipped goods 16 months ago and has still not received payment. What is the position?',
    expect: [/realis/i, /repatriat/i, /Export and Import of Goods and Services\) Regulations, 2026|Export of Goods and Services/i, /EDPMS/i, /15 months/i]
  }
];

const score = (text, patterns) => patterns.filter(p => p.test(text)).length;

async function oldPromptExpansion(prompts, query) {
  // Baseline: previous behaviour (SHARED LEGAL CONTEXT base ontology)
  let p = prompts.Query_Expansion_Agent
    .replace('[SHARED LEGAL CONTEXT]', prompts.SHARED_LEGAL_CONTEXT)
    .replace('[COMMON RULES]', prompts.COMMON_RULES);
  const r = await getLLMProvider('openai', settings.OPENAI_MODEL || 'gpt-4.1-mini')
    .generate({ messages: [{ role: 'user', content: query }], systemPrompt: p, temperature: 0.2, maxTokens: 3000 });
  return r.content || '';
}

(async () => {
  const prompts = loadAgentPrompts();
  const assembled = assembleExpansionPrompt(prompts);
  const checks = {
    'contains CA control section': assembled.includes('SECTION CA. COMPANIES ACT, 2013 AND SEBI SAST'),
    'contains FEMA section': assembled.includes('SECTION FEMA. A WORKING ONTOLOGY OF FEMA'),
    'contains FEMA Part M detail layer': assembled.includes('PART M. DETAIL LAYER'),
    'old base ontology removed': !assembled.includes('TERRITORIAL RULE:'),
    'expansion instructions kept': assembled.includes('STRICT OUTPUT FORMAT REQUIREMENT'),
    'common rules kept': assembled.includes('RULES FOR ALL AGENTS:'),
    'placeholders resolved': !assembled.includes('[SHARED LEGAL CONTEXT]') && !assembled.includes('[COMMON RULES]')
  };
  console.log(`Assembled prompt: ${assembled.length} chars`);
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);

  const origLog = console.log;
  let totalNew = 0, totalOld = 0, totalMax = 0, incomplete = 0;
  const rows = [];
  for (const c of CASES) {
    console.log = () => {};
    const [res, oldText] = await Promise.all([expandLegalQuery(c.query), oldPromptExpansion(prompts, c.query)]);
    console.log = origLog;
    const newText = [res.expandedQuery, res.keywords.join(', '), res.primaryAct, res.suggestedFilters].join('\n');
    const n = score(newText, c.expect), o = score(oldText, c.expect);
    totalNew += n; totalOld += o; totalMax += c.expect.length;
    const complete = res.keywords.length > 0 && !!res.primaryAct;
    if (!complete) incomplete++;
    rows.push({ c, res, n, o, complete, missing: c.expect.filter(p => !p.test(newText)).map(String) });
  }
  for (const r of rows) {
    console.log('\n' + '='.repeat(100));
    console.log('QUERY:', r.c.query);
    console.log(`OUTPUT COMPLETE: ${r.complete ? 'YES' : 'NO (keywords/primary act missing)'}`);
    console.log(`ONTOLOGY HITS  new: ${r.n}/${r.c.expect.length}   old baseline: ${r.o}/${r.c.expect.length}${r.missing.length ? '   missing(new): ' + r.missing.join(' ') : ''}`);
    console.log('EXPANDED_QUERY:', r.res.expandedQuery);
    console.log('KEYWORDS:', r.res.keywords.join(', '));
    console.log('PRIMARY_ACT:', r.res.primaryAct, '| SECTIONS:', (r.res.inferredSections || []).join(', '));
  }
  console.log(`\nTOTAL ontology hits — new: ${totalNew}/${totalMax}, old baseline: ${totalOld}/${totalMax}`);
  console.log(`Incomplete expansions: ${incomplete}/${CASES.length}`);
  if (Object.values(checks).some(v => !v) || incomplete > 0) process.exit(1);
})();
