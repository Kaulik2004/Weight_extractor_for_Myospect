import { AnimatePresence, motion } from 'framer-motion'
import { Cpu, FlaskConical, RotateCcw, SlidersHorizontal, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../lib/api'
import { ENGINE_LABELS, FLAG_LABELS, fmtPct } from '../../lib/format'
import { AI_ENGINES, isAiEngine } from '../../lib/types'
import type { EngineName, OcrOptions } from '../../lib/types'
import { DEFAULT_OPTIONS, canExtract, roiAtFrame, useStore } from '../../store'
import { Field, NeonButton, Segmented, Slider, Toggle } from '../ui/controls'
import { Panel } from '../ui/Panel'

const ENGINE_INFO: Record<EngineName, string> = {
  gemini: 'Google Gemini reads the display like the Gemini app does',
  claude: 'Anthropic Claude reads the display like the Claude app does',
  openai: 'OpenAI (ChatGPT) vision model reads the display',
  groq: 'Groq-hosted open vision model: fast and cheap, but noticeably less accurate',
  easyocr: 'Local EasyOCR model on the thresholded ROI (no API key, GPU if available)',
}

export function OcrSettingsPanel() {
  const meta = useStore((s) => s.meta)!
  const roi = useStore((s) => s.roi)
  const roiEnd = useStore((s) => s.roiEnd)
  const sampling = useStore((s) => s.sampling)
  const o = useStore((s) => s.options)
  const setOptions = useStore((s) => s.setOptions)
  const engines = useStore((s) => s.engines)
  const frame = useStore((s) => s.currentFrame)
  const test = useStore((s) => s.test)
  const unit = useStore((s) => s.unit)
  const running = useStore((s) => s.job.status === 'running')
  const ready = useStore(canExtract)
  const ai = isAiEngine(o.engine)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)

  const runTest = async () => {
    if (!ready) return
    setBusy(true)
    setErr(null)
    try {
      // Use the same interpolated box the extraction job would use at this frame (none = whole frame).
      const effectiveRoi = roi ? roiAtFrame(frame, roi, roiEnd, sampling) : null
      useStore.setState({ test: await api.ocrTest(meta.id, frame, effectiveRoi, o) })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const num = (v: string) => (v.trim() === '' ? null : Number(v))

  return (
    <Panel
      title="OCR Engine"
      icon={<Cpu size={14} />}
      delay={0.1}
      actions={
        <button
          onClick={() => setOptions(DEFAULT_OPTIONS)}
          className="flex items-center gap-1 text-[11px] text-ink-mute hover:text-neon-soft"
          title="Reset OCR settings"
        >
          <RotateCcw size={11} /> reset
        </button>
      }
    >
      <fieldset disabled={running} className="space-y-4 disabled:opacity-60">
        <Field label="Engine">
          <select className="field" value={o.engine} onChange={(e) => setOptions({ engine: e.target.value as EngineName })}>
            {AI_ENGINES.map((e) => (
              <option key={e} value={e} disabled={!engines[e]}>
                ✨ {ENGINE_LABELS[e]} AI{engines[e] ? '' : ' (add API key)'}
              </option>
            ))}
            <option value="easyocr" disabled={!engines.easyocr}>
              EasyOCR (local){engines.easyocr ? '' : ' (not installed)'}
            </option>
          </select>
          <p className="text-[11px] leading-snug text-ink-mute">{ENGINE_INFO[o.engine]}</p>
          {ai && (
            <div className="flex items-start gap-2 rounded-md border border-neon/40 bg-gradient-to-br from-neon-deep/20 to-neon/10 px-3 py-2 text-[11px] leading-snug text-neon-soft shadow-neon">
              <Sparkles size={13} className="mt-0.5 shrink-0" />
              <span>
                Sampled frames go to {ENGINE_LABELS[o.engine]} in chronological batches, labelled with
                their timestamps, so the model can cross-check neighbouring frames the way it does when
                you upload the clip in its app. An ROI is optional: without one it reads the whole frame,
                and with one it gets a closer view of the display. Frames leave this machine and use your
                API quota.
              </span>
            </div>
          )}
          {!engines[o.engine] && (
            <p role="alert" className="text-[11px] leading-snug text-warn">
              Not configured: add the API key to <code className="font-mono">backend/.env</code> and restart the backend.
            </p>
          )}
        </Field>

        {!ai && (
          <Field label="Display type">
            <Segmented<OcrOptions['polarity']>
              ariaLabel="Display polarity"
              value={o.polarity}
              onChange={(polarity) => setOptions({ polarity })}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'dark_on_light', label: 'LCD' },
                { value: 'light_on_dark', label: 'LED' },
              ]}
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Decimals" hint="fixes lost '.'">
            <select
              className="field"
              value={o.decimals ?? ''}
              onChange={(e) => setOptions({ decimals: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">As read</option>
              {[0, 1, 2, 3].map((d) => (
                <option key={d} value={d}>
                  {d} ({(0).toFixed(d)})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Rotate ROI">
            <select className="field" value={o.rotate} onChange={(e) => setOptions({ rotate: Number(e.target.value) as OcrOptions['rotate'] })}>
              {[0, 90, 180, 270].map((r) => (
                <option key={r} value={r}>
                  {r}°
                </option>
              ))}
            </select>
          </Field>
        </div>

        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          className="flex items-center gap-1.5 text-xs text-ink-dim hover:text-neon-soft"
          aria-expanded={advanced}
        >
          <SlidersHorizontal size={12} /> {advanced ? 'Hide' : 'Show'} {ai ? 'validation' : 'preprocessing & validation'}
        </button>

        <AnimatePresence initial={false}>
          {advanced && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="space-y-4 overflow-hidden"
            >
              {!ai && (
                <>
                  <Field label="Threshold">
                    <select className="field" value={o.threshold} onChange={(e) => setOptions({ threshold: e.target.value as OcrOptions['threshold'] })}>
                      <option value="otsu">Otsu (global)</option>
                      <option value="adaptive">Adaptive (uneven light / glare)</option>
                      <option value="none">None (grayscale to OCR model)</option>
                    </select>
                  </Field>
                  <Field label="Upscale" hint={`${o.upscale.toFixed(1)}×`}>
                    <Slider ariaLabel="Upscale" value={o.upscale} min={1} max={6} step={0.5} onChange={(upscale) => setOptions({ upscale })} />
                  </Field>
                  <Field label="Blur" hint={o.blur ? `${o.blur | 1}px` : 'off'}>
                    <Slider ariaLabel="Blur" value={o.blur} min={0} max={11} onChange={(blur) => setOptions({ blur })} />
                  </Field>
                </>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Min (${unit})`}>
                  <input className="field" type="number" value={o.min_value ?? ''} placeholder="none" onChange={(e) => setOptions({ min_value: num(e.target.value) })} />
                </Field>
                <Field label={`Max (${unit})`}>
                  <input className="field" type="number" value={o.max_value ?? ''} placeholder="none" onChange={(e) => setOptions({ max_value: num(e.target.value) })} />
                </Field>
              </div>
              <Toggle checked={o.allow_negative} onChange={(allow_negative) => setOptions({ allow_negative })} label="Allow negative readings (tare)" />
            </motion.div>
          )}
        </AnimatePresence>

        <NeonButton
          type="button"
          className="w-full"
          icon={<FlaskConical size={14} />}
          disabled={!ready || busy || !engines[o.engine]}
          onClick={runTest}
          title={ready ? undefined : 'Draw an ROI first'}
        >
          {busy ? 'Analysing…' : `Test on frame #${frame}`}
        </NeonButton>
      </fieldset>

      {err && <p role="alert" className="mt-3 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{err}</p>}

      <AnimatePresence>
        {test && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-4 space-y-2 rounded-lg border border-white/5 bg-void/60 p-3"
          >
            <div className="flex items-baseline justify-between">
              <span className="hud-label">Test · frame #{test.frame_index}</span>
              <span className="font-mono text-[10px] text-ink-mute">{test.engine} · {test.elapsed_ms} ms</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className={`font-display text-2xl ${test.value == null ? 'text-bad' : 'text-neon-soft text-glow'}`}>
                {test.value ?? '—'}
              </span>
              <span className="text-xs text-ink-mute">{unit}</span>
              <span className="ml-auto font-mono text-xs text-ink-dim">conf {fmtPct(test.confidence)}</span>
            </div>
            {test.engine === 'easyocr' ? (
              <div className="grid grid-cols-2 gap-2">
                <figure>
                  <img src={test.preview} alt="Annotated ROI" className="w-full rounded border border-edge" />
                  <figcaption className="mt-1 text-[10px] text-ink-mute">Detections</figcaption>
                </figure>
                <figure>
                  <img src={test.input_image} alt="Binarised ROI" className="w-full rounded border border-edge" />
                  <figcaption className="mt-1 text-[10px] text-ink-mute">What EasyOCR sees</figcaption>
                </figure>
              </div>
            ) : (
              <figure>
                <img src={test.input_image} alt="Image sent to the model" className="w-full rounded border border-edge" />
                <figcaption className="mt-1 text-[10px] text-ink-mute">What the model sees</figcaption>
              </figure>
            )}
            <p className="font-mono text-[11px] text-ink-mute">
              raw “{test.text || ' '}”
              {test.flags.map((f) => (
                <span key={f} className="ml-2 text-warn">⚠ {FLAG_LABELS[f] ?? f}</span>
              ))}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  )
}
