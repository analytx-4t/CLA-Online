import { Bell, RefreshCw, Search, ChevronDown, Settings } from 'lucide-react';

export default function Navbar({ title, onMenuToggle }) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-900/80 bg-[#0B0F14]/95 px-3 py-3 backdrop-blur-xl shadow-sm sm:px-5">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <button
            onClick={onMenuToggle}
            className="rounded-lg border border-slate-800 bg-[#111827] p-2 text-slate-300 lg:hidden"
            aria-label="Open menu"
          >
            ☰
          </button>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-400">AI Monitoring Platform</p>
            <h1 className="text-[26px] font-semibold text-white">{title}</h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="hidden items-center gap-2 rounded-lg border border-slate-800 bg-[#111827] px-3 py-2 text-sm text-slate-300 shadow-sm sm:flex">
            <Search size={16} />
            <input aria-label="Search dashboard" placeholder="Search" className="w-[160px] bg-transparent text-sm text-white outline-none placeholder:text-slate-500" />
          </div>
          <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-800 bg-[#111827] px-3 text-sm text-slate-300 shadow-sm transition hover:border-[#0F9D58] hover:text-white" aria-label="Time range selector">
            Last 7 days
            <ChevronDown size={16} />
          </button>
          <button className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-800 bg-[#111827] text-slate-300 transition hover:border-[#0F9D58] hover:text-white" aria-label="Auto refresh">
            <RefreshCw size={16} />
          </button>
          <button className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-800 bg-[#111827] text-slate-300 transition hover:border-[#0F9D58] hover:text-white" aria-label="Notifications">
            <Bell size={16} />
          </button>
          <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-800 bg-[#111827] px-3 text-sm text-slate-300 transition hover:border-[#0F9D58] hover:text-white" aria-label="Profile">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#0F9D58] text-[11px] font-bold text-black">CL</span>
            <span className="hidden sm:inline">CLA Ops</span>
            <Settings size={16} />
          </button>
        </div>
      </div>
    </header>
  );
}
