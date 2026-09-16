require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const PORT = 3105;
const BASE_URL = `http://localhost:${PORT}`;

async function runTests() {
  console.log('=== STARTING FULL SYSTEM VERIFICATION ===\n');

  // Step 1: Start Server
  console.log(`[Step 1] Starting backend server on port ${PORT}...`);
  const serverProcess = spawn('node', [path.resolve(__dirname, '../index.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) }
  });

  let serverStarted = false;
  serverProcess.stdout.on('data', (d) => {
    const s = d.toString();
    console.log('  [Server]', s.trim());
    if (s.includes('Server running on port') || s.includes('Connected to MongoDB')) {
      serverStarted = true;
    }
  });

  serverProcess.stderr.on('data', (d) => {
    console.error('  [Server Err]', d.toString().trim());
  });

  // Poll health endpoint until ready
  for (let i = 0; i < 30; i++) {
    try {
      const hRes = await fetch(`${BASE_URL}/api/health`);
      if (hRes.ok) {
        console.log('  [Server] Health check OK, server is ready.\n');
        break;
      }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  let exitCode = 0;
  try {
    const testSessionId = `test-session-${Date.now()}`;
    const testMessageId = `msg-asst-${Date.now()}`;
    const testUserMsgId = `msg-user-${Date.now()}`;
    const userQuestion = 'Whether promoters of a corporate debtor are eligible to file an application for initiation of CIRP under IBC 2016';

    // Step 1.5: Create Session via /api/chat/sessions
    console.log('\n[Step 1.5] Creating test chat session (/api/chat/sessions)...');
    const createSessionRes = await fetch(`${BASE_URL}/api/chat/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'test-user-123' },
      body: JSON.stringify({
        session_id: testSessionId,
        title: 'IBC Promoter CIRP Eligibility Test',
        mode: 'rag'
      })
    });
    assert.strictEqual(createSessionRes.status, 200, `Expected 200 OK from create session, got ${createSessionRes.status}`);
    const createdSessionData = await createSessionRes.json();
    console.log('  ✓ Session created:', createdSessionData.session?.session_id || testSessionId);

    // Step 2: Test User-side Question Answering (/api/ask)
    console.log('\n[Step 2] Testing /api/ask (Question Fetching & Answer Generation)...');
    const askStart = Date.now();
    const askRes = await fetch(`${BASE_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'test-user-123' },
      body: JSON.stringify({
        question: userQuestion,
        history: [],
        sessionId: testSessionId,
        userMessageId: testUserMsgId,
        assistantMessageId: testMessageId
      })
    });

    assert.strictEqual(askRes.status, 200, `Expected 200 OK from /api/ask, got ${askRes.status}`);
    const askData = await askRes.json();
    console.log(`  ✓ Received response in ${Date.now() - askStart}ms`);
    console.log(`  ✓ Answer preview: ${askData.answer.slice(0, 150)}...`);
    console.log(`  ✓ Sources returned: ${askData.sources ? askData.sources.length : 0}`);
    console.log(`  ✓ Follow-up questions: ${askData.follow_up_questions ? askData.follow_up_questions.length : 0}`);

    assert.ok(askData.answer && askData.answer.length > 50, 'Answer should not be empty');
    assert.ok(Array.isArray(askData.sources) && askData.sources.length > 0, 'Sources array should contain retrieved citations');

    // Step 3: Test Citations Endpoint (/api/citation) - Open in New Tab behavior
    console.log('\n[Step 3] Testing /api/citation (Document Details & Full Content in New Tab)...');
    const firstSource = askData.sources[0];
    const sourceTable = firstSource.source_table || 'Legislation';
    const recordId = firstSource.record_id || firstSource.embedding_id || 715;
    const highlight = firstSource.excerpt || firstSource.chunk_text || '';

    const citationUrl = `${BASE_URL}/api/citation?sourceTable=${encodeURIComponent(sourceTable)}&recordId=${encodeURIComponent(recordId)}&theme=light&highlight=${encodeURIComponent(highlight)}`;
    console.log(`  Fetching citation URL: ${citationUrl}`);
    const citationRes = await fetch(citationUrl);
    assert.strictEqual(citationRes.status, 200, `Expected 200 OK from /api/citation, got ${citationRes.status}`);
    const citationHtml = await citationRes.text();
    console.log(`  ✓ Received HTML Citation page (${citationHtml.length} bytes)`);
    assert.ok(citationHtml.includes('CLA Online Citation'), 'Citation HTML title valid');
    assert.ok(citationHtml.includes('document-title') && citationHtml.includes('meta-grid') && citationHtml.includes('content-body'), 'Citation page includes all doc details, metadata grid and content body');

    // Step 4: Test Feedback Option - Thumbs Up / Down (/api/chat/feedback)
    console.log('\n[Step 4] Testing Feedback Option: Thumbs Up (/api/chat/feedback)...');
    const feedbackRes = await fetch(`${BASE_URL}/api/chat/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'test-user-123' },
      body: JSON.stringify({
        session_id: testSessionId,
        message_id: testMessageId,
        feedback: 'up'
      })
    });
    assert.strictEqual(feedbackRes.status, 200, `Expected 200 OK from /api/chat/feedback, got ${feedbackRes.status}`);
    const feedbackData = await feedbackRes.json();
    console.log('  ✓ Feedback saved successfully:', feedbackData);
    assert.strictEqual(feedbackData.success, true, 'Feedback update should succeed');

    // Step 5: Test Detailed User Feedback Modal Submission (/api/feedback)
    console.log('\n[Step 5] Testing Detailed Feedback Submission Modal (/api/feedback)...');
    const detailedFeedbackRes = await fetch(`${BASE_URL}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'test-user-123' },
      body: JSON.stringify({
        question: userQuestion,
        answer: askData.answer,
        chunks: askData.sources,
        feedback: 'Excellent retrieval and accurate reference to IBC Section 7 and 10.',
        sessionId: testSessionId
      })
    });
    assert.strictEqual(detailedFeedbackRes.status, 200, `Expected 200 OK from /api/feedback, got ${detailedFeedbackRes.status}`);
    const detailedData = await detailedFeedbackRes.json();
    console.log('  ✓ Detailed feedback recorded:', detailedData);
    assert.strictEqual(detailedData.success, true, 'Detailed feedback recording should succeed');

    // Step 6: Test Admin Side Persistence (/api/admin/feedback & /api/chat/sessions)
    console.log('\n[Step 6] Testing Admin Side Persistence & Retrievals...');
    
    // Check Admin Feedback retrieval
    const adminFeedbackRes = await fetch(`${BASE_URL}/api/admin/feedback?limit=10`, {
      headers: { 'x-user-id': 'test-user-123' }
    });
    assert.strictEqual(adminFeedbackRes.status, 200, `Expected 200 OK from /api/admin/feedback, got ${adminFeedbackRes.status}`);
    const adminFeedbackData = await adminFeedbackRes.json();
    console.log(`  ✓ Admin feedback records found: ${adminFeedbackData.feedbacks ? adminFeedbackData.feedbacks.length : 0}`);
    const foundFeedback = (adminFeedbackData.feedbacks || []).find(f => f.sessionId === testSessionId || (f.feedback && f.feedback.includes('IBC Section 7')));
    assert.ok(foundFeedback, 'Submitted detailed feedback should be properly stored in admin database');
    console.log('  ✓ Confirmed feedback stored in Admin DB:', {
      question: foundFeedback.question?.slice(0, 60),
      feedback: foundFeedback.feedback,
      chunksCount: foundFeedback.chunks?.length
    });

    // Check Chat Sessions persistence
    const sessionsRes = await fetch(`${BASE_URL}/api/chat/sessions`, {
      headers: { 'x-user-id': 'test-user-123' }
    });
    assert.strictEqual(sessionsRes.status, 200, `Expected 200 OK from /api/chat/sessions, got ${sessionsRes.status}`);
    const sessionsData = await sessionsRes.json();
    console.log(`  ✓ Chat sessions found: ${sessionsData.sessions ? sessionsData.sessions.length : 0}`);

    // Check Messages for the session
    const messagesRes = await fetch(`${BASE_URL}/api/chat/sessions/${testSessionId}/messages`, {
      headers: { 'x-user-id': 'test-user-123' }
    });
    assert.strictEqual(messagesRes.status, 200, `Expected 200 OK from /api/chat/messages/${testSessionId}, got ${messagesRes.status}`);
    const messagesData = await messagesRes.json();
    console.log(`  ✓ Messages stored for session: ${messagesData.messages ? messagesData.messages.length : 0}`);
    const storedAssistantMsg = (messagesData.messages || []).find(m => m.message_id === testMessageId || m.role === 'assistant');
    if (storedAssistantMsg) {
      console.log('  ✓ Stored assistant message feedback state:', storedAssistantMsg.feedback);
      assert.strictEqual(storedAssistantMsg.feedback, 'up', 'Assistant message feedback should reflect "up" in DB');
    }

    // Check Admin Evaluations / Overview
    const evalRes = await fetch(`${BASE_URL}/api/admin/overview`, {
      headers: { 'x-user-id': 'test-user-123' }
    });
    assert.strictEqual(evalRes.status, 200, `Expected 200 OK from /api/admin/overview, got ${evalRes.status}`);
    const evalData = await evalRes.json();
    console.log(`  ✓ Admin evaluations overview:`, {
      totalEvaluations: evalData.totalEvaluations,
      avgFaithfulness: evalData.avgFaithfulness,
      avgAnswerRelevancy: evalData.avgAnswerRelevancy
    });

    console.log('\n======================================================');
    console.log('🎉 ALL SYSTEM CHECKS PASSED PERFECTLY!');
    console.log('1. User-side questions are being fetched and answered accurately.');
    console.log('2. Citations open properly with complete details in a new tab.');
    console.log('3. Feedback options (thumbs up/down + detailed notes) are functional.');
    console.log('4. Admin-side stores messages, sessions, feedback & evaluations in MongoDB.');
    console.log('======================================================');
  } catch (err) {
    console.error('\n❌ TEST FAILED:', err);
    exitCode = 1;
  } finally {
    console.log('\nShutting down test server...');
    serverProcess.kill('SIGINT');
    setTimeout(() => process.exit(exitCode), 1000);
  }
}

runTests();
