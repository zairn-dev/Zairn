import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, CircleMarker, useMap } from 'react-leaflet'
import L from 'leaflet'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
import { useSdk } from '@/contexts/SdkContext'
import { calculateDistance } from '@zairn/sdk'
import TrailLayer from './TrailLayer'
import ExplorationLayer from './ExplorationLayer'
import type { LocationCurrentRow } from '@zairn/sdk'

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

interface MapViewProps {
  currentLocation: { lat: number; lon: number; accuracy: number } | null
  showTrails: boolean
  showExploration: boolean
}

function InitialCenter({ lat, lon }: { lat: number; lon: number }) {
  const map = useMap()
  const initialized = useRef(false)
  useEffect(() => {
    if (!initialized.current) {
      map.setView([lat, lon], 15)
      initialized.current = true
    }
  }, [map, lat, lon])
  return null
}

// Demo friends placed around a center point (deterministic — no Math.random)
function makeDemoFriends(centerLat: number, centerLon: number): LocationCurrentRow[] {
  const demos = [
    { name: 'Alice',   offset: [0.004, 0.003],  motion: 'walking' as const,    battery: 85, speed: 1.2 },
    { name: 'Bob',     offset: [-0.003, 0.005],  motion: 'stationary' as const, battery: 42, speed: 0 },
    { name: 'Charlie', offset: [0.002, -0.004],  motion: 'cycling' as const,    battery: 67, speed: 5.5 },
    { name: 'Diana',   offset: [-0.005, -0.002], motion: 'running' as const,    battery: 31, speed: 3.1 },
    { name: 'Eve',     offset: [0.001, 0.006],   motion: 'driving' as const,    battery: 92, speed: 12 },
  ]
  return demos.map((d, i) => ({
    user_id: `demo-${d.name.toLowerCase()}-${'0'.repeat(20)}`,
    lat: centerLat + d.offset[0],
    lon: centerLon + d.offset[1],
    accuracy: 15,
    battery_level: d.battery,
    motion: d.motion,
    is_charging: i % 3 === 0,
    speed: d.speed,
    heading: i * 72,
    altitude: null,
    location_since: new Date(Date.now() - i * 600000).toISOString(),
    updated_at: new Date().toISOString(),
  } as LocationCurrentRow))
}

export default function MapView({ currentLocation, showTrails, showExploration }: MapViewProps) {
  const sdk = useSdk()
  const [friends, setFriends] = useState<LocationCurrentRow[]>([])
  const [useDemoData, setUseDemoData] = useState(false)
  const lastSentRef = useRef<{ lat: number; lon: number } | null>(null)

  // Fetch friends every 15s — fall back to demo data if none found
  useEffect(() => {
    let cancelled = false
    const fetch = async () => {
      try {
        const data = await sdk.getVisibleFriends()
        // Get current user id to filter out self
        const { data: { user } } = await sdk.supabase.auth.getUser()
        const othersOnly = user ? data.filter(f => f.user_id !== user.id) : data
        if (!cancelled) {
          if (othersOnly.length > 0) {
            setFriends(othersOnly)
            setUseDemoData(false)
          } else {
            setUseDemoData(true)
          }
        }
      } catch {
        if (!cancelled) setUseDemoData(true)
      }
    }
    fetch()
    const interval = setInterval(fetch, 15000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [sdk])

  // Subscribe to realtime location updates
  useEffect(() => {
    const channel = sdk.subscribeLocations((row) => {
      setFriends((prev) => {
        const idx = prev.findIndex((f) => f.user_id === row.user_id)
        if (idx >= 0) {
          const next = [...prev]
          next[idx] = row
          return next
        }
        return [...prev, row]
      })
    })
    return () => { channel.unsubscribe() }
  }, [sdk])

  // Send own location when it changes (debounced, >10m movement)
  const sendLocation = useCallback(async (loc: { lat: number; lon: number; accuracy: number }) => {
    const last = lastSentRef.current
    if (last) {
      const dist = calculateDistance(last.lat, last.lon, loc.lat, loc.lon)
      if (dist < 10) return
    }
    lastSentRef.current = { lat: loc.lat, lon: loc.lon }
    try {
      await sdk.sendLocationWithTrail({ lat: loc.lat, lon: loc.lon, accuracy: loc.accuracy })
    } catch { /* ignore */ }
  }, [sdk])

  useEffect(() => {
    if (currentLocation) {
      const timer = setTimeout(() => sendLocation(currentLocation), 500)
      return () => clearTimeout(timer)
    }
  }, [currentLocation, sendLocation])

  const center: [number, number] = currentLocation
    ? [currentLocation.lat, currentLocation.lon]
    : [35.6812, 139.7671] // Tokyo default

  // Merge real friends with demo data when no real friends exist
  const displayFriends = useMemo(() => {
    return useDemoData ? makeDemoFriends(center[0], center[1]) : friends
  }, [useDemoData, friends, center[0], center[1]])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {useDemoData && (
        <div
          style={{
            position: 'absolute', top: 8, left: 8, zIndex: 1000,
            background: 'var(--md-primary-container)', color: 'var(--md-on-primary-container)',
            padding: '4px 10px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 500,
            pointerEvents: 'none',
          }}
        >
          Demo mode — showing sample friends
        </div>
      )}
      <MapContainer
        center={center}
        zoom={15}
        style={{ width: '100%', height: '100%' }}
        zoomControl={false}
        keyboard={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {currentLocation && (
          <>
            <InitialCenter lat={currentLocation.lat} lon={currentLocation.lon} />
            <CircleMarker
              center={[currentLocation.lat, currentLocation.lon]}
              radius={10}
              pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.6, weight: 2 }}
            >
              <Popup>You</Popup>
            </CircleMarker>
          </>
        )}

        {displayFriends.map((f) => {
        const demoName = f.user_id.startsWith('demo-') ? f.user_id.split('-')[1] : null
        const label = demoName
          ? demoName.charAt(0).toUpperCase() + demoName.slice(1)
          : f.user_id.slice(0, 8) + '...'
        const dist = currentLocation
          ? calculateDistance(currentLocation.lat, currentLocation.lon, f.lat, f.lon)
          : null
        return (
          <Marker key={f.user_id} position={[f.lat, f.lon]}>
            <Popup>
              <div style={{ fontSize: '0.85rem', lineHeight: 1.5 }}>
                <strong>{label}</strong>
                <br />
                Motion: {f.motion}
                <br />
                Battery: {f.battery_level != null ? `${f.battery_level}%` : 'N/A'}
                {dist != null && (
                  <>
                    <br />
                    Distance: {dist < 1000 ? `${Math.round(dist)}m` : `${(dist / 1000).toFixed(1)}km`}
                  </>
                )}
              </div>
            </Popup>
          </Marker>
        )
      })}

        {showTrails && <TrailLayer sdk={sdk} />}
        {showExploration && <ExplorationLayer sdk={sdk} />}
      </MapContainer>
    </div>
  )
}
