import { useState, useEffect, useCallback } from 'react'
import { createClient, type User } from '@supabase/supabase-js'
import { createGeoDrop, type GeoDrop } from '@zairn/geo-drop'
import { MapContainer, TileLayer, Marker, Popup, Circle, useMapEvents } from 'react-leaflet'
import L from 'leaflet'

// Fix default marker icons
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const lockedIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
})

const unlockedIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
})

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// ─── Auth ─────────────────────────────────────

function AuthPanel({ onAuth }: { onAuth: (user: User, geo: ReturnType<typeof createGeoDrop>) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const auth = async (action: 'signIn' | 'signUp') => {
    setError('')
    const result = action === 'signIn'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password })
    if (result.error) { setError(result.error.message); return }
    const geo = createGeoDrop({
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
      supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    })
    onAuth(result.data.user!, geo)
  }

  return (
    <div style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Treasure Hunt</h1>
      <p style={{ color: 'var(--md-outline)', marginBottom: 24 }}>
        Create encrypted drops. Walk to them. Unlock with GPS.
      </p>
      <input type="email" placeholder="Email" value={email}
        onChange={e => setEmail(e.target.value)} style={inputStyle} />
      <input type="password" placeholder="Password" value={password}
        onChange={e => setPassword(e.target.value)} style={inputStyle} />
      {error && <p style={{ color: 'var(--md-error)', fontSize: 14 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => auth('signIn')} style={btnStyle}>Sign In</button>
        <button onClick={() => auth('signUp')}
          style={{ ...btnStyle, background: 'var(--md-outline)' }}>Sign Up</button>
      </div>
    </div>
  )
}

// ─── Create Drop Dialog ───────────────────────

function CreateDropDialog({ lat, lon, geo, onCreated, onCancel }: {
  lat: number; lon: number; geo: ReturnType<typeof createGeoDrop>
  onCreated: () => void; onCancel: () => void
}) {
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [radius, setRadius] = useState(30)
  const [creating, setCreating] = useState(false)

  const create = async () => {
    if (!title || !content) return
    setCreating(true)
    try {
      await geo.createDrop(
        { title, content_type: 'text', lat, lon, unlock_radius_meters: radius },
        content
      )
      onCreated()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={dialogOverlay}>
      <div style={dialogBox}>
        <h3 style={{ margin: '0 0 12px' }}>Hide Treasure</h3>
        <p style={{ fontSize: 13, color: 'var(--md-outline)', margin: '0 0 12px' }}>
          at ({lat.toFixed(4)}, {lon.toFixed(4)})
        </p>
        <input placeholder="Title (e.g. 'Golden Coin')" value={title}
          onChange={e => setTitle(e.target.value)} style={inputStyle} />
        <textarea placeholder="Secret content revealed on unlock" value={content}
          onChange={e => setContent(e.target.value)}
          style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }} />
        <label style={{ fontSize: 13, marginBottom: 12, display: 'block' }}>
          Unlock radius: {radius}m
          <input type="range" min={10} max={200} value={radius}
            onChange={e => setRadius(Number(e.target.value))}
            style={{ width: '100%' }} />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={create} disabled={creating} style={btnStyle}>
            {creating ? 'Hiding...' : 'Hide Treasure'}
          </button>
          <button onClick={onCancel} style={{ ...btnStyle, background: 'var(--md-outline)' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Map Click Handler ────────────────────────

function MapClickHandler({ onMapClick }: { onMapClick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(e) { onMapClick(e.latlng.lat, e.latlng.lng) },
  })
  return null
}

// ─── Game View ────────────────────────────────

function GameView({ geo }: { geo: ReturnType<typeof createGeoDrop> }) {
  const [drops, setDrops] = useState<any[]>([])
  const [unlockedIds, setUnlockedIds] = useState<Set<string>>(new Set())
  const [unlockedContent, setUnlockedContent] = useState<Record<string, string>>({})
  const [myPos, setMyPos] = useState<{ lat: number; lon: number; accuracy: number } | null>(null)
  const [createAt, setCreateAt] = useState<{ lat: number; lon: number } | null>(null)

  // Watch GPS
  useEffect(() => {
    const id = navigator.geolocation.watchPosition(
      pos => setMyPos({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      console.error,
      { enableHighAccuracy: true, maximumAge: 5000 }
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  // Load nearby drops
  const loadDrops = useCallback(async () => {
    if (!myPos) return
    const data = await geo.findNearbyDrops(myPos.lat, myPos.lon, 2000)
    setDrops(data)
  }, [geo, myPos?.lat, myPos?.lon])

  useEffect(() => { loadDrops() }, [loadDrops])

  const tryUnlock = async (dropId: string) => {
    if (!myPos) { alert('GPS not available'); return }
    try {
      const result = await geo.unlockDrop(dropId, myPos.lat, myPos.lon, myPos.accuracy)
      if (result.content) {
        setUnlockedIds(prev => new Set(prev).add(dropId))
        setUnlockedContent(prev => ({ ...prev, [dropId]: result.content }))
      }
    } catch (e: any) {
      alert(`Cannot unlock: ${e.message}`)
    }
  }

  const center: [number, number] = myPos ? [myPos.lat, myPos.lon] : [35.6812, 139.7671]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--md-outline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>Treasure Hunt</strong>
        <span style={{ fontSize: 13, color: 'var(--md-outline)' }}>
          {drops.length} drops nearby | {unlockedIds.size} unlocked | Click map to hide treasure
        </span>
      </div>

      <MapContainer center={center} zoom={15} style={{ flex: 1 }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/">OSM</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapClickHandler onMapClick={(lat, lon) => setCreateAt({ lat, lon })} />

        {/* My position */}
        {myPos && (
          <>
            <Marker position={[myPos.lat, myPos.lon]}>
              <Popup>You are here (accuracy: {myPos.accuracy.toFixed(0)}m)</Popup>
            </Marker>
            <Circle center={[myPos.lat, myPos.lon]} radius={myPos.accuracy}
              pathOptions={{ color: '#6442d6', fillOpacity: 0.1 }} />
          </>
        )}

        {/* Drops */}
        {drops.map((nd: any) => {
          const d = nd.drop
          const unlocked = unlockedIds.has(d.id)
          return (
            <Marker key={d.id} position={[d.lat, d.lon]}
              icon={unlocked ? unlockedIcon : lockedIcon}>
              <Popup>
                <strong>{d.title}</strong><br />
                <span style={{ fontSize: 12 }}>
                  Radius: {d.unlock_radius_meters}m | {nd.distance_meters.toFixed(0)}m away
                </span>
                {unlocked ? (
                  <div style={{ marginTop: 8, padding: 8, background: '#e8f5e9', borderRadius: 4 }}>
                    {unlockedContent[d.id]}
                  </div>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    <button onClick={() => tryUnlock(d.id)} style={{ ...btnStyle, padding: '4px 12px', fontSize: 12 }}>
                      Try Unlock
                    </button>
                  </div>
                )}
              </Popup>
            </Marker>
          )
        })}
      </MapContainer>

      {createAt && (
        <CreateDropDialog
          lat={createAt.lat} lon={createAt.lon} geo={geo}
          onCreated={() => { setCreateAt(null); loadDrops() }}
          onCancel={() => setCreateAt(null)}
        />
      )}
    </div>
  )
}

// ─── App ──────────────────────────────────────

export default function App() {
  const [auth, setAuth] = useState<{ user: User; geo: ReturnType<typeof createGeoDrop> } | null>(null)

  if (!auth) return <AuthPanel onAuth={(user, geo) => setAuth({ user, geo })} />
  return <GameView geo={auth.geo} />
}

// ─── Styles ───────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', marginBottom: 12,
  border: '1px solid var(--md-outline)', borderRadius: 8,
  fontSize: 14, boxSizing: 'border-box',
}

const btnStyle: React.CSSProperties = {
  padding: '10px 20px', border: 'none', borderRadius: 8,
  background: 'var(--md-primary)', color: 'var(--md-on-primary)',
  fontSize: 14, cursor: 'pointer',
}

const dialogOverlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}

const dialogBox: React.CSSProperties = {
  background: 'var(--md-surface)', borderRadius: 16, padding: 24,
  maxWidth: 400, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
}
