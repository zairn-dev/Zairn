import { useEffect, useState } from 'react'
import { useGeoDrop } from '@/contexts/GeoDropContext'
import type { DropClaim, GeoDrop } from '@zen-map/geo-drop'

interface ClaimWithDrop extends DropClaim {
  dropTitle?: string
}

export default function MyClaimsList() {
  const { sdk } = useGeoDrop()
  const [claims, setClaims] = useState<ClaimWithDrop[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const fetchClaims = async () => {
      try {
        const data = await sdk.getMyClaims()
        // Fetch drop titles in parallel
        const enriched: ClaimWithDrop[] = await Promise.all(
          data.map(async (claim) => {
            let dropTitle: string | undefined
            try {
              const drop = await sdk.getDrop(claim.drop_id)
              dropTitle = drop?.title
            } catch {
              // Ignore title fetch errors
            }
            return { ...claim, dropTitle }
          }),
        )
        if (!cancelled) {
          setClaims(enriched)
          setError(null)
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load claims')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchClaims()
    return () => { cancelled = true }
  }, [sdk])

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

  if (claims.length === 0) {
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
        <p style={{ margin: 0, fontSize: '0.95rem' }}>No claims yet</p>
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
      {claims.map((claim) => (
        <div
          key={claim.id}
          style={{
            background: 'var(--md-surface-container)',
            borderRadius: 16,
            padding: '14px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: '1rem',
              fontWeight: 600,
              color: 'var(--md-on-surface)',
            }}
          >
            {claim.dropTitle ?? 'Unknown Drop'}
          </h3>

          <div
            style={{
              display: 'flex',
              gap: 12,
              fontSize: '0.8rem',
              color: 'var(--md-on-surface-variant)',
            }}
          >
            <span>{claim.distance_meters}m away</span>
            <span>{formatDate(claim.claimed_at)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
