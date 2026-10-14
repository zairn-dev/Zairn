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
import {
  isValidCid,
  jsonResponse,
  methodNotAllowed,
  preflightResponse,
  readBytesWithLimit,
  readTextWithLimit,
} from '../_shared/http.ts'
import { maybeCleanupRateLimits, withinRateLimits } from '../_shared/rate-limit.ts'
import { PinningUnavailableError, pinToPinata } from '../_shared/pinata.ts'

const MAX_CONTENT_SIZE = 10 * 1024 * 1024
const MAX_REQUEST_SIZE = MAX_CONTENT_SIZE + 1024 * 1024
const REQUEST_LIMIT = { max: 20, windowSeconds: 60 }
// Bounds what one account can pin to the project's Pinata account per day.
const DAILY_PIN_LIMIT = { max: 100, windowSeconds: 86_400 }

type ProxyRequest =
  | { action: 'pin'; blob: Blob }
  | { action: 'fetch'; cid: string }

/**
 * The body is read once under MAX_REQUEST_SIZE (chunked bodies without a
 * content-length included) before any multipart or JSON parsing.
 */
async function parseProxyRequest(req: Request): Promise<ProxyRequest | Response> {
  const contentTypeHeader = req.headers.get('content-type') ?? ''
  const contentType = contentTypeHeader.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'multipart/form-data' && contentType !== 'application/json') {
    return jsonResponse(req, { error: 'Unsupported content type' }, 415)
  }

  const bytes = await readBytesWithLimit(req, MAX_REQUEST_SIZE)
  if (bytes === null) return jsonResponse(req, { error: 'Content too large (max 10MB)' }, 413)

  if (contentType === 'multipart/form-data') {
    let formData: FormData
    try {
      formData = await new Response(bytes, { headers: { 'content-type': contentTypeHeader } }).formData()
    } catch {
      return jsonResponse(req, { error: 'Invalid multipart body' }, 400)
    }
    const file = formData.get('file')
    if (!(file instanceof File)) return jsonResponse(req, { error: 'Missing file' }, 400)
    return { action: 'pin', blob: file }
  }

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return jsonResponse(req, { error: 'Invalid JSON' }, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse(req, { error: 'Invalid request body' }, 400)
  }

  const payload = body as Record<string, unknown>
  if (payload.action === 'pin') {
    if (typeof payload.content !== 'string') return jsonResponse(req, { error: 'Missing content' }, 400)
    return { action: 'pin', blob: new Blob([payload.content], { type: 'application/json' }) }
  }
  if (payload.action === 'fetch') {
    if (!isValidCid(payload.cid)) return jsonResponse(req, { error: 'Invalid CID' }, 400)
    return { action: 'fetch', cid: payload.cid }
  }
  return jsonResponse(req, { error: 'Unknown action. Use "pin" or "fetch"' }, 400)
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflightResponse(req)
  if (req.method !== 'POST') return methodNotAllowed(req)

  try {
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return jsonResponse(req, { error: 'Missing authorization' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !supabaseAnonKey || !serviceKey) {
      return jsonResponse(req, { error: 'Service unavailable' }, 503)
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return jsonResponse(req, { error: 'Invalid token' }, 401)
    }

    const adminClient = createClient(supabaseUrl, serviceKey)
    if (!(await withinRateLimits(adminClient, [{ key: `ipfs-proxy:${user.id}`, ...REQUEST_LIMIT }]))) {
      return jsonResponse(req, { error: 'Rate limit exceeded' }, 429)
    }
    maybeCleanupRateLimits(adminClient)

    const parsed = await parseProxyRequest(req)
    if (parsed instanceof Response) return parsed

    const gateway = (Deno.env.get('IPFS_GATEWAY')
      ?? 'https://gateway.pinata.cloud/ipfs').replace(/\/+$/, '')

    if (parsed.action === 'pin') {
      if (parsed.blob.size > MAX_CONTENT_SIZE) {
        return jsonResponse(req, { error: 'Content too large (max 10MB)' }, 413)
      }
      if (!(await withinRateLimits(adminClient, [{ key: `ipfs-pin-daily:${user.id}`, ...DAILY_PIN_LIMIT }]))) {
        return jsonResponse(req, { error: 'Daily pin limit reached' }, 429)
      }

      try {
        const { cid, size } = await pinToPinata(parsed.blob)
        return jsonResponse(req, { cid, size, url: `${gateway}/${cid}` })
      } catch (pinErr) {
        if (pinErr instanceof PinningUnavailableError) {
          return jsonResponse(req, { error: 'IPFS not configured' }, 503)
        }
        console.error('ipfs-proxy pin error:', pinErr instanceof Error ? pinErr.message : pinErr)
        return jsonResponse(req, { error: 'IPFS pin failed' }, 502)
      }
    }

    const fetchRes = await fetch(`${gateway}/${parsed.cid}`, { redirect: 'error' })
    if (!fetchRes.ok) {
      return jsonResponse(req, { error: 'CID not found' }, 404)
    }

    const data = await readTextWithLimit(fetchRes, MAX_CONTENT_SIZE)
    if (data === null) {
      return jsonResponse(req, { error: 'Content too large' }, 413)
    }
    return jsonResponse(req, { data })
  } catch (err) {
    console.error('ipfs-proxy error:', err instanceof Error ? err.message : 'unknown error')
    return jsonResponse(req, { error: 'Internal server error' }, 500)
  }
})
