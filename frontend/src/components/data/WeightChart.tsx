import {
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
  type Plugin,
} from 'chart.js'
import { LineChart } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { Line } from 'react-chartjs-2'
import { fmtPct } from '../../lib/format'
import type { DataPoint } from '../../lib/types'
import { useStore } from '../../store'
import { Panel } from '../ui/Panel'

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Filler)

const NEON = '#A855F7'
const LOW_CONF = 0.6

/** Neon glow under the line + crosshair + playhead marker. */
const hudPlugin: Plugin<'line'> = {
  id: 'hud',
  beforeDatasetDraw(chart) {
    const { ctx } = chart
    ctx.save()
    ctx.shadowColor = 'rgba(168, 85, 247, 0.85)'
    ctx.shadowBlur = 12
  },
  afterDatasetDraw(chart) {
    chart.ctx.restore()
  },
  afterDraw(chart) {
    const { ctx, chartArea, scales } = chart
    const opts = (chart.options.plugins as { hud?: { playhead?: number } }).hud
    // Playhead
    if (opts?.playhead != null) {
      const x = scales.x.getPixelForValue(opts.playhead)
      if (x >= chartArea.left && x <= chartArea.right) {
        ctx.save()
        ctx.strokeStyle = 'rgba(192, 132, 252, 0.55)'
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(x, chartArea.top)
        ctx.lineTo(x, chartArea.bottom)
        ctx.stroke()
        ctx.restore()
      }
    }
    // Crosshair on hover
    const active = chart.tooltip?.getActiveElements()
    if (active?.length) {
      const x = active[0].element.x
      ctx.save()
      ctx.strokeStyle = 'rgba(236, 233, 245, 0.35)'
      ctx.beginPath()
      ctx.moveTo(x, chartArea.top)
      ctx.lineTo(x, chartArea.bottom)
      ctx.stroke()
      ctx.restore()
    }
  },
}

export function WeightChart() {
  const points = useStore((s) => s.points)
  const unit = useStore((s) => s.unit)
  const frame = useStore((s) => s.currentFrame)
  const fps = useStore((s) => s.meta?.fps ?? 30)
  const seekTo = useStore((s) => s.seekTo)
  const running = useStore((s) => s.job.status === 'running')
  const ref = useRef<ChartJS<'line'>>(null)

  const data = useMemo<ChartData<'line', { x: number; y: number | null; p: DataPoint }[]>>(() => {
    const rows = points.map((p) => ({ x: p.timestamp, y: p.value, p }))
    return {
      datasets: [
        {
          label: `Weight (${unit})`,
          data: rows,
          borderColor: NEON,
          borderWidth: 2,
          tension: 0.25,
          spanGaps: false,
          fill: {
            target: 'origin',
            above: 'rgba(168, 85, 247, 0.07)',
            below: 'rgba(168, 85, 247, 0.07)',
          },
          // Mark only points that need attention: manual edits and low confidence.
          pointRadius: rows.map((r) => (r.p.edited ? 4.5 : r.p.confidence < LOW_CONF ? 4 : 0)),
          pointHoverRadius: 6,
          pointStyle: rows.map((r) => (r.p.edited ? 'rectRot' : 'circle')),
          pointBackgroundColor: rows.map((r) => (r.p.edited ? '#F3E8FF' : '#FBBF24')),
          pointBorderColor: '#0A0A0C',
          pointBorderWidth: 2,
          pointHoverBackgroundColor: '#F3E8FF',
        },
      ],
    }
  }, [points, unit])

  const options = useMemo<ChartOptions<'line'>>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      animation: running ? false : { duration: 300 },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Time (s)', color: '#6B6480', font: { family: 'Inter', size: 11 } },
          grid: { color: 'rgba(168, 85, 247, 0.07)' },
          border: { color: '#2A2438' },
          ticks: { color: '#A39CB8', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 10 },
        },
        y: {
          title: { display: true, text: `Weight (${unit})`, color: '#6B6480', font: { family: 'Inter', size: 11 } },
          grid: { color: 'rgba(168, 85, 247, 0.07)' },
          border: { color: '#2A2438' },
          ticks: { color: '#A39CB8', font: { family: 'JetBrains Mono', size: 10 } },
          grace: '5%',
        },
      },
      plugins: {
        legend: { display: false },
        hud: { playhead: frame / fps },
        tooltip: {
          backgroundColor: 'rgba(15, 15, 20, 0.95)',
          borderColor: 'rgba(168, 85, 247, 0.5)',
          borderWidth: 1,
          titleColor: '#ECE9F5',
          bodyColor: '#A39CB8',
          titleFont: { family: 'JetBrains Mono', size: 12 },
          bodyFont: { family: 'JetBrains Mono', size: 11 },
          padding: 10,
          displayColors: false,
          callbacks: {
            title: (items) => {
              const p = (items[0].raw as { p: DataPoint }).p
              return p.value == null ? 'no reading' : `${p.value} ${unit}`
            },
            label: (item) => {
              const p = (item.raw as { p: DataPoint }).p
              return [
                `t = ${p.timestamp.toFixed(3)} s · frame #${p.frame_index}`,
                p.edited ? `manually corrected (OCR: ${p.ocr_value ?? '—'})` : `confidence ${fmtPct(p.confidence)}`,
              ]
            },
          },
        },
      } as ChartOptions<'line'>['plugins'],
      onClick: (_, els) => {
        if (!els.length) return
        const p = (data.datasets[0].data[els[0].index] as { p: DataPoint }).p
        seekTo(p.frame_index)
      },
      onHover: (e, els) => {
        const t = e.native?.target as HTMLElement | undefined
        if (t) t.style.cursor = els.length ? 'pointer' : 'default'
      },
    }),
    [unit, frame, fps, running, data, seekTo],
  )

  const valid = points.filter((p) => p.value != null).map((p) => p.value as number)
  const stats = valid.length
    ? {
        min: Math.min(...valid),
        max: Math.max(...valid),
        mean: valid.reduce((a, b) => a + b, 0) / valid.length,
      }
    : null

  return (
    <Panel
      title="Weight vs Time"
      icon={<LineChart size={14} />}
      delay={0.2}
      actions={
        stats && (
          <div className="hidden gap-3 font-mono text-[10px] text-ink-mute sm:flex">
            <span>min <span className="text-ink">{stats.min.toFixed(2)}</span></span>
            <span>mean <span className="text-ink">{stats.mean.toFixed(2)}</span></span>
            <span>max <span className="text-ink">{stats.max.toFixed(2)}</span></span>
          </div>
        )
      }
    >
      <div className="relative h-72">
        {points.length ? (
          <Line ref={ref} data={data} options={options} plugins={[hudPlugin]} />
        ) : (
          <div className="grid-bg flex h-full items-center justify-center rounded-lg border border-dashed border-edge text-xs text-ink-mute">
            The time series appears here as frames are processed
          </div>
        )}
      </div>
      {points.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-4 text-[11px] text-ink-mute">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-warn" /> low confidence
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rotate-45 bg-[#F3E8FF]" /> manually corrected
          </span>
          <span>Gaps are frames with no reading. Click a point to jump to its frame.</span>
        </p>
      )}
    </Panel>
  )
}
