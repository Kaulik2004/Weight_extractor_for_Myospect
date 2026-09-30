import { motion } from 'framer-motion'
import { useEffect } from 'react'
import { OcrSettingsPanel } from './components/controls/OcrSettingsPanel'
import { SamplingPanel } from './components/controls/SamplingPanel'
import { DataTable } from './components/data/DataTable'
import { WeightChart } from './components/data/WeightChart'
import { ExportPanel } from './components/export/ExportPanel'
import { Header } from './components/layout/Header'
import { PasswordGate } from './components/layout/PasswordGate'
import { VideoStage } from './components/player/VideoStage'
import { ProcessingPanel } from './components/processing/ProcessingPanel'
import { VideoDropzone } from './components/upload/VideoDropzone'
import { api, hasPassword, REMOTE_BACKEND, setPassword, setUnauthorizedHandler } from './lib/api'
import { useStore } from './store'

const STEPS = [
  ['01', 'Upload', 'Drop an MP4, AVI or MOV recording of the scale.'],
  ['02', 'Select ROI', 'Optional: drag a box over the display for a closer look.'],
  ['03', 'Sample', 'Choose N frames and let the AI read them.'],
  ['04', 'Review & export', 'Fix misreads inline, then save a CSV.'],
]

export default function App() {
  const meta = useStore((s) => s.meta)
  const backend = useStore((s) => s.backend)
  const auth = useStore((s) => s.auth)
  const setBackend = useStore((s) => s.setBackend)

  // Poll backend health so the status light recovers when the server restarts.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setPassword('')
      useStore.setState({ auth: 'required' })
    })
    let alive = true
    const check = async () => {
      try {
        const h = await api.health()
        if (!alive) return
        setBackend(true, h.engines)
        useStore.setState({ fsAccess: h.fs_access })
        if (!h.auth_required) useStore.setState({ auth: 'ok' })
        else if (useStore.getState().auth === 'unknown') {
          const ok = hasPassword() && (await api.checkPassword())
          if (alive) useStore.setState({ auth: ok ? 'ok' : 'required' })
        }
      } catch {
        if (alive) setBackend(false)
      }
    }
    void check()
    const t = setInterval(check, 10000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [setBackend])

  // Warn before closing the tab with unsaved results.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (useStore.getState().points.length) e.preventDefault()
    }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [])

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-[1680px] px-4 py-6 sm:px-6">
        {backend === 'offline' && (
          <div role="alert" className="mb-5 rounded-lg border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
            {REMOTE_BACKEND ? (
              <>
                Cannot reach the processing backend. If it has been idle it is asleep and takes about a minute to
                wake up; this page keeps retrying.
              </>
            ) : (
              <>
                Cannot reach the processing backend. Start it with{' '}
                <code className="font-mono">uvicorn app.main:app --port 8000</code> inside{' '}
                <code className="font-mono">backend/</code>.
              </>
            )}
          </div>
        )}

        {auth === 'required' ? (
          <PasswordGate />
        ) : !meta ? (
          <div className="flex min-h-[70vh] flex-col items-center justify-center gap-10">
            <VideoDropzone />
            <ol className="grid w-full max-w-3xl grid-cols-2 gap-3 md:grid-cols-4">
              {STEPS.map(([n, t, d], i) => (
                <motion.li
                  key={n}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + i * 0.07 }}
                  className="rounded-lg border border-white/5 bg-panel/40 p-3"
                >
                  <div className="font-display text-xs text-neon">{n}</div>
                  <div className="mt-1 text-sm font-medium text-ink">{t}</div>
                  <div className="mt-0.5 text-xs text-ink-mute">{d}</div>
                </motion.li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
            <div className="space-y-5 xl:col-span-8">
              <VideoStage />
              <WeightChart />
              <DataTable />
            </div>
            <aside className="space-y-5 xl:col-span-4">
              <ProcessingPanel />
              <SamplingPanel />
              <OcrSettingsPanel />
              <ExportPanel />
            </aside>
          </div>
        )}
      </main>
    </div>
  )
}
