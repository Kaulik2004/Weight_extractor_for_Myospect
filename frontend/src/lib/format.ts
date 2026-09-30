import type { EngineName } from './types'

export const fmtTime = (s: number) => {
  if (!Number.isFinite(s)) return '--:--.---'
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`
}

export const fmtBytes = (b: number) => {
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024
    i++
  }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`
}

export const fmtPct = (x: number) => `${Math.round(x * 100)}%`

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const FLAG_LABELS: Record<string, string> = {
  no_digits: 'No digits found',
  out_of_range: 'Outside the plausible range',
  extra_text: 'Extra characters were ignored',
  sign_dropped: 'Minus sign ignored',
  decode_error: 'Frame could not be decoded',
  model_error: 'AI request failed (rate limit or outage)',
  model_skipped: 'The model returned no reading for this frame',
}

export const ENGINE_LABELS: Record<EngineName, string> = {
  gemini: 'Gemini',
  claude: 'Claude',
  openai: 'OpenAI',
  groq: 'Groq',
  easyocr: 'EasyOCR',
}
