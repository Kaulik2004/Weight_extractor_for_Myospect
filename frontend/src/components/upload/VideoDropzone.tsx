import { AnimatePresence, motion } from 'framer-motion'
import { FileVideo, UploadCloud, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../../lib/api'
import { fmtBytes } from '../../lib/format'
import { useStore } from '../../store'

const ACCEPT = ['.mp4', '.avi', '.mov', '.mkv', '.m4v', '.webm']

export function useVideoUpload() {
  const abortRef = useRef<AbortController | null>(null)

  const uploadFile = async (file: File) => {
    const ext = '.' + (file.name.split('.').pop() ?? '').toLowerCase()
    const { set, setVideo, meta: prev } = useStore.getState()
    if (!ACCEPT.includes(ext)) {
      set({ upload: { busy: false, progress: 0, error: `Unsupported file type ${ext}. Use MP4, AVI or MOV.` } })
      return
    }
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    set({ upload: { busy: true, progress: 0, error: null } })
    try {
      const meta = await api.upload(
        file,
        (p) => useStore.setState((s) => ({ upload: { ...s.upload, progress: p } })),
        ctrl.signal,
      )
      if (prev) void api.deleteVideo(prev.id)
      setVideo(file, meta)
      set({ upload: { busy: false, progress: 1, error: null } })
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError'
      set({ upload: { busy: false, progress: 0, error: aborted ? null : (e as Error).message } })
    }
  }

  const cancel = () => abortRef.current?.abort()
  return { uploadFile, cancel }
}

export function VideoDropzone({ compact = false }: { compact?: boolean }) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const upload = useStore((s) => s.upload)
  const { uploadFile, cancel } = useVideoUpload()
  const [pending, setPending] = useState<File | null>(null)

  const take = (files: FileList | null) => {
    const f = files?.[0]
    if (!f) return
    setPending(f)
    void uploadFile(f)
  }

  if (compact) {
    return (
      <>
        <input ref={input} type="file" accept={ACCEPT.join(',')} hidden onChange={(e) => take(e.target.files)} />
        <button
          onClick={() => input.current?.click()}
          disabled={upload.busy}
          className="flex items-center gap-1.5 rounded-md border border-edge px-2 py-1 text-xs text-ink-dim hover:border-neon/60 hover:text-ink disabled:opacity-50"
        >
          <UploadCloud size={13} />
          {upload.busy ? `Uploading ${Math.round(upload.progress * 100)}%` : 'Replace video'}
        </button>
      </>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        take(e.dataTransfer.files)
      }}
      onClick={() => !upload.busy && input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      role="button"
      tabIndex={0}
      aria-label="Upload a video"
      className={`glass grid-bg relative mx-auto flex w-full max-w-3xl cursor-pointer flex-col items-center justify-center gap-5 overflow-hidden px-8 py-16 text-center transition-shadow ${
        over ? 'shadow-neon-lg' : 'hover:shadow-neon'
      }`}
    >
      <input ref={input} type="file" accept={ACCEPT.join(',')} hidden onChange={(e) => take(e.target.files)} />

      <motion.div
        animate={over ? { scale: 1.12, rotate: -4 } : { scale: 1, rotate: 0 }}
        className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-neon/50 bg-neon/10 shadow-neon"
      >
        <UploadCloud size={36} className="text-neon-soft" />
        <span className="pulse-dot absolute -right-1 -top-1 h-3 w-3 rounded-full bg-neon" />
      </motion.div>

      <div>
        <h1 className="font-display text-2xl font-bold tracking-wider text-ink text-glow sm:text-3xl">
          Drop a scale video
        </h1>
        <p className="mt-2 text-sm text-ink-dim">
          Drag and drop or click to browse. Accepts <span className="font-mono text-neon-soft">.mp4 .avi .mov</span>
        </p>
      </div>

      <AnimatePresence>
        {upload.busy && pending && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="w-full max-w-md space-y-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-left text-xs text-ink-dim">
              <FileVideo size={14} className="text-neon" />
              <span className="truncate">{pending.name}</span>
              <span className="ml-auto font-mono">{fmtBytes(pending.size)}</span>
              <button onClick={cancel} aria-label="Cancel upload" className="text-ink-mute hover:text-bad">
                <X size={14} />
              </button>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-edge">
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-neon-deep to-neon shadow-neon"
                animate={{ width: `${upload.progress * 100}%` }}
              />
            </div>
            <p className="font-mono text-[11px] text-ink-mute">
              {upload.progress < 1 ? `Uploading ${Math.round(upload.progress * 100)}%` : 'Probing video…'}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {upload.error && (
        <p role="alert" className="max-w-md rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
          {upload.error}
        </p>
      )}
    </motion.div>
  )
}
