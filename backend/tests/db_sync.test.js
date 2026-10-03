const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The service reads its configuration at load time, so set it before requiring it.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-sync-test-'));
process.env.CLA_SYNC_STATE_DIR = stateDir;
process.env.DB_SYNC_TIME = '00:00';
process.env.DB_SYNC_TIMEZONE = 'Asia/Kolkata';
process.env.DB_SYNC_ENABLED = 'true';

const { getStatus, startSync } = require('../dbSync/service');

const statusPath = path.join(stateDir, 'status.json');
const historyPath = path.join(stateDir, 'history.json');
const lockPath = path.join(stateDir, 'sync.lock');

function reset() {
  for (const file of [statusPath, historyPath, lockPath]) {
    fs.rmSync(file, { force: true });
  }
}

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

test('reports an idle service with the next run at the upcoming midnight IST', () => {
  reset();
  const status = getStatus();

  assert.equal(status.running, false);
  assert.equal(status.current, null);
  assert.equal(status.lastRun, null);
  assert.deepEqual(status.history, []);
  assert.equal(status.schedule.enabled, true);
  assert.equal(status.schedule.time, '00:00');
  assert.equal(status.schedule.timezone, 'Asia/Kolkata');

  const nextRun = new Date(status.schedule.nextRunAt);
  const msUntil = nextRun.getTime() - Date.now();
  assert.ok(msUntil > 0 && msUntil <= 24 * 60 * 60 * 1000, 'next run is within the next 24 hours');
  // Midnight in IST (UTC+05:30) is 18:30 UTC.
  assert.equal(nextRun.toISOString().slice(11, 19), '18:30:00');
});

test('a fresh lock means a run is in progress and a second run is refused', () => {
  reset();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, run_id: 'abc' }));
  fs.writeFileSync(statusPath, JSON.stringify({ run_id: 'abc', status: 'running', phase: 'listing', sources: {} }));

  const status = getStatus();
  assert.equal(status.running, true);
  assert.equal(status.current.run_id, 'abc');
  assert.deepEqual(startSync({ trigger: 'manual' }), { started: false, reason: 'already_running' });
});

test('a stale lock does not count as a running sync', () => {
  reset();
  fs.writeFileSync(lockPath, '{}');
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);

  assert.equal(getStatus().running, false);
});

test('a run that died without reporting is shown as failed, not running', () => {
  reset();
  fs.writeFileSync(statusPath, JSON.stringify({
    run_id: 'dead', status: 'running', phase: 'embedding_new', started_at: new Date().toISOString(), sources: {},
  }));

  const status = getStatus();
  assert.equal(status.running, false);
  assert.equal(status.lastRun.run_id, 'dead');
  assert.equal(status.lastRun.status, 'failed');
  assert.match(status.lastRun.error, /interrupted/);
});

test('the last real run is reported, skipping dry runs', () => {
  reset();
  const real = { run_id: 'real', status: 'completed', dry_run: false, started_at: '2026-10-02T18:30:05.000Z', sources: {} };
  const dry = { run_id: 'dry', status: 'completed', dry_run: true, started_at: '2026-10-03T04:00:00.000Z', sources: {} };
  fs.writeFileSync(historyPath, JSON.stringify([dry, real]));
  fs.writeFileSync(statusPath, JSON.stringify(dry));

  const status = getStatus();
  assert.equal(status.lastRun.run_id, 'real');
  assert.equal(status.history.length, 2);
});
