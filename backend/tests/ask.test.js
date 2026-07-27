require('dotenv').config();
const test = require('node:test');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3099;
const BASE_URL = `http://localhost:${PORT}`;

test.describe('/api/ask Endpoint Integration Tests', () => {
  let serverProcess;

  test.before(() => {
    return new Promise((resolve, reject) => {
      console.log('Starting backend server on port', PORT);
      serverProcess = spawn('node', [path.resolve(__dirname, '../index.js')], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, PORT: PORT }
      });

      let started = false;

      serverProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log('[Server Stdout]:', output.trim());
        if (output.includes(`Server running on port ${PORT}`) || output.includes('listening')) {
          if (!started) {
            started = true;
            resolve();
          }
        }
      });

      serverProcess.stderr.on('data', (data) => {
        console.error('[Server Stderr]:', data.toString().trim());
      });

      serverProcess.on('error', (err) => {
        reject(err);
      });

      // Timeout fallback in case stdout doesn't match perfectly
      setTimeout(() => {
        if (!started) {
          started = true;
          resolve();
        }
      }, 15000);
    });
  });

  test.after(() => {
    if (serverProcess) {
      console.log('Stopping backend server');
      serverProcess.kill('SIGINT');
    }
  });

  test('POST /api/ask - Happy Path (valid question with results)', async () => {
    const payload = { question: 'Can a managing director be in the employment of the company?' };
    
    const res = await fetch(`${BASE_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();

    assert.ok(data.answer, 'Response should contain an answer.');
    assert.ok(Array.isArray(data.sources), 'sources should be an array.');
    assert.ok(data.sources.length > 0, 'Should have retrieved at least one source.');
    assert.ok(data.searchResults.length > 0, 'Should have search results.');

    // Validate citation format in the answer
    console.log('Grounded Answer:', data.answer);
    console.log('Sources Used:', data.sources);
    
    const source = data.sources[0];
    assert.ok(source.title, 'Source should have a title.');
    assert.ok(source.filename, 'Source should have a filename.');
  });

  test('POST /api/ask - Out of scope / no results fallback', async () => {
    // This query is very unlikely to be in the legal Articles table
    const payload = { question: 'What is the recipe for baking chocolate chip cookies?' };
    
    const res = await fetch(`${BASE_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();

    console.log('Out of scope response answer:', data.answer);
    console.log('Out of scope response sources:', data.sources);

    // If search results are empty or the LLM grounds it as not found
    assert.ok(
      data.answer.toLowerCase().includes('nothing relevant found') || data.sources.length === 0,
      'Should return fallback message or zero sources for out-of-scope query.'
    );
  });

  test('POST /api/ask - Bad Request (missing question)', async () => {
    const payload = {};
    
    const res = await fetch(`${BASE_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
    assert.strictEqual(data.error, 'Question parameter is required and cannot be empty.');
  });

  test('POST /api/ask - Bad Request (empty question)', async () => {
    const payload = { question: '   ' };
    
    const res = await fetch(`${BASE_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.ok(data.error);
    assert.strictEqual(data.error, 'Question parameter is required and cannot be empty.');
  });

  test('POST /api/ask - Emits progress updates for a request id', async () => {
    const requestId = `progress-test-${Date.now()}`;
    const res = await fetch(`${BASE_URL}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Can a managing director be in the employment of the company?', requestId })
    });

    assert.strictEqual(res.status, 200);

    const progressRes = await fetch(`${BASE_URL}/api/ask/progress/${encodeURIComponent(requestId)}`);
    assert.strictEqual(progressRes.status, 200);
    const progressData = await progressRes.json();

    assert.ok(progressData.requestId === requestId, 'progress should be tracked for the request id');
    assert.ok(Array.isArray(progressData.steps), 'progress should include a step history');
    assert.ok(progressData.steps.length > 0, 'progress should include at least one step');
    assert.ok(progressData.currentStage === 'completed' || progressData.currentStage === 'complete', 'progress should complete');
  });
});
