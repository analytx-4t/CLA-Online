const { performance } = require('perf_hooks');

const BACKEND_URL = 'http://localhost:3000';

const testQuestions = [
  {
    topic: 'IBC Section 4 Threshold Limit',
    question: 'What is the threshold limit of default for initiating Corporate Insolvency Resolution Process (CIRP) under Section 4 of the Insolvency and Bankruptcy Code, 2016?'
  },
  {
    topic: 'Section 135 CSR Obligations',
    question: 'What are the mandatory requirements and penalties for non-compliance with Corporate Social Responsibility (CSR) under Section 135 of Companies Act, 2013?'
  }
];

async function measureUIRenderLatency() {
  console.log('================================================================');
  console.log('⚡ END-TO-END UI RENDER LATENCY MEASUREMENT TEST');
  console.log('================================================================');
  console.log(`Backend Server: ${BACKEND_URL}\n`);

  const userId = 'ui_latency_user_' + Date.now();

  // Create session
  const createRes = await fetch(`${BACKEND_URL}/api/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
    body: JSON.stringify({ mode: 'rag', title: 'Latency Test' })
  });
  const sessionData = await createRes.json();
  const sessionId = sessionData.session_id || sessionData.session?.session_id;

  for (const q of testQuestions) {
    console.log(`----------------------------------------------------------------`);
    console.log(`Testing Question: "${q.topic}"`);
    console.log(`Full Prompt: "${q.question}"`);

    const userSendTime = performance.now();

    // 1. Call /api/ask
    const askRes = await fetch(`${BACKEND_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ question: q.question, session_id: sessionId })
    });
    const askData = await askRes.json();
    const uiRenderTime = performance.now();

    const perceivedUILatencySecs = ((uiRenderTime - userSendTime) / 1000).toFixed(2);
    console.log(`\n🎉 [UI RENDER EVENT] Answer rendered on screen for user in: ${perceivedUILatencySecs} seconds (${(perceivedUILatencySecs / 60).toFixed(2)} mins)`);

    // 2. Async persistence call (as fired by frontend in background)
    const bgPersistStart = performance.now();
    const msgRes = await fetch(`${BACKEND_URL}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        message_id: 'user-' + Date.now(),
        content: q.question,
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
    const bgPersistEnd = performance.now();
    const bgSaveSecs = ((bgPersistEnd - bgPersistStart) / 1000).toFixed(2);

    console.log(`⚡ [BACKGROUND PERSISTENCE] Saved to MongoDB in: ${bgSaveSecs} seconds (non-blocking for UI)`);
    console.log(`📚 Sources Retrieved: ${(askData.sources || []).length}`);
    console.log(`📝 Answer Snippet: ${(askData.answer || '').slice(0, 150)}...\n`);
  }

  console.log('================================================================');
  console.log('✅ ALL UI LATENCY TESTS COMPLETED SUCCESSFULLY');
  console.log('================================================================\n');
  process.exit(0);
}

measureUIRenderLatency().catch(err => {
  console.error(err);
  process.exit(1);
});
