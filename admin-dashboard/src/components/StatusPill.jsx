export default function StatusPill({ label, tone }) {
  const toneStyles = {
    success: 'bg-good/15 text-good',
    warning: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
    info: 'bg-info-soft text-info',
    neutral: 'bg-surface-strong text-muted',
  };

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${toneStyles[tone] || toneStyles.neutral}`}>
      {label}
    </span>
  );
}
