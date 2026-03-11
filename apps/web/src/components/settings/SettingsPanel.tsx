import { useState, useEffect } from 'react'
import { useSdk } from '@/contexts/SdkContext'
import { useAuth } from '@/contexts/AuthContext'
import type { UserSettings, NotificationPreferences, Profile } from '@zairn/sdk'

const GHOST_DURATIONS = [
  { label: '1 hour', value: 60 },
  { label: '4 hours', value: 240 },
  { label: '8 hours', value: 480 },
  { label: 'Indefinite', value: 0 },
]

export default function SettingsPanel() {
  const core = useSdk()
  const { user, signOut } = useAuth()

  const [settings, setSettings] = useState<UserSettings | null>(null)
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreferences | null>(null)
  const [blockedUsers, setBlockedUsers] = useState<string[]>([])
  const [blockedProfiles, setBlockedProfiles] = useState<Record<string, Profile | null>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [ghostDuration, setGhostDuration] = useState(60)
  const [updateInterval, setUpdateInterval] = useState(30)

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core])

  async function loadAll() {
    try {
      setLoading(true)
      setError('')
      const [s, n, b] = await Promise.all([
        core.getSettings(),
        core.getNotificationPreferences(),
        core.getBlockedUsers(),
      ])
      setSettings(s)
      setNotifPrefs(n)
      setBlockedUsers(b)
      if (s) setUpdateInterval(s.location_update_interval)

      const profiles: Record<string, Profile | null> = {}
      for (const uid of b) {
        profiles[uid] = await core.getProfile(uid)
      }
      setBlockedProfiles(profiles)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleEnableGhost() {
    try {
      setError('')
      await core.enableGhostMode(ghostDuration || undefined)
      const s = await core.getSettings()
      setSettings(s)
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleDisableGhost() {
    try {
      setError('')
      await core.disableGhostMode()
      const s = await core.getSettings()
      setSettings(s)
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleUpdateInterval() {
    try {
      setError('')
      const s = await core.updateSettings({ location_update_interval: updateInterval })
      setSettings(s)
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleNotifToggle(key: keyof Omit<NotificationPreferences, 'user_id' | 'updated_at'>, value: boolean) {
    try {
      setError('')
      const updated = await core.updateNotificationPreferences({ [key]: value })
      setNotifPrefs(updated)
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleUnblock(userId: string) {
    try {
      setError('')
      await core.unblockUser(userId)
      setBlockedUsers(prev => prev.filter(id => id !== userId))
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleSignOut() {
    try {
      await signOut()
    } catch (e: any) {
      setError(e.message)
    }
  }

  if (loading) return <div className="p-4 text-center" style={{ color: 'var(--md-on-surface-variant)' }}>Loading settings...</div>

  return (
    <div className="flex flex-col gap-6">
      {error && <div className="text-sm" style={{ color: 'var(--md-error)' }}>{error}</div>}

      {/* Ghost Mode */}
      <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
        <h3 className="text-sm font-semibold uppercase mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>Ghost Mode</h3>
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm" style={{ color: 'var(--md-on-surface)' }}>
              {settings?.ghost_mode ? 'Active' : 'Inactive'}
            </p>
            {settings?.ghost_mode && settings.ghost_until && (
              <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>
                Until {new Date(settings.ghost_until).toLocaleString()}
              </p>
            )}
          </div>
          <div className="w-3 h-3 rounded-full" style={{ background: settings?.ghost_mode ? 'var(--md-error)' : '#22c55e' }} />
        </div>
        {settings?.ghost_mode ? (
          <button onClick={handleDisableGhost}
            className="w-full py-2 rounded text-sm" style={{ background: '#22c55e', color: '#fff' }}>
            Disable Ghost Mode
          </button>
        ) : (
          <div className="flex gap-2">
            <select value={ghostDuration} onChange={e => setGhostDuration(Number(e.target.value))}
              className="rounded px-2 py-1.5 text-sm flex-1" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
              {GHOST_DURATIONS.map(d => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
            <button onClick={handleEnableGhost}
              className="px-4 py-1.5 rounded text-sm" style={{ background: 'var(--md-error)', color: 'var(--md-on-primary)' }}>
              Enable
            </button>
          </div>
        )}
      </div>

      {/* Location Settings */}
      <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
        <h3 className="text-sm font-semibold uppercase mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>Location</h3>
        <div className="flex items-center gap-2">
          <label className="text-sm" style={{ color: 'var(--md-on-surface-variant)' }}>Update interval (s):</label>
          <input type="number" value={updateInterval} onChange={e => setUpdateInterval(Number(e.target.value))}
            min={5} max={600}
            className="w-20 rounded px-2 py-1 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} />
          <button onClick={handleUpdateInterval}
            className="px-3 py-1 rounded text-sm" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>
            Save
          </button>
        </div>
      </div>

      {/* Notifications */}
      <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
        <h3 className="text-sm font-semibold uppercase mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>Notifications</h3>
        {notifPrefs ? (
          <div className="flex flex-col gap-2">
            {([
              ['friend_requests', 'Friend requests'],
              ['reactions', 'Reactions'],
              ['chat_messages', 'Chat messages'],
              ['bumps', 'Bumps'],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center justify-between cursor-pointer">
                <span className="text-sm" style={{ color: 'var(--md-on-surface)' }}>{label}</span>
                <input type="checkbox"
                  checked={notifPrefs[key]}
                  onChange={e => handleNotifToggle(key, e.target.checked)}
                  className="w-4 h-4 accent-blue-500" />
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm" style={{ color: 'var(--md-on-surface-variant)' }}>No notification preferences set</p>
        )}
      </div>

      {/* Blocked Users */}
      <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
        <h3 className="text-sm font-semibold uppercase mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>
          Blocked Users ({blockedUsers.length})
        </h3>
        {blockedUsers.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--md-on-surface-variant)' }}>No blocked users</p>
        ) : (
          <div className="flex flex-col gap-2">
            {blockedUsers.map(uid => {
              const p = blockedProfiles[uid]
              return (
                <div key={uid} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
                      {p?.display_name?.[0]?.toUpperCase() ?? '?'}
                    </div>
                    <span className="text-sm" style={{ color: 'var(--md-on-surface)' }}>
                      {p?.display_name ?? uid.slice(0, 8)}
                    </span>
                  </div>
                  <button onClick={() => handleUnblock(uid)}
                    className="text-xs hover:underline" style={{ color: 'var(--md-primary)' }}>
                    Unblock
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Account */}
      <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
        <h3 className="text-sm font-semibold uppercase mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>Account</h3>
        <p className="text-sm mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>{user?.email ?? 'No email'}</p>
        <button onClick={handleSignOut}
          className="w-full py-2 rounded text-sm" style={{ background: 'var(--md-error)', color: 'var(--md-on-primary)' }}>
          Sign Out
        </button>
      </div>
    </div>
  )
}
