import type { CsvRow } from './csv'
import type { Engines, OcrOptions, Roi, StreamEvent, TestResult, Unit, VideoMeta } from './types'

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? ''
/** True when the backend is a separate hosted server (not the local dev proxy). */
export const REMOTE_BACKEND = BASE !== ''

// Shared password for a hosted backend (APP_PASSWORD). Sent as a header, or as
// `?key=` on <img> URLs, which can't carry headers.
const PASSWORD_KEY = 'wx.password'
let password = (() => {
  try {
    return localStorage.getItem(PASSWORD_KEY) ?? ''
  } catch {
    return ''
  }
})()
let onUnauthorized: () => void = () => {}

export function hasPassword(): boolean {
  return password !== ''
}

export function setPassword(p: string): void {
  password = p
  try {
    if (p) localStorage.setItem(PASSWORD_KEY, p)
    else localStorage.removeItem(PASSWORD_KEY)
  } catch {
    /* storage unavailable: keep it in memory for this tab */
  }
}

/** Called whenever the backend rejects the password (e.g. it was changed). */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn
}

function withAuth(headers?: HeadersInit): Headers {
  const h = new Headers(headers)
  if (password) h.set('X-App-Password', password)
  return h
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  if (res.status === 401) onUnauthorized()
  let msg = `${res.status} ${res.statusText}`
  try {
    const body = await res.json()
    if (typeof body.detail === 'string') msg = body.detail
    else if (Array.isArray(body.detail)) msg = body.detail.map((d: { msg: string }) => d.msg).join('; ')
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, msg)
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { ...init, headers: withAuth(init?.headers) })
  if (!res.ok) throw await errorFrom(res)
  return res.json() as Promise<T>
}

export const api = {
  health: () =>
    json<{ status: string; engines: Engines; auth_required: boolean; fs_access: boolean }>('/api/health'),

  /** True if the backend accepts `candidate` (default: the saved password). */
  async checkPassword(candidate: string = password): Promise<boolean> {
    const res = await fetch(`${BASE}/api/auth`, { headers: { 'X-App-Password': candidate } })
    if (res.status === 401) return false
    if (!res.ok) throw await errorFrom(res)
    return true
  },

  /** Upload with progress reporting (fetch has no upload progress, so XHR). */
  upload(file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<VideoMeta> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', BASE + '/api/videos')
      if (password) xhr.setRequestHeader('X-App-Password', password)
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
      xhr.onload = () => {
        let body: unknown = null
        try {
          body = JSON.parse(xhr.responseText)
        } catch {
          /* ignore */
        }
        if (xhr.status === 401) onUnauthorized()
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as VideoMeta)
        else reject(new ApiError(xhr.status, (body as { detail?: string })?.detail ?? xhr.statusText))
      }
      xhr.onerror = () =>
        reject(
          new ApiError(
            0,
            REMOTE_BACKEND
              ? 'Network error: the backend may be waking up, try again in a minute'
              : 'Network error: is the backend running on port 8000?',
          ),
        )
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'))
      signal?.addEventListener('abort', () => xhr.abort())
      const form = new FormData()
      form.append('file', file)
      xhr.send(form)
    })
  },

  frameUrl: (id: string, index: number, maxWidth = 1280) =>
    `${BASE}/api/videos/${id}/frames/${index}?max_width=${maxWidth}` +
    (password ? `&key=${encodeURIComponent(password)}` : ''),

  deleteVideo: (id: string) => fetch(`${BASE}/api/videos/${id}`, { method: 'DELETE', headers: withAuth() }),

  ocrTest: (id: string, frame_index: number, roi: Roi | null, options: OcrOptions) =>
    json<TestResult>(`/api/videos/${id}/ocr-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frame_index, roi, options }),
    }),

  /**
   * Start an extraction job and consume the NDJSON event stream.
   * Aborting `signal` closes the connection, which cancels the job server-side.
   */
  async extract(
    id: string,
    body: { roi: Roi | null; roi_end?: Roi | null; samples: number; start_frame: number; end_frame: number; options: OcrOptions },
    onEvent: (e: StreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${BASE}/api/videos/${id}/extract`, {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ ...body, include_previews: true }),
      signal,
    })
    if (!res.ok || !res.body) throw await errorFrom(res)
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line) onEvent(JSON.parse(line) as StreamEvent)
      }
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer) as StreamEvent)
  },

  fsList: (path?: string) =>
    json<{
      path: string
      parent: string | null
      dirs: { name: string; path: string }[]
      roots: string[]
      home: string
      default_export: string
    }>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),

  exportCsv: (payload: {
    rows: CsvRow[]
    directory: string
    filename: string
    unit: Unit
    include_extras: boolean
  }) =>
    json<{ path: string; rows: number; bytes: number }>('/api/export/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
}
