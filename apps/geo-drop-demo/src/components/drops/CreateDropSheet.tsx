import { useState, useRef } from 'react'
import { useGeoDrop } from '@/contexts/GeoDropContext'
import type { DropVisibility, DropContentType } from '@zairn/geo-drop'

interface CreateDropSheetProps {
  location: { lat: number; lon: number }
  onClose: () => void
  onCreated: () => void
}

const CONTENT_TYPES: { value: DropContentType; label: string; accept: string }[] = [
  { value: 'text', label: 'Text', accept: '' },
  { value: 'image', label: 'Image', accept: 'image/*' },
  { value: 'audio', label: 'Audio', accept: 'audio/*' },
  { value: 'video', label: 'Video', accept: 'video/*' },
  { value: 'file', label: 'File', accept: '*/*' },
]

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function CreateDropSheet({
  location,
  onClose,
  onCreated,
}: CreateDropSheetProps) {
  const { sdk } = useGeoDrop()
  const [title, setTitle] = useState('')
  const [textContent, setTextContent] = useState('')
  const [contentType, setContentType] = useState<DropContentType>('text')
  const [file, setFile] = useState<File | null>(null)
  const [filePreview, setFilePreview] = useState<string | null>(null)
  const [visibility, setVisibility] = useState<DropVisibility>('public')
  const [password, setPassword] = useState('')
  const [unlockRadius, setUnlockRadius] = useState(50)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isFileType = contentType !== 'text'

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    if (f.type.startsWith('image/')) {
      setFilePreview(URL.createObjectURL(f))
    } else {
      setFilePreview(null)
    }
  }

  const handleContentTypeChange = (type: DropContentType) => {
    setContentType(type)
    setFile(null)
    setFilePreview(null)
    setTextContent('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const canSubmit = title.trim() && (isFileType ? !!file : !!textContent.trim())

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return

    setLoading(true)
    setError(null)

    try {
      let contentPayload: string
      if (isFileType && file) {
        // Encode file as data URI (base64) for encryption & storage
        contentPayload = await fileToBase64(file)
      } else {
        contentPayload = textContent
      }

      await sdk.createDrop(
        {
          title: title.trim(),
          description: '',
          content_type: contentType,
          lat: location.lat,
          lon: location.lon,
          visibility,
          password: visibility === 'password' ? password : undefined,
          unlock_radius_meters: unlockRadius,
        },
        contentPayload,
      )
      onCreated()
      onClose()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create drop')
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = {
    padding: '10px 14px',
    borderRadius: 12,
    border: '1px solid var(--md-outline-variant)',
    background: 'var(--md-surface-container)',
    color: 'var(--md-on-surface)',
    fontSize: '0.95rem',
    outline: 'none',
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

        <h2
          style={{
            margin: '0 0 16px',
            fontSize: '1.25rem',
            fontWeight: 600,
            color: 'var(--md-on-surface)',
          }}
        >
          Create Drop
        </h2>

        <p
          style={{
            margin: '0 0 16px',
            fontSize: '0.8rem',
            color: 'var(--md-on-surface-variant)',
          }}
        >
          {location.lat.toFixed(5)}, {location.lon.toFixed(5)}
        </p>

        {error && (
          <div
            style={{
              background: 'var(--md-error-container)',
              color: 'var(--md-on-error-container)',
              padding: '10px 14px',
              borderRadius: 12,
              fontSize: '0.85rem',
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Title */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>
              Title
            </span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Give your drop a name"
              required
              style={inputStyle}
            />
          </label>

          {/* Content Type Selector */}
          <div>
            <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--md-on-surface-variant)', display: 'block', marginBottom: 6 }}>
              Content Type
            </span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {CONTENT_TYPES.map((ct) => (
                <button
                  key={ct.value}
                  type="button"
                  onClick={() => handleContentTypeChange(ct.value)}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 20,
                    border: 'none',
                    fontSize: '0.8rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    background: contentType === ct.value ? 'var(--md-primary)' : 'var(--md-surface-container)',
                    color: contentType === ct.value ? 'var(--md-on-primary)' : 'var(--md-on-surface-variant)',
                  }}
                >
                  {ct.label}
                </button>
              ))}
            </div>
          </div>

          {/* Text Content */}
          {contentType === 'text' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>
                Content
              </span>
              <textarea
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                placeholder="What do you want to share?"
                required
                rows={3}
                style={{
                  ...inputStyle,
                  resize: 'vertical' as const,
                  fontFamily: 'inherit',
                }}
              />
            </label>
          )}

          {/* File Upload */}
          {isFileType && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>
                Upload {contentType === 'image' ? 'Image' : contentType === 'audio' ? 'Audio' : contentType === 'video' ? 'Video' : 'File'}
              </span>

              {/* Drop zone */}
              <div
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: '2px dashed var(--md-outline-variant)',
                  borderRadius: 16,
                  padding: file ? '12px' : '28px 14px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: 'var(--md-surface-container)',
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={CONTENT_TYPES.find(c => c.value === contentType)?.accept ?? '*/*'}
                  onChange={handleFileChange}
                  style={{ display: 'none' }}
                />

                {!file && (
                  <p style={{ margin: 0, color: 'var(--md-on-surface-variant)', fontSize: '0.85rem' }}>
                    Tap to select a file
                  </p>
                )}

                {file && (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                    {/* Image preview */}
                    {filePreview && (
                      <img
                        src={filePreview}
                        alt="Preview"
                        style={{
                          maxWidth: '100%',
                          maxHeight: 160,
                          borderRadius: 12,
                          objectFit: 'contain',
                        }}
                      />
                    )}
                    <div style={{ fontSize: '0.85rem', color: 'var(--md-on-surface)' }}>
                      {file.name}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--md-on-surface-variant)' }}>
                      {formatFileSize(file.size)} &middot; Tap to change
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Visibility */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>
              Visibility
            </span>
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as DropVisibility)}
              style={inputStyle}
            >
              <option value="public">Public</option>
              <option value="password">Password Protected</option>
            </select>
          </label>

          {/* Password (conditional) */}
          {visibility === 'password' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>
                Password
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Set a password"
                required
                style={inputStyle}
              />
            </label>
          )}

          {/* Unlock Radius */}
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 500, color: 'var(--md-on-surface-variant)' }}>
              Unlock Radius (meters)
            </span>
            <input
              type="number"
              value={unlockRadius}
              onChange={(e) => setUnlockRadius(Number(e.target.value))}
              min={10}
              max={5000}
              style={inputStyle}
            />
          </label>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
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
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !canSubmit}
              style={{
                flex: 1,
                padding: '12px 0',
                borderRadius: 16,
                border: 'none',
                background: 'var(--md-primary)',
                color: 'var(--md-on-primary)',
                fontSize: '0.95rem',
                fontWeight: 500,
                cursor: loading ? 'wait' : 'pointer',
                opacity: loading || !canSubmit ? 0.5 : 1,
              }}
            >
              {loading ? 'Creating...' : 'Create Drop'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
