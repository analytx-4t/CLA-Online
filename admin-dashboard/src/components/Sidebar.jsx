import { NavLink } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Activity, ChevronLeft, ClipboardCheck, FileText, LayoutDashboard, Settings, ShieldCheck } from 'lucide-react';

const navItems = [
  { label: 'Overview', to: '/', icon: LayoutDashboard },
  { label: 'RAGAS', to: '/ragas', icon: ClipboardCheck },
  { label: 'Portkey', to: '/portkey', icon: ShieldCheck },
  { label: 'Settings', to: '/settings', icon: Settings },
];

export default function Sidebar({ collapsed, onToggle }) {
  return (
    <aside className={`hidden lg:flex flex-col border-r border-slate-800/70 bg-[#090B0F] text-slate-100 transition-all duration-200 ease-in-out ${collapsed ? 'w-[72px]' : 'w-[220px]'}`}>
      <div className={`flex ${collapsed ? 'flex-col items-center gap-3 py-3' : 'items-center justify-between px-3 py-3'} transition-all duration-200`}>
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'}`}>
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#0F9D58] text-sm font-semibold text-black">
            CLA
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-100">CLA Observability</p>
              <p className="text-xs text-slate-500">AI monitoring</p>
            </div>
          )}
        </div>

        <motion.button
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          className="flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 bg-slate-950/70 text-slate-300 transition hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0F9D58]/40"
        >
          <ChevronLeft size={18} className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`} />
        </motion.button>
      </div>

      <nav className="mt-2 flex-1 space-y-1 px-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `group flex items-center gap-3 rounded-[10px] px-3 ${isActive ? 'border-l-4 border-lime-500 bg-slate-900 text-slate-100' : 'border-l-4 border-transparent text-slate-400 hover:bg-slate-950/80 hover:text-slate-100'} h-[46px] text-sm font-medium transition`}
              aria-label={item.label}
            >
              {({ isActive }) => (
                <>
                  <div className={`flex h-10 w-10 min-w-[40px] items-center justify-center rounded-xl ${isActive ? 'bg-slate-900 text-lime-400' : 'bg-slate-950/80 text-slate-400 group-hover:bg-slate-900 group-hover:text-slate-100'}`}>
                    <Icon size={20} />
                  </div>
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="mt-auto space-y-3 border-t border-slate-800/70 px-3 py-3">
          <div className="rounded-[10px] border border-slate-800/60 bg-slate-950/80 p-3 text-sm text-slate-300">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Workspace</p>
            <p className="mt-2 font-semibold text-slate-100">Infra Production</p>
          </div>
          <div className="rounded-[10px] border border-slate-800/60 bg-slate-950/80 p-3 text-sm text-slate-300">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">System</p>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-slate-100">All systems nominal</p>
                <p className="text-xs text-slate-500">Latency 132 ms</p>
              </div>
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-lime-500/15 text-lime-400">
                <ShieldCheck size={16} />
              </span>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
