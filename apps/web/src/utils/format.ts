export function formatRelativeTime(date: string | Date): string {
  const now = Date.now()
  const then = typeof date === 'string' ? new Date(date).getTime() : date.getTime()
  const diffMs = now - then

  if (diffMs < 0) return 'just now'

  const seconds = Math.floor(diffMs / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 30)}mo ago`
}

/**
 * Sanitize avatar URL — only allow https: protocol to prevent XSS via javascript: or data: URIs
 */
/**
 * Avatars are user-controlled URLs, so only this project's Supabase Storage
 * is accepted: an arbitrary host would turn every rendered avatar into a
 * tracking pixel that learns each viewer's IP address.
 */
export function safeAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    const storage = new URL(import.meta.env.VITE_SUPABASE_URL as string)
    const sameOrigin = parsed.origin === storage.origin
    const secure = parsed.protocol === 'https:' || storage.protocol === 'http:'
    if (sameOrigin && secure && parsed.pathname.startsWith('/storage/v1/')) return url
    return null
  } catch {
    return null
  }
}

export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m`
  }
  const km = meters / 1000
  return km >= 10 ? `${Math.round(km)}km` : `${km.toFixed(1)}km`
}
