import { useLocation } from 'react-router-dom';

const PAGE_TITLES = [
  { match: /^\/$/, title: 'Overview', eyebrow: 'CLA operations' },
  { match: /^\/online-eval/, title: 'Online Eval', eyebrow: 'Live answer quality' },
  { match: /^\/golden-dataset/, title: 'Golden Dataset', eyebrow: 'Offline benchmark' },
  { match: /^\/settings/, title: 'Settings', eyebrow: 'System configuration' },
];

function getPageMeta(pathname) {
  return PAGE_TITLES.find((entry) => entry.match.test(pathname)) || { title: 'CLA Admin', eyebrow: 'CLA operations' };
}

export default function Navbar({ onMenuToggle }) {
  const location = useLocation();
  const { title, eyebrow } = getPageMeta(location.pathname);

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/95 px-3 py-3 backdrop-blur-xl sm:px-5">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuToggle}
          className="rounded-lg border border-line bg-surface-muted p-2 text-muted lg:hidden"
          aria-label="Open menu"
        >
          ☰
        </button>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted">{eyebrow}</p>
          <h1 className="truncate text-[24px] font-semibold text-ink">{title}</h1>
        </div>

        <div className="ml-auto flex items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-1.5 text-sm text-ink">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent text-[10px] font-bold text-accent-ink">CL</span>
          <span className="hidden sm:inline">CLA Ops</span>
        </div>
      </div>
    </header>
  );
}
