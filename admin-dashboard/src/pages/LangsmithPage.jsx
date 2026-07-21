import MonitoringFrame from '../components/MonitoringFrame';
import { MONITORING_URLS } from '../config/monitoringUrls';

export default function LangsmithPage() {
  return <MonitoringFrame title="LangSmith Monitor" url={MONITORING_URLS.langsmith} />;
}