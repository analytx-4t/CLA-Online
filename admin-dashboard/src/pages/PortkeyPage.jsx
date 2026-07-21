import MonitoringFrame from '../components/MonitoringFrame';
import { MONITORING_URLS } from '../config/monitoringUrls';

export default function PortkeyPage() {
  return <MonitoringFrame title="Portkey Analytics" url={MONITORING_URLS.portkey} />;
}
