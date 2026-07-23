export default function ChartCard({ title, meta, children, footer, action, className = '' }) {
  return (
    <section className={`card flex h-full flex-col p-4 shadow-panel ${className}`}>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{title}</p>
          {meta && <p className="mt-1 text-sm text-muted">{meta}</p>}
        </div>
        {action && <div>{action}</div>}
      </div>

      <div className="flex-1 min-h-[172px] overflow-hidden rounded-lg bg-surface-muted p-3">{children}</div>

      {footer && <div className="mt-2 text-sm text-muted">{footer}</div>}
    </section>
  );
}
