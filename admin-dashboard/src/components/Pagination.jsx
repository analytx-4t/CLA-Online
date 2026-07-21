export default function Pagination({ page, totalPages, onPageChange }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#111827] px-3 py-2 text-sm text-slate-300">
      <button onClick={() => onPageChange(page - 1)} disabled={page === 1} className="rounded-full border border-slate-800 bg-[#0B0F14] px-3 py-1.5 text-sm text-slate-200 transition hover:border-[#0F9D58] disabled:opacity-50">Prev</button>
      <span className="rounded-full bg-slate-900 px-3 py-1.5 font-semibold text-slate-200">{page} / {totalPages}</span>
      <button onClick={() => onPageChange(page + 1)} disabled={page === totalPages} className="rounded-full border border-slate-800 bg-[#0B0F14] px-3 py-1.5 text-sm text-slate-200 transition hover:border-[#0F9D58] disabled:opacity-50">Next</button>
    </div>
  );
}
