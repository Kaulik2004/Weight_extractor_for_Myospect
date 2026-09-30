import { useCallback } from 'react'
import { api } from '../lib/api'
import type { FrameEvent } from '../lib/types'
import { canExtract, effectiveSamples, useStore } from '../store'

let controller: AbortController | null = null

/**
 * Drives one extraction job. Frame events are buffered and flushed to the
 * store once per animation frame so that thousands of rows stream in without
 * re-rendering the table for every single event.
 */
export function useExtraction() {
  const start = useCallback(async () => {
    const s = useStore.getState()
    if (!s.meta || !canExtract(s) || s.job.status === 'running') return
    controller?.abort()
    const ctrl = new AbortController()
    controller = ctrl

    const samples = effectiveSamples(s.sampling, s.meta)
    s.resetJob()
    useStore.setState({
      job: { status: 'running', total: samples, processed: 0, recognised: 0, error: null, elapsed: null, rate: null },
    })

    let buffer: FrameEvent[] = []
    let raf = 0
    const flush = () => {
      raf = 0
      if (buffer.length) {
        const batch = buffer
        buffer = []
        useStore.getState().pushFrames(batch)
      }
    }
    const t0 = performance.now()

    try {
      await api.extract(
        s.meta.id,
        {
          roi: s.roi,
          roi_end: s.roi ? s.roiEnd : null,
          samples,
          start_frame: s.sampling.start,
          end_frame: s.sampling.end,
          options: s.options,
        },
        (e) => {
          switch (e.type) {
            case 'start':
              useStore.setState((st) => ({ job: { ...st.job, total: e.total } }))
              break
            case 'frame':
              buffer.push(e)
              if (!raf) raf = requestAnimationFrame(flush)
              break
            case 'done':
              flush()
              useStore.setState((st) => ({
                job: { ...st.job, status: 'done', elapsed: e.elapsed_s, rate: e.fps_processed },
              }))
              break
            case 'cancelled':
              flush()
              useStore.setState((st) => ({ job: { ...st.job, status: 'cancelled' } }))
              break
            case 'error':
              flush()
              useStore.setState((st) => ({ job: { ...st.job, status: 'error', error: e.message } }))
              break
          }
        },
        ctrl.signal,
      )
      // Stream closed without a terminal event (e.g. server restart).
      if (useStore.getState().job.status === 'running') {
        flush()
        useStore.setState((st) => ({
          job: { ...st.job, status: 'error', error: 'Connection closed before the job finished' },
        }))
      }
    } catch (err) {
      if (raf) cancelAnimationFrame(raf)
      flush()
      const aborted = (err as Error).name === 'AbortError'
      useStore.setState((st) => ({
        job: {
          ...st.job,
          status: aborted ? 'cancelled' : 'error',
          error: aborted ? null : (err as Error).message,
          elapsed: (performance.now() - t0) / 1000,
        },
      }))
    } finally {
      if (controller === ctrl) controller = null
    }
  }, [])

  const cancel = useCallback(() => controller?.abort(), [])

  return { start, cancel }
}
