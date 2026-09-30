import { motion } from 'framer-motion'
import { Scale } from 'lucide-react'
import { fmtBytes, fmtTime } from '../../lib/format'
import type { Unit } from '../../lib/types'
import { useStore } from '../../store'
import { Segmented } from '../ui/controls'

export function Header() {
  const backend = useStore((s) => s.backend)
  const engines = useStore((s) => s.engines)
  const meta = useStore((s) => s.meta)
  const unit = useStore((s) => s.unit)
  const set = useStore((s) => s.set)

  return (
    <motion.header
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="sticky top-0 z-40 border-b border-neon/15 bg-void/75 backdrop-blur-xl"
    >
      <div className="mx-auto flex max-w-[1680px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-neon/50 bg-neon/10 shadow-neon">
            <Scale size={18} className="text-neon-soft" />
          </div>
          <div>
            <div className="font-display text-sm font-bold tracking-[0.25em] text-ink">
              WEIGHT<span className="text-neon text-glow">//</span>EXTRACTOR
            </div>
            <div className="font-mono text-[10px] tracking-wider text-ink-mute">CV · OCR TELEMETRY CONSOLE</div>
          </div>
        </div>

        {meta && (
          <div className="hidden min-w-0 items-center gap-3 border-l border-edge pl-5 font-mono text-[11px] text-ink-dim lg:flex">
            <span className="max-w-56 truncate text-ink" title={meta.filename}>{meta.filename}</span>
            <span>{meta.width}×{meta.height}</span>
            <span>{meta.fps.toFixed(2)} fps</span>
            <span>{meta.frame_count} frames</span>
            <span>{fmtTime(meta.duration)}</span>
            <span>{fmtBytes(meta.size_bytes)}</span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-4">
          <div className="hidden items-center gap-1.5 sm:flex" aria-label="OCR engines">
            {(Object.keys(engines) as (keyof typeof engines)[]).map((k) => (
              <span
                key={k}
                title={engines[k] ? `${k} available` : `${k} not installed`}
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                  engines[k] ? 'border-neon/40 text-neon-soft' : 'border-edge text-ink-mute line-through'
                }`}
              >
                {k}
              </span>
            ))}
          </div>
          <div className="w-28">
            <Segmented<Unit>
              ariaLabel="Weight unit"
              value={unit}
              onChange={(u) => set({ unit: u })}
              options={[
                { value: 'kg', label: 'kg' },
                { value: 'lbs', label: 'lbs' },
              ]}
            />
          </div>
          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span
              className={`h-2 w-2 rounded-full ${
                backend === 'online' ? 'pulse-dot bg-neon' : backend === 'offline' ? 'bg-bad' : 'bg-ink-mute'
              }`}
            />
            <span className={backend === 'offline' ? 'text-bad' : 'text-ink-dim'}>
              {backend === 'online' ? 'ENGINE ONLINE' : backend === 'offline' ? 'BACKEND OFFLINE' : 'CONNECTING'}
            </span>
          </div>
        </div>
      </div>
    </motion.header>
  )
}
