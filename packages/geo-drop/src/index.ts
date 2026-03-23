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
  // Step-up verification
  StepUpRequired,
  UnlockSuccess,
  UnlockResult,
} from './types';

// Persistence (DB-independent recovery)
export { createPersistenceManager } from './persistence';
export type { PersistenceManager, PersistenceManagerConfig } from './persistence';

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
  // Region (polygon containment)
  generateRegionProof,
  generateZairnRegionProof,
  verifyRegionProof,
  validateRegionPublicSignals,
  MAX_POLYGON_VERTICES,
} from './zkp';
export type {
  Groth16Proof,
  ZkProximityProof,
  ZkContextBinding,
  ZkStatementBinding,
  CircuitArtifacts,
  VerificationKey,
  ZkpConfig,
  PolygonVertex,
  ZkRegionProof,
} from './zkp';

// Trust scoring
export { computeTrustScore, computeTrustScoreV2, gateTrustScore, createTrustSession } from './trust-scorer';
export type { TrustSession } from './trust-scorer';
export type { LocationPoint, TrustScoreResult, TrustScoreResultV2, TrustThresholds, GpsFix, NetworkHint, TrustContext } from './types';

// Geofence utilities
export { encodeGeohash, decodeGeohash, calculateDistance, verifyProximity, geohashNeighbors, isMovementRealistic } from './geofence';
export type { VerifyOptions } from './geofence';

// Crypto utilities
export { encrypt, decrypt, hashPassword, deriveLocationKey, CURRENT_KEY_VERSION } from './crypto';
export type { KeyDerivationVersion } from './crypto';

// Encrypted geographic search (GridSE)
export {
  generateIndexTokens,
  generateSearchTokens,
  matchTokens,
  selectPrecisionForRadius,
} from './encrypted-search';
export type {
  EncryptedSearchConfig,
  LocationIndexTokens,
  SearchTokenSet,
  EncryptedSearchMatch,
} from './encrypted-search';

// SBPP (Search-Bound Proximity Proofs)
export {
  createSession as createSbppSession,
  isSessionValid as isSbppSessionValid,
  SbppSessionStore,
  buildSbppChallengeDigest,
  verifySbppBinding,
  sbppSearch,
  sbppMatch,
  sbppVerifyBinding,
  TokenInvertedIndex,
  SBPP_DOMAIN_SEPARATOR,
  computeResultSetDigest,
  MerkleResultSet,
  SbppAuditLog,
} from './sbpp';
export type {
  SbppSession,
  SbppSessionOptions,
  SbppSearchResult,
  SbppProofContext,
  MerkleProof,
  SbppAuditRecord,
} from './sbpp';

// IPFS client
export { IpfsClient } from './ipfs';
