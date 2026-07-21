export default function StatusPill({ label, tone }) {
  const toneStyles = {
    success: 'bg-[#0F9D58]/15 text-[#0F9D58]',
    warning: 'bg-[#F59E0B]/15 text-[#F59E0B]',
    danger: 'bg-[#EF4444]/15 text-[#EF4444]',
    info: 'bg-[#3B82F6]/15 text-[#3B82F6]',
    neutral: 'bg-slate-800/80 text-slate-300',
  };

  return (
    <span className={`inline-flex rounded-sm px-2 py-1 text-[11px] font-semibold ${toneStyles[tone] || toneStyles.neutral}`}>
      {label}
    </span>
  );
}
