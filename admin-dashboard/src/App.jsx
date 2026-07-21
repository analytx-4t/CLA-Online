import { Routes, Route } from 'react-router-dom';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Sidebar from './components/Sidebar';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import OverviewPage from './pages/OverviewPage';
import RagasPage from './pages/RagasPage';
import MonitoringPages from './pages/MonitoringPages';
import SettingsPage from './pages/SettingsPage';
import RequestDetailsPage from './pages/RequestDetailsPage';
import NotFoundPage from './pages/NotFoundPage';

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#05070A] text-slate-100 transition-colors duration-300">
      <div className="relative flex min-h-screen">
        <div className="hidden lg:block">
          <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((prev) => !prev)} />
        </div>

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-30 bg-slate-950/45 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.aside initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} transition={{ type: 'spring', stiffness: 260, damping: 24 }} className="fixed inset-y-0 left-0 z-40 lg:hidden">
              <Sidebar collapsed={false} onToggle={() => setMobileMenuOpen(false)} />
            </motion.aside>
          )}
        </AnimatePresence>

        <div className="flex min-h-screen flex-1 flex-col">
          <Navbar title="Operations Dashboard" onMenuToggle={() => setMobileMenuOpen(true)} />
          <main className="mx-auto flex-1 w-full max-w-[1680px] p-4 sm:p-5 lg:p-6">
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/ragas" element={<RagasPage />} />
              <Route path="/portkey" element={<MonitoringPages page="portkey" />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/request/:requestId" element={<RequestDetailsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </main>
          <Footer />
        </div>
      </div>
    </div>
  );
}
