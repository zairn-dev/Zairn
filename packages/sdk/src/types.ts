/**
 * zairn SDK 型定義
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
  heading: number | null;
  altitude: number | null;
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
  status_emoji: string | null;
  status_text: string | null;
  status_expires_at: string | null;
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
// ブロック
// =====================
export interface BlockedUser {
  blocker_id: string;
  blocked_id: string;
  created_at: string;
}

// =====================
// プッシュ通知
// =====================
export interface PushSubscription {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
  created_at: string;
}

export interface NotificationPreferences {
  user_id: string;
  friend_requests: boolean;
  reactions: boolean;
  chat_messages: boolean;
  bumps: boolean;
  updated_at: string;
}

// =====================
// ストリーク
// =====================
export interface FriendStreak {
  user_id: string;
  friend_id: string;
  current_streak: number;
  longest_streak: number;
  last_interaction_date: string;
  updated_at: string;
}

// =====================
// フレンドのフレンド
// =====================
export interface FriendOfFriend {
  user_id: string;
  mutual_friend_ids: string[];
}

// =====================
// 訪問セル（エリア塗りつぶし）
// =====================
export interface VisitedCell {
  user_id: string;
  geohash: string;
  first_visited_at: string;
  last_visited_at: string;
  visit_count: number;
}

export interface VisitedCellStats {
  user_id: string;
  total_cells: number;
  exploring_since: string;
  last_explored_at: string;
}

export interface AreaRanking {
  user_id: string;
  cell_count: number;
  rank: number;
}

// =====================
// 共有ポリシー（SecureCheck）
// =====================
export type SharingEffectLevel = 'none' | 'coarse' | 'current' | 'history';

export type PolicyCondition =
  | { type: 'time_range'; start: string; end: string; timezone?: string }
  | { type: 'geofence'; lat: number; lon: number; radius_m: number; inside: boolean }
  | { type: 'proximity'; max_distance_m: number }
  | { type: 'trust_score'; min: number };

export interface SharingPolicyEffect {
  level: SharingEffectLevel;
  coarse_radius_m?: number;
}

export interface SharingPolicy {
  id: string;
  owner_id: string;
  viewer_id: string | null;
  conditions: PolicyCondition[];
  effect_level: SharingEffectLevel;
  coarse_radius_m: number | null;
  priority: number;
  label: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SharingPolicyCreate {
  viewer_id?: string | null;
  conditions: PolicyCondition[];
  effect_level: SharingEffectLevel;
  coarse_radius_m?: number;
  priority?: number;
  label?: string;
}

/** Location after policy filtering (may be coarsened) */
export interface FilteredLocation extends LocationCurrentRow {
  /** Original share level from share_rules */
  share_level: ShareLevel;
  /** Effective level after policy evaluation */
  effective_level: SharingEffectLevel;
  /** True if coordinates were coarsened */
  coarsened: boolean;
}

// =====================
// SDK戻り値の型
// =====================
export interface LocationCore {
  // Supabaseクライアント
  supabase: import('@supabase/supabase-js').SupabaseClient;

  // 位置情報
  sendLocation: (latOrUpdate: number | LocationUpdate, lon?: number, accuracy?: number | null) => Promise<void>;
  sendLocationWithTrail: (update: LocationUpdate) => Promise<void>;
  getVisibleFriends: () => Promise<LocationCurrentRow[]>;
  getLocationHistory: (userId: string, options?: { limit?: number; since?: Date }) => Promise<LocationHistoryRow[]>;
  saveLocationHistory: (lat: number, lon: number, accuracy?: number | null) => Promise<void>;
  getTrailFriendIds: () => Promise<string[]>;

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

  // アバター
  uploadAvatar: (file: { arrayBuffer(): Promise<ArrayBuffer>; type: string; name?: string }) => Promise<string>;
  deleteAvatar: () => Promise<void>;

  // ステータス絵文字
  setStatus: (emoji: string, text?: string, durationMinutes?: number) => Promise<void>;
  clearStatus: () => Promise<void>;

  // ブロック
  blockUser: (userId: string) => Promise<void>;
  unblockUser: (userId: string) => Promise<void>;
  getBlockedUsers: () => Promise<string[]>;
  isBlocked: (userId: string) => Promise<boolean>;

  // 共有期限
  setShareExpiry: (viewerId: string, expiresAt: Date) => Promise<void>;

  // プッシュ通知
  registerPushSubscription: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) => Promise<void>;
  unregisterPushSubscription: (endpoint: string) => Promise<void>;
  getNotificationPreferences: () => Promise<NotificationPreferences | null>;
  updateNotificationPreferences: (prefs: Partial<Omit<NotificationPreferences, 'user_id' | 'updated_at'>>) => Promise<NotificationPreferences>;

  // ストリーク
  recordInteraction: (friendId: string) => Promise<void>;
  getStreak: (friendId: string) => Promise<FriendStreak | null>;
  getStreaks: () => Promise<FriendStreak[]>;

  // フレンドのフレンド
  getFriendsOfFriends: () => Promise<FriendOfFriend[]>;

  // 訪問セル（エリア塗りつぶし）
  getMyVisitedCells: (options?: { areaPrefix?: string; since?: Date }) => Promise<VisitedCell[]>;
  getFriendVisitedCells: (friendId: string, options?: { areaPrefix?: string }) => Promise<VisitedCell[]>;
  getMyExplorationStats: () => Promise<VisitedCellStats | null>;
  getAreaRanking: (areaPrefix: string, limit?: number) => Promise<AreaRanking[]>;
  getFriendRanking: (options?: { areaPrefix?: string }) => Promise<AreaRanking[]>;
  encodeGeohash: (lat: number, lon: number, precision?: number) => string;
  decodeGeohash: (geohash: string) => { lat: number; lon: number };

  // 共有ポリシー（SecureCheck）
  addSharingPolicy: (policy: SharingPolicyCreate) => Promise<SharingPolicy>;
  getSharingPolicies: () => Promise<SharingPolicy[]>;
  updateSharingPolicy: (policyId: string, updates: Partial<SharingPolicyCreate>) => Promise<SharingPolicy>;
  deleteSharingPolicy: (policyId: string) => Promise<void>;
  getVisibleFriendsFiltered: (myLat: number, myLon: number) => Promise<FilteredLocation[]>;

  // ユーティリティ
  calculateDistance: (lat1: number, lon1: number, lat2: number, lon2: number) => number;
  estimateMotionType: (speedMs: number | null | undefined) => MotionType;
}
