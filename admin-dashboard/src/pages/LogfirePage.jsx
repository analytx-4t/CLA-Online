import { useEffect, useState, useMemo } from 'react';
import { Flame, Terminal, Search, RefreshCw, ExternalLink, AppWindow, CheckCircle2, ChevronDown, ChevronUp, AlertCircle, Info, ShieldAlert } from 'lucide-react';
import { MONITORING_URLS } from '../config/monitoringUrls';

export default function LogfirePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedLevel, setSelectedLevel] = useState('ALL');
  const [expandedLog, setExpandedLog] = useState(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/logfire').catch(() => fetch('http://localhost:3000/api/admin/logfire'));
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to load Logfire API data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const filteredLogs = useMemo(() => {
    if (!data?.logs) return [];
    return data.logs.filter((log) => {
      const matchesSearch =
        log.spanName.toLowerCase().includes(search.toLowerCase()) ||
        log.message.toLowerCase().includes(search.toLowerCase()) ||
        JSON.stringify(log.attributes).toLowerCase().includes(search.toLowerCase());
      const matchesLevel = selectedLevel === 'ALL' || log.level.toUpperCase() === selectedLevel.toUpperCase();
      return matchesSearch && matchesLevel;
    });
  }, [data, search, selectedLevel]);

  const handleOpenPopup = () => {
    window.open(MONITORING_URLS.logfire, 'Logfire Monitor', 'width=1280,height=850,resizable=yes,scrollbars=yes');
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800/80 bg-[#0B1220] p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-orange-500/30 bg-orange-500/10 text-orange-400">
            <Flame size={26} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white">Pydantic Logfire OpenTelemetry</h1>
              <span className="rounded-full bg-orange-500/15 px-2.5 py-0.5 text-xs font-semibold text-orange-400 border border-orange-500/30">
                Service: {data?.serviceName || 'cla-legal-rag-backend'} v{data?.serviceVersion || '1.0.0'}
              </span>
            </div>
            <p className="text-xs text-slate-400">System tracing, Python RAG search timing, NeMo guardrail spans, and server logs</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={fetchData}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>Refresh Telemetry</span>
          </button>

          <button
            onClick={handleOpenPopup}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-slate-800 hover:text-white"
          >
            <AppWindow size={14} />
            <span>Floating Window</span>
          </button>

          <a
            href={MONITORING_URLS.logfire}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-4 py-2 text-xs font-semibold text-black transition hover:bg-orange-400 shadow-md"
          >
            <span>Logfire Cloud</span>
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      {loading && !data && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-slate-800/80 bg-[#0B1220]">
          <div className="flex flex-col items-center gap-3 text-slate-400">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-700 border-t-orange-400" />
            <p className="text-sm">Fetching Logfire OpenTelemetry stream...</p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-red-300">
          <p className="font-semibold">Failed to fetch Logfire telemetry</p>
          <p className="text-xs text-red-400 mt-1">{error}</p>
        </div>
      )}

      {data && (
        <>
          {/* Summary Metric Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Total Telemetry Events</p>
              <p className="mt-2 text-2xl font-bold text-white">{data.summary.totalEvents}</p>
              <p className="mt-1 text-[11px] text-orange-400">Structured OpenTelemetry</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Info Events</p>
              <p className="mt-2 text-2xl font-bold text-sky-400">{data.summary.infoCount}</p>
              <p className="mt-1 text-[11px] text-slate-400">Normal system execution</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Warning Spans</p>
              <p className="mt-2 text-2xl font-bold text-amber-400">{data.summary.warnCount}</p>
              <p className="mt-1 text-[11px] text-slate-400">Soft threshold warnings</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Error Events</p>
              <p className="mt-2 text-2xl font-bold text-emerald-400">{data.summary.errorCount}</p>
              <p className="mt-1 text-[11px] text-emerald-400">0 critical failures</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Avg RAG Search Time</p>
              <p className="mt-2 text-2xl font-bold text-purple-400">{data.summary.avgSearchDurationMs} ms</p>
              <p className="mt-1 text-[11px] text-slate-400">Python FastEmbed + BM25</p>
            </div>
          </div>

          {/* Log Stream Table */}
          <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-5">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-base font-semibold text-white">Logfire OpenTelemetry Event Stream</h2>
                <p className="text-xs text-slate-400">Showing {filteredLogs.length} events</p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search span, message, attributes..."
                    className="w-56 rounded-lg border border-slate-800 bg-[#070A0F] pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-orange-500 focus:outline-none"
                  />
                </div>

                <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#070A0F] p-1">
                  {['ALL', 'INFO', 'WARN', 'ERROR'].map((lvl) => (
                    <button
                      key={lvl}
                      onClick={() => setSelectedLevel(lvl)}
                      className={`rounded px-2 py-1 text-xs font-medium transition ${
                        selectedLevel === lvl ? 'bg-orange-500 text-black font-semibold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {lvl}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="border-b border-slate-800 bg-[#070A0F] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Timestamp</th>
                    <th className="px-4 py-3">Level</th>
                    <th className="px-4 py-3">Span Name</th>
                    <th className="px-4 py-3">Message</th>
                    <th className="px-4 py-3">Duration</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {filteredLogs.map((log, index) => {
                    const logId = `${log.timestamp}_${index}`;
                    const isExpanded = expandedLog === logId;
                    return (
                      <tbody key={logId} className="contents">
                        <tr className="hover:bg-slate-900/50 transition">
                          <td className="px-4 py-3 text-slate-400 text-[11px]">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </td>
                          <td className="px-4 py-3">
                            {log.level === 'INFO' && (
                              <span className="rounded bg-sky-500/20 px-2 py-0.5 text-[10px] font-semibold text-sky-400">
                                INFO
                              </span>
                            )}
                            {log.level === 'WARN' && (
                              <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
                                WARN
                              </span>
                            )}
                            {log.level === 'ERROR' && (
                              <span className="rounded bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold text-red-400">
                                ERROR
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-semibold text-white">{log.spanName}</td>
                          <td className="px-4 py-3 text-slate-300 max-w-md truncate">{log.message}</td>
                          <td className="px-4 py-3 text-amber-400">{log.durationMs ? `${log.durationMs} ms` : '—'}</td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => setExpandedLog(isExpanded ? null : logId)}
                              className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
                            >
                              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                              <span>{isExpanded ? 'Hide' : 'Inspect'}</span>
                            </button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-[#070A0F]">
                            <td colSpan={6} className="p-4 border-t border-b border-slate-800">
                              <div className="rounded border border-slate-800 p-3 bg-slate-950">
                                <p className="text-[10px] font-semibold uppercase text-orange-400 mb-1">Span Context & Attributes</p>
                                <pre className="overflow-x-auto text-[11px] text-slate-300 font-mono">
                                  {JSON.stringify(log.attributes, null, 2)}
                                </pre>
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