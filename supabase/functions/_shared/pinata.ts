/**
 * Server-side Pinata pinning. PINATA_JWT stays in the function environment
 * and never reaches clients.
 */
import { isValidCid } from './http.ts'

export class PinningUnavailableError extends Error {}

export interface PinResult {
  cid: string
  size: number
}

/** Pin a blob and return its CID. Throws on provider errors or bad responses. */
export async function pinToPinata(blob: Blob, filename = 'drop.bin'): Promise<PinResult> {
  const jwt = Deno.env.get('PINATA_JWT')
  if (!jwt) throw new PinningUnavailableError('IPFS pinning is not configured')

  const form = new FormData()
  form.append('file', blob, filename)
  const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
    redirect: 'error',
  })
  if (!res.ok) throw new Error(`Pinata pin failed: ${res.status}`)

  const result = await res.json().catch(() => null) as Record<string, unknown> | null
  const cid = result?.IpfsHash
  if (!isValidCid(cid)) throw new Error('Invalid IPFS provider response')
  const size = result?.PinSize
  return {
    cid,
    size: typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 ? size : blob.size,
  }
}
