import { useState, useEffect, useCallback, useRef } from 'react'
import { useSdk } from '@/contexts/SdkContext'
import { useAuth } from '@/contexts/AuthContext'
import type { ChatRoom, Message, Profile } from '@zen-map/sdk'
import { formatRelativeTime } from '@/utils/format'

interface ChatPanelProps {
  initialFriendId?: string
}

export default function ChatPanel({ initialFriendId }: ChatPanelProps) {
  const sdk = useSdk()
  const { user } = useAuth()
  const [activeRoom, setActiveRoom] = useState<string | null>(null)
  const [initDone, setInitDone] = useState(!initialFriendId)

  useEffect(() => {
    if (!initialFriendId) return
    let cancelled = false
    sdk.getOrCreateDirectChat(initialFriendId).then((room) => {
      if (!cancelled) { setActiveRoom(room.id); setInitDone(true) }
    }).catch(() => setInitDone(true))
    return () => { cancelled = true }
  }, [sdk, initialFriendId])

  if (!initDone) return <p className="text-sm text-center py-8" style={{ color: 'var(--md-on-surface-variant)' }}>Opening chat...</p>

  if (activeRoom) {
    return <ThreadView sdk={sdk} userId={user?.id ?? ''} roomId={activeRoom} onBack={() => setActiveRoom(null)} />
  }
  return <RoomList sdk={sdk} userId={user?.id ?? ''} onSelectRoom={setActiveRoom} />
}

function RoomList({ sdk, userId, onSelectRoom }: { sdk: any; userId: string; onSelectRoom: (id: string) => void }) {
  const [rooms, setRooms] = useState<(ChatRoom & { preview?: string; otherName?: string })[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const raw: ChatRoom[] = await sdk.getChatRooms()
        const enriched = await Promise.all(
          raw.map(async (room) => {
            let otherName = 'Chat'
            let preview = ''
            try {
              const members: string[] = await sdk.getChatRoomMembers(room.id)
              const otherId = members.find((m: string) => m !== userId)
              if (otherId) {
                const p: Profile | null = await sdk.getProfile(otherId)
                otherName = p?.display_name || otherId.slice(0, 8)
              }
            } catch {}
            try {
              const msgs: Message[] = await sdk.getMessages(room.id, { limit: 1 })
              if (msgs.length) preview = msgs[0].content ?? ''
            } catch {}
            return { ...room, otherName, preview }
          }),
        )
        if (!cancelled) setRooms(enriched)
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Failed to load rooms')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [sdk, userId])

  if (loading) return <p className="text-sm text-center py-8" style={{ color: 'var(--md-on-surface-variant)' }}>Loading rooms...</p>
  if (error) return <p className="text-sm text-center py-4" style={{ color: 'var(--md-error)' }}>{error}</p>
  if (!rooms.length) return <p className="text-sm text-center py-8" style={{ color: 'var(--md-on-surface-variant)' }}>No conversations yet</p>

  return (
    <ul className="space-y-1 p-3">
      {rooms.map((room) => (
        <li key={room.id}>
          <button
            onClick={() => onSelectRoom(room.id)}
            className="w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left"
            style={{ background: 'var(--md-surface-container)' }}
          >
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
              {(room.otherName ?? '?')[0]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: 'var(--md-on-surface)' }}>{room.otherName}</p>
              {room.preview && <p className="text-xs truncate" style={{ color: 'var(--md-on-surface-variant)' }}>{room.preview}</p>}
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ThreadView({ sdk, userId, roomId, onBack }: { sdk: any; userId: string; roomId: string; onBack: () => void }) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const [profiles, setProfiles] = useState<Record<string, Profile>>({})

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const msgs: Message[] = await sdk.getMessages(roomId, { limit: 50 })
        if (!cancelled) {
          setMessages(msgs.reverse())
          sdk.markAsRead(roomId).catch(() => {})
        }
        const senderIds = [...new Set(msgs.map((m) => m.sender_id))]
        const profs: Record<string, Profile> = {}
        await Promise.all(
          senderIds.map(async (id) => {
            try {
              const p = await sdk.getProfile(id)
              if (p) profs[id] = p
            } catch {}
          }),
        )
        if (!cancelled) setProfiles(profs)
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Failed to load messages')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [sdk, roomId])

  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  useEffect(() => {
    const ch = sdk.subscribeMessages(roomId, (msg: Message) => {
      setMessages((prev) => [...prev, msg])
      sdk.markAsRead(roomId).catch(() => {})
    })
    return () => { ch.unsubscribe() }
  }, [sdk, roomId])

  const send = async () => {
    const text = input.trim()
    if (!text) return
    setSending(true)
    setError('')
    try {
      await sdk.sendMessage(roomId, text)
      setInput('')
    } catch (e: any) {
      setError(e.message ?? 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-3" style={{ borderBottom: '1px solid var(--md-outline-variant)' }}>
        <button onClick={onBack} className="text-sm" style={{ color: 'var(--md-on-surface-variant)' }}>&larr; Back</button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading && <p className="text-sm text-center" style={{ color: 'var(--md-on-surface-variant)' }}>Loading...</p>}
        {error && <p className="text-xs text-center" style={{ color: 'var(--md-error)' }}>{error}</p>}
        {messages.map((m) => {
          const mine = m.sender_id === userId
          const name = profiles[m.sender_id]?.display_name || m.sender_id.slice(0, 6)
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className="max-w-[75%] px-3 py-2 rounded-xl text-sm"
                style={mine
                  ? { background: 'var(--md-primary)', color: 'var(--md-on-primary)' }
                  : { background: 'var(--md-surface-container)', color: 'var(--md-on-surface)' }}
              >
                {!mine && <p className="text-[10px] mb-0.5" style={{ color: 'var(--md-on-surface-variant)' }}>{name}</p>}
                <p>{m.content}</p>
                <p className="text-[10px] mt-0.5 text-right" style={{ color: mine ? 'var(--md-on-primary)' : 'var(--md-on-surface-variant)', opacity: mine ? 0.7 : 1 }}>{formatRelativeTime(m.created_at)}</p>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
      <div className="flex gap-2 p-3" style={{ borderTop: '1px solid var(--md-outline-variant)' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
          placeholder="Type a message..."
          className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
          style={{ background: 'var(--md-surface-container)', color: 'var(--md-on-surface)' }}
        />
        <button onClick={send} disabled={sending || !input.trim()} className="px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-40" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>
          {sending ? '...' : 'Send'}
        </button>
      </div>
    </div>
  )
}
