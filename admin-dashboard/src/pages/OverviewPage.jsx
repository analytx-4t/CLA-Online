import { useEffect, useState } from 'react';
import { Activity, ClipboardCheck, Cpu, ShieldCheck } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import ChartCard from '../components/ChartCard';
import StatusPill from '../components/StatusPill';
import DonutChart from '../components/DonutChart';
import { Link } from 'react-router-dom';

const PROVIDER_LABELS = { openai: 'OpenAI', deepseek: 'DeepSeek', gemini: 'Gemini', groq: 'Groq' };
const PROVIDER_COLORS = { openai: '#0C8742', deepseek: '#2F6FB0', gemini: '#96602E', groq: '#7A5FB0' };

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function OverviewPage() {
  const [overview, setOverview] = useState(null);
  const [settings, setSettings] = useState(null);
  const [providerStats, setProviderStats] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const base = '';
        const [overviewRes, settingsRes, portkeyRes, ragasRes] = await Promise.all([
          fetch(`${base}/api/admin/overview`),
          fetch(`${base}/api/admin/settings`),
          fetch(`${base}/api/admin/portkey`),
          fetch(`${base}/api/admin/ragas?page=1&limit=5`),
        ]);
        if (overviewRes.ok) setOverview(await overviewRes.json());
        if (settingsRes.ok) setSettings(await settingsRes.json());
        if (portkeyRes.ok) {
          const payload = await portkeyRes.json();
          setProviderStats(payload.providerStats || null);
        }
        if (ragasRes.ok) {
          const payload = await ragasRes.json();
          setRecent(Array.isArray(payload?.data) ? payload.data : []);
        }
      } catch (err) {
        setError(err.message || 'Unable to load overview data.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const overallScore = overview
    ? [overview.avgFaithfulness, overview.avgAnswerRelevancy, overview.avgContextPrecision, overview.avgContextRecall, overview.avgAnswerCorrectness]
        .filter((value) => Number.isFinite(value))
    : [];
  const avgOverallScore = overallScore.length ? overallScore.reduce((sum, v) => sum + v, 0) / overallScore.length : null;

  const providerSegments = providerStats
    ? Object.entries(providerStats)
        .filter(([, stat]) => stat.count > 0)
        .map(([provider, stat]) => ({ label: PROVIDER_LABELS[provider] || provider, value: stat.count, color: PROVIDER_COLORS[provider] || '#5B635B' }))
    : [];

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
          Unable to load live data: {error}
        </div>
      )}

      <section className="card grid grid-cols-2 gap-x-4 gap-y-5 p-4 sm:grid-cols-4 divide-x divide-line">
        <MetricCard title="Evaluated Requests" value={loading ? '—' : (overview?.totalRequests ?? 0)} icon={Activity} caption="All time" />
        <div className="pl-4"><MetricCard title="Avg Quality Score" value={loading ? '—' : formatPercent(avgOverallScore)} icon={ClipboardCheck} caption="RAGAS composite" /></div>
        <div className="pl-4"><MetricCard title="Guardrails" value={loading || !settings ? '—' : (settings.guardrails.active ? 'Active' : 'Inactive')} icon={ShieldCheck} caption={settings?.guardrails?.mode} /></div>
        <div className="pl-4"><MetricCard title="LLM Model" value={loading ? '—' : (settings?.llm?.defaultModel || '—')} icon={Cpu} caption={settings?.llm?.defaultProvider} /></div>
      </section>

      <section className="grid gap-3 lg:grid-cols-3">
        <ChartCard title="Provider distribution" meta="Share of gateway requests by provider" className="lg:col-span-1">
          {providerSegments.length > 0 ? (
            <div className="flex h-full items-center justify-center"><DonutChart segments={providerSegments} /></div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">{loading ? 'Loading…' : 'No gateway activity yet.'}</div>
          )}
        </ChartCard>

        <div className="card p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Recent interactions</p>
              <p className="mt-1 text-sm text-muted">Latest scored production requests</p>
            </div>
          </div>

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-11 animate-pulse rounded-lg bg-surface-muted" />)}
            </div>
          ) : recent.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line bg-surface-muted p-6 text-center text-sm text-muted">No evaluations recorded yet.</div>
          ) : (
            <div className="divide-y divide-line">
              {recent.map((row) => (
                <div key={row.requestId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate text-ink">{row.question || row.requestId}</p>
                    <p className="text-xs text-muted">{formatTimestamp(row.timestamp)} · {row.provider || '—'}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 text-right">
            <Link to="/online-eval" className="text-sm font-medium text-accent hover:underline">See more</Link>
          </div>
        </div>
      </section>

      <section className="card p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-muted">Provider configuration</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {settings ? Object.entries(settings.llm.providers).map(([provider, info]) => (
            <div key={provider} className="flex items-center justify-between rounded-lg border border-line bg-surface-muted px-3 py-2.5 text-sm">
              <span className="text-ink">{PROVIDER_LABELS[provider] || provider}</span>
              <StatusPill label={info.configured ? 'Configured' : 'Not configured'} tone={info.configured ? 'success' : 'neutral'} />
            </div>
          )) : (
            <div className="text-sm text-muted">{loading ? 'Loading…' : 'Unable to load provider configuration.'}</div>
          )}
        </div>
      </section>
    </div>
  );
}
