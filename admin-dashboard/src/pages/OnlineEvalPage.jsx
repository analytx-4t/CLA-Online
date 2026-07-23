import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Filter, ChevronRight, RefreshCw } from 'lucide-react';
import SearchBox from '../components/SearchBox';
import FilterBar from '../components/FilterBar';
import DataTable from '../components/DataTable';
import StatusPill from '../components/StatusPill';
import Drawer from '../components/Drawer';
import MetricCard from '../components/MetricCard';
import MarkdownContent from '../components/MarkdownContent';

const statusOptions = ['All', 'completed', 'failed'];
const providerOptions = ['All', 'groq', 'openai', 'gemini', 'deepseek'];

function formatMetric(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${Number(value).toFixed(2)}`;
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function getStatusTone(status) {
  if (status === 'failed') return 'danger';
  if (status === 'completed') return 'success';
  return 'neutral';
}

export default function OnlineEvalPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All');
  const [provider, setProvider] = useState('All');
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [totalPages, setTotalPages] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const latestRequestRef = useRef(0);
  const socketRef = useRef(null);
  const pollTimerRef = useRef(null);

  const loadData = async ({ showLoader = true, refresh = false } = {}) => {
    if (showLoader) setLoading(true);
    if (refresh) setRefreshing(true);
    setError(null);

    const requestId = ++latestRequestRef.current;
    const params = new URLSearchParams({
      page: String(page),
      limit: String(pageSize),
      search,
      status: status === 'All' ? '' : status,
      provider: provider === 'All' ? '' : provider,
    });
    const url = `http://127.0.0.1:3000/api/admin/ragas?${params.toString()}`;

    try {
      const response = await fetch(url);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || 'Unable to load evaluations.');

      if (requestId !== latestRequestRef.current) return;
      setRows(Array.isArray(payload?.data) ? payload.data : []);
      setTotalPages(Number(payload?.pagination?.totalPages || 1));
    } catch (loadError) {
      if (requestId !== latestRequestRef.current) return;
      setError(loadError.message || 'Unable to load evaluations.');
    } finally {
      if (requestId === latestRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const loadStats = async () => {
    try {
      const response = await fetch('http://127.0.0.1:3000/api/admin/ragas/stats');
      if (!response.ok) throw new Error('Unable to load stats.');
      const payload = await response.json();
      setStats(payload?.data || null);
    } catch (statsError) {
      console.error('Failed to load evaluation stats', statsError);
    }
  };

  const loadDetail = async (requestId) => {
    if (!requestId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    setSelectedRequestId(requestId);
    try {
      const response = await fetch(`http://127.0.0.1:3000/api/admin/ragas/${requestId}`);
      if (!response.ok) throw new Error('Unable to load evaluation details.');
      const payload = await response.json();
      setDetail(payload?.data || null);
    } catch (detailError) {
      setDetail(null);
      setError(detailError.message || 'Unable to load evaluation details.');
    } finally {
      setLoadingDetail(false);
    }
  };

  const applyLiveEvaluation = (entry) => {
    if (!entry?.requestId) return;
    setRows((currentRows) => {
      if (currentRows.some((row) => row.requestId === entry.requestId)) {
        return currentRows.map((row) => (row.requestId === entry.requestId ? { ...row, ...entry } : row));
      }
      return [{ ...entry }, ...currentRows].slice(0, 25);
    });
  };

  useEffect(() => {
    loadData({ showLoader: true });
    loadStats();
  }, []);

  useEffect(() => {
    loadData({ showLoader: false });
  }, [page, search, status, provider]);

  useEffect(() => {
    const socket = io('http://127.0.0.1:3000', { transports: ['websocket'], reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });
    socketRef.current = socket;

    socket.on('ragas-evaluation-updated', (payload) => {
      applyLiveEvaluation(payload);
      loadStats();
    });

    socket.on('connect_error', () => {
      if (!pollTimerRef.current) {
        pollTimerRef.current = window.setInterval(() => {
          loadData({ showLoader: false, refresh: true });
          loadStats();
        }, 30000);
      }
    });

    return () => {
      socket.disconnect();
      if (pollTimerRef.current) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  const filteredRows = useMemo(() => rows, [rows]);

  const columns = [
    { header: 'Timestamp', accessor: 'timestamp', width: '170px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{formatTimestamp(row.timestamp)}</span> },
    { header: 'Request ID', accessor: 'requestId', width: '130px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.requestId || '—'}</span> },
    { header: 'Question', accessor: 'question', width: '260px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.question || '—'}</span> },
    { header: 'Provider', accessor: 'provider', width: '100px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.provider || '—'}</span> },
    { header: 'Model', accessor: 'model', width: '140px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.model || '—'}</span> },
    { header: 'Overall Score', accessor: 'overallScore', width: '110px', render: (row) => <span className="tnum font-semibold text-ink">{formatMetric(row.overallScore)}</span> },
    { header: 'Status', accessor: 'evaluationStatus', width: '100px', render: (row) => <StatusPill label={(row.evaluationStatus || 'unknown').toUpperCase()} tone={getStatusTone(row.evaluationStatus)} /> },
    { header: 'Actions', accessor: 'action', width: '90px', render: (row) => <button onClick={() => loadDetail(row.requestId)} className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-accent">View <ChevronRight size={14} /></button> },
  ];

  return (
    <div className="space-y-4">
      <section className="card p-4">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-muted">Evaluation workspace</p>
            <h2 className="mt-2 text-2xl font-semibold text-ink">Online Evaluation</h2>
            <p className="mt-1 text-sm text-muted">Live quality scoring of production requests, evaluated as they happen.</p>
          </div>
          <div className="flex w-full max-w-sm items-center gap-2 xl:w-auto">
            <SearchBox value={search} onChange={setSearch} placeholder="Search evaluations" />
            <button onClick={() => loadData({ showLoader: false, refresh: true })} disabled={refreshing} className="inline-flex items-center justify-center rounded-lg border border-line bg-surface p-2.5 text-muted transition hover:border-accent hover:text-accent disabled:opacity-60">
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <FilterBar>
            <div className="flex items-center gap-2 text-sm text-ink"><Filter size={16} /><span>Status</span></div>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none">
              {statusOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </FilterBar>
          <FilterBar>
            <div className="flex items-center gap-2 text-sm text-ink"><Filter size={16} /><span>Provider</span></div>
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setPage(1); }} className="rounded-lg border border-line bg-surface px-2.5 py-2 text-sm text-ink outline-none">
              {providerOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </FilterBar>
        </div>
      </section>

      <section className="space-y-4">
        <div className="card grid grid-cols-2 gap-x-4 gap-y-5 p-4 sm:grid-cols-5 divide-x divide-line">
          <MetricCard title="Total Evaluations" value={stats?.totalEvaluations ?? '—'} caption="All saved" />
          <div className="pl-4"><MetricCard title="Overall" value={stats ? formatPercent(stats.avgOverallScore) : '—'} /></div>
          <div className="pl-4"><MetricCard title="Faithfulness" value={stats ? formatPercent(stats.avgFaithfulness) : '—'} /></div>
          <div className="pl-4"><MetricCard title="Relevancy" value={stats ? formatPercent(stats.avgAnswerRelevancy) : '—'} /></div>
          <div className="pl-4"><MetricCard title="PII Leakage" value={stats ? formatPercent(stats.avgPiiLeakage) : '—'} /></div>
        </div>

        <div className="card overflow-hidden p-3">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-10 animate-pulse rounded-lg bg-surface-muted" />)}
            </div>
          ) : error ? (
            <div className="rounded-lg border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
              <p className="font-medium">Unable to load evaluations.</p>
              <p className="mt-1 opacity-90">{error}</p>
              <button onClick={() => loadData({ showLoader: false, refresh: true })} className="mt-3 rounded-lg border border-danger/30 px-3 py-2 text-sm text-danger">Retry</button>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line bg-surface-muted p-6 text-center text-sm text-muted">No evaluations available yet.</div>
          ) : (
            <>
              <div className="w-full overflow-x-auto">
                <DataTable columns={columns} rows={filteredRows} onRowClick={(row) => loadDetail(row.requestId)} />
              </div>
              <div className="mt-3 flex flex-col gap-2 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
                <span>Page {page} of {totalPages}</span>
                <div className="flex items-center gap-2">
                  <button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-line px-3 py-1 disabled:opacity-50">Previous</button>
                  <button disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-line px-3 py-1 disabled:opacity-50">Next</button>
                </div>
              </div>
            </>
          )}
        </div>

        <Drawer open={Boolean(selectedRequestId)} title={detail ? `Details - ${detail.requestId}` : 'Evaluation details'} onClose={() => { setSelectedRequestId(null); setDetail(null); }}>
          {loadingDetail ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-10 animate-pulse rounded-lg bg-surface-muted" />)}
            </div>
          ) : detail ? (
            <div className="space-y-3">
              <div className="rounded-lg bg-surface-muted p-3">
                <p className="text-[10px] uppercase tracking-[0.24em] text-muted">Question</p>
                <p className="mt-2 text-sm text-ink">{detail.question || '—'}</p>
              </div>
              <div className="rounded-lg bg-surface-muted p-3">
                <p className="text-[10px] uppercase tracking-[0.24em] text-muted">Answer</p>
                <div className="mt-2">
                  <MarkdownContent content={detail.answer} />
                </div>
              </div>
              <div className="rounded-lg bg-surface-muted p-3">
                <p className="text-[10px] uppercase tracking-[0.24em] text-muted">Retrieved Context</p>
                <div className="mt-2 space-y-2">
                  {(detail.retrievedContext || []).length === 0 ? (
                    <p className="text-sm text-muted">—</p>
                  ) : (
                    detail.retrievedContext.map((item, idx) => (
                      <div key={idx} className="rounded-lg border border-line bg-surface p-2.5">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Source {idx + 1}</p>
                        <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted">{item}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="rounded-lg bg-surface-muted p-3">
                <p className="text-[10px] uppercase tracking-[0.24em] text-muted">Metrics</p>
                <div className="mt-2 space-y-3 text-sm text-ink">
                  {[
                    ['Faithfulness', detail.faithfulness, detail.faithfulnessReason],
                    ['Answer Relevancy', detail.answerRelevancy, detail.answerRelevancyReason],
                    ['Context Precision', detail.contextPrecision, detail.contextPrecisionReason],
                    ['Context Recall', detail.contextRecall, detail.contextRecallReason],
                    ['PII Leakage', detail.piiLeakage, detail.piiLeakageReason],
                  ].map(([label, value, reason]) => (
                    <div key={label} className="border-b border-line pb-2 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted">{label}</span>
                        <span className="tnum font-semibold">{formatMetric(value)}</span>
                      </div>
                      {reason && <p className="mt-1 text-xs leading-relaxed text-muted">{reason}</p>}
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <span className="font-medium text-ink">Overall Score</span>
                    <span className="tnum font-semibold text-accent">{formatMetric(detail.overallScore)}</span>
                  </div>
                </div>
              </div>
              <div className="rounded-lg bg-surface-muted p-3">
                <p className="text-[10px] uppercase tracking-[0.24em] text-muted">Evaluation</p>
                <div className="mt-2 space-y-2 text-sm text-ink">
                  <div className="flex items-center justify-between gap-2"><span className="text-muted">Provider</span><span className="font-semibold">{detail.provider || '—'}</span></div>
                  <div className="flex items-center justify-between gap-2"><span className="text-muted">Model</span><span className="font-semibold">{detail.model || '—'}</span></div>
                  <div className="flex items-center justify-between gap-2"><span className="text-muted">Status</span><StatusPill label={(detail.evaluationStatus || 'unknown').toUpperCase()} tone={getStatusTone(detail.evaluationStatus)} /></div>
                  {detail.errorMessage && (
                    <p className="mt-1 rounded-lg border border-danger/30 bg-danger-soft p-2 text-xs text-danger">{detail.errorMessage}</p>
                  )}
                </div>
              </div>
              <div className="rounded-lg bg-surface-muted p-3">
                <p className="text-[10px] uppercase tracking-[0.24em] text-muted">Metadata</p>
                <pre className="mt-2 whitespace-pre-wrap text-sm text-ink">{JSON.stringify(detail.metadata || {}, null, 2)}</pre>
              </div>
              <div className="rounded-lg bg-surface-muted p-3">
                <p className="text-[10px] uppercase tracking-[0.24em] text-muted">Suggestions</p>
                <ul className="mt-2 space-y-2 text-sm text-muted">
                  {(detail.suggestions || []).map((item) => <li key={item}>• {item}</li>)}
                </ul>
              </div>
            </div>
          ) : null}
        </Drawer>
      </section>
    </div>
  );
}
