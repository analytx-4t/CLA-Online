import { useLocation } from 'react-router-dom';

const PAGE_TITLES = [
  { match: /^\/$/, title: 'Overview', eyebrow: 'Executive summary' },
  { match: /^\/online-eval/, title: 'Online Eval', eyebrow: 'Evaluation workspace' },
  { match: /^\/golden-dataset/, title: 'Golden Dataset', eyebrow: 'Golden dataset workspace' },
  { match: /^\/settings/, title: 'Settings', eyebrow: 'System configuration' },
];

function getPageMeta(pathname) {
  return PAGE_TITLES.find((entry) => entry.match.test(pathname)) || { title: 'CLA Admin', eyebrow: 'CLA operations' };
}

export default function Navbar({ onMenuToggle }) {
  const location = useLocation();
  const { title, eyebrow } = getPageMeta(location.pathname);

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface opacity-100 shadow-sm backdrop-blur-md px-3 py-2 sm:px-4" style={{ backgroundColor: 'rgb(var(--surface))' }}>
      <div className="flex items-center gap-2.5">
        <button
          onClick={onMenuToggle}
          className="rounded-lg border border-line bg-surface-muted p-1.5 text-muted lg:hidden"
          aria-label="Open menu"
        >
          ☰
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-ink">{title}</h1> 
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">{eyebrow}</p>
        </div>

        <div className="ml-auto flex items-center gap-1.5 rounded-lg border border-line bg-surface-muted px-2.5 py-1 text-xs text-ink">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-accent text-[9px] font-bold text-accent-ink">CL</span>
          <span className="hidden sm:inline">CLA Ops</span>
        </div>
      </div>
    </header>
  );
}
