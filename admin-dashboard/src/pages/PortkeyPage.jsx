import { useEffect, useState, useMemo } from 'react';
import { ShieldCheck, Activity, Cpu, Zap, DollarSign, Search, Filter, RefreshCw, ExternalLink, AppWindow, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';
import { MONITORING_URLS } from '../config/monitoringUrls';

export default function PortkeyPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedProvider, setSelectedProvider] = useState('ALL');
  const [expandedRow, setExpandedRow] = useState(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/portkey').catch(() => fetch('http://localhost:3000/api/admin/portkey'));
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to load Portkey API data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const filteredLogs = useMemo(() => {
    if (!data?.recentLogs) return [];
    return data.recentLogs.filter((log) => {
      const matchesSearch =
        log.requestId.toLowerCase().includes(search.toLowerCase()) ||
        log.model.toLowerCase().includes(search.toLowerCase()) ||
        log.provider.toLowerCase().includes(search.toLowerCase());
      const matchesProvider = selectedProvider === 'ALL' || log.provider.toLowerCase() === selectedProvider.toLowerCase();
      return matchesSearch && matchesProvider;
    });
  }, [data, search, selectedProvider]);

  const handleOpenPopup = () => {
    window.open(MONITORING_URLS.portkey, 'Portkey Analytics', 'width=1280,height=850,resizable=yes,scrollbars=yes');
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800/80 bg-[#0B1220] p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
            <ShieldCheck size={26} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white">Portkey AI Gateway Analytics</h1>
              <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-400 border border-emerald-500/30">
                Live API Connected
              </span>
            </div>
            <p className="text-xs text-slate-400">Request routing, LLM cache hits, latency metrics, and gateway cost tracking</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={fetchData}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span>Refresh Data</span>
          </button>

          <button
            onClick={handleOpenPopup}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-200 transition hover:bg-slate-800 hover:text-white"
          >
            <AppWindow size={14} />
            <span>Floating Window</span>
          </button>

          <a
            href={MONITORING_URLS.portkey}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-black transition hover:bg-emerald-400 shadow-md"
          >
            <span>Portkey Cloud</span>
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      {loading && !data && (
        <div className="flex h-64 items-center justify-center rounded-xl border border-slate-800/80 bg-[#0B1220]">
          <div className="flex flex-col items-center gap-3 text-slate-400">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-700 border-t-emerald-400" />
            <p className="text-sm">Fetching Portkey gateway telemetry...</p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-red-300">
          <p className="font-semibold">Failed to fetch Portkey telemetry</p>
          <p className="text-xs text-red-400 mt-1">{error}</p>
        </div>
      )}

      {data && (
        <>
          {/* Summary Metric Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Gateway Requests</p>
              <p className="mt-2 text-2xl font-bold text-white">{data.summary.totalRequests}</p>
              <p className="mt-1 text-[11px] text-emerald-400">100% Routed via Portkey</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Total Tokens</p>
              <p className="mt-2 text-2xl font-bold text-sky-400">{data.summary.totalTokens.toLocaleString()}</p>
              <p className="mt-1 text-[11px] text-slate-400">Input & Output combined</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Avg Gateway Latency</p>
              <p className="mt-2 text-2xl font-bold text-amber-400">{data.summary.avgLatencyMs} ms</p>
              <p className="mt-1 text-[11px] text-slate-400">TTFT: {data.summary.avgTtftMs} ms</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Latency Percentiles</p>
              <p className="mt-2 text-sm font-semibold text-slate-200">
                p50: <span className="text-emerald-400">{data.summary.latencyPercentiles?.p50}ms</span> | p90: <span className="text-amber-400">{data.summary.latencyPercentiles?.p90}ms</span>
              </p>
              <p className="mt-1 text-[11px] text-slate-400">p99: {data.summary.latencyPercentiles?.p99}ms</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Cache Hit Ratio</p>
              <p className="mt-2 text-2xl font-bold text-emerald-400">{data.summary.cacheHitRatio}%</p>
              <p className="mt-1 text-[11px] text-emerald-400">Semantic cache active</p>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Est. API Cost</p>
              <p className="mt-2 text-2xl font-bold text-purple-400">${data.summary.totalCostUsd}</p>
              <p className="mt-1 text-[11px] text-slate-400">Portkey cost tracking</p>
            </div>
          </div>

          {/* Active Gateway Config & Guardrails Badges */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-5">
              <h3 className="text-xs uppercase tracking-[0.2em] text-slate-400 mb-3">Active Gateway Configurations</h3>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {data.summary.activeGatewayConfigs.map((cfg) => (
                  <div key={cfg.id} className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#070A0F] p-3">
                    <div>
                      <p className="text-xs font-semibold text-white">{cfg.type}</p>
                      <code className="text-[11px] text-emerald-400">{cfg.id}</code>
                    </div>
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400">
                      <CheckCircle2 size={12} /> ACTIVE
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-5">
              <h3 className="text-xs uppercase tracking-[0.2em] text-slate-400 mb-3">Guardrail & Security Telemetry</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                <div className="rounded-lg border border-slate-800 bg-[#070A0F] p-3">
                  <p className="text-[10px] text-slate-400 uppercase">Passed</p>
                  <p className="text-lg font-bold text-emerald-400 mt-1">{data.summary.guardrails?.passed} / {data.summary.guardrails?.totalChecked}</p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-[#070A0F] p-3">
                  <p className="text-[10px] text-slate-400 uppercase">PII Redacted</p>
                  <p className="text-lg font-bold text-sky-400 mt-1">{data.summary.guardrails?.piiRedacted}</p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-[#070A0F] p-3">
                  <p className="text-[10px] text-slate-400 uppercase">Moderated</p>
                  <p className="text-lg font-bold text-purple-400 mt-1">{data.summary.guardrails?.topicsModerated}</p>
                </div>
                <div className="rounded-lg border border-slate-800 bg-[#070A0F] p-3">
                  <p className="text-[10px] text-slate-400 uppercase">Retries</p>
                  <p className="text-lg font-bold text-amber-400 mt-1">{data.summary.totalRetries}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Request Logs Table */}
          <div className="rounded-xl border border-slate-800/80 bg-[#0B1220] p-5">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-base font-semibold text-white">Live Portkey Gateway Logs</h2>
                <p className="text-xs text-slate-400">Showing {filteredLogs.length} request logs</p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search requestId or model..."
                    className="w-56 rounded-lg border border-slate-800 bg-[#070A0F] pl-9 pr-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                  />
                </div>

                <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#070A0F] p-1">
                  {['ALL', 'openai', 'gemini', 'groq'].map((prov) => (
                    <button
                      key={prov}
                      onClick={() => setSelectedProvider(prov)}
                      className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                        selectedProvider === prov ? 'bg-emerald-500 text-black font-semibold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {prov.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="border-b border-slate-800 bg-[#070A0F] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Request ID</th>
                    <th className="px-4 py-3">Provider / Model</th>
                    <th className="px-4 py-3">Tokens</th>
                    <th className="px-4 py-3">Latency / TTFT</th>
                    <th className="px-4 py-3">Cost (USD)</th>
                    <th className="px-4 py-3">Cache</th>
                    <th className="px-4 py-3">Guardrail</th>
                    <th className="px-4 py-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredLogs.map((log) => {
                    const isExpanded = expandedRow === log.requestId;
                    return (
                      <tbody key={log.requestId} className="contents">
                        <tr className="hover:bg-slate-900/50 transition">
                          <td className="px-4 py-3 font-mono text-emerald-400 font-medium">{log.requestId}</td>
                          <td className="px-4 py-3">
                            <span className="font-semibold text-white">{log.provider}</span>
                            <span className="ml-1 text-[11px] text-slate-400">({log.model})</span>
                          </td>
                          <td className="px-4 py-3 font-medium text-sky-400">{log.totalTokens}</td>
                          <td className="px-4 py-3 font-medium text-amber-400">{log.latencyMs} ms <span className="text-[10px] text-slate-500">({log.ttftMs}ms TTFT)</span></td>
                          <td className="px-4 py-3 text-slate-300">${log.costUsd}</td>
                          <td className="px-4 py-3">
                            {log.cacheHit ? (
                              <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                                HIT
                              </span>
                            ) : (
                              <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">MISS</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                              {log.guardrailAction}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              onClick={() => setExpandedRow(isExpanded ? null : log.requestId)}
                              className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
                            >
                              {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                              <span>{isExpanded ? 'Hide' : 'Inspect'}</span>
                            </button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-[#070A0F]">
                            <td colSpan={8} className="p-4 border-t border-b border-slate-800 space-y-3">
                              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4 text-xs">
                                <div className="rounded border border-slate-800 p-2.5">
                                  <p className="text-[10px] uppercase text-slate-500">Trace & Session</p>
                                  <code className="text-emerald-400 block mt-1">{log.traceId}</code>
                                  <span className="text-slate-400 text-[10px]">{log.sessionId}</span>
                                </div>
                                <div className="rounded border border-slate-800 p-2.5">
                                  <p className="text-[10px] uppercase text-slate-500">Prompt / Completion Tokens</p>
                                  <p className="font-mono text-slate-200 mt-1">
                                    In: <span className="text-sky-400">{log.promptTokens}</span> | Out: <span className="text-emerald-400">{log.completionTokens}</span>
                                  </p>
                                </div>
                                <div className="rounded border border-slate-800 p-2.5">
                                  <p className="text-[10px] uppercase text-slate-500">Portkey Config & Strategy</p>
                                  <code className="text-emerald-400 block mt-1">{log.configId}</code>
                                </div>
                                <div className="rounded border border-slate-800 p-2.5">
                                  <p className="text-[10px] uppercase text-slate-500">Feedback / Sentiment</p>
                                  <span className="text-amber-400 font-semibold block mt-1">{log.userSentiment}</span>
                                </div>
                              </div>

                              <div className="rounded border border-slate-800 bg-[#04060A] p-3 text-xs font-mono space-y-2">
                                <div>
                                  <span className="text-slate-500 uppercase text-[10px]">System Prompt:</span>
                                  <p className="text-slate-300 mt-0.5">{log.systemPrompt}</p>
                                </div>
                                <div>
                                  <span className="text-slate-500 uppercase text-[10px]">User Query:</span>
                                  <p className="text-sky-300 mt-0.5">{log.userPrompt}</p>
                                </div>
                                <div>
                                  <span className="text-slate-500 uppercase text-[10px]">Completion Output:</span>
                                  <p className="text-emerald-300 mt-0.5">{log.outputSnippet}...</p>
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

