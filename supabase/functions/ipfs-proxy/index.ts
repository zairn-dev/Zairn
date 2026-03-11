/**
 * Supabase Edge Function: ipfs-proxy
 *
 * Proxies IPFS pinning API calls so that API keys are never exposed to the client.
 * Supports Pinata pinning (upload + fetch).
 *
 * POST /ipfs-proxy  { action: "pin", content: "..." }
 * POST /ipfs-proxy  { action: "fetch", cid: "Qm..." }
 *
 * Environment variables:
 *   PINATA_JWT — Pinata API JWT token
 *   IPFS_GATEWAY — IPFS gateway URL (default: https://gateway.pinata.cloud/ipfs)
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'

// =====================
// Rate limiting
// =====================
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60_000

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
// CID validation
// =====================
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/
function isValidCid(cid: string): boolean {
  return CID_RE.test(cid)
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': Deno.env.get('CORS_ORIGIN') ?? Deno.env.get('SUPABASE_URL') ?? '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      },
    })
  }

  try {
    // Verify user auth first (rate limit by authenticated user ID, not spoofable IP)
    const authHeader = req.headers.get('authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401 })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401 })
    }

    if (!checkRateLimit(user.id)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { action, content, cid } = await req.json()
    const pinataJwt = Deno.env.get('PINATA_JWT')
    const gateway = Deno.env.get('IPFS_GATEWAY') ?? 'https://gateway.pinata.cloud/ipfs'

    if (action === 'pin') {
      if (!pinataJwt) {
        return new Response(JSON.stringify({ error: 'IPFS not configured' }), { status: 503 })
      }
      if (!content || typeof content !== 'string') {
        return new Response(JSON.stringify({ error: 'Missing content' }), { status: 400 })
      }
      // Max content size: 10MB
      if (content.length > 10 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Content too large (max 10MB)' }), { status: 400 })
      }

      const blob = new Blob([content], { type: 'application/json' })
      const formData = new FormData()
      formData.append('file', blob, 'drop.json')

      const pinRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: { Authorization: `Bearer ${pinataJwt}` },
        body: formData,
      })

      if (!pinRes.ok) {
        const err = await pinRes.text()
        console.error('Pinata error:', err)
        return new Response(JSON.stringify({ error: 'IPFS pin failed' }), { status: 502 })
      }

      const result = await pinRes.json()
      return new Response(JSON.stringify({
        cid: result.IpfsHash,
        size: result.PinSize,
        url: `${gateway}/${result.IpfsHash}`,
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': Deno.env.get('CORS_ORIGIN') ?? Deno.env.get('SUPABASE_URL') ?? '*',
        },
      })
    }

    if (action === 'fetch') {
      if (!cid || !isValidCid(cid)) {
        return new Response(JSON.stringify({ error: 'Invalid CID' }), { status: 400 })
      }

      const fetchRes = await fetch(`${gateway}/${cid}`)
      if (!fetchRes.ok) {
        return new Response(JSON.stringify({ error: 'CID not found' }), { status: 404 })
      }

      // Enforce 10MB size limit before reading body into memory
      const contentLength = fetchRes.headers.get('content-length')
      if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Content too large' }), { status: 400 })
      }

      const data = await fetchRes.text()
      if (data.length > 10 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'Content too large' }), { status: 400 })
      }
      return new Response(JSON.stringify({ data }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': Deno.env.get('CORS_ORIGIN') ?? Deno.env.get('SUPABASE_URL') ?? '*',
        },
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action. Use "pin" or "fetch"' }), { status: 400 })
  } catch (err) {
    console.error('ipfs-proxy error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500 })
  }
})
