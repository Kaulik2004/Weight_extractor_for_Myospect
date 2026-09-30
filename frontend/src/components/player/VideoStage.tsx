import { ChevronsLeft, ChevronsRight, Move, Pause, Play, ScanLine, SkipBack, SkipForward, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { fmtTime } from '../../lib/format'
import { useStore } from '../../store'
import { Segmented } from '../ui/controls'
import { Panel } from '../ui/Panel'
import { VideoDropzone } from '../upload/VideoDropzone'
import { FrameScrubber } from './FrameScrubber'
import { RoiSelector } from './RoiSelector'

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, m: { mediaTime: number }) => void) => number
  cancelVideoFrameCallback?: (id: number) => void
}

/**
 * Video preview. Uses the browser's native player when it can decode the
 * file; otherwise (e.g. AVI/MJPEG) falls back to frames decoded by the backend.
 */
export function VideoStage() {
  const meta = useStore((s) => s.meta)!
  const objectUrl = useStore((s) => s.objectUrl)
  const mode = useStore((s) => s.playerMode)
  const frame = useStore((s) => s.currentFrame)
  const seek = useStore((s) => s.seek)
  const roi = useStore((s) => s.roi)
  const roiEnd = useStore((s) => s.roiEnd)
  const roiTarget = useStore((s) => s.roiTarget)
  const sampling = useStore((s) => s.sampling)
  const test = useStore((s) => s.test)
  const live = useStore((s) => s.live)
  const running = useStore((s) => s.job.status === 'running')
  const set = useStore((s) => s.set)
  const seekTo = useStore((s) => s.seekTo)
  const setRoi = useStore((s) => s.setRoi)
  const setRoiEnd = useStore((s) => s.setRoiEnd)
  const setRoiTarget = useStore((s) => s.setRoiTarget)
  const video = useRef<VideoWithRvfc>(null)
  const [playing, setPlaying] = useState(false)
  const last = meta.frame_count - 1

  // Native mode: follow the decoder frame-accurately where supported.
  useEffect(() => {
    const v = video.current
    if (mode !== 'native' || !v) return
    let id = 0
    let raf = 0
    const report = (t: number) => {
      const f = Math.min(last, Math.floor(t * meta.fps + 1e-3))
      if (f !== useStore.getState().currentFrame) useStore.setState({ currentFrame: f })
    }
    if (v.requestVideoFrameCallback) {
      const cb = (_: number, m: { mediaTime: number }) => {
        report(m.mediaTime)
        id = v.requestVideoFrameCallback!(cb)
      }
      id = v.requestVideoFrameCallback(cb)
      return () => v.cancelVideoFrameCallback?.(id)
    }
    const loop = () => {
      report(v.currentTime)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [mode, meta.fps, last])

  // Apply explicit seeks (scrubber, table row clicks, chart clicks).
  useEffect(() => {
    const v = video.current
    if (mode === 'native' && v && seek.nonce > 0) {
      // Aim for the middle of the frame so rounding never lands on its neighbour.
      v.currentTime = (seek.frame + 0.5) / meta.fps
    }
  }, [seek, mode, meta.fps])

  // Frames mode playback: step through server-rendered frames.
  useEffect(() => {
    if (mode !== 'frames' || !playing) return
    const stepFrames = Math.max(1, Math.round(meta.fps / 8))
    const t = setInterval(() => {
      const f = useStore.getState().currentFrame + stepFrames
      if (f >= last) setPlaying(false)
      seekTo(Math.min(f, last))
    }, 1000 / 8)
    return () => clearInterval(t)
  }, [mode, playing, meta.fps, last, seekTo])

  const togglePlay = () => {
    const v = video.current
    if (mode === 'native' && v) {
      if (v.paused) void v.play()
      else v.pause()
    } else setPlaying((p) => !p)
  }

  const step = (n: number) => {
    video.current?.pause()
    setPlaying(false)
    seekTo(frame + n)
  }

  // Keyboard shortcuts (ignored while typing in inputs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [role="slider"], [contenteditable]')) return
      if (e.key === ' ') togglePlay()
      else if (e.key === 'ArrowRight') step(e.shiftKey ? 10 : 1)
      else if (e.key === 'ArrowLeft') step(e.shiftKey ? -10 : -1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Boxes to overlay: the single-frame test result, or the live job frame if it is the one on screen.
  const boxes = useMemo(() => {
    if (test && test.frame_index === frame) return test.boxes
    if (live && live.frame_index === frame) return live.boxes
    return null
  }, [test, live, frame])

  return (
    <Panel
      title="Video Stage"
      icon={<ScanLine size={14} />}
      actions={
        <>
          <button
            onClick={() => {
              video.current?.pause()
              setPlaying(false)
              set({ playerMode: mode === 'native' ? 'frames' : 'native' })
            }}
            title="Server frames show exactly what OpenCV decodes; use them if the browser cannot play this file."
            className={`rounded-md border px-2 py-1 text-xs ${
              mode === 'frames' ? 'border-warn/50 bg-warn/10 text-warn' : 'border-edge text-ink-dim hover:border-neon/60 hover:text-ink'
            }`}
          >
            {mode === 'frames' ? 'Server frames' : 'Browser player'}
          </button>
          {(roiTarget === 'end' ? roiEnd : roi) && (
            <button
              onClick={() => (roiTarget === 'end' ? setRoiEnd(null) : setRoi(null))}
              className="flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-xs text-ink-dim hover:border-bad/60 hover:text-bad"
            >
              <Trash2 size={12} /> Clear {roiTarget === 'end' ? 'end box' : 'ROI'}
            </button>
          )}
          <VideoDropzone compact />
        </>
      }
    >
      <div className="space-y-3">
        <div className="scanlines relative mx-auto flex max-h-[62vh] items-center justify-center overflow-hidden rounded-lg border border-edge bg-black">
          <div className="relative max-h-[62vh] w-full" style={{ aspectRatio: `${meta.width} / ${meta.height}`, maxWidth: `calc(62vh * ${meta.width / meta.height})` }}>
            {mode === 'native' && objectUrl ? (
              <video
                ref={video}
                src={objectUrl}
                className="absolute inset-0 h-full w-full"
                muted
                playsInline
                preload="auto"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => set({ playerMode: 'frames' })}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget
                  if (v.videoWidth === 0) set({ playerMode: 'frames' })
                  else v.currentTime = (useStore.getState().currentFrame + 0.5) / meta.fps
                }}
              />
            ) : (
              <img
                src={api.frameUrl(meta.id, frame, 1600)}
                alt={`Frame ${frame}`}
                className="absolute inset-0 h-full w-full"
                draggable={false}
              />
            )}
            <RoiSelector boxes={running ? null : boxes} />
          </div>
        </div>

        {roi && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-void/40 px-3 py-2">
            <Move size={13} className="text-ink-mute" />
            <span className="hud-label">Editing</span>
            <div className="w-64">
              <Segmented
                ariaLabel="ROI editing target"
                value={roiTarget}
                onChange={(t) => {
                  setRoiTarget(t)
                  seekTo(t === 'end' ? sampling.end : sampling.start)
                }}
                options={[
                  { value: 'start', label: `Start box (#${sampling.start})` },
                  { value: 'end', label: `End box (#${sampling.end})` },
                ]}
              />
            </div>
            <p className="text-[11px] text-ink-mute">
              {roiEnd
                ? 'The box will blend between these two across the sampling range — use this if the camera zooms or pans.'
                : "Optional: draw a second box at the end frame if the camera zooms or pans, and the box will track between them."}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <IconBtn label="Back 10 frames" onClick={() => step(-10)}><ChevronsLeft size={15} /></IconBtn>
            <IconBtn label="Previous frame" onClick={() => step(-1)}><SkipBack size={14} /></IconBtn>
            <button
              onClick={togglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-neon/60 bg-neon/15 text-neon-soft shadow-neon transition hover:bg-neon/30"
            >
              {playing ? <Pause size={15} /> : <Play size={15} className="translate-x-px" />}
            </button>
            <IconBtn label="Next frame" onClick={() => step(1)}><SkipForward size={14} /></IconBtn>
            <IconBtn label="Forward 10 frames" onClick={() => step(10)}><ChevronsRight size={15} /></IconBtn>
          </div>
          <div className="ml-2 font-mono text-xs text-ink-dim">
            <span className="text-neon-soft text-glow">{fmtTime(frame / meta.fps)}</span>
            <span className="text-ink-mute"> / {fmtTime(meta.duration)}</span>
          </div>
          <div className="ml-auto flex items-center gap-2 font-mono text-xs text-ink-mute">
            FRAME
            <input
              type="number"
              className="field w-24 py-1 text-right"
              value={frame}
              min={0}
              max={last}
              onChange={(e) => seekTo(Number(e.target.value))}
              aria-label="Current frame"
            />
            <span>/ {last}</span>
          </div>
        </div>

        <FrameScrubber />
        <p className="text-[11px] text-ink-mute">
          Shortcuts: <kbd className="font-mono text-ink-dim">Space</kbd> play/pause ·{' '}
          <kbd className="font-mono text-ink-dim">← →</kbd> step frame · <kbd className="font-mono text-ink-dim">Shift</kbd> ×10
        </p>
      </div>
    </Panel>
  )
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-edge text-ink-dim transition hover:border-neon/60 hover:text-neon-soft"
    >
      {children}
    </button>
  )
}
