const { performance } = require('perf_hooks');

const BACKEND_URL = 'http://localhost:3000';

const testQuestions = [
  {
    num: 1,
    category: 'Corporate Social Responsibility (Section 135, Companies Act 2013)',
    question: 'What are the mandatory requirements and penalties for non-compliance with Corporate Social Responsibility (CSR) under Section 135 of Companies Act, 2013?'
  },
  {
    num: 2,
    category: 'Insolvency & Bankruptcy Code (Section 9, IBC 2016)',
    question: 'Can an operational creditor initiate CIRP under Section 9 of IBC if there is a pre-existing dispute between the parties?'
  },
  {
    num: 3,
    category: 'SEBI & Corporate Governance (Regulation 30, SEBI LODR)',
    question: 'What are the disclosure requirements for material events under Regulation 30 of SEBI LODR Regulations?'
  }
];

async function testFullBrowserFlow() {
  console.log('================================================================');
  console.log('⚡ FULL BROWSER WORKFLOW LATENCY BENCHMARK (AFTER DUPLICATE RAG FIX)');
  console.log('================================================================');
  console.log(`Backend Server: ${BACKEND_URL}\n`);

  const userId = 'browser_flow_user_' + Date.now();

  // Step 1: Create a browser session
  console.log('1. Creating session via POST /api/chat/sessions...');
  const createSessionRes = await fetch(`${BACKEND_URL}/api/chat/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': userId
    },
    body: JSON.stringify({ mode: 'rag', title: 'CSR & Corporate Law Test' })
  });

  const sessionData = await createSessionRes.json();
  const sessionId = sessionData.session_id || sessionData.session?.session_id;
  console.log(`✅ Created session ID: ${sessionId}\n`);

  const results = [];

  for (const qObj of testQuestions) {
    console.log(`----------------------------------------------------------------`);
    console.log(`[Test ${qObj.num}/${testQuestions.length}] ${qObj.category}`);
    console.log(`Question: "${qObj.question}"`);

    const flowStartTime = performance.now();

    // Step A: Call /api/ask (as frontend chatbot_interface.js line 1715 does)
    const askStartTime = performance.now();
    const askRes = await fetch(`${BACKEND_URL}/api/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userId
      },
      body: JSON.stringify({ question: qObj.question, session_id: sessionId })
    });

    const askData = await askRes.json();
    const askEndTime = performance.now();
    const askTimeSecs = ((askEndTime - askStartTime) / 1000).toFixed(2);

    // Step B: Call /api/chat/sessions/:id/messages (as frontend chatbot_interface.js line 1762 does)
    const msgStartTime = performance.now();
    const msgRes = await fetch(`${BACKEND_URL}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': userId
      },
      body: JSON.stringify({
        message_id: 'user-' + Date.now(),
        content: qObj.question,
        assistantMessage: {
          content: askData.answer || '',
          metadata: {
            follow_up_questions: askData.suggestions || [],
            sources: askData.sources || []
          }
        }
      })
    });

    const msgData = await msgRes.json();
    const msgEndTime = performance.now();
    const msgTimeSecs = ((msgEndTime - msgStartTime) / 1000).toFixed(2);

    const totalFlowTimeSecs = ((msgEndTime - flowStartTime) / 1000).toFixed(2);

    console.log(`⏱️  /api/ask Duration        : ${askTimeSecs}s`);
    console.log(`⏱️  /messages Persistence Time: ${msgTimeSecs}s (INSTANT SAVE!)`);
    console.log(`🏁 Total Browser Round-Trip  : ${totalFlowTimeSecs}s (${(totalFlowTimeSecs / 60).toFixed(2)} mins)`);
    console.log(`📚 Citations Returned        : ${(askData.sources || []).length} sources`);
    console.log(`📄 Response Character Count  : ${(askData.answer || '').length} chars`);

    results.push({
      num: qObj.num,
      category: qObj.category,
      askTimeSecs,
      msgTimeSecs,
      totalFlowTimeSecs,
      sourcesCount: (askData.sources || []).length,
      answerLen: (askData.answer || '').length
    });
  }

  console.log('\n================================================================');
  console.log('📊 FINAL FULL BROWSER FLOW TIMING REPORT');
  console.log('================================================================');
  console.table(results.map(r => ({
    '#': r.num,
    'Category': r.category,
    '/api/ask Time': `${r.askTimeSecs}s`,
    '/messages Save Time': `${r.msgTimeSecs}s`,
    'Total UI Latency': `${r.totalFlowTimeSecs}s`,
    'Total UI Latency (Mins)': `${(r.totalFlowTimeSecs / 60).toFixed(2)}m`,
    'Citations': r.sourcesCount,
    'Answer Chars': r.answerLen
  })));

  const avgTotalSecs = (results.reduce((acc, r) => acc + parseFloat(r.totalFlowTimeSecs), 0) / results.length).toFixed(2);
  console.log(`\n🏆 AVERAGE TOTAL BROWSER UI RESPONSE TIME: ${avgTotalSecs} seconds (${(avgTotalSecs / 60).toFixed(2)} mins)`);
  console.log('================================================================\n');

  process.exit(0);
}

testFullBrowserFlow();
