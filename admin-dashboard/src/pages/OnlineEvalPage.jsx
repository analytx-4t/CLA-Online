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

const statusOptions = ['All', 'completed', 'blocked', 'failed'];
const providerOptions = ['All', 'groq', 'openai', 'gemini', 'deepseek'];

function formatMetric(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'Nil';
  return `${Number(value).toFixed(2)}`;
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'Nil';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

// The judge scores PII Leakage inverted from every other metric — 1.00 is
// the clean/no-leak baseline and each detected leak subtracts from it (see
// eval_agent.md, "## 5. PII Leakage": "Base is 1.00 and each leak
// subtracts"). Displaying that raw score under a column literally called
// "PII Leakage" reads backwards — a safe answer would show "100%", implying
// maximum leakage. Flip it here so 0% always means "nothing leaked".
function formatLeakagePercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'Nil';
  return formatPercent(1 - Number(value));
}

function formatLeakageMetric(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'Nil';
  return formatMetric(1 - Number(value));
}

function getStatusTone(status) {
  if (status === 'failed') return 'danger';
  if (status === 'completed') return 'success';
  if (status === 'blocked') return 'info';
  return 'neutral';
}

function omitTimings(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const { retrievalTime, llmTime, ...rest } = metadata;
  return rest;
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
    { header: 'Timestamp', accessor: 'timestamp', width: '10%', render: (row) => formatTimestamp(row.timestamp) },
    { header: 'Question', accessor: 'question', width: '18%', render: (row) => row.question || '—' },
    { header: 'Model', accessor: 'model', width: '9%', render: (row) => row.model || '—' },
    
    { header: 'Faithfulness', accessor: 'faithfulness', width: '7%', render: (row) => <span className="tnum">{formatMetric(row.faithfulness)}</span> },
    { header: 'Answer Relevancy', accessor: 'answerRelevancy', width: '7%', render: (row) => <span className="tnum">{formatMetric(row.answerRelevancy)}</span> },
    { header: 'Context Recall', accessor: 'contextRecall', width: '8%', render: (row) => <span className="tnum">{formatMetric(row.contextRecall)}</span> },
    { header: 'Context Precision', accessor: 'contextPrecision', width: '8%', render: (row) => <span className="tnum">{formatMetric(row.contextPrecision)}</span> },
    { header: 'PII Leakage', accessor: 'piiLeakage', width: '8%', render: (row) => <span className="tnum">{formatLeakageMetric(row.piiLeakage)}</span> },
    { header: 'Status', accessor: 'evaluationStatus', width: '9%', render: (row) => <StatusPill label={(row.evaluationStatus || 'unknown').toUpperCase()} tone={getStatusTone(row.evaluationStatus)} /> },
    { header: 'Actions', accessor: 'action', width: '9%', render: (row) => <button onClick={(e) => { e.stopPropagation(); loadDetail(row.requestId); }} className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-accent">View <ChevronRight size={14} /></button> },
  ];

  return (
    <div className="space-y-4">
      <section className="space-y-4">
        <div className="card grid grid-cols-2 gap-x-4 gap-y-5 p-4 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-line">
          <MetricCard title="Total Evaluations" value={stats?.totalEvaluations ?? '—'} caption="All saved" />
          <div className="pl-4"><MetricCard title="Faithfulness" value={stats ? formatPercent(stats.avgFaithfulness) : '—'} /></div>
          <div className="pl-4"><MetricCard title="Answer Relevancy" value={stats ? formatPercent(stats.avgAnswerRelevancy) : '—'} /></div>
          <div className="pl-4"><MetricCard title="Context Precision" value={stats ? formatPercent(stats.avgContextPrecision) : '—'} /></div>
          <div className="pl-4"><MetricCard title="Context Recall" value={stats ? formatPercent(stats.avgContextRecall) : '—'} /></div>
          <div className="pl-4"><MetricCard title="PII Leakage" value={stats ? formatLeakagePercent(stats.avgPiiLeakage) : '—'} /></div>
        </div>

        <div className="card overflow-hidden p-3">
          <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-1 items-center gap-2">
              <SearchBox value={search} onChange={setSearch} placeholder="Search evaluations" />
              <button onClick={() => loadData({ showLoader: false, refresh: true })} disabled={refreshing} className="inline-flex items-center justify-center rounded-lg border border-line bg-surface p-2.5 text-muted transition hover:border-accent hover:text-accent disabled:opacity-60">
                <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
          </div>

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
              <DataTable columns={columns} rows={filteredRows} onRowClick={(row) => loadDetail(row.requestId)} fit maxHeight="380px" />
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
                    ['Faithfulness', detail.faithfulness, detail.faithfulnessReason, formatMetric],
                    ['Answer Relevancy', detail.answerRelevancy, detail.answerRelevancyReason, formatMetric],
                    ['Context Precision', detail.contextPrecision, detail.contextPrecisionReason, formatMetric],
                    ['Context Recall', detail.contextRecall, detail.contextRecallReason, formatMetric],
                    ['PII Leakage', detail.piiLeakage, detail.piiLeakageReason, formatLeakageMetric],
                  ].map(([label, value, reason, format]) => (
                    <div key={label} className="border-b border-line pb-2 last:border-0 last:pb-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted">{label}</span>
                        <span className="tnum font-semibold">{format(value)}</span>
                      </div>
                      {reason && <p className="mt-1 text-xs leading-relaxed text-muted">{reason}</p>}
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg bg-surface-muted p-3">
                <p className="text-[10px] uppercase tracking-[0.24em] text-muted">LLM Response</p>
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
                <pre className="mt-2 whitespace-pre-wrap text-sm text-ink">{JSON.stringify(omitTimings(detail.metadata), null, 2)}</pre>
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
