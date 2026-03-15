import { useState, useCallback, useRef } from 'react'
import { useSdk } from '@/contexts/SdkContext'
import { useAuth } from '@/contexts/AuthContext'

interface OnboardingFlowProps {
  onComplete: () => void
}

type Step = 'welcome' | 'profile' | 'location' | 'friends' | 'done'

const STEPS: Step[] = ['welcome', 'profile', 'location', 'friends', 'done']

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const sdk = useSdk()
  const { user } = useAuth()
  const [step, setStep] = useState<Step>('welcome')
  const [displayName, setDisplayName] = useState('')
  const [statusEmoji, setStatusEmoji] = useState('')
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [locationGranted, setLocationGranted] = useState(false)
  const [friendSearch, setFriendSearch] = useState('')
  const [friendResults, setFriendResults] = useState<any[]>([])
  const [sentRequests, setSentRequests] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const stepIdx = STEPS.indexOf(step)
  const progress = ((stepIdx + 1) / STEPS.length) * 100

  const next = useCallback(() => {
    const idx = STEPS.indexOf(step)
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1])
  }, [step])

  const back = useCallback(() => {
    const idx = STEPS.indexOf(step)
    if (idx > 0) setStep(STEPS[idx - 1])
  }, [step])

  // ─── Step: Profile ──────────────────────

  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setAvatarFile(file)
    const reader = new FileReader()
    reader.onload = () => setAvatarPreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  const saveProfile = async () => {
    setSaving(true)
    try {
      if (displayName.trim()) {
        await sdk.updateProfile({ display_name: displayName.trim() })
      }
      if (statusEmoji) {
        await sdk.setStatus(statusEmoji)
      }
      if (avatarFile) {
        await sdk.uploadAvatar(avatarFile)
      }
      next()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setSaving(false)
    }
  }

  // ─── Step: Location ─────────────────────

  const requestLocation = async () => {
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        })
      })
      await sdk.sendLocation({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      })
      setLocationGranted(true)
    } catch {
      // User denied or error — that's fine, skip
    }
  }

  // ─── Step: Friends ──────────────────────

  const searchFriends = async () => {
    if (!friendSearch.trim()) return
    try {
      const results = await sdk.searchProfiles(friendSearch.trim())
      setFriendResults(results.filter((p: any) => p.user_id !== user?.id))
    } catch {
      setFriendResults([])
    }
  }

  const sendRequest = async (userId: string) => {
    try {
      await sdk.sendFriendRequest(userId)
      setSentRequests(prev => new Set(prev).add(userId))
    } catch (e: any) {
      alert(e.message)
    }
  }

  // ─── Step: Done ─────────────────────────

  const finish = () => {
    localStorage.setItem(`zairn:onboarded:${user?.id}`, '1')
    onComplete()
  }

  // ─── Common emoji picker (simple) ──────

  const EMOJIS = ['😊', '🔥', '💜', '🌍', '🎯', '🚀', '🎵', '📍', '⚡', '🌸']

  return (
    <div style={containerStyle}>
      {/* Progress bar */}
      <div style={{ height: 3, background: 'var(--md-surface-container)' }}>
        <div style={{
          height: '100%', width: `${progress}%`,
          background: 'var(--md-primary)', transition: 'width 0.3s ease',
        }} />
      </div>

      <div style={contentStyle}>
        {/* ─── Welcome ─── */}
        {step === 'welcome' && (
          <div style={stepStyle}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🗺</div>
            <h1 style={{ fontSize: 28, marginBottom: 8 }}>Welcome to Zairn</h1>
            <p style={subtitleStyle}>
              Share your location with friends you trust.
              <br />No one else can see where you are.
            </p>
            <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ fontSize: 14, color: 'var(--md-on-surface-variant)' }}>
                Let's set up your profile in a few quick steps.
              </p>
              <button onClick={next} style={primaryBtnStyle}>Get Started</button>
            </div>
          </div>
        )}

        {/* ─── Profile ─── */}
        {step === 'profile' && (
          <div style={stepStyle}>
            <h2 style={{ fontSize: 22, marginBottom: 4 }}>Your Profile</h2>
            <p style={subtitleStyle}>How should your friends see you?</p>

            {/* Avatar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, margin: '24px 0' }}>
              <div
                onClick={() => fileRef.current?.click()}
                style={{
                  width: 72, height: 72, borderRadius: '50%', cursor: 'pointer',
                  background: avatarPreview ? `url(${avatarPreview}) center/cover` : 'var(--md-surface-container)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '2px dashed var(--md-outline)',
                  fontSize: 28, color: 'var(--md-on-surface-variant)',
                }}
              >
                {!avatarPreview && '+'}
              </div>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleAvatarSelect} />
              <span style={{ fontSize: 14, color: 'var(--md-on-surface-variant)' }}>Tap to add a photo</span>
            </div>

            {/* Display name */}
            <label style={labelStyle}>
              Display Name
              <input
                type="text" placeholder="Your name"
                value={displayName} onChange={e => setDisplayName(e.target.value)}
                style={inputStyle}
              />
            </label>

            {/* Status emoji */}
            <label style={labelStyle}>
              Status Emoji (optional)
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                {EMOJIS.map(e => (
                  <button
                    key={e}
                    onClick={() => setStatusEmoji(statusEmoji === e ? '' : e)}
                    style={{
                      width: 40, height: 40, fontSize: 20, border: 'none', borderRadius: 8,
                      background: statusEmoji === e ? 'var(--md-primary-container)' : 'var(--md-surface-container)',
                      cursor: 'pointer',
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </label>

            <div style={btnRowStyle}>
              <button onClick={back} style={secondaryBtnStyle}>Back</button>
              <button onClick={saveProfile} disabled={saving} style={primaryBtnStyle}>
                {saving ? 'Saving...' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {/* ─── Location ─── */}
        {step === 'location' && (
          <div style={stepStyle}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>📍</div>
            <h2 style={{ fontSize: 22, marginBottom: 4 }}>Share Your Location</h2>
            <p style={subtitleStyle}>
              Your location is only shared with friends you approve.
              <br />You can turn it off anytime with Ghost Mode.
            </p>

            <div style={{ margin: '24px 0' }}>
              {locationGranted ? (
                <div style={{
                  padding: 16, borderRadius: 12,
                  background: 'var(--md-primary-container)',
                  color: 'var(--md-on-primary-container)',
                  textAlign: 'center',
                }}>
                  Location shared! Your friends will see you on the map.
                </div>
              ) : (
                <button onClick={requestLocation} style={{
                  ...primaryBtnStyle, width: '100%', padding: 16,
                }}>
                  Enable Location Sharing
                </button>
              )}
            </div>

            <div style={btnRowStyle}>
              <button onClick={back} style={secondaryBtnStyle}>Back</button>
              <button onClick={next} style={primaryBtnStyle}>
                {locationGranted ? 'Continue' : 'Skip for now'}
              </button>
            </div>
          </div>
        )}

        {/* ─── Friends ─── */}
        {step === 'friends' && (
          <div style={stepStyle}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>👥</div>
            <h2 style={{ fontSize: 22, marginBottom: 4 }}>Find Friends</h2>
            <p style={subtitleStyle}>Search by name to add your first friend.</p>

            <div style={{ display: 'flex', gap: 8, margin: '24px 0 16px' }}>
              <input
                placeholder="Search by name..."
                value={friendSearch} onChange={e => setFriendSearch(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && searchFriends()}
                style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
              />
              <button onClick={searchFriends} style={{ ...primaryBtnStyle, padding: '8px 16px' }}>
                Search
              </button>
            </div>

            {friendResults.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {friendResults.map((p: any) => (
                  <div key={p.user_id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 12px', borderRadius: 8,
                    background: 'var(--md-surface-container)', marginBottom: 8,
                  }}>
                    <span>{p.display_name || p.username || p.user_id.slice(0, 8)}</span>
                    {sentRequests.has(p.user_id) ? (
                      <span style={{ fontSize: 13, color: 'var(--md-primary)' }}>Sent!</span>
                    ) : (
                      <button
                        onClick={() => sendRequest(p.user_id)}
                        style={{ ...primaryBtnStyle, padding: '4px 12px', fontSize: 13 }}
                      >
                        Add
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div style={btnRowStyle}>
              <button onClick={back} style={secondaryBtnStyle}>Back</button>
              <button onClick={next} style={primaryBtnStyle}>
                {sentRequests.size > 0 ? 'Continue' : 'Skip for now'}
              </button>
            </div>
          </div>
        )}

        {/* ─── Done ─── */}
        {step === 'done' && (
          <div style={stepStyle}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
            <h2 style={{ fontSize: 22, marginBottom: 4 }}>You're all set!</h2>
            <p style={subtitleStyle}>
              Your map is ready. Friends you add will appear here.
            </p>
            <div style={{ margin: '24px 0', padding: 16, borderRadius: 12, background: 'var(--md-surface-container)' }}>
              <p style={{ fontSize: 14, margin: 0, lineHeight: 1.6 }}>
                <strong>Quick tips:</strong><br />
                👻 Ghost Mode — hide your location anytime<br />
                📍 Favorite Places — mark home, work, school<br />
                💜 Reactions — send emoji pokes to friends<br />
                👊 Bump — detect friends nearby automatically
              </p>
            </div>
            <button onClick={finish} style={{ ...primaryBtnStyle, width: '100%', padding: 16 }}>
              Open Map
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Styles ───────────────────────────────────

const containerStyle: React.CSSProperties = {
  height: '100dvh', display: 'flex', flexDirection: 'column',
  background: 'var(--md-surface)',
}

const contentStyle: React.CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '24px 16px', overflow: 'auto',
}

const stepStyle: React.CSSProperties = {
  maxWidth: 400, width: '100%', textAlign: 'center',
}

const subtitleStyle: React.CSSProperties = {
  fontSize: 15, color: 'var(--md-on-surface-variant)', lineHeight: 1.5,
  margin: '0 0 8px',
}

const labelStyle: React.CSSProperties = {
  display: 'block', textAlign: 'left', fontSize: 14, marginBottom: 16,
  color: 'var(--md-on-surface-variant)',
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px', marginTop: 4, marginBottom: 12,
  border: '1px solid var(--md-outline)', borderRadius: 10,
  fontSize: 15, boxSizing: 'border-box', background: 'white',
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '12px 28px', border: 'none', borderRadius: 10,
  background: 'var(--md-primary)', color: 'var(--md-on-primary)',
  fontSize: 15, fontWeight: 600, cursor: 'pointer',
}

const secondaryBtnStyle: React.CSSProperties = {
  padding: '12px 28px', border: '1px solid var(--md-outline)', borderRadius: 10,
  background: 'transparent', color: 'var(--md-on-surface)',
  fontSize: 15, cursor: 'pointer',
}

const btnRowStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 24,
}
