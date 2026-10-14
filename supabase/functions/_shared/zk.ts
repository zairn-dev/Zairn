/**
 * Server-side Groth16 verification for zk-method GeoDrops.
 *
 * Only the sound_geo_only circuit layout is accepted (5 public signals):
 *   [0] valid(=1) [1] targetLat [2] targetLon [3] radiusSquared [4] cosLatScaled
 * The verification key is server config (GEODROP_ZKP_VKEY), never taken
 * from the drop. A proof for this circuit carries no session context, so a
 * valid proof stays replayable for the same drop; context binding needs the
 * zairn_zkp circuit plus a server-issued challenge (not implemented here).
 */

/** BN254 scalar field modulus; circuit inputs are reduced modulo this. */
export const BN254_P =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n

const SCALE = 1_000_000
const DEG2RAD = Math.PI / 180
const METERS_PER_DEG_LAT = 111_320
const SOUND_GEO_ONLY_PUBLIC_SIGNALS = 5

export function toFixedPoint(deg: number): bigint {
  return BigInt(Math.round(deg * SCALE))
}
export function metersToRadiusSquared(meters: number): bigint {
  const rFp = BigInt(Math.round((meters / METERS_PER_DEG_LAT) * SCALE))
  return rFp * rFp
}
export function cosLatScaled(latDeg: number): bigint {
  return BigInt(Math.round(Math.cos(latDeg * DEG2RAD) * SCALE))
}

/** Field representation of a signed value (negative x is encoded as p - |x|). */
export function toField(x: bigint): bigint {
  return ((x % BN254_P) + BN254_P) % BN254_P
}

export interface DropGeometry {
  lat: number
  lon: number
  unlock_radius_meters: number
}

/** True when the public signals state exactly this drop's geometry. */
export function publicSignalsBindToDrop(publicSignals: unknown, drop: DropGeometry): boolean {
  if (!Array.isArray(publicSignals) || publicSignals.length !== SOUND_GEO_ONLY_PUBLIC_SIGNALS) return false
  const expected = [
    1n,
    toFixedPoint(drop.lat),
    toFixedPoint(drop.lon),
    metersToRadiusSquared(drop.unlock_radius_meters),
    cosLatScaled(drop.lat),
  ]
  try {
    return expected.every((value, i) =>
      typeof publicSignals[i] === 'string' && BigInt(publicSignals[i]) === toField(value))
  } catch {
    return false
  }
}

// deno-lint-ignore no-explicit-any
let snarkjsPromise: Promise<any> | null = null

// deno-lint-ignore no-explicit-any
async function loadSnarkjs(): Promise<any> {
  snarkjsPromise ??= (async () => {
    // The es2022 (browser) build: the Deno build pulls in the `web-worker`
    // package, which imports node:vm, and the Edge Functions bundler rejects
    // that ("Unknown built-in node: module: vm"), so the function could not
    // be deployed.
    const snarkjs = await import('https://esm.sh/snarkjs@0.7.5?target=es2022&no-dts')
    // ffjavascript (snarkjs's field library) spawns worker threads by
    // default, which fail under Deno, so every verification threw. Seed its
    // curve cache with a single-threaded curve. The module resets the cache
    // when it loads, so this must run after snarkjs — and the same
    // ffjavascript module it imports — have loaded.
    const ff = await import('https://esm.sh/ffjavascript@0.3.1/es2022/ffjavascript.mjs')
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any
    g.curve_bn128 ??= await ff.buildBn128(true)
    return snarkjs
  })()
  return snarkjsPromise
}

/**
 * Find the zk submission (SDK shape: { method, data: { proof, publicSignals } };
 * the flat legacy shape is also accepted) and verify it against the server
 * vkey and this drop. Any missing config, malformed input or bad proof → false.
 */
export async function verifyZkProximity(
  // deno-lint-ignore no-explicit-any
  proofs: any[] | null | undefined,
  drop: DropGeometry,
  vkeyJson: string | undefined = Deno.env.get('GEODROP_ZKP_VKEY'),
): Promise<boolean> {
  if (!vkeyJson) {
    console.error('GEODROP_ZKP_VKEY not set — cannot verify zk-required drop; rejecting')
    return false
  }
  // deno-lint-ignore no-explicit-any
  let vkey: any
  try { vkey = JSON.parse(vkeyJson) } catch { return false }
  if (vkey?.nPublic !== SOUND_GEO_ONLY_PUBLIC_SIGNALS) {
    console.error('GEODROP_ZKP_VKEY must be the sound_geo_only key (5 public signals); rejecting')
    return false
  }

  // deno-lint-ignore no-explicit-any
  const sub = (proofs ?? []).find((p: any) =>
    p?.method === 'zkp' || p?.method === 'zk' || p?.method === 'zk-proximity')
  const proof = sub?.data?.proof ?? sub?.proof
  const publicSignals = sub?.data?.publicSignals ?? sub?.publicSignals
  if (!proof || typeof proof !== 'object') return false
  if (!publicSignalsBindToDrop(publicSignals, drop)) return false

  try {
    const snarkjs = await loadSnarkjs()
    return (await snarkjs.groth16.verify(vkey, publicSignals, proof)) === true
  } catch (e) {
    console.error('snarkjs verify failed:', e instanceof Error ? e.message : e)
    return false
  }
}
