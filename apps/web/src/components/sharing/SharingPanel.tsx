import { useState, useEffect } from 'react'
import { useSdk } from '@/contexts/SdkContext'
import type { Profile, ShareLevel } from '@zairn/sdk'

interface FriendShareState {
  friendId: string
  profile: Profile | null
  level: ShareLevel
  expiresAt: string | null
}

const SHARE_LEVELS: { value: ShareLevel; label: string; desc: string }[] = [
  { value: 'none', label: 'None', desc: 'Not sharing' },
  { value: 'current', label: 'Current', desc: 'Current location only' },
  { value: 'history', label: 'History', desc: 'Current + history' },
]

export default function SharingPanel() {
  const core = useSdk()

  const [friends, setFriends] = useState<FriendShareState[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  useEffect(() => {
    loadFriends()
  }, [])

  async function loadFriends() {
    try {
      setLoading(true)
      setError('')
      const friendIds = await core.getFriends()
      const states: FriendShareState[] = []
      for (const fid of friendIds) {
        const profile = await core.getProfile(fid)
        states.push({
          friendId: fid,
          profile,
          level: 'current',
          expiresAt: null,
        })
      }
      setFriends(states)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleLevelChange(friendId: string, level: ShareLevel) {
    setUpdatingId(friendId)
    try {
      setError('')
      if (level === 'none') {
        await core.revoke(friendId)
      } else {
        await core.allow(friendId, level)
      }
      setFriends(prev =>
        prev.map(f => f.friendId === friendId ? { ...f, level } : f)
      )
    } catch (e: any) {
      setError(e.message)
    } finally {
      setUpdatingId(null)
    }
  }

  async function handleSetExpiry(friendId: string, dateStr: string) {
    if (!dateStr) return
    setUpdatingId(friendId)
    try {
      setError('')
      const date = new Date(dateStr)
      await core.setShareExpiry(friendId, date)
      setFriends(prev =>
        prev.map(f => f.friendId === friendId ? { ...f, expiresAt: date.toISOString() } : f)
      )
    } catch (e: any) {
      setError(e.message)
    } finally {
      setUpdatingId(null)
    }
  }

  if (loading) return <div className="p-4 text-center" style={{ color: 'var(--md-on-surface-variant)' }}>Loading sharing settings...</div>

  return (
    <div className="flex flex-col gap-4">
      {error && <div className="text-sm" style={{ color: 'var(--md-error)' }}>{error}</div>}

      {friends.length === 0 ? (
        <p className="text-sm text-center py-4" style={{ color: 'var(--md-on-surface-variant)' }}>No friends yet. Add friends to manage sharing.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {friends.map(f => (
            <div key={f.friendId} className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
                  {f.profile?.display_name?.[0]?.toUpperCase() ?? '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--md-on-surface)' }}>
                    {f.profile?.display_name ?? f.friendId.slice(0, 8)}
                  </p>
                  {f.profile?.username && (
                    <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>@{f.profile.username}</p>
                  )}
                </div>
                {updatingId === f.friendId && (
                  <span className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>Saving...</span>
                )}
              </div>

              {/* Level selector */}
              <div className="flex gap-1 mb-3">
                {SHARE_LEVELS.map(sl => (
                  <button key={sl.value} onClick={() => handleLevelChange(f.friendId, sl.value)}
                    disabled={updatingId === f.friendId}
                    className="flex-1 px-2 py-1.5 rounded text-xs transition-colors"
                    style={f.level === sl.value
                      ? sl.value === 'none'
                        ? { background: 'var(--md-error)', color: 'var(--md-on-primary)' }
                        : { background: 'var(--md-primary)', color: 'var(--md-on-primary)' }
                      : { background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface-variant)' }}>
                    {sl.label}
                  </button>
                ))}
              </div>

              {/* Level description */}
              <p className="text-xs mb-2" style={{ color: 'var(--md-on-surface-variant)' }}>
                {SHARE_LEVELS.find(sl => sl.value === f.level)?.desc}
              </p>

              {/* Expiry */}
              {f.level !== 'none' && (
                <div className="flex items-center gap-2">
                  <label className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>Expires:</label>
                  <input
                    type="datetime-local"
                    value={f.expiresAt ? f.expiresAt.slice(0, 16) : ''}
                    onChange={e => handleSetExpiry(f.friendId, e.target.value)}
                    className="rounded px-2 py-1 text-xs flex-1" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}
                  />
                  {f.expiresAt && (
                    <span className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>Set</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
