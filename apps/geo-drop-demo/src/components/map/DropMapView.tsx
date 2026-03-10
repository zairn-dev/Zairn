import { useEffect, useState, useRef, useCallback } from 'react'
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Circle,
  Popup,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'
import { useGeoDrop } from '@/contexts/GeoDropContext'
import type { NearbyDrop } from '@zairn/geo-drop'

// Fix default Leaflet icon paths
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

interface DropMapViewProps {
  currentLocation: { lat: number; lon: number; accuracy: number } | null
  onMapClick: (lat: number, lon: number) => void
  onDropSelect: (drop: NearbyDrop) => void
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

function MapClickHandler({
  onMapClick,
}: {
  onMapClick: (lat: number, lon: number) => void
}) {
  useMapEvents({
    click(e) {
      // Only fire if the click target is the map itself, not a marker
      const target = e.originalEvent.target as HTMLElement
      if (target.closest('.leaflet-marker-icon') || target.closest('.leaflet-interactive')) {
        return
      }
      onMapClick(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

export default function DropMapView({
  currentLocation,
  onMapClick,
  onDropSelect,
}: DropMapViewProps) {
  const { sdk } = useGeoDrop()
  const [nearbyDrops, setNearbyDrops] = useState<NearbyDrop[]>([])

  const fetchDrops = useCallback(async () => {
    if (!currentLocation) return
    try {
      const drops = await sdk.findNearbyDrops(
        currentLocation.lat,
        currentLocation.lon,
        5000,
      )
      setNearbyDrops(drops)
    } catch {
      // Silently ignore fetch errors
    }
  }, [sdk, currentLocation?.lat, currentLocation?.lon])

  // Fetch nearby drops on mount and every 30s
  useEffect(() => {
    fetchDrops()
    const interval = setInterval(fetchDrops, 30000)
    return () => clearInterval(interval)
  }, [fetchDrops])

  const center: [number, number] = currentLocation
    ? [currentLocation.lat, currentLocation.lon]
    : [35.6812, 139.7671]

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <MapContainer
        center={center}
        zoom={15}
        style={{ width: '100%', height: '100%' }}
        keyboard={false}
        zoomControl={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <MapClickHandler onMapClick={onMapClick} />

        {currentLocation && (
          <>
            <InitialCenter lat={currentLocation.lat} lon={currentLocation.lon} />
            <CircleMarker
              center={[currentLocation.lat, currentLocation.lon]}
              radius={10}
              pathOptions={{
                color: '#3b82f6',
                fillColor: '#3b82f6',
                fillOpacity: 0.6,
                weight: 2,
              }}
            >
              <Popup>You</Popup>
            </CircleMarker>
          </>
        )}

        {nearbyDrops.map((nd) => (
          <span key={nd.drop.id}>
            {/* Unlock radius circle */}
            <Circle
              center={[nd.drop.lat, nd.drop.lon]}
              radius={nd.drop.unlock_radius_meters}
              pathOptions={{
                color: nd.can_unlock ? '#22c55e' : '#f59e0b',
                fillColor: nd.can_unlock ? '#22c55e' : '#f59e0b',
                fillOpacity: 0.06,
                weight: 1,
                dashArray: '6 4',
              }}
            />
            {/* Drop marker */}
            <CircleMarker
              center={[nd.drop.lat, nd.drop.lon]}
              radius={8}
              pathOptions={{
                color: nd.can_unlock ? '#16a34a' : '#d97706',
                fillColor: nd.can_unlock ? '#22c55e' : '#f59e0b',
                fillOpacity: 0.8,
                weight: 2,
              }}
              eventHandlers={{
                click: () => onDropSelect(nd),
              }}
            >
              <Popup>
                <div style={{ fontSize: '0.85rem', lineHeight: 1.5 }}>
                  <strong>{nd.drop.title}</strong>
                  <br />
                  {nd.distance_meters}m away
                  <br />
                  {nd.can_unlock ? 'Ready to unlock' : 'Move closer'}
                </div>
              </Popup>
            </CircleMarker>
          </span>
        ))}
      </MapContainer>
    </div>
  )
}
