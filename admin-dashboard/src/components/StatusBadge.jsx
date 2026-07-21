export default function StatusBadge({ status }) {
  const tone = {
    Healthy: 'bg-[#0F9D58]/15 text-[#0F9D58]',
    Review: 'bg-[#F59E0B]/15 text-[#F59E0B]',
    Running: 'bg-[#38BDF8]/15 text-[#38BDF8]',
    Completed: 'bg-[#0F9D58]/15 text-[#0F9D58]',
    Warning: 'bg-[#F59E0B]/15 text-[#F59E0B]',
    Critical: 'bg-[#EF4444]/15 text-[#EF4444]',
    Info: 'bg-[#38BDF8]/15 text-[#38BDF8]',
  }[status] || 'bg-slate-800 text-slate-200';

  return <span className={`inline-flex rounded-full border border-slate-800 px-2.5 py-1 text-[11px] font-semibold ${tone}`}>{status}</span>;
}
