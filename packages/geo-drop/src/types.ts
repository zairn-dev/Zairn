/**
 * @zen-map/geo-drop 型定義
 * 場所に紐づいたデータドロップのための型
 */

// =====================
// ドロップの種類
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
// 暗号化
// =====================
export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  salt: string;
}

// =====================
// ジオフェンス
// =====================
export interface GeofenceConfig {
  lat: number;
  lon: number;
  radius_meters: number;
  geohash: string;
}

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
// ドロップ
// =====================
export interface GeoDrop {
  id: string;
  creator_id: string;
  // 場所
  lat: number;
  lon: number;
  geohash: string;
  unlock_radius_meters: number;
  // コンテンツ
  title: string;
  description: string | null;
  content_type: DropContentType;
  ipfs_cid: string;
  encrypted: boolean;
  // アクセス制御
  visibility: DropVisibility;
  password_hash: string | null;
  max_claims: number | null;
  claim_count: number;
  // 期限
  expires_at: string | null;
  status: DropStatus;
  // メタデータ
  preview_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
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
}

// =====================
// クレーム（受け取り記録）
// =====================
export interface DropClaim {
  id: string;
  drop_id: string;
  user_id: string;
  lat: number;
  lon: number;
  distance_meters: number;
  claimed_at: string;
}

// =====================
// 発見（近くのドロップ）
// =====================
export interface NearbyDrop {
  drop: GeoDrop;
  distance_meters: number;
  can_unlock: boolean;
}

// =====================
// 統計
// =====================
export interface DropStats {
  total_created: number;
  total_claimed: number;
  total_active: number;
  unique_locations: number;
}

// =====================
// NFT拡張（将来用）
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
// SDK
// =====================
export interface GeoDropOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
  ipfs?: IpfsConfig;
}

export interface GeoDropSDK {
  // ドロップ作成・管理
  createDrop: (data: GeoDropCreate, content: File | Blob | string) => Promise<GeoDrop>;
  getDrop: (dropId: string) => Promise<GeoDrop | null>;
  getMyDrops: (options?: { status?: DropStatus; limit?: number }) => Promise<GeoDrop[]>;
  deleteDrop: (dropId: string) => Promise<void>;

  // 発見・アンロック
  findNearbyDrops: (lat: number, lon: number, radiusMeters?: number) => Promise<NearbyDrop[]>;
  unlockDrop: (dropId: string, lat: number, lon: number, accuracy: number, password?: string) => Promise<{ content: string; claim: DropClaim }>;

  // クレーム
  getDropClaims: (dropId: string) => Promise<DropClaim[]>;
  getMyClaims: (options?: { limit?: number }) => Promise<DropClaim[]>;

  // 統計
  getMyStats: () => Promise<DropStats>;

  // IPFS
  uploadToIpfs: (content: File | Blob | string) => Promise<IpfsUploadResult>;
  fetchFromIpfs: (cid: string) => Promise<string>;

  // ジオフェンス検証
  verifyLocation: (dropId: string, lat: number, lon: number, accuracy: number) => Promise<LocationProof>;

  // NFTメタデータ生成
  generateNftMetadata: (drop: GeoDrop, imageUrl?: string) => NftMetadata;

  // ユーティリティ
  encodeGeohash: (lat: number, lon: number, precision?: number) => string;
  decodeGeohash: (geohash: string) => { lat: number; lon: number };
  calculateDistance: (lat1: number, lon1: number, lat2: number, lon2: number) => number;
}
