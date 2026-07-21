import { useEffect, useRef, useState } from 'react';

export default function MonitoringFrame({ url, title }) {
  const iframeRef = useRef(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);
  const [isReloading, setIsReloading] = useState(false);

  useEffect(() => {
    setStatus('loading');
    setError(null);
  }, [url]);

  return (
    <div className="flex min-h-[calc(100vh-170px)] w-full flex-col overflow-hidden rounded-xl border border-slate-800/80 bg-[#0B1220]">
      <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 bg-[#0B0F14] px-4 py-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Embedded monitor</p>
          <h1 className="text-lg font-semibold text-white">{title}</h1>
        </div>
        <button
          type="button"
          onClick={() => {
            setIsReloading(true);
            setStatus('loading');
            setError(null);
            if (iframeRef.current) {
              iframeRef.current.src = url;
            }
          }}
          className="inline-flex items-center justify-center rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-900"
        >
          Reload
        </button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {status === 'loading' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/80 text-center text-slate-200">
            <div className="flex flex-col items-center gap-3">
              <div className="h-12 w-12 animate-spin rounded-full border-4 border-slate-600 border-t-[#0F9D58]" />
              <p>Loading monitor…</p>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/90 px-6 text-center text-slate-100">
            <div className="max-w-lg rounded-xl border border-red-600/30 bg-[#1F2937] p-6 shadow-lg">
              <p className="text-sm uppercase tracking-[0.24em] text-red-300">Unable to load monitor</p>
              <p className="mt-3 text-base text-slate-200">The embedded page could not be loaded. Check your network or open it directly in a new tab.</p>
              <button
                type="button"
                onClick={() => {
                  setStatus('loading');
                  setError(null);
                  if (iframeRef.current) {
                    iframeRef.current.src = url;
                  }
                }}
                className="mt-4 inline-flex items-center justify-center rounded-md bg-[#0F9D58] px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-[#0B7A45]"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        <iframe
          ref={iframeRef}
          title={title}
          src={url}
          className="h-full w-full border-0"
          onLoad={() => {
            setStatus('loaded');
            setIsReloading(false);
          }}
          onError={() => {
            setStatus('error');
            setError('Failed to load iframe');
            setIsReloading(false);
          }}
        />
      </div>
    </div>
  );
}
