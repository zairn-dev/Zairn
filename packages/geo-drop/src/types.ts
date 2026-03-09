/**
 * @zen-map/geo-drop Type Definitions
 * Types for location-bound data drops
 */

// =====================
// Drop types
// =====================
export type DropVisibility = 'public' | 'friends' | 'private' | 'password';
export type DropContentType = 'text' | 'image' | 'audio' | 'video' | 'file' | 'nft';
export type DropStatus = 'active' | 'expired' | 'claimed' | 'deleted';

// =====================
// IPFS
// =====================
export interface IpfsConfig {
  gateway: string;
  pinningService?: 'pinata' | 'web3storage' | 'custom';
  pinningApiKey?: string;
  pinningApiSecret?: string;
  customPinningUrl?: string;
}

export interface IpfsUploadResult {
  cid: string;
  size: number;
  url: string;
}

// =====================
// Encryption
// =====================
export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  salt: string;
}

// =====================
// Location proof methods
// =====================

/**
 * Proof method type
 * - gps: GPS coordinates (default)
 * - secret: ID/secret matching (front-end sends an ID obtained via QR, BLE, WiFi, NFC, etc.)
 * - ar: Image feature-based location verification
 * - custom: Fully custom verifier
 */
export type ProofMethodType = 'gps' | 'secret' | 'ar' | 'custom';

/**
 * Proof requirements set on a drop
 * When multiple are specified, mode (all/any) switches between AND/OR
 */
export interface ProofRequirement {
  /** Proof method type */
  method: ProofMethodType;
  /**
   * Method-specific parameters
   * - gps: {} (default; controlled by unlock_radius_meters)
   * - secret: { secret: string; label?: string } — secret obtained on-site (via QR/BLE/WiFi/NFC etc., acquisition method is up to the front-end)
   * - ar: { reference_embedding: number[]; similarity_threshold?: number } — DINOv2 feature vector (compared server-side)
   * - custom: { verifier_id: string; [key: string]: unknown } — parameters passed to a custom verifier
   */
  params: Record<string, unknown>;
  /** Whether this method is required or optional (default: true) */
  required?: boolean;
}

/**
 * Proof configuration for a drop
 */
export interface ProofConfig {
  /**
   * Verification mode
   * - 'all': All required proofs must be satisfied (AND)
   * - 'any': Any single proof is sufficient (OR)
   * Default: 'all'
   */
  mode: 'all' | 'any';
  /** List of proof requirements */
  requirements: ProofRequirement[];
}

/**
 * Proof response submitted by a user
 */
export interface ProofSubmission {
  /** Proof method type */
  method: ProofMethodType;
  /**
   * Method-specific response data
   * - gps: { lat: number; lon: number; accuracy: number }
   * - secret: { secret: string } — secret obtained on-site (acquisition method does not matter)
   * - ar: { image: string } — base64 of captured image (vector extraction and comparison done server-side)
   * - custom: { verifier_id: string; [key: string]: unknown }
   */
  data: Record<string, unknown>;
}

/**
 * Verification result for a single proof
 */
export interface ProofResult {
  method: ProofMethodType;
  verified: boolean;
  /** Verification details (method-specific) */
  details: Record<string, unknown>;
}

/**
 * Combined result of all verifications
 */
export interface VerificationResult {
  verified: boolean;
  /** Result for each proof method */
  proofs: ProofResult[];
  /** GPS-based location proof (when GPS verification is included) */
  location_proof?: LocationProof;
  timestamp: string;
}

/**
 * Custom verifier function type
 * Interface for SDK consumers to register custom verification logic
 */
export type ProofVerifier = (
  requirement: ProofRequirement,
  submission: ProofSubmission,
  drop: GeoDrop
) => Promise<ProofResult> | ProofResult;

// =====================
// Location proof
// =====================
export interface LocationProof {
  user_id: string;
  lat: number;
  lon: number;
  accuracy: number;
  timestamp: string;
  geohash: string;
  distance_to_target: number;
  verified: boolean;
}

// =====================
// Drop
// =====================
export interface GeoDrop {
  id: string;
  creator_id: string;
  // Location
  lat: number;
  lon: number;
  geohash: string;
  unlock_radius_meters: number;
  // Content
  title: string;
  description: string | null;
  content_type: DropContentType;
  ipfs_cid: string | null;
  encrypted_content: string | null;
  encrypted: boolean;
  encryption_salt: string | null;
  // Access control
  visibility: DropVisibility;
  password_hash: string | null;
  max_claims: number | null;
  claim_count: number;
  // Location proof
  proof_config: ProofConfig | null;
  // Expiration
  expires_at: string | null;
  status: DropStatus;
  // Metadata
  preview_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  // Persistence (for DB-independent recovery, optional)
  persistence_level?: PersistenceLevel;
  metadata_cid?: string;
  chain_tx_hash?: string;
}

export interface GeoDropCreate {
  title: string;
  description?: string;
  content_type: DropContentType;
  lat: number;
  lon: number;
  unlock_radius_meters?: number;
  visibility?: DropVisibility;
  password?: string;
  max_claims?: number;
  expires_at?: Date;
  metadata?: Record<string, unknown>;
  /** User IDs to share a private drop with */
  shared_with?: string[];
  /** Proof configuration (defaults to GPS only when unspecified) */
  proof_config?: ProofConfig;
  /** Persistence level (uses GeoDropOptions default when unspecified) */
  persistence?: PersistenceLevel;
  /** Secret for metadata encryption (recommended for private/password drops) */
  recoverySecret?: string;
}

// =====================
// Private sharing
// =====================
export interface DropShare {
  drop_id: string;
  user_id: string;
  created_at: string;
}

// =====================
// Claim (collection record)
// =====================
export interface DropClaim {
  id: string;
  drop_id: string;
  user_id: string;
  lat: number;
  lon: number;
  distance_meters: number;
  proof_results: ProofResult[] | null;
  claimed_at: string;
}

// =====================
// Discovery (nearby drops)
// =====================
export interface NearbyDrop {
  drop: GeoDrop;
  distance_meters: number;
  can_unlock: boolean;
}

// =====================
// Stats
// =====================
export interface DropStats {
  total_created: number;
  total_claimed: number;
  total_active: number;
  unique_locations: number;
}

// =====================
// NFT extension (future use)
// =====================
export interface NftMetadata {
  name: string;
  description: string;
  image: string;
  attributes: {
    trait_type: string;
    value: string | number;
  }[];
  geo_drop: {
    lat: number;
    lon: number;
    geohash: string;
    drop_id: string;
    ipfs_cid: string;
  };
}

// =====================
// Persistence (DB-independent recovery)
// =====================

/**
 * Persistence level
 * - db-only: DB storage only (default, free)
 * - ipfs: Metadata also pinned to IPFS (recoverable even if DB is lost, requires ongoing pinning)
 * - onchain: Metadata CID recorded on-chain (implicitly pins to IPFS as well)
 * - ipfs+onchain: Explicitly both
 */
export type PersistenceLevel = 'db-only' | 'ipfs' | 'onchain' | 'ipfs+onchain';

/**
 * Abstract interface for an EVM signer
 * Can be adapted for either ethers.js Signer or viem WalletClient
 */
export interface EvmSigner {
  getAddress(): Promise<string>;
  sendTransaction(tx: {
    to: string;
    data: string;
    value?: string;
  }): Promise<{ hash: string; wait(confirmations?: number): Promise<{ status: number }> }>;
}

/**
 * Chain configuration
 */
export interface ChainConfig {
  /** EVM JSON-RPC endpoint */
  rpcUrl: string;
  /** Deployed GeoDropRegistry contract address */
  registryAddress: string;
  /** Signer (required for write operations; optional for read-only) */
  signer?: EvmSigner;
  /** Chain ID (optional, for logging) */
  chainId?: number;
}

/**
 * Persistence configuration
 */
export interface PersistenceConfig {
  level: PersistenceLevel;
  chain?: ChainConfig;
  /** Whether to fail drop creation if persistence fails (default: false) */
  strict?: boolean;
}

/**
 * Metadata document stored on IPFS
 * This document alone is sufficient to decrypt content even if DB is lost
 */
export interface DropMetadataDocument {
  version: 1;
  dropId: string;
  geohash: string;
  contentCid: string;
  encryptionSalt: string;
  unlockRadiusMeters: number;
  contentType: DropContentType;
  title: string;
  proofConfig: ProofConfig | null;
  createdAt: string;
  /** True if encrypted (when recoverySecret is used) */
  encrypted?: boolean;
}

/**
 * Result of a persistence operation
 */
export interface PersistenceResult {
  level: PersistenceLevel;
  metadataCid?: string;
  txHash?: string;
  chainId?: number;
}

/**
 * Drop information recovered independently of DB
 */
export interface RecoveredDrop {
  metadata: DropMetadataDocument;
  metadataCid: string;
  source: 'ipfs' | 'onchain';
}

// =====================
// SDK
// =====================
export interface GeoDropOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
  ipfs?: IpfsConfig;
  /** Initial custom proof verifiers to register */
  verifiers?: Record<string, ProofVerifier>;
  /**
   * Image proof Edge Function URL
   * Defaults to supabaseUrl + '/functions/v1/image-proof' when unspecified
   */
  imageProofUrl?: string;
  /** Persistence configuration */
  persistence?: PersistenceConfig;
}

export interface GeoDropSDK {
  // Drop CRUD
  createDrop: (data: GeoDropCreate, content: File | Blob | string) => Promise<GeoDrop>;
  getDrop: (dropId: string) => Promise<GeoDrop | null>;
  getMyDrops: (options?: { status?: DropStatus; limit?: number }) => Promise<GeoDrop[]>;
  deleteDrop: (dropId: string) => Promise<void>;

  // Discovery & unlock
  findNearbyDrops: (lat: number, lon: number, radiusMeters?: number) => Promise<NearbyDrop[]>;
  unlockDrop: (dropId: string, lat: number, lon: number, accuracy: number, password?: string, proofs?: ProofSubmission[]) => Promise<{ content: string; claim: DropClaim; verification: VerificationResult }>;

  // Location proof
  getProofConfig: (dropId: string) => Promise<ProofConfig | null>;
  registerVerifier: (methodOrId: ProofMethodType | string, verifier: ProofVerifier) => void;

  // Image proof (server-side DINOv2)
  /** Extract feature vector from a reference image (used during drop creation) */
  extractImageEmbedding: (imageBase64: string) => Promise<{ embedding: number[]; dimensions: number }>;
  /** Compare a captured image against a drop's reference and verify (for debug/direct calls) */
  verifyImageProof: (imageBase64: string, dropId: string, threshold?: number) => Promise<{ verified: boolean; similarity: number }>;

  // Private sharing
  shareDrop: (dropId: string, userIds: string[]) => Promise<void>;
  unshareDrop: (dropId: string, userId: string) => Promise<void>;
  getSharedDrops: () => Promise<GeoDrop[]>;

  // Claims
  getDropClaims: (dropId: string) => Promise<DropClaim[]>;
  getMyClaims: (options?: { limit?: number }) => Promise<DropClaim[]>;

  // Stats
  getMyStats: () => Promise<DropStats>;

  // IPFS
  uploadToIpfs: (content: File | Blob | string) => Promise<IpfsUploadResult>;
  fetchFromIpfs: (cid: string) => Promise<string>;

  // Geofence verification
  verifyLocation: (dropId: string, lat: number, lon: number, accuracy: number) => Promise<LocationProof>;

  // Realtime
  subscribeNearbyDrops: (lat: number, lon: number, radiusMeters: number, onDrop: (drop: GeoDrop) => void) => import('@supabase/supabase-js').RealtimeChannel;

  // NFT metadata generation
  generateNftMetadata: (drop: GeoDrop, imageUrl?: string) => NftMetadata;

  // DB-independent recovery
  /** Recover directly from a metadata CID */
  recoverDrop: (metadataCid: string, recoverySecret?: string) => Promise<RecoveredDrop>;
  /** Search the on-chain index by location and recover */
  discoverDropsByLocation: (lat: number, lon: number, precision?: number) => Promise<RecoveredDrop[]>;
  /** Decrypt recovered drop content */
  decryptRecoveredDrop: (recovered: RecoveredDrop) => Promise<string>;

  // Utilities
  encodeGeohash: (lat: number, lon: number, precision?: number) => string;
  decodeGeohash: (geohash: string) => { lat: number; lon: number };
  calculateDistance: (lat1: number, lon1: number, lat2: number, lon2: number) => number;
}
