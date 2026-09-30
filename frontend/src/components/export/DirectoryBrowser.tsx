import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, Folder, HardDrive, Home, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { NeonButton } from '../ui/controls'

type Listing = Awaited<ReturnType<typeof api.fsList>>

/** Folder picker backed by the local FastAPI server: works in every browser. */
export function DirectoryBrowser({
  open,
  initial,
  onClose,
  onPick,
}: {
  open: boolean
  initial?: string
  onClose: () => void
  onPick: (path: string) => void
}) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [typed, setTyped] = useState('')

  const load = async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const l = await api.fsList(path)
      setListing(l)
      setTyped(l.path)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load(initial || undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Choose a folder"
            initial={{ scale: 0.95, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 10 }}
            className="glass flex max-h-[80vh] w-full max-w-xl flex-col"
          >
            <header className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
              <Folder size={15} className="text-neon" />
              <h3 className="font-display text-xs tracking-[0.2em] text-ink-dim uppercase">Save location</h3>
              <button onClick={onClose} aria-label="Close" className="ml-auto text-ink-mute hover:text-ink">
                <X size={16} />
              </button>
            </header>

            <div className="space-y-3 p-4">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void load(typed)
                }}
              >
                <input className="field" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Folder path" />
                <NeonButton type="submit" size="sm">Go</NeonButton>
              </form>
              <div className="flex flex-wrap gap-1.5">
                <Chip onClick={() => listing?.parent && load(listing.parent)} disabled={!listing?.parent} icon={<ArrowUp size={12} />}>
                  Up
                </Chip>
                <Chip onClick={() => load(listing?.home)} icon={<Home size={12} />}>Home</Chip>
                {listing?.roots.map((r) => (
                  <Chip key={r} onClick={() => load(r)} icon={<HardDrive size={12} />}>{r}</Chip>
                ))}
                {listing && <Chip onClick={() => load(listing.default_export)}>App exports</Chip>}
              </div>
            </div>

            <div className="min-h-40 flex-1 overflow-y-auto border-y border-white/5 px-2 py-1">
              {error && <p className="p-3 text-xs text-bad">{error}</p>}
              {loading && <p className="p-3 text-xs text-ink-mute">Loading…</p>}
              {!loading && listing?.dirs.length === 0 && <p className="p-3 text-xs text-ink-mute">No sub-folders</p>}
              {!loading &&
                listing?.dirs.map((d) => (
                  <button
                    key={d.path}
                    onDoubleClick={() => load(d.path)}
                    onClick={() => load(d.path)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-ink-dim hover:bg-neon/10 hover:text-ink"
                  >
                    <Folder size={14} className="shrink-0 text-neon/80" />
                    <span className="truncate">{d.name}</span>
                  </button>
                ))}
            </div>

            <footer className="flex items-center gap-2 p-4">
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-mute" title={listing?.path}>
                {listing?.path}
              </span>
              <NeonButton size="sm" onClick={onClose}>Cancel</NeonButton>
              <NeonButton
                size="sm"
                variant="primary"
                disabled={!listing}
                onClick={() => {
                  if (listing) onPick(listing.path)
                  onClose()
                }}
              >
                Use this folder
              </NeonButton>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Chip({ children, onClick, icon, disabled }: { children: React.ReactNode; onClick: () => void; icon?: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1 rounded-md border border-edge px-2 py-1 font-mono text-[11px] text-ink-dim hover:border-neon/60 hover:text-ink disabled:opacity-40"
    >
      {icon}
      {children}
    </button>
  )
}
