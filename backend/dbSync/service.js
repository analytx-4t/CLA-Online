const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const dotenv = require('dotenv');

// Runs embedding/sync_from_api.py (CLA Online API -> Pinecone 'cla-online-db') every
// night and on demand from the admin dashboard. The Python job owns all sync logic and
// reports through JSON files in embedding/sync_state/; this module only starts it,
// schedules it and reads those files back.

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const SCRIPT_PATH = path.join(ROOT_DIR, 'embedding', 'sync_from_api.py');
const STATE_DIR = process.env.CLA_SYNC_STATE_DIR || path.join(ROOT_DIR, 'embedding', 'sync_state');
const STATUS_PATH = path.join(STATE_DIR, 'status.json');
const HISTORY_PATH = path.join(STATE_DIR, 'history.json');
const LOCK_PATH = path.join(STATE_DIR, 'sync.lock');

// Must match LOCK_STALE_SECONDS in sync_from_api.py.
const LOCK_STALE_MS = 600 * 1000;
const HISTORY_LIMIT = 60;

const SCHEDULE_ENABLED = String(process.env.DB_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
const SCHEDULE_TIME = parseScheduleTime(process.env.DB_SYNC_TIME || '00:00');
const SCHEDULE_TIMEZONE = resolveTimeZone(process.env.DB_SYNC_TIMEZONE || 'Asia/Kolkata');
const TICK_MS = 30 * 1000;
// A run missed because the backend was down at the scheduled minute is still started if
// the backend comes back within this window; after that it waits for the next night.
const CATCH_UP_WINDOW_MINUTES = 6 * 60;
const MAX_SCHEDULED_ATTEMPTS = 3;
const RETRY_GAP_MS = 60 * 60 * 1000;

let schedulerTimer = null;
let lastScheduledAttemptAt = 0;
let activeChild = null;

function parseScheduleTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  if (!match || hours > 23 || minutes > 59) {
    console.warn(`[DB Sync] Invalid DB_SYNC_TIME "${value}", falling back to 00:00.`);
    return { hours: 0, minutes: 0, label: '00:00' };
  }
  return { hours, minutes, label: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` };
}

function resolveTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch (err) {
    console.warn(`[DB Sync] Invalid DB_SYNC_TIMEZONE "${value}", falling back to Asia/Kolkata.`);
    return 'Asia/Kolkata';
  }
}

function getPythonExecutable() {
  const venvUnix = path.join(ROOT_DIR, 'embedding', 'venv', 'bin', 'python');
  const venvWin = path.join(ROOT_DIR, 'embedding', 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvUnix)) return venvUnix;
  if (fs.existsSync(venvWin)) return venvWin;
  if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) return process.env.PYTHON_PATH;
  return process.platform === 'win32' ? 'python' : 'python3';
}

// The Python job reads the root .env and backend/.env itself, so the credentials count as
// configured if they are in this process's environment or in either file.
function hasApiCredentials() {
  const keys = ['CLA_API_CLIENT_ID', 'CLA_API_CLIENT_SECRET'];
  if (keys.every((key) => process.env[key])) return true;
  const merged = {};
  for (const envPath of [path.join(ROOT_DIR, '.env'), path.join(ROOT_DIR, 'backend', '.env')]) {
    try {
      Object.assign(merged, dotenv.parse(fs.readFileSync(envPath)));
    } catch (err) {
      // file not present
    }
  }
  return keys.every((key) => process.env[key] || merged[key]);
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload));
  fs.renameSync(tmpPath, filePath);
}

function readHistory() {
  const history = readJson(HISTORY_PATH, []);
  return Array.isArray(history) ? history : [];
}

// The Python job refreshes the lock file's mtime while it is alive, so a fresh lock
// means a run is in progress even if it was started by another process (cron, CLI).
function isLockFresh() {
  try {
    return Date.now() - fs.statSync(LOCK_PATH).mtimeMs <= LOCK_STALE_MS;
  } catch (err) {
    return false;
  }
}

function isRunning() {
  return Boolean(activeChild) || isLockFresh();
}

function zonedParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHEDULE_TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function scheduledMinutes() {
  return SCHEDULE_TIME.hours * 60 + SCHEDULE_TIME.minutes;
}

function getNextRunAt(now = new Date()) {
  if (!SCHEDULE_ENABLED) return null;
  const delta = (scheduledMinutes() - zonedParts(now).minutes + 1440) % 1440 || 1440;
  const startOfMinute = Math.floor(now.getTime() / 60000) * 60000;
  return new Date(startOfMinute + delta * 60000).toISOString();
}

// Real (non dry-run) runs that started on the given local date at or after the scheduled time.
function runsSinceSchedule(dateKey) {
  const current = readJson(STATUS_PATH, null);
  const runs = readHistory();
  if (current && !runs.some((run) => run.run_id === current.run_id)) {
    // Still marked "running" with no live lock: the process was killed mid-run.
    const interrupted = current.status === 'running' && !isLockFresh();
    runs.unshift(interrupted ? { ...current, status: 'failed' } : current);
  }
  return runs.filter((run) => {
    if (!run || run.dry_run || !run.started_at) return false;
    const started = zonedParts(new Date(run.started_at));
    return started.dateKey === dateKey && started.minutes >= scheduledMinutes();
  });
}

function recordStartFailure(runId, trigger, message) {
  if (isLockFresh()) return;
  const current = readJson(STATUS_PATH, null);
  if (current && current.run_id === runId && current.status !== 'running') return;

  const now = new Date().toISOString();
  const failed = {
    ...(current && current.run_id === runId ? current : { sources: {} }),
    run_id: runId,
    trigger,
    dry_run: false,
    status: 'failed',
    phase: 'done',
    current_source: null,
    started_at: (current && current.run_id === runId && current.started_at) || now,
    finished_at: now,
    updated_at: now,
    error: message,
  };
  try {
    writeJson(STATUS_PATH, failed);
    writeJson(HISTORY_PATH, [failed, ...readHistory()].slice(0, HISTORY_LIMIT));
  } catch (err) {
    console.error('[DB Sync] Could not record failed run:', err.message);
  }
}

function startSync({ trigger = 'manual', reverify = false } = {}) {
  if (isRunning()) {
    return { started: false, reason: 'already_running' };
  }
  if (!fs.existsSync(SCRIPT_PATH)) {
    return { started: false, reason: 'script_missing', message: `sync_from_api.py not found at ${SCRIPT_PATH}` };
  }

  const runId = randomUUID().replace(/-/g, '').slice(0, 12);
  const args = [SCRIPT_PATH, '--trigger', trigger, '--run-id', runId];
  if (reverify) args.push('--reverify');

  let stderrTail = '';
  const child = spawn(getPythonExecutable(), args, {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  activeChild = child;

  child.stderr.on('data', (data) => {
    stderrTail = (stderrTail + data.toString()).slice(-2000);
  });

  child.on('error', (err) => {
    if (activeChild === child) activeChild = null;
    console.error(`[DB Sync] Could not start sync run ${runId}: ${err.message}`);
    recordStartFailure(runId, trigger, `Could not start the sync process: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    if (activeChild === child) activeChild = null;
    // 0 = completed, 3 = completed with per-record errors, 2 = another run held the lock.
    if (code === 0 || code === 3 || code === 2) {
      console.log(`[DB Sync] Run ${runId} (${trigger}) exited with code ${code}.`);
      return;
    }
    console.error(`[DB Sync] Run ${runId} (${trigger}) ended abnormally (code=${code}, signal=${signal}). ${stderrTail}`);
    recordStartFailure(runId, trigger, `Sync process ended unexpectedly (code=${code}, signal=${signal}). ${stderrTail}`.trim());
  });

  console.log(`[DB Sync] Started run ${runId} (trigger=${trigger}${reverify ? ', reverify' : ''}).`);
  return { started: true, runId };
}

function getStatus() {
  const running = isRunning();
  let current = readJson(STATUS_PATH, null);

  // The status file still says "running" but nothing is: the process was killed
  // (server restart, OOM) before it could record its outcome.
  if (current && current.status === 'running' && !running) {
    current = {
      ...current,
      status: 'failed',
      error: 'The run was interrupted before it finished (for example by a server restart). '
        + 'Nothing is lost: the next run picks up where it stopped.',
    };
  }

  const history = readHistory();
  const lastRun = history.find((run) => !run.dry_run) || null;

  return {
    running,
    current: running ? current : null,
    lastRun: !running && current && !current.dry_run && (!lastRun || current.run_id !== lastRun.run_id) ? current : lastRun,
    history: history.slice(0, 20),
    schedule: {
      enabled: SCHEDULE_ENABLED,
      time: SCHEDULE_TIME.label,
      timezone: SCHEDULE_TIMEZONE,
      nextRunAt: getNextRunAt(),
    },
    config: {
      apiConfigured: hasApiCredentials(),
      indexName: process.env.PINECONE_DB_INDEX_NAME || 'cla-online-db',
      embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
      embeddingDimensions: Number.parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10),
    },
  };
}

function schedulerTick() {
  try {
    const now = zonedParts(new Date());
    const sinceTarget = now.minutes - scheduledMinutes();
    if (sinceTarget < 0 || sinceTarget > CATCH_UP_WINDOW_MINUTES) return;
    if (isRunning()) return;

    const runs = runsSinceSchedule(now.dateKey);
    // Tonight's sync already ran (a manual run after the scheduled time counts too).
    if (runs.some((run) => run.status !== 'failed')) return;

    // Failed (API or network down): retry hourly, a limited number of times.
    const scheduledAttempts = runs.filter((run) => run.trigger === 'scheduled').length;
    if (scheduledAttempts >= MAX_SCHEDULED_ATTEMPTS) return;
    if (Date.now() - lastScheduledAttemptAt < RETRY_GAP_MS) return;

    lastScheduledAttemptAt = Date.now();
    const result = startSync({ trigger: 'scheduled' });
    if (!result.started) {
      console.warn(`[DB Sync] Scheduled run not started: ${result.reason}`);
    }
  } catch (err) {
    console.error('[DB Sync] Scheduler tick failed:', err.message);
  }
}

function startDbSyncScheduler() {
  if (schedulerTimer) return;
  if (!SCHEDULE_ENABLED) {
    console.log('[DB Sync] Nightly scheduler disabled (DB_SYNC_ENABLED=false).');
    return;
  }
  schedulerTimer = setInterval(schedulerTick, TICK_MS);
  schedulerTimer.unref();
  console.log(`[DB Sync] Nightly sync scheduled at ${SCHEDULE_TIME.label} ${SCHEDULE_TIMEZONE} (next run: ${getNextRunAt()}).`);
  schedulerTick();
}

function stopDbSyncScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  startSync,
  getStatus,
  startDbSyncScheduler,
  stopDbSyncScheduler,
};
