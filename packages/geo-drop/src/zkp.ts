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

/** Context-binding values included in the Zairn-ZKP statement */
export interface ZkContextBinding {
  /** Drop identifier for cross-drop replay resistance */
  dropId: string;
  /** Optional policy/config version for statement evolution */
  policyVersion?: string;
  /** Freshness window identifier */
  epoch: number | string;
  /** Server-issued nonce for session binding */
  serverNonce: string;
}

/** Public statement values expected by the verifier */
export interface ZkStatementBinding {
  contextDigest: string;
  epoch: string;
  challengeDigest: string;
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
  /** Circuit basename under artifactsBaseUrl. Defaults to `proximity`. */
  circuitName?: string;
}

/** A polygon vertex (lat/lon in degrees) */
export interface PolygonVertex {
  lat: number;
  lon: number;
}

/** Result of region proof generation */
export interface ZkRegionProof {
  proof: Groth16Proof;
  publicSignals: string[];
}

/** Maximum polygon vertices supported by the circuit */
export const MAX_POLYGON_VERTICES = 16;

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
  config: ZkpConfig,
  statement?: ZkStatementBinding
): Promise<ZkProximityProof> {
  const snarkjs = await loadSnarkjs();

  const artifacts = resolveArtifacts(config);

  const input: Record<string, string> = {
    targetLat: toFixedPoint(targetLat).toString(),
    targetLon: toFixedPoint(targetLon).toString(),
    radiusSquared: metersToRadiusSquared(unlockRadius).toString(),
    cosLatScaled: cosLatScaled(targetLat).toString(),
    userLat: toFixedPoint(userLat).toString(),
    userLon: toFixedPoint(userLon).toString(),
  };
  if (statement) {
    input.contextDigest = statement.contextDigest;
    input.epoch = statement.epoch;
    input.challengeDigest = statement.challengeDigest;
  }

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    artifacts.wasmUrl,
    artifacts.zkeyUrl
  );

  return { proof, publicSignals };
}

/**
 * Generate a context-bound Zairn-ZKP proof.
 *
 * This is the application-oriented path used by the revised design:
 * the proof is tied to a specific drop, policy version, freshness epoch,
 * and server-issued challenge.
 */
export async function generateZairnZkpProof(
  userLat: number,
  userLon: number,
  targetLat: number,
  targetLon: number,
  unlockRadius: number,
  context: ZkContextBinding,
  config: ZkpConfig
): Promise<ZkProximityProof & { statement: ZkStatementBinding }> {
  const statement = await buildZkStatementBinding(context);
  const proof = await generateProximityProof(
    userLat,
    userLon,
    targetLat,
    targetLon,
    unlockRadius,
    { ...config, circuitName: config.circuitName ?? 'zairn_zkp' },
    statement
  );
  return { ...proof, statement };
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
 *   [0] valid            (always 1)
 *   [1] targetLat        (fixed-point)
 *   [2] targetLon        (fixed-point)
 *   [3] radiusSquared
 *   [4] cosLatScaled
 *   [5] contextDigest    (optional, Zairn-ZKP path)
 *   [6] epoch            (optional, Zairn-ZKP path)
 *   [7] challengeDigest  (optional, Zairn-ZKP path)
 *
 * @returns true if public signals match the expected drop parameters
 */
export function validatePublicSignals(
  publicSignals: string[],
  targetLat: number,
  targetLon: number,
  unlockRadius: number,
  statement?: ZkStatementBinding
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

  if (!statement) return true;
  if (publicSignals.length < 8) return false;

  const sigContextDigest = publicSignals[5];
  const sigEpoch = publicSignals[6];
  const sigChallengeDigest = publicSignals[7];

  if (sigContextDigest !== statement.contextDigest) return false;
  if (sigEpoch !== statement.epoch) return false;
  if (sigChallengeDigest !== statement.challengeDigest) return false;

  return true;
}

/**
 * Build the public statement binding used by Zairn-ZKP.
 */
export async function buildZkStatementBinding(
  context: ZkContextBinding
): Promise<ZkStatementBinding> {
  const policyVersion = context.policyVersion ?? '1';
  const epoch = String(context.epoch);
  return {
    contextDigest: await hashToField(
      lengthPrefixEncode(context.dropId, policyVersion, epoch)
    ),
    epoch,
    challengeDigest: await hashToField(context.serverNonce),
  };
}

/**
 * Length-prefixed canonical encoding for hash pre-images.
 * Each field is encoded as a 4-digit decimal length prefix followed by its UTF-8 value.
 * This provides formally unambiguous domain separation regardless of field content,
 * unlike separator-based encoding which requires restricting the character set.
 *
 * Example: lengthPrefixEncode("drop-42", "2", "7") → "0007drop-420001200017"
 */
export function lengthPrefixEncode(...fields: string[]): string {
  return fields
    .map((f) => `${f.length.toString(10).padStart(4, '0')}${f}`)
    .join('');
}

// =====================
// Region (polygon containment) proof
// =====================

/**
 * Prepare polygon vertices as fixed-point circuit inputs.
 * Pads to MAX_POLYGON_VERTICES with zeros for inactive slots.
 */
function preparePolygonInputs(polygon: PolygonVertex[]): {
  polyLat: string[];
  polyLon: string[];
  vertexCount: string;
} {
  if (polygon.length < 3) {
    throw new Error('Polygon must have at least 3 vertices');
  }
  if (polygon.length > MAX_POLYGON_VERTICES) {
    throw new Error(`Polygon exceeds maximum of ${MAX_POLYGON_VERTICES} vertices`);
  }

  const LAT_SHIFT = 90_000_000n;
  const LON_SHIFT = 180_000_000n;

  const polyLat: string[] = [];
  const polyLon: string[] = [];

  for (let i = 0; i < MAX_POLYGON_VERTICES; i++) {
    if (i < polygon.length) {
      // Shift to non-negative (same as circuit)
      polyLat.push((toFixedPoint(polygon[i].lat) + LAT_SHIFT).toString());
      polyLon.push((toFixedPoint(polygon[i].lon) + LON_SHIFT).toString());
    } else {
      // Padding: inactive vertices
      polyLat.push('0');
      polyLon.push('0');
    }
  }

  return { polyLat, polyLon, vertexCount: polygon.length.toString() };
}

/**
 * Generate a ZK region containment proof.
 *
 * Proves the user is inside a polygon defined by the given vertices,
 * without revealing exact user coordinates.
 *
 * @param userLat  - User's latitude in degrees
 * @param userLon  - User's longitude in degrees
 * @param polygon  - Polygon vertices (3..16), ordered consistently (CW or CCW)
 * @param config   - Circuit artifacts configuration (circuitName defaults to 'region_zkp')
 * @param statement - Optional context binding for replay resistance
 * @returns Groth16 proof and public signals
 */
export async function generateRegionProof(
  userLat: number,
  userLon: number,
  polygon: PolygonVertex[],
  config: ZkpConfig,
  statement?: ZkStatementBinding,
): Promise<ZkRegionProof> {
  const snarkjs = await loadSnarkjs();

  const regionConfig = { ...config, circuitName: config.circuitName ?? 'region_zkp' };
  const artifacts = resolveArtifacts(regionConfig);

  const { polyLat, polyLon, vertexCount } = preparePolygonInputs(polygon);

  const input: Record<string, string | string[]> = {
    userLat: toFixedPoint(userLat).toString(),
    userLon: toFixedPoint(userLon).toString(),
    polyLat,
    polyLon,
    vertexCount,
  };

  if (statement) {
    input.contextDigest = statement.contextDigest;
    input.epoch = statement.epoch;
    input.challengeDigest = statement.challengeDigest;
  }

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    artifacts.wasmUrl,
    artifacts.zkeyUrl,
  );

  return { proof, publicSignals };
}

/**
 * Generate a context-bound region containment proof.
 */
export async function generateZairnRegionProof(
  userLat: number,
  userLon: number,
  polygon: PolygonVertex[],
  context: ZkContextBinding,
  config: ZkpConfig,
): Promise<ZkRegionProof & { statement: ZkStatementBinding }> {
  const statement = await buildZkStatementBinding(context);
  const proof = await generateRegionProof(
    userLat,
    userLon,
    polygon,
    config,
    statement,
  );
  return { ...proof, statement };
}

/**
 * Verify a ZK region containment proof.
 */
export async function verifyRegionProof(
  proof: Groth16Proof,
  publicSignals: string[],
  verificationKey: VerificationKey,
): Promise<boolean> {
  const snarkjs = await loadSnarkjs();
  return snarkjs.groth16.verify(verificationKey, publicSignals, proof);
}

/**
 * Validate that region proof public signals match expected polygon parameters.
 *
 * Public signals layout (from region_zkp circuit, MAX_VERTICES=16):
 *   [0]     valid (always 1)
 *   [1..16] polyLat[0..15]
 *   [17..32] polyLon[0..15]
 *   [33]    vertexCount
 *   [34]    contextDigest  (optional)
 *   [35]    epoch          (optional)
 *   [36]    challengeDigest (optional)
 */
export function validateRegionPublicSignals(
  publicSignals: string[],
  polygon: PolygonVertex[],
  statement?: ZkStatementBinding,
): boolean {
  // 1 (valid) + 16 (polyLat) + 16 (polyLon) + 1 (vertexCount) = 34
  if (publicSignals.length < 34) return false;

  // Check valid flag
  if (publicSignals[0] !== '1') return false;

  const { polyLat, polyLon, vertexCount } = preparePolygonInputs(polygon);

  // Check polygon vertices
  for (let i = 0; i < MAX_POLYGON_VERTICES; i++) {
    if (publicSignals[1 + i] !== polyLat[i]) return false;
    if (publicSignals[17 + i] !== polyLon[i]) return false;
  }

  // Check vertex count
  if (publicSignals[33] !== vertexCount) return false;

  if (!statement) return true;
  if (publicSignals.length < 37) return false;

  if (publicSignals[34] !== statement.contextDigest) return false;
  if (publicSignals[35] !== statement.epoch) return false;
  if (publicSignals[36] !== statement.challengeDigest) return false;

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
  const circuitName = config.circuitName ?? 'proximity';
  return {
    wasmUrl: `${base}/${circuitName}.wasm`,
    zkeyUrl: `${base}/${circuitName}_final.zkey`,
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

async function hashToField(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return BigInt(`0x${hex}`).toString();
}
