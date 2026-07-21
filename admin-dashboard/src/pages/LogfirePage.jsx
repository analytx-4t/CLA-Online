import MonitoringFrame from '../components/MonitoringFrame';
import { MONITORING_URLS } from '../config/monitoringUrls';

export default function LogfirePage() {
  return <MonitoringFrame title="Logfire Monitor" url={MONITORING_URLS.logfire} />;
}