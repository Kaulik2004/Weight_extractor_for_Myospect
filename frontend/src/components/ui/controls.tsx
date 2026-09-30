import { motion } from 'framer-motion'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart'> {
  variant?: Variant
  icon?: ReactNode
  size?: 'sm' | 'md'
}

const variants: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-neon to-neon-deep text-white shadow-neon hover:shadow-neon-lg border border-neon-soft/40',
  ghost: 'bg-white/[0.03] text-ink-dim border border-edge hover:border-neon/60 hover:text-ink hover:bg-neon/10',
  danger: 'bg-bad/10 text-bad border border-bad/40 hover:bg-bad/20',
}

export function NeonButton({ variant = 'ghost', icon, size = 'md', children, className = '', disabled, ...rest }: ButtonProps) {
  return (
    <motion.button
      whileHover={disabled ? undefined : { y: -1 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-[box-shadow,background-color,border-color,color] disabled:cursor-not-allowed disabled:opacity-40 ${
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-sm'
      } ${variants[variant]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </motion.button>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="hud-label flex items-center justify-between gap-2">
        {label}
        {hint && <span className="font-mono text-[10px] tracking-normal normal-case text-ink-mute">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  ariaLabel,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  ariaLabel: string
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      type="range"
      className="slider"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ ['--fill' as string]: `${fill}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="relative flex rounded-lg border border-edge bg-void/70 p-0.5">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`relative z-10 flex-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              active ? 'text-white' : 'text-ink-mute hover:text-ink-dim'
            }`}
          >
            {active && (
              <motion.span
                layoutId={`seg-${ariaLabel}`}
                className="absolute inset-0 -z-10 rounded-md bg-neon/25 shadow-[inset_0_0_0_1px_rgb(168_85_247/0.6)]"
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
              />
            )}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 text-xs text-ink-dim hover:text-ink"
    >
      <span
        className={`relative h-4 w-7 rounded-full border transition-colors ${
          checked ? 'border-neon bg-neon/40 shadow-neon' : 'border-edge bg-void'
        }`}
      >
        <motion.span
          className="absolute top-0.5 h-2.5 w-2.5 rounded-full bg-ink"
          animate={{ left: checked ? 14 : 2 }}
          transition={{ type: 'spring', stiffness: 600, damping: 35 }}
        />
      </span>
      {label}
    </button>
  )
}

export function Stat({ label, value, accent = false }: { label: string; value: ReactNode; accent?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border border-white/5 bg-void/50 px-3 py-2">
      <div className="hud-label truncate">{label}</div>
      <div className={`mt-0.5 truncate font-mono text-sm ${accent ? 'text-neon-soft text-glow' : 'text-ink'}`}>{value}</div>
    </div>
  )
}
