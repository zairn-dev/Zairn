/**
 * Two-layer rate limiting for Edge Functions.
 *
 *  1. A bounded in-memory map per instance — a cheap burst filter only.
 *     Instances are recycled and run in parallel, so it is not authoritative.
 *  2. The check_rate_limit() Postgres function (service-role only), an
 *     atomic upsert shared by every instance. This is what enforces limits.
 *     RPC errors fail closed.
 */

const MAX_LOCAL_KEYS = 10_000
const localBuckets = new Map<string, { count: number; resetAt: number }>()

function checkLocal(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const entry = localBuckets.get(key)
  if (!entry || now > entry.resetAt) {
    if (!entry && localBuckets.size >= MAX_LOCAL_KEYS) {
      for (const [k, v] of localBuckets) if (now > v.resetAt) localBuckets.delete(k)
      if (localBuckets.size >= MAX_LOCAL_KEYS) {
        const oldest = localBuckets.keys().next().value
        if (typeof oldest === 'string') localBuckets.delete(oldest)
      }
    }
    localBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  entry.count++
  return entry.count <= max
}

export interface RateLimit {
  key: string
  max: number
  windowSeconds: number
}

/** True when the request is within every limit. `adminClient` must be service-role. */
export async function withinRateLimits(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  limits: RateLimit[],
): Promise<boolean> {
  for (const l of limits) {
    if (!checkLocal(l.key, l.max, l.windowSeconds * 1000)) return false
  }
  for (const l of limits) {
    const { data, error } = await adminClient.rpc('check_rate_limit', {
      p_key: l.key,
      p_max: l.max,
      p_window_seconds: l.windowSeconds,
    })
    if (error) {
      console.error('check_rate_limit RPC failed:', error.message)
      return false
    }
    if (data !== true) return false
  }
  return true
}

/** Occasionally purge stale buckets; fire-and-forget, no pg_cron needed. */
// deno-lint-ignore no-explicit-any
export function maybeCleanupRateLimits(adminClient: any): void {
  if (Math.random() >= 0.01) return
  adminClient.rpc('cleanup_stale_rate_limits', {}).then(
    // deno-lint-ignore no-explicit-any
    (r: any) => { if (r?.error) console.error('cleanup_stale_rate_limits failed:', r.error.message) },
  )
}
