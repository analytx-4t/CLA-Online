export default function Pagination({ page, totalPages, onPageChange }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink">
      <button onClick={() => onPageChange(page - 1)} disabled={page === 1} className="rounded-full border border-line bg-surface-muted px-3 py-1.5 text-sm text-ink transition hover:border-accent disabled:opacity-50">Prev</button>
      <span className="tnum rounded-full bg-surface-muted px-3 py-1.5 font-semibold text-ink">{page} / {totalPages}</span>
      <button onClick={() => onPageChange(page + 1)} disabled={page === totalPages} className="rounded-full border border-line bg-surface-muted px-3 py-1.5 text-sm text-ink transition hover:border-accent disabled:opacity-50">Next</button>
    </div>
  );
}
