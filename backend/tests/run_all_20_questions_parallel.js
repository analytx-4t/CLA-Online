require('dotenv').config();
const { checkGuardrails } = require('../guardrails');
const { performPrioritizedLegalSearch } = require('../index');

const questions = [
  { id: 1, text: "Which companies are required to file form DPT – 3 and what is the due date of filing it for F.Y. 2025-26 ?" },
  { id: 2, text: "A foreign company wants to open it liaison office in India ? How cant it do so ?" },
  { id: 3, text: "Who are person acting in concert ? What are landmark case on it ?" },
  { id: 4, text: "Can promoters of a corporate debtor file application for insolvency resolution process against it? What are the recent judgments on it ?" },
  { id: 5, text: "What are the liabilities of directors of a company in case of dishonour of cheque issued during moratorium ?" },
  { id: 6, text: "The board wants to sell off one idle property of the company that earns no revenue. Do we still need a special resolution under section 180 or is that only when you're selling the whole undertaking?" },
  { id: 7, text: "Unlisted public co’s shareholders are trying to transfer shares that were never dematerialised. Can we as a company’s board reject it?" },
  { id: 8, text: "Client wants to write off accumulated losses against securities premium and cut the paid-up value of equity and pref shares, all as one scheme. Can that ride on section 230 or does it have to go through s.66?" },
  { id: 9, text: "HC quashed my client's cheque-bounce complaint before summoning saying no debt was shown, but presentation, dishonour and notice were all done. Can HC do that?" },
  { id: 10, text: "Ex-MD quit but is still sitting on company laptops and records. Can we prosecute her even with no formal \"entrustment\" on record?" },
  { id: 11, text: "Our multi-state co-op society invested in a company now in CIRP. RP says we're not in the \"same line of business\". Is that read off our bye-laws or off actual turnover and profit?" },
  { id: 12, text: "Bank's filed s.7 against the company and the guarantor at the same time. Can they run both together or does the election bar it?" },
  { id: 13, text: "The company has been resolved and the plan's approved. The old promoter now wants to challenge it in the SC. Does he even have locus as an aggrieved person?" },
  { id: 14, text: "Unlisted co wants to buy back some shares. What resolution do we need u/s 68, and is there anything in law that could block it?" },
  { id: 15, text: "Is New Development Bank a \"body corporate\" as defined under Companies Act?" },
  { id: 16, text: "Missed the DPT-3 due date for FY ending March 2026. Till when can we file without the extra additional fee?" },
  { id: 17, text: "Are preference shareholders creditors of the company, or members? And does the redemption angle change how you treat them?" },
  { id: 18, text: "What's the sectoral cap for the insurance sector and is it an automatic route under the current FDI policy?" },
  { id: 19, text: "Client is an FPI wanting to put money into government securities. Please tell me the framework for this." },
  { id: 20, text: "The company announced a stock split and there was some trading just before it. Is a stock split even UPSI for insider-trading purposes?" }
];

async function processQuestion(q) {
  const start = Date.now();
  try {
    const guard = await checkGuardrails(q.text);
    if (guard?.action === 'RESPOND') {
      const elapsed = Date.now() - start;
      return {
        id: q.id,
        question: q.text,
        elapsedMs: elapsed,
        guardrail: 'BLOCKED (' + (guard.category || 'DIALOG') + ')',
        chunksFound: 0,
        tables: [],
        topTitle: 'N/A'
      };
    }

    const results = await performPrioritizedLegalSearch(q.text, q.text);
    const elapsed = Date.now() - start;
    const tables = [...new Set(results.map(r => r.source_table))];
    const topTitle = results[0]?.doc_title || results[0]?.law_title || 'N/A';

    return {
      id: q.id,
      question: q.text,
      elapsedMs: elapsed,
      guardrail: 'ALLOWED',
      chunksFound: results.length,
      tables: tables,
      topTitle: topTitle.substring(0, 50)
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    return {
      id: q.id,
      question: q.text,
      elapsedMs: elapsed,
      guardrail: 'ERROR (' + err.message + ')',
      chunksFound: 0,
      tables: [],
      topTitle: 'N/A'
    };
  }
}

async function runBatchedParallelBenchmark() {
  console.log(`Starting batched parallel benchmark for ${questions.length} questions (batch size = 4)...`);
  const overallStart = Date.now();
  const BATCH_SIZE = 4;
  let allResults = [];

  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    const batch = questions.slice(i, i + BATCH_SIZE);
    console.log(`Executing batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(questions.length / BATCH_SIZE)} (Questions ${batch[0].id} to ${batch[batch.length - 1].id})...`);
    const batchResults = await Promise.all(batch.map(q => processQuestion(q)));
    allResults = allResults.concat(batchResults);
  }

  const totalElapsed = Date.now() - overallStart;

  console.log(`\n========================================================================================`);
  console.log(`PARALLEL BENCHMARK SUMMARY (Completed ${questions.length} questions in ${totalElapsed} ms)`);
  console.log(`========================================================================================\n`);

  console.table(allResults.map(r => ({
    "Q#": r.id,
    "Guardrail": r.guardrail,
    "Latency (ms)": r.elapsedMs,
    "Chunks Found": r.chunksFound,
    "Extracted Tables": r.tables.join(', '),
    "Top Retrieved Source": r.topTitle
  })));

  const blockedCount = allResults.filter(r => r.guardrail.startsWith('BLOCKED')).length;
  const passedCount = allResults.filter(r => r.guardrail === 'ALLOWED').length;
  console.log(`\n Total Passed Guardrails: ${passedCount} / ${questions.length}`);
  console.log(` Total Blocked by Guardrails: ${blockedCount}`);
  process.exit(0);
}

runBatchedParallelBenchmark();
