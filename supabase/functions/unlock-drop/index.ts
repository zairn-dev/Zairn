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

// =====================
// Rate limiting (in-memory, per-function instance)
// =====================
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 30 // requests per window
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute

function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

// =====================
// Crypto helpers (Web Crypto API, same as @zairn/geo-drop)
// =====================
function deriveLocationKey(geohash: string, dropId: string, salt: string): string {
  const base = `geodrop:${geohash}:${dropId}:${salt}`
  const serverSecret = Deno.env.get('GEODROP_ENCRYPTION_SECRET')
  if (!serverSecret) {
    console.warn('WARNING: GEODROP_ENCRYPTION_SECRET is not set — encryption keys are predictable from public data')
  }
  return serverSecret ? `${base}:${serverSecret}` : base
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

    // Rate limit by authenticated user ID (non-spoofable, unlike x-forwarded-for)
    if (!checkRateLimit(user.id)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
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

    // Validate CID format to prevent SSRF (CIDv0 = Qm..., CIDv1 = ba...)
    const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/
    function isValidCid(cid: string): boolean {
      return CID_RE.test(cid)
    }

    // Decrypt content
    const locationKey = deriveLocationKey(drop.geohash, drop.id, drop.encryption_salt)
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
