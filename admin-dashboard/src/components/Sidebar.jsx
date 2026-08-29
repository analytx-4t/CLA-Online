import { NavLink } from 'react-router-dom';
import { ChevronLeft, ClipboardCheck, Database, LayoutDashboard, Settings, Target, Sparkles, MessageSquare } from 'lucide-react';
import ThemeToggle from './ThemeToggle';

const navItems = [
  { label: 'Overview', to: '/', icon: LayoutDashboard },
  { label: 'Feedback Logs', to: '/feedback-logs', icon: MessageSquare },
  { label: 'Golden Dataset', to: '/golden-dataset', icon: Database },
  { label: 'Retrieval Eval', to: '/retrieval-eval', icon: Target },
  { label: 'Generation Eval', to: '/generation-eval', icon: Sparkles },
  { label: 'Online Eval', to: '/online-eval', icon: ClipboardCheck },
  { label: 'Settings', to: '/settings', icon: Settings },
];

export default function Sidebar({ collapsed, onToggle, fixed = false }) {
  return (
    <aside className={`${fixed ? 'fixed left-0 top-0 z-20' : ''} hidden h-screen lg:flex flex-col border-r border-sidebar-line bg-sidebar text-sidebar-ink transition-all duration-200 ease-in-out ${collapsed ? 'w-[84px]' : 'w-[260px]'}`}>
      <div className={`flex ${collapsed ? 'flex-col items-center gap-3 py-4' : 'items-center justify-between px-4 py-4'} transition-all duration-200`}>
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'}`}>
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent text-sm font-semibold text-accent-ink">
            CLA
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-sm font-semibold text-sidebar-ink">CLA Admin</p>
              <p className="text-xs text-sidebar-muted">Operations workspace</p>
            </div>
          )}
        </div>

        <button
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-sidebar-line bg-sidebar-muted-bg text-sidebar-muted transition hover:border-accent hover:text-accent focus:outline-none focus:ring-2 focus:ring-accent-soft-strong"
        >
          <ChevronLeft size={16} className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <nav className="mt-2 flex-1 space-y-1 px-3">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `group flex items-center gap-3 rounded-lg px-3 ${isActive ? 'bg-accent-soft-strong text-accent' : 'text-sidebar-muted hover:bg-white/5 hover:text-sidebar-ink'} h-[46px] text-sm font-medium transition`}
              aria-label={item.label}
            >
              {({ isActive }) => (
                <>
                  <div className={`flex h-8 w-8 min-w-[32px] items-center justify-center rounded-lg ${isActive ? 'text-accent' : 'text-sidebar-muted group-hover:text-sidebar-ink'}`}>
                    <Icon size={18} />
                  </div>
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className={`border-t border-sidebar-line px-4 py-4 ${collapsed ? 'flex justify-center' : ''}`}>
        <ThemeToggle collapsed={collapsed} />
      </div>

      {!collapsed && (
        <div className="space-y-3 px-4 pb-4">
          <div className="rounded-lg border border-sidebar-line bg-sidebar-muted-bg p-3 text-sm text-sidebar-ink">
            <p className="text-xs uppercase tracking-[0.2em] text-sidebar-muted">Workspace</p>
            <p className="mt-2 font-semibold">Infra Production</p>
          </div>
        </div>
      )}
    </aside>
  );
}
