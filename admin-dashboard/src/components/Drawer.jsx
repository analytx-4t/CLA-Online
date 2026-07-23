export default function Drawer({ open, title, children, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-overlay/55" onClick={onClose}>
      <div className="h-full w-full max-w-[560px] overflow-y-auto border-l border-line bg-surface p-4 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-lg font-semibold text-ink">{title}</h3>
          <button onClick={onClose} className="rounded-lg border border-line bg-surface-muted px-3 py-1 text-sm text-muted hover:text-ink">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
