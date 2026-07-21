import { Sparkles, ShieldCheck, Activity, Layers } from 'lucide-react';
import MetricCard from '../components/MetricCard';
import ChartCard from '../components/ChartCard';
import StatusPill from '../components/StatusPill';
import LineChart from '../components/LineChart';
import DonutChart from '../components/DonutChart';
import { overviewMetrics, providerHealth, liveRequests, activityTimeline } from '../data/mockMetrics';

const requestTimeline = [120, 142, 158, 170, 155, 162, 176, 168, 190, 205, 198, 182];
const tokenUsageTimeline = [45, 52, 48, 60, 58, 64, 72, 68, 75, 80, 78, 85];

export default function OverviewPage() {
  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-slate-800/80 bg-[#111827]/95 p-3 shadow-panel">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Executive summary</p>
            <h2 className="mt-1 text-2xl font-semibold text-white">Overview</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="rounded-lg border border-slate-800 bg-[#0F9D58]/10 px-3 py-1.5 text-xs font-semibold text-[#0F9D58]">7D Trend</button>
            <button className="rounded-lg border border-slate-800 bg-[#111827] px-3 py-1.5 text-xs text-slate-200 hover:border-[#0F9D58]">Export report</button>
          </div>
        </div>
      </section>

      <section className="grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-6">
        {overviewMetrics.map((metric) => (
          <MetricCard
            key={metric.title}
            title={metric.title}
            value={metric.value}
            delta={metric.delta}
            trend={metric.trend}
            caption={metric.title === 'Error Rate' ? 'Critical alert monitoring' : 'Stable performance'}
            accent={metric.trend === 'down' ? 'bg-[#EF4444]/15 text-[#EF4444]' : 'bg-[#0F9D58]/15 text-[#0F9D58]'}
          />
        ))}
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <ChartCard className="min-h-[250px]" title="Request volume" meta="Trailing seven-day request trend" footer="Peak traffic at 16:00 UTC.">
          <div className="h-full w-full"><LineChart points={requestTimeline} /></div>
        </ChartCard>
        <ChartCard className="min-h-[250px]" title="Token utilization" meta="Token burn per call" footer="High efficiency across models.">
          <div className="h-full w-full"><LineChart points={tokenUsageTimeline} accent="#3B82F6" /></div>
        </ChartCard>
      </section>

      <section className="grid gap-3 xl:grid-cols-4">
        <div className="card rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3 shadow-panel">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.24em] text-slate-500">Provider health</p>
              <p className="mt-1 text-lg font-semibold text-white">Gateway status</p>
            </div>
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[#0F9D58]/15 text-[#0F9D58]">
              <ShieldCheck size={18} />
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {providerHealth.map((provider) => (
              <div key={provider.name} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800/80 bg-[#0B1119] p-2.5">
                <div>
                  <p className="font-medium text-white">{provider.name}</p>
                  <p className="text-sm text-slate-400">{provider.throughput} • {provider.latency}</p>
                </div>
                <StatusPill label={provider.status} tone={provider.status === 'Healthy' ? 'success' : provider.status === 'Review' ? 'warning' : 'danger'} />
              </div>
            ))}
          </div>
        </div>

        <ChartCard className="min-h-[250px]" title="Model allocation" meta="Request distribution by provider" action={<span className="text-sm text-slate-400">Updated 5m ago</span>}>
          <div className="flex h-full items-center justify-center"><DonutChart segments={[{ label: 'OpenAI', value: 44, color: '#0F9D58' }, { label: 'Groq', value: 22, color: '#3B82F6' }, { label: 'DeepSeek', value: 18, color: '#F59E0B' }, { label: 'Gemini', value: 12, color: '#A855F7' }, { label: 'Other', value: 4, color: '#64748B' }]} /></div>
        </ChartCard>

        <div className="card rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3 shadow-panel xl:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Cache efficiency</p>
              <p className="mt-1 text-lg font-semibold text-white">Retrieval cache hit rate</p>
            </div>
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[#3B82F6]/15 text-[#3B82F6]">
              <Layers size={18} />
            </span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="rounded-lg bg-[#0B1119] p-2.5">
              <p className="text-xs text-slate-400">Current hit rate</p>
              <p className="mt-2 text-2xl font-semibold text-white">95.7%</p>
              <div className="mt-2 h-2.5 overflow-hidden rounded-lg bg-slate-950">
                <div className="h-full rounded-lg bg-[#0F9D58]" style={{ width: '95.7%' }} />
              </div>
            </div>
            <div className="rounded-lg bg-[#0B1119] p-2.5">
              <p className="text-xs text-slate-400">Retention window</p>
              <p className="mt-2 text-2xl font-semibold text-white">24h</p>
              <p className="mt-2 text-sm text-slate-400">Stable cache conditions across the observability layer.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-3">
        <div className="card rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3 shadow-panel xl:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Recent evaluations</p>
              <p className="mt-1 text-lg font-semibold text-white">Operational timeline</p>
            </div>
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[#0F9D58]/15 text-[#0F9D58]">
              <Sparkles size={18} />
            </span>
          </div>
          <div className="mt-2 divide-y divide-slate-800/80">
            {liveRequests.slice(0, 3).map((req) => (
              <div key={req.id} className="flex items-center justify-between gap-3 py-2 text-sm text-slate-300">
                <div className="min-w-0">
                  <p className="font-semibold text-white">{req.id}</p>
                  <p className="truncate text-xs text-slate-400">{req.source} • {req.model}</p>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-300">
                  <span>{req.latency}</span>
                  <StatusPill label={req.status} tone={req.status === 'Success' ? 'success' : req.status === 'Warning' ? 'warning' : 'danger'} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <ChartCard title="Recent alerts" meta="Triggered events and severity counts">
          <div className="grid gap-2 text-sm text-slate-300">
            <div className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-[#0B1119] p-2.5">
              <div>
                <p className="font-semibold text-white">Model drift alert</p>
                <p className="text-slate-400">OpenAI latency drift exceeding threshold.</p>
              </div>
              <StatusPill label="Warning" tone="warning" />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-[#0B1119] p-3">
              <div>
                <p className="font-semibold text-white">Cache miss surge</p>
                <p className="text-slate-400">Context retrieval failures spiked 15%.</p>
              </div>
              <StatusPill label="Critical" tone="danger" />
            </div>
          </div>
        </ChartCard>
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <div className="card rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3 shadow-panel">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Live feed</p>
              <p className="mt-1 text-lg font-semibold text-white">Recent requests</p>
            </div>
            <span className="text-xs text-slate-400">Streaming</span>
          </div>
          <div className="mt-2 space-y-2">
            {liveRequests.map((req) => (
              <div key={req.id} className="flex flex-col gap-2 rounded-lg border border-slate-800/80 bg-[#0B1119] p-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-semibold text-white">{req.id}</p>
                  <p className="text-xs text-slate-400">{req.source} • {req.model}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-300">
                  <span>{req.latency}</span>
                  <StatusPill label={req.status} tone={req.status === 'Success' ? 'success' : req.status === 'Warning' ? 'warning' : 'danger'} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card rounded-lg border border-slate-800/80 bg-[#151C26]/95 p-3 shadow-panel">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Activity</p>
              <p className="mt-1 text-lg font-semibold text-white">Operational timeline</p>
            </div>
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-[#3B82F6]/15 text-[#3B82F6]">
              <Activity size={18} />
            </span>
          </div>
          <div className="mt-2 space-y-2">
            {activityTimeline.map((item) => (
              <div key={item.time} className="rounded-lg border border-slate-800/80 bg-[#0B1119] p-2.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-white">{item.label}</p>
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-500">{item.time}</span>
                </div>
                <p className="mt-2 text-sm text-slate-400">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
