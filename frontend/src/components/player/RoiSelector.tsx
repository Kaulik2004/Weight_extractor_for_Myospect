import { AnimatePresence, motion } from 'framer-motion'
import { Crosshair } from 'lucide-react'
import { useRef, useState } from 'react'
import { clamp } from '../../lib/format'
import type { OcrBox, Roi } from '../../lib/types'
import { useStore } from '../../store'

type Drag =
  | { kind: 'new'; ox: number; oy: number }
  | { kind: 'move'; ox: number; oy: number; start: Roi }
  | { kind: 'resize'; corner: 'nw' | 'ne' | 'sw' | 'se'; start: Roi }

const MIN = 0.01

/**
 * Transparent overlay over the video. Drag on empty space to draw a region of
 * interest, drag inside it to move, drag a corner to resize. Coordinates are
 * normalised to 0..1 so they are independent of the on-screen size.
 *
 * Edits `roi` or `roiEnd` depending on `roiTarget` (see the "Editing" toggle
 * in the Video Stage panel). When both boxes exist, the one *not* being
 * edited is drawn as a dim, non-interactive reference rectangle so you can
 * see how far the display has drifted between the start and end of the range.
 */
export function RoiSelector({ boxes }: { boxes: OcrBox[] | null }) {
  const roiTarget = useStore((s) => s.roiTarget)
  const roi = useStore((s) => (roiTarget === 'end' ? s.roiEnd : s.roi))
  const otherRoi = useStore((s) => (roiTarget === 'end' ? s.roi : s.roiEnd))
  const setRoi = useStore((s) => (roiTarget === 'end' ? s.setRoiEnd : s.setRoi))
  const meta = useStore((s) => s.meta)
  const rotate = useStore((s) => s.options.rotate)
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)

  const point = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }
  }

  const onDown = (e: React.PointerEvent, d?: Drag) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    ref.current!.setPointerCapture(e.pointerId)
    const p = point(e)
    setDrag(d ?? { kind: 'new', ox: p.x, oy: p.y })
    if (!d) setRoi({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return
    const p = point(e)
    if (drag.kind === 'new') {
      setRoi({ x: Math.min(p.x, drag.ox), y: Math.min(p.y, drag.oy), w: Math.abs(p.x - drag.ox), h: Math.abs(p.y - drag.oy) })
    } else if (drag.kind === 'move') {
      const s = drag.start
      setRoi({ ...s, x: clamp(s.x + p.x - drag.ox, 0, 1 - s.w), y: clamp(s.y + p.y - drag.oy, 0, 1 - s.h) })
    } else {
      const s = drag.start
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h
      if (drag.corner.includes('w')) x0 = Math.min(p.x, x1 - MIN)
      if (drag.corner.includes('e')) x1 = Math.max(p.x, x0 + MIN)
      if (drag.corner.includes('n')) y0 = Math.min(p.y, y1 - MIN)
      if (drag.corner.includes('s')) y1 = Math.max(p.y, y0 + MIN)
      setRoi({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })
    }
  }

  const onUp = (e: React.PointerEvent) => {
    if (!drag) return
    ref.current!.releasePointerCapture(e.pointerId)
    setDrag(null)
    const r = useStore.getState().roi
    if (r && (r.w < MIN || r.h < MIN)) setRoi(null) // a click, not a drag
  }

  const px = roi && meta ? {
    w: Math.round(roi.w * meta.width),
    h: Math.round(roi.h * meta.height),
    x: Math.round(roi.x * meta.width),
    y: Math.round(roi.y * meta.height),
  } : null

  return (
    <div
      ref={ref}
      className="absolute inset-0 cursor-crosshair touch-none select-none"
      onPointerDown={(e) => onDown(e)}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      {otherRoi && otherRoi.w > 0 && otherRoi.h > 0 && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          preserveAspectRatio="none"
          viewBox="0 0 1 1"
        >
          <rect
            x={otherRoi.x} y={otherRoi.y} width={otherRoi.w} height={otherRoi.h}
            fill="none" stroke="#7E22CE" strokeWidth={0.003} strokeDasharray="0.012 0.01"
          />
          <text
            x={otherRoi.x} y={Math.max(0.02, otherRoi.y - 0.012)}
            fontSize={0.028} fill="#7E22CE" style={{ fontFamily: 'monospace' }}
          >
            {roiTarget === 'end' ? 'start box' : 'end box'}
          </text>
        </svg>
      )}

      <AnimatePresence>
        {!roi && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center"
          >
            <span className="flex items-center gap-2 rounded-full border border-neon/40 bg-void/80 px-3 py-1.5 text-xs text-ink-dim backdrop-blur">
              <Crosshair size={13} className="text-neon" />
              {roiTarget === 'end'
                ? "Drag a box around the display as it appears at this (end) frame"
                : "Drag a box around the scale's digital display"}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {roi && roi.w > 0 && roi.h > 0 && (
        <>
          {/* Dim everything outside the ROI */}
          <svg className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 1 1">
            <path
              fillRule="evenodd"
              fill="rgb(10 10 12 / 0.55)"
              d={`M0 0H1V1H0Z M${roi.x} ${roi.y}v${roi.h}h${roi.w}v${-roi.h}Z`}
            />
          </svg>

          <div
            className="absolute cursor-move"
            style={{ left: `${roi.x * 100}%`, top: `${roi.y * 100}%`, width: `${roi.w * 100}%`, height: `${roi.h * 100}%` }}
            onPointerDown={(e) => {
              const p = point(e)
              onDown(e, { kind: 'move', ox: p.x, oy: p.y, start: roi })
            }}
          >
            <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              <rect
                x="0" y="0" width="100%" height="100%"
                fill="rgb(168 85 247 / 0.06)" stroke="#A855F7" strokeWidth="1.5"
                strokeDasharray="6 4" className="marching"
                style={{ filter: 'drop-shadow(0 0 6px rgb(168 85 247 / 0.9))' }}
              />
            </svg>

            {/* OCR detection boxes, normalised to the ROI (only meaningful without rotation) */}
            {rotate === 0 &&
              boxes?.map((b, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="pointer-events-none absolute border border-neon-soft shadow-[0_0_8px_rgb(192_132_252/0.8)]"
                  style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
                >
                  <span className="absolute -top-4 left-0 font-mono text-[10px] leading-none text-neon-soft text-glow">{b.text}</span>
                </motion.div>
              ))}

            {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
              <span
                key={c}
                onPointerDown={(e) => onDown(e, { kind: 'resize', corner: c, start: roi })}
                className="absolute h-3 w-3 rounded-sm border border-neon bg-void shadow-neon"
                style={{
                  left: c.includes('w') ? -6 : undefined,
                  right: c.includes('e') ? -6 : undefined,
                  top: c.includes('n') ? -6 : undefined,
                  bottom: c.includes('s') ? -6 : undefined,
                  cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize',
                }}
              />
            ))}

            {px && (
              <span className="pointer-events-none absolute -bottom-6 left-0 whitespace-nowrap rounded bg-void/85 px-1.5 py-0.5 font-mono text-[10px] text-neon-soft">
                {roiTarget === 'end' ? 'End box' : 'ROI'} {px.w}×{px.h}px @ ({px.x}, {px.y})
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
