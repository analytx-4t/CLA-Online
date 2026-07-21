export default function FilterBar({ children }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-800/80 bg-[#111827]/95 p-3 shadow-panel sm:flex-row sm:items-center sm:justify-between">
      {children}
    </div>
  );
}
