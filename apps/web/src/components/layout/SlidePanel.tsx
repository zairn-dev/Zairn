import { useState, useEffect, type ReactNode } from 'react'

interface SlidePanelProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}

export default function SlidePanel({ open, onClose, title, children }: SlidePanelProps) {
  // Keep children mounted during the close animation, then unmount
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
    } else {
      // Wait for the slide-out animation (300ms) before unmounting
      const timer = setTimeout(() => setMounted(false), 300)
      return () => clearTimeout(timer)
    }
  }, [open])

  if (!mounted && !open) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 transition-opacity duration-300"
        style={{
          background: 'var(--md-scrim)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
        onClick={onClose}
      />

      {/* Panel — bottom-14 to sit above the nav bar */}
      <div
        className="fixed top-0 right-0 z-50 w-[90vw] max-w-[420px] flex flex-col transition-transform duration-300 ease-out"
        style={{
          bottom: '3.5rem',
          background: 'var(--md-surface)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{ borderBottom: `1px solid var(--md-outline-variant)` }}
        >
          <h2
            className="text-lg font-semibold m-0"
            style={{ color: 'var(--md-on-surface)' }}
          >
            {title}
          </h2>
          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center rounded-full text-lg cursor-pointer border-none"
            style={{
              background: 'var(--md-surface-container-high)',
              color: 'var(--md-on-surface)',
            }}
          >
            ✕
          </button>
        </div>

        {/* Content — only render children when mounted */}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </>
  )
}
