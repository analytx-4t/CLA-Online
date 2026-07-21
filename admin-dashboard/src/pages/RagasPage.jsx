import { useMemo, useState } from 'react';
import { Search, Filter, ChevronRight } from 'lucide-react';
import SearchBox from '../components/SearchBox';
import FilterBar from '../components/FilterBar';
import DataTable from '../components/DataTable';
import StatusPill from '../components/StatusPill';
import ChartCard from '../components/ChartCard';
import LineChart from '../components/LineChart';
import Drawer from '../components/Drawer';
import { ragasRows, ragasDetail } from '../data/mockRagas';

const statusOptions = ['All', 'Completed', 'Review'];
const modelOptions = ['All', 'gpt-4o-mini', 'gemini-pro', 'openai-4.1', 'groq-1'];
const metricOptions = ['Faithfulness', 'Relevancy', 'Precision', 'Recall', 'Correctness'];

export default function RagasPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All');
  const [model, setModel] = useState('All');
  const [metric, setMetric] = useState('Faithfulness');
  const [selectedId, setSelectedId] = useState(null);

  const filteredRows = useMemo(() => {
    return ragasRows.filter((row) => {
      const matchesSearch = row.query.toLowerCase().includes(search.toLowerCase()) || row.id.toLowerCase().includes(search.toLowerCase());
      const matchesStatus = status === 'All' || row.status === status;
      const matchesModel = model === 'All' || row.model === model;
      return matchesSearch && matchesStatus && matchesModel;
    });
  }, [search, status, model]);

  const selectedDetail = selectedId ? ragasRows.find((row) => row.id === selectedId) : null;

  const columns = [
    { header: 'ID', accessor: 'id', width: '80px' },
    { header: 'Prompt', accessor: 'query', width: '160px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{`${row.query.split(' ')[0]}...`}</span> },
    { header: 'Model', accessor: 'model', width: '100px' },
    { header: 'Faithfulness', accessor: 'faithfulness', width: '90px' },
    { header: 'Relevancy', accessor: 'relevancy', width: '90px' },
    { header: 'Precision', accessor: 'precision', width: '90px' },
    { header: 'Recall', accessor: 'recall', width: '90px' },
    { header: 'Correctness', accessor: 'correctness', width: '90px' },
    { header: 'Status', accessor: 'status', width: '90px', render: (row) => <StatusPill label={row.status} tone={row.status === 'Completed' ? 'success' : 'warning'} /> },
    { header: '', accessor: 'action', width: '90px', render: (row) => <button onClick={() => setSelectedId(row.id)} className="inline-flex items-center gap-1 rounded-lg border border-slate-800 bg-[#111827] px-2 py-1 text-[11px] text-slate-300 hover:border-[#0F9D58]">Details <ChevronRight size={14} /></button> },
  ];

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-800/80 bg-[#111827]/95 p-3 shadow-panel">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Evaluation workspace</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">RAGAS Review</h2>
          </div>
          <div className="w-full max-w-sm xl:w-auto">
            <SearchBox value={search} onChange={setSearch} placeholder="Search evaluations" />
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <FilterBar>
            <div className="flex items-center gap-2 text-sm text-slate-200"><Filter size={16} /><span>Status</span></div>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-slate-800 bg-[#0B1119] px-2.5 py-2 text-sm text-slate-100 outline-none">
              {statusOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </FilterBar>
          <FilterBar>
            <div className="flex items-center gap-2 text-sm text-slate-200"><Filter size={16} /><span>Model</span></div>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="rounded-lg border border-slate-800 bg-[#0B1119] px-2.5 py-2 text-sm text-slate-100 outline-none">
              {modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </FilterBar>
          <FilterBar>
            <div className="flex items-center gap-2 text-sm text-slate-200"><Filter size={16} /><span>Metric</span></div>
            <select value={metric} onChange={(e) => setMetric(e.target.value)} className="rounded-lg border border-slate-800 bg-[#0B1119] px-2.5 py-2 text-sm text-slate-100 outline-none">
              {metricOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </FilterBar>
          <div className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 px-4 py-3 text-slate-300">
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Score focus</p>
            <p className="mt-2 text-lg font-semibold text-white">{metric}</p>
          </div>
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-[1.9fr_1fr]">
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3 shadow-panel overflow-hidden">
            <DataTable columns={columns} rows={filteredRows} />
          </div>

          <div className="grid gap-3 xl:grid-cols-3">
            <ChartCard title="Faithfulness" meta="Evaluation consistency" footer="Average 94.8% across reviewed prompts.">
              <div className="h-full w-full"><LineChart points={[92, 94, 95, 96, 94, 95, 96]} accent="#0F9D58" /></div>
            </ChartCard>
            <ChartCard title="Context precision" meta="Retrieval quality" footer="Strong relevance for evaluation sets.">
              <div className="h-full w-full"><LineChart points={[88, 90, 91, 92, 91, 90, 92]} accent="#3B82F6" /></div>
            </ChartCard>
            <ChartCard title="Answer correctness" meta="Final output accuracy" footer="Accuracy remains above target.">
              <div className="h-full w-full"><LineChart points={[89, 90, 92, 94, 93, 92, 93]} accent="#0F9D58" /></div>
            </ChartCard>
          </div>
        </div>

        <div className="space-y-4">
          <Drawer open={Boolean(selectedId)} title={selectedId ? `Details - ${selectedId}` : ''} onClose={() => setSelectedId(null)}>
            {selectedDetail ? (
              <div className="space-y-4">
                <div className="rounded-lg bg-[#0B1119] p-3">
                  <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Prompt</p>
                  <p className="mt-2 text-sm text-slate-200 truncate">{selectedDetail.query}</p>
                </div>
                <div className="rounded-lg bg-[#0B1119] p-3">
                  <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Question</p>
                  <p className="mt-2 text-sm text-slate-200">{ragasDetail.question}</p>
                </div>
                <div className="rounded-lg bg-[#0B1119] p-3">
                  <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Context</p>
                  <ul className="mt-2 space-y-2 text-sm text-slate-400">
                    {ragasDetail.context.map((item) => <li key={item}>• {item}</li>)}
                  </ul>
                </div>
                <div className="rounded-lg bg-[#0B1119] p-3">
                  <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Golden answer</p>
                  <p className="mt-2 text-sm text-slate-200">{ragasDetail.golden}</p>
                </div>
                <div className="rounded-lg bg-[#0B1119] p-3">
                  <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Model answer</p>
                  <p className="mt-2 text-sm text-slate-200">{ragasDetail.answer}</p>
                </div>
                <div className="rounded-lg bg-[#0B1119] p-3">
                  <p className="text-[10px] uppercase tracking-[0.3em] text-slate-500">Evaluation</p>
                  <div className="mt-2 space-y-2">
                    {ragasDetail.scores.map((score) => (
                      <div key={score.label} className="flex items-center justify-between gap-2 text-sm text-slate-300">
                        <span>{score.label}</span>
                        <span className="font-semibold text-white">{score.value}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </Drawer>

          <ChartCard title="Evaluation summary" meta="Score distribution">
            <div className="h-full w-full"><LineChart points={[82, 88, 92, 94, 93, 91, 95]} accent="#0F9D58" /></div>
          </ChartCard>
        </div>
      </section>
    </div>
  );
}
