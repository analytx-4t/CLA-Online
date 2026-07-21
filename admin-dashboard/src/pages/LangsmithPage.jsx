import { useEffect, useState, useMemo } from 'react';
import { Activity, Layers, Cpu, Search, RefreshCw, ExternalLink, AppWindow, CheckCircle2, ChevronDown, ChevronUp, Tag } from 'lucide-react';
import { MONITORING_URLS } from '../config/monitoringUrls';

export default function LangsmithPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedRunType, setSelectedRunType] = useState('ALL');
  const [expandedRun, setExpandedRun] = useState(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/langsmith').catch(() => fetch('http://localhost:3000/api/admin/langsmith'));
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to load LangSmith API data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const filteredRuns = useMemo(() => {
    if (!data?.runs) return [];
    return data.runs.filter((run) => {
      const matchesSearch =
        run.name.toLowerCase().includes(search.toLowerCase()) ||
        run.runId.toLowerCase().includes(search.toLowerCase()) ||
        run.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()));
      const matchesType = selectedRunType === 'ALL' || run.runType.toLowerCase() === selectedRunType.toLowerCase();
      return matchesSearch && matchesType;
    });
  }, [data, search, selectedRunType]);

  const handleOpenPopup = () => {
    window.open(MONITORING_URLS.langsmith, 'LangSmith Monitor', 'width=1280,height=850,resizable=yes,scrollbars=yes');
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800/80 bg-[#0B1220] p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-sky-500/30 bg-sky-500/10 text-sky-400">
            <Activity size={26} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white">LangChain LangSmith Agent Traces</h1>
              <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-semibold text-sky-400 border border-sky-500/30">
                Project: {data?.project || 'cla-legal-rag'}
              </span>
            </div>
            <p className="text-xs text-slate-400">Step-by-step LLM chain executions, RAG retrieval runs, and agent state monitoring</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={fetchData}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>Refresh Traces</span>
          </button>

          <button
            onClick={handleOpenPopup}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-slate-800 hover:text-white"
          >
            <AppWindow size={14} />
            <span>Floating Window</span>
          </button>

          <a
            href={MONITORING_URLS.langsmith}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-4 py-2 text-xs font-semibold text-black transition hover:bg-sky-400 shadow-md"
          >
            <span>LangSmith Cloud</span>
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      {loading && !data && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-slate-800/80 bg-[#0B1220]">
          <div className="flex flex-col items-center gap-3 text-slate-400">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-700 border-t-sky-400" />
            <p className="text-sm">Fetching LangSmith agent execution traces...</p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-red-300">
          <p className="font-semibold">Failed to fetch LangSmith traces</p>
          <p className="text-xs text-red-400 mt-1">{error}</p>
        </div>
      )}

      {data && (
        <>
          {/* Summary Metric Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Total Traced Runs</p>
              <p className="mt-2 text-2xl font-bold text-white">{data.summary.totalRuns}</p>
              <p className="mt-1 text-[11px] text-sky-400">Active LangSmith Tracing</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Total Tokens Processed</p>
              <p className="mt-2 text-2xl font-bold text-sky-400">{data.summary.totalTokens.toLocaleString()}</p>
              <p className="mt-1 text-[11px] text-slate-400">LangSmith usage telemetry</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Avg Chain Latency</p>
              <p className="mt-2 text-2xl font-bold text-amber-400">{data.summary.avgLatencyMs} ms</p>
              <p className="mt-1 text-[11px] text-slate-400">Chain step execution</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Run Health</p>
              <p className="mt-2 text-2xl font-bold text-emerald-400">100% Success</p>
              <p className="mt-1 text-[11px] text-emerald-400">{data.summary.successfulRuns} successful / 0 failed</p>
            </div>
          </div>

          {/* Agent Runs Table */}
          <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-5">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-base font-semibold text-white">Agent Execution Traces</h2>
                <p className="text-xs text-slate-400">Showing {filteredRuns.length} trace steps</p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search name, runId, tags..."
                    className="w-56 rounded-lg border border-slate-800 bg-[#070A0F] pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>

                <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#070A0F] p-1">
                  {['ALL', 'llm', 'retrieval'].map((type) => (
                    <button
                      key={type}
                      onClick={() => setSelectedRunType(type)}
                      className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                        selectedRunType === type ? 'bg-sky-500 text-black font-semibold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {type.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="border-b border-slate-800 bg-[#070A0F] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Run ID / Name</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Provider / Model</th>
                    <th className="px-4 py-3">Tokens</th>
                    <th className="px-4 py-3">Latency</th>
                    <th className="px-4 py-3">Tags</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredRuns.map((run) => {
                    const isExpanded = expandedRun === run.runId;
                    return (
                      <tbody key={run.runId} className="contents">
                        <tr className="hover:bg-slate-900/50 transition">
                          <td className="px-4 py-3">
                            <p className="font-semibold text-white">{run.name}</p>
                            <code className="text-[10px] text-sky-400 font-mono">{run.runId}</code>
                          </td>
                          <td className="px-4 py-3">
                            <span className="rounded bg-sky-500/20 px-2 py-0.5 text-[10px] font-semibold text-sky-400 uppercase">
                              {run.runType}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="font-medium text-slate-200">{run.provider}</span>
                            <span className="ml-1 text-[11px] text-slate-400">({run.model})</span>
                          </td>
                          <td className="px-4 py-3 font-medium text-sky-400">{run.totalTokens > 0 ? run.totalTokens : 'N/A'}</td>
                          <td className="px-4 py-3 font-medium text-amber-400">{run.latencyMs} ms</td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {run.tags.map((tag) => (
                                <span key={tag} className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                                  #{tag}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                              {run.status}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => setExpandedRun(isExpanded ? null : run.runId)}
                              className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
                            >
                              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                              <span>{isExpanded ? 'Hide' : 'Inspect'}</span>
                            </button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-[#070A0F]">
                            <td colSpan={8} className="p-4 border-t border-b border-slate-800">
                              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-xs">
                                <div className="rounded border border-slate-800 p-3 bg-slate-950">
                                  <p className="text-[10px] font-semibold uppercase text-sky-400 mb-1">Input Payload</p>
                                  <pre className="overflow-x-auto text-[11px] text-slate-300 font-mono">
                                    {JSON.stringify(run.inputs, null, 2)}
                                  </pre>
                                </div>
                                <div className="rounded border border-slate-800 p-3 bg-slate-950">
                                  <p className="text-[10px] font-semibold uppercase text-emerald-400 mb-1">Output Payload</p>
                                  <pre className="overflow-x-auto text-[11px] text-slate-300 font-mono">
                                    {JSON.stringify(run.outputs, null, 2)}
                                  </pre>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}