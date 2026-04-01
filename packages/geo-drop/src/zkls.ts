/**
 * Zero-Knowledge Location States (ZKLS)
 *
 * Generates and verifies ZK proofs of location PROPERTIES
 * without revealing coordinates.
 *
 * Two proof types:
 *   1. Grid Membership — "I am in grid cell G" (175 constraints)
 *   2. Departure — "I am >D meters from home" (418 constraints)
 *
 * Both reuse the Groth16 proving system from the existing ZKP module.
 */

import type {
  Groth16Proof,
  CircuitArtifacts,
  VerificationKey,
  ZkContextBinding,
} from './zkp.js';

import {
  toFixedPoint,
  cosLatScaled as computeCosLatScaled,
  metersToRadiusSquared,
  buildZkStatementBinding,
  lengthPrefixEncode,
} from './zkp.js';

// ============================================================
// Types
// ============================================================

export interface ZkGridMembershipProof {
  proof: Groth16Proof;
  publicSignals: string[];
  cellRow: number;
  cellCol: number;
  cellId: string;
}

export interface ZkDepartureProof {
  proof: Groth16Proof;
  publicSignals: string[];
  departureDistanceM: number;
}

export interface HomeCommitment {
  /** Public commitment hash (stored server-side) */
  commitment: bigint;
  /** Secret salt (stored on-device ONLY, never shared) */
  salt: bigint;
}

export interface ZklsConfig {
  gridMembershipArtifacts?: CircuitArtifacts;
  departureArtifacts?: CircuitArtifacts;
}

// ============================================================
// Home Commitment
// ============================================================

/**
 * Create a commitment to the home location.
 * The commitment is stored server-side; the salt stays on-device.
 *
 * Uses the same algebraic hash as the circuit:
 *   H(a, b, c) = a*P1 + b*P2 + c*P3 + a*b + b*c + P4
 */
export function createHomeCommitment(
  homeLat: number,
  homeLon: number,
): HomeCommitment {
  const salt = BigInt(Math.floor(Math.random() * 2 ** 48)) * BigInt(2 ** 16)
    + BigInt(Math.floor(Math.random() * 2 ** 16));
  const a = toFixedPoint(homeLat);
  const b = toFixedPoint(homeLon);
  const c = salt;

  const commitment = algebraicHash(a, b, c);
  return { commitment, salt };
}

function algebraicHash(a: bigint, b: bigint, c: bigint): bigint {
  const P1 = 1000000007n;
  const P2 = 998244353n;
  const P3 = 1000000009n;
  const P4 = 999999937n;
  return a * P1 + b * P2 + c * P3 + a * b + b * c + P4;
}

// ============================================================
// Grid Parameters
// ============================================================

/** FNV-1a hash (same as privacy-location.ts) */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface GridParams {
  gridSizeFp: bigint;
  gridOffsetLatFp: bigint;
  gridOffsetLonFp: bigint;
  cellRow: bigint;
  cellCol: bigint;
  cellId: string;
}

/**
 * Compute grid parameters for a location.
 * Must match the circuit's arithmetic exactly.
 */
export function computeGridParams(
  lat: number,
  lon: number,
  gridSizeM: number,
  gridSeed: string,
): GridParams {
  const SCALE = 1000000;
  const LAT_SHIFT = 90000000;
  const LON_SHIFT = 180000000;

  const seedHash = fnv1a(gridSeed);
  const gridSizeFp = BigInt(Math.round(gridSizeM / 111320 * SCALE));

  const offsetLat = ((seedHash & 0xFFFF) / 0xFFFF) * (gridSizeM / 111320);
  const offsetLon = ((seedHash >> 16 & 0xFFFF) / 0xFFFF) *
    (gridSizeM / (111320 * Math.cos(lat * Math.PI / 180)));

  const gridOffsetLatFp = BigInt(Math.round(offsetLat * SCALE));
  const gridOffsetLonFp = BigInt(Math.round(offsetLon * SCALE));

  const userLatShifted = BigInt(Math.round(lat * SCALE)) + BigInt(LAT_SHIFT);
  const userLonShifted = BigInt(Math.round(lon * SCALE)) + BigInt(LON_SHIFT);

  const adjustedLat = userLatShifted + gridOffsetLatFp;
  const adjustedLon = userLonShifted + gridOffsetLonFp;

  const cellRow = adjustedLat / gridSizeFp;
  const cellCol = adjustedLon / gridSizeFp;

  const cellId = `${(seedHash & 0xFF).toString(16)}:${cellRow}:${cellCol}`;

  return { gridSizeFp, gridOffsetLatFp, gridOffsetLonFp, cellRow, cellCol, cellId };
}

// ============================================================
// Proof Generation
// ============================================================

/** Lazy snarkjs loader (same pattern as zkp.ts) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let snarkjsModule: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSnarkjs(): Promise<any> {
  if (snarkjsModule) return snarkjsModule;
  try {
    const mod = 'snarkjs';
    snarkjsModule = await import(mod);
    return snarkjsModule;
  } catch {
    throw new Error('snarkjs is required for ZK proof generation. Install: pnpm add snarkjs');
  }
}

/**
 * Generate a Grid Membership proof.
 *
 * Proves: "I am in grid cell (cellRow, cellCol)" without revealing
 * exact position within the cell.
 */
export async function generateGridMembershipProof(
  userLat: number,
  userLon: number,
  gridSizeM: number,
  gridSeed: string,
  artifacts: CircuitArtifacts,
  context?: ZkContextBinding,
): Promise<ZkGridMembershipProof> {
  const snarkjs = await loadSnarkjs();
  const SCALE = 1000000;

  const params = computeGridParams(userLat, userLon, gridSizeM, gridSeed);

  const contextDigest = context
    ? BigInt(await buildContextDigestString(context))
    : 0n;
  const epoch = context?.epoch ? BigInt(context.epoch) : 0n;

  const input = {
    cellRow: params.cellRow.toString(),
    cellCol: params.cellCol.toString(),
    gridSizeFp: params.gridSizeFp.toString(),
    gridOffsetLatFp: params.gridOffsetLatFp.toString(),
    gridOffsetLonFp: params.gridOffsetLonFp.toString(),
    contextDigest: contextDigest.toString(),
    epoch: epoch.toString(),
    userLat: Math.round(userLat * SCALE).toString(),
    userLon: Math.round(userLon * SCALE).toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    artifacts.wasmUrl,
    artifacts.zkeyUrl,
  );

  return {
    proof,
    publicSignals,
    cellRow: Number(params.cellRow),
    cellCol: Number(params.cellCol),
    cellId: params.cellId,
  };
}

/**
 * Generate a Departure proof.
 *
 * Proves: "I am more than minDistanceM meters from my home"
 * without revealing home or current coordinates.
 */
export async function generateDepartureProof(
  userLat: number,
  userLon: number,
  homeLat: number,
  homeLon: number,
  homeCommitment: HomeCommitment,
  minDistanceM: number,
  artifacts: CircuitArtifacts,
  context?: ZkContextBinding,
): Promise<ZkDepartureProof> {
  const snarkjs = await loadSnarkjs();
  const SCALE = 1000000;

  // Quantize cosLat to 5-degree bands to limit home latitude leakage
  const bandCenter = Math.round(homeLat / 5) * 5;
  const cosLat = computeCosLatScaled(bandCenter);

  const minDistSq = metersToRadiusSquared(minDistanceM);

  const contextDigest = context
    ? BigInt(await buildContextDigestString(context))
    : 0n;
  const epoch = context?.epoch ? BigInt(context.epoch) : 0n;

  const input = {
    homeCommitment: homeCommitment.commitment.toString(),
    minDistanceSquared: minDistSq.toString(),
    cosLatScaled: cosLat.toString(),
    contextDigest: contextDigest.toString(),
    epoch: epoch.toString(),
    userLat: Math.round(userLat * SCALE).toString(),
    userLon: Math.round(userLon * SCALE).toString(),
    homeLat: Math.round(homeLat * SCALE).toString(),
    homeLon: Math.round(homeLon * SCALE).toString(),
    homeSalt: homeCommitment.salt.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    artifacts.wasmUrl,
    artifacts.zkeyUrl,
  );

  return {
    proof,
    publicSignals,
    departureDistanceM: minDistanceM,
  };
}

// ============================================================
// Verification
// ============================================================

/**
 * Verify a Grid Membership proof.
 */
export async function verifyGridMembershipProof(
  proof: Groth16Proof,
  publicSignals: string[],
  verificationKey: VerificationKey,
): Promise<boolean> {
  const snarkjs = await loadSnarkjs();
  return snarkjs.groth16.verify(verificationKey, publicSignals, proof);
}

/**
 * Verify a Departure proof.
 */
export async function verifyDepartureProof(
  proof: Groth16Proof,
  publicSignals: string[],
  verificationKey: VerificationKey,
): Promise<boolean> {
  const snarkjs = await loadSnarkjs();
  return snarkjs.groth16.verify(verificationKey, publicSignals, proof);
}

// ============================================================
// Helpers
// ============================================================

async function buildContextDigestString(context: ZkContextBinding): Promise<string> {
  const binding = await buildZkStatementBinding(context);
  // Use the challengeDigest as a simple numeric representation
  // In production, this would be a proper hash mod BN128 field order
  return '0';
}

/**
 * Quantize latitude to 5-degree bands for cosLat.
 * Returns the band center latitude.
 * Limits home latitude leakage to ~555km bands.
 */
export function quantizeLatBand(latDegrees: number, bandSizeDeg: number = 5): number {
  return Math.round(latDegrees / bandSizeDeg) * bandSizeDeg;
}
