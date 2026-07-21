export default function Drawer({ open, title, children, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/70">
      <div className="h-full w-full max-w-[560px] border-l border-slate-800 bg-[#0B0F14] p-3 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="rounded-lg border border-slate-800 bg-[#111827] px-3 py-1 text-sm text-slate-300">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
