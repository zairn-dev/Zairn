import { useState, useEffect, useCallback } from 'react'
import { useSdk } from '@/contexts/SdkContext'
import { useAuth } from '@/contexts/AuthContext'
import type { Profile, LocationReaction } from '@zen-map/sdk'
import { formatRelativeTime } from '@/utils/format'

const EMOJIS = ['\u{1F44B}', '\u{1F525}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F389}', '\u{1F440}', '\u{1F4AF}', '\u{1F64C}']

type Tab = 'send' | 'received'

export default function ReactionPanel() {
  const sdk = useSdk()
  const { user } = useAuth()
  const [tab, setTab] = useState<Tab>('send')
  const [toast, setToast] = useState('')

  useEffect(() => {
    const ch = sdk.subscribeReactions((r: LocationReaction) => {
      if (r.to_user_id === user?.id) {
        setToast(`${r.emoji} from ${r.from_user_id.slice(0, 6)}`)
        setTimeout(() => setToast(''), 3000)
      }
    })
    return () => { ch.unsubscribe() }
  }, [sdk, user])

  return (
    <div className="flex flex-col h-full">
      {toast && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-lg text-sm text-center animate-pulse" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>
          {toast}
        </div>
      )}
      <div className="flex" style={{ borderBottom: '1px solid var(--md-outline-variant)' }}>
        {(['send', 'received'] as Tab[]).map((t) => (
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
        {tab === 'send' ? <SendTab sdk={sdk} /> : <ReceivedTab sdk={sdk} userId={user?.id ?? ''} />}
      </div>
    </div>
  )
}

function SendTab({ sdk }: { sdk: any }) {
  const [friends, setFriends] = useState<Profile[]>([])
  const [selectedFriend, setSelectedFriend] = useState<string | null>(null)
  const [selectedEmoji, setSelectedEmoji] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  useEffect(() => {
    sdk.getFriends().then(async (ids: string[]) => {
      const profiles = await Promise.all(ids.map(async (id: string) => {
        const p = await sdk.getProfile(id)
        return p ?? { user_id: id, username: null, display_name: null, avatar_url: null, status_emoji: null, status_text: null, status_expires_at: null, created_at: '', updated_at: '' } as Profile
      }))
      setFriends(profiles)
      setLoading(false)
    }).catch((e: any) => { setError(e.message); setLoading(false) })
  }, [sdk])

  const send = async () => {
    if (!selectedFriend || !selectedEmoji) return
    setSending(true)
    setError('')
    setSuccess('')
    try {
      await sdk.sendReaction(selectedFriend, selectedEmoji, message || undefined)
      setSuccess('Sent!')
      setSelectedEmoji(null)
      setMessage('')
      setTimeout(() => setSuccess(''), 2000)
    } catch (e: any) {
      setError(e.message ?? 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  if (loading) return <p className="text-sm text-center py-4" style={{ color: 'var(--md-on-surface-variant)' }}>Loading...</p>

  return (
    <div className="space-y-4">
      {error && <p className="text-xs" style={{ color: 'var(--md-error)' }}>{error}</p>}
      {success && <p className="text-xs" style={{ color: '#22c55e' }}>{success}</p>}
      <div>
        <p className="text-xs mb-1" style={{ color: 'var(--md-on-surface-variant)' }}>Select friend</p>
        <div className="flex flex-wrap gap-1">
          {friends.map((f) => {
            const name = f.display_name || f.user_id.slice(0, 8)
            return (
              <button
                key={f.user_id}
                onClick={() => setSelectedFriend(f.user_id)}
                className="px-2 py-1 text-xs rounded-full transition-colors"
                style={selectedFriend === f.user_id
                  ? { background: 'var(--md-primary)', color: 'var(--md-on-primary)' }
                  : { background: 'var(--md-surface-container)', color: 'var(--md-on-surface-variant)' }}
              >
                {name}
              </button>
            )
          })}
          {!friends.length && <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>No friends</p>}
        </div>
      </div>
      <div>
        <p className="text-xs mb-1" style={{ color: 'var(--md-on-surface-variant)' }}>Pick emoji</p>
        <div className="grid grid-cols-4 gap-2">
          {EMOJIS.map((e) => (
            <button
              key={e}
              onClick={() => setSelectedEmoji(e)}
              className="text-2xl p-2 rounded-lg transition-colors"
              style={selectedEmoji === e
                ? { background: 'var(--md-surface-container-high)', outline: '2px solid var(--md-primary)' }
                : { background: 'var(--md-surface-container)' }}
            >
              {e}
            </button>
          ))}
        </div>
      </div>
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Optional message..."
        className="w-full px-3 py-2 rounded-lg text-sm outline-none"
        style={{ background: 'var(--md-surface-container)', color: 'var(--md-on-surface)', }}
      />
      <button
        onClick={send}
        disabled={!selectedFriend || !selectedEmoji || sending}
        className="w-full py-2 rounded-lg text-sm font-medium disabled:opacity-40"
        style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}
      >
        {sending ? 'Sending...' : 'Send Reaction'}
      </button>
    </div>
  )
}

function ReceivedTab({ sdk, userId }: { sdk: any; userId: string }) {
  const [received, setReceived] = useState<LocationReaction[]>([])
  const [sent, setSent] = useState<LocationReaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      sdk.getReceivedReactions({ limit: 20 }),
      sdk.getSentReactions({ limit: 20 }),
    ]).then(([r, s]) => {
      if (!cancelled) { setReceived(r); setSent(s) }
    }).catch((e: any) => {
      if (!cancelled) setError(e.message)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [sdk])

  if (loading) return <p className="text-sm text-center py-4" style={{ color: 'var(--md-on-surface-variant)' }}>Loading...</p>
  if (error) return <p className="text-xs text-center py-4" style={{ color: 'var(--md-error)' }}>{error}</p>

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--md-on-surface-variant)' }}>Received</h3>
        {received.length === 0 && <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>None yet</p>}
        {received.map((r) => (
          <ReactionRow key={r.id} emoji={r.emoji} userId={r.from_user_id} message={r.message} time={r.created_at} />
        ))}
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase mb-2" style={{ color: 'var(--md-on-surface-variant)' }}>Sent</h3>
        {sent.length === 0 && <p className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>None yet</p>}
        {sent.map((r) => (
          <ReactionRow key={r.id} emoji={r.emoji} userId={r.to_user_id} message={r.message} time={r.created_at} />
        ))}
      </div>
    </div>
  )
}

function ReactionRow({ emoji, userId, message, time }: { emoji: string; userId: string; message: string | null; time: string }) {
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg mb-1" style={{ background: 'var(--md-surface-container)' }}>
      <span className="text-xl">{emoji}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate" style={{ color: 'var(--md-on-surface)' }}>{userId.slice(0, 8)}</p>
        {message && <p className="text-xs truncate" style={{ color: 'var(--md-on-surface-variant)' }}>{message}</p>}
      </div>
      <span className="text-[10px]" style={{ color: 'var(--md-on-surface-variant)' }}>{formatRelativeTime(time)}</span>
    </div>
  )
}
