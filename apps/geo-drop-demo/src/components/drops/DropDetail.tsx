import { useEffect, useState } from 'react'
import { useGeoDrop } from '@/contexts/GeoDropContext'
import type { GeoDrop, DropContentType, ProofMethodType } from '@zairn/geo-drop'

interface DropDetailProps {
  dropId: string
  distance: number
  canUnlock: boolean
  currentLocation: { lat: number; lon: number; accuracy: number } | null
  onClose: () => void
}

export default function DropDetail({
  dropId,
  distance,
  canUnlock,
  currentLocation,
  onClose,
}: DropDetailProps) {
  const { sdk } = useGeoDrop()
  const [drop, setDrop] = useState<GeoDrop | null>(null)
  const [loading, setLoading] = useState(true)
  const [unlocking, setUnlocking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [unlockedContent, setUnlockedContent] = useState<string | null>(null)
  const [stepUp, setStepUp] = useState<{
    reason: string
    availableMethods: ProofMethodType[]
    trustScore: number
  } | null>(null)
  const [secretInput, setSecretInput] = useState('')

  useEffect(() => {
    let cancelled = false
    const fetchDrop = async () => {
      try {
        const data = await sdk.getDrop(dropId)
        if (!cancelled) setDrop(data)
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load drop')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchDrop()
    return () => { cancelled = true }
  }, [sdk, dropId])

  const handleUnlock = async (extraProofs?: { method: ProofMethodType; data: Record<string, unknown> }[]) => {
    if (!currentLocation) return
    setUnlocking(true)
    setError(null)

    try {
      const result = await sdk.unlockDrop(
        dropId,
        currentLocation.lat,
        currentLocation.lon,
        currentLocation.accuracy,
        drop?.visibility === 'password' ? password : undefined,
        extraProofs,
      )
      if (result.type === 'step-up-required') {
        setStepUp({
          reason: result.reason,
          availableMethods: result.availableMethods,
          trustScore: result.trustScore,
        })
      } else {
        setUnlockedContent(result.content)
        setStepUp(null)
      }
    } catch (err: any) {
      setError(err?.message ?? 'Failed to unlock drop')
    } finally {
      setUnlocking(false)
    }
  }

  const handleStepUpSubmit = (method: ProofMethodType) => {
    if (method === 'secret') {
      if (!secretInput.trim()) return
      handleUnlock([{ method: 'secret', data: { secret: secretInput.trim() } }])
    }
    // Future: AR (camera capture), ZKP (proof generation)
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 60,
        transform: 'translateY(0)',
        transition: 'transform 0.3s ease-out',
      }}
    >
      {/* Scrim */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--md-scrim)',
          zIndex: -1,
        }}
      />

      {/* Sheet */}
      <div
        style={{
          background: 'var(--md-surface)',
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          padding: '24px 20px',
          maxHeight: '80vh',
          overflowY: 'auto',
          boxShadow: '0 -4px 24px var(--md-shadow)',
        }}
      >
        {/* Handle */}
        <div
          style={{
            width: 40,
            height: 4,
            borderRadius: 2,
            background: 'var(--md-outline-variant)',
            margin: '0 auto 16px',
          }}
        />

        {loading && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: '24px 0',
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                border: '3px solid var(--md-primary)',
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
          </div>
        )}

        {!loading && drop && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Title */}
            <h2
              style={{
                margin: 0,
                fontSize: '1.25rem',
                fontWeight: 600,
                color: 'var(--md-on-surface)',
              }}
            >
              {drop.title}
            </h2>

            {/* Meta info */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <span
                style={{
                  padding: '4px 10px',
                  borderRadius: 8,
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  background: 'var(--md-secondary-container)',
                  color: 'var(--md-on-secondary-container)',
                }}
              >
                {drop.content_type}
              </span>
              <span
                style={{
                  padding: '4px 10px',
                  borderRadius: 8,
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  background: 'var(--md-tertiary-container)',
                  color: 'var(--md-on-tertiary-container)',
                }}
              >
                {drop.visibility}
              </span>
            </div>

            {/* Details */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                fontSize: '0.85rem',
                color: 'var(--md-on-surface-variant)',
              }}
            >
              {drop.description && <p style={{ margin: 0 }}>{drop.description}</p>}
              <p style={{ margin: 0 }}>Distance: {distance}m</p>
              <p style={{ margin: 0 }}>Claims: {drop.claim_count}</p>
              <p style={{ margin: 0 }}>Created: {formatDate(drop.created_at)}</p>
            </div>

            {/* Error */}
            {error && (
              <div
                style={{
                  background: 'var(--md-error-container)',
                  color: 'var(--md-on-error-container)',
                  padding: '10px 14px',
                  borderRadius: 12,
                  fontSize: '0.85rem',
                }}
              >
                {error}
              </div>
            )}

            {/* Step-up verification */}
            {stepUp && (
              <div
                style={{
                  background: 'var(--md-tertiary-container)',
                  color: 'var(--md-on-tertiary-container)',
                  padding: '14px 16px',
                  borderRadius: 16,
                }}
              >
                <div
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    marginBottom: 6,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  Additional Verification Required
                </div>
                <p style={{ margin: '0 0 10px', fontSize: '0.85rem', lineHeight: 1.4 }}>
                  {stepUp.reason}
                </p>
                <p style={{ margin: '0 0 10px', fontSize: '0.75rem', opacity: 0.8 }}>
                  Trust score: {(stepUp.trustScore * 100).toFixed(0)}%
                </p>

                {stepUp.availableMethods.includes('secret') && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input
                      type="text"
                      placeholder="Enter secret code (QR / NFC)"
                      value={secretInput}
                      onChange={(e) => setSecretInput(e.target.value)}
                      style={{
                        flex: 1,
                        padding: '10px 14px',
                        borderRadius: 12,
                        border: '1px solid var(--md-outline-variant)',
                        background: 'var(--md-surface-container)',
                        color: 'var(--md-on-surface)',
                        fontSize: '0.85rem',
                        outline: 'none',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => handleStepUpSubmit('secret')}
                      disabled={unlocking || !secretInput.trim()}
                      style={{
                        padding: '10px 16px',
                        borderRadius: 12,
                        border: 'none',
                        background: 'var(--md-tertiary)',
                        color: 'var(--md-on-tertiary)',
                        fontSize: '0.85rem',
                        fontWeight: 500,
                        cursor: unlocking ? 'not-allowed' : 'pointer',
                        opacity: unlocking ? 0.5 : 1,
                      }}
                    >
                      Verify
                    </button>
                  </div>
                )}

                {stepUp.availableMethods.includes('ar') && (
                  <p style={{ margin: '8px 0 0', fontSize: '0.8rem', fontStyle: 'italic' }}>
                    AR verification: camera capture coming soon
                  </p>
                )}

                {stepUp.availableMethods.includes('zkp') && (
                  <p style={{ margin: '8px 0 0', fontSize: '0.8rem', fontStyle: 'italic' }}>
                    ZKP verification: proof generation coming soon
                  </p>
                )}
              </div>
            )}

            {/* Unlocked content */}
            {unlockedContent !== null && (
              <div
                style={{
                  background: 'var(--md-primary-container)',
                  color: 'var(--md-on-primary-container)',
                  padding: '14px 16px',
                  borderRadius: 16,
                  fontSize: '0.95rem',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                <div
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    marginBottom: 6,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  Unlocked Content
                </div>
                <UnlockedMedia content={unlockedContent} contentType={drop.content_type} />
              </div>
            )}

            {/* Password input for password-protected drops */}
            {unlockedContent === null && drop.visibility === 'password' && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span
                  style={{
                    fontSize: '0.8rem',
                    fontWeight: 500,
                    color: 'var(--md-on-surface-variant)',
                  }}
                >
                  Password
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter the drop password"
                  style={{
                    padding: '10px 14px',
                    borderRadius: 12,
                    border: '1px solid var(--md-outline-variant)',
                    background: 'var(--md-surface-container)',
                    color: 'var(--md-on-surface)',
                    fontSize: '0.95rem',
                    outline: 'none',
                  }}
                />
              </label>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1,
                  padding: '12px 0',
                  borderRadius: 16,
                  border: '1px solid var(--md-outline-variant)',
                  background: 'transparent',
                  color: 'var(--md-on-surface)',
                  fontSize: '0.95rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
              {unlockedContent === null && (
                <button
                  type="button"
                  onClick={() => handleUnlock()}
                  disabled={!canUnlock || !currentLocation || unlocking}
                  style={{
                    flex: 1,
                    padding: '12px 0',
                    borderRadius: 16,
                    border: 'none',
                    background: 'var(--md-primary)',
                    color: 'var(--md-on-primary)',
                    fontSize: '0.95rem',
                    fontWeight: 500,
                    cursor: !canUnlock || !currentLocation || unlocking ? 'not-allowed' : 'pointer',
                    opacity: !canUnlock || !currentLocation || unlocking ? 0.5 : 1,
                  }}
                >
                  {unlocking ? 'Unlocking...' : canUnlock ? 'Unlock' : 'Too far away'}
                </button>
              )}
            </div>
          </div>
        )}

        {!loading && !drop && (
          <p
            style={{
              textAlign: 'center',
              color: 'var(--md-on-surface-variant)',
              padding: '24px 0',
            }}
          >
            Drop not found
          </p>
        )}
      </div>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}

function UnlockedMedia({ content, contentType }: { content: string; contentType: DropContentType }) {
  // data URI content (base64 encoded files)
  const isDataUri = content.startsWith('data:')

  if (contentType === 'image' && isDataUri) {
    return (
      <img
        src={content}
        alt="Unlocked image"
        style={{ maxWidth: '100%', borderRadius: 12, marginTop: 4 }}
      />
    )
  }

  if (contentType === 'audio' && isDataUri) {
    return (
      <audio controls src={content} style={{ width: '100%', marginTop: 4 }} />
    )
  }

  if (contentType === 'video' && isDataUri) {
    return (
      <video
        controls
        src={content}
        style={{ maxWidth: '100%', borderRadius: 12, marginTop: 4 }}
      />
    )
  }

  if ((contentType === 'file' || contentType === 'image' || contentType === 'audio' || contentType === 'video') && isDataUri) {
    return (
      <a
        href={content}
        download="drop-content"
        style={{
          display: 'inline-block',
          marginTop: 4,
          padding: '8px 16px',
          borderRadius: 12,
          background: 'var(--md-primary)',
          color: 'var(--md-on-primary)',
          textDecoration: 'none',
          fontSize: '0.85rem',
          fontWeight: 500,
        }}
      >
        Download File
      </a>
    )
  }

  // Plain text fallback
  return <>{content}</>
}
