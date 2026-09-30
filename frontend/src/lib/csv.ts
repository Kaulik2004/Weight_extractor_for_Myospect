import type { DataPoint, Unit } from './types'

export interface CsvRow {
  timestamp: number
  frame_index: number
  weight_value: number | null
  confidence: number | null
  edited: boolean
}

export function toCsvRows(points: DataPoint[]): CsvRow[] {
  return [...points]
    .sort((a, b) => a.frame_index - b.frame_index)
    .map((p) => ({
      timestamp: p.timestamp,
      frame_index: p.frame_index,
      weight_value: p.value,
      confidence: p.edited ? 1 : p.confidence,
      edited: p.edited,
    }))
}

/** Same format the backend writes: timestamp, frame_index, weight_value [, unit, confidence, edited]. */
export function buildCsv(points: DataPoint[], unit: Unit, includeExtras: boolean): string {
  const header = ['timestamp', 'frame_index', 'weight_value']
  if (includeExtras) header.push('unit', 'confidence', 'edited')
  const lines = [header.join(',')]
  for (const r of toCsvRows(points)) {
    const cells: (string | number)[] = [r.timestamp.toFixed(4), r.frame_index, r.weight_value ?? '']
    if (includeExtras) cells.push(unit, r.confidence == null ? '' : r.confidence.toFixed(4), r.edited ? 1 : 0)
    lines.push(cells.join(','))
  }
  return lines.join('\n') + '\n'
}

export function defaultCsvName(videoName: string | undefined): string {
  const stem = (videoName ?? 'video').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_')
  return `${stem}_weights_${stamp}.csv`
}

export function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
