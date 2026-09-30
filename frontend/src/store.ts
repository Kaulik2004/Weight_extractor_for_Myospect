import { create } from 'zustand'
import { AI_ENGINES, isAiEngine } from './lib/types'
import type { DataPoint, EngineName, Engines, FrameEvent, OcrOptions, Roi, TestResult, Unit, VideoMeta } from './lib/types'

export type JobStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error'
export type SamplingMode = 'total' | 'rate'

export interface Sampling {
  mode: SamplingMode
  /** N: total frames to sample (mode "total"). */
  total: number
  /** Samples per second of video (mode "rate"); interval = FPS / rate frames. */
  rate: number
  start: number
  end: number
}

interface State {
  backend: 'unknown' | 'online' | 'offline'
  engines: Engines
  /** Hosted backends need a password; 'required' shows the password screen. */
  auth: 'unknown' | 'required' | 'ok'
  /** Whether the backend may write CSVs to a path on its own disk (local runs only). */
  fsAccess: boolean

  file: File | null
  objectUrl: string | null
  meta: VideoMeta | null
  upload: { progress: number; busy: boolean; error: string | null }
  playerMode: 'native' | 'frames'

  currentFrame: number
  seek: { frame: number; nonce: number }

  roi: Roi | null
  /** Optional second box, positioned at sampling.end, for tracking a drifting/zooming camera. */
  roiEnd: Roi | null
  /** Which box a drag on the video edits. */
  roiTarget: 'start' | 'end'
  sampling: Sampling
  options: OcrOptions
  unit: Unit

  job: { status: JobStatus; total: number; processed: number; recognised: number; error: string | null; elapsed: number | null; rate: number | null }
  points: DataPoint[]
  live: FrameEvent | null
  test: TestResult | null
}

interface Actions {
  set: (p: Partial<State>) => void
  setBackend: (online: boolean, engines?: Engines) => void
  setVideo: (file: File, meta: VideoMeta) => void
  clearVideo: () => void
  seekTo: (frame: number) => void
  setRoi: (roi: Roi | null) => void
  setRoiEnd: (roi: Roi | null) => void
  setRoiTarget: (t: 'start' | 'end') => void
  setSampling: (p: Partial<Sampling>) => void
  setOptions: (p: Partial<OcrOptions>) => void
  resetJob: () => void
  pushFrames: (events: FrameEvent[]) => void
  editPoint: (frame: number, value: number | null) => void
  revertPoint: (frame: number) => void
}

export const DEFAULT_OPTIONS: OcrOptions = {
  engine: 'gemini',
  polarity: 'auto',
  threshold: 'otsu',
  upscale: 2,
  blur: 3,
  rotate: 0,
  decimals: null,
  min_value: null,
  max_value: null,
  allow_negative: true,
}

const idleJob: State['job'] = { status: 'idle', total: 0, processed: 0, recognised: 0, error: null, elapsed: null, rate: null }

export const useStore = create<State & Actions>((set, get) => ({
  backend: 'unknown',
  engines: { gemini: false, claude: false, openai: false, groq: false, easyocr: false },
  auth: 'unknown',
  fsAccess: false,
  file: null,
  objectUrl: null,
  meta: null,
  upload: { progress: 0, busy: false, error: null },
  playerMode: 'native',
  currentFrame: 0,
  seek: { frame: 0, nonce: 0 },
  roi: null,
  roiEnd: null,
  roiTarget: 'start',
  sampling: { mode: 'total', total: 100, rate: 5, start: 0, end: 0 },
  options: DEFAULT_OPTIONS,
  unit: 'kg',
  job: idleJob,
  points: [],
  live: null,
  test: null,

  set: (p) => set(p),
  setBackend: (online, engines) =>
    set((s) => {
      if (!online || !engines) return { backend: online ? 'online' : 'offline' }
      // Keep the chosen engine if it works; otherwise switch to the first configured one.
      const engine = engines[s.options.engine] ? s.options.engine : PREFERRED_ENGINES.find((e) => engines[e])
      return {
        backend: 'online',
        engines,
        options: engine && engine !== s.options.engine ? { ...s.options, engine } : s.options,
      }
    }),

  setVideo: (file, meta) => {
    const prev = get().objectUrl
    if (prev) URL.revokeObjectURL(prev)
    set({
      file,
      meta,
      objectUrl: URL.createObjectURL(file),
      playerMode: 'native',
      currentFrame: 0,
      roi: null,
      roiEnd: null,
      roiTarget: 'start',
      sampling: { ...get().sampling, start: 0, end: meta.frame_count - 1, total: Math.min(get().sampling.total, meta.frame_count) },
      job: idleJob,
      points: [],
      live: null,
      test: null,
    })
  },

  clearVideo: () => {
    const { objectUrl } = get()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    set({ file: null, meta: null, objectUrl: null, roi: null, roiEnd: null, roiTarget: 'start', job: idleJob, points: [], live: null, test: null, currentFrame: 0 })
  },

  seekTo: (frame) => {
    const meta = get().meta
    if (!meta) return
    const f = Math.max(0, Math.min(meta.frame_count - 1, Math.round(frame)))
    set((s) => ({ currentFrame: f, seek: { frame: f, nonce: s.seek.nonce + 1 } }))
  },

  setRoi: (roi) => set({ roi, test: null }),
  setRoiEnd: (roiEnd) => set({ roiEnd, test: null }),
  setRoiTarget: (roiTarget) => set({ roiTarget }),
  setSampling: (p) => set((s) => ({ sampling: { ...s.sampling, ...p } })),
  setOptions: (p) => set((s) => ({ options: { ...s.options, ...p }, test: null })),

  resetJob: () => set({ job: idleJob, points: [], live: null }),

  pushFrames: (events) =>
    set((s) => {
      if (!events.length) return {}
      const added: DataPoint[] = events.map((e) => ({
        frame_index: e.frame_index,
        timestamp: e.timestamp,
        ocr_value: e.value,
        ocr_text: e.text,
        value: e.value,
        confidence: e.confidence,
        flags: e.flags,
        edited: false,
      }))
      // Keep the most recent event that carries a preview image for the live feed.
      let live = s.live
      for (const e of events) if (e.preview) live = e
      const last = events[events.length - 1]
      if (live && live !== last && !last.preview) live = { ...last, preview: live.preview, boxes: live.boxes }
      return {
        points: s.points.concat(added),
        live,
        job: {
          ...s.job,
          processed: s.job.processed + events.length,
          recognised: s.job.recognised + events.filter((e) => e.value != null).length,
        },
      }
    }),

  editPoint: (frame, value) =>
    set((s) => ({
      points: s.points.map((p) =>
        p.frame_index === frame ? { ...p, value, edited: value !== p.ocr_value } : p,
      ),
    })),

  revertPoint: (frame) =>
    set((s) => ({
      points: s.points.map((p) => (p.frame_index === frame ? { ...p, value: p.ocr_value, edited: false } : p)),
    })),
}))

const PREFERRED_ENGINES: EngineName[] = [...AI_ENGINES, 'easyocr']

/** AI engines can read the whole frame; EasyOCR needs a box around the display. */
export function canExtract(s: { roi: Roi | null; options: OcrOptions }): boolean {
  return s.roi != null || isAiEngine(s.options.engine)
}

/** Mirrors backend `sample_indices`: N evenly spaced frames across [start, end]. */
export function sampleIndices(frameCount: number, n: number, start: number, end: number): number[] {
  const last = Math.max(0, frameCount - 1)
  end = Math.min(end, last)
  start = Math.max(0, Math.min(start, end))
  const count = Math.max(1, Math.min(n, end - start + 1))
  if (count === 1) return [start]
  const out = new Set<number>()
  for (let i = 0; i < count; i++) out.add(Math.round(start + ((end - start) * i) / (count - 1)))
  return [...out].sort((a, b) => a - b)
}

/** Mirrors backend ROI.lerp / the extraction pipeline's roi tracker: blends
 * `roi` (at sampling.start) toward `roiEnd` (at sampling.end) for `frame`. */
export function roiAtFrame(frame: number, roi: Roi, roiEnd: Roi | null, sampling: Sampling): Roi {
  if (!roiEnd) return roi
  const span = Math.max(1, sampling.end - sampling.start)
  const t = Math.max(0, Math.min(1, (frame - sampling.start) / span))
  return {
    x: roi.x + (roiEnd.x - roi.x) * t,
    y: roi.y + (roiEnd.y - roi.y) * t,
    w: roi.w + (roiEnd.w - roi.w) * t,
    h: roi.h + (roiEnd.h - roi.h) * t,
  }
}

/** Resolve the sampling panel into N (total datapoints). */
export function effectiveSamples(s: Sampling, meta: VideoMeta | null): number {
  if (!meta) return 0
  const span = Math.max(1, s.end - s.start + 1)
  const n = s.mode === 'total' ? s.total : Math.round((span / meta.fps) * s.rate)
  return Math.max(1, Math.min(span, n))
}
