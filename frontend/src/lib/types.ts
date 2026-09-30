export interface VideoMeta {
  id: string
  filename: string
  fps: number
  frame_count: number
  duration: number
  width: number
  height: number
  size_bytes: number
}

/** Region of interest, normalised to 0..1 of the frame. */
export interface Roi {
  x: number
  y: number
  w: number
  h: number
}

export type EngineName = 'gemini' | 'claude' | 'openai' | 'groq' | 'easyocr'

/** Vision-LLM engines: read colour frames in batches, and work without an ROI (whole frame). */
export const AI_ENGINES: readonly EngineName[] = ['gemini', 'claude', 'openai', 'groq']
export const isAiEngine = (e: EngineName) => AI_ENGINES.includes(e)

export interface OcrOptions {
  engine: EngineName
  polarity: 'auto' | 'dark_on_light' | 'light_on_dark'
  threshold: 'otsu' | 'adaptive' | 'none'
  upscale: number
  blur: number
  rotate: 0 | 90 | 180 | 270
  decimals: number | null
  min_value: number | null
  max_value: number | null
  allow_negative: boolean
}

export interface OcrBox {
  x: number
  y: number
  w: number
  h: number
  text: string
  conf: number
}

export interface FrameEvent {
  type: 'frame'
  seq: number
  total: number
  frame_index: number
  timestamp: number
  text: string
  value: number | null
  confidence: number
  engine: string
  flags: string[]
  boxes: OcrBox[]
  preview?: string
  elapsed_ms?: number
}

export type StreamEvent =
  | { type: 'start'; total: number; indices: number[]; fps: number }
  | FrameEvent
  | { type: 'done'; total: number; recognised: number; elapsed_s: number; fps_processed: number | null }
  | { type: 'cancelled'; processed: number }
  | { type: 'error'; message: string }

export interface TestResult extends Omit<FrameEvent, 'type' | 'seq' | 'total'> {
  preview: string
  /** The image the engine actually read (colour crop / frame for AI, binarised ROI for EasyOCR). */
  input_image: string
}

/** A table row: the OCR reading plus any manual correction. */
export interface DataPoint {
  frame_index: number
  timestamp: number
  ocr_value: number | null
  ocr_text: string
  value: number | null
  confidence: number
  flags: string[]
  edited: boolean
}

export type Unit = 'kg' | 'lbs'

export type Engines = Record<EngineName, boolean>
