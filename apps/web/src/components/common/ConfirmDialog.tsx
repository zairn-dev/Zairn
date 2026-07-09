import { useEffect, type ReactNode } from 'react'

interface ConfirmDialogProps {
  open: boolean
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as a destructive action (error color) */
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Material 3 confirmation dialog. Replaces blocking native confirm().
 * Renders nothing when `open` is false.
 */
export default function ConfirmDialog({
  open,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-describedby="confirm-dialog-message"
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'var(--md-scrim)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="rounded-lg p-4 flex flex-col gap-3"
        style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)', maxWidth: 320, width: '100%' }}
      >
        <p id="confirm-dialog-message" className="text-sm">{message}</p>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} autoFocus className="px-3 py-1.5 rounded text-sm"
            style={{ background: 'var(--md-surface-container)', color: 'var(--md-on-surface)' }}>
            {cancelLabel}
          </button>
          <button onClick={onConfirm} className="px-3 py-1.5 rounded text-sm"
            style={destructive
              ? { background: 'var(--md-error)', color: 'var(--md-on-error)' }
              : { background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
