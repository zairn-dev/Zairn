import { useEffect, useState } from 'react'
import { useGeoDrop } from '@/contexts/GeoDropContext'
import type { DropStats } from '@zairn/geo-drop'

export default function StatsView() {
  const { sdk } = useGeoDrop()
  const [stats, setStats] = useState<DropStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const fetchStats = async () => {
      try {
        const data = await sdk.getMyStats()
        if (!cancelled) {
          setStats(data)
          setError(null)
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load stats')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchStats()
    return () => { cancelled = true }
  }, [sdk])

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

  if (!stats) return null

  const cards = [
    { label: 'Created', value: stats.total_created },
    { label: 'Claimed', value: stats.total_claimed },
    { label: 'Active Drops', value: stats.total_active },
    { label: 'Unique Locations', value: stats.unique_locations },
  ]

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 12,
        padding: 16,
      }}
    >
      {cards.map((card) => (
        <div
          key={card.label}
          style={{
            background: 'var(--md-surface-container)',
            borderRadius: 16,
            padding: '20px 16px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: '2rem',
              fontWeight: 700,
              color: 'var(--md-primary)',
              lineHeight: 1,
            }}
          >
            {card.value}
          </span>
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 500,
              color: 'var(--md-on-surface-variant)',
              textAlign: 'center',
            }}
          >
            {card.label}
          </span>
        </div>
      ))}
    </div>
  )
}
