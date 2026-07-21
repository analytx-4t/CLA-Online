import { createContext, useContext, useMemo, useState } from 'react';

const MonitoringContext = createContext(null);

export function MonitoringProvider({ children }) {
  const [activePage, setActivePage] = useState(null);

  const value = useMemo(
    () => ({ activePage, setActivePage }),
    [activePage]
  );

  return <MonitoringContext.Provider value={value}>{children}</MonitoringContext.Provider>;
}

export function useMonitoring() {
  const context = useContext(MonitoringContext);
  if (!context) {
    throw new Error('useMonitoring must be used within a MonitoringProvider');
  }
  return context;
}
