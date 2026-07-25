import { useEffect, useState } from 'react';
import { Cpu, Network, ShieldCheck, Database, RefreshCw } from 'lucide-react';
import StatusPill from '../components/StatusPill';

const PROVIDER_LABELS = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  groq: 'Groq',
};

function formatProviderModel(provider, info) {
  if (provider === 'deepseek') {
    return [info.proModel, info.flashModel].filter(Boolean).join(' / ') || '—';
  }
  if (provider === 'groq') {
    return [info.llamaModel, info.mistralModel].filter(Boolean).join(' / ') || '—';
  }
  return info.model || '—';
}

function SectionCard({ icon: Icon, title, subtitle, children }) {
  return (
    <section className="rounded-lg border border-line bg-surface p-4 ">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Icon size={18} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-4 space-y-2">{children}</div>
    </section>
  );
}

function Row({ label, value, tone }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-muted px-3 py-2.5 text-sm">
      <span className="text-muted">{label}</span>
      {tone ? <StatusPill label={value} tone={tone} /> : <span className="font-medium text-ink">{value}</span>}
    </div>
  );
}

export default function SettingsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/settings');
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err.message || 'Unable to load settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-line bg-surface p-3 ">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-muted">Configuration</p>
            <h2 className="mt-1 text-2xl font-semibold text-ink">Settings</h2>
            <p className="mt-1 text-sm text-muted">Current system configuration and provider status. Values are managed via server environment variables.</p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 self-start rounded-lg border border-line bg-surface-muted px-3 py-2 text-xs text-ink transition hover:border-accent disabled:opacity-60"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger-soft p-4 text-sm text-danger">
          <p className="font-medium">Unable to load settings.</p>
          <p className="mt-1 text-danger">{error}</p>
        </div>
      )}

      {loading && !data ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-40 animate-pulse rounded-lg bg-surface-muted" />
          ))}
        </div>
      ) : data ? (
        <div className="grid gap-3 md:grid-cols-2">
          <SectionCard icon={Cpu} title="LLM Providers" subtitle={`Default: ${PROVIDER_LABELS[data.llm.defaultProvider] || data.llm.defaultProvider} · ${data.llm.defaultModel}`}>
            {Object.entries(data.llm.providers).map(([provider, info]) => (
              <Row
                key={provider}
                label={`${PROVIDER_LABELS[provider] || provider} — ${formatProviderModel(provider, info)}`}
                value={info.configured ? 'Configured' : 'Not configured'}
                tone={info.configured ? 'success' : 'neutral'}
              />
            ))}
          </SectionCard>

          <SectionCard icon={Network} title="LLM Gateway" subtitle="Portkey routing &amp; reliability configuration">
            <Row label="Gateway" value={data.gateway.portkeyConfigured ? 'Connected' : 'Not configured'} tone={data.gateway.portkeyConfigured ? 'success' : 'neutral'} />
            <Row label="Primary config" value={data.gateway.configId || 'Not set'} />
            <Row label="Retry config" value={data.gateway.retryConfigId || 'Not set'} />
            <Row label="Reliability config" value={data.gateway.reliabilityConfigId || 'Not set'} />
            <Row label="Cache config" value={data.gateway.cacheConfigId || 'Not set'} />
          </SectionCard>

          <SectionCard icon={ShieldCheck} title="Guardrails" subtitle="Input safety classification">
            <Row label="Status" value={data.guardrails.active ? 'Active' : 'Inactive'} tone={data.guardrails.active ? 'success' : 'danger'} />
            <Row label="Mode" value={data.guardrails.mode} />
            <Row label="Tracing (LangSmith)" value={data.observability.langsmithTracing ? 'Enabled' : 'Disabled'} tone={data.observability.langsmithTracing ? 'success' : 'neutral'} />
            <Row label="NeMo Guardrail" value={data.guardrails.active ? 'Active' : 'Inactive'} tone={data.guardrails.active ? 'success' : 'danger'} />
          </SectionCard>

          <SectionCard icon={Database} title="Database" subtitle="Primary data store">
            <Row label="Connection" value={data.database.connected ? 'Connected' : 'Unavailable'} tone={data.database.connected ? 'success' : 'danger'} />
            <Row label="Database" value={data.database.name || '—'} />
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
