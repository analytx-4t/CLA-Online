export default function Tabs({ tabs, activeTab, onChange }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface-muted p-1">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onChange(tab)}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${activeTab === tab ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink'}`}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}
