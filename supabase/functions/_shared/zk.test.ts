// deno test --allow-read --allow-net supabase/functions/_shared/
// Fixtures: real sound_geo_only Groth16 proofs (Tokyo, and Buenos Aires for
// negative coordinates) generated with the project's trusted-setup zkey.
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { publicSignalsBindToDrop, toField, verifyZkProximity } from './zk.ts'

const fixtures = JSON.parse(
  await Deno.readTextFile(new URL('./testdata/sound-geo-only-proofs.json', import.meta.url)),
)
const vkey = await Deno.readTextFile(
  new URL('../../../packages/geo-drop/circuits/sound_geo_only_vkey.json', import.meta.url),
)

Deno.test('negative coordinates are compared as field elements', () => {
  assertEquals(toField(-1n), toField(-1n + 21888242871839275222246405745257275088548364400416034343698204186575808495617n))
  const { drop, publicSignals } = fixtures.buenos_aires
  assert(publicSignalsBindToDrop(publicSignals, drop))
})

Deno.test('valid proofs verify in both hemispheres (SDK submission shape)', async () => {
  for (const name of ['tokyo', 'buenos_aires']) {
    const { drop, proof, publicSignals } = fixtures[name]
    assert(await verifyZkProximity([{ method: 'zkp', data: { proof, publicSignals } }], drop, vkey), name)
  }
})

Deno.test('a proof for one drop does not unlock another', async () => {
  const { proof, publicSignals } = fixtures.tokyo
  const other = { ...fixtures.tokyo.drop, lat: fixtures.tokyo.drop.lat + 0.01 }
  assertEquals(await verifyZkProximity([{ method: 'zkp', data: { proof, publicSignals } }], other, vkey), false)
})

Deno.test('a proof that is not for these signals fails the pairing check', async () => {
  // Signals bind to the Tokyo drop, so only the Groth16 check can reject this.
  const { drop, publicSignals } = fixtures.tokyo
  const foreignProof = fixtures.buenos_aires.proof
  assertEquals(await verifyZkProximity([{ method: 'zkp', data: { proof: foreignProof, publicSignals } }], drop, vkey), false)
})

Deno.test('missing proof and wrong or missing vkey are rejected', async () => {
  const { drop, proof, publicSignals } = fixtures.tokyo
  assertEquals(await verifyZkProximity([{ method: 'zkp', data: { publicSignals } }], drop, vkey), false)
  assertEquals(await verifyZkProximity([], drop, vkey), false)
  const eightSignalKey = JSON.stringify({ ...JSON.parse(vkey), nPublic: 8 })
  assertEquals(await verifyZkProximity([{ method: 'zkp', data: { proof, publicSignals } }], drop, eightSignalKey), false)
  assertEquals(await verifyZkProximity([{ method: 'zkp', data: { proof, publicSignals } }], drop, undefined), false)
})

Deno.test('legacy flat submission shape still verifies', async () => {
  const { drop, proof, publicSignals } = fixtures.tokyo
  assert(await verifyZkProximity([{ method: 'zkp', proof, publicSignals }], drop, vkey))
})
