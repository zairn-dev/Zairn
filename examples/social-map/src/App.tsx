import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient, type User } from '@supabase/supabase-js'
import { createLocationCore, type LocationCore } from '@zairn/sdk'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'

// Fix default marker icons in bundled environments
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const friendIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)

// ─── Auth Panel ───────────────────────────────

function AuthPanel({ onAuth }: { onAuth: (user: User, core: LocationCore) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const auth = async (action: 'signIn' | 'signUp') => {
    setLoading(true)
    setError('')
    try {
      const result = action === 'signIn'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password })
      if (result.error) throw result.error
      const core = createLocationCore({
        supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
        supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      })
      onAuth(result.data.user!, core)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: '80px auto', padding: 24 }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Social Map</h1>
      <p style={{ color: 'var(--md-outline)', marginBottom: 24 }}>
        Minimal private location sharing with @zairn/sdk
      </p>
      <input
        type="email" placeholder="Email" value={email}
        onChange={e => setEmail(e.target.value)}
        style={inputStyle}
      />
      <input
        type="password" placeholder="Password" value={password}
        onChange={e => setPassword(e.target.value)}
        style={inputStyle}
      />
      {error && <p style={{ color: 'var(--md-error)', fontSize: 14 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => auth('signIn')} disabled={loading} style={btnStyle}>
          Sign In
        </button>
        <button onClick={() => auth('signUp')} disabled={loading}
          style={{ ...btnStyle, background: 'var(--md-outline)', opacity: 0.8 }}>
          Sign Up
        </button>
      </div>
    </div>
  )
}

// ─── Friend Panel ─────────────────────────────

function FriendPanel({ core }: { core: LocationCore }) {
  const [friendEmail, setFriendEmail] = useState('')
  const [friends, setFriends] = useState<string[]>([])
  const [pending, setPending] = useState<any[]>([])
  const [msg, setMsg] = useState('')

  const refresh = useCallback(async () => {
    try {
      const f = await core.getFriends()
      setFriends(f)
      const p = await core.getPendingRequests()
      setPending(p)
    } catch { /* ignore if not authed yet */ }
  }, [core])

  useEffect(() => { refresh() }, [refresh])

  const sendRequest = async () => {
    setMsg('')
    const profiles = await core.searchProfiles(friendEmail)
    if (!profiles.data?.length) { setMsg('User not found'); return }
    const result = await core.sendFriendRequest(profiles.data[0].id)
    if (result.error) setMsg(result.error.message)
    else setMsg('Request sent!')
    setFriendEmail('')
    refresh()
  }

  const accept = async (reqId: number) => {
    await core.acceptFriendRequest(reqId)
    refresh()
  }

  return (
    <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--md-outline)', fontSize: 14 }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          placeholder="Friend's email or name"
          value={friendEmail} onChange={e => setFriendEmail(e.target.value)}
          style={{ ...inputStyle, marginBottom: 0, flex: 1 }}
        />
        <button onClick={sendRequest} style={{ ...btnStyle, padding: '6px 12px', fontSize: 13 }}>
          Add
        </button>
      </div>
      {msg && <p style={{ margin: '4px 0', color: 'var(--md-primary)' }}>{msg}</p>}
      {pending.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <strong>Pending requests:</strong>
          {pending.map((r: any) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span>{r.from_user_id.slice(0, 8)}...</span>
              <button onClick={() => accept(r.id)}
                style={{ ...btnStyle, padding: '2px 8px', fontSize: 12 }}>
                Accept
              </button>
            </div>
          ))}
        </div>
      )}
      <div>
        <strong>Friends ({friends.length}):</strong>
        {friends.map((id: string) => (
          <span key={id} style={{ marginLeft: 8 }}>{id.slice(0, 8)}</span>
        ))}
      </div>
    </div>
  )
}

// ─── Map View ─────────────────────────────────

function RecenterMap({ center }: { center: [number, number] }) {
  const map = useMap()
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { map.setView(center, 15); first.current = false }
  }, [center, map])
  return null
}

function MapView({ core }: { core: LocationCore }) {
  const [myPos, setMyPos] = useState<{ lat: number; lon: number } | null>(null)
  const [friendLocations, setFriendLocations] = useState<any[]>([])

  // Watch own position and share it
  useEffect(() => {
    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon, accuracy } = pos.coords
        setMyPos({ lat, lon })
        await core.sendLocation({ lat, lon, accuracy })
      },
      console.error,
      { enableHighAccuracy: true, maximumAge: 10000 }
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [core])

  // Poll friend locations
  useEffect(() => {
    const poll = async () => {
      try {
        const data = await core.getVisibleFriends()
        setFriendLocations(data)
      } catch { /* ignore */ }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [core])

  // Subscribe to realtime updates
  useEffect(() => {
    const channel = core.subscribeLocations((row: any) => {
      setFriendLocations(prev => {
        const idx = prev.findIndex(f => f.user_id === row.user_id)
        if (idx >= 0) { const next = [...prev]; next[idx] = row; return next }
        return [...prev, row]
      })
    })
    return () => { channel?.unsubscribe?.() }
  }, [core])

  const center: [number, number] = myPos ? [myPos.lat, myPos.lon] : [35.6812, 139.7671]

  return (
    <MapContainer center={center} zoom={15} style={{ flex: 1 }}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/">OSM</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <RecenterMap center={center} />
      {myPos && (
        <Marker position={[myPos.lat, myPos.lon]}>
          <Popup>You</Popup>
        </Marker>
      )}
      {friendLocations.map((f: any) => (
        <Marker key={f.user_id} position={[f.lat, f.lon]} icon={friendIcon}>
          <Popup>Friend: {f.user_id.slice(0, 8)}</Popup>
        </Marker>
      ))}
    </MapContainer>
  )
}

// ─── App ──────────────────────────────────────

export default function App() {
  const [auth, setAuth] = useState<{ user: User; core: LocationCore } | null>(null)

  if (!auth) return <AuthPanel onAuth={(user, core) => setAuth({ user, core })} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
      <FriendPanel core={auth.core} />
      <MapView core={auth.core} />
    </div>
  )
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
