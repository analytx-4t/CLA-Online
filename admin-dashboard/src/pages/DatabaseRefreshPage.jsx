import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, DatabaseZap, History, Loader2, RefreshCw } from 'lucide-react';
import StatusPill from '../components/StatusPill';

const STATUS_META = {
  running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'success' },
  completed_with_errors: { label: 'Completed with errors', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  pending: { label: 'Waiting', tone: 'neutral' },
};

const PHASE_LABELS = {
  starting: 'Starting',
  listing: 'Reading the record list from the API',
  checking_index: 'Checking which records are already indexed',
  embedding_new: 'Embedding and adding new records',
  refreshing_updated: 'Refreshing records edited at the source',
  verifying: 'Verifying the new records',
  done: 'Finished',
};

const TRIGGER_LABELS = { scheduled: 'Nightly schedule', manual: 'Admin panel', cli: 'Command line' };

const SOURCE_LABELS = {
  Articles: 'Articles',
  CaseLaws: 'Case laws',
  Circular: 'Circulars',
  Legislation: 'Legislation',
  Notifications: 'Notifications',
  Query: 'Queries',
};

const numberFormat = new Intl.NumberFormat('en-IN');

function formatNumber(value) {
  return value === null || value === undefined ? '—' : numberFormat.format(value);
}

function formatDateTime(value, timeZone) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  });
}

function formatDuration(startedAt, finishedAt) {
  if (!startedAt) return '—';
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function sumSources(run, key) {
  return Object.values(run?.sources || {}).reduce((total, source) => total + (source[key] || 0), 0);
}

function Card({ icon: Icon, title, subtitle, children }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Icon size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-4 space-y-2">{children}</div>
    </section>
  );
}

function Row({ label, value, tone }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-muted px-3 py-2.5 text-sm">
      <span className="text-muted">{label}</span>
      {tone ? <StatusPill label={value} tone={tone} /> : <span className="tnum text-right font-medium text-ink">{value}</span>}
    </div>
  );
}

function SourceTable({ run }) {
  const sources = Object.entries(run?.sources || {});
  if (sources.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-[10px] border border-line">
      <table className="min-w-full border-separate border-spacing-0 text-sm text-ink">
        <thead className="bg-surface-strong text-left text-[10px] uppercase tracking-[0.2em] text-muted">
          <tr>
            {['Source', 'In API', 'Already indexed', 'Added', 'Refreshed', 'No text in API', 'Errors', 'Status'].map((header) => (
              <th key={header} className="border-b border-line px-3 py-2.5 font-semibold">{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sources.map(([name, source]) => {
            const meta = STATUS_META[source.status] || STATUS_META.pending;
            return (
              <tr key={name} className="bg-surface">
                <td className="border-b border-line px-3 py-2.5 font-medium">
                  {SOURCE_LABELS[name] || name}
                  {source.status === 'running' && source.phase && (
                    <p className="mt-0.5 text-xs font-normal text-muted">{PHASE_LABELS[source.phase] || source.phase}</p>
                  )}
                </td>
                <td className="tnum border-b border-line px-3 py-2.5">
                  {formatNumber(source.listed)} {source.unit === 'files' ? 'files' : ''}
                </td>
                <td className="tnum border-b border-line px-3 py-2.5">{formatNumber(source.already_indexed)}</td>
                <td className="tnum border-b border-line px-3 py-2.5">
                  {formatNumber(source.new_records)}
                  {source.new_chunks > 0 && <span className="text-muted"> ({formatNumber(source.new_chunks)} chunks)</span>}
                </td>
                <td className="tnum border-b border-line px-3 py-2.5">{formatNumber(source.updated_records)}</td>
                <td className="tnum border-b border-line px-3 py-2.5">{formatNumber(source.no_content)}</td>
                <td className="tnum border-b border-line px-3 py-2.5">
                  <span className={source.errors > 0 ? 'font-semibold text-danger' : ''} title={(source.error_samples || []).join('\n')}>
                    {formatNumber(source.errors)}
                  </span>
                </td>
                <td className="border-b border-line px-3 py-2.5"><StatusPill label={meta.label} tone={meta.tone} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function DatabaseRefreshPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/db-sync/status');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const payload = await res.json();
      setData(payload.data);
      setError(null);
    } catch (err) {
      setError(err.message || 'Unable to load database refresh status.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll quickly while a refresh is running so progress is live, slowly otherwise.
  useEffect(() => {
    load();
    const delay = data?.running ? 3000 : 30000;
    pollRef.current = setInterval(load, delay);
    return () => clearInterval(pollRef.current);
  }, [load, data?.running]);

  const startRefresh = async (reverify) => {
    setStarting(true);
    setNotice(null);
    try {
      const res = await fetch('/api/admin/db-sync/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reverify }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.success) {
        throw new Error(payload.error || `HTTP error ${res.status}`);
      }
      setNotice({ tone: 'success', text: 'Database refresh started. Progress appears below.' });
      // The job needs a moment to write its first progress report.
      setTimeout(load, 1500);
    } catch (err) {
      setNotice({ tone: 'danger', text: err.message || 'Unable to start the database refresh.' });
    } finally {
      setStarting(false);
      load();
    }
  };

  const running = Boolean(data?.running);
  const activeRun = running ? data?.current : data?.lastRun;
  const activeMeta = STATUS_META[running ? 'running' : activeRun?.status] || null;
  const scheduleZone = data?.schedule?.timezone;
  const buttonsDisabled = running || starting || !data?.config?.apiConfigured;

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-line bg-surface p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-muted">Knowledge base</p>
            <h2 className="mt-1 text-2xl font-semibold text-ink">Database Refresh</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted">
              Pulls new and edited records from the CLA Online API into the legal research index. This runs automatically every night; use the button to run it now.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => startRefresh(true)}
              disabled={buttonsDisabled}
              title="Ignores the saved list of indexed records and re-checks every record against the index. Slower; use it if the index was changed outside this page."
              className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-ink transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              Full re-check
            </button>
            <button
              onClick={() => startRefresh(false)}
              disabled={buttonsDisabled}
              className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {running || starting ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              {running ? 'Refresh running…' : 'Refresh now'}
            </button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
          <p className="font-medium">Unable to load database refresh status.</p>
          <p className="mt-1">{error}</p>
        </div>
      )}

      {notice && (
        <div className={`rounded-lg border p-3 text-sm ${notice.tone === 'danger' ? 'border-danger/30 bg-danger-soft text-danger' : 'border-good/30 bg-good/15 text-good'}`}>
          {notice.text}
        </div>
      )}

      {data && !data.config.apiConfigured && (
        <div className="rounded-lg border border-warn/30 bg-warn-soft p-4 text-sm text-warn">
          <p className="font-medium">CLA Online API credentials are not set on the server.</p>
          <p className="mt-1">Add CLA_API_CLIENT_ID and CLA_API_CLIENT_SECRET to the server .env file, then restart the backend.</p>
        </div>
      )}

      {loading && !data ? (
        <div className="grid gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="h-44 animate-pulse rounded-lg bg-surface-muted" />
          ))}
        </div>
      ) : data ? (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Card icon={CalendarClock} title="Schedule" subtitle="Automatic nightly refresh">
              <Row label="Status" value={data.schedule.enabled ? 'Enabled' : 'Disabled'} tone={data.schedule.enabled ? 'success' : 'neutral'} />
              <Row label="Runs daily at" value={`${data.schedule.time} (${data.schedule.timezone})`} />
              <Row label="Next run" value={data.schedule.enabled ? formatDateTime(data.schedule.nextRunAt, scheduleZone) : '—'} />
            </Card>

            <Card icon={DatabaseZap} title="Index" subtitle="Where new records are added">
              <Row label="Pinecone index" value={data.config.indexName} />
              <Row label="Embedding model" value={`${data.config.embeddingModel} · ${data.config.embeddingDimensions}`} />
              <Row label="Vectors" value={formatNumber(activeRun?.vectors_after ?? activeRun?.vectors_before)} />
            </Card>

            <Card icon={RefreshCw} title={running ? 'Current run' : 'Last run'} subtitle={activeRun ? TRIGGER_LABELS[activeRun.trigger] || activeRun.trigger : 'No refresh has run yet'}>
              <Row label="Status" value={activeMeta ? activeMeta.label : 'Never run'} tone={activeMeta ? activeMeta.tone : 'neutral'} />
              <Row label="Started" value={formatDateTime(activeRun?.started_at, scheduleZone)} />
              <Row label={running ? 'Running for' : 'Duration'} value={activeRun ? formatDuration(activeRun.started_at, running ? null : activeRun.finished_at) : '—'} />
            </Card>
          </div>

          {activeRun && (
            <section className="rounded-lg border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-ink">{running ? 'Live progress' : 'Last run by source'}</h3>
                  <p className="text-xs text-muted">
                    {running
                      ? `${SOURCE_LABELS[activeRun.current_source] || activeRun.current_source || 'Preparing'} — ${PHASE_LABELS[activeRun.phase] || activeRun.phase || ''}`
                      : `${formatNumber(sumSources(activeRun, 'new_records'))} records added (${formatNumber(sumSources(activeRun, 'new_chunks'))} chunks), ${formatNumber(sumSources(activeRun, 'updated_records'))} refreshed, ${formatNumber(sumSources(activeRun, 'errors'))} errors`}
                  </p>
                </div>
                {running && <Loader2 size={18} className="animate-spin text-accent" />}
              </div>

              {activeRun.error && (
                <div className="mt-3 rounded-lg border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{activeRun.error}</div>
              )}

              <div className="mt-3">
                <SourceTable run={activeRun} />
              </div>
              <p className="mt-2 text-xs text-muted">
                “No text in API” counts records the API lists without any document text, so there is nothing to embed. Commentary and Procedures have no API endpoint and are not refreshed here.
              </p>
            </section>
          )}

          <section className="rounded-lg border border-line bg-surface p-4">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
                <History size={18} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-ink">Run history</h3>
                <p className="text-xs text-muted">Most recent 20 runs</p>
              </div>
            </div>

            {data.history.length === 0 ? (
              <p className="mt-4 rounded-lg border border-line bg-surface-muted px-3 py-6 text-center text-sm text-muted">No runs recorded yet.</p>
            ) : (
              <div className="mt-4 overflow-x-auto rounded-[10px] border border-line">
                <table className="min-w-full border-separate border-spacing-0 text-sm text-ink">
                  <thead className="bg-surface-strong text-left text-[10px] uppercase tracking-[0.2em] text-muted">
                    <tr>
                      {['Started', 'Started by', 'Status', 'Duration', 'Added', 'Refreshed', 'Errors', 'Vectors after'].map((header) => (
                        <th key={header} className="border-b border-line px-3 py-2.5 font-semibold">{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((run) => {
                      const meta = STATUS_META[run.status] || STATUS_META.pending;
                      return (
                        <tr key={run.run_id} className="bg-surface" title={run.error || undefined}>
                          <td className="tnum border-b border-line px-3 py-2.5">{formatDateTime(run.started_at, scheduleZone)}</td>
                          <td className="border-b border-line px-3 py-2.5">
                            {TRIGGER_LABELS[run.trigger] || run.trigger}
                            {run.dry_run ? ' (dry run)' : ''}
                          </td>
                          <td className="border-b border-line px-3 py-2.5"><StatusPill label={meta.label} tone={meta.tone} /></td>
                          <td className="tnum border-b border-line px-3 py-2.5">{formatDuration(run.started_at, run.finished_at)}</td>
                          <td className="tnum border-b border-line px-3 py-2.5">
                            {formatNumber(sumSources(run, 'new_records'))}
                            <span className="text-muted"> ({formatNumber(sumSources(run, 'new_chunks'))} chunks)</span>
                          </td>
                          <td className="tnum border-b border-line px-3 py-2.5">{formatNumber(sumSources(run, 'updated_records'))}</td>
                          <td className="tnum border-b border-line px-3 py-2.5">{formatNumber(sumSources(run, 'errors'))}</td>
                          <td className="tnum border-b border-line px-3 py-2.5">{formatNumber(run.vectors_after)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
