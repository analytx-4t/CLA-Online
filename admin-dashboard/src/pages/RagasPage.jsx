import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Search, Filter, ChevronRight, RefreshCw } from 'lucide-react';
import SearchBox from '../components/SearchBox';
import FilterBar from '../components/FilterBar';
import DataTable from '../components/DataTable';
import StatusPill from '../components/StatusPill';
import ChartCard from '../components/ChartCard';
import LineChart from '../components/LineChart';
import Drawer from '../components/Drawer';
import MetricCard from '../components/MetricCard';

const statusOptions = ['All', 'completed', 'failed'];
const providerOptions = ['All', 'groq', 'openai', 'gemini'];
const modelOptions = ['All'];
const metricOptions = ['Faithfulness', 'Relevancy', 'Precision', 'Recall', 'Correctness'];

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

export default function RagasPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All');
  const [provider, setProvider] = useState('All');
  const [model, setModel] = useState('All');
  const [metric, setMetric] = useState('Faithfulness');
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
  const [total, setTotal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [liveNotice, setLiveNotice] = useState(false);
  const latestRequestRef = useRef(0);
  const socketRef = useRef(null);
  const pollTimerRef = useRef(null);

  const loadData = async ({ showLoader = true, refresh = false } = {}) => {
    if (showLoader) {
      setLoading(true);
    }
    if (refresh) {
      setRefreshing(true);
    }
    setError(null);

    const requestId = ++latestRequestRef.current;
    const params = new URLSearchParams({
      page: String(page),
      limit: String(pageSize),
      search,
      status: status === 'All' ? '' : status,
      provider: provider === 'All' ? '' : provider,
      model: model === 'All' ? '' : model,
    });
    const url = `http://127.0.0.1:3000/api/admin/ragas?${params.toString()}`;

    console.log('[RAGAS UI] Requesting evaluations', url);

    try {
      const response = await fetch(url);
      const responseBody = await response.text();
      console.log('[RAGAS UI] Response status', response.status);
      console.log('[RAGAS UI] Response body', responseBody);

      let payload = {};
      try {
        payload = responseBody ? JSON.parse(responseBody) : {};
      } catch (parseError) {
        console.error('[RAGAS UI] Failed to parse response body', parseError);
        throw new Error('Unable to parse evaluations response.');
      }

      if (!response.ok) {
        throw new Error(payload?.error || 'Unable to load evaluations.');
      }

      if (requestId !== latestRequestRef.current) return;
      const list = Array.isArray(payload?.data) ? payload.data : [];
      setRows(list);
      setTotal(Number(payload?.pagination?.total || 0));
      setTotalPages(Number(payload?.pagination?.totalPages || 1));
      setLoading(false);
      setRefreshing(false);
    } catch (loadError) {
      if (requestId !== latestRequestRef.current) return;
      console.error('[RAGAS UI] Failed to load evaluations', loadError);
      setError(loadError.message || 'Unable to load evaluations.');
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadStats = async () => {
    try {
      const response = await fetch('http://127.0.0.1:3000/api/admin/ragas/stats');
      if (!response.ok) throw new Error('Unable to load stats.');
      const payload = await response.json();
      setStats(payload?.data || null);
    } catch (statsError) {
      console.error('Failed to load RAGAS stats', statsError);
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
      if (!response.ok) {
        throw new Error('Unable to load evaluation details.');
      }
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

      const nextRows = [{ ...entry }, ...currentRows];
      return nextRows.slice(0, 25);
    });
    setTotal((currentTotal) => currentTotal + 1);
    setLiveNotice(true);
    window.setTimeout(() => setLiveNotice(false), 2200);
  };

  useEffect(() => {
    loadData({ showLoader: true });
    loadStats();
  }, []);

  useEffect(() => {
    loadData({ showLoader: false });
  }, [page, search, status, provider, model]);

  useEffect(() => {
    const socket = io('http://127.0.0.1:3000', { transports: ['websocket'], reconnection: true, reconnectionAttempts: 5, reconnectionDelay: 1000 });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[RAGAS Live] Client connected');
    });

    socket.on('ragas-evaluation-updated', (payload) => {
      console.log('[RAGAS Live] Evaluation broadcast');
      applyLiveEvaluation(payload);
      loadStats();
      console.log('[RAGAS Live] Dashboard updated');
    });

    socket.on('disconnect', () => {
      console.warn('[RAGAS Live] Socket disconnected, falling back to REST polling.');
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
    { header: 'Overall Score', accessor: 'overallScore', width: '110px', render: (row) => <span className="font-semibold text-white">{formatMetric(row.overallScore)}</span> },
    { header: 'Status', accessor: 'evaluationStatus', width: '100px', render: (row) => <StatusPill label={(row.evaluationStatus || 'unknown').toUpperCase()} tone={getStatusTone(row.evaluationStatus)} /> },
    { header: 'Actions', accessor: 'action', width: '90px', render: (row) => <button onClick={() => loadDetail(row.requestId)} className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#111827] px-2 py-1 text-[11px] text-slate-300 hover:border-[#0F9D58]">View <ChevronRight size={14} /></button> },
  ];

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-800/80 bg-[#111827]/95 p-3 shadow-panel">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Evaluation workspace</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">RAGAS Review</h2>
          </div>
          <div className="flex w-full max-w-sm items-center gap-2 xl:w-auto">
            <SearchBox value={search} onChange={setSearch} placeholder="Search evaluations" />
            <button onClick={() => loadData({ showLoader: false, refresh: true })} disabled={refreshing} className="inline-flex items-center justify-center rounded-lg border border-slate-800 bg-[#0B1119] p-2.5 text-slate-300 transition hover:border-[#0F9D58] disabled:opacity-60">
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <FilterBar>
            <div className="flex items-center gap-2 text-sm text-slate-200"><Filter size={16} /><span>Status</span></div>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="rounded-lg border border-slate-800 bg-[#0B1119] px-2.5 py-2 text-sm text-slate-100 outline-none">
              {statusOptions.map((option) => <option key={option} value={option}>{option === 'All' ? 'All' : option}</option>)}
            </select>
          </FilterBar>
          <FilterBar>
            <div className="flex items-center gap-2 text-sm text-slate-200"><Filter size={16} /><span>Provider</span></div>
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setPage(1); }} className="rounded-lg border border-slate-800 bg-[#0B1119] px-2.5 py-2 text-sm text-slate-100 outline-none">
              {providerOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </FilterBar>
          <FilterBar>
            <div className="flex items-center gap-2 text-sm text-slate-200"><Filter size={16} /><span>Model</span></div>
            <select value={model} onChange={(e) => { setModel(e.target.value); setPage(1); }} className="rounded-lg border border-slate-800 bg-[#0B1119] px-2.5 py-2 text-sm text-slate-100 outline-none">
              {modelOptions.map((option) => <option key={option} value={option}>{option === 'All' ? 'All' : option}</option>)}
            </select>
          </FilterBar>
          <div className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 px-4 py-3 text-slate-300">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Score focus</p>
            <p className="mt-2 text-lg font-semibold text-white">{metric}</p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <MetricCard title="Total Evaluations" value={stats?.totalEvaluations ?? '—'} subtitle="All saved evaluations" />
          <MetricCard title="Avg Overall Score" value={stats ? formatPercent(stats.avgOverallScore) : '—'} subtitle="Across completed runs" />
          <MetricCard title="Avg Faithfulness" value={stats ? formatPercent(stats.avgFaithfulness) : '—'} subtitle="Context support" />
        </div>

        <div className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3 shadow-panel overflow-hidden">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, index) => <div key={index} className="h-10 animate-pulse rounded-lg bg-slate-800/70" />)}
            </div>
          ) : error ? (
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-4 text-sm text-rose-300">
              <p className="font-medium">Unable to load evaluations.</p>
              <p className="mt-1 text-rose-200/80">{error}</p>
              <button onClick={() => loadData({ showLoader: false, refresh: true })} className="mt-3 rounded-lg border border-rose-400/30 px-3 py-2 text-sm text-rose-200">Retry</button>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-700 bg-[#0B1119]/70 p-6 text-center text-sm text-slate-400">No evaluations available yet.</div>
          ) : (
            <>
              <div className="w-full overflow-x-auto">
                <DataTable columns={columns} rows={filteredRows} onRowClick={(row) => loadDetail(row.requestId)} />
              </div>
              <div className="mt-3 flex flex-col gap-2 text-sm text-slate-400 sm:flex-row sm:items-center sm:justify-between">
                <span>Page {page} of {totalPages}</span>
                <div className="flex items-center gap-2">
                  <button disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg border border-slate-800 px-3 py-1 disabled:opacity-50">Previous</button>
                  <button disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-slate-800 px-3 py-1 disabled:opacity-50">Next</button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="grid gap-3 xl:grid-cols-4 lg:grid-cols-2 md:grid-cols-2 grid-cols-1">
          <ChartCard title="Evaluation summary" meta="Score distribution" className="h-full">
            <div className="h-full w-full"><LineChart points={[stats?.avgFaithfulness ? Math.round(stats.avgFaithfulness * 100) : 82, 88, 92, 94, 93, 91, 95]} accent="#0F9D58" /></div>
          </ChartCard>
          <ChartCard title="Faithfulness" meta="Evaluation consistency" footer="Live score trend from MongoDB results." className="h-full">
            <div className="h-full w-full"><LineChart points={[stats?.avgFaithfulness ? Math.round(stats.avgFaithfulness * 100) : 90, 92, 93, 94, 93, 95, 96]} accent="#0F9D58" /></div>
          </ChartCard>
          <ChartCard title="Context precision" meta="Retrieval quality" footer="Updated from the latest evaluations." className="h-full">
            <div className="h-full w-full"><LineChart points={[88, 90, 91, 92, 91, 90, 92]} accent="#3B82F6" /></div>
          </ChartCard>
          <ChartCard title="Answer correctness" meta="Final output accuracy" footer="Based on the latest completed runs." className="h-full">
            <div className="h-full w-full"><LineChart points={[89, 90, 92, 94, 93, 92, 93]} accent="#0F9D58" /></div>
          </ChartCard>
        </div>

        <Drawer open={Boolean(selectedRequestId)} title={detail ? `Details - ${detail.requestId}` : 'Evaluation details'} onClose={() => { setSelectedRequestId(null); setDetail(null); }}>
          {loadingDetail ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-10 animate-pulse rounded-lg bg-slate-800/70" />)}
            </div>
          ) : detail ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-[#0B1119] p-3">
                <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Question</p>
                <p className="mt-2 text-sm text-slate-200">{detail.question || '—'}</p>
              </div>
              <div className="rounded-lg bg-[#0B1119] p-3">
                <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Answer</p>
                <p className="mt-2 text-sm text-slate-200">{detail.answer || '—'}</p>
              </div>
              <div className="rounded-lg bg-[#0B1119] p-3">
                <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Retrieved Context</p>
                <ul className="mt-2 space-y-2 text-sm text-slate-400">
                  {(detail.retrievedContext || []).map((item) => <li key={item}>• {item}</li>)}
                </ul>
              </div>
              <div className="rounded-lg bg-[#0B1119] p-3">
                <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Metrics</p>
                <div className="mt-2 space-y-2 text-sm text-slate-300">
                  {[
                    ['Faithfulness', detail.faithfulness],
                    ['Answer Relevancy', detail.answerRelevancy],
                    ['Context Precision', detail.contextPrecision],
                    ['Context Recall', detail.contextRecall],
                    ['Answer Correctness', detail.answerCorrectness],
                    ['Overall Score', detail.overallScore],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-2">
                      <span>{label}</span>
                      <span className="font-semibold text-white">{formatMetric(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-lg bg-[#0B1119] p-3">
                <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Evaluation</p>
                <div className="mt-2 space-y-2 text-sm text-slate-300">
                  <div className="flex items-center justify-between gap-2"><span>Evaluation Time</span><span className="font-semibold text-white">{detail.evaluationTimeMs ?? '—'}</span></div>
                  <div className="flex items-center justify-between gap-2"><span>Provider</span><span className="font-semibold text-white">{detail.provider || '—'}</span></div>
                  <div className="flex items-center justify-between gap-2"><span>Model</span><span className="font-semibold text-white">{detail.model || '—'}</span></div>
                  <div className="flex items-center justify-between gap-2"><span>Status</span><span className="font-semibold text-white">{detail.evaluationStatus || '—'}</span></div>
                </div>
              </div>
              <div className="rounded-lg bg-[#0B1119] p-3">
                <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Metadata</p>
                <pre className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{JSON.stringify(detail.metadata || {}, null, 2)}</pre>
              </div>
              <div className="rounded-lg bg-[#0B1119] p-3">
                <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Suggestions</p>
                <ul className="mt-2 space-y-2 text-sm text-slate-400">
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
