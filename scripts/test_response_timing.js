require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const { performance } = require('perf_hooks');

const PORT = 3098;
const BASE_URL = `http://localhost:${PORT}`;

const testQuestions = [
  {
    category: 'Corporate Social Responsibility (Companies Act)',
    question: 'What are the mandatory requirements and penalties for non-compliance with Corporate Social Responsibility (CSR) under Section 135 of Companies Act, 2013?'
  },
  {
    category: 'Insolvency & Bankruptcy Code (IBC)',
    question: 'Can an operational creditor initiate CIRP under Section 9 of IBC if there is a pre-existing dispute between the parties?'
  },
  {
    category: 'SEBI & Corporate Governance',
    question: 'What are the disclosure requirements for material events under Regulation 30 of SEBI LODR Regulations?'
  }
];

function waitForPort(port, maxAttempts = 30) {
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok || res.status === 404 || res.status === 200) {
          return resolve();
        }
      } catch (e) {
        // server not ready yet
      }
      await new Promise(r => setTimeout(r, 500));
    }
    reject(new Error(`Server failed to respond on port ${port} within timeout`));
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    console.log(`Starting backend server on port ${PORT}...`);
    const serverProcess = spawn('node', [path.resolve(__dirname, '../backend/index.js')], {
      cwd: path.resolve(__dirname, '../backend'),
      env: { ...process.env, PORT: PORT }
    });

    serverProcess.stdout.on('data', (data) => {
      console.log('[Server]:', data.toString().trim());
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('[Server Error]:', data.toString().trim());
    });

    serverProcess.on('error', (err) => {
      reject(err);
    });

    // Wait until port responds
    waitForPort(PORT)
      .then(() => resolve(serverProcess))
      .catch((err) => reject(err));
  });
}

async function runTimingBenchmark() {
  let serverProcess;
  try {
    serverProcess = await startServer();
    console.log(`✅ Backend server listening on port ${PORT}.\n`);
  } catch (err) {
    console.error('Failed to start test server:', err);
    process.exit(1);
  }

  console.log('================================================================');
  console.log('⚡ BACKEND END-TO-END LATENCY BENCHMARK TEST');
  console.log('================================================================\n');

  const results = [];

  for (let i = 0; i < testQuestions.length; i++) {
    const item = testQuestions[i];
    console.log(`[Test ${i + 1}/${testQuestions.length}] Category: ${item.category}`);
    console.log(`Question: "${item.question}"`);

    const startTime = performance.now();
    try {
      const response = await fetch(`${BASE_URL}/api/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ question: item.question })
      });

      const endTime = performance.now();
      const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(2);

      if (!response.ok) {
        console.error(`❌ Request failed with status ${response.status}`);
        results.push({
          category: item.category,
          question: item.question,
          elapsedSeconds,
          status: response.status,
          success: false
        });
        continue;
      }

      const data = await response.json();
      const answerLen = (data.answer || '').length;
      const sourcesCount = (data.sources || []).length;
      const searchResultsCount = (data.searchResults || []).length;

      console.log(`⏱️  Response Time: ${elapsedSeconds} seconds (${(elapsedSeconds / 60).toFixed(2)} mins)`);
      console.log(`📄 Answer Length: ${answerLen} characters`);
      console.log(`📚 Sources Cited: ${sourcesCount} sources`);
      console.log(`🔍 Chunks Retrieved: ${searchResultsCount} chunks`);
      console.log(`----------------------------------------------------------------\n`);

      results.push({
        category: item.category,
        question: item.question,
        elapsedSeconds,
        status: response.status,
        answerLen,
        sourcesCount,
        searchResultsCount,
        success: true
      });
    } catch (err) {
      const endTime = performance.now();
      const elapsedSeconds = ((endTime - startTime) / 1000).toFixed(2);
      console.error(`❌ Request error:`, err.message);
      results.push({
        category: item.category,
        question: item.question,
        elapsedSeconds,
        status: 'ERROR',
        success: false,
        error: err.message
      });
    }
  }

  // Gracefully stop backend server
  if (serverProcess) {
    console.log('Stopping backend server process...');
    serverProcess.kill('SIGINT');
  }

  console.log('================================================================');
  console.log('📊 BENCHMARK TIMING SUMMARY');
  console.log('================================================================');
  console.table(results.map(r => ({
    Category: r.category,
    'Time (Seconds)': `${r.elapsedSeconds}s`,
    'Time (Minutes)': `${(r.elapsedSeconds / 60).toFixed(2)}m`,
    'Status': r.success ? 'SUCCESS (200)' : 'FAILED',
    'Sources': r.sourcesCount || 0,
    'Answer Chars': r.answerLen || 0
  })));

  const totalSecs = results.reduce((acc, r) => acc + parseFloat(r.elapsedSeconds), 0);
  const avgSecs = (totalSecs / results.length).toFixed(2);
  console.log(`\n🏆 Average Latency Across ${results.length} Real Queries: ${avgSecs} seconds (${(avgSecs / 60).toFixed(2)} mins)\n`);

  process.exit(0);
}

runTimingBenchmark();
