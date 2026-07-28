import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { 
  Filter, 
  ChevronRight, 
  RefreshCw, 
  ShieldCheck, 
  Sparkles, 
  Database, 
  Cpu, 
  Award, 
  ChevronDown, 
  ChevronUp, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  Layers 
} from 'lucide-react';
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

function formatPercentVal(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return 'N/A';
  return `${(Number(val) * 100).toFixed(0)}%`;
}

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
  if (status === 'completed' || status === 'passed') return 'success';
  if (status === 'blocked') return 'warning';
  return 'neutral';
}

function omitTimings(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  const { retrievalTime, llmTime, tokenUsage, ...rest } = metadata;
  return rest;
}

function ServerLogsTimeline({ logs }) {
  const [expandedSteps, setExpandedSteps] = useState({ 1: true, 2: true, 3: true, 4: true, 5: true });

  if (!logs || logs.length === 0) {
    return <p className="text-xs text-muted p-4">No step-by-step agent logs recorded for this query.</p>;
  }

  const toggleStep = (stepNum) => {
    setExpandedSteps((prev) => ({ ...prev, [stepNum]: !prev[stepNum] }));
  };

  const getStepIcon = (step) => {
    switch (step) {
      case 1: return <ShieldCheck className="h-4 w-4 text-emerald-500" />;
      case 2: return <Sparkles className="h-4 w-4 text-blue-500" />;
      case 3: return <Database className="h-4 w-4 text-amber-500" />;
      case 4: return <Cpu className="h-4 w-4 text-purple-500" />;
      case 5: return <Award className="h-4 w-4 text-teal-500" />;
      default: return <Layers className="h-4 w-4 text-muted" />;
    }
  };

  const getStatusBadge = (status) => {
    if (status === 'completed' || status === 'passed') {
      return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-500"><CheckCircle2 className="h-3 w-3" /> PASSED</span>;
    }
    if (status === 'blocked') {
      return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-500"><AlertTriangle className="h-3 w-3" /> BLOCKED</span>;
    }
    return <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-500">FAILED</span>;
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3 text-xs leading-relaxed text-ink">
        <p className="font-semibold text-indigo-400 flex items-center gap-1.5">
          <Sparkles className="h-4 w-4" /> Backend Execution Summary
        </p>
        <p className="mt-1 text-muted">
          This timeline presents the complete backend logs step-by-step—including guardrails evaluation, query expansion, database/cache retrieval, legal response synthesis, and audit scoring.
        </p>
      </div>

      <div className="relative border-l-2 border-line pl-4 space-y-4 my-2">
        {logs.map((log) => {
          const isOpen = Boolean(expandedSteps[log.step]);
          return (
            <div key={log.step} className="relative">
              {/* Step Icon */}
              <div className="absolute -left-[25px] top-1 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface shadow-sm">
                {getStepIcon(log.step)}
              </div>

              <div className="rounded-lg border border-line bg-surface p-3 shadow-panel">
                {/* Header */}
                <div 
                  onClick={() => toggleStep(log.step)}
                  className="flex cursor-pointer items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-ink">{log.title || `Step ${log.step}`}</span>
                    {getStatusBadge(log.status)}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    {log.timeMs !== undefined && log.timeMs !== null && (
                      <span className="inline-flex items-center gap-1 rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10px]">
                        <Clock className="h-3 w-3" /> {log.timeMs} ms
                      </span>
                    )}
                    {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </div>

                {/* Easy English Summary */}
                <p className="mt-2 text-xs leading-relaxed text-ink font-medium">
                  {log.summary}
                </p>

                {/* Agent Badges */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                  <span className="rounded bg-surface-strong px-2 py-0.5 text-muted font-medium">Agent: {log.agent}</span>
                  {log.provider && (
                    <span className="rounded bg-surface-strong px-2 py-0.5 text-muted font-mono">
                      {log.provider} {log.model ? `/ ${log.model}` : ''}
                    </span>
                  )}
                </div>

                {/* Expanded Flow Parameters */}
                {isOpen && log.details && (
                  <div className="mt-3 rounded-md border border-line bg-surface-muted p-2.5 text-xs space-y-2">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted">Technical Data & Flow Parameters</p>

                    {log.details.originalQuery && (
                      <div>
                        <span className="text-muted font-medium">Original Query: </span>
                        <span className="text-ink">{log.details.originalQuery}</span>
                      </div>
                    )}
                    {log.details.expandedQuery && (
                      <div>
                        <span className="text-muted font-medium">Expanded Query: </span>
                        <span className="text-ink font-semibold">{log.details.expandedQuery}</span>
                      </div>
                    )}
                    {Array.isArray(log.details.keywords) && log.details.keywords.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-muted font-medium">Keywords: </span>
                        {log.details.keywords.map((kw, i) => (
                          <span key={i} className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-indigo-400 border border-indigo-500/20">{kw}</span>
                        ))}
                      </div>
                    )}
                    {log.details.retrievalQuery && (
                      <div>
                        <span className="text-muted font-medium">Retrieval Query: </span>
                        <span className="font-mono text-[11px] text-ink">{log.details.retrievalQuery}</span>
                      </div>
                    )}
                    {log.details.candidatesFound !== undefined && (
                      <div className="flex gap-3 text-muted">
                        <span>Candidates: <strong className="text-ink">{log.details.candidatesFound}</strong></span>
                        <span>Top Reranked Sources: <strong className="text-ink">{log.details.topRerankedCount}</strong></span>
                      </div>
                    )}
                    {Array.isArray(log.details.topSourcesPreview) && log.details.topSourcesPreview.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-muted font-medium">Top Sources Preview:</span>
                        {log.details.topSourcesPreview.map((src, i) => (
                          <div key={i} className="rounded bg-surface p-1.5 text-[11px] text-muted border border-line">
                            <span className="font-bold text-indigo-400">Source [{src.rank}]: </span>
                            {src.title ? <span>{src.title} — </span> : null}
                            <span>{src.snippet || src.sections}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {log.details.sourcesUsed !== undefined && (
                      <div className="flex gap-3 text-muted">
                        <span>Sources Used: <strong className="text-ink">{log.details.sourcesUsed}</strong></span>
                        <span>Suggestions: <strong className="text-ink">{log.details.suggestionsGenerated}</strong></span>
                        <span>Answer Length: <strong className="text-ink">{log.details.answerLength} chars</strong></span>
                      </div>
                    )}
                    {log.details.faithfulness !== undefined && (
                      <div className="grid grid-cols-2 gap-2 pt-1.5 border-t border-line text-[11px]">
                        <div>Faithfulness: <strong className="text-emerald-500">{formatPercentVal(log.details.faithfulness)}</strong></div>
                        <div>Answer Relevancy: <strong className="text-emerald-500">{formatPercentVal(log.details.answerRelevancy)}</strong></div>
                        <div>Context Precision: <strong className="text-emerald-500">{formatPercentVal(log.details.contextPrecision)}</strong></div>
                        <div>Context Recall: <strong className="text-emerald-500">{formatPercentVal(log.details.contextRecall)}</strong></div>
                        <div>PII Protection: <strong className="text-emerald-500">{formatPercentVal(1 - (log.details.piiLeakage ?? 0))}</strong></div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
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
  const [drawerTab, setDrawerTab] = useState('logs');
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
    const url = `/api/admin/ragas?${params.toString()}`;

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
      const response = await fetch('/api/admin/ragas/stats');
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
    setDrawerTab('logs');
    try {
      const response = await fetch(`/api/admin/ragas/${requestId}`);
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
    const socket = io('/', { transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });
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

  const columns = [
    { header: 'Timestamp', accessor: 'timestamp', width: '12%', render: (row) => formatTimestamp(row.timestamp) },
    { header: 'Question', accessor: 'question', width: '22%', render: (row) => row.question || '—' },
    { header: 'Model', accessor: 'model', width: '10%', render: (row) => row.model || '—' },
    { header: 'Faithfulness', accessor: 'faithfulness', width: '8%', render: (row) => <span className="tnum">{formatMetric(row.faithfulness)}</span> },
    { header: 'Answer Relevancy', accessor: 'answerRelevancy', width: '8%', render: (row) => <span className="tnum">{formatMetric(row.answerRelevancy)}</span> },
    { header: 'Context Recall', accessor: 'contextRecall', width: '8%', render: (row) => <span className="tnum">{formatMetric(row.contextRecall)}</span> },
    { header: 'Context Precision', accessor: 'contextPrecision', width: '8%', render: (row) => <span className="tnum">{formatMetric(row.contextPrecision)}</span> },
    { header: 'PII Leakage', accessor: 'piiLeakage', width: '8%', render: (row) => <span className="tnum">{formatLeakageMetric(row.piiLeakage)}</span> },
    { header: 'Status', accessor: 'evaluationStatus', width: '8%', render: (row) => <StatusPill label={(row.evaluationStatus || 'unknown').toUpperCase()} tone={getStatusTone(row.evaluationStatus)} /> },
    { header: 'Actions', accessor: 'action', width: '8%', render: (row) => <button onClick={(e) => { e.stopPropagation(); loadDetail(row.requestId); }} className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-accent">View <ChevronRight size={14} /></button> },
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
              <DataTable columns={columns} rows={rows} onRowClick={(row) => loadDetail(row.requestId)} fit maxHeight="380px" />
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
              {/* Tab navigation */}
              <div className="flex border-b border-line pb-1">
                <button
                  onClick={() => setDrawerTab('logs')}
                  className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold transition ${
                    drawerTab === 'logs'
                      ? 'border-indigo-500 text-indigo-400'
                      : 'border-transparent text-muted hover:text-ink'
                  }`}
                >
                  <Layers className="h-3.5 w-3.5" />
                  Backend Logs ({detail.serverLogs?.length || 0})
                </button>
                <button
                  onClick={() => setDrawerTab('overview')}
                  className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-semibold transition ${
                    drawerTab === 'overview'
                      ? 'border-indigo-500 text-indigo-400'
                      : 'border-transparent text-muted hover:text-ink'
                  }`}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Overview & Details
                </button>
              </div>

              {drawerTab === 'logs' ? (
                <ServerLogsTimeline logs={detail.serverLogs} />
              ) : (
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
              )}
            </div>
          ) : null}
        </Drawer>
      </section>
    </div>
  );
}
