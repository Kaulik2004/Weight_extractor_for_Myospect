import { AlertTriangle, PencilLine, Table2, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FLAG_LABELS, fmtPct } from '../../lib/format'
import type { DataPoint } from '../../lib/types'
import { useStore } from '../../store'
import { Toggle } from '../ui/controls'
import { Panel } from '../ui/Panel'

const ROW_H = 36
const OVERSCAN = 8
const LOW_CONF = 0.6

type Filter = 'all' | 'attention'

const needsAttention = (p: DataPoint) => !p.edited && (p.value == null || p.confidence < LOW_CONF || p.flags.length > 0)

/**
 * Virtualised, inline-editable results table. Click a weight (or press Enter
 * on a focused row) to correct it; Enter saves and moves to the next row,
 * Escape cancels. Clicking a row seeks the video to that frame.
 */
export function DataTable() {
  const points = useStore((s) => s.points)
  const unit = useStore((s) => s.unit)
  const current = useStore((s) => s.currentFrame)
  const running = useStore((s) => s.job.status === 'running')
  const seekTo = useStore((s) => s.seekTo)
  const editPoint = useStore((s) => s.editPoint)
  const revertPoint = useStore((s) => s.revertPoint)

  const [filter, setFilter] = useState<Filter>('all')
  const [follow, setFollow] = useState(true)
  const [editing, setEditing] = useState<number | null>(null) // frame_index
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(400)

  const rows = useMemo(() => (filter === 'all' ? points : points.filter(needsAttention)), [points, filter])
  const attention = useMemo(() => points.filter(needsAttention).length, [points])
  const edited = useMemo(() => points.filter((p) => p.edited).length, [points])

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Auto-follow the newest rows while a job is streaming.
  useEffect(() => {
    if (running && follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [rows.length, running, follow])

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN)
  const visible = rows.slice(first, last)

  const beginEdit = (p: DataPoint) => {
    setEditing(p.frame_index)
    setDraft(p.value == null ? '' : String(p.value))
  }

  // Moving to another row unmounts the input; ignore the blur that may follow.
  const moving = useRef(false)

  const commit = (move: 0 | 1 | -1) => {
    if (editing == null) return
    if (move === 0 && moving.current) {
      moving.current = false
      return
    }
    const text = draft.trim().replace(',', '.')
    const value = text === '' ? null : Number(text)
    if (value !== null && !Number.isFinite(value)) return // keep editing invalid input
    editPoint(editing, value)
    const idx = rows.findIndex((r) => r.frame_index === editing)
    const next = rows[idx + move]
    if (move && next) {
      moving.current = true
      requestAnimationFrame(() => (moving.current = false))
      beginEdit(next)
      seekTo(next.frame_index)
      scrollIntoView(idx + move)
    } else setEditing(null)
  }

  const scrollIntoView = (i: number) => {
    const el = scroller.current
    if (!el) return
    const top = i * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight - ROW_H) el.scrollTop = top - el.clientHeight + 2 * ROW_H
  }

  return (
    <Panel
      title="Datapoints"
      icon={<Table2 size={14} />}
      delay={0.25}
      bodyClassName="flex flex-col gap-3"
      actions={
        <div className="flex items-center gap-2 font-mono text-[10px] text-ink-mute">
          <span>{points.length} rows</span>
          {edited > 0 && <span className="text-neon-soft">{edited} edited</span>}
          {attention > 0 && <span className="text-warn">{attention} to review</span>}
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-edge bg-void/70 p-0.5 text-xs">
          {(['all', 'attention'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-2.5 py-1 ${filter === f ? 'bg-neon/25 text-white' : 'text-ink-mute hover:text-ink-dim'}`}
            >
              {f === 'all' ? 'All' : `Needs review (${attention})`}
            </button>
          ))}
        </div>
        {running && <Toggle checked={follow} onChange={setFollow} label="Follow live" />}
        <span className="ml-auto flex items-center gap-1 text-[11px] text-ink-mute">
          <PencilLine size={11} /> click a weight to correct it
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-edge">
       <div className="min-w-[520px]">
        <div className="grid grid-cols-[1fr_1.2fr_1.6fr_1.3fr] border-b border-edge bg-abyss px-3 py-2 text-left" role="row">
          {['Frame #', 'Timestamp (s)', `Weight (${unit})`, 'Confidence'].map((h) => (
            <span key={h} className="hud-label" role="columnheader">{h}</span>
          ))}
        </div>
        <div
          ref={scroller}
          role="table"
          aria-rowcount={rows.length}
          className="relative h-[360px] overflow-y-auto"
          onScroll={(e) => {
            const el = e.currentTarget
            setScrollTop(el.scrollTop)
            if (running) setFollow(el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 2)
          }}
        >
          {rows.length === 0 && (
            <div className="flex h-full items-center justify-center text-xs text-ink-mute">
              {points.length ? 'Nothing needs review 🎯' : 'No datapoints yet'}
            </div>
          )}
          <div style={{ height: rows.length * ROW_H }} className="relative">
            {visible.map((p, i) => {
              const idx = first + i
              const isCurrent = p.frame_index === current
              const warn = needsAttention(p)
              return (
                <div
                  key={p.frame_index}
                  role="row"
                  tabIndex={0}
                  onClick={() => seekTo(p.frame_index)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && editing == null) beginEdit(p)
                  }}
                  className={`absolute inset-x-0 grid grid-cols-[1fr_1.2fr_1.6fr_1.3fr] items-center border-b border-white/[0.03] px-3 font-mono text-xs transition-colors ${
                    isCurrent ? 'bg-neon/15' : idx % 2 ? 'bg-white/[0.012]' : ''
                  } cursor-pointer hover:bg-neon/10`}
                  style={{ top: idx * ROW_H, height: ROW_H }}
                >
                  <span className={isCurrent ? 'text-neon-soft' : 'text-ink-dim'}>{p.frame_index}</span>
                  <span className="text-ink-dim">{p.timestamp.toFixed(3)}</span>
                  <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5">
                    {editing === p.frame_index ? (
                      <input
                        autoFocus
                        inputMode="decimal"
                        className="field h-7 w-28 py-0"
                        value={draft}
                        aria-label={`Weight at frame ${p.frame_index}`}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commit(0)}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commit(e.shiftKey ? -1 : 1)
                          } else if (e.key === 'Tab') {
                            e.preventDefault()
                            commit(e.shiftKey ? -1 : 1)
                          } else if (e.key === 'Escape') setEditing(null)
                          else if (e.key === 'ArrowDown') {
                            e.preventDefault()
                            commit(1)
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault()
                            commit(-1)
                          }
                        }}
                      />
                    ) : (
                      <button
                        onClick={() => {
                          seekTo(p.frame_index)
                          beginEdit(p)
                        }}
                        className={`min-w-16 rounded px-1.5 py-0.5 text-left transition hover:bg-neon/15 hover:shadow-[inset_0_0_0_1px_rgb(168_85_247/0.5)] ${
                          p.value == null ? 'text-bad' : p.edited ? 'text-neon-soft' : 'text-ink'
                        }`}
                        title={p.edited ? `OCR read ${p.ocr_value ?? 'nothing'} (“${p.ocr_text}”)` : `OCR text “${p.ocr_text}”`}
                      >
                        {p.value ?? '—'}
                      </button>
                    )}
                    {p.edited && editing !== p.frame_index && (
                      <button onClick={() => revertPoint(p.frame_index)} title="Revert to OCR value" className="text-ink-mute hover:text-neon-soft">
                        <Undo2 size={12} />
                      </button>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    {p.edited ? (
                      <span className="rounded border border-neon/40 px-1 text-[10px] text-neon-soft">manual</span>
                    ) : (
                      <>
                        <span className="h-1 w-12 overflow-hidden rounded-full bg-edge">
                          <span
                            className={`block h-full ${p.confidence >= LOW_CONF ? 'bg-neon' : p.confidence > 0 ? 'bg-warn' : 'bg-bad'}`}
                            style={{ width: `${p.confidence * 100}%` }}
                          />
                        </span>
                        <span className={p.confidence >= LOW_CONF ? 'text-ink-dim' : 'text-warn'}>{fmtPct(p.confidence)}</span>
                      </>
                    )}
                    {warn && (
                      <span title={p.flags.map((f) => FLAG_LABELS[f] ?? f).join(', ') || 'Low confidence'}>
                        <AlertTriangle size={12} className="text-warn" aria-hidden />
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
       </div>
      </div>
    </Panel>
  )
}
