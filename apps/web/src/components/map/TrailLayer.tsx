import { useEffect, useState } from 'react'
import { Polyline, useMap } from 'react-leaflet'
import type { LocationCore, LocationHistoryRow } from '@zairn/sdk'

interface TrailLayerProps {
  sdk: LocationCore
}

interface TrailSegment {
  positions: [number, number][]
  opacity: number
  weight: number
  color: string
}

const FRIEND_COLORS = ['#e6553a', '#22c55e', '#f59e0b', '#ec4899', '#14b8a6', '#8b5cf6']

function getTimeStyle(recordedAt: string): { opacity: number; weight: number } {
  const age = Date.now() - new Date(recordedAt).getTime()
  const hours = age / 3600000
  if (hours < 1) return { opacity: 0.8, weight: 4 }
  if (hours < 4) return { opacity: 0.5, weight: 3 }
  if (hours < 12) return { opacity: 0.3, weight: 2 }
  return { opacity: 0.15, weight: 2 }
}

function buildSegments(history: LocationHistoryRow[], color: string): TrailSegment[] {
  if (history.length < 2) return []
  const segments: TrailSegment[] = []
  for (let i = 0; i < history.length - 1; i++) {
    const a = history[i]
    const b = history[i + 1]
    const style = getTimeStyle(a.recorded_at)
    segments.push({
      positions: [[a.lat, a.lon], [b.lat, b.lon]],
      ...style,
      color,
    })
  }
  return segments
}

// Generate demo trail as a single continuous polyline with time-based styling
function makeDemoTrail(
  cLat: number,
  cLon: number,
  color: string,
  // Each point is [deltaLat, deltaLon] from map center
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

export default function TrailLayer({ sdk }: TrailLayerProps) {
  const [segments, setSegments] = useState<TrailSegment[]>([])
  const map = useMap()

  useEffect(() => {
    let cancelled = false

    const fetchTrails = async () => {
      try {
        if (cancelled) return
        const c = map.getCenter()
        const lat = c.lat
        const lon = c.lng
        const allSegments: TrailSegment[] = []

        // Always show demo trails for testing
        // Self: 10km commute from south-west to center
        allSegments.push(...makeDemoTrail(lat, lon, '#6442d6', [
          [-0.060, -0.080],
          [-0.055, -0.072],
          [-0.048, -0.063],
          [-0.042, -0.055],
          [-0.035, -0.048],
          [-0.030, -0.040],
          [-0.025, -0.032],
          [-0.020, -0.025],
          [-0.015, -0.018],
          [-0.010, -0.012],
          [-0.006, -0.007],
          [-0.003, -0.003],
          [-0.001, -0.001],
          [0.000, 0.000],
        ], 90))

        // Alice: 8km jog loop north-east
        allSegments.push(...makeDemoTrail(lat, lon, FRIEND_COLORS[0], [
          [0.004, 0.003],
          [0.010, 0.010],
          [0.018, 0.020],
          [0.028, 0.030],
          [0.038, 0.035],
          [0.045, 0.028],
          [0.050, 0.015],
          [0.048, 0.000],
          [0.040, -0.010],
          [0.030, -0.015],
          [0.020, -0.010],
          [0.012, -0.003],
          [0.004, 0.003],
        ], 60))

        // Bob: 15km cycling from far east
        allSegments.push(...makeDemoTrail(lat, lon, FRIEND_COLORS[1], [
          [-0.050, 0.120],
          [-0.045, 0.105],
          [-0.038, 0.090],
          [-0.032, 0.075],
          [-0.025, 0.060],
          [-0.018, 0.045],
          [-0.012, 0.032],
          [-0.008, 0.020],
          [-0.005, 0.012],
          [-0.003, 0.005],
        ], 40))

        // Charlie: 6km walk west to shops and back
        allSegments.push(...makeDemoTrail(lat, lon, FRIEND_COLORS[2], [
          [0.000, -0.005],
          [-0.005, -0.015],
          [-0.010, -0.028],
          [-0.018, -0.042],
          [-0.025, -0.055],
          [-0.022, -0.060],
          [-0.015, -0.052],
          [-0.010, -0.040],
          [-0.005, -0.025],
          [-0.003, -0.010],
          [-0.005, -0.002],
        ], 70))

        if (!cancelled) setSegments(allSegments)
      } catch { /* ignore */ }
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
