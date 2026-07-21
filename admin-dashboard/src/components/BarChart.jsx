export default function BarChart({ values, colors = ['#0F9D58', '#3B82F6', '#F59E0B'] }) {
  const max = Math.max(...values.map((item) => item.value), 1);
  return (
    <div className="flex h-full items-end gap-2">
      {values.map((item, index) => {
        const height = (item.value / max) * 100;
        return (
          <div key={item.label} className="flex flex-[1_1_0%] min-w-0 flex-col items-center gap-2 text-[11px] text-slate-400">
            <div className="relative flex h-20 w-full items-end overflow-hidden rounded-[3px] bg-slate-900">
              <div className="h-full w-full rounded-b-[3px]" style={{ height: `${height}%`, backgroundColor: colors[index % colors.length] }} />
            </div>
            <span className="w-full truncate text-xs text-slate-300 text-center">{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
