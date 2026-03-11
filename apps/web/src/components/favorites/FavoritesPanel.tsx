import { useState, useEffect } from 'react'
import { useSdk } from '@/contexts/SdkContext'
import type { FavoritePlace, PlaceType } from '@zairn/sdk'

const PLACE_TYPES: { type: PlaceType; icon: string; label: string }[] = [
  { type: 'home', icon: '🏠', label: 'Home' },
  { type: 'work', icon: '💼', label: 'Work' },
  { type: 'school', icon: '🎓', label: 'School' },
  { type: 'gym', icon: '💪', label: 'Gym' },
  { type: 'custom', icon: '📍', label: 'Custom' },
]

function placeIcon(type: PlaceType): string {
  return PLACE_TYPES.find(t => t.type === type)?.icon ?? '📍'
}

interface FavoritesPanelProps {
  currentLocation?: { lat: number; lon: number } | null
}

export default function FavoritesPanel({ currentLocation }: FavoritesPanelProps) {
  const core = useSdk()

  const [places, setPlaces] = useState<FavoritePlace[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [atPlace, setAtPlace] = useState<FavoritePlace | null>(null)

  const [showAdd, setShowAdd] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState<PlaceType>('custom')
  const [formLat, setFormLat] = useState('')
  const [formLon, setFormLon] = useState('')
  const [formRadius, setFormRadius] = useState('100')
  const [formIcon, setFormIcon] = useState('')

  useEffect(() => {
    loadPlaces()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core])

  useEffect(() => {
    if (currentLocation) {
      core.checkAtFavoritePlace(currentLocation.lat, currentLocation.lon)
        .then(setAtPlace)
        .catch(() => {})
    }
  }, [currentLocation])

  async function loadPlaces() {
    try {
      setLoading(true)
      setError('')
      const p = await core.getFavoritePlaces()
      setPlaces(p)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function resetForm() {
    setFormName('')
    setFormType('custom')
    setFormLat(currentLocation?.lat.toString() ?? '')
    setFormLon(currentLocation?.lon.toString() ?? '')
    setFormRadius('100')
    setFormIcon('')
    setEditingId(null)
    setShowAdd(false)
  }

  function startAdd() {
    resetForm()
    setFormLat(currentLocation?.lat.toString() ?? '')
    setFormLon(currentLocation?.lon.toString() ?? '')
    setShowAdd(true)
  }

  function startEdit(place: FavoritePlace) {
    setFormName(place.name)
    setFormType(place.place_type)
    setFormLat(place.lat.toString())
    setFormLon(place.lon.toString())
    setFormRadius(place.radius_meters.toString())
    setFormIcon(place.icon ?? '')
    setEditingId(place.id)
    setShowAdd(true)
  }

  async function handleSubmit() {
    if (!formName.trim()) return
    const lat = parseFloat(formLat)
    const lon = parseFloat(formLon)
    const radius = parseInt(formRadius, 10)
    if (isNaN(lat) || isNaN(lon) || isNaN(radius) || lat < -90 || lat > 90 || lon < -180 || lon > 180 || radius < 1 || radius > 100000) {
      setError('Invalid coordinates or radius')
      return
    }
    try {
      setError('')
      if (editingId) {
        await core.updateFavoritePlace(editingId, {
          name: formName.trim(),
          place_type: formType,
          lat, lon,
          radius_meters: radius,
          icon: formIcon || null,
        })
      } else {
        await core.addFavoritePlace({
          name: formName.trim(),
          place_type: formType,
          lat, lon,
          radius_meters: radius,
          icon: formIcon || null,
        })
      }
      resetForm()
      await loadPlaces()
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this favorite place?')) return
    try {
      await core.deleteFavoritePlace(id)
      await loadPlaces()
    } catch (e: any) {
      setError(e.message)
    }
  }

  function distanceText(place: FavoritePlace): string | null {
    if (!currentLocation) return null
    const d = core.calculateDistance(currentLocation.lat, currentLocation.lon, place.lat, place.lon)
    return d < 1000 ? `${Math.round(d)}m` : `${(d / 1000).toFixed(1)}km`
  }

  if (loading) return <div className="p-4 text-center" style={{ color: 'var(--md-on-surface-variant)' }}>Loading favorites...</div>

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="text-sm" style={{ color: 'var(--md-error)' }}>{error}</div>}

      {atPlace && (
        <div className="rounded-lg p-3 text-sm" style={{ background: 'var(--md-primary-container)', color: 'var(--md-on-primary-container)', border: '1px solid var(--md-primary)' }}>
          You are at <span className="font-semibold">{placeIcon(atPlace.place_type)} {atPlace.name}</span>
        </div>
      )}

      {/* Add / Edit form */}
      {showAdd ? (
        <div className="rounded-lg p-4 flex flex-col gap-2" style={{ background: 'var(--md-surface-container)' }}>
          <h4 className="text-sm font-semibold" style={{ color: 'var(--md-on-surface)' }}>{editingId ? 'Edit Place' : 'Add Place'}</h4>
          <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Place name"
            className="rounded px-3 py-1.5 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} />
          <div className="flex gap-1 flex-wrap">
            {PLACE_TYPES.map(t => (
              <button key={t.type} onClick={() => setFormType(t.type)}
                className="px-2 py-1 rounded text-xs"
                style={formType === t.type
                  ? { background: 'var(--md-primary)', color: 'var(--md-on-primary)' }
                  : { background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={formLat} onChange={e => setFormLat(e.target.value)} placeholder="Latitude"
              className="flex-1 rounded px-3 py-1.5 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} type="number" step="any" />
            <input value={formLon} onChange={e => setFormLon(e.target.value)} placeholder="Longitude"
              className="flex-1 rounded px-3 py-1.5 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} type="number" step="any" />
          </div>
          <input value={formRadius} onChange={e => setFormRadius(e.target.value)} placeholder="Radius (meters)"
            className="rounded px-3 py-1.5 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} type="number" />
          <div className="flex gap-2">
            <button onClick={handleSubmit} className="px-3 py-1.5 rounded text-sm" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>
              {editingId ? 'Update' : 'Add'}
            </button>
            <button onClick={resetForm} className="px-3 py-1.5 rounded text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={startAdd} className="w-full py-2 rounded text-sm" style={{ background: 'var(--md-surface-container)', color: 'var(--md-primary)' }}>
          + Add Favorite Place
        </button>
      )}

      {/* Places list */}
      {places.length === 0 ? (
        <p className="text-sm text-center py-4" style={{ color: 'var(--md-on-surface-variant)' }}>No favorite places yet</p>
      ) : (
        <div className="flex flex-col gap-2">
          {places.map(place => (
            <div key={place.id}
              className="rounded-lg p-3"
              style={{
                background: 'var(--md-surface-container)',
                ...(atPlace?.id === place.id ? { outline: '1px solid var(--md-primary)' } : {}),
              }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{place.icon ?? placeIcon(place.place_type)}</span>
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--md-on-surface)' }}>{place.name}</p>
                    <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>
                      {place.place_type}{distanceText(place) ? ` · ${distanceText(place)}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => startEdit(place)} className="text-xs hover:underline" style={{ color: 'var(--md-primary)' }}>Edit</button>
                  <button onClick={() => handleDelete(place.id)} className="text-xs hover:underline" style={{ color: 'var(--md-error)' }}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
