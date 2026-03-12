/**
 * Zero-Knowledge Proof of Location
 *
 * Proves proximity to a target location without revealing exact coordinates.
 * Uses Groth16 (snarkjs) with a circom circuit that verifies:
 *   dLat² + (dLon × cos(lat))² ≤ R²
 * in fixed-point arithmetic (scale factor 1e6 ≈ ~0.11m per unit).
 *
 * Flow:
 *   1. Drop creator sets proof_config with method 'zkp' and params { verification_key }
 *   2. Claimer calls generateProximityProof(userLat, userLon, drop)
 *      → returns { proof, publicSignals } without exposing exact coordinates
 *   3. Verifier calls verifyProximityProof(proof, publicSignals, verificationKey)
 *      → returns boolean
 *
 * Circuit artifacts (wasm + zkey) are loaded from a configurable base URL
 * or can be provided directly. For production, host compiled artifacts on CDN.
 */

// =====================
// Constants
// =====================

/** Fixed-point scale factor — 1 unit ≈ 0.11m at equator */
const SCALE = 1_000_000;

/** Degrees to radians */
const DEG2RAD = Math.PI / 180;

/**
 * Approximate meters per degree of latitude (constant globally).
 * 111,320m per degree is the standard WGS84 approximation.
 */
const METERS_PER_DEG_LAT = 111_320;

// =====================
// Types
// =====================

/** Raw snarkjs proof object (Groth16) */
export interface Groth16Proof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: 'groth16';
  curve: 'bn128';
}

/** Result of proof generation */
export interface ZkProximityProof {
  proof: Groth16Proof;
  publicSignals: string[];
}

/** Artifacts needed for proof generation */
export interface CircuitArtifacts {
  /** URL or Buffer of the compiled circuit WASM */
  wasmUrl: string;
  /** URL or Buffer of the proving key (zkey) */
  zkeyUrl: string;
}

/** Verification key (JSON exported from snarkjs) */
export type VerificationKey = Record<string, unknown>;

/** Configuration for the ZKP module */
export interface ZkpConfig {
  /** Base URL where circuit artifacts are hosted */
  artifactsBaseUrl?: string;
  /** Direct artifact references (overrides artifactsBaseUrl) */
  artifacts?: CircuitArtifacts;
  /** Verification key for proof verification */
  verificationKey?: VerificationKey;
}

// =====================
// Coordinate conversion
// =====================

/**
 * Convert lat/lon in degrees to fixed-point integers (×1e6).
 * Each unit ≈ 0.11m at equator.
 */
export function toFixedPoint(degrees: number): bigint {
  return BigInt(Math.round(degrees * SCALE));
}

/**
 * Convert a radius in meters to squared fixed-point units.
 * This is the value used as `radiusSquared` public input.
 *
 * R_deg = R_meters / METERS_PER_DEG_LAT
 * R_fp  = R_deg × SCALE
 * radiusSquared = R_fp²
 */
export function metersToRadiusSquared(meters: number): bigint {
  const rDeg = meters / METERS_PER_DEG_LAT;
  const rFp = BigInt(Math.round(rDeg * SCALE));
  return rFp * rFp;
}

/**
 * Compute cos(lat) × SCALE as an integer.
 * Used as the `cosLatScaled` public input for longitude correction.
 */
export function cosLatScaled(latDegrees: number): bigint {
  return BigInt(Math.round(Math.cos(latDegrees * DEG2RAD) * SCALE));
}

// =====================
// Proof generation
// =====================

/**
 * Generate a ZK proximity proof.
 *
 * Proves the user is within `unlockRadius` meters of (targetLat, targetLon)
 * without revealing the exact user coordinates.
 *
 * @param userLat    - User's latitude in degrees
 * @param userLon    - User's longitude in degrees
 * @param targetLat  - Drop's latitude in degrees
 * @param targetLon  - Drop's longitude in degrees
 * @param unlockRadius - Unlock radius in meters
 * @param config     - Circuit artifacts configuration
 * @returns Groth16 proof and public signals
 * @throws If snarkjs is not available or proof generation fails (e.g., user not in range)
 */
export async function generateProximityProof(
  userLat: number,
  userLon: number,
  targetLat: number,
  targetLon: number,
  unlockRadius: number,
  config: ZkpConfig
): Promise<ZkProximityProof> {
  const snarkjs = await loadSnarkjs();

  const artifacts = resolveArtifacts(config);

  const input = {
    targetLat: toFixedPoint(targetLat).toString(),
    targetLon: toFixedPoint(targetLon).toString(),
    radiusSquared: metersToRadiusSquared(unlockRadius).toString(),
    cosLatScaled: cosLatScaled(targetLat).toString(),
    userLat: toFixedPoint(userLat).toString(),
    userLon: toFixedPoint(userLon).toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    artifacts.wasmUrl,
    artifacts.zkeyUrl
  );

  return { proof, publicSignals };
}

// =====================
// Proof verification
// =====================

/**
 * Verify a ZK proximity proof.
 *
 * @param proof          - Groth16 proof
 * @param publicSignals  - Public signals from proof generation
 * @param verificationKey - Verification key (from trusted setup)
 * @returns true if the proof is valid
 */
export async function verifyProximityProof(
  proof: Groth16Proof,
  publicSignals: string[],
  verificationKey: VerificationKey
): Promise<boolean> {
  const snarkjs = await loadSnarkjs();
  return snarkjs.groth16.verify(verificationKey, publicSignals, proof);
}

/**
 * Validate that the public signals match the expected drop parameters.
 * This prevents proof reuse across different drops.
 *
 * Public signals layout (from circuit):
 *   [0] valid       (always 1)
 *   [1] targetLat   (fixed-point)
 *   [2] targetLon   (fixed-point)
 *   [3] radiusSquared
 *   [4] cosLatScaled
 *
 * @returns true if public signals match the expected drop parameters
 */
export function validatePublicSignals(
  publicSignals: string[],
  targetLat: number,
  targetLon: number,
  unlockRadius: number
): boolean {
  if (publicSignals.length < 5) return false;

  const valid = publicSignals[0];
  const sigTargetLat = publicSignals[1];
  const sigTargetLon = publicSignals[2];
  const sigRadiusSq = publicSignals[3];
  const sigCosLat = publicSignals[4];

  // Check valid flag
  if (valid !== '1') return false;

  // Check target coordinates match
  if (BigInt(sigTargetLat) !== toFixedPoint(targetLat)) return false;
  if (BigInt(sigTargetLon) !== toFixedPoint(targetLon)) return false;

  // Check radius matches
  if (BigInt(sigRadiusSq) !== metersToRadiusSquared(unlockRadius)) return false;

  // Check cosLat matches (prevents manipulation of correction factor)
  if (BigInt(sigCosLat) !== cosLatScaled(targetLat)) return false;

  return true;
}

// =====================
// Helpers
// =====================

function resolveArtifacts(config: ZkpConfig): CircuitArtifacts {
  if (config.artifacts) {
    return config.artifacts;
  }
  const base = config.artifactsBaseUrl?.replace(/\/$/, '') ?? '';
  if (!base) {
    throw new Error(
      'ZKP artifacts not configured. Provide artifacts or artifactsBaseUrl in ZkpConfig.'
    );
  }
  return {
    wasmUrl: `${base}/proximity.wasm`,
    zkeyUrl: `${base}/proximity_final.zkey`,
  };
}

/**
 * Dynamically import snarkjs.
 * This avoids bundling the large snarkjs library when ZKP is not used.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSnarkjs(): Promise<any> {
  try {
    // Dynamic import to keep snarkjs optional
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = await (Function('return import("snarkjs")')() as Promise<any>);
    return mod.default ?? mod;
  } catch {
    throw new Error(
      'snarkjs is required for ZK proofs. Install it: pnpm add snarkjs'
    );
  }
}
