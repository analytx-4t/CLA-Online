import { motion } from 'framer-motion';

export default function MetricCard({ title, value, delta, trend, icon: Icon, accent, caption }) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      className="card group relative overflow-hidden border border-slate-800/80 bg-[#151C26]/95 px-4 py-4 shadow-panel min-h-[112px]"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">{title}</p>
          <p className="mt-2 text-[30px] font-semibold text-white sm:text-[34px]">{value}</p>
        </div>
        {Icon && (
          <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${accent || 'bg-slate-900 text-slate-300'}`}>
            <Icon size={18} />
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-slate-400">
        {delta && <span className={`rounded-sm px-2 py-1 ${trend === 'down' ? 'bg-rose-500/10 text-rose-400' : 'bg-emerald-500/10 text-emerald-400'}`}>{delta}</span>}
        {caption && <span>{caption}</span>}
      </div>
    </motion.div>
  );
}
