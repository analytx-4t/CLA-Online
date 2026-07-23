import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-150px)] max-w-4xl flex-col items-center justify-center gap-6 rounded-xl border border-line bg-surface-muted/90 p-8 text-center ">
      <AlertTriangle size={48} className="mx-auto text-warn" />
      <div>
        <p className="text-sm uppercase tracking-[0.24em] text-muted">Page not found</p>
        <h1 className="mt-4 text-[42px] font-semibold text-ink">404 • Resource unavailable</h1>
        <p className="mt-3 text-sm text-muted">The requested dashboard page does not exist or has been moved.</p>
      </div>
      <Link to="/" className="inline-flex items-center gap-2 rounded-full border border-line bg-accent-soft px-5 py-3 text-sm font-semibold text-accent transition hover:bg-accent/15">
        <ArrowLeft size={16} /> Back to overview
      </Link>
    </div>
  );
}
