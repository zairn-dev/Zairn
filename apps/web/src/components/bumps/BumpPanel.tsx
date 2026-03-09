import { useState, useEffect, useCallback } from 'react'
import { useSdk } from '@/contexts/SdkContext'
import type { NearbyUser, BumpEvent, Profile } from '@zen-map/sdk'
import { formatRelativeTime, formatDistance } from '@/utils/format'

interface BumpPanelProps {
  currentLocation: { lat: number; lon: number } | null
}

export default function BumpPanel({ currentLocation }: BumpPanelProps) {
  const sdk = useSdk()
  const [radius, setRadius] = useState(500)
  const [nearby, setNearby] = useState<(NearbyUser & { name?: string })[]>([])
  const [history, setHistory] = useState<(BumpEvent & { name?: string })[]>([])
  const [searching, setSearching] = useState(false)
  const [bumping, setBumping] = useState<string | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    sdk.getBumpHistory({ limit: 20 }).then(async (events: BumpEvent[]) => {
      const enriched = await Promise.all(
        events.map(async (e) => {
          let name: string | undefined
          try {
            const p = await sdk.getProfile(e.nearby_user_id)
            name = p?.display_name || undefined
          } catch {}
          return { ...e, name }
        }),
      )
      if (!cancelled) setHistory(enriched)
    }).catch((e: any) => {
      if (!cancelled) setError(e.message)
    }).finally(() => {
      if (!cancelled) setLoadingHistory(false)
    })
    return () => { cancelled = true }
  }, [sdk])

  const search = async () => {
    if (!currentLocation) return
    setSearching(true)
    setError('')
    try {
      const result: NearbyUser[] = await sdk.findNearbyFriends(currentLocation.lat, currentLocation.lon, radius)
      const enriched = await Promise.all(
        result.map(async (u) => {
          let name: string | undefined
          try {
            const p = await sdk.getProfile(u.user_id)
            name = p?.display_name || undefined
          } catch {}
          return { ...u, name }
        }),
      )
      setNearby(enriched)
    } catch (e: any) {
      setError(e.message ?? 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  const bump = async (user: NearbyUser & { name?: string }) => {
    if (!currentLocation) return
    setBumping(user.user_id)
    setError('')
    try {
      const event = await sdk.recordBump(user.user_id, user.distance_meters, currentLocation.lat, currentLocation.lon)
      setHistory((prev) => [{ ...event, name: user.name }, ...prev])
    } catch (e: any) {
      setError(e.message ?? 'Bump failed')
    } finally {
      setBumping(null)
    }
  }

  return (
    <div className="flex flex-col h-full p-3 space-y-4 overflow-y-auto">
      {!currentLocation && (
        <p className="text-yellow-400 text-xs text-center">Location unavailable. Enable location to search.</p>
      )}

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>Radius</label>
          <span className="text-xs" style={{ color: 'var(--md-on-surface)' }}>{formatDistance(radius)}</span>
        </div>
        <input
          type="range"
          min={100}
          max={2000}
          step={100}
          value={radius}
          onChange={(e) => setRadius(Number(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>

      <button
        onClick={search}
        disabled={!currentLocation || searching}
        className="w-full py-2 rounded-lg text-sm font-medium disabled:opacity-40"
        style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}
      >
        {searching ? 'Searching...' : 'Find Nearby Friends'}
      </button>

      {error && <p className="text-xs" style={{ color: 'var(--md-error)' }}>{error}</p>}

      {nearby.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--md-on-surface-variant)' }}>Nearby</h3>
          <ul className="space-y-1">
            {nearby.map((u) => (
              <li key={u.user_id} className="flex items-center justify-between p-2 rounded-lg" style={{ background: 'var(--md-surface-container)' }}>
                <div>
                  <p className="text-sm" style={{ color: 'var(--md-on-surface)' }}>{u.name || u.user_id.slice(0, 8)}</p>
                  <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>{formatDistance(u.distance_meters)}</p>
                </div>
                <button
                  onClick={() => bump(u)}
                  disabled={bumping === u.user_id}
                  className="px-3 py-1 rounded-lg text-sm font-medium"
                  style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}
                >
                  {bumping === u.user_id ? '...' : 'Bump!'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {nearby.length === 0 && !searching && !error && currentLocation && (
        <p className="text-xs text-center" style={{ color: 'var(--md-on-surface-variant)' }}>Tap search to find nearby friends</p>
      )}

      <div>
        <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--md-on-surface-variant)' }}>Bump History</h3>
        {loadingHistory && <p className="text-xs text-center" style={{ color: 'var(--md-on-surface-variant)' }}>Loading...</p>}
        {!loadingHistory && history.length === 0 && <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>No bumps yet</p>}
        <ul className="space-y-1">
          {history.map((b) => (
            <li key={b.id} className="flex items-center justify-between p-2 rounded-lg" style={{ background: 'var(--md-surface-container)' }}>
              <div>
                <p className="text-sm" style={{ color: 'var(--md-on-surface)' }}>{b.name || b.nearby_user_id.slice(0, 8)}</p>
                <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>{formatDistance(b.distance_meters)}</p>
              </div>
              <span className="text-[10px]" style={{ color: 'var(--md-on-surface-variant)' }}>{formatRelativeTime(b.created_at)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
