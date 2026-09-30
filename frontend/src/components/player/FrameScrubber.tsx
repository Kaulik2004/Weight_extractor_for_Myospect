import { useEffect, useMemo, useRef, useState } from 'react'
import { clamp, fmtTime } from '../../lib/format'
import { effectiveSamples, sampleIndices, useStore } from '../../store'

const LOW_CONF = 0.6

/**
 * Timeline scrubber. Shows the sampling range, one tick per planned sample
 * frame (coloured by result once extracted) and the playhead.
 */
export function FrameScrubber() {
  const meta = useStore((s) => s.meta)!
  const frame = useStore((s) => s.currentFrame)
  const sampling = useStore((s) => s.sampling)
  const points = useStore((s) => s.points)
  const seekTo = useStore((s) => s.seekTo)
  const canvas = useRef<HTMLCanvasElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const last = Math.max(1, meta.frame_count - 1)
  const planned = useMemo(
    () => sampleIndices(meta.frame_count, effectiveSamples(sampling, meta), sampling.start, sampling.end),
    [meta, sampling],
  )

  // Ticks are painted on a canvas: thousands of DOM nodes would be too slow.
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth
      const h = c.clientHeight
      c.width = w * dpr
      c.height = h * dpr
      const ctx = c.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)
      const done = new Map(points.map((p) => [p.frame_index, p]))
      const step = Math.max(1, Math.ceil(planned.length / (w / 2)))
      for (let i = 0; i < planned.length; i += step) {
        const f = planned[i]
        const x = Math.round((f / last) * (w - 1)) + 0.5
        const p = done.get(f)
        if (!p) ctx.strokeStyle = 'rgba(163,156,184,0.35)'
        else if (p.value == null) ctx.strokeStyle = '#f87171'
        else if (!p.edited && p.confidence < LOW_CONF) ctx.strokeStyle = '#fbbf24'
        else ctx.strokeStyle = '#c084fc'
        ctx.beginPath()
        ctx.moveTo(x, p ? 3 : 7)
        ctx.lineTo(x, h - (p ? 3 : 7))
        ctx.stroke()
      }
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(c)
    return () => ro.disconnect()
  }, [planned, points, last])

  const frameAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    return Math.round(clamp((clientX - r.left) / r.width, 0, 1) * last)
  }

  const pct = (f: number) => `${(f / last) * 100}%`

  return (
    <div className="select-none space-y-1.5">
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label="Frame scrubber"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={frame}
        className="relative h-9 cursor-pointer rounded-md border border-edge bg-void/70"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
          seekTo(frameAt(e.clientX))
        }}
        onPointerMove={(e) => {
          const f = frameAt(e.clientX)
          setHover(f)
          if (dragging) seekTo(f)
        }}
        onPointerUp={() => setDragging(false)}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          const big = e.shiftKey ? 10 : 1
          if (e.key === 'ArrowRight') seekTo(frame + big)
          else if (e.key === 'ArrowLeft') seekTo(frame - big)
          else if (e.key === 'Home') seekTo(0)
          else if (e.key === 'End') seekTo(last)
          else return
          e.preventDefault()
        }}
      >
        {/* Sampling range */}
        <div
          className="absolute inset-y-0 rounded-sm bg-neon/10 shadow-[inset_0_0_0_1px_rgb(168_85_247/0.35)]"
          style={{ left: pct(sampling.start), width: `calc(${pct(sampling.end - sampling.start)} + 1px)` }}
        />
        <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
        {/* Playhead */}
        <div className="pointer-events-none absolute inset-y-[-3px] w-0.5 bg-neon-soft shadow-neon" style={{ left: pct(frame) }}>
          <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-neon-soft" />
        </div>
        {hover != null && !dragging && (
          <div
            className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded border border-edge bg-void px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-ink-dim"
            style={{ left: pct(hover) }}
          >
            #{hover} · {fmtTime(hover / meta.fps)}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between font-mono text-[10px] text-ink-mute">
        <span>0</span>
        <span className="flex items-center gap-3">
          <Legend color="bg-ink-mute/50" label="planned" />
          <Legend color="bg-neon-soft" label="read" />
          <Legend color="bg-warn" label="low conf." />
          <Legend color="bg-bad" label="failed" />
        </span>
        <span>{last}</span>
      </div>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block h-2.5 w-0.5 ${color}`} />
      {label}
    </span>
  )
}
