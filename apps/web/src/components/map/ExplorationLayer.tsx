import { useEffect, useState } from 'react'
import { Rectangle, useMap } from 'react-leaflet'
import type { LocationCore, VisitedCell } from '@zairn/sdk'

interface ExplorationLayerProps {
  sdk: LocationCore
}

// Direct lat/lon bounds for cells (works for both real geohash data and demo)
interface CellDisplay {
  id: string
  bounds: [[number, number], [number, number]]
  visit_count: number
}

// Generate demo exploration grid — scattered clusters like real usage
function makeDemoCells(centerLat: number, centerLon: number): CellDisplay[] {
  const cellSize = 0.0014 // ~150m cells
  const cells: CellDisplay[] = []

  // Cluster centers — large offsets for km-scale spread
  const clusters: { cx: number; cy: number; radius: number; density: number }[] = [
    { cx: 0, cy: 0, radius: 5, density: 15 },       // current area — heavily explored
    { cx: -28, cy: -22, radius: 4, density: 10 },    // home (~4km south-west)
    { cx: 14, cy: 22, radius: 4, density: 6 },       // park (~3km north-east)
    { cx: -18, cy: 8, radius: 3, density: 8 },       // station (~2.5km west)
    { cx: 25, cy: -18, radius: 3, density: 4 },      // friend's area (~3km south-east)
    { cx: -8, cy: 28, radius: 3, density: 7 },       // office (~4km north)
    { cx: -35, cy: -5, radius: 3, density: 5 },      // shops (~5km west)
    { cx: 10, cy: -30, radius: 2, density: 3 },      // gym (~4km south)
  ]

  // Connect clusters with continuous cell paths (Bresenham-like line)
  function lineCells(x0: number, y0: number, x1: number, y1: number, visits: number): [number, number, number][] {
    const result: [number, number, number][] = []
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx - dy, cx = x0, cy = y0
    while (true) {
      result.push([cx, cy, visits])
      if (cx === x1 && cy === y1) break
      const e2 = 2 * err
      if (e2 > -dy) { err -= dy; cx += sx }
      if (e2 < dx) { err += dx; cy += sy }
    }
    return result
  }

  const trails: [number, number, number][] = [
    // Home → station
    ...lineCells(-28, -22, -18, 8, 4),
    // Home → current
    ...lineCells(-28, -22, 0, 0, 6),
    // Current → park
    ...lineCells(0, 0, 14, 22, 3),
    // Current → office
    ...lineCells(0, 0, -8, 28, 5),
    // Current → friend's area
    ...lineCells(0, 0, 25, -18, 2),
    // Station → shops
    ...lineCells(-18, 8, -35, -5, 2),
    // Current → gym
    ...lineCells(0, 0, 10, -30, 2),
  ]

  const added = new Set<string>()

  for (const cluster of clusters) {
    for (let dy = -cluster.radius; dy <= cluster.radius; dy++) {
      for (let dx = -cluster.radius; dx <= cluster.radius; dx++) {
        // Circular shape
        if (dx * dx + dy * dy > cluster.radius * cluster.radius) continue
        const gx = cluster.cx + dx
        const gy = cluster.cy + dy
        const key = `${gx},${gy}`
        if (added.has(key)) continue
        added.add(key)
        // More visits near cluster center
        const distFromCenter = Math.sqrt(dx * dx + dy * dy)
        const visits = Math.max(1, Math.round(cluster.density * (1 - distFromCenter / (cluster.radius + 1))))
        const lat = centerLat + gy * cellSize
        const lon = centerLon + gx * cellSize
        const half = cellSize / 2
        cells.push({
          id: `demo-${gx}-${gy}`,
          bounds: [[lat - half, lon - half], [lat + half, lon + half]],
          visit_count: visits,
        })
      }
    }
  }

  for (const [dx, dy, visits] of trails) {
    const key = `${dx},${dy}`
    if (added.has(key)) continue
    added.add(key)
    const lat = centerLat + dy * cellSize
    const lon = centerLon + dx * cellSize
    const half = cellSize / 2
    cells.push({
      id: `demo-${dx}-${dy}`,
      bounds: [[lat - half, lon - half], [lat + half, lon + half]],
      visit_count: visits,
    })
  }

  return cells
}

export default function ExplorationLayer({ sdk }: ExplorationLayerProps) {
  const [cells, setCells] = useState<CellDisplay[]>([])
  const map = useMap()

  useEffect(() => {
    let cancelled = false

    const fetchCells = async () => {
      try {
        const data = await sdk.getMyVisitedCells()
        if (!cancelled) {
          if (data.length > 10) {
            // Use real data — need to decode geohash to bounds
            const { decodeGeohash } = await import('@zairn/sdk')
            const real: CellDisplay[] = data.map(c => {
              const { lat, lon } = decodeGeohash(c.geohash)
              const dlat = 0.00068
              const dlon = 0.00086
              return {
                id: c.geohash,
                bounds: [[lat - dlat, lon - dlon], [lat + dlat, lon + dlon]] as [[number, number], [number, number]],
                visit_count: c.visit_count,
              }
            })
            setCells(real)
          } else {
            // Demo cells
            const center = map.getCenter()
            setCells(makeDemoCells(center.lat, center.lng))
          }
        }
      } catch {
        if (!cancelled) {
          const center = map.getCenter()
          setCells(makeDemoCells(center.lat, center.lng))
        }
      }
    }

    fetchCells()
    const interval = setInterval(fetchCells, 60000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [sdk, map])

  const maxVisits = Math.max(1, ...cells.map((c) => c.visit_count))

  return (
    <>
      {cells.map((cell) => {
        const baseOpacity = 0.15
        const maxOpacity = 0.5
        const opacity = baseOpacity + (cell.visit_count / maxVisits) * (maxOpacity - baseOpacity)
        return (
          <Rectangle
            key={cell.id}
            bounds={cell.bounds}
            pathOptions={{
              color: '#6442d6',
              fillColor: '#6442d6',
              fillOpacity: opacity,
              weight: 0.5,
              opacity: 0.3,
            }}
          />
        )
      })}
    </>
  )
}
