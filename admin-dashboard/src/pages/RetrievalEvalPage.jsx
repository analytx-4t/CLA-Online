import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  Sparkles,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronUp,
  Download,
  AlertTriangle,
  CheckCircle2,
  BrainCircuit,
  FileText,
  Layers,
  Target,
  BookOpen
} from 'lucide-react';

const API_BASE = '/api/admin/eval/retrieval';

const SAMPLE_LEGAL_CASE = {
  question: 'What are the statutory requirements and approval thresholds for Related Party Transactions under Section 188 of the Companies Act 2013?',
  expectedAnswer: 'Section 188 of the Companies Act 2013 requires prior approval of the Audit Committee for all related party transactions. Board approval is required for specified transactions, and shareholder approval by ordinary resolution is required if transaction thresholds exceed statutory limits specified in Rule 15 of Companies (Meetings of Board and its Powers) Rules, 2014.',
  generatedAnswer: 'Under Section 188 of Companies Act 2013, related party transactions require prior consent of the Audit Committee. Board consent is mandatory for contracts with related parties. Shareholder approval via ordinary resolution is required if thresholds in Rule 15 are breached.'
};

export default function RetrievalEvalPage() {
  const [question, setQuestion] = useState('');
  const [expectedAnswer, setExpectedAnswer] = useState('');
  const [generatedAnswer, setGeneratedAnswer] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [currentResult, setCurrentResult] = useState(null);
  const [error, setError] = useState(null);

  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [scoreFilter, setScoreFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    setLoadingHistory(true);
    try {
      const res = await fetch(API_BASE);
      const data = await res.json();
      if (data.success) {
        setHistory(data.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch retrieval eval history', err);
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleLoadSample = () => {
    setQuestion(SAMPLE_LEGAL_CASE.question);
    setExpectedAnswer(SAMPLE_LEGAL_CASE.expectedAnswer);
    setGeneratedAnswer(SAMPLE_LEGAL_CASE.generatedAnswer);
    setError(null);
  };

  const handleEvaluate = async (e) => {
    e.preventDefault();
    if (!question.trim() || !expectedAnswer.trim() || !generatedAnswer.trim()) {
      setError('Please provide Question, Expected Answer, and Generated Answer.');
      return;
    }

    setEvaluating(true);
    setError(null);
    setCurrentResult(null);

    try {
      const res = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, expectedAnswer, generatedAnswer }),
      });
      const data = await res.json();
      if (data.success) {
        setCurrentResult(data.data);
        fetchHistory();
      } else {
        setError(data.error || 'Evaluation failed.');
      }
    } catch (err) {
      setError(err.message || 'Network error during evaluation.');
    } finally {
      setEvaluating(false);
    }
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this evaluation record?')) return;
    setDeletingId(id);
    try {
      const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setHistory((prev) => prev.filter((item) => item.id !== id));
        if (currentResult?.id === id) setCurrentResult(null);
      }
    } catch (err) {
      console.error('Failed to delete record', err);
    } finally {
      setDeletingId(null);
    }
  };

  const handleClearHistory = async () => {
    if (!window.confirm('Are you sure you want to clear all retrieval evaluation history? This action cannot be undone.')) return;
    try {
      const res = await fetch(`${API_BASE}/clear`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setHistory([]);
        setCurrentResult(null);
      }
    } catch (err) {
      console.error('Failed to clear history', err);
    }
  };

  const handleExportCSV = () => {
    if (history.length === 0) return;
    const headers = ['ID', 'Question', 'Expected Answer', 'Generated Answer', 'Context Precision', 'Context Recall', 'Overall Score', 'Next Best Action', 'Date'];
    const rows = history.map((item) => [
      `"${item.id}"`,
      `"${(item.question || '').replace(/"/g, '""')}"`,
      `"${(item.expectedAnswer || '').replace(/"/g, '""')}"`,
      `"${(item.generatedAnswer || '').replace(/"/g, '""')}"`,
      item.contextPrecision ?? '',
      item.contextRecall ?? '',
      item.overallScore ?? '',
      `"${(item.nextBestAction || '').replace(/"/g, '""')}"`,
      `"${item.createdAt}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `retrieval_evaluations_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredHistory = history.filter((item) => {
    const q = (item.question || '').toLowerCase();
    const exp = (item.expectedAnswer || '').toLowerCase();
    const gen = (item.generatedAnswer || '').toLowerCase();
    const s = searchTerm.toLowerCase();
    const matchesSearch = q.includes(s) || exp.includes(s) || gen.includes(s);

    if (!matchesSearch) return false;
    if (scoreFilter === 'high') return (item.overallScore || 0) >= 0.8;
    if (scoreFilter === 'needs_improvement') return (item.overallScore || 0) < 0.8;
    return true;
  });

  const getScoreBadge = (score) => {
    if (score === null || score === undefined) return 'bg-gray-500/10 text-gray-400 border-gray-500/20';
    if (score >= 0.8) return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
    if (score >= 0.6) return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    return 'bg-rose-500/10 text-rose-400 border-rose-500/20';
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between border-b border-sidebar-line pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-white tracking-tight">Retrieval Evaluation</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-xs font-semibold text-accent">
              <BrainCircuit className="h-3 w-3" />
              DeepEval + DeepSeek v4 Pro
            </span>
          </div>
          <p className="mt-1 text-sm text-sidebar-muted">
            Benchmark context retrieval quality using <b>Contextual Precision</b> and <b>Contextual Recall</b> metrics.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleLoadSample}
            className="flex items-center gap-1.5 rounded-lg border border-sidebar-line bg-sidebar-muted-bg px-3 py-2 text-xs font-medium text-sidebar-ink transition hover:border-accent hover:text-accent"
          >
            <BookOpen size={14} />
            Load Legal Sample Case
          </button>
        </div>
      </div>

      {/* Input Form Card */}
      <form onSubmit={handleEvaluate} className="rounded-xl border border-sidebar-line bg-sidebar p-5 shadow-lg space-y-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Input 1: Question */}
          <div className="space-y-1.5">
            <label className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-sidebar-muted">
              <span>Question (User Query)</span>
              <span className="text-[10px] text-accent font-normal">Required</span>
            </label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={4}
              placeholder="e.g. What are the requirements for related party transactions under Section 188?"
              className="w-full rounded-lg border border-sidebar-line bg-black/30 p-3 text-sm text-sidebar-ink placeholder-sidebar-muted/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              required
            />
          </div>

          {/* Input 2: Expected Answer */}
          <div className="space-y-1.5">
            <label className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-sidebar-muted">
              <span>Expected Answer (Ground Truth)</span>
              <span className="text-[10px] text-accent font-normal">Required</span>
            </label>
            <textarea
              value={expectedAnswer}
              onChange={(e) => setExpectedAnswer(e.target.value)}
              rows={4}
              placeholder="e.g. Audit Committee approval, Board consent, Ordinary resolution under Rule 15..."
              className="w-full rounded-lg border border-sidebar-line bg-black/30 p-3 text-sm text-sidebar-ink placeholder-sidebar-muted/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              required
            />
          </div>

          {/* Input 3: Generated Answer */}
          <div className="space-y-1.5">
            <label className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-sidebar-muted">
              <span>Generated Answer (Model Output)</span>
              <span className="text-[10px] text-accent font-normal">Required</span>
            </label>
            <textarea
              value={generatedAnswer}
              onChange={(e) => setGeneratedAnswer(e.target.value)}
              rows={4}
              placeholder="e.g. Section 188 mandates audit committee approval and board consent..."
              className="w-full rounded-lg border border-sidebar-line bg-black/30 p-3 text-sm text-sidebar-ink placeholder-sidebar-muted/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
              required
            />
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-xs text-rose-400 flex items-center gap-2">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end border-t border-sidebar-line pt-4">
          <button
            type="submit"
            disabled={evaluating}
            className="flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition hover:bg-accent/90 disabled:opacity-50"
          >
            {evaluating ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span>Running DeepEval...</span>
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                <span>Evaluate Retrieval</span>
              </>
            )}
          </button>
        </div>
      </form>

      {/* Live Result Cards */}
      <AnimatePresence>
        {currentResult && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="rounded-xl border border-sidebar-line bg-sidebar p-5 shadow-xl space-y-4"
          >
            <div className="flex items-center justify-between border-b border-sidebar-line pb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                <h3 className="text-base font-bold text-white">Latest Evaluation Output</h3>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-sidebar-muted">Overall Score:</span>
                <span className={`rounded-md border px-2.5 py-1 text-xs font-bold ${getScoreBadge(currentResult.overallScore)}`}>
                  {currentResult.overallScore !== null ? currentResult.overallScore.toFixed(2) : 'N/A'}
                </span>
              </div>
            </div>

            {/* Retrieval Metrics Grid (Precision & Recall) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Context Precision */}
              <div className="rounded-lg border border-sidebar-line bg-black/20 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Target className="h-4 w-4 text-blue-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-sidebar-ink">Contextual Precision</span>
                  </div>
                  <span className={`rounded-md border px-2 py-0.5 text-xs font-bold ${getScoreBadge(currentResult.contextPrecision)}`}>
                    {currentResult.contextPrecision !== null ? currentResult.contextPrecision.toFixed(2) : 'N/A'}
                  </span>
                </div>
                <p className="text-xs text-sidebar-muted leading-relaxed">
                  {currentResult.contextPrecisionReason || 'No reasoning supplied.'}
                </p>
              </div>

              {/* Context Recall */}
              <div className="rounded-lg border border-sidebar-line bg-black/20 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-indigo-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-sidebar-ink">Contextual Recall</span>
                  </div>
                  <span className={`rounded-md border px-2 py-0.5 text-xs font-bold ${getScoreBadge(currentResult.contextRecall)}`}>
                    {currentResult.contextRecall !== null ? currentResult.contextRecall.toFixed(2) : 'N/A'}
                  </span>
                </div>
                <p className="text-xs text-sidebar-muted leading-relaxed">
                  {currentResult.contextRecallReason || 'No reasoning supplied.'}
                </p>
              </div>
            </div>

            {/* Next Best Action Callout */}
            <div className="rounded-lg border border-accent/30 bg-accent/10 p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-accent">Next Best Action</p>
              <p className="mt-1 text-xs text-sidebar-ink font-medium leading-relaxed">
                {currentResult.nextBestAction}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* History & Saved Records Table */}
      <div className="rounded-xl border border-sidebar-line bg-sidebar p-5 shadow-lg space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-accent" />
            <h2 className="text-lg font-bold text-white">Retrieval Evaluation History</h2>
            <span className="rounded-full bg-sidebar-muted-bg px-2 py-0.5 text-xs font-medium text-sidebar-muted">
              {filteredHistory.length} records
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-sidebar-muted" />
              <input
                type="text"
                placeholder="Search history..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-8 w-44 rounded-lg border border-sidebar-line bg-black/20 pl-8 pr-3 text-xs text-sidebar-ink placeholder-sidebar-muted/50 focus:border-accent focus:outline-none"
              />
            </div>

            {/* Filter Dropdown */}
            <select
              value={scoreFilter}
              onChange={(e) => setScoreFilter(e.target.value)}
              className="h-8 rounded-lg border border-sidebar-line bg-black/20 px-2.5 text-xs text-sidebar-ink focus:border-accent focus:outline-none"
            >
              <option value="all">All Scores</option>
              <option value="high">High (&ge; 0.8)</option>
              <option value="needs_improvement">Needs Improvement (&lt; 0.8)</option>
            </select>

            <button
              onClick={handleExportCSV}
              disabled={history.length === 0}
              title="Export CSV"
              className="flex h-8 items-center gap-1 rounded-lg border border-sidebar-line bg-sidebar-muted-bg px-2.5 text-xs font-medium text-sidebar-ink transition hover:border-accent hover:text-accent disabled:opacity-40"
            >
              <Download size={13} />
              <span>Export</span>
            </button>

            <button
              onClick={handleClearHistory}
              disabled={history.length === 0}
              title="Clear All History"
              className="flex h-8 items-center gap-1 rounded-lg border border-rose-500/20 bg-rose-500/10 px-2.5 text-xs font-medium text-rose-400 transition hover:bg-rose-500/20 disabled:opacity-40"
            >
              <Trash2 size={13} />
              <span>Clear</span>
            </button>
          </div>
        </div>

        {/* History List */}
        {loadingHistory ? (
          <div className="py-12 text-center text-xs text-sidebar-muted flex items-center justify-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>Loading evaluation records...</span>
          </div>
        ) : filteredHistory.length === 0 ? (
          <div className="py-12 text-center text-xs text-sidebar-muted border border-dashed border-sidebar-line rounded-lg">
            No retrieval evaluations found. Run an evaluation above to populate history.
          </div>
        ) : (
          <div className="space-y-2">
            {filteredHistory.map((item) => {
              const isExpanded = expandedId === item.id;
              return (
                <div
                  key={item.id}
                  className="rounded-lg border border-sidebar-line bg-black/20 transition hover:border-sidebar-line/80 overflow-hidden"
                >
                  <div
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                    className="flex items-center justify-between p-3.5 cursor-pointer select-none"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1 pr-4">
                      <span className={`rounded-md border px-2 py-0.5 text-xs font-bold ${getScoreBadge(item.overallScore)}`}>
                        {item.overallScore !== null ? item.overallScore.toFixed(2) : 'N/A'}
                      </span>
                      <p className="text-xs font-medium text-sidebar-ink truncate max-w-xl">
                        {item.question}
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="hidden sm:flex items-center gap-3 text-[11px] text-sidebar-muted">
                        <span>Prec: <b>{item.contextPrecision ?? 'N/A'}</b></span>
                        <span>Rec: <b>{item.contextRecall ?? 'N/A'}</b></span>
                        <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                      </div>

                      <button
                        onClick={(e) => handleDelete(item.id, e)}
                        disabled={deletingId === item.id}
                        className="p-1 text-sidebar-muted hover:text-rose-400 transition"
                        title="Delete evaluation"
                      >
                        <Trash2 size={14} />
                      </button>

                      {isExpanded ? <ChevronUp size={16} className="text-sidebar-muted" /> : <ChevronDown size={16} className="text-sidebar-muted" />}
                    </div>
                  </div>

                  {/* Expanded Detail Panel */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="border-t border-sidebar-line bg-sidebar/50 p-4 space-y-3 text-xs"
                      >
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                          <div>
                            <p className="font-semibold uppercase tracking-wider text-sidebar-muted text-[10px]">Question</p>
                            <p className="mt-1 text-sidebar-ink bg-black/30 p-2.5 rounded border border-sidebar-line/50">{item.question}</p>
                          </div>
                          <div>
                            <p className="font-semibold uppercase tracking-wider text-sidebar-muted text-[10px]">Expected Answer</p>
                            <p className="mt-1 text-sidebar-ink bg-black/30 p-2.5 rounded border border-sidebar-line/50">{item.expectedAnswer}</p>
                          </div>
                          <div>
                            <p className="font-semibold uppercase tracking-wider text-sidebar-muted text-[10px]">Generated Answer</p>
                            <p className="mt-1 text-sidebar-ink bg-black/30 p-2.5 rounded border border-sidebar-line/50">{item.generatedAnswer}</p>
                          </div>
                        </div>

                        {/* Detailed Reasons */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                          <div className="rounded border border-sidebar-line bg-black/20 p-3">
                            <span className="font-bold text-sidebar-ink">Precision Reason: </span>
                            <span className="text-sidebar-muted">{item.contextPrecisionReason}</span>
                          </div>
                          <div className="rounded border border-sidebar-line bg-black/20 p-3">
                            <span className="font-bold text-sidebar-ink">Recall Reason: </span>
                            <span className="text-sidebar-muted">{item.contextRecallReason}</span>
                          </div>
                        </div>

                        {/* Next Best Action */}
                        <div className="rounded border border-accent/30 bg-accent/10 p-3">
                          <span className="font-bold text-accent">Next Best Action: </span>
                          <span className="text-sidebar-ink">{item.nextBestAction}</span>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
