import { useState, useEffect, useCallback } from 'react'
import { useSdk } from '@/contexts/SdkContext'
import { useAuth } from '@/contexts/AuthContext'
import type { Profile, FriendRequest, FriendOfFriend } from '@zen-map/sdk'

type Tab = 'friends' | 'requests' | 'search'

interface FriendsPanelProps {
  onOpenChat?: (userId: string) => void
}

export default function FriendsPanel({ onOpenChat }: FriendsPanelProps) {
  const sdk = useSdk()
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('friends')

  return (
    <div className="flex flex-col h-full">
      <div className="flex" style={{ borderBottom: '1px solid var(--md-outline-variant)' }}>
        {(['friends', 'requests', 'search'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex-1 py-2 text-sm font-medium capitalize transition-colors"
            style={tab === t
              ? { borderBottom: '2px solid var(--md-primary)', color: 'var(--md-on-surface)' }
              : { color: 'var(--md-on-surface-variant)' }}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {tab === 'friends' && <FriendsTab sdk={sdk} onOpenChat={onOpenChat} />}
        {tab === 'requests' && <RequestsTab sdk={sdk} userId={user?.id} />}
        {tab === 'search' && <SearchTab sdk={sdk} userId={user?.id} />}
      </div>
    </div>
  )
}

function FriendsTab({ sdk, onOpenChat }: { sdk: any; onOpenChat?: (id: string) => void }) {
  const [friends, setFriends] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const ids: string[] = await sdk.getFriends()
      const profiles = await Promise.all(ids.map(async (id: string) => {
        try {
          const p = await sdk.getProfile(id)
          // If no profile row exists, create a stub so the friend still shows
          return p ?? { user_id: id, username: null, display_name: null, avatar_url: null, status_emoji: null, status_text: null, status_expires_at: null, created_at: '', updated_at: '' } as Profile
        } catch {
          return { user_id: id, username: null, display_name: null, avatar_url: null, status_emoji: null, status_text: null, status_expires_at: null, created_at: '', updated_at: '' } as Profile
        }
      }))
      setFriends(profiles)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load friends')
    } finally {
      setLoading(false)
    }
  }, [sdk])

  useEffect(() => { load() }, [load])

  const handleRemove = async (id: string, name: string) => {
    if (!confirm(`Remove ${name}?`)) return
    try {
      await sdk.removeFriend(id)
      setFriends((prev) => prev.filter((f) => f.user_id !== id))
    } catch (e: any) {
      setError(e.message ?? 'Failed to remove friend')
    }
  }

  if (loading) return <p className="text-sm text-center py-4" style={{ color: 'var(--md-on-surface-variant)' }}>Loading...</p>
  if (error) return <p className="text-sm text-center py-4" style={{ color: 'var(--md-error)' }}>{error}</p>
  if (!friends.length) return <p className="text-sm text-center py-4" style={{ color: 'var(--md-on-surface-variant)' }}>No friends yet</p>

  return (
    <ul className="space-y-2">
      {friends.map((f) => {
        const name = f.display_name || f.user_id.slice(0, 8)
        return (
          <li key={f.user_id} className="flex items-center gap-3 p-2 rounded-lg" style={{ background: 'var(--md-surface-container)' }}>
            {f.avatar_url ? (
              <img src={f.avatar_url} alt="" className="w-9 h-9 rounded-full object-cover" />
            ) : (
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
                {name[0]}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: 'var(--md-on-surface)' }}>
                {f.status_emoji && <span className="mr-1">{f.status_emoji}</span>}
                {name}
              </p>
            </div>
            <div className="flex gap-1">
              {onOpenChat && (
                <button onClick={() => onOpenChat(f.user_id)} className="px-2 py-1 text-xs rounded" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>Chat</button>
              )}
              <button onClick={() => handleRemove(f.user_id, name)} className="px-2 py-1 text-xs rounded" style={{ background: 'var(--md-error)', color: 'var(--md-on-primary)', opacity: 0.8 }}>Remove</button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function RequestsTab({ sdk, userId }: { sdk: any; userId?: string }) {
  const [received, setReceived] = useState<FriendRequest[]>([])
  const [sent, setSent] = useState<FriendRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [r, s] = await Promise.all([sdk.getPendingRequests(), sdk.getSentRequests()])
      setReceived(r)
      setSent(s)
    } catch (e: any) {
      setError(e.message ?? 'Failed to load requests')
    } finally {
      setLoading(false)
    }
  }, [sdk])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const ch = sdk.subscribeFriendRequests(() => load())
    return () => { ch.unsubscribe() }
  }, [sdk, load])

  const act = async (fn: () => Promise<void>) => {
    try { await fn(); load() } catch (e: any) { setError(e.message) }
  }

  if (loading) return <p className="text-sm text-center py-4" style={{ color: 'var(--md-on-surface-variant)' }}>Loading...</p>
  if (error) return <p className="text-sm text-center py-4" style={{ color: 'var(--md-error)' }}>{error}</p>

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--md-on-surface-variant)' }}>Received</h3>
        {received.length === 0 && <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>None</p>}
        {received.map((r) => (
          <div key={r.id} className="flex items-center justify-between p-2 rounded-lg mb-1" style={{ background: 'var(--md-surface-container)' }}>
            <span className="text-sm truncate" style={{ color: 'var(--md-on-surface)' }}>{r.from_user_id.slice(0, 8)}</span>
            <div className="flex gap-1">
              <button onClick={() => act(() => sdk.acceptFriendRequest(r.id))} className="px-2 py-1 text-xs rounded" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>Accept</button>
              <button onClick={() => act(() => sdk.rejectFriendRequest(r.id))} className="px-2 py-1 text-xs rounded" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface-variant)' }}>Reject</button>
            </div>
          </div>
        ))}
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--md-on-surface-variant)' }}>Sent</h3>
        {sent.length === 0 && <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>None</p>}
        {sent.map((r) => (
          <div key={r.id} className="flex items-center justify-between p-2 rounded-lg mb-1" style={{ background: 'var(--md-surface-container)' }}>
            <span className="text-sm truncate" style={{ color: 'var(--md-on-surface)' }}>{r.to_user_id.slice(0, 8)}</span>
            <button onClick={() => act(() => sdk.cancelFriendRequest(r.id))} className="px-2 py-1 text-xs rounded" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface-variant)' }}>Cancel</button>
          </div>
        ))}
      </div>
    </div>
  )
}

function SearchTab({ sdk, userId }: { sdk: any; userId?: string }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Profile[]>([])
  const [suggestions, setSuggestions] = useState<FriendOfFriend[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    sdk.getFriendsOfFriends().then(setSuggestions).catch(() => {})
  }, [sdk])

  const search = async () => {
    if (!query.trim()) return
    setLoading(true)
    setError('')
    try {
      setResults(await sdk.searchProfiles(query.trim()))
    } catch (e: any) {
      setError(e.message ?? 'Search failed')
    } finally {
      setLoading(false)
    }
  }

  const addFriend = async (id: string) => {
    try {
      await sdk.sendFriendRequest(id)
      setResults((prev) => prev.filter((p) => p.user_id !== id))
    } catch (e: any) {
      setError(e.message ?? 'Failed to send request')
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder="Search by username..."
          className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
          style={{ background: 'var(--md-surface-container)', color: 'var(--md-on-surface)' }}
        />
        <button onClick={search} disabled={loading} className="px-3 py-2 rounded-lg text-sm font-medium" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>
          {loading ? '...' : 'Search'}
        </button>
      </div>
      {error && <p className="text-xs" style={{ color: 'var(--md-error)' }}>{error}</p>}
      {results.map((p) => (
        <div key={p.user_id} className="flex items-center justify-between p-2 rounded-lg" style={{ background: 'var(--md-surface-container)' }}>
          <span className="text-sm truncate" style={{ color: 'var(--md-on-surface)' }}>{p.display_name || p.username || p.user_id.slice(0, 8)}</span>
          <button onClick={() => addFriend(p.user_id)} className="px-2 py-1 text-xs rounded" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>Add</button>
        </div>
      ))}
      {suggestions.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--md-on-surface-variant)' }}>Suggestions</h3>
          {suggestions.map((s) => (
            <div key={s.user_id} className="flex items-center justify-between p-2 rounded-lg mb-1" style={{ background: 'var(--md-surface-container)' }}>
              <div>
                <span className="text-sm" style={{ color: 'var(--md-on-surface)' }}>{s.user_id.slice(0, 8)}</span>
                <span className="text-xs ml-2" style={{ color: 'var(--md-on-surface-variant)' }}>{s.mutual_friend_ids.length} mutual</span>
              </div>
              <button onClick={() => addFriend(s.user_id)} className="px-2 py-1 text-xs rounded" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>Add</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
