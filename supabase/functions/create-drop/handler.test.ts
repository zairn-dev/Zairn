// deno test -A supabase/functions/create-drop/
import { assert, assertEquals, assertMatch } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { handleCreate } from './handler.ts'
import { handleUnlock } from '../unlock-drop/handler.ts'
import { encodeGeohash } from '../_shared/geohash.ts'
import { FakeDb, fakeDeps, jsonRequest, setTestEnv } from '../_shared/testing/fake-supabase.ts'
import type { Row } from '../_shared/testing/fake-supabase.ts'

setTestEnv()

const TOKYO = { lat: 35.6812, lon: 139.7671 }
const base = (extra: Row = {}) => ({ title: 'Treasure', content_type: 'text', content: 'hello treasure', ...TOKYO, ...extra })

async function create(db: FakeDb, body: Row) {
  const res = await handleCreate(jsonRequest('create-drop', body), fakeDeps(db, db.user))
  return { res, body: await res.json() }
}

async function unlock(db: FakeDb, dropId: string, extra: Row = {}) {
  db.visible.add(dropId)
  const res = await handleUnlock(jsonRequest('unlock-drop', { drop_id: dropId, ...TOKYO, accuracy: 5, ...extra }), fakeDeps(db))
  return { res, body: await res.json() }
}

Deno.test('creates a drop the client cannot decrypt but unlock-drop can', async () => {
  const db = new FakeDb()
  const { res, body } = await create(db, base())
  assertEquals(res.status, 201)

  const stored = db.tables.geo_drops[0]
  assertEquals(stored.creator_id, db.user.id)
  assertEquals(stored.geohash, encodeGeohash(TOKYO.lat, TOKYO.lon))
  assertEquals(stored.key_derivation_version, 2)
  assertEquals(stored.server_secret_version, 1)
  assert(!stored.encrypted_content.includes('hello treasure'), 'content is stored encrypted')
  assertMatch(stored.encryption_salt, /^[0-9a-f]{32}$/)

  // The response carries only client-readable columns.
  for (const secret of ['encryption_salt', 'encrypted_content', 'password_hash', 'proof_secret_hashes']) {
    assertEquals(secret in body.drop, false, secret)
  }

  const opened = await unlock(db, body.drop.id)
  assertEquals(opened.res.status, 200)
  assertEquals(opened.body.content, 'hello treasure')
})

Deno.test('passwords and secrets are stored only as hashes and still unlock', async () => {
  const db = new FakeDb()
  const { body } = await create(db, base({
    visibility: 'password',
    password: 'pw-1234',
    proof_config: { mode: 'all', requirements: [{ method: 'gps' }, { method: 'secret', params: { secret: 'open sesame', label: 'Sign' } }] },
  }))
  const stored = db.tables.geo_drops[0]
  assertEquals(JSON.stringify(stored).includes('open sesame'), false)
  assertEquals(JSON.stringify(stored).includes('pw-1234'), false)
  assertEquals(stored.proof_config.requirements[1].params, { label: 'Sign' })
  assertMatch(stored.proof_secret_hashes['1'], /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)

  const wrong = await unlock(db, body.drop.id, { password: 'pw-1234', proofs: [{ method: 'secret', data: { secret: 'nope' } }] })
  assertEquals(wrong.res.status, 403)
  const right = await unlock(db, body.drop.id, { password: 'pw-1234', proofs: [{ method: 'secret', data: { secret: 'open sesame' } }] })
  assertEquals(right.res.status, 200)
  assertEquals(right.body.content, 'hello treasure')
})

Deno.test('drops nobody could ever unlock are refused at creation', async () => {
  const db = new FakeDb()
  const ar = await create(db, base({ proof_config: { requirements: [{ method: 'ar' }] } }))
  assertEquals(ar.res.status, 400)
  assertMatch(ar.body.error, /cannot be verified by the server/)

  const zk = await create(db, base({ proof_config: { requirements: [{ method: 'zkp' }] } }))
  assertEquals(zk.res.status, 400, 'no GEODROP_ZKP_VKEY configured')

  const optionalAr = await create(db, base({ proof_config: { requirements: [{ method: 'gps' }, { method: 'ar', required: false }] } }))
  assertEquals(optionalAr.res.status, 201, 'optional unverifiable methods are fine')
})

Deno.test('malformed input is rejected and nothing is stored', async () => {
  for (const bad of [
    base({ lat: 91 }),
    base({ lon: '139' }),
    base({ unlock_radius_meters: 0 }),
    base({ title: '' }),
    base({ content: '' }),
    base({ content_type: 'exe' }),
    base({ visibility: 'password' }),
    base({ expires_at: '2000-01-01T00:00:00Z' }),
    base({ max_claims: 0 }),
    base({ shared_with: ['not-a-uuid'] }),
    base({ metadata: { blob: 'x'.repeat(9000) } }),
    base({ storage: 'floppy' }),
  ]) {
    const db = new FakeDb() // fresh user: stay under the per-minute create limit
    const { res } = await create(db, bad)
    assertEquals(res.status, 400, JSON.stringify(bad).slice(0, 80))
    assertEquals(db.tables.geo_drops.length, 0)
  }
})

Deno.test('private drops are shared only with the listed users', async () => {
  const db = new FakeDb()
  const friend = crypto.randomUUID()
  await create(db, base({ visibility: 'private', shared_with: [friend, friend, db.user.id] }))
  assertEquals(db.tables.drop_shares.map((s) => s.user_id), [friend])

  await create(db, base({ visibility: 'public', shared_with: [crypto.randomUUID()] }))
  assertEquals(db.tables.drop_shares.length, 1, 'shares are ignored for non-private drops')
})

Deno.test('without the server secret no drop is created', async () => {
  const db = new FakeDb()
  Deno.env.delete('GEODROP_ENCRYPTION_SECRET')
  try {
    const { res } = await create(db, base())
    assertEquals(res.status, 503)
    assertEquals(db.tables.geo_drops.length, 0)
  } finally {
    Deno.env.set('GEODROP_ENCRYPTION_SECRET', 'server-secret')
  }
})

Deno.test('IPFS storage pins the ciphertext with the server key', async () => {
  const db = new FakeDb()
  const cid = `Qm${'a'.repeat(44)}`
  const realFetch = globalThis.fetch
  let pinned = ''
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    assertEquals(String(input), 'https://api.pinata.cloud/pinning/pinFileToIPFS')
    assertEquals(new Headers(init?.headers).get('authorization'), 'Bearer pinata-jwt')
    pinned = await ((init?.body as FormData).get('file') as Blob).text()
    return new Response(JSON.stringify({ IpfsHash: cid, PinSize: 10 }), { status: 200 })
  }
  try {
    Deno.env.delete('PINATA_JWT')
    assertEquals((await create(db, base({ storage: 'ipfs' }))).res.status, 503, 'pinning not configured')

    Deno.env.set('PINATA_JWT', 'pinata-jwt')
    const { res } = await create(db, base({ storage: 'ipfs' }))
    assertEquals(res.status, 201)
    const stored = db.tables.geo_drops.at(-1)!
    assertEquals(stored.ipfs_cid, cid)
    assertEquals(stored.encrypted_content, null)
    assert(pinned.includes('ciphertext') && !pinned.includes('hello treasure'), 'only ciphertext leaves the server')
  } finally {
    globalThis.fetch = realFetch
    Deno.env.delete('PINATA_JWT')
  }
})

Deno.test('creation is rate limited before any work is done', async () => {
  const db = new FakeDb()
  db.rateLimitAllowed = false
  const { res } = await create(db, base())
  assertEquals(res.status, 429)
  assertEquals(db.tables.geo_drops.length, 0)
})
