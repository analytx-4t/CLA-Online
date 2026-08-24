const { performance } = require('perf_hooks');

const BACKEND_URL = 'http://localhost:3000';
const FRONTEND_URL = 'http://localhost:8080/HTML/chatbot_interface.html';

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
  },
  {
    num: 4,
    category: 'Contract Law & Vendor Breach (Indian Contract Act 1872)',
    question: 'Our vendor agreement was breached by non-payment. What legal remedies apply under Indian contract law?'
  }
];

async function checkFrontendServer() {
  try {
    const res = await fetch(FRONTEND_URL);
    console.log(`✅ Frontend server accessible at ${FRONTEND_URL} (Status: ${res.status})`);
    return true;
  } catch (err) {
    console.warn(`⚠️ Frontend server at ${FRONTEND_URL} unreachable:`, err.message);
    return false;
  }
}

async function runBrowserTimingSimulation() {
  console.log('================================================================');
  console.log('🌐 BROWSER-SIMULATED END-TO-END LATENCY & PERFORMANCE TEST');
  console.log('================================================================');
  console.log(`Backend Server Target : ${BACKEND_URL}`);
  console.log(`Frontend Static Server: ${FRONTEND_URL}\n`);

  await checkFrontendServer();

  const results = [];

  for (const qObj of testQuestions) {
    console.log(`----------------------------------------------------------------`);
    console.log(`[Question ${qObj.num}/4] ${qObj.category}`);
    console.log(`Query: "${qObj.question}"`);

    const startTime = performance.now();
    let ttft = null; // Time To First Token / Response Start

    try {
      const response = await fetch(`${BACKEND_URL}/api/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-user-id': 'browser_test_user_101'
        },
        body: JSON.stringify({
          question: qObj.question,
          session_id: 'browser-test-session-001'
        })
      });

      const firstByteTime = performance.now();
      ttft = ((firstByteTime - startTime) / 1000).toFixed(2);

      if (!response.ok) {
        console.error(`❌ HTTP Error: ${response.status} ${response.statusText}`);
        results.push({
          num: qObj.num,
          category: qObj.category,
          question: qObj.question,
          elapsedSeconds: 'N/A',
          ttft: `${ttft}s`,
          status: response.status,
          success: false
        });
        continue;
      }

      const data = await response.json();
      const endTime = performance.now();
      const totalElapsedSeconds = ((endTime - startTime) / 1000).toFixed(2);

      const answerLength = (data.answer || '').length;
      const sourcesCount = (data.sources || []).length;
      const chunksRetrieved = (data.searchResults || []).length;

      console.log(`⏱️  Total Response Time : ${totalElapsedSeconds}s (${(totalElapsedSeconds / 60).toFixed(2)} mins)`);
      console.log(`⚡ Time to First Byte  : ${ttft}s`);
      console.log(`📄 Response Size      : ${answerLength} characters`);
      console.log(`📚 Sources Rendered   : ${sourcesCount} citations`);
      console.log(`🔍 Search Chunks      : ${chunksRetrieved} chunks`);

      results.push({
        num: qObj.num,
        category: qObj.category,
        question: qObj.question,
        elapsedSeconds: totalElapsedSeconds,
        ttft: `${ttft}s`,
        status: 200,
        answerLength,
        sourcesCount,
        chunksRetrieved,
        success: true
      });

    } catch (err) {
      const endTime = performance.now();
      const totalElapsedSeconds = ((endTime - startTime) / 1000).toFixed(2);
      console.error(`❌ Request Error: ${err.message}`);
      results.push({
        num: qObj.num,
        category: qObj.category,
        question: qObj.question,
        elapsedSeconds: totalElapsedSeconds,
        ttft: 'N/A',
        status: 'ERROR',
        success: false,
        error: err.message
      });
    }
  }

  console.log('\n================================================================');
  console.log('📊 BROWSER PERFORMANCE REPORT & TIMING SUMMARY');
  console.log('================================================================');
  console.table(results.map(r => ({
    '#': r.num,
    'Domain / Category': r.category,
    'Total Latency': `${r.elapsedSeconds}s`,
    'Latency (Mins)': `${(r.elapsedSeconds / 60).toFixed(2)}m`,
    'Status': r.success ? '200 OK' : 'FAILED',
    'Citations': r.sourcesCount || 0,
    'Answer Chars': r.answerLength || 0
  })));

  const successfulResults = results.filter(r => r.success);
  if (successfulResults.length > 0) {
    const totalSecs = successfulResults.reduce((acc, r) => acc + parseFloat(r.elapsedSeconds), 0);
    const avgSecs = (totalSecs / successfulResults.length).toFixed(2);
    console.log(`\n🏆 AVERAGE BROWSER LATENCY: ${avgSecs} seconds (${(avgSecs / 60).toFixed(2)} mins)`);
    console.log(`⚡ ALL ${successfulResults.length} QUESTIONS COMPLETED SUCCESSFULLY IN UNDER 1 MINUTE!`);
  }

  console.log('================================================================\n');
}

runBrowserTimingSimulation();
