import type { ReactNode } from 'react'

interface PanelStateProps {
  kind: 'loading' | 'empty' | 'error'
  message?: ReactNode
  /** Empty-state emoji icon, shown above the message in the non-compact variant */
  icon?: string
  /** Error-state only: shows a "Retry" text button */
  onRetry?: () => void
  /** Smaller variant for sub-sections within a panel (no icon, tighter spacing) */
  compact?: boolean
}

const DEFAULT_MESSAGE: Record<PanelStateProps['kind'], string> = {
  loading: 'Loading...',
  empty: 'Nothing here yet',
  error: 'Something went wrong',
}

/**
 * Unified loading / empty / error state display for panel content.
 * loading uses role="status", error uses role="alert" so both are announced
 * to assistive tech without any per-panel wiring.
 */
export default function PanelState({ kind, message, icon, onRetry, compact = false }: PanelStateProps) {
  const text = message ?? DEFAULT_MESSAGE[kind]
  const padding = compact ? 'py-2' : 'py-4'

  if (kind === 'loading') {
    return (
      <div role="status" aria-live="polite" className={`flex items-center justify-center gap-2 text-center ${padding}`}>
        <span
          aria-hidden="true"
          className="inline-block rounded-full animate-spin"
          style={{
            width: compact ? 12 : 16, height: compact ? 12 : 16,
            border: '2px solid var(--md-surface-container-high)',
            borderTopColor: 'var(--md-primary)',
          }}
        />
        <span className={compact ? 'text-xs' : 'text-sm'} style={{ color: 'var(--md-on-surface-variant)' }}>
          {text}
        </span>
      </div>
    )
  }

  if (kind === 'error') {
    return (
      <div role="alert" className={`flex flex-col items-center gap-1.5 text-center ${padding}`}>
        <span className={compact ? 'text-xs' : 'text-sm'} style={{ color: 'var(--md-error)' }}>
          {text}
        </span>
        {onRetry && (
          <button
            onClick={onRetry}
            className="text-xs font-medium hover:underline"
            style={{ color: 'var(--md-primary)' }}
          >
            Retry
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={`flex flex-col items-center gap-1 text-center ${padding}`}>
      {icon && !compact && <span className="text-3xl" aria-hidden="true">{icon}</span>}
      <span className={compact ? 'text-xs' : 'text-sm'} style={{ color: 'var(--md-on-surface-variant)' }}>
        {text}
      </span>
    </div>
  )
}
