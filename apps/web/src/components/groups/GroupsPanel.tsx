import { useState, useEffect } from 'react'
import { useSdk } from '@/contexts/SdkContext'
import { useAuth } from '@/contexts/AuthContext'
import type { Group, GroupMember, Profile } from '@zairn/sdk'

export default function GroupsPanel() {
  const core = useSdk()
  const { user } = useAuth()

  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [showCreate, setShowCreate] = useState(false)

  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [memberProfiles, setMemberProfiles] = useState<Record<string, Profile | null>>({})
  const [loadingMembers, setLoadingMembers] = useState(false)

  useEffect(() => {
    loadGroups()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core])

  async function loadGroups() {
    try {
      setLoading(true)
      setError('')
      const g = await core.getGroups()
      setGroups(g)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return
    try {
      setError('')
      await core.createGroup(newName.trim(), newDesc.trim() || undefined)
      setNewName('')
      setNewDesc('')
      setShowCreate(false)
      await loadGroups()
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleJoin() {
    if (!joinCode.trim()) return
    try {
      setError('')
      await core.joinGroup(joinCode.trim())
      setJoinCode('')
      await loadGroups()
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function selectGroup(group: Group) {
    setSelectedGroup(group)
    setLoadingMembers(true)
    try {
      const m = await core.getGroupMembers(group.id)
      setMembers(m)
      const profiles: Record<string, Profile | null> = {}
      for (const member of m) {
        profiles[member.user_id] = await core.getProfile(member.user_id)
      }
      setMemberProfiles(profiles)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoadingMembers(false)
    }
  }

  async function handleLeave(groupId: string) {
    if (!confirm('Leave this group?')) return
    try {
      await core.leaveGroup(groupId)
      setSelectedGroup(null)
      await loadGroups()
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleDelete(groupId: string) {
    if (!confirm('Delete this group? This cannot be undone.')) return
    try {
      await core.deleteGroup(groupId)
      setSelectedGroup(null)
      await loadGroups()
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function handleOpenChat(groupId: string) {
    try {
      await core.getOrCreateGroupChat(groupId)
      // Chat opening would be handled by parent navigation
    } catch (e: any) {
      setError(e.message)
    }
  }

  if (loading) return <div className="p-4 text-center" style={{ color: 'var(--md-on-surface-variant)' }}>Loading groups...</div>

  // Group detail view
  if (selectedGroup) {
    const isOwner = selectedGroup.owner_id === user?.id
    return (
      <div className="flex flex-col gap-4">
        <button onClick={() => setSelectedGroup(null)} className="text-sm hover:underline self-start" style={{ color: 'var(--md-primary)' }}>
          &larr; Back to groups
        </button>
        {error && <div className="text-sm" style={{ color: 'var(--md-error)' }}>{error}</div>}

        <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
          <h3 className="text-lg font-semibold" style={{ color: 'var(--md-on-surface)' }}>{selectedGroup.name}</h3>
          {selectedGroup.description && <p className="text-sm mt-1" style={{ color: 'var(--md-on-surface-variant)' }}>{selectedGroup.description}</p>}
          {selectedGroup.invite_code && (
            <p className="text-xs mt-2" style={{ color: 'var(--md-on-surface-variant)' }}>Invite code: <span className="font-mono" style={{ color: 'var(--md-on-surface)' }}>{selectedGroup.invite_code}</span></p>
          )}
        </div>

        <div className="rounded-lg p-4" style={{ background: 'var(--md-surface-container)' }}>
          <h4 className="text-sm font-semibold uppercase mb-3" style={{ color: 'var(--md-on-surface-variant)' }}>
            Members ({members.length})
          </h4>
          {loadingMembers ? (
            <p className="text-sm" style={{ color: 'var(--md-on-surface-variant)' }}>Loading...</p>
          ) : (
            <div className="flex flex-col gap-2">
              {members.map(m => {
                const p = memberProfiles[m.user_id]
                return (
                  <div key={m.user_id} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
                        {p?.display_name?.[0]?.toUpperCase() ?? '?'}
                      </div>
                      <span style={{ color: 'var(--md-on-surface)' }}>{p?.display_name ?? m.user_id.slice(0, 8)}</span>
                    </div>
                    <span className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>{m.role}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <button onClick={() => handleOpenChat(selectedGroup.id)}
            className="w-full py-2 rounded text-sm" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>
            Open Group Chat
          </button>
          <button onClick={() => handleLeave(selectedGroup.id)}
            className="w-full py-2 rounded text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
            Leave Group
          </button>
          {isOwner && (
            <button onClick={() => handleDelete(selectedGroup.id)}
              className="w-full py-2 rounded text-sm" style={{ background: 'var(--md-error)', color: 'var(--md-on-primary)' }}>
              Delete Group
            </button>
          )}
        </div>
      </div>
    )
  }

  // Group list view
  return (
    <div className="flex flex-col gap-4">
      {error && <div className="text-sm" style={{ color: 'var(--md-error)' }}>{error}</div>}

      {/* Join by code */}
      <div className="flex gap-2">
        <input value={joinCode} onChange={e => setJoinCode(e.target.value)} placeholder="Invite code"
          className="flex-1 rounded px-3 py-1.5 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} />
        <button onClick={handleJoin} className="px-3 py-1.5 rounded text-sm" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>
          Join
        </button>
      </div>

      {/* Create group */}
      {showCreate ? (
        <div className="rounded-lg p-4 flex flex-col gap-2" style={{ background: 'var(--md-surface-container)' }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Group name"
            className="rounded px-3 py-1.5 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} />
          <input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Description (optional)"
            className="rounded px-3 py-1.5 text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }} />
          <div className="flex gap-2">
            <button onClick={handleCreate} className="px-3 py-1.5 rounded text-sm" style={{ background: 'var(--md-primary)', color: 'var(--md-on-primary)' }}>
              Create
            </button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 rounded text-sm" style={{ background: 'var(--md-surface-container-high)', color: 'var(--md-on-surface)' }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowCreate(true)} className="w-full py-2 rounded text-sm" style={{ background: 'var(--md-surface-container)', color: 'var(--md-primary)' }}>
          + Create Group
        </button>
      )}

      {/* Groups list */}
      {groups.length === 0 ? (
        <p className="text-sm text-center py-4" style={{ color: 'var(--md-on-surface-variant)' }}>No groups yet</p>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map(g => (
            <button key={g.id} onClick={() => selectGroup(g)}
              className="w-full text-left rounded-lg p-3" style={{ background: 'var(--md-surface-container)' }}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium" style={{ color: 'var(--md-on-surface)' }}>{g.name}</span>
                <span className="text-xs" style={{ color: 'var(--md-on-surface-variant)' }}>&rarr;</span>
              </div>
              {g.description && <p className="text-xs mt-1 truncate" style={{ color: 'var(--md-on-surface-variant)' }}>{g.description}</p>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
