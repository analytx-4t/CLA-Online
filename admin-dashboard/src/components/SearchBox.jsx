export default function SearchBox({ placeholder = 'Search', value = '', onChange }) {
  return (
    <label className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm text-ink">
      <span className="text-muted">⌕</span>
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        className="w-full bg-transparent text-ink outline-none placeholder:text-muted"
      />
    </label>
  );
}
