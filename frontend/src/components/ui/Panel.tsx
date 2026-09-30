import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

interface Props {
  title: string
  icon?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  delay?: number
}

/** Glassmorphic HUD panel with a title bar. */
export function Panel({ title, icon, actions, children, className = '', bodyClassName = '', delay = 0 }: Props) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
      className={`glass flex min-w-0 flex-col ${className}`}
    >
      <header className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5">
        {icon && <span className="text-neon">{icon}</span>}
        <h2 className="font-display text-[11px] font-medium tracking-[0.2em] text-ink-dim uppercase">{title}</h2>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </header>
      <div className={`min-h-0 flex-1 p-4 ${bodyClassName}`}>{children}</div>
    </motion.section>
  )
}
