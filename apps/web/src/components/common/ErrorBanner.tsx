interface ErrorBannerProps {
  message: string
  onDismiss?: () => void
}

/**
 * Non-destructive error banner for action failures (e.g. a failed submit)
 * where the surrounding content should stay visible. For a failed initial
 * load that replaces the whole panel, use PanelState kind="error" instead.
 */
export default function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-2 rounded-lg px-3 py-2 text-xs"
      style={{ background: 'var(--md-error-container)', color: 'var(--md-on-error-container)' }}
    >
      <span>{message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 leading-none"
          style={{ color: 'var(--md-on-error-container)' }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
