/**
 * @zairn/geo-drop
 * Location-bound decentralized data drops with IPFS and geofence verification
 */

// Core
export { createGeoDrop } from './core';

// Verification engine (for advanced use / custom integrations)
export { createVerificationEngine } from './verification';
export type { VerificationEngine, VerificationEngineOptions } from './verification';

// Types
export type {
  // SDK
  GeoDropOptions,
  GeoDropSDK,
  // Drop
  GeoDrop,
  GeoDropCreate,
  DropVisibility,
  DropContentType,
  DropStatus,
  // Claim
  DropClaim,
  NearbyDrop,
  // IPFS
  IpfsConfig,
  IpfsUploadResult,
  // Location proof
  ProofMethodType,
  ProofRequirement,
  ProofConfig,
  ProofSubmission,
  ProofResult,
  ProofVerifier,
  VerificationResult,
  // Location proof
  LocationProof,
  // Crypto
  EncryptedPayload,
  // Stats
  DropStats,
  // NFT
  NftMetadata,
  // Share
  DropShare,
  // Persistence
  PersistenceLevel,
  PersistenceConfig,
  PersistenceResult,
  ChainConfig,
  EvmSigner,
  DropMetadataDocument,
  RecoveredDrop,
} from './types';

// Persistence (DB-independent recovery)
export { createPersistenceManager } from './persistence';
export type { PersistenceManager } from './persistence';

// Chain client (EVM on-chain registry)
export { createChainClient } from './chain';
export type { ChainClient } from './chain';

// ZKP (Zero-Knowledge Proof of Location)
export {
  buildZkStatementBinding,
  generateZairnZkpProof,
  generateProximityProof,
  verifyProximityProof,
  validatePublicSignals,
  toFixedPoint,
  metersToRadiusSquared,
  cosLatScaled,
} from './zkp';
export type {
  Groth16Proof,
  ZkProximityProof,
  ZkContextBinding,
  ZkStatementBinding,
  CircuitArtifacts,
  VerificationKey,
  ZkpConfig,
} from './zkp';

// Geofence utilities
export { encodeGeohash, decodeGeohash, calculateDistance, verifyProximity, geohashNeighbors, isMovementRealistic } from './geofence';
export type { VerifyOptions } from './geofence';

// Crypto utilities
export { encrypt, decrypt, hashPassword, deriveLocationKey } from './crypto';

// IPFS client
export { IpfsClient } from './ipfs';
