import { NavLink } from 'react-router-dom';
import { ChevronLeft, ClipboardCheck, Database, LayoutDashboard, Settings, ShieldCheck } from 'lucide-react';
import ThemeToggle from './ThemeToggle';

const navItems = [
  { label: 'Overview', to: '/', icon: LayoutDashboard },
  { label: 'Online Eval', to: '/online-eval', icon: ClipboardCheck },
  { label: 'Golden Dataset', to: '/golden-dataset', icon: Database },
  { label: 'Settings', to: '/settings', icon: Settings },
];

export default function Sidebar({ collapsed, onToggle }) {
  return (
    <aside className={`hidden lg:flex flex-col border-r border-line bg-surface text-ink transition-all duration-200 ease-in-out ${collapsed ? 'w-[72px]' : 'w-[220px]'}`}>
      <div className={`flex ${collapsed ? 'flex-col items-center gap-3 py-3' : 'items-center justify-between px-3 py-3'} transition-all duration-200`}>
        <div className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'}`}>
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent text-sm font-semibold text-accent-ink">
            CLA
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">CLA Admin</p>
              <p className="text-xs text-muted">Operations workspace</p>
            </div>
          )}
        </div>

        <button
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-surface text-muted transition hover:border-accent hover:text-accent focus:outline-none focus:ring-2 focus:ring-accent-soft-strong"
        >
          <ChevronLeft size={16} className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <nav className="mt-2 flex-1 space-y-1 px-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `group flex items-center gap-3 rounded-lg px-2.5 ${isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-muted hover:text-ink'} h-[42px] text-sm font-medium transition`}
              aria-label={item.label}
            >
              {({ isActive }) => (
                <>
                  <div className={`flex h-8 w-8 min-w-[32px] items-center justify-center rounded-lg ${isActive ? 'text-accent' : 'text-muted group-hover:text-ink'}`}>
                    <Icon size={18} />
                  </div>
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className={`border-t border-line px-3 py-3 ${collapsed ? 'flex justify-center' : ''}`}>
        <ThemeToggle collapsed={collapsed} />
      </div>

      {!collapsed && (
        <div className="space-y-3 px-3 pb-3">
          <div className="rounded-lg border border-line bg-surface-muted p-3 text-sm text-ink">
            <p className="text-xs uppercase tracking-[0.2em] text-muted">Workspace</p>
            <p className="mt-2 font-semibold">Infra Production</p>
          </div>
        </div>
      )}
    </aside>
  );
}
