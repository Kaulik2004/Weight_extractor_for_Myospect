import { KeyRound, LogIn } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, setPassword } from '../../lib/api'
import { useStore } from '../../store'
import { Field, NeonButton } from '../ui/controls'
import { Panel } from '../ui/Panel'

/** Shown when the hosted backend requires APP_PASSWORD and we don't have a valid one. */
export function PasswordGate() {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!value) return
    setBusy(true)
    setErr(null)
    try {
      if (await api.checkPassword(value)) {
        setPassword(value)
        useStore.setState({ auth: 'ok' })
      } else {
        setErr('Wrong password')
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <Panel title="Password required" icon={<KeyRound size={14} />} className="w-full max-w-sm">
        <form onSubmit={submit} className="space-y-4">
          <p className="text-xs leading-snug text-ink-mute">
            This server spends its owner's AI API quota, so it's password protected.
          </p>
          <Field label="Password">
            <input
              className="field"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          {err && (
            <p role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
              {err}
            </p>
          )}
          <NeonButton type="submit" variant="primary" className="w-full" icon={<LogIn size={14} />} disabled={busy || !value}>
            {busy ? 'Checking…' : 'Unlock'}
          </NeonButton>
        </form>
      </Panel>
    </div>
  )
}
