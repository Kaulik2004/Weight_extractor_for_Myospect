import { Sigma } from 'lucide-react'
import { effectiveSamples, useStore } from '../../store'
import { Field, Segmented, Slider } from '../ui/controls'
import { Panel } from '../ui/Panel'

export function SamplingPanel() {
  const meta = useStore((s) => s.meta)!
  const sampling = useStore((s) => s.sampling)
  const setSampling = useStore((s) => s.setSampling)
  const frame = useStore((s) => s.currentFrame)
  const running = useStore((s) => s.job.status === 'running')

  const span = sampling.end - sampling.start + 1
  const spanSec = span / meta.fps
  const n = effectiveSamples(sampling, meta)
  const intervalFrames = span / n
  const maxN = Math.min(span, 20000)

  return (
    <Panel title="Frame Sampling" icon={<Sigma size={14} />} delay={0.05}>
      <fieldset disabled={running} className="space-y-4 disabled:opacity-60">
        <Segmented
          ariaLabel="Sampling mode"
          value={sampling.mode}
          onChange={(mode) => setSampling({ mode })}
          options={[
            { value: 'total', label: 'Total frames (N)' },
            { value: 'rate', label: 'Per second' },
          ]}
        />

        {sampling.mode === 'total' ? (
          <Field label="Sampling frames N" hint={`1 – ${maxN}`}>
            <div className="flex items-center gap-3">
              <Slider ariaLabel="N" value={Math.min(sampling.total, maxN)} min={1} max={Math.min(maxN, 2000)} onChange={(total) => setSampling({ total })} />
              <input
                type="number"
                className="field w-24 text-right"
                min={1}
                max={maxN}
                value={sampling.total}
                onChange={(e) => setSampling({ total: Math.max(1, Math.min(maxN, Number(e.target.value) || 1)) })}
              />
            </div>
          </Field>
        ) : (
          <Field label="Samples per second" hint={`video ${meta.fps.toFixed(2)} fps`}>
            <div className="flex items-center gap-3">
              <Slider ariaLabel="Samples per second" value={sampling.rate} min={0.1} max={Math.max(1, Math.round(meta.fps))} step={0.1} onChange={(rate) => setSampling({ rate })} />
              <input
                type="number"
                step={0.1}
                className="field w-24 text-right"
                min={0.01}
                max={meta.fps}
                value={sampling.rate}
                onChange={(e) => setSampling({ rate: Math.max(0.01, Math.min(meta.fps, Number(e.target.value) || 1)) })}
              />
            </div>
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Start frame">
            <div className="flex gap-1">
              <input
                type="number"
                className="field"
                min={0}
                max={sampling.end}
                value={sampling.start}
                onChange={(e) => setSampling({ start: Math.max(0, Math.min(sampling.end, Number(e.target.value) || 0)) })}
              />
              <button
                type="button"
                title="Set start to the current frame"
                onClick={() => setSampling({ start: Math.min(frame, sampling.end) })}
                className="rounded-md border border-edge px-2 font-mono text-xs text-ink-dim hover:border-neon/60 hover:text-neon-soft"
              >
                [
              </button>
            </div>
          </Field>
          <Field label="End frame">
            <div className="flex gap-1">
              <input
                type="number"
                className="field"
                min={sampling.start}
                max={meta.frame_count - 1}
                value={sampling.end}
                onChange={(e) =>
                  setSampling({ end: Math.min(meta.frame_count - 1, Math.max(sampling.start, Number(e.target.value) || 0)) })
                }
              />
              <button
                type="button"
                title="Set end to the current frame"
                onClick={() => setSampling({ end: Math.max(frame, sampling.start) })}
                className="rounded-md border border-edge px-2 font-mono text-xs text-ink-dim hover:border-neon/60 hover:text-neon-soft"
              >
                ]
              </button>
            </div>
          </Field>
        </div>
        {(sampling.start > 0 || sampling.end < meta.frame_count - 1) && (
          <button
            type="button"
            onClick={() => setSampling({ start: 0, end: meta.frame_count - 1 })}
            className="text-xs text-neon-soft hover:underline"
          >
            Reset to full video
          </button>
        )}

        {/* Formula readout */}
        <div className="space-y-1.5 rounded-lg border border-neon/20 bg-neon/[0.04] p-3 font-mono text-xs">
          <Row k="Total Extracted Datapoints" v={<span className="text-neon-soft text-glow">N = {n}</span>} />
          <Row k="Frame interval" v={`${intervalFrames.toFixed(2)} frames ≈ ${(intervalFrames / meta.fps).toFixed(3)} s`} />
          <Row k="Effective rate" v={`${(n / spanSec).toFixed(2)} Hz`} />
          <Row k="Range" v={`${span} frames · ${spanSec.toFixed(2)} s`} />
        </div>
      </fieldset>
    </Panel>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-mute">{k}</span>
      <span className="text-right text-ink">{v}</span>
    </div>
  )
}
