export default function Tabs({ tabs, activeTab, onChange }) {
  return (
    <div className="flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-[#111827] p-1">
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onChange(tab)}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${activeTab === tab ? 'bg-[#0F9D58] text-black' : 'text-slate-300 hover:text-white'}`}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}
