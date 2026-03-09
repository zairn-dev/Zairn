import { useState, useMemo, lazy, Suspense } from 'react'
import { useGeolocation } from '@/hooks/useGeolocation'
import ErrorBoundary from '@/components/ErrorBoundary'
import type { NearbyDrop } from '@zen-map/geo-drop'

const DropMapView = lazy(() => import('@/components/map/DropMapView'))
const CreateDropSheet = lazy(() => import('@/components/drops/CreateDropSheet'))
const DropDetail = lazy(() => import('@/components/drops/DropDetail'))
const MyDropsList = lazy(() => import('@/components/drops/MyDropsList'))
const MyClaimsList = lazy(() => import('@/components/drops/MyClaimsList'))
const StatsView = lazy(() => import('@/components/stats/StatsView'))

type PanelType = 'myDrops' | 'myClaims' | 'stats' | null

interface Tab {
  id: PanelType
  label: string
  icon: string
}

const tabs: Tab[] = [
  { id: null, label: 'Map', icon: '\u{1F5FA}' },
  { id: 'myDrops', label: 'My Drops', icon: '\u{1F4E6}' },
  { id: 'myClaims', label: 'Claims', icon: '\u{1F513}' },
  { id: 'stats', label: 'Stats', icon: '\u{1F4CA}' },
]

export default function AppShell() {
  const [activePanel, setActivePanel] = useState<PanelType>(null)
  const [createLocation, setCreateLocation] = useState<{ lat: number; lon: number } | null>(null)
  const [selectedDrop, setSelectedDrop] = useState<NearbyDrop | null>(null)
  const geo = useGeolocation()

  const currentLocation = useMemo(() => {
    if (geo.lat !== null && geo.lon !== null && geo.accuracy !== null) {
      return { lat: geo.lat, lon: geo.lon, accuracy: geo.accuracy }
    }
    return null
  }, [geo.lat, geo.lon, geo.accuracy])

  const handleMapClick = (lat: number, lon: number) => {
    setCreateLocation({ lat, lon })
  }

  const handleDropSelect = (drop: NearbyDrop) => {
    setSelectedDrop(drop)
  }

  const handleTabClick = (panelId: PanelType) => {
    if (panelId === null || panelId === activePanel) {
      setActivePanel(null)
    } else {
      setActivePanel(panelId)
    }
  }

  const handleCreateAtMyLocation = () => {
    if (currentLocation) {
      setCreateLocation({ lat: currentLocation.lat, lon: currentLocation.lon })
    }
  }

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      {/* Map -- always rendered in background */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
        <ErrorBoundary><Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--md-on-surface-variant)' }}>Loading...</div>}>
          <DropMapView
            currentLocation={currentLocation}
            onMapClick={handleMapClick}
            onDropSelect={handleDropSelect}
          />
        </Suspense></ErrorBoundary>
      </div>

      {/* Slide panels */}
      <ErrorBoundary><Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--md-on-surface-variant)' }}>Loading...</div>}>
        {activePanel === 'myDrops' && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              onClick={() => setActivePanel(null)}
              style={{
                position: 'absolute',
                inset: 0,
                background: 'var(--md-scrim)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                bottom: 56,
                left: 0,
                right: 0,
                maxHeight: '70vh',
                overflowY: 'auto',
                background: 'var(--md-surface)',
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                boxShadow: '0 -4px 24px var(--md-shadow)',
                animation: 'slideUp 0.3s ease-out',
              }}
            >
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  background: 'var(--md-surface)',
                  padding: '16px 20px 8px',
                  borderTopLeftRadius: 24,
                  borderTopRightRadius: 24,
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 4,
                    borderRadius: 2,
                    background: 'var(--md-outline-variant)',
                    margin: '0 auto 12px',
                  }}
                />
                <h2
                  style={{
                    margin: 0,
                    fontSize: '1.15rem',
                    fontWeight: 600,
                    color: 'var(--md-on-surface)',
                  }}
                >
                  My Drops
                </h2>
              </div>
              <MyDropsList />
            </div>
          </div>
        )}

        {activePanel === 'myClaims' && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              onClick={() => setActivePanel(null)}
              style={{
                position: 'absolute',
                inset: 0,
                background: 'var(--md-scrim)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                bottom: 56,
                left: 0,
                right: 0,
                maxHeight: '70vh',
                overflowY: 'auto',
                background: 'var(--md-surface)',
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                boxShadow: '0 -4px 24px var(--md-shadow)',
                animation: 'slideUp 0.3s ease-out',
              }}
            >
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  background: 'var(--md-surface)',
                  padding: '16px 20px 8px',
                  borderTopLeftRadius: 24,
                  borderTopRightRadius: 24,
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 4,
                    borderRadius: 2,
                    background: 'var(--md-outline-variant)',
                    margin: '0 auto 12px',
                  }}
                />
                <h2
                  style={{
                    margin: 0,
                    fontSize: '1.15rem',
                    fontWeight: 600,
                    color: 'var(--md-on-surface)',
                  }}
                >
                  My Claims
                </h2>
              </div>
              <MyClaimsList />
            </div>
          </div>
        )}

        {activePanel === 'stats' && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 40,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              onClick={() => setActivePanel(null)}
              style={{
                position: 'absolute',
                inset: 0,
                background: 'var(--md-scrim)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                bottom: 56,
                left: 0,
                right: 0,
                maxHeight: '70vh',
                overflowY: 'auto',
                background: 'var(--md-surface)',
                borderTopLeftRadius: 24,
                borderTopRightRadius: 24,
                boxShadow: '0 -4px 24px var(--md-shadow)',
                animation: 'slideUp 0.3s ease-out',
              }}
            >
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  background: 'var(--md-surface)',
                  padding: '16px 20px 8px',
                  borderTopLeftRadius: 24,
                  borderTopRightRadius: 24,
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 4,
                    borderRadius: 2,
                    background: 'var(--md-outline-variant)',
                    margin: '0 auto 12px',
                  }}
                />
                <h2
                  style={{
                    margin: 0,
                    fontSize: '1.15rem',
                    fontWeight: 600,
                    color: 'var(--md-on-surface)',
                  }}
                >
                  Stats
                </h2>
              </div>
              <StatsView />
            </div>
          </div>
        )}
      </Suspense></ErrorBoundary>

      {/* FAB: Create at my location */}
      {activePanel === null && currentLocation && (
        <button
          onClick={handleCreateAtMyLocation}
          style={{
            position: 'fixed',
            bottom: 72,
            right: 16,
            zIndex: 30,
            width: 56,
            height: 56,
            borderRadius: 16,
            border: 'none',
            background: 'var(--md-primary)',
            color: 'var(--md-on-primary)',
            fontSize: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            boxShadow: '0 4px 16px var(--md-shadow)',
          }}
          title="Create drop at my location"
        >
          +
        </button>
      )}

      {/* CreateDropSheet */}
      <ErrorBoundary><Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--md-on-surface-variant)' }}>Loading...</div>}>
        {createLocation && (
          <CreateDropSheet
            location={createLocation}
            onClose={() => setCreateLocation(null)}
            onCreated={() => setCreateLocation(null)}
          />
        )}
      </Suspense></ErrorBoundary>

      {/* DropDetail */}
      <ErrorBoundary><Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--md-on-surface-variant)' }}>Loading...</div>}>
        {selectedDrop && (
          <DropDetail
            dropId={selectedDrop.drop.id}
            distance={selectedDrop.distance_meters}
            canUnlock={selectedDrop.can_unlock}
            currentLocation={currentLocation}
            onClose={() => setSelectedDrop(null)}
          />
        )}
      </Suspense></ErrorBoundary>

      {/* Bottom navigation */}
      <nav
        className="glass"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 50,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          padding: '8px 4px',
          borderTop: '1px solid var(--md-outline-variant)',
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === null ? activePanel === null : activePanel === tab.id
          return (
            <button
              key={tab.label}
              onClick={() => handleTabClick(tab.id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
                border: 'none',
                background: isActive ? 'var(--md-primary-container)' : 'transparent',
                color: isActive ? 'var(--md-primary)' : 'var(--md-on-surface-variant)',
                cursor: 'pointer',
                padding: '4px 12px',
                borderRadius: 12,
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              <span style={{ fontSize: '1.25rem', lineHeight: 1 }}>{tab.icon}</span>
              <span style={{ fontSize: '0.7rem', fontWeight: 500 }}>{tab.label}</span>
            </button>
          )
        })}
      </nav>

      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to { transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}
