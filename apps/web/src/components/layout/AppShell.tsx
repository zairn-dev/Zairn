import { useState, useMemo, lazy, Suspense } from 'react'
import { useGeolocation } from '@/hooks/useGeolocation'
import SlidePanel from '@/components/layout/SlidePanel'
import ErrorBoundary from '@/components/ErrorBoundary'

export type PanelType =
  | 'friends' | 'chat' | 'profile' | 'more'
  | 'groups' | 'favorites' | 'sharing' | 'bumps' | 'reactions'
  | null

const MapView = lazy(() => import('@/components/map/MapView'))
const FriendsPanel = lazy(() => import('@/components/friends/FriendsPanel'))
const ChatPanel = lazy(() => import('@/components/chat/ChatPanel'))
const ProfilePanel = lazy(() => import('@/components/profile/ProfilePanel'))
const SettingsPanel = lazy(() => import('@/components/settings/SettingsPanel'))
const GroupsPanel = lazy(() => import('@/components/groups/GroupsPanel'))
const FavoritesPanel = lazy(() => import('@/components/favorites/FavoritesPanel'))
const SharingPanel = lazy(() => import('@/components/sharing/SharingPanel'))
const BumpPanel = lazy(() => import('@/components/bumps/BumpPanel'))
const ReactionPanel = lazy(() => import('@/components/reactions/ReactionPanel'))

interface Tab {
  id: PanelType
  label: string
  icon: string
}

const tabs: Tab[] = [
  { id: null, label: 'Map', icon: '🗺' },
  { id: 'friends', label: 'Friends', icon: '👥' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'profile', label: 'Profile', icon: '👤' },
  { id: 'more', label: 'More', icon: '⋯' },
]

export default function AppShell() {
  const [activePanel, setActivePanel] = useState<PanelType>(null)
  const [showTrails, setShowTrails] = useState(false)
  const [showExploration, setShowExploration] = useState(false)
  const [chatFriendId, setChatFriendId] = useState<string | undefined>()
  const geo = useGeolocation()

  const currentLocation = useMemo(() => {
    if (geo.lat !== null && geo.lon !== null && geo.accuracy !== null) {
      return { lat: geo.lat, lon: geo.lon, accuracy: geo.accuracy }
    }
    return null
  }, [geo.lat, geo.lon, geo.accuracy])

  const openPanel = (panel: PanelType) => setActivePanel(panel)
  const closePanel = () => {
    setActivePanel(null)
    setChatFriendId(undefined)
  }

  const handleTabClick = (panelId: PanelType) => {
    if (panelId === null || panelId === activePanel) {
      setActivePanel(null)
    } else {
      setActivePanel(panelId)
    }
  }

  const handleOpenChat = (userId: string) => {
    setChatFriendId(userId)
    setActivePanel('chat')
  }

  return (
    <div className="relative h-full w-full">
      {/* Map — always rendered (z-0 creates stacking context to contain Leaflet z-indexes) */}
      <div className="absolute inset-0 z-0">
        <ErrorBoundary fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--md-on-surface-variant)' }}>Failed to load map</div>}>
          <Suspense fallback={<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--md-on-surface-variant)' }}>Loading map...</div>}>
            <MapView
              currentLocation={currentLocation}
              showTrails={showTrails}
              showExploration={showExploration}
            />
          </Suspense>
        </ErrorBoundary>
      </div>

      {/* Map overlay buttons */}
      <div className="fixed top-4 right-4 z-40 flex flex-col gap-2">
        <button
          onClick={() => setShowTrails(v => !v)}
          className="glass rounded-full w-10 h-10 flex items-center justify-center text-lg cursor-pointer border-none"
          style={{ color: showTrails ? 'var(--md-primary)' : 'var(--md-on-surface-variant)' }}
          title="Toggle trails"
        >👣</button>
        <button
          onClick={() => setShowExploration(v => !v)}
          className="glass rounded-full w-10 h-10 flex items-center justify-center text-lg cursor-pointer border-none"
          style={{ color: showExploration ? 'var(--md-primary)' : 'var(--md-on-surface-variant)' }}
          title="Toggle exploration"
        >🔲</button>
        <button
          onClick={() => openPanel('bumps')}
          className="glass rounded-full w-10 h-10 flex items-center justify-center text-lg cursor-pointer border-none"
          title="Bumps"
        >📍</button>
        <button
          onClick={() => openPanel('reactions')}
          className="glass rounded-full w-10 h-10 flex items-center justify-center text-lg cursor-pointer border-none"
          title="Reactions"
        >👋</button>
      </div>

      {/* Slide panels */}
      <ErrorBoundary>
       <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', padding: 24, color: 'var(--md-on-surface-variant)' }}>Loading...</div>}>
        <SlidePanel open={activePanel === 'friends'} onClose={closePanel} title="Friends">
          <FriendsPanel onOpenChat={handleOpenChat} />
        </SlidePanel>
        <SlidePanel open={activePanel === 'chat'} onClose={closePanel} title="Chat">
          <ChatPanel initialFriendId={chatFriendId} />
        </SlidePanel>
        <SlidePanel open={activePanel === 'profile'} onClose={closePanel} title="Profile">
          <ProfilePanel />
        </SlidePanel>
        <SlidePanel open={activePanel === 'more'} onClose={closePanel} title="Settings">
          <SettingsPanel />
          <div className="mt-4 flex flex-col gap-2 px-4 pb-4">
            <button onClick={() => openPanel('groups')} className="w-full py-3 rounded-xl cursor-pointer border-none text-left px-4" style={{ background: 'var(--md-surface-container)' }}>
              👥 Groups
            </button>
            <button onClick={() => openPanel('favorites')} className="w-full py-3 rounded-xl cursor-pointer border-none text-left px-4" style={{ background: 'var(--md-surface-container)' }}>
              ⭐ Favorite Places
            </button>
            <button onClick={() => openPanel('sharing')} className="w-full py-3 rounded-xl cursor-pointer border-none text-left px-4" style={{ background: 'var(--md-surface-container)' }}>
              🔗 Sharing Settings
            </button>
          </div>
        </SlidePanel>
        <SlidePanel open={activePanel === 'groups'} onClose={closePanel} title="Groups">
          <GroupsPanel />
        </SlidePanel>
        <SlidePanel open={activePanel === 'favorites'} onClose={closePanel} title="Favorite Places">
          <FavoritesPanel currentLocation={currentLocation} />
        </SlidePanel>
        <SlidePanel open={activePanel === 'sharing'} onClose={closePanel} title="Sharing">
          <SharingPanel />
        </SlidePanel>
        <SlidePanel open={activePanel === 'bumps'} onClose={closePanel} title="Bumps">
          <BumpPanel currentLocation={currentLocation} />
        </SlidePanel>
        <SlidePanel open={activePanel === 'reactions'} onClose={closePanel} title="Reactions">
          <ReactionPanel />
        </SlidePanel>
       </Suspense>
      </ErrorBoundary>

      {/* Bottom navigation */}
      <nav
        className="glass fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around py-2 px-1"
        style={{ borderTop: '1px solid var(--md-outline-variant)' }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === null ? activePanel === null : activePanel === tab.id
          return (
            <button
              key={tab.label}
              onClick={() => handleTabClick(tab.id)}
              className="flex flex-col items-center gap-0.5 border-none bg-transparent cursor-pointer px-3 py-1 rounded-xl transition-colors"
              style={{
                color: isActive ? 'var(--md-primary)' : 'var(--md-on-surface-variant)',
                background: isActive ? 'var(--md-primary-container)' : 'transparent',
              }}
            >
              <span className="text-xl leading-none">{tab.icon}</span>
              <span className="text-xs font-medium">{tab.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
