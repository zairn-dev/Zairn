/**
 * unlock-drop request handler (served by ./index.ts).
 *
 * Server-side drop unlock — authorizes the caller, verifies location and
 * proof requirements, decrypts content, records the claim, returns plaintext.
 * The client never sees encryption keys or encrypted content.
 *
 * POST /unlock-drop
 * Headers: Authorization: Bearer <user_jwt>
 * Body: { drop_id, lat, lon, accuracy?, password?, proofs? }
 *
 * Returns: { content, claim, verification }
 * Errors carry a machine-readable `code` (e.g. step_up_required).
 */
import { createClient as createSupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { computeTrustScore, gateTrustScore } from '../_shared/trust-scorer.ts'
import type { LocationPoint } from '../_shared/trust-scorer.ts'
import {
  isUuid,
  isValidCid,
  jsonResponse,
  methodNotAllowed,
  preflightResponse,
  readTextWithLimit,
} from '../_shared/http.ts'
import { maybeCleanupRateLimits, withinRateLimits } from '../_shared/rate-limit.ts'
import { verifyZkProximity } from '../_shared/zk.ts'
import { decrypt, deriveLocationKey, verifyPassword } from '../_shared/drop-crypto.ts'
import type { EncryptedPayload } from '../_shared/drop-crypto.ts'
import { ServerConfigError, resolveServerSecret } from '../_shared/server-secret.ts'

const MAX_REQUEST_BYTES = 16 * 1024
const MAX_PROOFS_BYTES = 8192
const MAX_IPFS_PAYLOAD_BYTES = 10 * 1024 * 1024
const UNLOCK_LIMIT = { max: 30, windowSeconds: 60 }
// Per account and drop: bounds online password/secret guessing.
const SECRET_GUESS_LIMIT = { max: 10, windowSeconds: 600 }
const TRUST_HISTORY_SIZE = 10

// =====================
// proof_config requirement verification (server-authoritative)
//
// GPS is satisfied by the distance check the handler runs first. Every
// OTHER declared requirement is verified here. Semantics mirror
// @zairn/geo-drop's verificationEngine.verify(): only `required !== false`
// requirements gate the unlock; mode 'any' passes if any of them is
// satisfied, mode 'all' requires all of them. Optional requirements are
// still evaluated, because they are what a trust-gate step-up relies on.
//
// FAIL CLOSED: a method this server cannot verify counts as NOT satisfied.
// =====================
interface RequirementOutcome {
  method: string
  required: boolean
  verified: boolean
}

async function verifySecretRequirement(
  // deno-lint-ignore no-explicit-any
  proofs: any[],
  secretHashes: Record<string, string> | null | undefined,
  index: number,
): Promise<boolean> {
  const storedHash = secretHashes?.[String(index)]
  if (!storedHash) return false // no hash on file: unmigrated/misconfigured drop -> reject
  // deno-lint-ignore no-explicit-any
  const submission = proofs.find((p: any) => p?.method === 'secret')
  const submitted = submission?.data?.secret
  if (typeof submitted !== 'string' || submitted.length === 0 || submitted.length > 512) return false
  return await verifyPassword(submitted, storedHash)
}

async function verifyDropRequirements(
  // deno-lint-ignore no-explicit-any
  drop: any,
  // deno-lint-ignore no-explicit-any
  proofs: any[],
): Promise<{ ok: boolean; outcomes: RequirementOutcome[] }> {
  const proofConfig = drop.proof_config
  const requirements = Array.isArray(proofConfig?.requirements) ? proofConfig.requirements : []
  const mode = proofConfig?.mode === 'any' ? 'any' : 'all'
  let zkVerified: boolean | null = null
  const outcomes: RequirementOutcome[] = []

  for (let i = 0; i < requirements.length; i++) {
    const req = requirements[i]
    const method = typeof req?.method === 'string' ? req.method : 'unknown'
    let verified: boolean
    if (method === 'gps') {
      verified = true
    } else if (method === 'zkp' || method === 'zk' || method === 'zk-proximity') {
      zkVerified ??= await verifyZkProximity(proofs, drop)
      verified = zkVerified
    } else if (method === 'secret') {
      verified = await verifySecretRequirement(proofs, drop.proof_secret_hashes, i)
    } else {
      verified = false // unsupported method server-side -> fail closed
    }
    outcomes.push({ method, required: req?.required !== false, verified })
  }

  const gating = outcomes.filter((o) => o.required).map((o) => o.verified)
  const ok = gating.length === 0
    ? true
    : mode === 'any' ? gating.some(Boolean) : gating.every(Boolean)
  return { ok, outcomes }
}

// =====================
// Distance calculation (Haversine)
// =====================
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.min(1,
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2)
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// =====================
// Request parsing
// =====================
interface UnlockRequest {
  dropId: string
  lat: number
  lon: number
  accuracy: number | null
  password: string | null
  // deno-lint-ignore no-explicit-any
  proofs: any[]
}

function parseUnlockRequest(body: unknown): UnlockRequest | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid request body'
  const b = body as Record<string, unknown>
  if (!isUuid(b.drop_id)) return 'drop_id must be a UUID'
  const { lat, lon } = b
  if (typeof lat !== 'number' || typeof lon !== 'number' ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return 'Invalid coordinates'
  }
  const accuracy = typeof b.accuracy === 'number' && Number.isFinite(b.accuracy) && b.accuracy >= 0
    ? b.accuracy
    : null
  if (b.password != null && (typeof b.password !== 'string' || b.password.length > 512)) {
    return 'Invalid password'
  }
  let proofs: unknown[] = []
  if (b.proofs != null) {
    if (!Array.isArray(b.proofs) || JSON.stringify(b.proofs).length > MAX_PROOFS_BYTES) {
      return 'Invalid or oversized proofs payload'
    }
    proofs = b.proofs
  }
  return {
    dropId: b.drop_id,
    lat,
    lon,
    accuracy,
    password: typeof b.password === 'string' ? b.password : null,
    proofs,
  }
}

// =====================
// Handler
// =====================
export interface UnlockDeps {
  // deno-lint-ignore no-explicit-any
  createClient: (url: string, key: string, options?: any) => any
}

const defaultDeps: UnlockDeps = { createClient: createSupabaseClient }

export async function handleUnlock(req: Request, deps: UnlockDeps = defaultDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return preflightResponse(req)
  if (req.method !== 'POST') return methodNotAllowed(req)
  const respond = (body: Record<string, unknown>, status = 200) => jsonResponse(req, body, status)

  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) return respond({ error: 'Missing authorization' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !serviceKey || !anonKey) return respond({ error: 'Service unavailable' }, 503)

    const raw = await readTextWithLimit(req, MAX_REQUEST_BYTES)
    if (raw === null) return respond({ error: 'Request too large' }, 413)
    let body: unknown
    try { body = JSON.parse(raw) } catch { return respond({ error: 'Invalid JSON' }, 400) }
    const parsed = parseUnlockRequest(body)
    if (typeof parsed === 'string') return respond({ error: parsed }, 400)
    const { dropId, lat, lon, accuracy, password, proofs } = parsed

    const adminClient = deps.createClient(supabaseUrl, serviceKey)
    const userClient = deps.createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return respond({ error: 'Invalid token' }, 401)

    if (!(await withinRateLimits(adminClient, [{ key: `unlock-drop:${user.id}`, ...UNLOCK_LIMIT }]))) {
      return respond({ error: 'Rate limit exceeded' }, 429)
    }
    maybeCleanupRateLimits(adminClient)

    // Authorization: the caller must be able to see the drop under RLS
    // (public, password, friends, shared-private, or own). The service-role
    // read below bypasses RLS, so this check is what enforces visibility.
    // Invisible and nonexistent drops get the same answer.
    const { data: visible } = await userClient
      .from('geo_drops').select('id').eq('id', dropId).maybeSingle()
    if (!visible) return respond({ error: 'Drop not found' }, 404)

    const { data: drop, error: dropError } = await adminClient
      .from('geo_drops').select('*').eq('id', dropId).single()
    if (dropError || !drop) return respond({ error: 'Drop not found' }, 404)

    if (drop.status !== 'active') return respond({ error: 'Drop is not active' }, 400)
    if (drop.expires_at && new Date(drop.expires_at) <= new Date()) {
      return respond({ error: 'Drop has expired' }, 400)
    }

    const { data: existingClaim } = await adminClient
      .from('drop_claims').select('id').eq('drop_id', dropId).eq('user_id', user.id).maybeSingle()
    if (existingClaim) return respond({ error: 'Already claimed', code: 'already_claimed' }, 409)

    // Location check
    const distance = calculateDistance(drop.lat, drop.lon, lat, lon)
    const maxAccuracy = Math.min(50, drop.unlock_radius_meters / 2)
    const effectiveAccuracy = Math.min(accuracy ?? 50, maxAccuracy)
    const locationVerified = (distance - effectiveAccuracy) <= drop.unlock_radius_meters

    // Trust/velocity gate over the caller's previous unlock attempts. Only
    // server-written 'unlock_attempt' rows are trusted: clients may log
    // 'create'/'search' rows themselves, and RLS forbids them from writing
    // this action; created_at is set by the database.
    const { data: recentLogs } = await adminClient
      .from('drop_location_logs')
      .select('lat, lon, created_at')
      .eq('user_id', user.id)
      .eq('action', 'unlock_attempt')
      .order('created_at', { ascending: false })
      .limit(TRUST_HISTORY_SIZE)
    const history: LocationPoint[] = (recentLogs ?? []).map(
      (l: { lat: number; lon: number; created_at: string }) => ({
        lat: l.lat, lon: l.lon, accuracy: null, timestamp: l.created_at,
      }),
    )
    const decision = gateTrustScore(computeTrustScore(
      { lat, lon, accuracy, timestamp: new Date().toISOString() },
      history,
    ))

    // Every authorized attempt becomes history, including failures, so a
    // rejected teleport still counts against the next attempt.
    const { error: logError } = await adminClient.from('drop_location_logs').insert({
      user_id: user.id, lat, lon, geohash: drop.geohash, action: 'unlock_attempt',
    })
    if (logError) console.error('drop_location_logs insert failed:', logError.message)

    if (!locationVerified) {
      return respond({
        error: 'Too far from drop location',
        code: 'too_far',
        distance_meters: Math.round(distance),
        required_radius: drop.unlock_radius_meters,
      }, 403)
    }
    if (decision === 'deny') return respond({ error: 'trust_gate', code: 'trust_denied', decision }, 403)

    // Password / secret guesses are rate limited per account and drop.
    const guessesSecret = Boolean(drop.password_hash) ||
      proofs.some((p: { method?: string }) => p?.method === 'secret')
    if (guessesSecret && !(await withinRateLimits(adminClient, [
      { key: `unlock-secret:${user.id}:${dropId}`, ...SECRET_GUESS_LIMIT },
    ]))) {
      return respond({ error: 'Too many attempts', code: 'too_many_attempts' }, 429)
    }

    if (drop.password_hash) {
      if (!password) return respond({ error: 'Password required', code: 'password_required' }, 400)
      if (!(await verifyPassword(password, drop.password_hash))) {
        return respond({ error: 'Incorrect password', code: 'incorrect_password' }, 403)
      }
    }

    let requirements: { ok: boolean; outcomes: RequirementOutcome[] }
    try {
      requirements = await verifyDropRequirements(drop, proofs)
    } catch (reqErr) {
      console.error('Requirement verification error:', reqErr instanceof Error ? reqErr.message : reqErr)
      return respond({ error: 'Proof requirements not satisfied' }, 403)
    }

    if (decision === 'step-up') {
      // Step-up needs stronger evidence that actually VERIFIES: a configured
      // non-GPS requirement (required or optional). Merely submitting a
      // non-GPS proof object is not evidence.
      const stepUpMethods = requirements.outcomes.filter((o) => o.method !== 'gps')
      if (!stepUpMethods.some((o) => o.verified)) {
        return respond({
          error: 'trust_gate',
          code: 'step_up_required',
          decision,
          step_up_options: [...new Set(stepUpMethods.map((o) => o.method))],
        }, 403)
      }
    }
    if (!requirements.ok) return respond({ error: 'Proof requirements not satisfied' }, 403)

    // Decrypt content — resolve the server secret FIRST and fail closed if
    // unset (predictable keys) or if the drop's key/secret version is unknown.
    let locationKey: string
    try {
      const keyVersion = Number(drop.key_derivation_version ?? 1)
      const secretVersion = Number(drop.server_secret_version ?? 1)
      const serverSecret = resolveServerSecret(secretVersion)
      locationKey = deriveLocationKey(drop.geohash, drop.id, drop.encryption_salt, serverSecret, keyVersion)
    } catch (cfgErr) {
      if (cfgErr instanceof ServerConfigError) {
        console.error('unlock-drop config error:', cfgErr.message)
        return respond({ error: 'Server encryption not configured' }, 503)
      }
      throw cfgErr
    }

    let content: string
    try {
      let payloadText: string
      if (drop.encrypted_content) {
        payloadText = drop.encrypted_content
      } else if (drop.ipfs_cid) {
        if (!isValidCid(drop.ipfs_cid)) return respond({ error: 'Invalid IPFS CID' }, 400)
        const gateway = (Deno.env.get('IPFS_GATEWAY') ?? 'https://gateway.pinata.cloud/ipfs').replace(/\/+$/, '')
        const res = await fetch(`${gateway}/${drop.ipfs_cid}`, { redirect: 'error' })
        if (!res.ok) throw new Error(`IPFS gateway returned ${res.status}`)
        const text = await readTextWithLimit(res, MAX_IPFS_PAYLOAD_BYTES)
        if (text === null) return respond({ error: 'IPFS content too large' }, 400)
        payloadText = text
      } else {
        return respond({ error: 'No content available' }, 404)
      }
      content = await decrypt(JSON.parse(payloadText) as EncryptedPayload, locationKey)
    } catch (decryptErr) {
      console.error('Decryption/parse error:', decryptErr instanceof Error ? decryptErr.message : decryptErr)
      return respond({ error: 'Failed to decrypt content' }, 500)
    }

    // Record the claim and bump claim_count atomically (row lock, max_claims
    // and single-claim checks inside claim_drop). Only verification outcomes
    // are stored — never the submitted secrets or reusable proofs.
    const proofResults = [{ method: 'gps', verified: true }, ...requirements.outcomes.map(
      ({ method, verified }) => ({ method, verified }),
    )]
    const { data: claimRows, error: claimError } = await adminClient.rpc('claim_drop', {
      p_drop_id: dropId,
      p_user_id: user.id,
      p_lat: lat,
      p_lon: lon,
      p_distance_meters: Math.round(distance),
      p_proof_results: proofResults,
    })
    if (claimError) {
      if (claimError.code === '23505' || claimError.message?.includes('Already claimed')) {
        return respond({ error: 'Already claimed', code: 'already_claimed' }, 409)
      }
      console.error('claim_drop failed:', claimError.message)
      return respond({ error: 'Failed to record claim' }, 500)
    }
    const claimRow = Array.isArray(claimRows) ? claimRows[0] : claimRows
    if (!claimRow?.claimed) return respond({ error: 'Max claims reached', code: 'max_claims_reached' }, 409)

    return respond({
      content,
      claim: {
        id: claimRow.claim_id,
        drop_id: dropId,
        user_id: user.id,
        lat,
        lon,
        distance_meters: Math.round(distance),
        proof_results: proofResults,
        claimed_at: claimRow.claimed_at,
      },
      verification: {
        verified: true,
        distance_meters: Math.round(distance),
        unlock_radius: drop.unlock_radius_meters,
      },
    })
  } catch (err) {
    console.error('unlock-drop error:', err instanceof Error ? err.message : err)
    return respond({ error: 'Internal server error' }, 500)
  }
}
