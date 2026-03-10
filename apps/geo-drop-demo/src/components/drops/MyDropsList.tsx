import { useEffect, useState } from 'react'
import { useGeoDrop } from '@/contexts/GeoDropContext'
import type { GeoDrop, DropStatus } from '@zairn/geo-drop'

const statusColors: Record<DropStatus, { bg: string; fg: string }> = {
  active: { bg: 'var(--md-primary-container)', fg: 'var(--md-on-primary-container)' },
  expired: { bg: 'var(--md-surface-variant)', fg: 'var(--md-on-surface-variant)' },
  claimed: { bg: 'var(--md-tertiary-container)', fg: 'var(--md-on-tertiary-container)' },
  deleted: { bg: 'var(--md-error-container)', fg: 'var(--md-on-error-container)' },
}

export default function MyDropsList() {
  const { sdk } = useGeoDrop()
  const [drops, setDrops] = useState<GeoDrop[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchDrops = async () => {
    setLoading(true)
    try {
      const data = await sdk.getMyDrops()
      setDrops(data)
      setError(null)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load drops')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDrops()
  }, [sdk])

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this drop?')) return
    try {
      await sdk.deleteDrop(id)
      setDrops((prev) => prev.filter((d) => d.id !== id))
    } catch (err: any) {
      setError(err?.message ?? 'Failed to delete drop')
    }
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          padding: '32px 0',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            border: '3px solid var(--md-primary)',
            borderTopColor: 'transparent',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (error) {
    return (
      <div
        style={{
          background: 'var(--md-error-container)',
          color: 'var(--md-on-error-container)',
          padding: '12px 16px',
          borderRadius: 12,
          margin: 16,
          fontSize: '0.85rem',
        }}
      >
        {error}
      </div>
    )
  }

  if (drops.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 20px',
          color: 'var(--md-on-surface-variant)',
          gap: 8,
        }}
      >
        <span style={{ fontSize: '2rem' }}>~</span>
        <p style={{ margin: 0, fontSize: '0.95rem' }}>No drops created yet</p>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 16,
      }}
    >
      {drops.map((drop) => {
        const sc = statusColors[drop.status] ?? statusColors.active
        return (
          <div
            key={drop.id}
            style={{
              background: 'var(--md-surface-container)',
              borderRadius: 16,
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3
                style={{
                  margin: 0,
                  fontSize: '1rem',
                  fontWeight: 600,
                  color: 'var(--md-on-surface)',
                }}
              >
                {drop.title}
              </h3>
              <span
                style={{
                  padding: '3px 8px',
                  borderRadius: 6,
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  background: sc.bg,
                  color: sc.fg,
                }}
              >
                {drop.status}
              </span>
            </div>

            <div
              style={{
                display: 'flex',
                gap: 12,
                fontSize: '0.8rem',
                color: 'var(--md-on-surface-variant)',
              }}
            >
              <span>{drop.content_type}</span>
              <span>Claims: {drop.claim_count}</span>
              <span>{formatDate(drop.created_at)}</span>
            </div>

            {drop.status !== 'deleted' && (
              <button
                onClick={() => handleDelete(drop.id)}
                style={{
                  alignSelf: 'flex-end',
                  padding: '6px 14px',
                  borderRadius: 10,
                  border: '1px solid var(--md-error)',
                  background: 'transparent',
                  color: 'var(--md-error)',
                  fontSize: '0.8rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Delete
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
