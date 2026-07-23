export default function MetricCard({ title, value, delta, trend, icon: Icon, caption, compact }) {
  return (
    <div className="group relative px-1 py-1 min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">{title}</p>
          <p className={`tnum mt-2 break-words font-semibold text-ink ${compact ? 'text-base leading-snug' : 'text-[28px] leading-none sm:text-[32px]'}`}>{value}</p>
        </div>
        {Icon && (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <Icon size={16} />
          </span>
        )}
      </div>

      {(delta || caption) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted">
          {delta && <span className={`tnum rounded-full px-2 py-0.5 font-medium ${trend === 'down' ? 'bg-danger-soft text-danger' : 'bg-good/15 text-good'}`}>{delta}</span>}
          {caption && <span>{caption}</span>}
        </div>
      )}
    </div>
  );
}
