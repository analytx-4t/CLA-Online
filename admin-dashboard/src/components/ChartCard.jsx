export default function ChartCard({ title, meta, children, footer, action, className = '' }) {
  return (
    <section className={`card border border-slate-800/80 bg-[#151C26]/95 p-3 shadow-panel ${className}`}>
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">{title}</p>
          {meta && <p className="mt-1 text-sm text-slate-400">{meta}</p>}
        </div>
        {action && <div>{action}</div>}
      </div>

      <div className="min-h-[172px] overflow-hidden rounded-lg bg-slate-950/80 p-3">{children}</div>

      {footer && <div className="mt-2 text-sm text-slate-400">{footer}</div>}
    </section>
  );
}
