/**
 * zen-map SDK 型定義
 * Single Source of Truth - 全ての型定義をここで管理
 */

// =====================
// 基本型
// =====================
export type ShareLevel = 'none' | 'current' | 'history';
export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected';
export type MotionType = 'stationary' | 'walking' | 'running' | 'cycling' | 'driving' | 'transit' | 'unknown';
export type PlaceType = 'home' | 'work' | 'school' | 'gym' | 'custom';
export type ChatRoomType = 'direct' | 'group';
export type MessageType = 'text' | 'image' | 'location' | 'reaction';

// =====================
// 設定・オプション
// =====================
export interface LocationCoreOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

// =====================
// 位置情報
// =====================
export interface LocationCurrentRow {
  user_id: string;
  lat: number;
  lon: number;
  accuracy: number | null;
  updated_at: string;
  battery_level: number | null;
  is_charging: boolean;
  location_since: string | null;
  speed: number | null;
  motion: MotionType;
}

export interface LocationUpdate {
  lat: number;
  lon: number;
  accuracy?: number | null;
  battery_level?: number | null;
  is_charging?: boolean;
  speed?: number | null;
  motion?: MotionType;
}

export interface LocationHistoryRow {
  id: number;
  user_id: string;
  lat: number;
  lon: number;
  accuracy: number | null;
  recorded_at: string;
}

// =====================
// 共有ルール
// =====================
export interface ShareRule {
  owner_id: string;
  viewer_id: string;
  level: ShareLevel;
  expires_at: string | null;
}

// =====================
// プロフィール
// =====================
export interface Profile {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

// =====================
// フレンド
// =====================
export interface FriendRequest {
  id: number;
  from_user_id: string;
  to_user_id: string;
  status: FriendRequestStatus;
  created_at: string;
  updated_at: string;
}

// =====================
// ユーザー設定
// =====================
export interface UserSettings {
  user_id: string;
  ghost_mode: boolean;
  ghost_until: string | null;
  location_update_interval: number;
  updated_at: string;
}

// =====================
// グループ
// =====================
export interface Group {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  invite_code: string | null;
  created_at: string;
}

export interface GroupMember {
  group_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

// =====================
// チャット
// =====================
export interface ChatRoom {
  id: string;
  type: ChatRoomType;
  group_id: string | null;
  created_at: string;
}

export interface ChatRoomMember {
  room_id: string;
  user_id: string;
  joined_at: string;
  last_read_at: string | null;
}

export interface Message {
  id: number;
  room_id: string;
  sender_id: string;
  content: string | null;
  message_type: MessageType;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

// =====================
// リアクション
// =====================
export interface LocationReaction {
  id: number;
  from_user_id: string;
  to_user_id: string;
  emoji: string;
  message: string | null;
  created_at: string;
}

// =====================
// Bump
// =====================
export interface BumpEvent {
  id: number;
  user_id: string;
  nearby_user_id: string;
  distance_meters: number;
  lat: number;
  lon: number;
  created_at: string;
}

export interface NearbyUser {
  user_id: string;
  lat: number;
  lon: number;
  distance_meters: number;
}

// =====================
// お気に入りの場所
// =====================
export interface FavoritePlace {
  id: string;
  user_id: string;
  name: string;
  place_type: PlaceType;
  lat: number;
  lon: number;
  radius_meters: number;
  icon: string | null;
  created_at: string;
  updated_at: string;
}

// =====================
// SDK戻り値の型
// =====================
export interface LocationCore {
  // Supabaseクライアント
  supabase: import('@supabase/supabase-js').SupabaseClient;

  // 位置情報
  sendLocation: (latOrUpdate: number | LocationUpdate, lon?: number, accuracy?: number | null) => Promise<void>;
  getVisibleFriends: () => Promise<LocationCurrentRow[]>;
  getLocationHistory: (userId: string, options?: { limit?: number; since?: Date }) => Promise<LocationHistoryRow[]>;
  saveLocationHistory: (lat: number, lon: number, accuracy?: number | null) => Promise<void>;

  // 共有ルール
  allow: (viewerId: string, level?: ShareLevel) => Promise<void>;
  revoke: (viewerId: string) => Promise<void>;

  // プロフィール
  getProfile: (userId?: string) => Promise<Profile | null>;
  updateProfile: (profile: Partial<Omit<Profile, 'user_id' | 'created_at' | 'updated_at'>>) => Promise<Profile>;
  searchProfiles: (query: string) => Promise<Profile[]>;

  // フレンド
  sendFriendRequest: (toUserId: string) => Promise<FriendRequest>;
  getPendingRequests: () => Promise<FriendRequest[]>;
  getSentRequests: () => Promise<FriendRequest[]>;
  acceptFriendRequest: (requestId: number) => Promise<void>;
  rejectFriendRequest: (requestId: number) => Promise<void>;
  cancelFriendRequest: (requestId: number) => Promise<void>;
  getFriends: () => Promise<string[]>;
  removeFriend: (friendId: string) => Promise<void>;

  // ユーザー設定
  getSettings: () => Promise<UserSettings | null>;
  updateSettings: (settings: Partial<Omit<UserSettings, 'user_id' | 'updated_at'>>) => Promise<UserSettings>;
  enableGhostMode: (durationMinutes?: number) => Promise<void>;
  disableGhostMode: () => Promise<void>;

  // グループ
  createGroup: (name: string, description?: string) => Promise<Group>;
  getGroups: () => Promise<Group[]>;
  getGroupMembers: (groupId: string) => Promise<GroupMember[]>;
  joinGroup: (inviteCode: string) => Promise<Group>;
  leaveGroup: (groupId: string) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;

  // Realtime
  subscribeLocations: (onUpdate: (row: LocationCurrentRow) => void) => import('@supabase/supabase-js').RealtimeChannel;
  subscribeFriendRequests: (onUpdate: (request: FriendRequest) => void) => import('@supabase/supabase-js').RealtimeChannel;

  // チャット
  getOrCreateDirectChat: (otherUserId: string) => Promise<ChatRoom>;
  getOrCreateGroupChat: (groupId: string) => Promise<ChatRoom>;
  getChatRooms: () => Promise<ChatRoom[]>;
  getChatRoomMembers: (roomId: string) => Promise<string[]>;
  sendMessage: (roomId: string, content: string, messageType?: MessageType, metadata?: Record<string, unknown>) => Promise<Message>;
  getMessages: (roomId: string, options?: { limit?: number; before?: number }) => Promise<Message[]>;
  markAsRead: (roomId: string) => Promise<void>;
  subscribeMessages: (roomId: string, onMessage: (message: Message) => void) => import('@supabase/supabase-js').RealtimeChannel;

  // リアクション
  sendReaction: (toUserId: string, emoji: string, message?: string) => Promise<LocationReaction>;
  getReceivedReactions: (options?: { limit?: number; since?: Date }) => Promise<LocationReaction[]>;
  getSentReactions: (options?: { limit?: number }) => Promise<LocationReaction[]>;
  subscribeReactions: (onReaction: (reaction: LocationReaction) => void) => import('@supabase/supabase-js').RealtimeChannel;

  // Bump
  findNearbyFriends: (myLat: number, myLon: number, radiusMeters?: number) => Promise<NearbyUser[]>;
  recordBump: (nearbyUserId: string, distance: number, lat: number, lon: number) => Promise<BumpEvent>;
  getBumpHistory: (options?: { limit?: number; since?: Date }) => Promise<BumpEvent[]>;

  // お気に入りの場所
  addFavoritePlace: (place: Omit<FavoritePlace, 'id' | 'user_id' | 'created_at' | 'updated_at'>) => Promise<FavoritePlace>;
  getFavoritePlaces: (userId?: string) => Promise<FavoritePlace[]>;
  updateFavoritePlace: (placeId: string, updates: Partial<Omit<FavoritePlace, 'id' | 'user_id' | 'created_at' | 'updated_at'>>) => Promise<FavoritePlace>;
  deleteFavoritePlace: (placeId: string) => Promise<void>;
  checkAtFavoritePlace: (lat: number, lon: number, userId?: string) => Promise<FavoritePlace | null>;
  getVisibleFriendsWithPlaces: () => Promise<(LocationCurrentRow & { place?: FavoritePlace })[]>;

  // ユーティリティ
  calculateDistance: (lat1: number, lon1: number, lat2: number, lon2: number) => number;
  estimateMotionType: (speedMs: number | null | undefined) => MotionType;
}
