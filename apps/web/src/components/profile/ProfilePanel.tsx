import { useState, useEffect, useRef } from 'react'
import { useSdk } from '@/contexts/SdkContext'
import { useAuth } from '@/contexts/AuthContext'
import { formatRelativeTime } from '@/utils/format'
import type { Profile, AreaRanking, FriendStreak, VisitedCellStats } from '@zen-map/sdk'

const EMOJI_GRID = ['😀','😎','🔥','❤️','🎉','💤','📍','🏃','🎮','📚','🍕','☕','🎵','✈️','🏠','💼']
const DURATION_OPTIONS = [
  { label: '30min', value: 30 },
  { label: '1h', value: 60 },
  { label: '4h', value: 240 },
  { label: '24h', value: 1440 },
]

export default function ProfilePanel() {
  const core = useSdk()
  const { user } = useAuth()

  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')

  const [statusEmoji, setStatusEmoji] = useState('')
  const [statusText, setStatusText] = useState('')
  const [statusDuration, setStatusDuration] = useState(60)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)

  const [stats, setStats] = useState<VisitedCellStats | null>(null)
  const [ranking, setRanking] = useState<AreaRanking[]>([])
  const [streaks, setStreaks] = useState<FriendStreak[]>([])
  const [streakProfiles, setStreakProfiles] = useState<Record<string, Profile | null>>({})

  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadProfile()
    loadStats()
    loadStreaks()
  }, [])

  async function loadProfile() {
    try {
      setLoading(true)
      const p = await core.getProfile()
      setProfile(p)
      if (p) {
        setUsername(p.username ?? '')
        setDisplayName(p.display_name ?? '')
      }
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function loadStats() {
    try {
      const [s, r] = await Promise.all([
        core.getMyExplorationStats(),
        core.getFriendRanking(),
      ])
      setStats(s)
      setRanking(r)
    } catch {}
  }

  async function loadStreaks() {
    try {
      const s = await core.getStreaks()
      setStreaks(s)
      const profiles: Record<string, Profile | null> = {}
      for (const streak of s) {
        profiles[streak.friend_id] = await core.getProfile(streak.friend_id)
      }
      setStreakProfiles(profiles)
    } catch {}
  }

  async function saveProfile() {
    try {
      const updated = await core.updateProfile({ username, display_name: displayName })
      setProfile(updated)
      setEditing(false)
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      await core.uploadAvatar(file)
      await loadProfile()
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleDeleteAvatar() {
    if (!confirm('Delete your avatar?')) return
    try {
      await core.deleteAvatar()
      await loadProfile()
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleSetStatus() {
    try {
      await core.setStatus(statusEmoji || '😀', statusText || undefined, statusDuration)
      await loadProfile()
      setShowEmojiPicker(false)
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleClearStatus() {
    try {
      await core.clearStatus()
      await loadProfile()
    } catch (e: any) {
      setError(e.message)
    }
  }

  if (loading) return <div className="p-4 text-center" style={{ color: 'var(--md-on-surface-variant)' }}>Loading profile...</div>
  if (error) return <div className="p-4 text-center" style={{ color: 'var(--md-error)' }}>{error}</div>

  return (
    <div className="flex flex-col gap-6">
      {/* Avatar */}
      <div className="flex flex-col items-center gap-2">
        {profile?.avatar_url ? (
          <img src={profile.avatar_url} alt="avatar" className="w-20 h-20 rounded-full object-cover" />
        ) : (
          <div className="w-20 h-20 rounded-full flex items-center justify-center text-3xl" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
            {profile?.display_name?.[0]?.toUpperCase() ?? '?'}
          </div>
        )}
        <div className="flex gap-2">
          <button onClick={() => fileRef.current?.click()} className="text-sm hover:underline" style={{ color: 'var(--md-primary)' }}>
            Upload
          </button>
          {profile?.avatar_url && (
            <button onClick={handleDeleteAvatar} className="text-sm hover:underline" style={{ color: 'var(--md-error)' }}>
              Remove
            </button>
          )}
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} />
      </div>

      {/* Profile Info */}
      <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold uppercase" style={{ color: 'var(--md-on-surface-variant)' }}>Profile</h3>
          <button onClick={() => editing ? saveProfile() : setEditing(true)} className="text-sm hover:underline" style={{ color: 'var(--md-primary)' }}>
            {editing ? 'Save' : 'Edit'}
          </button>
        </div>
        {editing ? (
          <div className="flex flex-col gap-2">
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder="Username"
              className="rounded px-3 py-1.5 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} />
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Display name"
              className="rounded px-3 py-1.5 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} />
          </div>
        ) : (
          <div className="text-sm" style={{ color: 'var(--md-on-surface)' }}>
            <p>@{profile?.username ?? 'not set'}</p>
            <p style={{ color: 'var(--md-on-surface-variant)' }}>{profile?.display_name ?? 'No display name'}</p>
          </div>
        )}
      </div>

      {/* Status */}
      <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
        <h3 className="text-sm font-semibold uppercase mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>Status</h3>
        {profile?.status_emoji && (
          <div className="flex items-center gap-2 mb-3 text-sm">
            <span className="text-xl">{profile.status_emoji}</span>
            <span style={{ color: 'var(--md-on-surface)' }}>{profile.status_text}</span>
            {profile.status_expires_at && (
              <span className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>expires {formatRelativeTime(profile.status_expires_at)}</span>
            )}
            <button onClick={handleClearStatus} className="ml-auto text-xs hover:underline" style={{ color: 'var(--md-error)' }}>Clear</button>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="w-9 h-9 rounded text-lg flex items-center justify-center" style={{ background: 'var(--md-surface-container-high)' }}>
              {statusEmoji || '😀'}
            </button>
            <input value={statusText} onChange={e => setStatusText(e.target.value)} placeholder="What's up?"
              className="flex-1 rounded px-3 py-1.5 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} />
          </div>
          {showEmojiPicker && (
            <div className="grid grid-cols-8 gap-1">
              {EMOJI_GRID.map(e => (
                <button key={e} onClick={() => { setStatusEmoji(e); setShowEmojiPicker(false) }}
                  className="w-8 h-8 rounded text-lg" style={{ background: 'var(--md-surface-container-high)' }}>{e}</button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <select value={statusDuration} onChange={e => setStatusDuration(Number(e.target.value))}
              className="rounded px-2 py-1 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
              {DURATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button onClick={handleSetStatus} className="px-3 py-1 rounded text-sm" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>
              Set Status
            </button>
          </div>
        </div>
      </div>

      {/* Exploration Stats */}
      <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
        <h3 className="text-sm font-semibold uppercase mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>Exploration</h3>
        {stats ? (
          <div className="text-sm mb-3" style={{ color: 'var(--md-on-surface)' }}>
            <p>Cells explored: <span className="font-bold">{stats.total_cells}</span></p>
            <p style={{ color: 'var(--md-on-surface-variant)' }}>Since {formatRelativeTime(stats.exploring_since)}</p>
          </div>
        ) : (
          <p className="text-sm mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>No exploration data yet</p>
        )}
        {ranking.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold mb-1" style={{ color: 'var(--md-on-surface-variant)' }}>Friend Ranking</h4>
            <div className="flex flex-col gap-1">
              {ranking.map(r => (
                <div key={r.user_id} className="flex justify-between text-sm" style={{ color: 'var(--md-on-surface)' }}>
                  <span>#{r.rank}</span>
                  <span className="truncate flex-1 mx-2">{r.user_id.slice(0, 8)}</span>
                  <span className="font-mono">{r.cell_count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Streaks */}
      <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
        <h3 className="text-sm font-semibold uppercase mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>Streaks</h3>
        {streaks.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--md-on-surface-variant)' }}>No streaks yet</p>
        ) : (
          <div className="flex flex-col gap-2">
            {streaks.map(s => {
              const p = streakProfiles[s.friend_id]
              return (
                <div key={s.friend_id} className="flex items-center justify-between text-sm">
                  <span style={{ color: 'var(--md-on-surface)' }}>{p?.display_name ?? s.friend_id.slice(0, 8)}</span>
                  <div className="flex items-center gap-2">
                    <span title={`Current: ${s.current_streak}`}>
                      {'🔥'.repeat(Math.min(s.current_streak, 5))}{s.current_streak > 5 ? `+${s.current_streak - 5}` : ''}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>best: {s.longest_streak}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
