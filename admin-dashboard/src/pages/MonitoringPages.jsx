import { useParams } from 'react-router-dom';
import PortkeyPage from './PortkeyPage';

const pageComponents = {
  portkey: PortkeyPage,
};

export default function MonitoringPages({ page }) {
  const params = useParams();
  const activeKey = page || params.monitoringPage;
  const Component = pageComponents[activeKey];

  if (!Component) {
    return (
      <div className="rounded-xl border border-slate-800/80 bg-[#0C1119] p-6 text-slate-300">
        <h1 className="text-xl font-semibold text-white">Page not found</h1>
        <p className="mt-3 text-sm">The monitoring page you requested is unavailable.</p>
      </div>
    );
  }

  return <Component />;
}

