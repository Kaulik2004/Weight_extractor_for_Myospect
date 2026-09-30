import { AnimatePresence, motion } from 'framer-motion'
import { Activity, CircleStop, Radar, Sparkles, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useExtraction } from '../../hooks/useExtraction'
import { ENGINE_LABELS, FLAG_LABELS, fmtPct, fmtTime } from '../../lib/format'
import { isAiEngine } from '../../lib/types'
import { canExtract, effectiveSamples, useStore } from '../../store'
import { NeonButton, Stat } from '../ui/controls'
import { Panel } from '../ui/Panel'

export function ProcessingPanel() {
  const meta = useStore((s) => s.meta)!
  const roi = useStore((s) => s.roi)
  const job = useStore((s) => s.job)
  const live = useStore((s) => s.live)
  const unit = useStore((s) => s.unit)
  const engine = useStore((s) => s.options.engine)
  const ready = useStore(canExtract)
  const configured = useStore((s) => s.engines[s.options.engine])
  const n = useStore((s) => effectiveSamples(s.sampling, s.meta))
  const { start, cancel } = useExtraction()
  const running = job.status === 'running'
  const progress = job.total ? job.processed / job.total : 0

  // Wall-clock timer for rate / ETA while running.
  const t0 = useRef(0)
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!running) return
    t0.current = performance.now()
    const t = setInterval(() => setNow(performance.now()), 250)
    return () => clearInterval(t)
  }, [running])
  const elapsed = running ? Math.max(0.001, (now - t0.current) / 1000) : (job.elapsed ?? 0)
  const rate = running ? job.processed / elapsed : (job.rate ?? (elapsed ? job.processed / elapsed : 0))
  const eta = running && rate > 0 ? (job.total - job.processed) / rate : 0

  return (
    <Panel
      title="Processing Engine"
      icon={<Radar size={14} />}
      delay={0.15}
      actions={
        running && (
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-neon-soft">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-neon" /> LIVE
          </span>
        )
      }
    >
      <div className="space-y-4">
        {running ? (
          <NeonButton variant="danger" className="w-full" icon={<CircleStop size={15} />} onClick={cancel}>
            Abort extraction
          </NeonButton>
        ) : (
          <NeonButton
            variant="primary"
            className="w-full py-2.5"
            icon={<Zap size={15} />}
            disabled={!ready || !configured}
            onClick={() => void start()}
            title={configured ? undefined : `${ENGINE_LABELS[engine]} is not configured: add its API key to backend/.env`}
          >
            {!configured
              ? `${ENGINE_LABELS[engine]} not configured`
              : !ready
                ? 'Select an ROI to begin'
                : roi
                  ? `Extract ${n} datapoints`
                  : `Extract ${n} datapoints · whole frame`}
          </NeonButton>
        )}

        {job.status !== 'idle' && (
          <div className="space-y-2">
            <div className="relative h-2 overflow-hidden rounded-full bg-edge">
              <motion.div
                className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-neon-deep via-neon to-neon-soft"
                style={{ boxShadow: '0 0 12px rgb(168 85 247 / 0.8)' }}
                animate={{ width: `${progress * 100}%` }}
                transition={{ ease: 'linear', duration: 0.2 }}
              />
            </div>
            <div className="flex justify-between font-mono text-[11px] text-ink-mute">
              <span>
                {job.processed}/{job.total} frames
              </span>
              <span>
                {job.status === 'running' && eta > 0 && `ETA ${fmtTime(eta)}`}
                {job.status === 'done' && <span className="text-ok">complete</span>}
                {job.status === 'cancelled' && <span className="text-warn">aborted</span>}
                {job.status === 'error' && <span className="text-bad">error</span>}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Read" value={job.processed ? fmtPct(job.recognised / job.processed) : '—'} accent />
              <Stat label="Speed" value={rate ? `${rate.toFixed(1)} f/s` : '—'} />
              <Stat label="Elapsed" value={`${elapsed.toFixed(1)} s`} />
            </div>
            {job.error && (
              <p role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
                {job.error}
              </p>
            )}
          </div>
        )}

        {/* Live feed: what the engine is reading right now */}
        <div className="overflow-hidden rounded-lg border border-edge bg-black/60">
          <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5">
            <Activity size={12} className="text-neon" />
            <span className="hud-label">Live feed</span>
            {isAiEngine(engine) && (
              <span className="flex items-center gap-1 rounded-full bg-gradient-to-r from-neon-deep to-neon px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white shadow-neon">
                <Sparkles size={10} /> {ENGINE_LABELS[engine]}
              </span>
            )}
            {live && (
              <span className="ml-auto font-mono text-[10px] text-ink-mute">
                #{live.frame_index} · {live.timestamp.toFixed(3)} s
              </span>
            )}
          </div>
          <div className="scanlines relative flex min-h-[120px] items-center justify-center p-2">
            <AnimatePresence mode="popLayout">
              {live?.preview ? (
                <motion.img
                  key={live.preview.length + live.frame_index}
                  src={live.preview}
                  alt="Frame currently being read"
                  initial={{ opacity: 0.6 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.12 }}
                  className="max-h-40 w-auto rounded"
                />
              ) : (
                <span className="text-xs text-ink-mute">
                  {ready ? 'Frames appear here while extracting' : `No ROI selected · ${meta.width}×${meta.height}`}
                </span>
              )}
            </AnimatePresence>
          </div>
          {live && (
            <div className="flex items-end gap-3 border-t border-white/5 px-3 py-2">
              <div>
                <div className="hud-label">Reading</div>
                <div className={`font-display text-3xl leading-tight ${live.value == null ? 'text-bad' : 'text-neon-soft text-glow'}`}>
                  {live.value ?? '— —'}
                  <span className="ml-1 font-sans text-sm text-ink-mute">{unit}</span>
                </div>
              </div>
              <div className="ml-auto w-28">
                <div className="hud-label mb-1 text-right">Confidence {fmtPct(live.confidence)}</div>
                <div className="h-1.5 overflow-hidden rounded-full bg-edge">
                  <div
                    className={`h-full rounded-full ${live.confidence >= 0.6 ? 'bg-neon' : live.confidence > 0 ? 'bg-warn' : 'bg-bad'}`}
                    style={{ width: `${live.confidence * 100}%` }}
                  />
                </div>
              </div>
            </div>
          )}
          {live && live.flags.length > 0 && (
            <p className="px-3 pb-2 text-[11px] text-warn">⚠ {live.flags.map((f) => FLAG_LABELS[f] ?? f).join(' · ')}</p>
          )}
        </div>
      </div>
    </Panel>
  )
}
