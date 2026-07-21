/**
 * Supabase Edge Function: ipfs-proxy
 *
 * Proxies IPFS pinning API calls so that API keys are never exposed to the client.
 * Supports multipart uploads plus the legacy JSON pin/fetch API.
 *
 * POST /ipfs-proxy  multipart/form-data with a "file" field
 * POST /ipfs-proxy  { action: "pin", content: "..." }
 * POST /ipfs-proxy  { action: "fetch", cid: "Qm..." }
 *
 * Environment variables:
 *   PINATA_JWT - Pinata API JWT token
 *   IPFS_GATEWAY - IPFS gateway URL (default: https://gateway.pinata.cloud/ipfs)
 *   CORS_ORIGIN - Comma-separated browser origins allowed to call this function
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'

const MAX_CONTENT_SIZE = 10 * 1024 * 1024
const MAX_REQUEST_SIZE = MAX_CONTENT_SIZE + 1024 * 1024

// =====================
// Rate limiting
// =====================
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_KEYS = 10_000

function checkRateLimit(key: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    if (!entry && rateLimitMap.size >= RATE_LIMIT_MAX_KEYS) {
      for (const [candidateKey, candidate] of rateLimitMap) {
        if (now > candidate.resetAt) rateLimitMap.delete(candidateKey)
      }
      if (rateLimitMap.size >= RATE_LIMIT_MAX_KEYS) {
        const oldestKey = rateLimitMap.keys().next().value
        if (typeof oldestKey === 'string') rateLimitMap.delete(oldestKey)
      }
    }
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }
  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}

// =====================
// Request and response helpers
// =====================
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/

function isValidCid(cid: string): boolean {
  return CID_RE.test(cid)
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  const allowedOrigins = (Deno.env.get('CORS_ORIGIN') ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  const headers: Record<string, string> = { Vary: 'Origin' }
  if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

function jsonResponse(
  req: Request,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function exceedsRequestLimit(req: Request): boolean {
  const value = req.headers.get('content-length')
  if (!value) return false
  const size = Number(value)
  return !Number.isSafeInteger(size) || size < 0 || size > MAX_REQUEST_SIZE
}

async function readTextWithLimit(response: Response): Promise<string | null> {
  const contentLength = response.headers.get('content-length')
  if (contentLength) {
    const size = Number(contentLength)
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_CONTENT_SIZE) {
      return null
    }
  }

  if (!response.body) {
    const text = await response.text()
    return new TextEncoder().encode(text).byteLength <= MAX_CONTENT_SIZE ? text : null
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_CONTENT_SIZE) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }

  const combined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(combined)
}

type ProxyRequest =
  | { action: 'pin'; blob: Blob }
  | { action: 'fetch'; cid: string }

async function parseProxyRequest(req: Request): Promise<ProxyRequest | Response> {
  const contentType = (req.headers.get('content-type') ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()

  if (contentType === 'multipart/form-data') {
    const formData = await req.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return jsonResponse(req, { error: 'Missing file' }, 400)
    }
    return { action: 'pin', blob: file }
  }

  if (contentType !== 'application/json') {
    return jsonResponse(req, { error: 'Unsupported content type' }, 415)
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse(req, { error: 'Invalid request body' }, 400)
  }

  const payload = body as Record<string, unknown>
  if (payload.action === 'pin') {
    if (typeof payload.content !== 'string') {
      return jsonResponse(req, { error: 'Missing content' }, 400)
    }
    return {
      action: 'pin',
      blob: new Blob([payload.content], { type: 'application/json' }),
    }
  }

  if (payload.action === 'fetch') {
    if (typeof payload.cid !== 'string' || !isValidCid(payload.cid)) {
      return jsonResponse(req, { error: 'Invalid CID' }, 400)
    }
    return { action: 'fetch', cid: payload.cid }
  }

  return jsonResponse(req, { error: 'Unknown action. Use "pin" or "fetch"' }, 400)
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(req),
        'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Max-Age': '600',
      },
    })
  }

  if (req.method !== 'POST') {
    return new Response(null, {
      status: 405,
      headers: {
        ...corsHeaders(req),
        Allow: 'POST, OPTIONS',
      },
    })
  }

  if (exceedsRequestLimit(req)) {
    return jsonResponse(req, { error: 'Content too large (max 10MB)' }, 413)
  }

  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse(req, { error: 'Missing authorization' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !supabaseAnonKey) {
      return jsonResponse(req, { error: 'Service unavailable' }, 503)
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return jsonResponse(req, { error: 'Invalid token' }, 401)
    }

    if (!checkRateLimit(user.id)) {
      return jsonResponse(req, { error: 'Rate limit exceeded' }, 429)
    }

    const parsed = await parseProxyRequest(req)
    if (parsed instanceof Response) return parsed

    const gateway = (Deno.env.get('IPFS_GATEWAY')
      ?? 'https://gateway.pinata.cloud/ipfs').replace(/\/+$/, '')

    if (parsed.action === 'pin') {
      if (parsed.blob.size > MAX_CONTENT_SIZE) {
        return jsonResponse(req, { error: 'Content too large (max 10MB)' }, 413)
      }

      const pinataJwt = Deno.env.get('PINATA_JWT')
      if (!pinataJwt) {
        return jsonResponse(req, { error: 'IPFS not configured' }, 503)
      }

      const formData = new FormData()
      formData.append('file', parsed.blob, 'drop.bin')
      const pinRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pinataJwt}` },
        body: formData,
        redirect: 'error',
      })

      if (!pinRes.ok) {
        console.error('Pinata pin failed:', pinRes.status)
        return jsonResponse(req, { error: 'IPFS pin failed' }, 502)
      }

      let result: unknown
      try {
        result = await pinRes.json()
      } catch {
        return jsonResponse(req, { error: 'Invalid IPFS provider response' }, 502)
      }
      if (!result || typeof result !== 'object') {
        return jsonResponse(req, { error: 'Invalid IPFS provider response' }, 502)
      }

      const providerResult = result as Record<string, unknown>
      const cid = providerResult.IpfsHash
      if (typeof cid !== 'string' || !isValidCid(cid)) {
        return jsonResponse(req, { error: 'Invalid IPFS provider response' }, 502)
      }
      const providerSize = providerResult.PinSize
      const size = typeof providerSize === 'number'
        && Number.isSafeInteger(providerSize)
        && providerSize >= 0
        ? providerSize
        : parsed.blob.size

      return jsonResponse(req, {
        cid,
        size,
        url: `${gateway}/${cid}`,
      })
    }

    const fetchRes = await fetch(`${gateway}/${parsed.cid}`, { redirect: 'error' })
    if (!fetchRes.ok) {
      return jsonResponse(req, { error: 'CID not found' }, 404)
    }

    const data = await readTextWithLimit(fetchRes)
    if (data === null) {
      return jsonResponse(req, { error: 'Content too large' }, 413)
    }
    return jsonResponse(req, { data })
  } catch (err) {
    console.error('ipfs-proxy error:', err instanceof Error ? err.message : 'unknown error')
    return jsonResponse(req, { error: 'Internal server error' }, 500)
  }
})
