import { useState } from 'react';
import { ExternalLink, ShieldAlert, RefreshCw, Monitor, Lock, ArrowUpRight, AppWindow } from 'lucide-react';
import { MONITORING_URLS } from '../config/monitoringUrls';

const SERVICE_META = {
  'Portkey Analytics': {
    service: 'Portkey AI Gateway',
    desc: 'LLM request tracing, prompt caching, guardrail logs, and latency metrics.',
    color: 'from-emerald-500/20 to-teal-500/10 border-emerald-500/30 text-emerald-400',
    iconColor: 'text-emerald-400',
    btnBg: 'bg-emerald-500 hover:bg-emerald-400 text-black',
  },
  'LangSmith Monitor': {
    service: 'LangChain LangSmith',
    desc: 'Detailed agent execution traces, RAG chain steps, prompt runs, and evaluation benchmarks.',
    color: 'from-sky-500/20 to-blue-500/10 border-sky-500/30 text-sky-400',
    iconColor: 'text-sky-400',
    btnBg: 'bg-sky-500 hover:bg-sky-400 text-black',
  },
  'Logfire Monitor': {
    service: 'Pydantic Logfire',
    desc: 'OpenTelemetry traces, real-time log streams, system metrics, and python backend performance.',
    color: 'from-orange-500/20 to-amber-500/10 border-orange-500/30 text-orange-400',
    iconColor: 'text-orange-400',
    btnBg: 'bg-orange-500 hover:bg-orange-400 text-black',
  },
};

export default function MonitoringFrame({ url, title }) {
  const [embedMode, setEmbedMode] = useState(false);
  const meta = SERVICE_META[title] || {
    service: title,
    desc: 'Observability platform dashboard',
    color: 'from-emerald-500/20 to-teal-500/10 border-emerald-500/30 text-emerald-400',
    iconColor: 'text-emerald-400',
    btnBg: 'bg-[#0F9D58] hover:bg-[#0B7A45] text-black',
  };

  const handleOpenPopup = () => {
    window.open(url, title, 'width=1280,height=850,resizable=yes,scrollbars=yes,status=yes');
  };

  return (
    <div className="flex min-h-[calc(100vh-170px)] w-full flex-col overflow-hidden rounded-xl border border-slate-800/80 bg-[#0B1220]">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 bg-[#0B0F14] px-4 py-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Observability Platform</p>
          <h1 className="text-lg font-semibold text-white">{title}</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleOpenPopup}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:bg-slate-800 hover:text-white"
          >
            <AppWindow size={14} />
            <span>Open Floating Window</span>
          </button>

          <button
            type="button"
            onClick={() => setEmbedMode(!embedMode)}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-800 hover:text-white"
          >
            <Monitor size={14} />
            {embedMode ? 'Hide Embedded Frame' : 'Try Embedded Frame'}
          </button>

          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-semibold shadow-md transition ${meta.btnBg}`}
          >
            <span>Open in New Tab</span>
            <ExternalLink size={14} />
          </a>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="relative flex flex-1 flex-col overflow-y-auto p-6">
        {embedMode ? (
          <div className="flex h-full w-full flex-col">
            <div className="mb-3 flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
              <span className="flex items-center gap-2">
                <ShieldAlert size={14} className="text-amber-400" />
                Note: If the frame displays "refused to connect", the provider blocks iframe embedding.
              </span>
              <a href={url} target="_blank" rel="noopener noreferrer" className="font-medium underline hover:text-amber-100">
                Launch directly ↗
              </a>
            </div>
            <iframe title={title} src={url} className="h-[700px] w-full rounded-lg border border-slate-800 bg-slate-950" />
          </div>
        ) : (
          <div className="mx-auto my-auto flex max-w-2xl flex-col items-center text-center">
            {/* Service Icon / Badge */}
            <div className={`mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border bg-gradient-to-br p-3 shadow-lg ${meta.color}`}>
              <Lock size={32} className={meta.iconColor} />
            </div>

            <h2 className="text-2xl font-bold text-white">{meta.service}</h2>
            <p className="mt-2 text-sm text-slate-400 max-w-lg">{meta.desc}</p>

            {/* Explanation Banner */}
            <div className="mt-6 w-full rounded-xl border border-slate-800/80 bg-[#070A0F] p-4 text-left shadow-inner">
              <div className="flex items-start gap-3">
                <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-400" />
                <div className="text-xs text-slate-300 space-y-1">
                  <p className="font-semibold text-slate-200">Why does Portkey/LangSmith block standard iframes?</p>
                  <p className="text-slate-400">
                    SaaS monitoring providers (<code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">app.portkey.ai</code>, <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">smith.langchain.com</code>, <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">logfire-us.pydantic.dev</code>) enforce strict HTTP Security Headers (<code className="text-emerald-400">X-Frame-Options: DENY / SAMEORIGIN</code>) to protect user authentication.
                  </p>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={handleOpenPopup}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-3 text-sm font-semibold text-black shadow-lg transition hover:bg-emerald-400 transform hover:-translate-y-0.5"
              >
                <AppWindow size={18} />
                <span>Open Floating Window</span>
              </button>

              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex items-center gap-2 rounded-lg px-5 py-3 text-sm font-semibold shadow-lg transition transform hover:-translate-y-0.5 ${meta.btnBg}`}
              >
                <span>Launch in New Tab</span>
                <ArrowUpRight size={18} />
              </a>
            </div>

            {/* Quick Navigation to Other Platforms */}
            <div className="mt-10 w-full border-t border-slate-800/80 pt-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 mb-3">All Observability Endpoints</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <a
                  href={MONITORING_URLS.portkey}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#090D16] p-3 text-left transition hover:border-emerald-500/50 hover:bg-emerald-500/5"
                >
                  <div>
                    <p className="text-xs font-semibold text-slate-200">Portkey AI</p>
                    <p className="text-[10px] text-slate-500">Gateway & Cache</p>
                  </div>
                  <ExternalLink size={14} className="text-emerald-400" />
                </a>

                <a
                  href={MONITORING_URLS.langsmith}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#090D16] p-3 text-left transition hover:border-sky-500/50 hover:bg-sky-500/5"
                >
                  <div>
                    <p className="text-xs font-semibold text-slate-200">LangSmith</p>
                    <p className="text-[10px] text-slate-500">LLM Tracing</p>
                  </div>
                  <ExternalLink size={14} className="text-sky-400" />
                </a>

                <a
                  href={MONITORING_URLS.logfire}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#090D16] p-3 text-left transition hover:border-orange-500/50 hover:bg-orange-500/5"
                >
                  <div>
                    <p className="text-xs font-semibold text-slate-200">Logfire</p>
                    <p className="text-[10px] text-slate-500">OpenTelemetry</p>
                  </div>
                  <ExternalLink size={14} className="text-orange-400" />
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


