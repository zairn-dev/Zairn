/**
 * create-drop request handler (served by ./index.ts).
 *
 * Server-side drop creation. The content key is derived from the server
 * secret (GEODROP_ENCRYPTION_SECRET), so clients never hold it and the key
 * is not derivable from the drop's own columns. The plaintext reaches the
 * server once, over TLS, from its author.
 *
 * POST /create-drop
 * Headers: Authorization: Bearer <user_jwt>
 * Body: {
 *   title, content_type, content (string), lat, lon,
 *   description?, unlock_radius_meters?, visibility?, password?, max_claims?,
 *   expires_at? (ISO 8601), metadata?, shared_with? (user ids, private drops),
 *   proof_config?, storage? ('db' | 'ipfs')
 * }
 * Returns: { drop } — client-readable columns only.
 */
import { createClient as createSupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { isUuid, jsonResponse, methodNotAllowed, preflightResponse, readTextWithLimit } from '../_shared/http.ts'
import { maybeCleanupRateLimits, withinRateLimits } from '../_shared/rate-limit.ts'
import { CURRENT_KEY_VERSION, deriveLocationKey, encrypt, hashPassword, randomHex } from '../_shared/drop-crypto.ts'
import { ServerConfigError, currentSecretVersion, resolveServerSecret } from '../_shared/server-secret.ts'
import { encodeGeohash } from '../_shared/geohash.ts'
import { PinningUnavailableError, pinToPinata } from '../_shared/pinata.ts'

const MAX_CONTENT_BYTES = 10 * 1024 * 1024
// Content plus JSON escaping and the other fields.
const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const MAX_SMALL_JSON_BYTES = 8192
const MAX_SHARED_WITH = 100
const MAX_REQUIREMENTS = 10
const MAX_TITLE = 500
const MAX_DESCRIPTION = 5000
const MAX_EXPIRY_MS = 5 * 365 * 24 * 3600 * 1000
const CREATE_LIMITS = (uid: string) => [
  { key: `create-drop:${uid}`, max: 10, windowSeconds: 60 },
  { key: `create-drop-daily:${uid}`, max: 200, windowSeconds: 86_400 },
]

const CONTENT_TYPES = new Set(['text', 'image', 'audio', 'video', 'file', 'nft'])
const VISIBILITIES = new Set(['public', 'friends', 'private', 'password'])
const PROOF_METHODS = new Set(['gps', 'secret', 'ar', 'zkp', 'zkp-region', 'custom'])
// What unlock-drop can verify. A REQUIRED requirement outside this set would
// make the drop unlockable by nobody (unlock fails closed), so it is refused.
const SERVER_VERIFIABLE = new Set(['gps', 'secret', 'zkp'])

// Matches GEO_DROP_PUBLIC_COLUMNS in packages/geo-drop/src/core.ts.
const PUBLIC_COLUMNS = 'id,creator_id,title,description,content_type,lat,lon,geohash,unlock_radius_meters,visibility,max_claims,claim_count,proof_config,expires_at,status,preview_url,metadata,persistence_level,metadata_cid,chain_tx_hash,ipfs_cid,encrypted,created_at,updated_at'

// deno-lint-ignore no-explicit-any
type Json = any

interface ProofRequirementInput {
  method: string
  required?: boolean
  params?: Record<string, Json>
}

interface CreateRequest {
  title: string
  description: string | null
  contentType: string
  content: string
  lat: number
  lon: number
  radius: number
  visibility: string
  password: string | null
  maxClaims: number | null
  expiresAt: string | null
  metadata: Record<string, Json> | null
  sharedWith: string[]
  proofConfig: { mode: 'all' | 'any'; requirements: ProofRequirementInput[] } | null
  storage: 'db' | 'ipfs'
}

const jsonSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const isPlainObject = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v)

function parseProofConfig(raw: unknown): CreateRequest['proofConfig'] | string {
  if (raw == null) return null
  if (!isPlainObject(raw) || jsonSize(raw) > MAX_SMALL_JSON_BYTES) return 'Invalid or oversized proof_config'
  if (raw.mode !== undefined && raw.mode !== 'all' && raw.mode !== 'any') return 'proof_config.mode must be "all" or "any"'
  if (!Array.isArray(raw.requirements) || raw.requirements.length > MAX_REQUIREMENTS) {
    return `proof_config.requirements must be an array of at most ${MAX_REQUIREMENTS}`
  }
  const requirements: ProofRequirementInput[] = []
  for (const [i, r] of raw.requirements.entries()) {
    if (!isPlainObject(r) || typeof r.method !== 'string' || !PROOF_METHODS.has(r.method)) {
      return `proof_config.requirements[${i}].method is invalid`
    }
    if (r.params !== undefined && !isPlainObject(r.params)) return `proof_config.requirements[${i}].params must be an object`
    if (r.required !== undefined && typeof r.required !== 'boolean') return `proof_config.requirements[${i}].required must be boolean`
    const required = r.required !== false
    if (required && !SERVER_VERIFIABLE.has(r.method)) {
      return `Required method "${r.method}" cannot be verified by the server; mark it optional or remove it`
    }
    if (r.method === 'zkp' && required && !Deno.env.get('GEODROP_ZKP_VKEY')) {
      return 'zkp requirements are not enabled on this server (GEODROP_ZKP_VKEY is not set)'
    }
    if (r.method === 'secret') {
      const secret = r.params?.secret
      if (typeof secret !== 'string' || secret.length === 0 || secret.length > 512) {
        return `proof_config.requirements[${i}].params.secret must be a non-empty string of at most 512 characters`
      }
    }
    requirements.push({ method: r.method, required: r.required, params: r.params })
  }
  return requirements.length ? { mode: raw.mode === 'any' ? 'any' : 'all', requirements } : null
}

export function parseCreateRequest(body: unknown, userId: string, now = Date.now()): CreateRequest | string {
  if (!isPlainObject(body)) return 'Invalid request body'
  const b = body

  if (typeof b.title !== 'string' || b.title.trim().length === 0 || b.title.length > MAX_TITLE) {
    return `title must be a non-empty string of at most ${MAX_TITLE} characters`
  }
  if (b.description != null && (typeof b.description !== 'string' || b.description.length > MAX_DESCRIPTION)) {
    return `description must be a string of at most ${MAX_DESCRIPTION} characters`
  }
  if (typeof b.content_type !== 'string' || !CONTENT_TYPES.has(b.content_type)) return 'content_type is invalid'
  if (typeof b.content !== 'string' || b.content.length === 0) return 'content must be a non-empty string'
  if (new TextEncoder().encode(b.content).byteLength > MAX_CONTENT_BYTES) return 'content is too large (max 10MB)'

  const { lat, lon } = b
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return 'Invalid coordinates'
  }
  const radius = b.unlock_radius_meters ?? 50
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0 || radius > 100_000) {
    return 'unlock_radius_meters must be between 1 and 100,000'
  }

  const visibility = b.visibility ?? 'public'
  if (typeof visibility !== 'string' || !VISIBILITIES.has(visibility)) return 'visibility is invalid'
  if (b.password != null && (typeof b.password !== 'string' || b.password.length === 0 || b.password.length > 512)) {
    return 'password must be a non-empty string of at most 512 characters'
  }
  if (visibility === 'password' && typeof b.password !== 'string') return 'password visibility requires a password'

  if (b.max_claims != null && (!Number.isInteger(b.max_claims) || b.max_claims < 1 || b.max_claims > 1_000_000)) {
    return 'max_claims must be an integer between 1 and 1,000,000'
  }

  let expiresAt: string | null = null
  if (b.expires_at != null) {
    const t = typeof b.expires_at === 'string' ? Date.parse(b.expires_at) : NaN
    if (!Number.isFinite(t) || t <= now || t > now + MAX_EXPIRY_MS) {
      return 'expires_at must be an ISO 8601 time in the future (at most 5 years)'
    }
    expiresAt = new Date(t).toISOString()
  }

  if (b.metadata != null && (!isPlainObject(b.metadata) || jsonSize(b.metadata) > MAX_SMALL_JSON_BYTES)) {
    return 'metadata must be an object of at most 8KB'
  }

  let sharedWith: string[] = []
  if (b.shared_with != null) {
    if (!Array.isArray(b.shared_with) || b.shared_with.length > MAX_SHARED_WITH || !b.shared_with.every(isUuid)) {
      return `shared_with must be an array of at most ${MAX_SHARED_WITH} user ids`
    }
    sharedWith = [...new Set(b.shared_with as string[])].filter((id) => id !== userId)
  }

  const proofConfig = parseProofConfig(b.proof_config)
  if (typeof proofConfig === 'string') return proofConfig

  const storage = b.storage ?? 'db'
  if (storage !== 'db' && storage !== 'ipfs') return 'storage must be "db" or "ipfs"'

  return {
    title: b.title,
    description: typeof b.description === 'string' ? b.description : null,
    contentType: b.content_type,
    content: b.content,
    lat,
    lon,
    radius,
    visibility,
    password: typeof b.password === 'string' ? b.password : null,
    maxClaims: b.max_claims ?? null,
    expiresAt,
    metadata: b.metadata ?? null,
    sharedWith: visibility === 'private' ? sharedWith : [],
    proofConfig,
    storage,
  }
}

/**
 * Hash `secret` requirement params into a server-only map keyed by
 * requirement index and strip the plaintext from the client-readable
 * proof_config (same contract as the SDK's sanitizeProofConfig).
 */
async function sealProofConfig(config: CreateRequest['proofConfig']) {
  if (!config) return { proofConfig: null, secretHashes: null }
  const secretHashes: Record<string, string> = {}
  const requirements = await Promise.all(config.requirements.map(async (r, i) => {
    if (r.method !== 'secret') return r
    const { secret, ...rest } = r.params ?? {}
    secretHashes[String(i)] = await hashPassword(secret as string)
    return { ...r, params: rest }
  }))
  return {
    proofConfig: { mode: config.mode, requirements },
    secretHashes: Object.keys(secretHashes).length ? secretHashes : null,
  }
}

export interface CreateDeps {
  // deno-lint-ignore no-explicit-any
  createClient: (url: string, key: string, options?: any) => any
}

const defaultDeps: CreateDeps = { createClient: createSupabaseClient }

export async function handleCreate(req: Request, deps: CreateDeps = defaultDeps): Promise<Response> {
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

    const userClient = deps.createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return respond({ error: 'Invalid token' }, 401)

    const adminClient = deps.createClient(supabaseUrl, serviceKey)
    if (!(await withinRateLimits(adminClient, CREATE_LIMITS(user.id)))) {
      return respond({ error: 'Rate limit exceeded', code: 'rate_limited' }, 429)
    }
    maybeCleanupRateLimits(adminClient)

    const raw = await readTextWithLimit(req, MAX_REQUEST_BYTES)
    if (raw === null) return respond({ error: 'Request too large' }, 413)
    let body: unknown
    try { body = JSON.parse(raw) } catch { return respond({ error: 'Invalid JSON' }, 400) }
    const parsed = parseCreateRequest(body, user.id)
    if (typeof parsed === 'string') return respond({ error: parsed, code: 'invalid_input' }, 400)

    // Resolve the secret before any work: no secret, no drop.
    let serverSecret: string
    let secretVersion: number
    try {
      secretVersion = currentSecretVersion()
      serverSecret = resolveServerSecret(secretVersion)
    } catch (cfgErr) {
      if (cfgErr instanceof ServerConfigError) {
        console.error('create-drop config error:', cfgErr.message)
        return respond({ error: 'Server encryption not configured' }, 503)
      }
      throw cfgErr
    }

    const dropId = crypto.randomUUID()
    const geohash = encodeGeohash(parsed.lat, parsed.lon)
    const encryptionSalt = randomHex(16)
    const locationKey = deriveLocationKey(geohash, dropId, encryptionSalt, serverSecret, CURRENT_KEY_VERSION)
    const encryptedJson = JSON.stringify(await encrypt(parsed.content, locationKey))

    let ipfsCid: string | null = null
    let previewUrl: string | null = null
    if (parsed.storage === 'ipfs') {
      try {
        ipfsCid = (await pinToPinata(new Blob([encryptedJson], { type: 'application/json' }))).cid
      } catch (pinErr) {
        if (pinErr instanceof PinningUnavailableError) {
          return respond({ error: 'IPFS storage is not configured on this server', code: 'ipfs_unavailable' }, 503)
        }
        console.error('create-drop pin error:', pinErr instanceof Error ? pinErr.message : pinErr)
        return respond({ error: 'IPFS pin failed' }, 502)
      }
      const gateway = (Deno.env.get('IPFS_GATEWAY') ?? 'https://gateway.pinata.cloud/ipfs').replace(/\/+$/, '')
      previewUrl = `${gateway}/${ipfsCid}`
    }

    const { proofConfig, secretHashes } = await sealProofConfig(parsed.proofConfig)

    const { data: drop, error: insertError } = await adminClient
      .from('geo_drops')
      .insert({
        id: dropId,
        creator_id: user.id,
        lat: parsed.lat,
        lon: parsed.lon,
        geohash,
        unlock_radius_meters: parsed.radius,
        title: parsed.title,
        description: parsed.description,
        content_type: parsed.contentType,
        ipfs_cid: ipfsCid,
        encrypted_content: ipfsCid ? null : encryptedJson,
        encrypted: true,
        encryption_salt: encryptionSalt,
        visibility: parsed.visibility,
        password_hash: parsed.password ? await hashPassword(parsed.password) : null,
        max_claims: parsed.maxClaims,
        proof_config: proofConfig,
        proof_secret_hashes: secretHashes,
        expires_at: parsed.expiresAt,
        preview_url: previewUrl,
        metadata: parsed.metadata,
        key_derivation_version: CURRENT_KEY_VERSION,
        encryption_algorithm: 'aes-256-gcm',
        server_secret_version: secretVersion,
      })
      .select(PUBLIC_COLUMNS)
      .single()
    if (insertError || !drop) {
      console.error('create-drop insert failed:', insertError?.message)
      return respond({ error: 'Failed to create drop' }, 500)
    }

    if (parsed.sharedWith.length > 0) {
      const { error: shareError } = await adminClient
        .from('drop_shares')
        .insert(parsed.sharedWith.map((uid) => ({ drop_id: dropId, user_id: uid })))
      if (shareError) {
        // No partial drops: a private drop without its shares is useless.
        await adminClient.from('geo_drops').delete().eq('id', dropId)
        console.error('create-drop share insert failed:', shareError.message)
        return respond({ error: 'Failed to share drop' }, 500)
      }
    }

    const { error: logError } = await adminClient.from('drop_location_logs').insert({
      user_id: user.id, lat: parsed.lat, lon: parsed.lon, geohash, action: 'create',
    })
    if (logError) console.error('drop_location_logs insert failed:', logError.message)

    return respond({ drop }, 201)
  } catch (err) {
    console.error('create-drop error:', err instanceof Error ? err.message : err)
    return respond({ error: 'Internal server error' }, 500)
  }
}
