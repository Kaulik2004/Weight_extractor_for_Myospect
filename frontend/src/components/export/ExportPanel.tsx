import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, Download, FolderOpen, HardDriveDownload, Server } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { buildCsv, defaultCsvName, downloadText, toCsvRows } from '../../lib/csv'
import {
  type FsDirHandle,
  pickDirectory,
  recallDirectory,
  rememberDirectory,
  supportsDirectoryPicker,
  writeFileToDirectory,
} from '../../lib/fsAccess'
import { useStore } from '../../store'
import { Field, NeonButton, Segmented, Toggle } from '../ui/controls'
import { Panel } from '../ui/Panel'
import { DirectoryBrowser } from './DirectoryBrowser'

type Target = 'download' | 'folder' | 'server'

const SERVER_DIR_KEY = 'wx.serverDir'

function readLocal(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export function ExportPanel() {
  const points = useStore((s) => s.points)
  const unit = useStore((s) => s.unit)
  const meta = useStore((s) => s.meta)
  const running = useStore((s) => s.job.status === 'running')
  const fsAccess = useStore((s) => s.fsAccess)

  const fsSupported = supportsDirectoryPicker()
  const [target, setTarget] = useState<Target>(fsSupported ? 'folder' : 'download')
  const [filename, setFilename] = useState(() => defaultCsvName(meta?.filename))
  const [extras, setExtras] = useState(false)
  const [dir, setDir] = useState<FsDirHandle | null>(null)
  const [serverDir, setServerDir] = useState(() => readLocal(SERVER_DIR_KEY))
  const [browse, setBrowse] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => setFilename(defaultCsvName(meta?.filename)), [meta?.filename])
  // "Path" writes to the backend's own disk: only offered when the backend runs on this machine.
  useEffect(() => {
    if (!fsAccess && target === 'server') setTarget('download')
  }, [fsAccess, target])
  useEffect(() => {
    if (fsSupported) void recallDirectory().then((d) => d && setDir(d))
  }, [fsSupported])

  const csv = useMemo(() => buildCsv(points, unit, extras), [points, unit, extras])
  const preview = csv.split('\n').slice(0, 6).join('\n')
  const empty = points.length === 0
  const name = filename.trim().toLowerCase().endsWith('.csv') ? filename.trim() : `${filename.trim() || 'weights'}.csv`

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    setStatus(null)
    try {
      setStatus({ ok: true, msg: await fn() })
    } catch (e) {
      setStatus({ ok: false, msg: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const chooseFolder = async () => {
    try {
      const d = await pickDirectory()
      if (d) {
        setDir(d)
        void rememberDirectory(d)
      }
    } catch (e) {
      setStatus({ ok: false, msg: (e as Error).message })
    }
  }

  const save = () => {
    if (target === 'download') {
      downloadText(csv, name)
      setStatus({ ok: true, msg: `Downloaded ${name}` })
    } else if (target === 'folder') {
      if (!dir) return void chooseFolder()
      void run(async () => {
        await writeFileToDirectory(dir, name, csv)
        return `Saved ${name} to “${dir.name}”`
      })
    } else {
      void run(async () => {
        const res = await api.exportCsv({ rows: toCsvRows(points), directory: serverDir, filename: name, unit, include_extras: extras })
        return `Saved ${res.rows} rows to ${res.path}`
      })
    }
  }

  return (
    <Panel title="CSV Export" icon={<HardDriveDownload size={14} />} delay={0.3}>
      <div className="space-y-4">
        <Field label="Destination">
          <Segmented<Target>
            ariaLabel="Export destination"
            value={target}
            onChange={setTarget}
            options={[
              { value: 'download', label: 'Download' },
              { value: 'folder', label: 'Local folder' },
              ...(fsAccess ? [{ value: 'server' as const, label: 'Path' }] : []),
            ]}
          />
        </Field>

        {target === 'folder' &&
          (fsSupported ? (
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate rounded-lg border border-edge bg-void/70 px-3 py-1.5 font-mono text-xs text-ink-dim">
                {dir ? `📁 ${dir.name}` : 'No folder selected'}
              </div>
              <NeonButton size="sm" icon={<FolderOpen size={13} />} onClick={chooseFolder}>
                {dir ? 'Change' : 'Choose'}
              </NeonButton>
            </div>
          ) : (
            <p className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
              This browser has no File System Access API. Use Chrome or Edge, or pick “Path” to save through the local backend.
            </p>
          ))}

        {target === 'server' && (
          <Field label="Folder on this computer" hint="written by the backend">
            <div className="flex gap-2">
              <input
                className="field"
                placeholder="e.g. C:\Users\me\Documents\trials"
                value={serverDir}
                onChange={(e) => {
                  setServerDir(e.target.value)
                  try {
                    localStorage.setItem(SERVER_DIR_KEY, e.target.value)
                  } catch {
                    /* ignore */
                  }
                }}
              />
              <NeonButton size="sm" icon={<Server size={13} />} onClick={() => setBrowse(true)}>
                Browse
              </NeonButton>
            </div>
          </Field>
        )}

        <Field label="File name">
          <input className="field" value={filename} onChange={(e) => setFilename(e.target.value)} />
        </Field>

        <Toggle checked={extras} onChange={setExtras} label="Include unit, confidence and edit flag columns" />

        <NeonButton
          variant="primary"
          className="w-full py-2.5"
          icon={target === 'download' ? <Download size={15} /> : <HardDriveDownload size={15} />}
          disabled={empty || busy || running || (target === 'server' && !serverDir.trim())}
          onClick={save}
        >
          {empty
            ? 'No data to export'
            : target === 'download'
              ? `Generate & download CSV (${points.length})`
              : target === 'folder' && !dir
                ? 'Choose folder…'
                : `Save CSV (${points.length} rows)`}
        </NeonButton>

        <AnimatePresence>
          {status && (
            <motion.p
              role="status"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs break-all ${
                status.ok ? 'border-ok/30 bg-ok/5 text-ok' : 'border-bad/40 bg-bad/10 text-bad'
              }`}
            >
              {status.ok && <CheckCircle2 size={13} className="mt-px shrink-0" />}
              {status.msg}
            </motion.p>
          )}
        </AnimatePresence>

        <div>
          <div className="hud-label mb-1.5">Preview</div>
          <pre className="max-h-36 overflow-auto rounded-lg border border-edge bg-void/80 p-3 font-mono text-[11px] leading-relaxed text-ink-dim">
            {empty ? 'timestamp,frame_index,weight_value' : preview}
            {points.length > 5 && <span className="text-ink-mute">{`\n… ${points.length - 5} more rows`}</span>}
          </pre>
        </div>
      </div>

      <DirectoryBrowser
        open={browse}
        initial={serverDir}
        onClose={() => setBrowse(false)}
        onPick={(p) => {
          setServerDir(p)
          try {
            localStorage.setItem(SERVER_DIR_KEY, p)
          } catch {
            /* ignore */
          }
        }}
      />
    </Panel>
  )
}
