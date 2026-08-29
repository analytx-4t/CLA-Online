import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
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
  MessageSquare,
  ShieldCheck,
  Search,
  BookOpen,
  Eye,
  EyeOff
} from 'lucide-react';

const API_BASE = '/api/admin/eval/generation';

const SAMPLE_LEGAL_CASE = {
  question: 'What are the statutory duties of a Director under Section 166 of the Companies Act 2013?',
  expectedAnswer: 'Under Section 166 of the Companies Act 2013, a director must act in accordance with the articles of the company, act in good faith to promote the objects of the company for the benefit of its members as a whole, exercise duties with due and reasonable care, skill and diligence, avoid direct or indirect conflicts of interest, and not achieve or attempt to achieve any undue gain or advantage.',
  generatedAnswer: 'Section 166 of Companies Act 2013 sets director duties: acting in good faith to promote company objects, exercising reasonable care and diligence, avoiding conflicts of interest, and refraining from assigning the office or securing undue gain.'
};

function FormatPercentage(val) {
  if (val === null || val === undefined || isNaN(val)) return 'N/A';
  const num = Number(val);
  const pct = num <= 1.0 ? Math.round(num * 100) : Math.round(num);
  return `${pct}%`;
}

function CollapsibleText({ label, text, maxLength = 160 }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text && text.length > maxLength;

  return (
    <div className="rounded-lg border border-slate-200 dark:border-sidebar-line bg-slate-50 dark:bg-black/20 p-3 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-sidebar-muted">
          {label}
        </span>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-[11px] font-medium text-purple-600 dark:text-purple-400 hover:underline focus:outline-none"
          >
            {expanded ? (
              <>
                <span>Show Less</span>
                <EyeOff size={12} />
              </>
            ) : (
              <>
                <span>See More</span>
                <Eye size={12} />
              </>
            )}
          </button>
        )}
      </div>
      <p className="text-xs text-slate-800 dark:text-sidebar-ink leading-relaxed whitespace-pre-wrap">
        {isLong && !expanded ? `${text.slice(0, maxLength)}...` : text}
      </p>
    </div>
  );
}

export default function GenerationEvalPage() {
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
      console.error('Failed to fetch generation eval history', err);
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
    if (!window.confirm('Are you sure you want to clear all generation evaluation history? This action cannot be undone.')) return;
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
    const headers = ['ID', 'Question', 'Expected Answer', 'Generated Answer', 'Answer Relevancy', 'Faithfulness', 'Overall Score', 'Next Best Action', 'Date'];
    const rows = history.map((item) => [
      `"${item.id}"`,
      `"${(item.question || '').replace(/"/g, '""')}"`,
      `"${(item.expectedAnswer || '').replace(/"/g, '""')}"`,
      `"${(item.generatedAnswer || '').replace(/"/g, '""')}"`,
      item.answerRelevancy ?? '',
      item.faithfulness ?? '',
      item.overallScore ?? '',
      `"${(item.nextBestAction || '').replace(/"/g, '""')}"`,
      `"${item.createdAt}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `generation_evaluations_${new Date().toISOString().slice(0, 10)}.csv`);
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
    const scoreVal = item.overallScore <= 1.0 ? item.overallScore : item.overallScore / 100;
    if (scoreFilter === 'high') return (scoreVal || 0) >= 0.8;
    if (scoreFilter === 'needs_improvement') return (scoreVal || 0) < 0.8;
    return true;
  });

  const getScoreBadge = (score) => {
    if (score === null || score === undefined) return 'bg-slate-100 text-slate-600 border-slate-300 dark:bg-gray-500/10 dark:text-gray-400 dark:border-gray-500/20';
    const val = score <= 1.0 ? score : score / 100;
    if (val >= 0.8) return 'bg-emerald-50 text-emerald-700 border-emerald-300 dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/20';
    if (val >= 0.6) return 'bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20';
    return 'bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-500/20';
  };

  return (
    <div className="space-y-6 text-slate-900 dark:text-white">
      {/* Page Header */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between border-b border-slate-200 dark:border-sidebar-line pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Generation Evaluation</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-50 dark:bg-purple-500/10 px-2.5 py-0.5 text-xs font-semibold text-purple-700 dark:text-purple-400">
              <BrainCircuit className="h-3 w-3" />
              DeepSeek v4 Pro (Fast Judge)
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-sidebar-muted">
            Benchmark LLM generation accuracy using <b>Answer Relevancy</b> and <b>Faithfulness</b> metrics.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleLoadSample}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-sidebar-line bg-white dark:bg-sidebar-muted-bg px-3 py-2 text-xs font-medium text-slate-700 dark:text-sidebar-ink transition hover:border-purple-500 hover:text-purple-500 shadow-sm"
          >
            <BookOpen size={14} />
            Load Legal Sample Case
          </button>
        </div>
      </div>

      {/* Input Form Card */}
      <form onSubmit={handleEvaluate} className="rounded-xl border border-slate-200 dark:border-sidebar-line bg-white dark:bg-sidebar p-5 shadow-sm space-y-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Input 1: Question */}
          <div className="space-y-1.5">
            <label className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-sidebar-muted">
              <span>Question (User Query)</span>
              <span className="text-[10px] text-purple-600 dark:text-purple-400 font-normal">Required</span>
            </label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={4}
              placeholder="e.g. What are the duties of a Director under Section 166?"
              className="w-full rounded-lg border border-slate-300 dark:border-sidebar-line bg-slate-50 dark:bg-black/30 p-3 text-sm text-slate-900 dark:text-sidebar-ink placeholder-slate-400 dark:placeholder-sidebar-muted/50 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              required
            />
          </div>

          {/* Input 2: Expected Answer */}
          <div className="space-y-1.5">
            <label className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-sidebar-muted">
              <span>Expected Answer (Ground Truth)</span>
              <span className="text-[10px] text-purple-600 dark:text-purple-400 font-normal">Required</span>
            </label>
            <textarea
              value={expectedAnswer}
              onChange={(e) => setExpectedAnswer(e.target.value)}
              rows={4}
              placeholder="e.g. Act in good faith, exercise due care, avoid conflicts of interest..."
              className="w-full rounded-lg border border-slate-300 dark:border-sidebar-line bg-slate-50 dark:bg-black/30 p-3 text-sm text-slate-900 dark:text-sidebar-ink placeholder-slate-400 dark:placeholder-sidebar-muted/50 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              required
            />
          </div>

          {/* Input 3: Generated Answer */}
          <div className="space-y-1.5">
            <label className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-sidebar-muted">
              <span>Generated Answer (Model Output)</span>
              <span className="text-[10px] text-purple-600 dark:text-purple-400 font-normal">Required</span>
            </label>
            <textarea
              value={generatedAnswer}
              onChange={(e) => setGeneratedAnswer(e.target.value)}
              rows={4}
              placeholder="e.g. Director duties under Section 166 mandate acting in good faith..."
              className="w-full rounded-lg border border-slate-300 dark:border-sidebar-line bg-slate-50 dark:bg-black/30 p-3 text-sm text-slate-900 dark:text-sidebar-ink placeholder-slate-400 dark:placeholder-sidebar-muted/50 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              required
            />
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-200 dark:border-rose-500/20 bg-rose-50 dark:bg-rose-500/10 p-3 text-xs text-rose-700 dark:text-rose-400 flex items-center gap-2">
            <AlertTriangle size={16} />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end border-t border-slate-200 dark:border-sidebar-line pt-4">
          <button
            type="submit"
            disabled={evaluating}
            className="flex items-center gap-2 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-purple-500 disabled:opacity-50 shadow-sm"
          >
            {evaluating ? (
              <>
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span>Evaluating in seconds...</span>
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                <span>Evaluate Generation</span>
              </>
            )}
          </button>
        </div>
      </form>

      {/* Live Result Output */}
      <AnimatePresence>
        {currentResult && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className="rounded-xl border border-slate-200 dark:border-sidebar-line bg-white dark:bg-sidebar p-5 shadow-md space-y-5"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-sidebar-line pb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-500 dark:text-emerald-400" />
                <h3 className="text-base font-bold text-slate-900 dark:text-white">Latest Evaluation Results</h3>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-500 dark:text-sidebar-muted">Overall Score:</span>
                <span className={`rounded-md border px-3 py-1 text-sm font-extrabold ${getScoreBadge(currentResult.overallScore)}`}>
                  {FormatPercentage(currentResult.overallScore)}
                </span>
              </div>
            </div>

            {/* 1. METRICS FIRST AT TOP */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Answer Relevancy Metric */}
              <div className="rounded-xl border border-purple-200 dark:border-sidebar-line bg-purple-50/50 dark:bg-black/20 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-sidebar-ink">Answer Relevancy</span>
                  </div>
                  <span className={`rounded-md border px-2.5 py-0.5 text-xs font-extrabold ${getScoreBadge(currentResult.answerRelevancy)}`}>
                    {FormatPercentage(currentResult.answerRelevancy)}
                  </span>
                </div>

                {/* Separate Reason Block */}
                <div className="rounded-lg border border-slate-200 dark:border-sidebar-line/60 bg-white dark:bg-sidebar/80 p-3">
                  <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 block mb-1">Relevancy Reason & Analysis:</span>
                  <p className="text-xs text-slate-600 dark:text-sidebar-muted leading-relaxed">
                    {currentResult.answerRelevancyReason || 'No reasoning supplied.'}
                  </p>
                </div>
              </div>

              {/* Faithfulness Metric */}
              <div className="rounded-xl border border-emerald-200 dark:border-sidebar-line bg-emerald-50/50 dark:bg-black/20 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-sidebar-ink">Faithfulness</span>
                  </div>
                  <span className={`rounded-md border px-2.5 py-0.5 text-xs font-extrabold ${getScoreBadge(currentResult.faithfulness)}`}>
                    {FormatPercentage(currentResult.faithfulness)}
                  </span>
                </div>

                {/* Separate Reason Block */}
                <div className="rounded-lg border border-slate-200 dark:border-sidebar-line/60 bg-white dark:bg-sidebar/80 p-3">
                  <span className="text-[11px] font-bold text-slate-700 dark:text-slate-300 block mb-1">Faithfulness Reason & Analysis:</span>
                  <p className="text-xs text-slate-600 dark:text-sidebar-muted leading-relaxed">
                    {currentResult.faithfulnessReason || 'No reasoning supplied.'}
                  </p>
                </div>
              </div>
            </div>

            {/* Next Best Action Callout */}
            <div className="rounded-lg border border-purple-300 dark:border-purple-500/30 bg-purple-50 dark:bg-purple-500/10 p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-purple-700 dark:text-purple-400">Next Best Action</p>
              <p className="mt-1 text-xs text-slate-800 dark:text-sidebar-ink font-medium leading-relaxed">
                {currentResult.nextBestAction}
              </p>
            </div>

            {/* 2. WRAPPED TEXTS AT BOTTOM WITH SEE MORE */}
            <div className="border-t border-slate-200 dark:border-sidebar-line pt-4 space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-sidebar-muted">Evaluated Input Text Details</h4>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <CollapsibleText label="Question (User Query)" text={currentResult.question} />
                <CollapsibleText label="Expected Answer (Ground Truth)" text={currentResult.expectedAnswer} />
                <CollapsibleText label="Generated Answer (Model Output)" text={currentResult.generatedAnswer} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* History & Saved Records Table */}
      <div className="rounded-xl border border-slate-200 dark:border-sidebar-line bg-white dark:bg-sidebar p-5 shadow-sm space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-purple-600 dark:text-purple-400" />
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Generation Evaluation History</h2>
            <span className="rounded-full bg-slate-100 dark:bg-sidebar-muted-bg px-2.5 py-0.5 text-xs font-semibold text-slate-600 dark:text-sidebar-muted">
              {filteredHistory.length} records
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400 dark:text-sidebar-muted" />
              <input
                type="text"
                placeholder="Search history..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-8 w-44 rounded-lg border border-slate-300 dark:border-sidebar-line bg-slate-50 dark:bg-black/20 pl-8 pr-3 text-xs text-slate-900 dark:text-sidebar-ink placeholder-slate-400 focus:border-purple-500 focus:outline-none"
              />
            </div>

            {/* Filter Dropdown */}
            <select
              value={scoreFilter}
              onChange={(e) => setScoreFilter(e.target.value)}
              className="h-8 rounded-lg border border-slate-300 dark:border-sidebar-line bg-slate-50 dark:bg-black/20 px-2.5 text-xs text-slate-900 dark:text-sidebar-ink focus:border-purple-500 focus:outline-none"
            >
              <option value="all">All Scores</option>
              <option value="high">High (&ge; 80%)</option>
              <option value="needs_improvement">Needs Improvement (&lt; 80%)</option>
            </select>

            <button
              onClick={handleExportCSV}
              disabled={history.length === 0}
              title="Export CSV"
              className="flex h-8 items-center gap-1 rounded-lg border border-slate-300 dark:border-sidebar-line bg-slate-50 dark:bg-sidebar-muted-bg px-2.5 text-xs font-medium text-slate-700 dark:text-sidebar-ink transition hover:border-purple-500 hover:text-purple-500 disabled:opacity-40"
            >
              <Download size={13} />
              <span>Export</span>
            </button>

            <button
              onClick={handleClearHistory}
              disabled={history.length === 0}
              title="Clear All History"
              className="flex h-8 items-center gap-1 rounded-lg border border-rose-300 dark:border-rose-500/20 bg-rose-50 dark:bg-rose-500/10 px-2.5 text-xs font-medium text-rose-600 dark:text-rose-400 transition hover:bg-rose-100 dark:hover:bg-rose-500/20 disabled:opacity-40"
            >
              <Trash2 size={13} />
              <span>Clear</span>
            </button>
          </div>
        </div>

        {/* History List */}
        {loadingHistory ? (
          <div className="py-12 text-center text-xs text-slate-500 dark:text-sidebar-muted flex items-center justify-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>Loading evaluation records...</span>
          </div>
        ) : filteredHistory.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-500 dark:text-sidebar-muted border border-dashed border-slate-300 dark:border-sidebar-line rounded-lg">
            No generation evaluations found. Run an evaluation above to populate history.
          </div>
        ) : (
          <div className="space-y-2">
            {filteredHistory.map((item) => {
              const isExpanded = expandedId === item.id;
              return (
                <div
                  key={item.id}
                  className="rounded-lg border border-slate-200 dark:border-sidebar-line bg-slate-50/50 dark:bg-black/20 transition hover:border-slate-300 dark:hover:border-sidebar-line/80 overflow-hidden"
                >
                  <div
                    onClick={() => setExpandedId(isExpanded ? null : item.id)}
                    className="flex items-center justify-between p-3.5 cursor-pointer select-none"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1 pr-4">
                      <span className={`rounded-md border px-2.5 py-0.5 text-xs font-extrabold ${getScoreBadge(item.overallScore)}`}>
                        {FormatPercentage(item.overallScore)}
                      </span>
                      <p className="text-xs font-semibold text-slate-800 dark:text-sidebar-ink truncate max-w-xl">
                        {item.question}
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="hidden sm:flex items-center gap-3 text-[11px] text-slate-500 dark:text-sidebar-muted">
                        <span>Rel: <b>{FormatPercentage(item.answerRelevancy)}</b></span>
                        <span>Faith: <b>{FormatPercentage(item.faithfulness)}</b></span>
                        <span>{new Date(item.createdAt).toLocaleDateString()}</span>
                      </div>

                      <button
                        onClick={(e) => handleDelete(item.id, e)}
                        disabled={deletingId === item.id}
                        className="p-1 text-slate-400 dark:text-sidebar-muted hover:text-rose-500 transition"
                        title="Delete evaluation"
                      >
                        <Trash2 size={14} />
                      </button>

                      {isExpanded ? <ChevronUp size={16} className="text-slate-500 dark:text-sidebar-muted" /> : <ChevronDown size={16} className="text-slate-500 dark:text-sidebar-muted" />}
                    </div>
                  </div>

                  {/* Expanded Detail Panel */}
                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="border-t border-slate-200 dark:border-sidebar-line bg-white dark:bg-sidebar/50 p-4 space-y-4 text-xs"
                      >
                        {/* 1. METRICS AT TOP */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <div className="rounded-lg border border-slate-200 dark:border-sidebar-line bg-purple-50/40 dark:bg-black/20 p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-slate-800 dark:text-sidebar-ink text-[11px] uppercase tracking-wider">Answer Relevancy Score</span>
                              <span className={`rounded border px-2 py-0.5 text-xs font-bold ${getScoreBadge(item.answerRelevancy)}`}>
                                {FormatPercentage(item.answerRelevancy)}
                              </span>
                            </div>
                            <div className="rounded border border-slate-200 dark:border-sidebar-line bg-white dark:bg-sidebar p-2.5">
                              <span className="font-semibold text-slate-700 dark:text-slate-300 block mb-0.5 text-[10px] uppercase">Reason Block:</span>
                              <p className="text-slate-600 dark:text-sidebar-muted leading-relaxed text-xs">{item.answerRelevancyReason}</p>
                            </div>
                          </div>

                          <div className="rounded-lg border border-slate-200 dark:border-sidebar-line bg-emerald-50/40 dark:bg-black/20 p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="font-bold text-slate-800 dark:text-sidebar-ink text-[11px] uppercase tracking-wider">Faithfulness Score</span>
                              <span className={`rounded border px-2 py-0.5 text-xs font-bold ${getScoreBadge(item.faithfulness)}`}>
                                {FormatPercentage(item.faithfulness)}
                              </span>
                            </div>
                            <div className="rounded border border-slate-200 dark:border-sidebar-line bg-white dark:bg-sidebar p-2.5">
                              <span className="font-semibold text-slate-700 dark:text-slate-300 block mb-0.5 text-[10px] uppercase">Reason Block:</span>
                              <p className="text-slate-600 dark:text-sidebar-muted leading-relaxed text-xs">{item.faithfulnessReason}</p>
                            </div>
                          </div>
                        </div>

                        {/* Next Best Action */}
                        <div className="rounded-lg border border-purple-300 dark:border-purple-500/30 bg-purple-50 dark:bg-purple-500/10 p-3">
                          <span className="font-bold text-purple-700 dark:text-purple-400">Next Best Action: </span>
                          <span className="text-slate-800 dark:text-sidebar-ink font-medium">{item.nextBestAction}</span>
                        </div>

                        {/* 2. WRAPPED TEXTS BELOW WITH SEE MORE */}
                        <div className="border-t border-slate-200 dark:border-sidebar-line pt-3 space-y-2">
                          <span className="font-bold text-slate-500 dark:text-sidebar-muted text-[10px] uppercase tracking-wider block">Question & Answer Content</span>
                          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                            <CollapsibleText label="Question" text={item.question} />
                            <CollapsibleText label="Expected Answer" text={item.expectedAnswer} />
                            <CollapsibleText label="Generated Answer" text={item.generatedAnswer} />
                          </div>
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
