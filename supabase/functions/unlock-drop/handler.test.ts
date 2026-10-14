// deno test -A supabase/functions/unlock-drop/
// Exercises the unlock handler against an in-memory fake of the Supabase
// client: RLS visibility is modelled as a per-user set of visible drop ids.
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { handleUnlock } from './handler.ts'
import { computeTrustScore, gateTrustScore } from '../_shared/trust-scorer.ts'
import { deriveLocationKey, encrypt, hashPassword } from '../_shared/drop-crypto.ts'
import { FakeDb, fakeDeps as deps, jsonRequest, setTestEnv, TEST_USER as USER } from '../_shared/testing/fake-supabase.ts'
import type { Row } from '../_shared/testing/fake-supabase.ts'

const ORIGIN = 'https://app.test'
setTestEnv()

const hashSecret = hashPassword

async function makeDrop(db: FakeDb, extra: Row = {}) {
  const drop: Row = {
    id: crypto.randomUUID(), lat: 35.6812, lon: 139.7671, geohash: 'xn76urx', unlock_radius_meters: 50,
    status: 'active', expires_at: null, encryption_salt: 'salt-1', key_derivation_version: 2,
    server_secret_version: 1, password_hash: null, proof_config: null, proof_secret_hashes: null, ...extra,
  }
  const key = deriveLocationKey(drop.geohash, drop.id, drop.encryption_salt, 'server-secret', 2)
  drop.encrypted_content = JSON.stringify(await encrypt('hello treasure', key))
  db.tables.geo_drops.push(drop)
  return drop
}

const unlockRequest = (body: Row) => jsonRequest('unlock-drop', body)

Deno.test('a drop the caller cannot see is reported as not found and nothing is logged', async () => {
  const db = new FakeDb()
  const drop = await makeDrop(db)
  const res = await handleUnlock(unlockRequest({ drop_id: drop.id, lat: drop.lat, lon: drop.lon }), deps(db))
  assertEquals(res.status, 404)
  assertEquals(res.headers.get('access-control-allow-origin'), ORIGIN)
  assertEquals(db.tables.drop_location_logs.length, 0)
})

Deno.test('a visible drop unlocks at its location; only verification outcomes are stored', async () => {
  const db = new FakeDb()
  const drop = await makeDrop(db)
  db.visible.add(drop.id)
  const res = await handleUnlock(unlockRequest({ drop_id: drop.id, lat: drop.lat, lon: drop.lon, accuracy: 5 }), deps(db))
  assertEquals(res.status, 200)
  const body = await res.json()
  assertEquals(body.content, 'hello treasure')
  const claim = db.rpcCalls.find((c) => c.name === 'claim_drop')
  assert(claim, 'claim_drop called')
  assertEquals(claim.args.p_proof_results, [{ method: 'gps', verified: true }])
  assertEquals(db.tables.drop_location_logs.map((l) => l.action), ['unlock_attempt'])
})

Deno.test('too far is rejected and still recorded as an unlock attempt', async () => {
  const db = new FakeDb()
  const drop = await makeDrop(db)
  db.visible.add(drop.id)
  const res = await handleUnlock(unlockRequest({ drop_id: drop.id, lat: drop.lat + 0.01, lon: drop.lon }), deps(db))
  assertEquals(res.status, 403)
  assertEquals((await res.json()).code, 'too_far')
  assertEquals(db.tables.drop_location_logs.length, 1)
})

Deno.test('client-written search logs are not trusted as unlock history', async () => {
  const db = new FakeDb()
  const drop = await makeDrop(db)
  db.visible.add(drop.id)
  // A client-written row 500 km away one second ago would read as a
  // teleport and be denied if the gate trusted client rows; it must be ignored.
  db.tables.drop_location_logs.push({ user_id: USER.id, lat: drop.lat + 4.5, lon: drop.lon, action: 'search',
    created_at: new Date(Date.now() - 1000).toISOString() })
  const res = await handleUnlock(unlockRequest({ drop_id: drop.id, lat: drop.lat, lon: drop.lon, accuracy: 5 }), deps(db))
  assertEquals(res.status, 200)
})

async function stepUpHistory(drop: Row) {
  // Find a previous position that makes the gate demand step-up.
  for (const km of [1, 2, 3, 5, 8, 12, 20, 40]) {
    const prev = { lat: drop.lat + km / 111.32, lon: drop.lon, accuracy: null, timestamp: new Date(Date.now() - 60_000).toISOString() }
    const decision = gateTrustScore(computeTrustScore(
      { lat: drop.lat, lon: drop.lon, accuracy: 5, timestamp: new Date().toISOString() }, [prev]))
    if (decision === 'step-up') return prev
  }
  throw new Error('no step-up configuration found')
}

Deno.test('a junk non-GPS proof does not satisfy a trust step-up', async () => {
  const db = new FakeDb()
  const drop = await makeDrop(db, { proof_config: { mode: 'all', requirements: [{ method: 'gps' }] } })
  db.visible.add(drop.id)
  const prev = await stepUpHistory(drop)
  db.tables.drop_location_logs.push({ user_id: USER.id, lat: prev.lat, lon: prev.lon, action: 'unlock_attempt', created_at: prev.timestamp })
  const res = await handleUnlock(unlockRequest({
    drop_id: drop.id, lat: drop.lat, lon: drop.lon, accuracy: 5, proofs: [{ method: 'ar', data: {} }],
  }), deps(db))
  assertEquals(res.status, 403)
  const body = await res.json()
  assertEquals(body.code, 'step_up_required')
  assertEquals(body.trust_score, undefined, 'scores are not disclosed')
  assertEquals(db.rpcCalls.some((c) => c.name === 'claim_drop'), false)
})

Deno.test('a verified optional secret satisfies a trust step-up', async () => {
  const db = new FakeDb()
  const drop = await makeDrop(db, {
    proof_config: { mode: 'all', requirements: [{ method: 'gps' }, { method: 'secret', required: false }] },
    proof_secret_hashes: { '1': await hashSecret('open sesame') },
  })
  db.visible.add(drop.id)
  const prev = await stepUpHistory(drop)
  db.tables.drop_location_logs.push({ user_id: USER.id, lat: prev.lat, lon: prev.lon, action: 'unlock_attempt', created_at: prev.timestamp })
  const res = await handleUnlock(unlockRequest({
    drop_id: drop.id, lat: drop.lat, lon: drop.lon, accuracy: 5,
    proofs: [{ method: 'secret', data: { secret: 'open sesame' } }],
  }), deps(db))
  assertEquals(res.status, 200)
  const stored = db.rpcCalls.find((c) => c.name === 'claim_drop')!.args.p_proof_results
  assertEquals(JSON.stringify(stored).includes('open sesame'), false, 'submitted secret is never stored')
})

Deno.test('max claims reached is reported without content', async () => {
  const db = new FakeDb()
  db.claimRows = [{ claimed: false, claim_id: null, claimed_at: null }]
  const drop = await makeDrop(db)
  db.visible.add(drop.id)
  const res = await handleUnlock(unlockRequest({ drop_id: drop.id, lat: drop.lat, lon: drop.lon }), deps(db))
  assertEquals(res.status, 409)
  const body = await res.json()
  assertEquals(body.code, 'max_claims_reached')
  assertEquals(body.content, undefined)
})

Deno.test('malformed input is rejected before any lookup', async () => {
  const db = new FakeDb()
  for (const body of [
    { drop_id: 'not-a-uuid', lat: 1, lon: 1 },
    { drop_id: crypto.randomUUID(), lat: '35', lon: 139 },
    { drop_id: crypto.randomUUID(), lat: 35, lon: 181 },
  ]) {
    const res = await handleUnlock(unlockRequest(body), deps(db))
    assertEquals(res.status, 400, JSON.stringify(body))
  }
  assertEquals(db.rpcCalls.length, 0)
})

Deno.test('CORS preflight allows the headers supabase-js sends', async () => {
  const res = await handleUnlock(new Request('http://fn.test/unlock-drop', {
    method: 'OPTIONS', headers: { origin: ORIGIN },
  }), deps(new FakeDb()))
  assertEquals(res.status, 204)
  assertEquals(res.headers.get('access-control-allow-origin'), ORIGIN)
  for (const h of ['authorization', 'apikey', 'content-type', 'x-client-info']) {
    assert(res.headers.get('access-control-allow-headers')!.includes(h), h)
  }
  const other = await handleUnlock(new Request('http://fn.test/unlock-drop', {
    method: 'OPTIONS', headers: { origin: 'https://evil.test' },
  }), deps(new FakeDb()))
  assertEquals(other.headers.get('access-control-allow-origin'), null)
})
