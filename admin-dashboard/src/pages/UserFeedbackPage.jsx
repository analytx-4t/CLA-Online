import { useState, useEffect } from 'react';
import { MessageSquare, Search, RefreshCw, Edit2, CheckCircle2, AlertCircle, Calendar, FileText } from 'lucide-react';

export default function UserFeedbackPage() {
  const [feedbackLogs, setFeedbackLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Edit modal state
  const [editingItem, setEditingItem] = useState(null);
  const [editFeedbackText, setEditFeedbackText] = useState('');
  const [updating, setUpdating] = useState(false);
  const [updateNotice, setUpdateNotice] = useState(null);

  const fetchFeedback = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/feedback');
      const data = await res.json();
      if (data.success) {
        setFeedbackLogs(data.feedback || []);
      } else {
        throw new Error(data.error || 'Failed to load user feedback logs.');
      }
    } catch (err) {
      setError(err.message || 'Network error fetching feedback.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFeedback();
  }, []);

  const handleOpenEdit = (item) => {
    setEditingItem(item);
    setEditFeedbackText(item.feedback || '');
    setUpdateNotice(null);
  };

  const handleCloseEdit = () => {
    setEditingItem(null);
    setEditFeedbackText('');
    setUpdateNotice(null);
  };

  const handleSaveEdit = async () => {
    if (!editingItem) return;
    setUpdating(true);
    setUpdateNotice(null);

    try {
      const res = await fetch('/api/admin/feedback/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingItem.id,
          feedback: editFeedbackText
        })
      });

      const data = await res.json();
      if (data.success) {
        setUpdateNotice({ type: 'success', message: 'Feedback updated successfully!' });
        setTimeout(() => {
          handleCloseEdit();
          fetchFeedback();
        }, 1200);
      } else {
        throw new Error(data.error || 'Failed to update feedback');
      }
    } catch (err) {
      setUpdateNotice({ type: 'error', message: err.message || 'Error updating feedback.' });
    } finally {
      setUpdating(false);
    }
  };

  const filteredLogs = feedbackLogs.filter((item) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      (item.question && item.question.toLowerCase().includes(term)) ||
      (item.answer && item.answer.toLowerCase().includes(term)) ||
      (item.feedback && item.feedback.toLowerCase().includes(term)) ||
      (item.sessionId && item.sessionId.toLowerCase().includes(term))
    );
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink flex items-center gap-2">
            <MessageSquare className="text-accent" size={24} />
            User Feedback Logs
          </h1>
          <p className="text-sm text-sidebar-muted mt-1">
            Review and manage audit feedback, user corrections, and interaction metadata submitted from the Chatbot Interface.
          </p>
        </div>
        <button
          onClick={fetchFeedback}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-surface border border-sidebar-line text-sm font-medium text-ink hover:bg-surface-soft transition shadow-sm"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Refresh Logs
        </button>
      </div>

      {/* Filter / Search Bar */}
      <div className="flex items-center gap-3 p-3 rounded-2xl bg-surface border border-sidebar-line shadow-sm">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sidebar-muted" size={18} />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by question, answer text, user feedback, or session ID..."
            className="w-full pl-10 pr-4 py-2 bg-transparent text-sm text-ink placeholder:text-sidebar-muted outline-none"
          />
        </div>
        {searchTerm && (
          <button
            onClick={() => setSearchTerm('')}
            className="text-xs px-3 py-1.5 rounded-lg bg-surface-soft text-sidebar-muted hover:text-ink transition"
          >
            Clear
          </button>
        )}
      </div>

      {/* Logs Table / Cards */}
      {loading ? (
        <div className="flex items-center justify-center p-12 bg-surface rounded-2xl border border-sidebar-line">
          <RefreshCw className="animate-spin text-accent" size={24} />
          <span className="ml-3 text-sm text-sidebar-muted">Loading feedback logs...</span>
        </div>
      ) : error ? (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 flex items-center gap-3">
          <AlertCircle size={20} />
          <span>{error}</span>
        </div>
      ) : filteredLogs.length === 0 ? (
        <div className="text-center p-12 bg-surface rounded-2xl border border-sidebar-line">
          <FileText className="mx-auto text-sidebar-muted mb-3" size={32} />
          <p className="text-base font-semibold text-ink">No feedback records found</p>
          <p className="text-xs text-sidebar-muted mt-1">
            {searchTerm ? 'Try adjusting your search criteria.' : 'User feedback submitted in the chat app will appear here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredLogs.map((item) => (
            <div
              key={item.id}
              className="p-5 rounded-2xl bg-surface border border-sidebar-line shadow-sm hover:border-accent/40 transition space-y-4"
            >
              {/* Top row metadata */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sidebar-line/60 pb-3">
                <div className="flex items-center gap-3">
                  <span className="px-2.5 py-1 rounded-lg bg-accent-soft-strong text-accent text-xs font-semibold">
                    Feedback ID: {String(item.id).slice(-8)}
                  </span>
                  {item.sessionId && (
                    <span className="text-xs text-sidebar-muted">
                      Session: {item.sessionId.slice(0, 14)}...
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 text-xs text-sidebar-muted">
                  <span className="flex items-center gap-1">
                    <Calendar size={14} />
                    {new Date(item.created_at).toLocaleString()}
                  </span>
                  <button
                    onClick={() => handleOpenEdit(item)}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 text-xs font-semibold transition"
                  >
                    <Edit2 size={13} />
                    Edit Feedback
                  </button>
                </div>
              </div>

              {/* Question & Answer Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-sidebar-muted">
                    User Question
                  </span>
                  <p className="p-3 rounded-xl bg-surface-soft border border-sidebar-line/40 text-sm font-medium text-ink">
                    {item.question || 'N/A'}
                  </p>
                </div>
                <div className="space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-sidebar-muted">
                    Assistant Answer Preview
                  </span>
                  <p className="p-3 rounded-xl bg-surface-soft border border-sidebar-line/40 text-xs text-sidebar-muted line-clamp-3">
                    {item.answer || 'N/A'}
                  </p>
                </div>
              </div>

              {/* User Feedback & Cited Chunks */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pt-1">
                <div className="lg:col-span-2 space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-accent">
                    💬 User Feedback / Audit Note
                  </span>
                  <div className="p-3 rounded-xl bg-accent-soft-strong/40 border border-accent/20 text-sm text-ink font-medium">
                    {item.feedback || <span className="italic text-sidebar-muted">No text feedback recorded.</span>}
                  </div>
                </div>

                <div className="space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-sidebar-muted">
                    Cited Sources ({item.chunks ? item.chunks.length : 0})
                  </span>
                  <div className="p-3 rounded-xl bg-surface-soft border border-sidebar-line/40 text-xs space-y-1 max-h-24 overflow-y-auto">
                    {item.chunks && item.chunks.length > 0 ? (
                      item.chunks.map((chunk, idx) => (
                        <div key={idx} className="truncate text-sidebar-muted">
                          • <span className="text-ink font-medium">{chunk.title || chunk.law_title || chunk.source_table || 'Source'}</span>
                        </div>
                      ))
                    ) : (
                      <span className="text-sidebar-muted italic">No citations attached.</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit Feedback Modal */}
      {editingItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-2xl bg-surface border border-sidebar-line p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-sidebar-line pb-3">
              <h3 className="text-lg font-bold text-ink flex items-center gap-2">
                <Edit2 size={18} className="text-accent" />
                Edit User Feedback Note
              </h3>
              <button
                onClick={handleCloseEdit}
                className="text-sidebar-muted hover:text-ink text-xl font-bold"
              >
                &times;
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-sidebar-muted">
                Feedback Content:
              </label>
              <textarea
                value={editFeedbackText}
                onChange={(e) => setEditFeedbackText(e.target.value)}
                rows={5}
                className="w-full p-3 rounded-xl bg-surface-soft border border-sidebar-line text-sm text-ink outline-none focus:border-accent transition"
                placeholder="Enter updated audit feedback note..."
              />
            </div>

            {updateNotice && (
              <div
                className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
                  updateNotice.type === 'success'
                    ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-500'
                    : 'bg-red-500/10 border border-red-500/20 text-red-500'
                }`}
              >
                {updateNotice.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                <span>{updateNotice.message}</span>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={handleCloseEdit}
                disabled={updating}
                className="px-4 py-2 rounded-xl bg-surface-soft text-sm font-medium text-sidebar-muted hover:text-ink transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEdit}
                disabled={updating}
                className="px-4 py-2 rounded-xl bg-accent text-accent-ink text-sm font-semibold hover:opacity-90 transition inline-flex items-center gap-2"
              >
                {updating && <RefreshCw size={14} className="animate-spin" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
