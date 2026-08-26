import { Routes, Route } from 'react-router-dom';
import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Sidebar from './components/Sidebar';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import OverviewPage from './pages/OverviewPage';
import OnlineEvalPage from './pages/OnlineEvalPage';
import SettingsPage from './pages/SettingsPage';
import RequestDetailsPage from './pages/RequestDetailsPage';
import GoldenDatasetPage from './pages/GoldenDatasetPage';
import RetrievalEvalPage from './pages/RetrievalEvalPage';
import GenerationEvalPage from './pages/GenerationEvalPage';
import NotFoundPage from './pages/NotFoundPage';

export default function App() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="relative min-h-screen overflow-hidden bg-canvas text-ink transition-colors duration-300">
      <div className="relative flex min-h-screen">
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((prev) => !prev)} fixed />
        {/* Reserves the fixed sidebar's width in the flex row so the main
            column doesn't render underneath it. */}
        <div className={`hidden lg:block flex-shrink-0 transition-all duration-200 ease-in-out ${sidebarCollapsed ? 'w-[84px]' : 'w-[260px]'}`} aria-hidden="true" />

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-30 bg-overlay/55 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.aside initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} transition={{ type: 'spring', stiffness: 260, damping: 24 }} className="fixed inset-y-0 left-0 z-40 lg:hidden">
              <Sidebar collapsed={false} onToggle={() => setMobileMenuOpen(false)} />
            </motion.aside>
          )}
        </AnimatePresence>

        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <Navbar onMenuToggle={() => setMobileMenuOpen(true)} />
          <main className="mx-auto min-w-0 flex-1 w-full max-w-[1680px] p-4 sm:p-5 lg:p-6">
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/golden-dataset" element={<GoldenDatasetPage />} />
              <Route path="/retrieval-eval" element={<RetrievalEvalPage />} />
              <Route path="/generation-eval" element={<GenerationEvalPage />} />
              <Route path="/online-eval" element={<OnlineEvalPage />} />
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
