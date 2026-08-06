process.env.DISABLE_OPENAI_EMBEDDINGS = "true";
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { classifyLocal } = require('../backend/guardrails');
const { performPrioritizedLegalSearch } = require('../backend/index');
const { getLLMProvider } = require('../backend/llm/factory');
const { parseAnswerAndSuggestions } = require('../backend/responseParser');
const { loadAgentPrompts } = require('../backend/agentSystem');

const questionsPool = [
  { id: "CQ-01", text: "Which companies are required to file Form DPT-3 and what is the due date of filing it for F.Y. 2025-26?" },
  { id: "CQ-03", text: "Who is a 'person acting in concert'? What is the landmark case on it?" },
  { id: "CQ-06", text: "The board wants to sell one idle property that earns no revenue. Is a special resolution under Section 180 still needed, or only when selling the whole undertaking?" },
  { id: "CQ-14", text: "An unlisted company wants to buy back some shares. What resolution is needed under Section 68, and is there anything in law that could block it?" },
  { id: "CQ-20", text: "The company announced a stock split and there was some trading just before it. Is a stock split even UPSI for insider-trading purposes?" }
];

async function runSingleQuestionTest(qItem) {
  console.log(`\n========================================================================`);
  console.log(`RUNNING TEST CASE [${qItem.id}]: ${qItem.text}`);
  console.log(`========================================================================`);

  const startTime = Date.now();

  // 1. Guardrail Check
  const localGuard = classifyLocal(qItem.text);
  const guardStatus = (localGuard && localGuard.triggered) ? `BLOCKED (${localGuard.category})` : 'ALLOWED';

  // 2. Perform Prioritized Search + Cohere Rerank + capPerDoc filtering
  const results = await performPrioritizedLegalSearch(qItem.text, qItem.text);
  const legCount = results.legislationResults ? results.legislationResults.length : 0;
  const otherCount = results.otherResults ? results.otherResults.length : 0;
  const totalChunks = results.length;

  console.log(`[Retrieval] Total Chunks: ${totalChunks} (Legislation: ${legCount}, Other: ${otherCount})`);

  // Format Search Context
  const contextBlock = results.map((r, idx) => {
    const sourceIndex = idx + 1;
    const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
    const fileName = (r.original && r.original.child && r.original.child.FileName) ||
      (r.original && r.original.parent && r.original.parent.FileName) || 'Unknown';
    const category = r.category || 'Unknown';
    const subject = r.subject || 'Unknown';
    const sections = r.sections || 'Unknown';

    return `[Source ${sourceIndex}] Title: "${title}" | File: ${fileName} | Sections: ${sections} | Category: ${category} | Subject: ${subject}\nContent: ${r.chunk_text}`;
  }).join('\n\n---\n\n');

  // 3. System Prompt & LLM Call
  const agentPrompts = loadAgentPrompts();
  const baseSummarizerPrompt = agentPrompts.Content_Summarizer_Agent || `You are a professional legal research assistant for Indian corporate and commercial law. Answer STRICTLY from the Search Context only — never from your own knowledge. Read ALL chunks and combine relevant information into one answer. Write in a clean, flowing legal-memo style: start directly with a 2-3 sentence legal answer, use bold thematic section headers, cite [Source N] inline (max 1-2 citations per bracket), and end with "This is legal research, not legal advice. Please verify against the primary source." Only output "I could not find authority on this in the CLAOnline database." if every chunk is completely unrelated to the question.`;

  const formattingRules = `

CRITICAL READABILITY & FORMATTING RULES:
1. NO META OPENING: NEVER start your answer with "Based solely on...", "Based on the retrieved...", "According to the database...", or any meta-disclaimer. Start IMMEDIATELY with a direct 2-3 sentence legal answer.
2. MINIMAL CLEAN INLINE CITATIONS: Keep inline citations concise. Cite at most 1 to 2 specific source numbers per statement (e.g. [Source 1] or [Source 1, 2]). NEVER output long strings or ranges of citations like [Source 6, 7, 8, 9, 10, 11, 12...].
3. NO MANUAL SOURCES SECTION: Do NOT output a manual "**Sources:**" text section or bullet list at the end of your answer. The user interface automatically renders the interactive Source Citations panel below your message.
4. MANDATORY FOLLOW-UP QUESTIONS: At the very end of your response, ALWAYS append the exact tag '---SUGGESTIONS---' followed by 3 relevant follow-up questions the user might ask next, one per line.
Example:
---SUGGESTIONS---
What are the requirements for board resolutions under Section 135?
Are private companies exempt from these regulations?
What is the penalty for violating this provision?`;

  const systemPrompt = `${baseSummarizerPrompt}${formattingRules}`;
  const userContentParts = [`Question: ${qItem.text}`, `Search Context:\n${contextBlock}`];

  const llm = getLLMProvider('deepseek', 'deepseek-v4-pro');
  const response = await llm.chat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContentParts.join('\n\n') }
    ],
    temperature: 0.1,
    maxTokens: 2500
  });

  const rawAnswer = response.content;
  const parsed = parseAnswerAndSuggestions(rawAnswer);
  const elapsedMs = Date.now() - startTime;

  // Analysis / Verification checks
  const startsWithMeta = /^(Based solely on|Based on the|According to the database|In response to your query based on)/i.test(parsed.answer);
  const hasManualSourcesList = /\n+\s*(?:###?\s*)?(?:\*\*|__)?\s*Sources:?/i.test(parsed.answer);
  const hasLongBracketString = /\[Source\s+\d+(?:\s*,\s*\d+){3,}\]/i.test(parsed.answer);

  const verification = {
    chunksWithinLimit: totalChunks <= 35,
    noMetaOpening: !startsWithMeta,
    noManualSourcesList: !hasManualSourcesList,
    cleanInlineCitations: !hasLongBracketString,
    hasFollowUpSuggestions: parsed.suggestions && parsed.suggestions.length >= 2,
    citationParityCount: totalChunks
  };

  const sourcesSummary = results.map((r, idx) => {
    const title = r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled';
    const sec = r.sections || 'N/A';
    return `[Source ${idx + 1}] ${r.source_table}: ${title} (Sec/Ref: ${sec})`;
  });

  return {
    id: qItem.id,
    question: qItem.text,
    elapsedMs,
    totalChunks,
    legCount,
    otherCount,
    answer: parsed.answer,
    suggestions: parsed.suggestions,
    sourcesSummary,
    verification
  };
}

async function runAllTests() {
  const allTestResults = [];

  for (const qItem of questionsPool) {
    try {
      const res = await runSingleQuestionTest(qItem);
      allTestResults.push(res);
    } catch (err) {
      console.error(`Error testing ${qItem.id}:`, err);
    }
  }

  fs.writeFileSync(
    path.join(__dirname, 'random_5_test_results.json'),
    JSON.stringify(allTestResults, null, 2)
  );

  console.log(`\n========================================================================`);
  console.log(`ALL 5 RANDOM TESTS COMPLETED! Saved raw JSON to random_5_test_results.json`);
  console.log(`========================================================================\n`);

  process.exit(0);
}

runAllTests();
