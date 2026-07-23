import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, Loader2, Search, RefreshCw, UploadCloud } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FileUp, Search, RefreshCw, UploadCloud } from 'lucide-react';
import DataTable from '../components/DataTable';
import Drawer from '../components/Drawer';
import MetricCard from '../components/MetricCard';
import MarkdownContent from '../components/MarkdownContent';

const PAGE_SIZE = 10;

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
}

function mergeUniqueRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = row?.requestId || `${row?.question || 'question'}::${row?.timestamp || row?.metadata?.timestamp || 'missing'}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export default function GoldenDatasetPage() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generationStatus, setGenerationStatus] = useState('idle');
  const [uploading, setUploading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState('id');
  const [sortDirection, setSortDirection] = useState('asc');
  const [summaryMeta, setSummaryMeta] = useState({
    version: '—',
    totalQuestions: 0,
    lastUpload: '—',
    lastEvaluation: '—',
    avgFaithfulness: '—',
    avgPiiLeakage: '—',
  });
  const [evaluations, setEvaluations] = useState([]);
  const [evaluationSessionId, setEvaluationSessionId] = useState(null);
  const [selectedEvaluation, setSelectedEvaluation] = useState(null);
  const [evaluationsLoading, setEvaluationsLoading] = useState(true);
  const [streamingEvaluation, setStreamingEvaluation] = useState(false);
  const [streamEvents, setStreamEvents] = useState([]);
  const [evaluationProgress, setEvaluationProgress] = useState({
    active: false,
    percentage: 0,
    currentRow: 0,
    completedRows: 0,
    remainingRows: 0,
    estimatedTimeSeconds: 0,
    startedAt: null,
  });
  const [evaluationState, setEvaluationState] = useState({
    evaluationInProgress: false,
    lastEvaluationStatus: null,
    lastEvaluatedVersion: null,
    evaluationStartedAt: null,
    recordCount: 0,
  });
  const eventSourceRef = useRef(null);
  const generationPollRef = useRef(null);
  const lastDatasetSignatureRef = useRef('');
  const lastEvaluationsSignatureRef = useRef('');
  const [evaluationRunning, setEvaluationRunning] = useState(false);
  const evaluationPollRef = useRef(null);

  const stopGenerationPolling = useCallback(() => {
    if (generationPollRef.current) {
      window.clearInterval(generationPollRef.current);
      generationPollRef.current = null;
    }
  }, []);

  const loadDataset = useCallback(async (options = {}) => {
    const { shouldShowLoading = false } = options;
    if (shouldShowLoading) {
      setLoading(true);
    }

    try {
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset');
      const payload = await response.json();
      const dataset = Array.isArray(payload.records) ? payload.records : [];
      const nextSignature = JSON.stringify({
        records: dataset.map((item) => ({
          question: item?.question || '',
          answer: item?.answer || '',
          reference: item?.reference || '',
          contexts: Array.isArray(item?.contexts) ? item.contexts : [],
          version: item?.version || '',
        })),
        version: payload.version || null,
        uploadedAt: payload.uploadedAt || null,
        generationStatus: payload.generationStatus || 'idle',
        evaluationState: payload.evaluationState || {},
        evaluationSessionId: payload.evaluationSessionId || null,
      });

      if (lastDatasetSignatureRef.current === nextSignature && !shouldShowLoading) {
        return;
      }
      lastDatasetSignatureRef.current = nextSignature;

      setRecords(dataset);
      setGenerationStatus(payload.generationStatus || 'idle');

      const versions = dataset.map((item) => item.version).filter(Boolean);

      setSummaryMeta({
        version: payload.version || versions[0] || '—',
        totalQuestions: dataset.length,
        lastUpload: payload.uploadedAt || dataset[0]?.uploadedAt || dataset[0]?.uploaded_at || '—',
        lastEvaluation: evaluations[0]?.lastEvaluation || evaluations[0]?.last_evaluation || '—',
        avgFaithfulness: faithfulnessValues.length ? `${(faithfulnessValues.reduce((sum, value) => sum + value, 0) / faithfulnessValues.length).toFixed(2)}%` : '—',
        avgAnswerCorrectness: correctnessValues.length ? `${(correctnessValues.reduce((sum, value) => sum + value, 0) / correctnessValues.length).toFixed(2)}%` : '—',
      });
      setEvaluationState({
        evaluationInProgress: payload.evaluationState?.evaluationInProgress || false,
        lastEvaluationStatus: payload.evaluationState?.lastEvaluationStatus || null,
        lastEvaluatedVersion: payload.evaluationState?.lastEvaluatedVersion || null,
        evaluationStartedAt: payload.evaluationState?.evaluationStartedAt || null,
        recordCount: payload.evaluationState?.recordCount ?? dataset.length,
      });
      setEvaluationSessionId(payload.evaluationSessionId || null);
      if (payload.generationStatus === 'completed' || payload.generationStatus === 'failed' || payload.generationStatus === 'idle') {
        stopGenerationPolling();
      }
      setSummary((prev) => ({
        ...prev,
        version: payload.version || versions[0] || '—',
        totalQuestions: dataset.length,
        lastUpload: payload.uploadedAt || dataset[0]?.uploadedAt || dataset[0]?.uploaded_at || '—',
      }));
    } catch (error) {
      console.error(error);
    } finally {
      if (shouldShowLoading) {
        setLoading(false);
      }
    }
  }, [stopGenerationPolling]);

  const loadEvaluations = useCallback(async () => {
    try {
      setEvaluationsLoading(true);
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset/evaluations');
      const payload = await response.json();
      const list = Array.isArray(payload.evaluations) ? payload.evaluations : [];
      setEvaluations(list);

      // Summary averages are derived here, from real completed runs, rather
      // than from a per-record field that's never actually written on
      // upload — that field was always empty, so these cards always showed
      // "—" regardless of how many evaluations had actually run.
      const completedRuns = list.filter((item) => item.status === 'completed' || item.status === 'partial');
      const faithfulnessValues = completedRuns.map((item) => Number(item.faithfulness)).filter(Number.isFinite);
      const piiLeakageValues = completedRuns.map((item) => Number(item.piiLeakage)).filter(Number.isFinite);
      const latestTimestamp = list.reduce((latest, item) => {
        if (!item.timestamp) return latest;
        return !latest || item.timestamp > latest ? item.timestamp : latest;
      }, null);

      setSummary((prev) => ({
        ...prev,
        lastEvaluation: latestTimestamp || '—',
        avgFaithfulness: faithfulnessValues.length
          ? `${((faithfulnessValues.reduce((sum, value) => sum + value, 0) / faithfulnessValues.length) * 100).toFixed(1)}%`
          : '—',
        avgPiiLeakage: piiLeakageValues.length
          ? `${((piiLeakageValues.reduce((sum, value) => sum + value, 0) / piiLeakageValues.length) * 100).toFixed(1)}%`
          : '—',
      }));
    } catch (error) {
      console.error('[Golden Dataset] Failed to load evaluations', error);
    } finally {
      setEvaluationsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDataset({ shouldShowLoading: true });
    loadEvaluations();
  }, [loadDataset, loadEvaluations]);
    return () => {
      if (evaluationPollRef.current) {
        window.clearInterval(evaluationPollRef.current);
        evaluationPollRef.current = null;
      }
    };
  }, []);

  const filteredRecords = useMemo(() => {
    const query = search.toLowerCase();
    return records.filter((row) => {
      const fields = [
        row.question,
        row.answer,
        row.reference,
        Array.isArray(row.contexts) ? row.contexts.join(' ') : '',
      ]
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

  const handleSort = useCallback((key) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  }, [sortKey]);

  const startEvaluationPolling = () => {
    setEvaluationRunning(true);
    if (evaluationPollRef.current) {
      window.clearInterval(evaluationPollRef.current);
    }
    let pollCount = 0;
    const maxPolls = 80; // ~20 minutes at 15s intervals
    evaluationPollRef.current = window.setInterval(() => {
      pollCount += 1;
      loadEvaluations();
      if (pollCount >= maxPolls) {
        window.clearInterval(evaluationPollRef.current);
        evaluationPollRef.current = null;
        setEvaluationRunning(false);
      }
    }, 15000);
  };

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      setUploading(true);
      setPage(1);
      setEvaluations([]);
      setStreamEvents([]);
      setEvaluationState({
        evaluationInProgress: false,
        lastEvaluationStatus: null,
        lastEvaluatedVersion: null,
        evaluationStartedAt: null,
        recordCount: 0,
      });
      setEvaluationProgress({
        active: false,
        percentage: 0,
        currentRow: 0,
        completedRows: 0,
        remainingRows: 0,
        estimatedTimeSeconds: 0,
        startedAt: null,
      });
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset/upload', {
        method: 'POST',
        body: formData,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Upload failed');
      setGenerationStatus(payload.generationStatus || 'processing');
      setEvaluationSessionId(payload.evaluationSessionId || null);
      stopGenerationPolling();
      if (payload.generationStatus === 'processing') {
        generationPollRef.current = window.setInterval(() => {
          loadDataset();
        }, 500);
      }
      await loadDataset();
      alert(payload.message || 'Dataset uploaded');

      // Upload auto-triggers a background evaluation run server-side —
      // poll so newly evaluated rows show up without a manual refresh.
      startEvaluationPolling();
    } catch (error) {
      alert(error.message || 'Upload failed');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }, [generationStatus, loadDataset, stopGenerationPolling, streamingEvaluation, uploading]);

  const handleReplace = useCallback(async () => {
    if (!window.confirm('Replace the current dataset?')) return;
    try {
      setUploading(true);
      const response = await fetch('http://127.0.0.1:3000/api/admin/golden-dataset', {
        method: 'DELETE',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Replace failed');
      setPage(1);
      setEvaluations([]);
      setStreamEvents([]);
      setEvaluationSessionId(null);
      setEvaluationState({
        evaluationInProgress: false,
        lastEvaluationStatus: null,
        lastEvaluatedVersion: null,
        evaluationStartedAt: null,
        recordCount: 0,
      });
      setEvaluationProgress({
        active: false,
        percentage: 0,
        currentRow: 0,
        completedRows: 0,
        remainingRows: 0,
        estimatedTimeSeconds: 0,
        startedAt: null,
      });
      await loadDataset();
      await loadEvaluations();
      window.setTimeout(() => loadEvaluations(), 2000);
      alert(payload.message || 'Dataset cleared');
    } catch (error) {
      alert(error.message || 'Replace failed');
    } finally {
      setUploading(false);
    }
  }, [loadDataset, loadEvaluations]);

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
      startEvaluationPolling();
    } catch (error) {
      alert(error.message || 'Evaluation failed');
    } finally {
      setUploading(false);
    }

    const source = new EventSource('http://127.0.0.1:3000/api/admin/golden-dataset/evaluate?stream=true');
    eventSourceRef.current = source;
    setStreamEvents([]);
    setStreamingEvaluation(true);
    setUploading(true);
    setEvaluationProgress({
      active: true,
      percentage: 0,
      currentRow: 0,
      completedRows: 0,
      remainingRows: summaryMeta.totalQuestions || 0,
      estimatedTimeSeconds: 0,
      startedAt: Date.now(),
    });

    source.addEventListener('row', (event) => {
      const payload = JSON.parse(event.data);
      const progress = payload || {};
      setStreamEvents((prev) => [progress, ...prev]);
      setEvaluationProgress((prev) => {
        const nextProgress = {
          active: true,
          percentage: Number.isFinite(progress.percentage) ? progress.percentage : prev.percentage || 0,
          currentRow: Number.isFinite(progress.currentRow) ? progress.currentRow : progress.current || prev.currentRow || 0,
          completedRows: Number.isFinite(progress.completedRows) ? progress.completedRows : progress.current || prev.completedRows || 0,
          remainingRows: Number.isFinite(progress.remainingRows) ? progress.remainingRows : Math.max(0, (summaryMeta.totalQuestions || 0) - (progress.current || prev.completedRows || 0)),
          estimatedTimeSeconds: Number.isFinite(progress.estimatedTimeSeconds) ? progress.estimatedTimeSeconds : prev.estimatedTimeSeconds || 0,
          startedAt: progress.startedAt || prev.startedAt || Date.now(),
        };
        return nextProgress;
      });
      if (progress.result) {
        setEvaluations((prev) => {
          const nextRow = {
            ...progress.result,
            id: progress.result.id || `${progress.result.question || 'question'}::${progress.result.timestamp || Date.now()}`,
          };
          const deduped = prev.filter((existing) => {
            const sameQuestion = (existing.question || '') === (nextRow.question || '');
            const sameTimestamp = (existing.timestamp || '') === (nextRow.timestamp || '');
            return !(sameQuestion && sameTimestamp);
          });
          return [...deduped, nextRow];
        });
      }
    });

    source.addEventListener('completion', (event) => {
      const payload = JSON.parse(event.data);
      setStreamingEvaluation(false);
      setUploading(false);
      setEvaluationProgress({
        active: false,
        percentage: 0,
        currentRow: 0,
        completedRows: 0,
        remainingRows: 0,
        estimatedTimeSeconds: 0,
        startedAt: null,
      });
      setEvaluationState((prev) => ({
        ...prev,
        evaluationInProgress: false,
      }));
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      loadDataset();
      loadEvaluations();
      alert(`Golden dataset evaluation completed: ${payload.success} succeeded, ${payload.failed} failed`);
    });

    source.addEventListener('error', () => {
      setStreamingEvaluation(false);
      setUploading(false);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    });
  }, [loadDataset, loadEvaluations, summaryMeta.totalQuestions]);

  useEffect(() => {
    if (!evaluationState.evaluationInProgress || streamingEvaluation) {
      return undefined;
    }

    startEvaluationStreaming();
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [evaluationState.evaluationInProgress, startEvaluationStreaming, streamingEvaluation]);

  const handleRunEvaluation = useCallback(() => {
    if (streamingEvaluation) return;
    startEvaluationStreaming();
  }, [startEvaluationStreaming, streamingEvaluation]);

  const formatShortText = (text) => {
    if (!text) return '—';
    const value = String(text).trim();
    return value.length <= 80 ? value : `${value.slice(0, 80)}...`;
  };

  const datasetColumns = useMemo(() => [
    {
      header: 'ID',
      accessor: 'id',
      width: '90px',
      render: (row) => (
        <button onClick={() => handleSort('id')} className="text-left text-ink">
          {row.id || '—'}
        </button>
      ),
    },
    {
      header: 'Question',
      accessor: 'question',
      width: '220px',
      render: (row) => (
        <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
          {row.question || '—'}
        </span>
      ),
    },
    {
      header: 'Generated Answer',
      accessor: 'answer',
      width: '260px',
      render: (row) => (
        <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
          {formatShortText(row.answer)}
        </span>
      ),
    },
    {
      header: 'Reference',
      accessor: 'reference',
      width: '220px',
      render: (row) => (
        <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
          {formatShortText(row.reference)}
        </span>
      ),
    },
    {
      header: 'Context',
      accessor: 'contexts',
      width: '260px',
      render: (row) => (
        <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
          {Array.isArray(row.contexts) && row.contexts.length
            ? formatShortText(row.contexts.join(' | '))
            : '—'}
        </span>
      ),
    },
    { header: 'Intent', accessor: 'intent', width: '140px' },
    { header: 'Source Table', accessor: 'sourceTable', width: '140px' },
    { header: 'Source Column', accessor: 'sourceColumn', width: '140px' },
    { header: 'Row Id', accessor: 'rowId', width: '100px' },
    { header: 'Notes', accessor: 'notes', width: '180px' },
  ], [handleSort]);

  const currentRunEvaluations = useMemo(() => {
    if (!evaluationState.lastEvaluatedVersion) return evaluations;
    return evaluations.filter((item) => (item.metadata?.datasetVersion ?? item.datasetVersion) === evaluationState.lastEvaluatedVersion);
  }, [evaluations, evaluationState.lastEvaluatedVersion]);

  const completedCount = useMemo(() => currentRunEvaluations.filter((row) => row.status === 'completed').length, [currentRunEvaluations]);
  const failedCount = useMemo(() => currentRunEvaluations.filter((row) => row.status === 'failed').length, [currentRunEvaluations]);
  const totalQuestions = summaryMeta.totalQuestions;
  const evaluationIsActive = Boolean(streamingEvaluation || evaluationState.evaluationInProgress || evaluationProgress.active);
  const progressPercentage = evaluationIsActive ? (evaluationProgress.percentage || 0) : 0;
  const progressCurrentRow = evaluationIsActive ? (evaluationProgress.currentRow || 0) : 0;
  const progressCompletedRows = evaluationIsActive ? (evaluationProgress.completedRows || 0) : 0;
  const progressRemainingRows = evaluationIsActive ? (evaluationProgress.remainingRows || 0) : 0;
  const formatDuration = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  };

  const evaluationColumns = useMemo(() => [
    { header: 'Question', accessor: 'question', width: '220px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.question || '—'}</span> },
    { header: 'Status', accessor: 'status', width: '100px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.status || '—'}</span> },
    { header: 'Faithfulness', accessor: 'faithfulness', width: '110px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.faithfulness ?? '—'}</span> },
    { header: 'Answer Relevancy', accessor: 'answerRelevancy', width: '130px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.answerRelevancy ?? '—'}</span> },
    { header: 'Context Precision', accessor: 'contextPrecision', width: '130px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.contextPrecision ?? '—'}</span> },
    { header: 'Context Recall', accessor: 'contextRecall', width: '120px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.contextRecall ?? '—'}</span> },
    { header: 'PII Leakage', accessor: 'piiLeakage', width: '110px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.piiLeakage ?? '—'}</span> },
    { header: 'Retrieved Chunks', accessor: 'retrievedChunks', width: '160px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{(row.retrievedChunks || []).join(', ') || '—'}</span> },
    { header: 'Chunk IDs', accessor: 'retrievedChunkIds', width: '140px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{(row.retrievedChunkIds || []).join(', ') || '—'}</span> },
    { header: 'Similarity Scores', accessor: 'similarityScores', width: '140px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{(row.similarityScores || []).join(', ') || '—'}</span> },
    { header: 'Generated Answer', accessor: 'chatbotAnswer', width: '220px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.chatbotAnswer || '—'}</span> },
    { header: 'Reference Answer', accessor: 'referenceAnswer', width: '220px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.referenceAnswer || '—'}</span> },
    { header: 'Timestamp', accessor: 'timestamp', width: '140px', render: (row) => <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap">{row.timestamp || '—'}</span> },
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
            <p className="text-[11px] uppercase tracking-[0.24em] text-muted">Golden dataset workspace</p>
            <h2 className="mt-2 text-2xl font-semibold text-ink">Golden Dataset</h2>
          </div>
          <div className="flex w-full max-w-md items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm text-ink">
            <Search size={16} className="text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search dataset" className="w-full bg-transparent outline-none" />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 divide-x divide-line">
          <MetricCard compact title="Version" value={summary.version} />
          <div className="pl-4"><MetricCard title="Questions" value={summary.totalQuestions} /></div>
          <div className="pl-4"><MetricCard compact title="Last Upload" value={formatDate(summary.lastUpload)} /></div>
          <div className="pl-4"><MetricCard compact title="Last Eval" value={formatDate(summary.lastEvaluation)} /></div>
          <div className="pl-4"><MetricCard title="Avg Faithfulness" value={summary.avgFaithfulness} /></div>
          <div className="pl-4"><MetricCard title="Avg PII Leakage" value={summary.avgPiiLeakage} /></div>
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
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleUpload} />
            </label>
            <button onClick={handleReplace} className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm font-medium text-ink transition hover:border-accent">
              <RefreshCw size={16} />
              Replace Dataset
            </button>
            <button
              onClick={handleRunEvaluation}
              disabled={evaluationRunning}
              className="inline-flex items-center gap-2 rounded-lg border border-accent bg-accent/15 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {evaluationRunning ? <RefreshCw size={16} className="animate-spin" /> : <FileUp size={16} />}
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
          <p className="text-[11px] uppercase tracking-[0.24em] text-muted">Dataset table</p>
          <p className="mt-1 text-sm text-muted">{sortedRecords.length} records</p>
        </div>
      </div>

      {loading || generationStatus === 'processing' ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-muted p-4 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          <span>
            {loading ? 'Loading dataset…' : 'Generating dataset rows…'}
          </span>
        </div>
      ) : generationStatus === 'failed' ? (
        <div className="rounded-lg border border-red-500/40 bg-surface-muted p-4 text-sm text-red-400">
          Dataset generation failed. Please upload the file again.
        </div>
      ) : (
      ): (
          <>
            <DataTable columns = { datasetColumns } rows = { pagedRecords } />
      <div className="mt-3 flex items-center justify-between text-sm text-muted">
        <span>Page {page} of {totalPages}</span>
        <div className="flex gap-2">
          <button disabled={page === 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))} className="rounded-lg border border-line bg-surface-muted px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
          <button disabled={page === totalPages} onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} className="rounded-lg border border-line bg-surface-muted px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50">Next</button>
        </div>
      </div>
    </>
        )
}
      </section >

<section className="rounded-lg border border-line bg-surface p-3">
  <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <div className="flex items-center gap-2">
        <p className="text-[11px] uppercase tracking-[0.24em] text-muted">
          Evaluation progress
        </p>
        {evaluationIsActive && (
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Updates appear only after a question finishes evaluation.
      </p>
    </div>

    <div className="flex flex-wrap items-center gap-3 text-sm text-ink">
      {streamingEvaluation && (
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-muted px-3 py-1">
          <Loader2 className="h-4 w-4 animate-spin" />
          Evaluating
        </span>
      )}

      <span>
        Completed: <span className="font-semibold">{progressCompletedRows}</span>
      </span>

      <span>
        Remaining: <span className="font-semibold">{progressRemainingRows}</span>
      </span>

      <span>
        Current row: <span className="font-semibold">{progressCurrentRow || "—"}</span>
      </span>

      <span>
        Estimated time:{" "}
        <span className="font-semibold">
          {formatDuration(evaluationProgress.estimatedTimeSeconds)}
        </span>
      </span>
    </div>
  </div>

  <div className="rounded-lg border border-line bg-surface-muted p-3">
    <div className="flex items-center justify-between text-sm text-muted">
      <span>
        {evaluationIsActive
          ? `Evaluating row ${progressCurrentRow || 0} of ${totalQuestions || 0}`
          : "Waiting for evaluation to start"}
      </span>

      <span className="font-semibold">
        {evaluationIsActive ? `${progressPercentage}%` : "0%"}
      </span>
    </div>

    <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-800">
      <div
        className={`h-full rounded-full transition-all duration-500 ${
          progressPercentage === 100 ? "bg-emerald-500" : "bg-accent"
        }`}
        style={{ width: `${Math.min(100, progressPercentage)}%` }}
      />
    </div>
  </div>
</section>

<section className="rounded-lg border border-line bg-surface p-3">
  <div className="mb-3 flex items-center justify-between">
    <div>
      <p className="text-[11px] uppercase tracking-[0.24em] text-muted">
        Evaluation results
      </p>
      <p className="mt-1 text-sm text-muted">
        One row per evaluated question
      </p>
          </div>
        </div>

        {evaluationsLoading ? (
{loadingEvaluations ? (
  <div className="rounded-lg border border-line bg-surface-muted p-4 text-sm text-muted">
    Loading evaluations…
  </div>
) : evaluations.length === 0 ? (
  <div className="rounded-lg border border-line bg-surface-muted p-4 text-sm text-muted">
    No golden dataset evaluation results available yet.
  </div>
) : (
        ) : (
          <DataTable columns={evaluationColumns} rows={evaluations} onRowClick={(row) => setSelectedEvaluation(row)} />
        )}
      </section>

      <Drawer open={Boolean(selectedEvaluation)} title={selectedEvaluation?.question || 'Evaluation details'} onClose={() => setSelectedEvaluation(null)}>
        {selectedEvaluation ? (
          <div className="space-y-3">
            {renderDetailSection('Retrieved chunks', (selectedEvaluation.retrievedChunks || []).join('\n'))}
            {renderMarkdownSection('Complete chatbot answer', selectedEvaluation.chatbotAnswer)}
            {renderDetailSection('Reference answer', selectedEvaluation.referenceAnswer)}
            {renderDetailSection('Evaluation metrics', [
              `Faithfulness: ${selectedEvaluation.faithfulness ?? '—'}`,
              `Answer Relevancy: ${selectedEvaluation.answerRelevancy ?? '—'}`,
              `Context Precision: ${selectedEvaluation.contextPrecision ?? '—'}`,
              `Context Recall: ${selectedEvaluation.contextRecall ?? '—'}`,
              `PII Leakage: ${selectedEvaluation.piiLeakage ?? '—'}`,
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
    </div >
  );
}
