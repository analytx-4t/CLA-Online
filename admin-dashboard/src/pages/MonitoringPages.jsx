import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import MonitoringFrame from '../components/MonitoringFrame';
import { MONITORING_URLS } from '../config/monitoringUrls';

const pages = {
  portkey: {
    title: 'Portkey Analytics',
    url: MONITORING_URLS.portkey,
  },
  langsmith: {
    title: 'LangSmith Monitor',
    url: MONITORING_URLS.langsmith,
  },
  logfire: {
    title: 'Logfire Monitor',
    url: MONITORING_URLS.logfire,
  },
};

export default function MonitoringPages({ page }) {
  const params = useParams();
  const activeKey = page || params.monitoringPage;
  const activePage = pages[activeKey];

  const frames = useMemo(
    () =>
      Object.entries(pages).map(([key, config]) => (
        <div key={key} className={key === activeKey ? 'block' : 'hidden'}>
          <MonitoringFrame title={config.title} url={config.url} />
        </div>
      )),
    [activeKey]
  );

  if (!activePage) {
    return (
      <div className="rounded-xl border border-slate-800/80 bg-[#0C1119] p-6 text-slate-300">
        <h1 className="text-xl font-semibold text-white">Page not found</h1>
        <p className="mt-3 text-sm">The monitoring page you requested is unavailable.</p>
      </div>
    );
  }

  return <div className="flex min-h-[calc(100vh-170px)] flex-col gap-4">{frames}</div>;
}
