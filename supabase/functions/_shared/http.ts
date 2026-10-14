/**
 * HTTP helpers shared by the Edge Functions: CORS allowlist, JSON responses,
 * and size-capped body reading.
 *
 * CORS_ORIGIN is a comma-separated allowlist of browser origins. When it is
 * unset no Access-Control-Allow-Origin header is sent, so browsers are
 * refused (server-to-server callers are unaffected).
 */

const ALLOWED_HEADERS = 'authorization, x-client-info, apikey, content-type'

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  const allowed = (Deno.env.get('CORS_ORIGIN') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const headers: Record<string, string> = { Vary: 'Origin' }
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

export function preflightResponse(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(req),
      'Access-Control-Allow-Headers': ALLOWED_HEADERS,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    },
  })
}

export function methodNotAllowed(req: Request): Response {
  return new Response(null, {
    status: 405,
    headers: { ...corsHeaders(req), Allow: 'POST, OPTIONS' },
  })
}

export function jsonResponse(req: Request, body: Record<string, unknown>, status = 200): Response {
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

/**
 * Read a body stream, giving up (null) as soon as it exceeds maxBytes.
 * A declared content-length larger than the cap is rejected up front;
 * chunked bodies without one are still capped while streaming.
 */
export async function readBytesWithLimit(
  source: Request | Response,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = source.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) return null
  }
  if (!source.body) return new Uint8Array(0)

  const reader = source.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export async function readTextWithLimit(
  source: Request | Response,
  maxBytes: number,
): Promise<string | null> {
  const bytes = await readBytesWithLimit(source, maxBytes)
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

export const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/

export function isValidCid(cid: unknown): cid is string {
  return typeof cid === 'string' && CID_RE.test(cid)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
