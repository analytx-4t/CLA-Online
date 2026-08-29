require('dotenv').config();
const { runAgentFlow } = require('../agentSystem');

async function runTests() {
  const testCases = [
    {
      id: 1,
      title: "Land Border FDI / Beneficial Ownership",
      query: "An investor's ultimate beneficial owner is in a country sharing a land border with India, does that change the investment route?"
    },
    {
      id: 2,
      title: "Family Private Company Director Removal & Oppression",
      query: "A family-run private company removes one of the family directors from the board without a shareholder resolution, does that alone amount to oppression and mismanagement under the Companies Act, or does it need more to succeed?"
    },
    {
      id: 3,
      title: "Cheque Bounce (Sec 138 NI Act) vs Moratorium (Sec 14 IBC)",
      query: "Can a Section 138 cheque bounce proceeding under the Negotiable Instruments Act continue against a corporate debtor or its directors when a moratorium under Section 14 of the IBC is in place?"
    }
  ];

  for (const test of testCases) {
    console.log(`\n================================================================================`);
    console.log(`TEST ${test.id}: ${test.title}`);
    console.log(`ORIGINAL USER QUERY: "${test.query}"`);
    console.log(`================================================================================\n`);

    const startTime = Date.now();
    try {
      const result = await runAgentFlow(test.query);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log(`--- [1] AGENT ROUTE ---`);
      console.log(`Route: ${result.route}`);

      if (result.isClarifying) {
        console.log(`Clarifying Question Asked: ${result.content}`);
      } else {
        console.log(`\n--- [2] FINAL CLA CHATBOT ANSWER (${duration}s) ---`);
        console.log(result.content);

        if (result.follow_up_questions && result.follow_up_questions.length > 0) {
          console.log(`\n--- FOLLOW-UP QUESTIONS ---`);
          result.follow_up_questions.forEach((q, idx) => console.log(` ${idx + 1}. ${q}`));
        }
      }
    } catch (err) {
      console.error(`ERROR in Test ${test.id}:`, err);
    }
  }
}

runTests().then(() => {
  console.log("\nAll tests completed successfully!");
  process.exit(0);
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
