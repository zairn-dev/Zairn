import { useEffect, useRef, useState } from 'react'
import { Polyline, useMap } from 'react-leaflet'
import type { LocationCore, LocationHistoryRow } from '@zairn/sdk'

interface TrailLayerProps {
  sdk: LocationCore
  onDemoChange?: (isDemo: boolean) => void
  /** Fixed center for demo trails (GPS position, not map center) */
  centerLat?: number
  centerLon?: number
}

interface TrailSegment {
  positions: [number, number][]
  opacity: number
  weight: number
  color: string
}

const SELF_COLOR = '#6442d6'
const FRIEND_COLORS = ['#e6553a', '#22c55e', '#f59e0b', '#ec4899', '#14b8a6', '#8b5cf6']

function getTimeStyle(recordedAt: string): { opacity: number; weight: number } {
  const age = Date.now() - new Date(recordedAt).getTime()
  const hours = age / 3600000
  if (hours < 1) return { opacity: 0.8, weight: 4 }
  if (hours < 4) return { opacity: 0.5, weight: 3 }
  if (hours < 12) return { opacity: 0.3, weight: 2 }
  return { opacity: 0.15, weight: 2 }
}

// Max gap between two consecutive points before splitting into separate segments
const GAP_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes

function buildSegments(history: LocationHistoryRow[], color: string): TrailSegment[] {
  if (history.length < 2) return []
  // SDK returns DESC (newest first) — reverse to chronological order
  const sorted = [...history].reverse()
  const segments: TrailSegment[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    // Skip segment if time gap is too large (avoids long straight lines across idle periods)
    const gap = new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
    if (gap > GAP_THRESHOLD_MS) continue
    const style = getTimeStyle(a.recorded_at)
    segments.push({
      positions: [[a.lat, a.lon], [b.lat, b.lon]],
      ...style,
      color,
    })
  }
  return segments
}

// =====================
// Demo trails (fallback when no real data)
// =====================
function makeDemoTrail(
  cLat: number,
  cLon: number,
  color: string,
  route: [number, number][],
  totalMinutes: number,
): TrailSegment[] {
  const now = Date.now()
  const segments: TrailSegment[] = []
  for (let i = 0; i < route.length - 1; i++) {
    const minutesAgo = totalMinutes * (1 - i / (route.length - 1))
    const time = new Date(now - minutesAgo * 60000).toISOString()
    const style = getTimeStyle(time)
    segments.push({
      positions: [
        [cLat + route[i][0], cLon + route[i][1]],
        [cLat + route[i + 1][0], cLon + route[i + 1][1]],
      ],
      ...style,
      color,
    })
  }
  return segments
}

function buildDemoSegments(lat: number, lon: number): TrailSegment[] {
  const all: TrailSegment[] = []
  // Self: commute from south-west
  all.push(...makeDemoTrail(lat, lon, SELF_COLOR, [
    [-0.060, -0.080], [-0.055, -0.072], [-0.048, -0.063], [-0.042, -0.055],
    [-0.035, -0.048], [-0.030, -0.040], [-0.025, -0.032], [-0.020, -0.025],
    [-0.015, -0.018], [-0.010, -0.012], [-0.006, -0.007], [-0.003, -0.003],
    [-0.001, -0.001], [0.000, 0.000],
  ], 90))
  // Alice: jog loop north-east
  all.push(...makeDemoTrail(lat, lon, FRIEND_COLORS[0], [
    [0.004, 0.003], [0.010, 0.010], [0.018, 0.020], [0.028, 0.030],
    [0.038, 0.035], [0.045, 0.028], [0.050, 0.015], [0.048, 0.000],
    [0.040, -0.010], [0.030, -0.015], [0.020, -0.010], [0.012, -0.003],
    [0.004, 0.003],
  ], 60))
  // Bob: cycling from far east
  all.push(...makeDemoTrail(lat, lon, FRIEND_COLORS[1], [
    [-0.050, 0.120], [-0.045, 0.105], [-0.038, 0.090], [-0.032, 0.075],
    [-0.025, 0.060], [-0.018, 0.045], [-0.012, 0.032], [-0.008, 0.020],
    [-0.005, 0.012], [-0.003, 0.005],
  ], 40))
  // Charlie: walk west and back
  all.push(...makeDemoTrail(lat, lon, FRIEND_COLORS[2], [
    [0.000, -0.005], [-0.005, -0.015], [-0.010, -0.028], [-0.018, -0.042],
    [-0.025, -0.055], [-0.022, -0.060], [-0.015, -0.052], [-0.010, -0.040],
    [-0.005, -0.025], [-0.003, -0.010], [-0.005, -0.002],
  ], 70))
  return all
}

// =====================
// Real data fetching
// =====================
async function fetchRealTrails(sdk: LocationCore): Promise<TrailSegment[] | null> {
  const since = new Date(Date.now() - 24 * 3600000)
  const { data: { user } } = await sdk.supabase.auth.getUser()
  if (!user) return null

  // Fetch own history
  const myHistory = await sdk.getLocationHistory(user.id, { limit: 500, since })
  if (myHistory.length < 2) return null // no meaningful trail data → fallback to demo

  const allSegments: TrailSegment[] = []
  allSegments.push(...buildSegments(myHistory, SELF_COLOR))

  // Fetch trail-visible friends (individual failures don't discard own trail)
  const friendIds = await sdk.getTrailFriendIds()
  if (friendIds.length > 0) {
    const results = await Promise.allSettled(
      friendIds.slice(0, 10).map((id, idx) =>
        sdk.getLocationHistory(id, { limit: 500, since }).then(h => ({
          history: h,
          color: FRIEND_COLORS[idx % FRIEND_COLORS.length],
        }))
      )
    )
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allSegments.push(...buildSegments(result.value.history, result.value.color))
      }
    }
  }

  return allSegments
}

export default function TrailLayer({ sdk, onDemoChange, centerLat, centerLon }: TrailLayerProps) {
  const [segments, setSegments] = useState<TrailSegment[]>([])
  const map = useMap()
  const onDemoChangeRef = useRef(onDemoChange)
  onDemoChangeRef.current = onDemoChange

  // Use provided GPS center for demo trails; only fall back to map center if not given
  const demoCenterRef = useRef({ lat: centerLat ?? map.getCenter().lat, lon: centerLon ?? map.getCenter().lng })
  if (centerLat != null && centerLon != null) {
    demoCenterRef.current = { lat: centerLat, lon: centerLon }
  }

  useEffect(() => {
    let cancelled = false

    const fetchTrails = async () => {
      if (cancelled) return
      try {
        const realSegments = await fetchRealTrails(sdk)
        if (cancelled) return

        if (realSegments && realSegments.length > 0) {
          setSegments(realSegments)
          onDemoChangeRef.current?.(false)
        } else {
          const { lat, lon } = demoCenterRef.current
          setSegments(buildDemoSegments(lat, lon))
          onDemoChangeRef.current?.(true)
        }
      } catch {
        if (cancelled) return
        const { lat, lon } = demoCenterRef.current
        setSegments(buildDemoSegments(lat, lon))
        onDemoChangeRef.current?.(true)
      }
    }

    fetchTrails()
    const interval = setInterval(fetchTrails, 60000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [sdk, map])

  return (
    <>
      {segments.map((seg, i) => (
        <Polyline
          key={i}
          positions={seg.positions}
          pathOptions={{ color: seg.color, opacity: seg.opacity, weight: seg.weight }}
        />
      ))}
    </>
  )
}
