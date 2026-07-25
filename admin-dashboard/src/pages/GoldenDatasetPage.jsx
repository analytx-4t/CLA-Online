import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, Loader2, RefreshCw, Search, UploadCloud } from 'lucide-react';
import DataTable from '../components/DataTable';
import Drawer from '../components/Drawer';
import MetricCard from '../components/MetricCard';
import MarkdownContent from '../components/MarkdownContent';

const PAGE_SIZE = 10;
const EVAL_PAGE_SIZE = 10;
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 240; // ~20 minutes at 5s intervals

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatMetric(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(2);
}

function averageOf(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? formatPercent(finite.reduce((sum, value) => sum + value, 0) / finite.length) : '—';
}

export default function GoldenDatasetPage() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generationStatus, setGenerationStatus] = useState('idle');
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [version, setVersion] = useState(null);
  const [uploadedAt, setUploadedAt] = useState(null);
  const [totalUploadsCount, setTotalUploadsCount] = useState(0);
  const [evaluationState, setEvaluationState] = useState({
    evaluationInProgress: false,
    lastEvaluationStatus: null,
    lastEvaluatedVersion: null,
    evaluationStartedAt: null,
    recordCount: 0,
  });

  const [evaluations, setEvaluations] = useState([]);
  const [evalPage, setEvalPage] = useState(1);
  const [evaluationsLoading, setEvaluationsLoading] = useState(true);
  const [selectedEvaluation, setSelectedEvaluation] = useState(null);

  const pollRef = useRef(null);
  const pollCountRef = useRef(0);

  const loadDataset = useCallback(async ({ showLoader = false } = {}) => {
    if (showLoader) setLoading(true);
    try {
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset');
      const payload = await response.json();
      const dataset = Array.isArray(payload.records) ? payload.records : [];
      setRecords(dataset);
      setGenerationStatus(payload.generationStatus || 'idle');
      setVersion(payload.version || null);
      setUploadedAt(payload.uploadedAt || null);
      setTotalUploadsCount(Number.isFinite(payload.totalUploadsCount) ? payload.totalUploadsCount : 0);
      setEvaluationState({
        evaluationInProgress: Boolean(payload.evaluationState?.evaluationInProgress),
        lastEvaluationStatus: payload.evaluationState?.lastEvaluationStatus || null,
        lastEvaluatedVersion: payload.evaluationState?.lastEvaluatedVersion || null,
        evaluationStartedAt: payload.evaluationState?.evaluationStartedAt || null,
        recordCount: payload.evaluationState?.recordCount ?? dataset.length,
      });
    } catch (error) {
      console.error('[Golden Dataset] Failed to load dataset', error);
    } finally {
      if (showLoader) setLoading(false);
    }
  }, []);

  const loadEvaluations = useCallback(async () => {
    try {
      setEvaluationsLoading(true);
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset/evaluations');
      const payload = await response.json();
      const list = Array.isArray(payload.evaluations) ? payload.evaluations : [];
      setEvaluations(list);
    } catch (error) {
      console.error('[Golden Dataset] Failed to load evaluations', error);
    } finally {
      setEvaluationsLoading(false);
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollCountRef.current = 0;
    pollRef.current = window.setInterval(async () => {
      pollCountRef.current += 1;
      await Promise.all([loadDataset(), loadEvaluations()]);
      if (pollCountRef.current >= MAX_POLLS) {
        stopPolling();
      }
    }, POLL_INTERVAL_MS);
  }, [loadDataset, loadEvaluations, stopPolling]);

  useEffect(() => {
    loadDataset({ showLoader: true });
    loadEvaluations();
    return stopPolling;
  }, [loadDataset, loadEvaluations, stopPolling]);

  // Evaluation runs entirely server-side (each row is a full answer
  // generation plus a 5-metric judge pass, so realistically a minute or
  // more per question). Keep polling in sync with the backend's own state
  // — this also picks a run back up if the page is reloaded mid-run,
  // instead of only starting from the "Run Evaluation" click.
  useEffect(() => {
    const isActive = generationStatus === 'evaluating' || evaluationState.evaluationInProgress;
    if (isActive) {
      startPolling();
    } else {
      stopPolling();
    }
  }, [generationStatus, evaluationState.evaluationInProgress, startPolling, stopPolling]);

  const evaluationRunning = generationStatus === 'evaluating' || evaluationState.evaluationInProgress;

  const summary = useMemo(() => {
    const completedEvaluations = evaluations.filter((row) => row.status === 'completed');
    const latestTimestamp = evaluations.reduce((latest, row) => {
      if (!row.timestamp) return latest;
      return !latest || row.timestamp > latest ? row.timestamp : latest;
    }, null);

    return {
      version: version || '—',
      totalQuestions: records.length,
      lastUpload: uploadedAt,
      lastEvaluation: latestTimestamp,
      totalUploads: totalUploadsCount,
      avgFaithfulness: averageOf(completedEvaluations.map((row) => row.faithfulness)),
      avgAnswerRelevancy: averageOf(completedEvaluations.map((row) => row.answerRelevancy)),
      avgAnswerCorrectness: averageOf(completedEvaluations.map((row) => row.answerCorrectness)),
      avgContextPrecision: averageOf(completedEvaluations.map((row) => row.contextPrecision)),
      avgContextRecall: averageOf(completedEvaluations.map((row) => row.contextRecall)),
    };
  }, [records.length, version, uploadedAt, totalUploadsCount, evaluations]);

  const filteredRecords = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return records;
    return records.filter((row) => {
      const fields = [row.question, row.answer, row.reference, Array.isArray(row.contexts) ? row.contexts.join(' ') : '']
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return fields.includes(query);
    });
  }, [records, search]);

  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pagedRecords = useMemo(() => {
    const start = (clampedPage - 1) * PAGE_SIZE;
    return filteredRecords.slice(start, start + PAGE_SIZE).map((row, index) => ({
      ...row,
      rowNumber: start + index + 1,
    }));
  }, [filteredRecords, clampedPage]);

  const totalEvalPages = Math.max(1, Math.ceil(evaluations.length / EVAL_PAGE_SIZE));
  const clampedEvalPage = Math.min(evalPage, totalEvalPages);
  const pagedEvaluations = useMemo(() => {
    const start = (clampedEvalPage - 1) * EVAL_PAGE_SIZE;
    return evaluations.slice(start, start + EVAL_PAGE_SIZE);
  }, [evaluations, clampedEvalPage]);

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

      setEvaluations([]);
      setPage(1);
      setEvalPage(1);
      await loadDataset({ showLoader: true });
      alert(payload.message || 'Dataset uploaded. Click Run Evaluation to generate answers and evaluate the dataset.');
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
      stopPolling();
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset', {
        method: 'DELETE',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Replace failed');
      setPage(1);
      setEvalPage(1);
      setEvaluations([]);
      await loadDataset({ showLoader: true });
      await loadEvaluations();
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

      // The run itself happens server-side in the background — each question
      // is a full answer generation plus a 5-metric LLM-judge evaluation, so
      // realistically a minute or more per question. Poll for fresh rows
      // instead of waiting on one long request (which used to make this
      // button look stuck).
      alert(payload.message || 'Evaluation started');
      startPolling();
    } catch (error) {
      alert(error.message || 'Evaluation failed');
    } finally {
      setUploading(false);
    }
  };

  const datasetColumns = [
    { header: '#', accessor: 'rowNumber', width: '6%' },
    { header: 'Question', accessor: 'question', width: '22%' },
    { header: 'Generated Answer', accessor: 'answer', width: '22%', render: (row) => row.answer || '—' },
    { header: 'Reference', accessor: 'reference', width: '20%', render: (row) => row.reference || '—' },
    { header: 'Context', accessor: 'contexts', width: '20%', render: (row) => (Array.isArray(row.contexts) && row.contexts.length ? row.contexts.join(' | ') : '—') },
    { header: 'Status', accessor: 'status', width: '10%', render: (row) => row.status || '—' },
  ];

  // Long array-joined fields (retrieved context) and free text (answers) can
  // run to hundreds of characters — wrapping them without a cap makes every
  // row balloon vertically. Clamp to 2 lines and let the native title
  // tooltip carry the full value on hover.
  const clampCell = (text) => (
    <span title={text || undefined} className="line-clamp-2">{text || '—'}</span>
  );

  const evaluationColumns = [
    { header: 'Question', accessor: 'question', width: '12%', render: (row) => clampCell(row.question) },
    { header: 'Status', accessor: 'status', width: '6%', render: (row) => row.status || '—' },
    { header: 'Faithfulness', accessor: 'faithfulness', width: '7%', render: (row) => formatMetric(row.faithfulness) },
    { header: 'Answer Relevancy', accessor: 'answerRelevancy', width: '7%', render: (row) => formatMetric(row.answerRelevancy) },
    { header: 'Context Precision', accessor: 'contextPrecision', width: '7%', render: (row) => formatMetric(row.contextPrecision) },
    { header: 'Context Recall', accessor: 'contextRecall', width: '7%', render: (row) => formatMetric(row.contextRecall) },
    { header: 'Answer Correctness', accessor: 'answerCorrectness', width: '7%', render: (row) => formatMetric(row.answerCorrectness) },
    { header: 'Overall Score', accessor: 'overallScore', width: '7%', render: (row) => formatMetric(row.overallScore) },
    { header: 'Retrieved Context', accessor: 'retrievedChunks', width: '12%', render: (row) => clampCell((row.retrievedChunks || row.contexts || []).join(', ')) },
    { header: 'Generated Answer', accessor: 'chatbotAnswer', width: '12%', render: (row) => clampCell(row.chatbotAnswer || row.generatedAnswer) },
    { header: 'Reference Answer', accessor: 'referenceAnswer', width: '10%', render: (row) => clampCell(row.referenceAnswer) },
    { header: 'Timestamp', accessor: 'timestamp', width: '6%', render: (row) => formatDate(row.timestamp) },
  ];

  const renderDetailSection = (label, value) => (
    <div className="rounded-lg border border-line bg-surface-muted p-3">
      <p className="text-[10px] uppercase tracking-[0.24em] text-muted">{label}</p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{value || '—'}</p>
    </div>
  );

  const renderMarkdownSection = (label, value) => (
    <div className="rounded-lg border border-line bg-surface-muted p-3">
      <p className="text-[10px] uppercase tracking-[0.24em] text-muted">{label}</p>
      <div className="mt-2">
        <MarkdownContent content={value} />
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-line bg-surface p-3 ">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-muted">Evaluation Metrics</p>
          </div>
          <div className="flex w-full max-w-md items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-ink">
            <Search size={16} className="text-muted" />
            <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Search dataset" className="w-full bg-transparent outline-none" />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-line">
          <MetricCard compact title="Version" value={summary.version} />
          <div className="pl-4"><MetricCard title="Questions" value={summary.totalQuestions} /></div>
          <div className="pl-4"><MetricCard compact title="Last Upload" value={formatDate(summary.lastUpload)} /></div>
          <div className="pl-4"><MetricCard compact title="Last Eval" value={formatDate(summary.lastEvaluation)} /></div>
          <div className="pl-4"><MetricCard title="Total Uploaded Dataset" value={summary.totalUploads} /></div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-line border-t border-line pt-4">
          <MetricCard title="Avg Faithfulness" value={summary.avgFaithfulness} />
          <div className="pl-4"><MetricCard title="Avg Answer Relevance" value={summary.avgAnswerRelevancy} /></div>
          <div className="pl-4"><MetricCard title="Avg Answer Correctness" value={summary.avgAnswerCorrectness} /></div>
          <div className="pl-4"><MetricCard title="Avg Context Precision" value={summary.avgContextPrecision} /></div>
          <div className="pl-4"><MetricCard title="Avg Context Recall" value={summary.avgContextRecall} /></div>
        </div>
      </section>

      <section className="rounded-lg border border-line bg-surface p-3 ">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-muted">Upload and evaluation</p>
            <h3 className="mt-1 text-lg font-semibold text-ink">Dataset controls</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm font-medium text-ink transition hover:border-accent">
              <UploadCloud size={16} />
              {uploading ? 'Uploading…' : 'Upload Excel'}
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} disabled={uploading || evaluationRunning} />
            </label>
            <button onClick={handleReplace} disabled={uploading || evaluationRunning} className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm font-medium text-ink transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-60">
              <RefreshCw size={16} />
              Replace Dataset
            </button>
            <button
              onClick={handleRunEvaluation}
              disabled={uploading || evaluationRunning || records.length === 0}
              className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {evaluationRunning ? <Loader2 size={16} className="animate-spin" /> : <FileUp size={16} />}
              {evaluationRunning ? 'Evaluating…' : 'Run Evaluation'}
            </button>
          </div>
        </div>
        {evaluationRunning && (
          <p className="mt-2 text-xs text-muted">
            Running in the background — each question takes roughly a minute or more (full answer generation plus a 5-metric evaluation). New rows will appear below as they finish.
          </p>
        )}
      </section>

      <section className="rounded-lg border border-line bg-surface p-3 ">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-muted">Evaluation results</p>
            <p className="mt-1 text-sm text-muted">{evaluations.length} evaluated question{evaluations.length === 1 ? '' : 's'}</p>
          </div>
        </div>

        {evaluationsLoading ? (
          <div className="rounded-lg border border-line bg-surface-muted p-4 text-sm text-muted">Loading evaluations…</div>
        ) : evaluations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-surface-muted p-6 text-center text-sm text-muted">No golden dataset evaluation results available yet.</div>
        ) : (
          <>
            <DataTable columns={evaluationColumns} rows={pagedEvaluations} onRowClick={(row) => setSelectedEvaluation(row)} fit maxHeight="360px" />
            <div className="mt-3 flex items-center justify-between text-sm text-muted">
              <span>Page {clampedEvalPage} of {totalEvalPages}</span>
              <div className="flex gap-2">
                <button disabled={clampedEvalPage === 1} onClick={() => setEvalPage((prev) => Math.max(1, prev - 1))} className="rounded-lg border border-line bg-surface-muted px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
                <button disabled={clampedEvalPage === totalEvalPages} onClick={() => setEvalPage((prev) => Math.min(totalEvalPages, prev + 1))} className="rounded-lg border border-line bg-surface-muted px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">Next</button>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="rounded-lg border border-line bg-surface p-3 ">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-muted">Dataset table</p>
            <p className="mt-1 text-sm text-muted">{filteredRecords.length} records</p>
          </div>
        </div>

        {loading ? (
          <div className="rounded-lg border border-line bg-surface-muted p-4 text-sm text-muted">Loading dataset…</div>
        ) : records.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-surface-muted p-6 text-center text-sm text-muted">No dataset uploaded yet.</div>
        ) : (
          <>
            <DataTable columns={datasetColumns} rows={pagedRecords} />
            <div className="mt-3 flex items-center justify-between text-sm text-muted">
              <span>Page {clampedPage} of {totalPages}</span>
              <div className="flex gap-2">
                <button disabled={clampedPage === 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))} className="rounded-lg border border-line bg-surface-muted px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
                <button disabled={clampedPage === totalPages} onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} className="rounded-lg border border-line bg-surface-muted px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">Next</button>
              </div>
            </div>
          </>
        )}
      </section>

      <Drawer open={Boolean(selectedEvaluation)} title={selectedEvaluation?.question || 'Evaluation details'} onClose={() => setSelectedEvaluation(null)}>
        {selectedEvaluation ? (
          <div className="space-y-3">
            {renderDetailSection('Retrieved context', (selectedEvaluation.retrievedChunks || selectedEvaluation.contexts || []).join('\n'))}
            {renderMarkdownSection('Complete chatbot answer', selectedEvaluation.chatbotAnswer || selectedEvaluation.generatedAnswer)}
            {renderDetailSection('Reference answer', selectedEvaluation.referenceAnswer)}
            {renderDetailSection('Evaluation metrics', [
              `Faithfulness: ${formatMetric(selectedEvaluation.faithfulness)}`,
              `Answer Relevancy: ${formatMetric(selectedEvaluation.answerRelevancy)}`,
              `Context Precision: ${formatMetric(selectedEvaluation.contextPrecision)}`,
              `Context Recall: ${formatMetric(selectedEvaluation.contextRecall)}`,
              `Answer Correctness: ${formatMetric(selectedEvaluation.answerCorrectness)}`,
              `Overall Score: ${formatMetric(selectedEvaluation.overallScore)}`,
            ].join('\n'))}
            {renderDetailSection('Metadata', [
              `Status: ${selectedEvaluation.status || '—'}`,
              `Evaluation Session: ${selectedEvaluation.evaluationSessionId || '—'}`,
              `Timestamp: ${selectedEvaluation.timestamp || '—'}`,
              `Error: ${selectedEvaluation.error || '—'}`,
            ].join('\n'))}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
