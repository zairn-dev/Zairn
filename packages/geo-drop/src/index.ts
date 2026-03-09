/**
 * @zen-map/geo-drop
 * Location-bound decentralized data drops with IPFS and geofence verification
 */

// Core
export { createGeoDrop } from './core';

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
  // Geofence
  GeofenceConfig,
  LocationProof,
  // Crypto
  EncryptedPayload,
  // Stats
  DropStats,
  // NFT
  NftMetadata,
} from './types';

// Utilities (standalone exports for direct use)
export { encodeGeohash, decodeGeohash, calculateDistance, verifyProximity } from './geofence';
export { encrypt, decrypt, hashPassword, deriveLocationKey } from './crypto';
export { IpfsClient } from './ipfs';
