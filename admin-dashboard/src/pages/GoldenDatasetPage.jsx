import { useEffect, useMemo, useState } from 'react';
import { FileUp, Search, RefreshCw, UploadCloud } from 'lucide-react';
import DataTable from '../components/DataTable';
import Drawer from '../components/Drawer';

const PAGE_SIZE = 10;

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}

function getAverage(values) {
  if (!values.length) return '—';
  const avg = values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
  return `${avg.toFixed(2)}%`;
}

export default function GoldenDatasetPage() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState('id');
  const [sortDirection, setSortDirection] = useState('asc');
  const [summary, setSummary] = useState({
    version: '—',
    totalQuestions: 0,
    lastUpload: '—',
    lastEvaluation: '—',
    avgFaithfulness: '—',
    avgAnswerCorrectness: '—',
  });
  const [evaluations, setEvaluations] = useState([]);
  const [selectedEvaluation, setSelectedEvaluation] = useState(null);
  const [evaluationsLoading, setEvaluationsLoading] = useState(true);

  const loadDataset = async () => {
    try {
      setLoading(true);
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset');
      const payload = await response.json();
      const dataset = Array.isArray(payload.records) ? payload.records : [];
      setRecords(dataset);

      const versions = dataset.map((item) => item.version).filter(Boolean);
      const evaluations = dataset.filter((item) => item.lastEvaluation || item.last_evaluation);
      const faithfulnessValues = dataset
        .map((item) => Number(item.avgFaithfulness ?? item.avg_faithfulness))
        .filter((value) => Number.isFinite(value));
      const correctnessValues = dataset
        .map((item) => Number(item.avgAnswerCorrectness ?? item.avg_answer_correctness))
        .filter((value) => Number.isFinite(value));

      setSummary({
        version: payload.version || versions[0] || '—',
        totalQuestions: dataset.length,
        lastUpload: payload.uploadedAt || dataset[0]?.uploadedAt || dataset[0]?.uploaded_at || '—',
        lastEvaluation: evaluations[0]?.lastEvaluation || evaluations[0]?.last_evaluation || '—',
        avgFaithfulness: faithfulnessValues.length ? `${(faithfulnessValues.reduce((sum, value) => sum + value, 0) / faithfulnessValues.length).toFixed(2)}%` : '—',
        avgAnswerCorrectness: correctnessValues.length ? `${(correctnessValues.reduce((sum, value) => sum + value, 0) / correctnessValues.length).toFixed(2)}%` : '—',
      });
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const loadEvaluations = async () => {
    try {
      setEvaluationsLoading(true);
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset/evaluations');
      const payload = await response.json();
      setEvaluations(Array.isArray(payload.evaluations) ? payload.evaluations : []);
    } catch (error) {
      console.error(error);
    } finally {
      setEvaluationsLoading(false);
    }
  };

  useEffect(() => {
    loadDataset();
    loadEvaluations();
  }, []);

  const filteredRecords = useMemo(() => {
    const query = search.toLowerCase();
    return records.filter((row) => {
      const fields = [row.id, row.question, row.intent, row.answer, row.sourceTable, row.sourceColumn, row.rowId, row.notes]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return fields.includes(query);
    });
  }, [records, search]);

  const sortedRecords = useMemo(() => {
    const sorted = [...filteredRecords].sort((a, b) => {
      const left = a[sortKey] ?? '';
      const right = b[sortKey] ?? '';
      const comparison = String(left).localeCompare(String(right), undefined, { sensitivity: 'base' });
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [filteredRecords, sortKey, sortDirection]);

  const pagedRecords = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return sortedRecords.slice(start, start + PAGE_SIZE);
  }, [sortedRecords, page]);

  const totalPages = Math.max(1, Math.ceil(sortedRecords.length / PAGE_SIZE));

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      setUploading(true);
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset/upload', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Upload failed');
      await loadDataset();
      alert(payload.message || 'Dataset uploaded');
    } catch (error) {
      alert(error.message || 'Upload failed');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  };

  const handleReplace = async () => {
    if (!window.confirm('Replace the current dataset?')) return;
    try {
      setUploading(true);
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset', {
        method: 'DELETE',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Replace failed');
      await loadDataset();
      await loadEvaluations();
      window.setTimeout(() => loadEvaluations(), 2000);
      alert(payload.message || 'Dataset cleared');
    } catch (error) {
      alert(error.message || 'Replace failed');
    } finally {
      setUploading(false);
    }
  };

  const handleRunEvaluation = async () => {
    try {
      setUploading(true);
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset/evaluate', {
        method: 'POST',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Evaluation failed');
      await loadEvaluations();
      window.setTimeout(() => loadEvaluations(), 2000);
      alert(payload.message || 'Evaluation started');
    } catch (error) {
      alert(error.message || 'Evaluation failed');
    } finally {
      setUploading(false);
    }
  };

  const datasetColumns = [
    { header: 'ID', accessor: 'id', width: '90px', render: (row) => <button onClick={() => handleSort('id')} className="text-left text-slate-100">{row.id || '—'}</button> },
    { header: 'Question', accessor: 'question', width: '220px' },
    { header: 'Intent', accessor: 'intent', width: '140px' },
    { header: 'Expected Answer', accessor: 'answer', width: '220px' },
    { header: 'Source Table', accessor: 'sourceTable', width: '140px' },
    { header: 'Source Column', accessor: 'sourceColumn', width: '140px' },
    { header: 'Row Id', accessor: 'rowId', width: '100px' },
    { header: 'Notes', accessor: 'notes', width: '180px' },
  ];

  const evaluationColumns = [
    { header: 'Question', accessor: 'question', width: '220px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.question || '—'}</span> },
    { header: 'Status', accessor: 'status', width: '100px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.status || '—'}</span> },
    { header: 'Faithfulness', accessor: 'faithfulness', width: '110px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.faithfulness ?? '—'}</span> },
    { header: 'Answer Relevancy', accessor: 'answerRelevancy', width: '130px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.answerRelevancy ?? '—'}</span> },
    { header: 'Context Precision', accessor: 'contextPrecision', width: '130px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.contextPrecision ?? '—'}</span> },
    { header: 'Context Recall', accessor: 'contextRecall', width: '120px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.contextRecall ?? '—'}</span> },
    { header: 'Answer Correctness', accessor: 'answerCorrectness', width: '130px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.answerCorrectness ?? '—'}</span> },
    { header: 'Retrieval Time', accessor: 'retrievalTime', width: '120px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.retrievalTime ?? '—'}</span> },
    { header: 'LLM Time', accessor: 'llmTime', width: '100px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.llmTime ?? '—'}</span> },
    { header: 'Retrieved Chunks', accessor: 'retrievedChunks', width: '160px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{(row.retrievedChunks || []).join(', ') || '—'}</span> },
    { header: 'Chunk IDs', accessor: 'retrievedChunkIds', width: '140px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{(row.retrievedChunkIds || []).join(', ') || '—'}</span> },
    { header: 'Similarity Scores', accessor: 'similarityScores', width: '140px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{(row.similarityScores || []).join(', ') || '—'}</span> },
    { header: 'Generated Answer', accessor: 'chatbotAnswer', width: '220px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.chatbotAnswer || '—'}</span> },
    { header: 'Reference Answer', accessor: 'referenceAnswer', width: '220px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.referenceAnswer || '—'}</span> },
    { header: 'Timestamp', accessor: 'timestamp', width: '140px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.timestamp || '—'}</span> },
  ];

  const renderDetailSection = (label, value) => (
    <div className="rounded-lg border border-slate-800/70 bg-[#0B1119] p-3">
      <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-slate-200">{value || '—'}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-800/80 bg-[#111827]/95 p-3 shadow-panel">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Golden dataset workspace</p>
            <h2 className="mt-2 text-2xl font-semibold text-white">Golden Dataset</h2>
          </div>
          <div className="flex w-full max-w-md items-center gap-2 rounded-lg border border-slate-800 bg-[#0B1119] px-3 py-2 text-sm text-slate-300">
            <Search size={16} className="text-slate-500" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search dataset" className="w-full bg-transparent outline-none" />
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <div className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Dataset Version</p>
            <p className="mt-2 text-lg font-semibold text-white">{summary.version}</p>
          </div>
          <div className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Total Questions</p>
            <p className="mt-2 text-lg font-semibold text-white">{summary.totalQuestions}</p>
          </div>
          <div className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Last Upload</p>
            <p className="mt-2 text-lg font-semibold text-white">{formatDate(summary.lastUpload)}</p>
          </div>
          <div className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Last Evaluation</p>
            <p className="mt-2 text-lg font-semibold text-white">{formatDate(summary.lastEvaluation)}</p>
          </div>
          <div className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Average Faithfulness</p>
            <p className="mt-2 text-lg font-semibold text-white">{summary.avgFaithfulness}</p>
          </div>
          <div className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3">
            <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Average Answer Correctness</p>
            <p className="mt-2 text-lg font-semibold text-white">{summary.avgAnswerCorrectness}</p>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-800/80 bg-[#111827]/95 p-3 shadow-panel">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Upload and evaluation</p>
            <h3 className="mt-1 text-lg font-semibold text-white">Dataset controls</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 bg-[#0B1119] px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-[#0F9D58]">
              <UploadCloud size={16} />
              {uploading ? 'Uploading…' : 'Upload Excel'}
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} />
            </label>
            <button onClick={handleReplace} className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-[#0B1119] px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-[#0F9D58]">
              <RefreshCw size={16} />
              Replace Dataset
            </button>
            <button onClick={handleRunEvaluation} className="inline-flex items-center gap-2 rounded-lg border border-[#0F9D58] bg-[#0F9D58]/15 px-3 py-2 text-sm font-medium text-[#9BE6B2] transition hover:bg-[#0F9D58]/25">
              <FileUp size={16} />
              Run Evaluation
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3 shadow-panel">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Dataset table</p>
            <p className="mt-1 text-sm text-slate-400">{sortedRecords.length} records</p>
          </div>
        </div>

        {loading ? (
          <div className="rounded-lg border border-slate-800/80 bg-[#0B1119] p-4 text-sm text-slate-400">Loading dataset…</div>
        ) : (
          <>
            <DataTable columns={datasetColumns} rows={pagedRecords} />
            <div className="mt-3 flex items-center justify-between text-sm text-slate-400">
              <span>Page {page} of {totalPages}</span>
              <div className="flex gap-2">
                <button disabled={page === 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))} className="rounded-lg border border-slate-800 bg-[#0B1119] px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
                <button disabled={page === totalPages} onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} className="rounded-lg border border-slate-800 bg-[#0B1119] px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">Next</button>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3 shadow-panel">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Evaluation results</p>
            <p className="mt-1 text-sm text-slate-400">One row per evaluated question</p>
          </div>
        </div>

        {evaluationsLoading ? (
          <div className="rounded-lg border border-slate-800/80 bg-[#0B1119] p-4 text-sm text-slate-400">Loading evaluations…</div>
        ) : (
          <DataTable columns={evaluationColumns} rows={evaluations} onRowClick={(row) => setSelectedEvaluation(row)} />
        )}
      </section>

      <Drawer open={Boolean(selectedEvaluation)} title={selectedEvaluation?.question || 'Evaluation details'} onClose={() => setSelectedEvaluation(null)}>
        {selectedEvaluation ? (
          <div className="space-y-3">
            {renderDetailSection('Retrieved chunks', (selectedEvaluation.retrievedChunks || []).join('\n'))}
            {renderDetailSection('Complete chatbot answer', selectedEvaluation.chatbotAnswer)}
            {renderDetailSection('Reference answer', selectedEvaluation.referenceAnswer)}
            {renderDetailSection('RAGAS metrics', [
              `Faithfulness: ${selectedEvaluation.faithfulness ?? '—'}`,
              `Answer Relevancy: ${selectedEvaluation.answerRelevancy ?? '—'}`,
              `Context Precision: ${selectedEvaluation.contextPrecision ?? '—'}`,
              `Context Recall: ${selectedEvaluation.contextRecall ?? '—'}`,
              `Answer Correctness: ${selectedEvaluation.answerCorrectness ?? '—'}`,
              `Retrieval Time: ${selectedEvaluation.retrievalTime ?? '—'}`,
              `LLM Time: ${selectedEvaluation.llmTime ?? '—'}`,
            ].join('\n'))}
            {renderDetailSection('Metadata', [
              `Status: ${selectedEvaluation.status || '—'}`,
              `Question ID: ${selectedEvaluation.metadata?.questionId || '—'}`,
              `Dataset Version: ${selectedEvaluation.metadata?.datasetVersion || '—'}`,
              `Provider: ${selectedEvaluation.metadata?.provider || '—'}`,
              `Model: ${selectedEvaluation.metadata?.model || '—'}`,
              `Timestamp: ${selectedEvaluation.timestamp || '—'}`,
              `Error: ${selectedEvaluation.metadata?.error || '—'}`,
            ].join('\n'))}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
