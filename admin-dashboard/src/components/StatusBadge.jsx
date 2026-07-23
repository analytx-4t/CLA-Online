export default function StatusBadge({ status }) {
  const tone = {
    Healthy: 'bg-good/15 text-good',
    Review: 'bg-warn-soft text-warn',
    Running: 'bg-info-soft text-info',
    Completed: 'bg-good/15 text-good',
    Warning: 'bg-warn-soft text-warn',
    Critical: 'bg-danger-soft text-danger',
    Info: 'bg-info-soft text-info',
  }[status] || 'bg-surface-strong text-muted';

  return <span className={`inline-flex rounded-full border border-line px-2.5 py-1 text-[11px] font-semibold ${tone}`}>{status}</span>;
}
