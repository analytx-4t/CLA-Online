export default function SearchBox({ placeholder = 'Search', value = '', onChange }) {
  return (
    <label className="flex items-center gap-2 rounded-xl border border-slate-800 bg-[#111827] px-3 py-2 text-sm text-slate-300 shadow-sm">
      <span className="text-slate-500">⌕</span>
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        className="w-full bg-transparent text-slate-100 outline-none placeholder:text-slate-500"
      />
    </label>
  );
}
