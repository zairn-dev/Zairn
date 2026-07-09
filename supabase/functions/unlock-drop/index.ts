/**
 * Supabase Edge Function: unlock-drop
 *
 * Server-side drop unlock — verifies location, decrypts content, returns plaintext.
 * The client never sees encryption keys or encrypted content.
 *
 * POST /unlock-drop
 * Headers: Authorization: Bearer <user_jwt>
 * Body: { drop_id, lat, lon, accuracy, password?, proofs? }
 *
 * Returns: { content, claim, verification }
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { computeTrustScore, gateTrustScore } from '../_shared/trust-scorer.ts'
import type { LocationPoint } from '../_shared/trust-scorer.ts'

// =====================
// Rate limiting
//
// Two layers:
//  1. In-memory Map — a cheap first filter that catches bursts within a
//     single warm instance without a DB round trip. NOT authoritative:
//     Deno Deploy runs multiple instances and recycles them on cold start,
//     so this alone resets constantly and is trivially bypassed by
//     traffic landing on a fresh instance.
//  2. check_rate_limit() Postgres RPC (migration
//     20260709000015_persistent_rate_limit.sql) — authoritative, shared
//     across every instance/function via a single atomic UPSERT (same
//     "lock the row, check-then-update in one statement" pattern as
//     increment_claim_count). This is what actually enforces the limit;
//     layer 1 only reduces how often it's called.
// =====================
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 30 // requests per window
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute

function checkRateLimitLocal(key: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

// deno-lint-ignore no-explicit-any
async function checkRateLimitPersistent(adminClient: any, key: string): Promise<boolean> {
  const { data, error } = await adminClient.rpc('check_rate_limit', {
    p_key: key,
    p_max: RATE_LIMIT_MAX,
    p_window_seconds: Math.floor(RATE_LIMIT_WINDOW_MS / 1000),
  })
  if (error) {
    console.error('check_rate_limit RPC failed:', error)
    return false // fail closed: the DB is authoritative here, not a nice-to-have
  }
  return data === true
}

// =====================
// Crypto helpers (Web Crypto API, same as @zairn/geo-drop)
// =====================

/** Thrown when the server is missing required secret configuration. */
class ServerConfigError extends Error {}

/**
 * Resolve the server encryption secret for a given secret version.
 * Supports rotation via GEODROP_ENCRYPTION_SECRET_V{n}, falling back to the
 * unversioned GEODROP_ENCRYPTION_SECRET. FAIL CLOSED: if no secret is set the
 * derived key would be predictable from public columns, so we refuse rather
 * than warn-and-proceed.
 */
function resolveServerSecret(version: number): string {
  const versioned = Deno.env.get(`GEODROP_ENCRYPTION_SECRET_V${version}`)
  const secret = versioned ?? Deno.env.get('GEODROP_ENCRYPTION_SECRET')
  if (!secret) {
    throw new ServerConfigError(
      'GEODROP_ENCRYPTION_SECRET is not configured — refusing to derive keys predictable from public data'
    )
  }
  return secret
}

/**
 * Location key derivation. MUST byte-for-byte match @zairn/geo-drop crypto.ts
 * deriveLocationKey for the given version, or decryption fails.
 *   v1: geodrop:{geohash}:{dropId}:{salt}:{secret}
 *   v2: geodrop-v2:{len:field|...}:{secret}   (length-prefixed, delimiter-safe)
 */
function deriveLocationKey(
  geohash: string,
  dropId: string,
  salt: string,
  serverSecret: string,
  version: number,
): string {
  if (version >= 2) {
    const encoded = [geohash, dropId, salt].map((f) => `${f.length}:${f}`).join('|')
    return `geodrop-v2:${encoded}:${serverSecret}`
  }
  return `geodrop:${geohash}:${dropId}:${salt}:${serverSecret}`
}

async function pbkdf2Decrypt(
  ciphertext: string,
  iv: string,
  salt: string,
  password: string
): Promise<string> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  )
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext)
  )
  return new TextDecoder().decode(decrypted)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// =====================
// Server-side ZK proximity verification
//
// Authoritative check for drops that require a zero-knowledge proximity
// proof. All client-side verification is advisory; only this decides.
// FAIL CLOSED: a zk-required drop is rejected unless a proof verifies here.
//
// The verification key is server-trusted config (GEODROP_ZKP_VKEY), NEVER
// taken from the drop — a malicious creator could otherwise supply a vkey
// that accepts any proof.
//
// ⚠️ DEPLOY NOTE: the snarkjs import + vkey must be validated in your
// Supabase deploy before relying on this. Blast radius is limited to
// zk-method drops; GPS/password drops are unaffected. Set GEODROP_ZKP_VKEY
// to the JSON of circuits/sound_geo_only_vkey.json (or zairn_zkp_vkey.json).
// =====================
const SCALE = 1_000_000
const DEG2RAD = Math.PI / 180
const METERS_PER_DEG_LAT = 111_320

function toFixedPoint(deg: number): bigint {
  return BigInt(Math.round(deg * SCALE))
}
function metersToRadiusSquared(meters: number): bigint {
  const rFp = BigInt(Math.round((meters / METERS_PER_DEG_LAT) * SCALE))
  return rFp * rFp
}
function cosLatScaled(latDeg: number): bigint {
  return BigInt(Math.round(Math.cos(latDeg * DEG2RAD) * SCALE))
}

/**
 * Bind public signals to THIS drop's geometry (prevents cross-drop replay).
 * Public-signal layout of sound_geo_only / proximity circuits:
 *   [0] valid(=1) [1] targetLat [2] targetLon [3] radiusSquared [4] cosLatScaled
 */
function zkPublicSignalsBindToDrop(
  publicSignals: string[],
  // deno-lint-ignore no-explicit-any
  drop: any,
): boolean {
  if (!Array.isArray(publicSignals) || publicSignals.length < 5) return false
  try {
    if (publicSignals[0] !== '1') return false
    if (BigInt(publicSignals[1]) !== toFixedPoint(drop.lat)) return false
    if (BigInt(publicSignals[2]) !== toFixedPoint(drop.lon)) return false
    if (BigInt(publicSignals[3]) !== metersToRadiusSquared(drop.unlock_radius_meters)) return false
    if (BigInt(publicSignals[4]) !== cosLatScaled(drop.lat)) return false
    return true
  } catch {
    return false
  }
}

/**
 * Verify a ZK proximity proof server-side. Returns true only if a submitted
 * zk proof cryptographically verifies against the server vkey AND its public
 * signals bind to this drop. Any missing config / bad proof → false (reject).
 */
// deno-lint-ignore no-explicit-any
async function verifyZkProximityServer(proofs: any[], drop: any): Promise<boolean> {
  const vkeyRaw = Deno.env.get('GEODROP_ZKP_VKEY')
  if (!vkeyRaw) {
    console.error('GEODROP_ZKP_VKEY not set — cannot verify zk-required drop; rejecting')
    return false
  }
  // deno-lint-ignore no-explicit-any
  const sub = (proofs ?? []).find((p: any) => p?.method === 'zkp' || p?.method === 'zk')
  if (!sub?.proof || !Array.isArray(sub.publicSignals)) return false
  if (!zkPublicSignalsBindToDrop(sub.publicSignals, drop)) return false
  // deno-lint-ignore no-explicit-any
  let vkey: any
  try { vkey = JSON.parse(vkeyRaw) } catch { return false }
  try {
    const snarkjs = await import('https://esm.sh/snarkjs@0.7.5')
    return await snarkjs.groth16.verify(vkey, sub.publicSignals, sub.proof)
  } catch (e) {
    console.error('snarkjs verify failed:', e)
    return false
  }
}

// =====================
// proof_config requirement verification (server-authoritative)
//
// GPS is implicitly satisfied by the distance check the caller runs before
// calling this. Every OTHER declared requirement (secret, zkp, ...) is
// authorized here. Semantics mirror @zairn/geo-drop's client-side
// verificationEngine.verify(): only `required !== false` requirements
// count toward the pass/fail decision; mode 'any' passes if any required
// requirement is satisfied, mode 'all' requires all of them.
//
// FAIL CLOSED: a method this server does not know how to verify (ar,
// custom, or anything future) counts as NOT satisfied. Silently treating
// an unrecognized requirement as satisfied is exactly the bug this fixes
// (proof_config.secret was previously never checked here at all).
// =====================
async function verifySecretRequirement(
  // deno-lint-ignore no-explicit-any
  proofs: any[],
  secretHashes: Record<string, string> | null | undefined,
  index: number,
): Promise<boolean> {
  const storedHash = secretHashes?.[String(index)]
  if (!storedHash) return false // no hash on file: unmigrated/misconfigured drop -> reject
  // deno-lint-ignore no-explicit-any
  const submission = (proofs ?? []).find((p: any) => p?.method === 'secret')
  const submitted = submission?.data?.secret
  if (typeof submitted !== 'string' || submitted.length === 0) return false
  return await verifyPassword(submitted, storedHash)
}

async function verifyDropRequirements(
  // deno-lint-ignore no-explicit-any
  drop: any,
  // deno-lint-ignore no-explicit-any
  proofs: any[],
): Promise<{ ok: boolean; error?: string }> {
  const proofConfig = drop.proof_config
  const requirements = Array.isArray(proofConfig?.requirements) ? proofConfig.requirements : []
  if (requirements.length === 0) return { ok: true } // GPS-only (implicit default)

  const mode = proofConfig.mode === 'any' ? 'any' : 'all'
  let zkVerified: boolean | null = null
  const requiredOutcomes: boolean[] = []

  for (let i = 0; i < requirements.length; i++) {
    const req = requirements[i]
    if (req?.required === false) continue // optional: informational only, not part of the gate

    const method = req?.method
    let satisfied: boolean
    if (method === 'gps') {
      satisfied = true
    } else if (method === 'zkp' || method === 'zk' || method === 'zk-proximity') {
      if (zkVerified === null) zkVerified = await verifyZkProximityServer(proofs, drop)
      satisfied = zkVerified
    } else if (method === 'secret') {
      satisfied = await verifySecretRequirement(proofs, drop.proof_secret_hashes, i)
    } else {
      satisfied = false // unsupported method server-side -> fail closed
    }
    requiredOutcomes.push(satisfied)
  }

  const ok = requiredOutcomes.length === 0
    ? true
    : mode === 'any'
      ? requiredOutcomes.some(Boolean)
      : requiredOutcomes.every(Boolean)
  return ok ? { ok: true } : { ok: false, error: 'Proof requirements not satisfied' }
}

// =====================
// Distance calculation (Haversine)
// =====================
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// =====================
// Password verification (compatible with salted PBKDF2 + legacy SHA-256)
// =====================
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i]
  return result === 0
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash.includes(':')) {
    // Legacy unsalted SHA-256 — constant-time compare
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password)))
    return constantTimeEqual(hash, base64ToBytes(storedHash))
  }
  const [saltB64, hashB64] = storedHash.split(':')
  const salt = base64ToBytes(saltB64)
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  )
  const hash = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  ))
  return constantTimeEqual(hash, base64ToBytes(hashB64))
}

// =====================
// Handler
// =====================
serve(async (req: Request) => {
  // CORS — restrict to configured origin or fallback to same-site
  const allowedOrigin = Deno.env.get('CORS_ORIGIN') ?? Deno.env.get('SUPABASE_URL')
  if (!allowedOrigin) {
    return new Response('CORS_ORIGIN or SUPABASE_URL must be configured', { status: 500 })
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Headers': 'authorization, content-type',
      },
    })
  }

  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401 })
    }

    const { drop_id, lat, lon, accuracy, password, proofs } = await req.json()

    if (!drop_id || lat == null || lon == null) {
      return new Response(JSON.stringify({ error: 'Missing required fields: drop_id, lat, lon' }), { status: 400 })
    }

    // Validate proofs payload if present
    if (proofs !== undefined && proofs !== null) {
      if (!Array.isArray(proofs) || JSON.stringify(proofs).length > 8192) {
        return new Response(JSON.stringify({ error: 'Invalid or oversized proofs payload' }), { status: 400 })
      }
    }

    // Validate coordinates
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return new Response(JSON.stringify({ error: 'Invalid coordinates' }), { status: 400 })
    }

    // User client (with user's JWT for RLS)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Service role client to read full drop data (bypasses RLS column restrictions)
    const adminClient = createClient(supabaseUrl, supabaseServiceKey)

    // Verify user JWT
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 })
    }

    // Rate limit by authenticated user ID (non-spoofable, unlike x-forwarded-for).
    // Local check first (cheap burst filter); persistent RPC is authoritative.
    const rateLimitKey = `unlock-drop:${user.id}`
    if (!checkRateLimitLocal(rateLimitKey) || !(await checkRateLimitPersistent(adminClient, rateLimitKey))) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    // Opportunistic cleanup of stale buckets (no pg_cron dependency).
    if (Math.random() < 0.01) {
      adminClient.rpc('cleanup_stale_rate_limits', {}).then(
        // deno-lint-ignore no-explicit-any
        (r: any) => { if (r?.error) console.error('cleanup_stale_rate_limits failed:', r.error) },
      )
    }

    // Fetch full drop using service role (includes encryption material)
    const { data: drop, error: dropError } = await adminClient
      .from('geo_drops')
      .select('*')
      .eq('id', drop_id)
      .single()

    if (dropError || !drop) {
      return new Response(JSON.stringify({ error: 'Drop not found' }), { status: 404 })
    }

    // Status checks
    if (drop.status !== 'active') {
      return new Response(JSON.stringify({ error: 'Drop is not active' }), { status: 400 })
    }
    if (drop.expires_at && new Date(drop.expires_at) <= new Date()) {
      return new Response(JSON.stringify({ error: 'Drop has expired' }), { status: 400 })
    }

    // Check if already claimed
    const { data: existingClaim } = await adminClient
      .from('drop_claims')
      .select('id')
      .eq('drop_id', drop_id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingClaim) {
      return new Response(JSON.stringify({ error: 'Already claimed' }), { status: 409 })
    }

    // Password verification
    if (drop.password_hash) {
      if (!password || typeof password !== 'string') {
        return new Response(JSON.stringify({ error: 'Password required' }), { status: 400 })
      }
      if (password.length > 512) {
        return new Response(JSON.stringify({ error: 'Password too long' }), { status: 400 })
      }
      if (!(await verifyPassword(password, drop.password_hash))) {
        return new Response(JSON.stringify({ error: 'Incorrect password' }), { status: 403 })
      }
    }

    // Server-side location verification
    const distance = calculateDistance(drop.lat, drop.lon, lat, lon)
    const maxAccuracy = Math.min(50, drop.unlock_radius_meters / 2)
    const rawAccuracy = typeof accuracy === 'number' && accuracy >= 0 ? accuracy : 50
    const effectiveAccuracy = Math.min(rawAccuracy, maxAccuracy)
    const locationVerified = (distance - effectiveAccuracy) <= drop.unlock_radius_meters

    if (!locationVerified) {
      return new Response(JSON.stringify({
        error: 'Too far from drop location',
        distance_meters: Math.round(distance),
        required_radius: drop.unlock_radius_meters,
      }), { status: 403 })
    }

    // Server-side trust/velocity gate (fixes #7: this previously only ran
    // in the client-side dev-only unlock path — production never checked
    // it at all). Reads the caller's recent unlock_attempt history,
    // stateless recompute over the window (no in-memory session latch,
    // so this survives cold starts/multi-instance same as everything
    // else here).
    {
      const { data: recentLogs } = await adminClient
        .from('drop_location_logs')
        .select('lat, lon, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10)

      const history: LocationPoint[] = (recentLogs ?? []).map((l: { lat: number; lon: number; created_at: string }) => ({
        lat: l.lat, lon: l.lon, accuracy: null, timestamp: l.created_at,
      }))
      const trustResult = computeTrustScore(
        { lat, lon, accuracy: typeof accuracy === 'number' ? accuracy : null, timestamp: new Date().toISOString() },
        history,
      )
      const decision = gateTrustScore(trustResult)

      if (decision === 'deny') {
        return new Response(JSON.stringify({
          error: 'trust_gate', decision, trust_score: trustResult.trustScore, signals: trustResult.signals,
        }), { status: 403 })
      }
      if (decision === 'step-up') {
        // Mirrors core.ts's client-path heuristic: any non-GPS proof
        // submitted counts as an attempt at step-up evidence. Whether it's
        // actually VALID is decided below by verifyDropRequirements — this
        // gate only decides whether stronger evidence is required at all.
        const hasExtraProofs = Array.isArray(proofs) && proofs.some((p: { method?: string }) => p?.method && p.method !== 'gps')
        if (!hasExtraProofs) {
          const configuredMethods: string[] = Array.isArray(drop.proof_config?.requirements)
            ? drop.proof_config.requirements.map((r: { method?: string }) => r?.method).filter(Boolean)
            : []
          const stepUpOptions = configuredMethods.filter((m: string) => m !== 'gps')
          return new Response(JSON.stringify({
            error: 'trust_gate', decision, trust_score: trustResult.trustScore, signals: trustResult.signals,
            step_up_options: stepUpOptions,
          }), { status: 403 })
        }
      }
    }

    // Authoritative proof_config requirement verification (fail closed).
    // Covers zkp AND secret (and fails closed on any other declared
    // method this server doesn't know how to check) — GPS/password-only
    // drops with no extra requirements pass through immediately.
    try {
      const reqCheck = await verifyDropRequirements(drop, proofs)
      if (!reqCheck.ok) {
        return new Response(JSON.stringify({ error: reqCheck.error ?? 'Proof requirements not satisfied' }), { status: 403 })
      }
    } catch (reqErr) {
      console.error('Requirement verification error:', reqErr)
      return new Response(JSON.stringify({ error: 'Proof requirements not satisfied' }), { status: 403 })
    }

    // Validate CID format to prevent SSRF (CIDv0 = Qm..., CIDv1 = ba...)
    const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/
    function isValidCid(cid: string): boolean {
      return CID_RE.test(cid)
    }

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
        return new Response(JSON.stringify({ error: 'Server encryption not configured' }), { status: 503 })
      }
      throw cfgErr
    }
    let content: string

    try {
      if (drop.encrypted_content) {
        // DB-only mode
        const payload = JSON.parse(drop.encrypted_content)
        content = await pbkdf2Decrypt(payload.ciphertext, payload.iv, payload.salt, locationKey)
      } else if (drop.ipfs_cid) {
        // IPFS mode — fetch from gateway (validate CID to prevent SSRF)
        if (!isValidCid(drop.ipfs_cid)) {
          return new Response(JSON.stringify({ error: 'Invalid IPFS CID' }), { status: 400 })
        }
        const gateway = Deno.env.get('IPFS_GATEWAY') ?? 'https://gateway.pinata.cloud/ipfs'
        const res = await fetch(`${gateway}/${drop.ipfs_cid}`)
        if (!res.ok) throw new Error('Failed to fetch from IPFS')
        const contentLength = res.headers.get('content-length')
        if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: 'IPFS content too large' }), { status: 400 })
        }
        const payload = await res.json()
        content = await pbkdf2Decrypt(payload.ciphertext, payload.iv, payload.salt, locationKey)
      } else {
        return new Response(JSON.stringify({ error: 'No content available' }), { status: 404 })
      }
    } catch (decryptErr) {
      console.error('Decryption/parse error:', decryptErr)
      return new Response(JSON.stringify({ error: 'Failed to decrypt content' }), { status: 500 })
    }

    // Record claim — use userClient so auth.uid() is available for increment_claim_count
    const { data: claimResult, error: rpcError } = await userClient.rpc('increment_claim_count', { p_drop_id: drop_id })
    if (rpcError) {
      // Handle "Already claimed" and other RPC errors
      const status = rpcError.message?.includes('Already claimed') ? 409 : 500
      return new Response(JSON.stringify({ error: rpcError.message ?? 'Failed to increment claim count' }), { status })
    }
    if (claimResult === false) {
      return new Response(JSON.stringify({ error: 'Max claims reached' }), { status: 409 })
    }

    // Insert claim record (adminClient bypasses RLS for cross-user writes)
    // Schema: drop_claims(id, drop_id, user_id, lat, lon, distance_meters, proof_results, claimed_at)
    const { data: claim, error: claimError } = await adminClient
      .from('drop_claims')
      .insert({
        drop_id: drop_id,
        user_id: user.id,
        lat,
        lon,
        distance_meters: Math.round(distance),
        proof_results: proofs ?? null,
      })
      .select()
      .single()

    if (claimError) {
      return new Response(JSON.stringify({ error: 'Failed to record claim' }), { status: 500 })
    }

    // Log location for GPS spoofing detection
    // Schema: drop_location_logs(id, user_id, lat, lon, geohash, action, created_at)
    await adminClient.from('drop_location_logs').insert({
      user_id: user.id,
      lat,
      lon,
      geohash: drop.geohash,
      action: 'unlock_attempt',
    })

    return new Response(JSON.stringify({
      content,
      claim,
      verification: {
        verified: true,
        distance_meters: Math.round(distance),
        unlock_radius: drop.unlock_radius_meters,
      },
    }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': allowedOrigin,
      },
    })
  } catch (err) {
    console.error('unlock-drop error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 })
  }
})
