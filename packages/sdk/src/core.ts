/**
 * zairn SDK コア実装
 */
import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import {
  LocationCoreOptions,
  LocationCurrentRow,
  LocationUpdate,
  LocationHistoryRow,
  ShareLevel,
  Profile,
  FriendRequest,
  UserSettings,
  Group,
  GroupMember,
  ChatRoom,
  Message,
  MessageType,
  LocationReaction,
  BumpEvent,
  NearbyUser,
  FavoritePlace,
  MotionType,
  LocationCore,
  NotificationPreferences,
  FriendStreak,
  FriendOfFriend,
  VisitedCell,
  VisitedCellStats,
  AreaRanking,
  SharingPolicy,
  SharingPolicyCreate,
  FilteredLocation,
  SharingEffectLevel,
  PolicyCondition,
} from './types';
import { computeTrustScore, gateTrustScore } from './trust-scorer';
import type { LocationPoint } from './trust-scorer';
import { evaluatePolicies, coarsenLocation } from './policy-engine';

/**
 * 2点間の距離を計算（メートル）- Haversine公式
 */
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // 地球の半径（メートル）
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1,
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2));
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 速度から移動タイプを推定
 */
export function estimateMotionType(speedMs: number | null | undefined): MotionType {
  if (speedMs === null || speedMs === undefined) return 'unknown';
  if (speedMs < 0.5) return 'stationary';
  if (speedMs < 2) return 'walking';
  if (speedMs < 4) return 'running';
  if (speedMs < 8) return 'cycling';
  if (speedMs < 30) return 'driving';
  return 'transit';
}

/**
 * Geohashエンコード（lat/lon → geohash文字列）
 */
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat: number, lon: number, precision: number = 7): string {
  precision = Math.max(1, Math.min(12, precision));
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180;
  let isLon = true, bits = 0, hashVal = 0;
  let result = '';

  while (result.length < precision) {
    const mid = isLon ? (minLon + maxLon) / 2 : (minLat + maxLat) / 2;
    if (isLon) {
      if (lon >= mid) { hashVal = hashVal * 2 + 1; minLon = mid; }
      else { hashVal = hashVal * 2; maxLon = mid; }
    } else {
      if (lat >= mid) { hashVal = hashVal * 2 + 1; minLat = mid; }
      else { hashVal = hashVal * 2; maxLat = mid; }
    }
    isLon = !isLon;
    bits++;
    if (bits === 5) {
      result += GEOHASH_BASE32[hashVal];
      bits = 0;
      hashVal = 0;
    }
  }
  return result;
}

/**
 * Geohashデコード（geohash → lat/lonの中心点）
 */
export function decodeGeohash(geohash: string): { lat: number; lon: number } {
  if (!geohash || !GEOHASH_CHARS_RE.test(geohash)) {
    throw new Error(`Invalid geohash: ${geohash}`);
  }
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180;
  let isLon = true;

  for (const ch of geohash) {
    const val = GEOHASH_BASE32.indexOf(ch);
    if (val === -1) break;
    for (let bit = 4; bit >= 0; bit--) {
      const mid = isLon ? (minLon + maxLon) / 2 : (minLat + maxLat) / 2;
      if (isLon) {
        if (val & (1 << bit)) minLon = mid; else maxLon = mid;
      } else {
        if (val & (1 << bit)) minLat = mid; else maxLat = mid;
      }
      isLon = !isLon;
    }
  }
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

/**
 * UUID v4 format validation (prevents PostgREST filter injection via .or() / .in())
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertUuid(value: string, name = 'id'): void {
  if (!UUID_RE.test(value)) throw new Error(`Invalid UUID for ${name}: ${value}`);
}

/**
 * Sanitize geohash prefix for LIKE queries (prevent pattern injection with % and _)
 */
const GEOHASH_CHARS_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]+$/;
function sanitizeGeohashPrefix(prefix: string): string {
  const lower = prefix.toLowerCase();
  if (!GEOHASH_CHARS_RE.test(lower)) throw new Error(`Invalid geohash prefix: ${prefix}`);
  return lower;
}

/**
 * zairn SDKのメインファクトリ関数
 */
export function createLocationCore(opts: LocationCoreOptions): LocationCore {
  const supabase: SupabaseClient = createClient(opts.supabaseUrl, opts.supabaseAnonKey);

  // =====================
  // Production safety check: Realtime RLS
  // =====================
  // Supabase Realtime does NOT enforce RLS by default.
  // Without enabling it in the dashboard, ALL authenticated users receive
  // ALL row changes on subscribed tables — a critical privacy leak.
  //
  // How to fix:
  //   1. Go to Supabase Dashboard → Database → Replication
  //   2. For each table (locations_current, friend_requests, messages):
  //      Enable "Realtime" AND enable "RLS" checkbox
  //
  // We emit a one-time warning at SDK init to catch this in development.
  if (typeof console !== 'undefined' && !opts.suppressRealtimeRlsWarning) {
    console.warn(
      '[zairn/sdk] IMPORTANT: Ensure Realtime RLS is enabled in Supabase Dashboard ' +
      '(Database → Replication → enable RLS for locations_current, friend_requests, messages). ' +
      'Without this, ALL authenticated users can see ALL location updates. ' +
      'Set { suppressRealtimeRlsWarning: true } after confirming RLS is enabled.'
    );
  }

  const getUserId = async (): Promise<string> => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new Error('Not authenticated');
    return data.user.id;
  };

  // =====================
  // 位置情報
  // =====================
  const sendLocation = async (
    latOrUpdate: number | LocationUpdate,
    lon?: number,
    accuracy?: number | null
  ): Promise<void> => {
    try {
      const userId = await getUserId();

      // ゴーストモードチェック
      const settings = await getSettings();
      if (settings?.ghost_mode) {
        if (!settings.ghost_until || new Date(settings.ghost_until) > new Date()) {
          return;
        }
      }

      // 引数のパース（後方互換性のため2つの形式をサポート）
      let update: LocationUpdate;
      if (typeof latOrUpdate === 'object') {
        update = latOrUpdate;
      } else {
        if (lon === undefined) throw new Error('lon is required when passing lat as first argument');
        update = { lat: latOrUpdate, lon, accuracy };
      }

      // 入力バリデーション（NaN/Infinityも弾く）
      if (!Number.isFinite(update.lat) || update.lat < -90 || update.lat > 90) throw new Error('Invalid latitude: must be between -90 and 90');
      if (!Number.isFinite(update.lon) || update.lon < -180 || update.lon > 180) throw new Error('Invalid longitude: must be between -180 and 180');
      if (update.accuracy != null && (!Number.isFinite(update.accuracy) || update.accuracy < 0 || update.accuracy > 10000)) throw new Error('Invalid accuracy: must be between 0 and 10000');
      if (update.battery_level != null && (!Number.isFinite(update.battery_level) || update.battery_level < 0 || update.battery_level > 100)) throw new Error('Invalid battery level: must be between 0 and 100');

      // 現在の位置を取得して、滞在時間を計算
      const { data: current } = await supabase
        .from('locations_current')
        .select('lat, lon, location_since')
        .eq('user_id', userId)
        .maybeSingle();

      let locationSince = new Date().toISOString();
      if (current) {
        const distance = calculateDistance(current.lat, current.lon, update.lat, update.lon);
        if (distance < 50 && current.location_since) {
          locationSince = current.location_since;
        }

        // Trust scoring: use previous location as single-entry history
        const trustHistory: LocationPoint[] = [{
          lat: current.lat,
          lon: current.lon,
          accuracy: null,
          timestamp: current.location_since ?? new Date().toISOString(),
        }];
        const trustResult = computeTrustScore(
          { lat: update.lat, lon: update.lon, accuracy: update.accuracy ?? null, timestamp: new Date().toISOString() },
          trustHistory,
        );
        if (gateTrustScore(trustResult) === 'deny') {
          throw new Error('Location trust check failed: suspicious location pattern detected');
        }
      }

      const motion = update.motion ?? estimateMotionType(update.speed);

      const { error } = await supabase
        .from('locations_current')
        .upsert({
          user_id: userId,
          lat: update.lat,
          lon: update.lon,
          accuracy: update.accuracy ?? null,
          updated_at: new Date().toISOString(),
          battery_level: update.battery_level ?? null,
          is_charging: update.is_charging ?? false,
          location_since: locationSince,
          speed: update.speed ?? null,
          motion,
        });
      if (error) throw error;
    } catch (e) {
      // Re-throw authentication errors; ignore ghost mode early returns
      if (e instanceof Error && e.message === 'Not authenticated') throw e;
      throw e;
    }
  };

  /**
   * Get current locations of friends visible to the authenticated user.
   * Results are filtered server-side by RLS (share_rules).
   * @param options.limit Maximum number of results (default: 500)
   */
  const getFriendsLocations = async (
    options?: { limit?: number },
  ): Promise<LocationCurrentRow[]> => {
    let query = supabase.from('locations_current').select('*');
    // Default limit to prevent unbounded queries with large friend lists
    query = query.limit(options?.limit ?? 500);
    const { data, error } = await query;
    if (error) {
      // 認証エラーは再throw（セッション切れ等をクライアントに伝える）
      if (error.code === 'PGRST301' || error.message?.includes('JWT')) throw error;
      // Log non-auth errors so developers can diagnose Supabase downtime
      console.warn(`[zairn/sdk] getVisibleFriends failed (non-auth): ${error.message}`);
      return [];
    }
    return (data ?? []) as LocationCurrentRow[];
  };

  const getLocationHistory = async (
    userId: string,
    options?: { limit?: number; offset?: number; since?: Date }
  ): Promise<LocationHistoryRow[]> => {
    assertUuid(userId, 'userId');
    const limit = Math.min(options?.limit ?? 500, 5000);
    const offset = options?.offset ?? 0;
    let query = supabase
      .from('locations_history')
      .select('*')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (options?.since) query = query.gte('recorded_at', options.since.toISOString());

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as LocationHistoryRow[];
  };

  const saveLocationHistory = async (
    lat: number,
    lon: number,
    accuracy?: number | null
  ): Promise<void> => {
    const userId = await getUserId();
    const { error } = await supabase
      .from('locations_history')
      .insert({ user_id: userId, lat, lon, accuracy: accuracy ?? null });
    if (error) throw error;
  };

  // =====================
  // 足跡（軌跡記録）
  // =====================
  let lastSavedHistoryPoint: { lat: number; lon: number } | null = null;
  const TRAIL_MIN_DISTANCE_METERS = 30;

  const sendLocationWithTrail = async (update: LocationUpdate): Promise<void> => {
    // Ghost mode check — do it once before both sendLocation and history save
    try {
      const settings = await getSettings();
      if (settings?.ghost_mode) {
        if (!settings.ghost_until || new Date(settings.ghost_until) > new Date()) {
          return;
        }
      }
    } catch {
      // Auth not ready or settings table missing — skip everything
      return;
    }

    // sendLocation handles its own ghost mode check but that's cheap (cached by Supabase)
    await sendLocation(update);

    // 距離ベースのサンプリングで履歴保存
    try {
      if (!lastSavedHistoryPoint) {
        await saveLocationHistory(update.lat, update.lon, update.accuracy);
        lastSavedHistoryPoint = { lat: update.lat, lon: update.lon };
      } else {
        const dist = calculateDistance(
          lastSavedHistoryPoint.lat, lastSavedHistoryPoint.lon,
          update.lat, update.lon
        );
        if (dist >= TRAIL_MIN_DISTANCE_METERS) {
          await saveLocationHistory(update.lat, update.lon, update.accuracy);
          lastSavedHistoryPoint = { lat: update.lat, lon: update.lon };
        }
      }
    } catch {
      // History saving is best-effort — don't crash the location update flow
    }
  };

  const getTrailFriendIds = async (): Promise<string[]> => {
    const userId = await getUserId();
    assertUuid(userId, 'userId');
    const { data, error } = await supabase
      .from('share_rules')
      .select('owner_id')
      .eq('viewer_id', userId)
      .eq('level', 'history')
      .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString());
    if (error) throw error;

    const ownerIds = (data ?? []).map(r => r.owner_id).filter((id: string) => id !== userId);
    if (ownerIds.length === 0) return [];

    // Filter out blocked users
    const { data: blocks } = await supabase
      .from('blocked_users')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
    if (blocks && blocks.length > 0) {
      const blockedSet = new Set(
        blocks.map(b => b.blocker_id === userId ? b.blocked_id : b.blocker_id)
      );
      return ownerIds.filter(id => !blockedSet.has(id));
    }
    return ownerIds;
  };

  // =====================
  // 共有ルール
  // =====================
  const VALID_SHARE_LEVELS: ShareLevel[] = ['none', 'current', 'history'];

  const allow = async (viewerId: string, level: ShareLevel = 'current'): Promise<void> => {
    assertUuid(viewerId, 'viewerId');
    if (!VALID_SHARE_LEVELS.includes(level)) throw new Error(`Invalid share level: ${level}`);
    const ownerId = await getUserId();
    const { error } = await supabase
      .from('share_rules')
      .upsert({ owner_id: ownerId, viewer_id: viewerId, level });
    if (error) throw error;
  };

  const revoke = async (viewerId: string): Promise<void> => {
    assertUuid(viewerId, 'viewerId');
    const ownerId = await getUserId();
    const { error } = await supabase
      .from('share_rules')
      .delete()
      .eq('owner_id', ownerId)
      .eq('viewer_id', viewerId);
    if (error) throw error;
  };

  // =====================
  // 共有ポリシー（SecureCheck）
  // =====================
  const addSharingPolicy = async (policy: SharingPolicyCreate): Promise<SharingPolicy> => {
    if (policy.viewer_id) assertUuid(policy.viewer_id, 'viewer_id');
    const ownerId = await getUserId();
    const { data, error } = await supabase
      .from('sharing_policies')
      .insert({
        owner_id: ownerId,
        viewer_id: policy.viewer_id ?? null,
        conditions: policy.conditions,
        effect_level: policy.effect_level,
        coarse_radius_m: policy.coarse_radius_m ?? null,
        priority: policy.priority ?? 0,
        label: policy.label ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return data as SharingPolicy;
  };

  const getSharingPolicies = async (): Promise<SharingPolicy[]> => {
    const ownerId = await getUserId();
    const { data, error } = await supabase
      .from('sharing_policies')
      .select('*')
      .eq('owner_id', ownerId)
      .order('priority', { ascending: false });
    if (error) throw error;
    return (data ?? []) as SharingPolicy[];
  };

  const updateSharingPolicy = async (
    policyId: string,
    updates: Partial<SharingPolicyCreate>,
  ): Promise<SharingPolicy> => {
    assertUuid(policyId, 'policyId');
    if (updates.viewer_id) assertUuid(updates.viewer_id, 'viewer_id');
    const ownerId = await getUserId();
    const { data, error } = await supabase
      .from('sharing_policies')
      .update({
        ...(updates.viewer_id !== undefined && { viewer_id: updates.viewer_id }),
        ...(updates.conditions !== undefined && { conditions: updates.conditions }),
        ...(updates.effect_level !== undefined && { effect_level: updates.effect_level }),
        ...(updates.coarse_radius_m !== undefined && { coarse_radius_m: updates.coarse_radius_m }),
        ...(updates.priority !== undefined && { priority: updates.priority }),
        ...(updates.label !== undefined && { label: updates.label }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', policyId)
      .eq('owner_id', ownerId)
      .select()
      .single();
    if (error) throw error;
    return data as SharingPolicy;
  };

  const deleteSharingPolicy = async (policyId: string): Promise<void> => {
    assertUuid(policyId, 'policyId');
    const ownerId = await getUserId();
    const { error } = await supabase
      .from('sharing_policies')
      .delete()
      .eq('id', policyId)
      .eq('owner_id', ownerId);
    if (error) throw error;
  };

  const getVisibleFriendsFiltered = async (
    myLat: number,
    myLon: number,
  ): Promise<FilteredLocation[]> => {
    const userId = await getUserId();

    // Fetch friends and their policies in parallel
    const [friends, policiesResult, rulesResult] = await Promise.all([
      getFriendsLocations(),
      supabase
        .from('sharing_policies')
        .select('*')
        .eq('enabled', true),
      supabase
        .from('share_rules')
        .select('owner_id, viewer_id, level')
        .eq('viewer_id', userId),
    ]);

    // Build share level map: owner_id → level
    const shareLevels = new Map<string, ShareLevel>();
    for (const rule of rulesResult.data ?? []) {
      shareLevels.set(rule.owner_id, rule.level as ShareLevel);
    }

    // Group policies by owner_id
    const allPolicies = (policiesResult.data ?? []) as SharingPolicy[];
    const policiesByOwner = new Map<string, SharingPolicy[]>();
    for (const p of allPolicies) {
      const list = policiesByOwner.get(p.owner_id) ?? [];
      list.push(p);
      policiesByOwner.set(p.owner_id, list);
    }

    const results: FilteredLocation[] = [];
    const now = new Date();

    for (const friend of friends) {
      if (friend.user_id === userId) continue;

      const shareLevel = shareLevels.get(friend.user_id) ?? 'none';
      if (shareLevel === 'none') continue;

      const ownerPolicies = policiesByOwner.get(friend.user_id) ?? [];
      const { level, coarseRadiusM } = evaluatePolicies(
        ownerPolicies,
        userId,
        {
          ownerLat: friend.lat,
          ownerLon: friend.lon,
          viewerLat: myLat,
          viewerLon: myLon,
          now,
        },
        shareLevel,
      );

      if (level === 'none') continue;

      let { lat, lon } = friend;
      let coarsened = false;

      if (level === 'coarse' && coarseRadiusM) {
        const snapped = coarsenLocation(lat, lon, coarseRadiusM);
        lat = snapped.lat;
        lon = snapped.lon;
        coarsened = true;
      }

      results.push({
        ...friend,
        lat,
        lon,
        share_level: shareLevel,
        effective_level: level,
        coarsened,
      });
    }

    return results;
  };

  // =====================
  // プロフィール
  // =====================
  const getProfile = async (userId?: string): Promise<Profile | null> => {
    if (userId) assertUuid(userId, 'userId');
    const targetId = userId ?? await getUserId();
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', targetId)
      .maybeSingle();
    if (error) throw error;
    return data as Profile | null;
  };

  const updateProfile = async (
    profile: Partial<Omit<Profile, 'user_id' | 'created_at' | 'updated_at'>>
  ): Promise<Profile> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        user_id: userId,
        ...profile,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    return data as Profile;
  };

  const searchProfiles = async (query: string): Promise<Profile[]> => {
    // Sanitize: strip PostgREST filter operators to prevent injection
    const sanitized = query.replace(/[%_,.()"'\\]/g, '');
    if (!sanitized) return [];
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id,username,display_name,avatar_url,status_emoji,status_text,created_at')
      .or(`username.ilike.%${sanitized}%,display_name.ilike.%${sanitized}%`)
      .limit(20);
    if (error) throw error;
    return (data ?? []) as Profile[];
  };

  // =====================
  // フレンドリクエスト
  // =====================
  const sendFriendRequest = async (toUserId: string): Promise<FriendRequest> => {
    assertUuid(toUserId, 'toUserId');
    const fromUserId = await getUserId();
    if (fromUserId === toUserId) throw new Error('Cannot send friend request to yourself');

    const { data, error } = await supabase
      .from('friend_requests')
      .insert({ from_user_id: fromUserId, to_user_id: toUserId })
      .select()
      .single();
    if (error) throw error;
    return data as FriendRequest;
  };

  const getPendingRequests = async (): Promise<FriendRequest[]> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('friend_requests')
      .select('*')
      .eq('to_user_id', userId)
      .eq('status', 'pending');
    if (error) throw error;
    return (data ?? []) as FriendRequest[];
  };

  const getSentRequests = async (): Promise<FriendRequest[]> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('friend_requests')
      .select('*')
      .eq('from_user_id', userId)
      .eq('status', 'pending');
    if (error) throw error;
    return (data ?? []) as FriendRequest[];
  };

  const acceptFriendRequest = async (requestId: number): Promise<void> => {
    // security definer関数で承認 + 双方向share_rules作成をアトミックに実行
    const { error } = await supabase.rpc('accept_friend_request', { p_request_id: requestId });
    if (error) throw error;
  };

  const rejectFriendRequest = async (requestId: number): Promise<void> => {
    const userId = await getUserId();
    const { error } = await supabase
      .from('friend_requests')
      .update({ status: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('to_user_id', userId);
    if (error) throw error;
  };

  const cancelFriendRequest = async (requestId: number): Promise<void> => {
    const userId = await getUserId();
    const { error } = await supabase
      .from('friend_requests')
      .delete()
      .eq('id', requestId)
      .eq('from_user_id', userId);
    if (error) throw error;
  };

  const getFriends = async (): Promise<string[]> => {
    const userId = await getUserId();
    assertUuid(userId, 'userId');
    const { data, error } = await supabase
      .from('friend_requests')
      .select('from_user_id, to_user_id')
      .eq('status', 'accepted')
      .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);
    if (error) throw error;

    const friendIds = (data ?? []).map(r =>
      r.from_user_id === userId ? r.to_user_id : r.from_user_id
    );
    return [...new Set(friendIds)];
  };

  const removeFriend = async (friendId: string): Promise<void> => {
    assertUuid(friendId, 'friendId');
    // security definer関数でfriend_requests + share_rulesの削除をアトミックに実行
    const { error } = await supabase.rpc('remove_friend', { p_friend_id: friendId });
    if (error) throw error;
  };

  // =====================
  // ユーザー設定
  // =====================
  const getSettings = async (): Promise<UserSettings | null> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      // 認証エラーは再throw
      if (error.code === 'PGRST301' || error.message?.includes('JWT')) throw error;
      return null;
    }
    return data as UserSettings | null;
  };

  const updateSettings = async (
    settings: Partial<Omit<UserSettings, 'user_id' | 'updated_at'>>
  ): Promise<UserSettings> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('user_settings')
      .upsert({
        user_id: userId,
        ...settings,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    return data as UserSettings;
  };

  const enableGhostMode = async (durationMinutes?: number): Promise<void> => {
    const ghostUntil = durationMinutes
      ? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
      : null;
    await updateSettings({ ghost_mode: true, ghost_until: ghostUntil });
  };

  const disableGhostMode = async (): Promise<void> => {
    await updateSettings({ ghost_mode: false, ghost_until: null });
  };

  // =====================
  // グループ
  // =====================
  const createGroup = async (name: string, description?: string): Promise<Group> => {
    // Cryptographically random invite code
    const randomBytes = new Uint8Array(8);
    (globalThis as any).crypto.getRandomValues(randomBytes);
    const inviteCode = Array.from(randomBytes, (b: number) => b.toString(36)).join('').substring(0, 10).toUpperCase();

    // security definer関数でグループ + メンバー追加をアトミックに実行
    const { data: groupId, error } = await supabase.rpc('create_group_atomic', {
      p_name: name,
      p_description: description ?? null,
      p_invite_code: inviteCode,
    });
    if (error) throw error;

    const { data: group, error: fetchError } = await supabase
      .from('groups')
      .select('*')
      .eq('id', groupId)
      .single();
    if (fetchError) throw fetchError;

    return group as Group;
  };

  const getGroups = async (): Promise<Group[]> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('group_members')
      .select('group_id, groups(*)')
      .eq('user_id', userId);
    if (error) throw error;
    return (data ?? []).map(d => d.groups) as unknown as Group[];
  };

  const getGroupMembers = async (groupId: string): Promise<GroupMember[]> => {
    assertUuid(groupId, 'groupId');
    const { data, error } = await supabase
      .from('group_members')
      .select('*')
      .eq('group_id', groupId);
    if (error) throw error;
    return (data ?? []) as GroupMember[];
  };

  const joinGroup = async (inviteCode: string): Promise<Group> => {
    // security definer関数でinvite_codeを検証してメンバー追加
    const { data: groupId, error } = await supabase.rpc('join_group_by_invite', {
      p_invite_code: inviteCode.toUpperCase(),
    });
    if (error) throw new Error('Invalid invite code');

    const { data: group, error: groupError } = await supabase
      .from('groups')
      .select('*')
      .eq('id', groupId)
      .single();
    if (groupError) throw groupError;

    return group as Group;
  };

  const leaveGroup = async (groupId: string): Promise<void> => {
    assertUuid(groupId, 'groupId');
    const { error } = await supabase.rpc('leave_group', { p_group_id: groupId });
    if (error) throw error;
  };

  const deleteGroup = async (groupId: string): Promise<void> => {
    const userId = await getUserId();
    const { error } = await supabase
      .from('groups')
      .delete()
      .eq('id', groupId)
      .eq('owner_id', userId);
    if (error) throw error;
  };

  // =====================
  // Realtime購読
  // =====================
  const subscribeLocations = (
    onUpdate: (row: LocationCurrentRow) => void,
    onError?: (status: string, err?: Error) => void,
  ): RealtimeChannel => {
    // Note: Supabase Realtime RLS must be enabled in the dashboard for server-side filtering.
    // The client-side filter here reduces unnecessary processing but does NOT provide security.
    // Enable Realtime RLS: Dashboard → Database → Replication → Enable RLS for locations_current
    return supabase
      .channel('locations')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'locations_current' },
        payload => {
          if (payload.new && typeof payload.new === 'object' && 'user_id' in payload.new) {
            onUpdate(payload.new as LocationCurrentRow);
          }
        }
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          onError?.(status, err instanceof Error ? err : undefined);
        }
      });
  };

  const subscribeFriendRequests = (
    onUpdate: (request: FriendRequest) => void,
    onError?: (status: string, err?: Error) => void,
  ): RealtimeChannel => {
    return supabase
      .channel('friend_requests')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friend_requests' },
        payload => {
          if (payload.new && typeof payload.new === 'object' && 'id' in payload.new) {
            onUpdate(payload.new as FriendRequest);
          }
        }
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          onError?.(status, err instanceof Error ? err : undefined);
        }
      });
  };

  // =====================
  // チャット機能
  // =====================
  const getOrCreateDirectChat = async (otherUserId: string): Promise<ChatRoom> => {
    // security definer関数でフレンド・ブロックチェック + ルーム作成をアトミックに実行
    // 競合状態（重複ルーム作成）も防止される
    const { data: roomId, error } = await supabase.rpc('create_direct_chat', {
      p_other_user_id: otherUserId,
    });
    if (error) throw error;

    const { data: room, error: fetchError } = await supabase
      .from('chat_rooms')
      .select('*')
      .eq('id', roomId)
      .single();
    if (fetchError) throw fetchError;

    return room as ChatRoom;
  };

  const getOrCreateGroupChat = async (groupId: string): Promise<ChatRoom> => {
    // security definer関数でメンバーチェック + ルーム作成をアトミックに実行
    // 競合状態（重複ルーム作成）も防止される
    const { data: roomId, error } = await supabase.rpc('create_group_chat', {
      p_group_id: groupId,
    });
    if (error) throw error;

    const { data: room, error: fetchError } = await supabase
      .from('chat_rooms')
      .select('*')
      .eq('id', roomId)
      .single();
    if (fetchError) throw fetchError;

    return room as ChatRoom;
  };

  const getChatRooms = async (): Promise<ChatRoom[]> => {
    const userId = await getUserId();
    const { data: memberOf } = await supabase
      .from('chat_room_members')
      .select('room_id')
      .eq('user_id', userId);

    if (!memberOf || memberOf.length === 0) return [];

    const roomIds = memberOf.map(m => m.room_id);
    const { data: rooms, error } = await supabase
      .from('chat_rooms')
      .select('*')
      .in('id', roomIds);
    if (error) throw error;

    return (rooms ?? []) as ChatRoom[];
  };

  const getChatRoomMembers = async (roomId: string): Promise<string[]> => {
    assertUuid(roomId, 'roomId');
    const { data, error } = await supabase
      .from('chat_room_members')
      .select('user_id')
      .eq('room_id', roomId);
    if (error) throw error;
    return (data ?? []).map(m => m.user_id);
  };

  const sendMessage = async (
    roomId: string,
    content: string,
    messageType: MessageType = 'text',
    metadata?: Record<string, unknown>
  ): Promise<Message> => {
    assertUuid(roomId, 'roomId');
    if (content.length > 10000) throw new Error('Message too long (max 10000 characters)');
    if (metadata && JSON.stringify(metadata).length > 5000) throw new Error('Metadata too large');
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('messages')
      .insert({
        room_id: roomId,
        sender_id: userId,
        content,
        message_type: messageType,
        metadata: metadata ?? null,
      })
      .select()
      .single();
    if (error) throw error;

    // ストリーク自動記録（best-effort）
    try {
      const { data: members } = await supabase
        .from('chat_room_members')
        .select('user_id')
        .eq('room_id', roomId)
        .neq('user_id', userId);
      for (const m of members ?? []) {
        await supabase.rpc('record_interaction', { p_user_id: userId, p_friend_id: m.user_id });
      }
    } catch { /* streak tracking is best-effort */ }

    return data as Message;
  };

  const getMessages = async (
    roomId: string,
    options?: { limit?: number; before?: number }
  ): Promise<Message[]> => {
    assertUuid(roomId, 'roomId');
    let query = supabase
      .from('messages')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false })
      .limit(Math.min(options?.limit ?? 100, 1000));

    if (options?.before) query = query.lt('id', options.before);

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Message[];
  };

  const markAsRead = async (roomId: string): Promise<void> => {
    assertUuid(roomId, 'roomId');
    const userId = await getUserId();
    const { error } = await supabase
      .from('chat_room_members')
      .update({ last_read_at: new Date().toISOString() })
      .eq('room_id', roomId)
      .eq('user_id', userId);
    if (error) throw error;
  };

  const subscribeMessages = (
    roomId: string,
    onMessage: (message: Message) => void,
    onError?: (status: string, err?: Error) => void,
  ): RealtimeChannel => {
    assertUuid(roomId, 'roomId');
    return supabase
      .channel(`messages:${roomId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` },
        payload => {
          if (payload.new) {
            onMessage(payload.new as Message);
          }
        }
      )
      .subscribe((status, err) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          onError?.(status, err instanceof Error ? err : undefined);
        }
      });
  };

  // =====================
  // リアクション機能
  // =====================
  const sendReaction = async (toUserId: string, emoji: string, message?: string): Promise<LocationReaction> => {
    assertUuid(toUserId, 'toUserId');
    // Emoji: max 10 grapheme clusters (allows compound emoji), message: max 200 chars
    if (emoji.length > 40) throw new Error('Emoji too long');
    if (message && message.length > 200) throw new Error('Reaction message too long (max 200 characters)');
    const fromUserId = await getUserId();
    const { data, error } = await supabase
      .from('location_reactions')
      .insert({
        from_user_id: fromUserId,
        to_user_id: toUserId,
        emoji,
        message: message ?? null,
      })
      .select()
      .single();
    if (error) throw error;

    // ストリーク自動記録（best-effort）
    supabase.rpc('record_interaction', { p_user_id: fromUserId, p_friend_id: toUserId }).then(() => {}, () => {});

    return data as LocationReaction;
  };

  const getReceivedReactions = async (options?: { limit?: number; since?: Date }): Promise<LocationReaction[]> => {
    const userId = await getUserId();
    let query = supabase
      .from('location_reactions')
      .select('*')
      .eq('to_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(Math.min(options?.limit ?? 100, 1000));

    if (options?.since) query = query.gte('created_at', options.since.toISOString());

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as LocationReaction[];
  };

  const getSentReactions = async (options?: { limit?: number }): Promise<LocationReaction[]> => {
    const userId = await getUserId();
    let query = supabase
      .from('location_reactions')
      .select('*')
      .eq('from_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(Math.min(options?.limit ?? 100, 1000));

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as LocationReaction[];
  };

  const subscribeReactions = (onReaction: (reaction: LocationReaction) => void): RealtimeChannel => {
    return supabase
      .channel('location_reactions')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'location_reactions' },
        payload => {
          if (payload.new) {
            onReaction(payload.new as LocationReaction);
          }
        }
      )
      .subscribe();
  };

  // =====================
  // Bump機能
  // =====================
  const findNearbyFriends = async (
    myLat: number,
    myLon: number,
    radiusMeters: number = 500
  ): Promise<NearbyUser[]> => {
    radiusMeters = Math.max(0, Math.min(50000, radiusMeters));
    const userId = await getUserId();

    // Trust scoring: check caller's location against their last known position
    const { data: currentLoc } = await supabase
      .from('locations_current')
      .select('lat, lon, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (currentLoc) {
      const trustHistory: LocationPoint[] = [{
        lat: currentLoc.lat,
        lon: currentLoc.lon,
        accuracy: null,
        timestamp: currentLoc.updated_at,
      }];
      const trustResult = computeTrustScore(
        { lat: myLat, lon: myLon, accuracy: null, timestamp: new Date().toISOString() },
        trustHistory,
      );
      if (gateTrustScore(trustResult) === 'deny') {
        throw new Error('Location trust check failed: suspicious location pattern detected');
      }
    }

    const friends = await getFriendsLocations();

    const nearby: NearbyUser[] = [];

    for (const friend of friends) {
      if (friend.user_id === userId) continue;

      const distance = calculateDistance(myLat, myLon, friend.lat, friend.lon);
      if (distance <= radiusMeters) {
        nearby.push({
          user_id: friend.user_id,
          lat: friend.lat,
          lon: friend.lon,
          distance_meters: Math.round(distance),
        });
      }
    }

    return nearby.sort((a, b) => a.distance_meters - b.distance_meters);
  };

  const recordBump = async (nearbyUserId: string, distance: number, lat: number, lon: number): Promise<BumpEvent> => {
    assertUuid(nearbyUserId, 'nearbyUserId');
    if (!Number.isFinite(distance) || distance < 0) throw new Error('Invalid distance');
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('Invalid latitude');
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new Error('Invalid longitude');
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('bump_events')
      .insert({
        user_id: userId,
        nearby_user_id: nearbyUserId,
        distance_meters: distance,
        lat,
        lon,
      })
      .select()
      .single();
    if (error) throw error;

    // ストリーク自動記録（best-effort）
    supabase.rpc('record_interaction', { p_user_id: userId, p_friend_id: nearbyUserId }).then(() => {}, () => {});

    return data as BumpEvent;
  };

  const getBumpHistory = async (options?: { limit?: number; since?: Date }): Promise<BumpEvent[]> => {
    const userId = await getUserId();
    assertUuid(userId, 'userId');
    let query = supabase
      .from('bump_events')
      .select('*')
      .or(`user_id.eq.${userId},nearby_user_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(Math.min(options?.limit ?? 100, 1000));

    if (options?.since) query = query.gte('created_at', options.since.toISOString());

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as BumpEvent[];
  };

  // =====================
  // お気に入りの場所
  // =====================
  const addFavoritePlace = async (
    place: Omit<FavoritePlace, 'id' | 'user_id' | 'created_at' | 'updated_at'>
  ): Promise<FavoritePlace> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('favorite_places')
      .insert({ user_id: userId, ...place })
      .select()
      .single();
    if (error) throw error;
    return data as FavoritePlace;
  };

  const getFavoritePlaces = async (userId?: string): Promise<FavoritePlace[]> => {
    if (userId) assertUuid(userId, 'userId');
    const targetId = userId ?? await getUserId();
    const { data, error } = await supabase
      .from('favorite_places')
      .select('*')
      .eq('user_id', targetId);
    // Return empty array if table doesn't exist (404) or other errors
    if (error) return [];
    return (data ?? []) as FavoritePlace[];
  };

  const updateFavoritePlace = async (
    placeId: string,
    updates: Partial<Omit<FavoritePlace, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
  ): Promise<FavoritePlace> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('favorite_places')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', placeId)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw error;
    return data as FavoritePlace;
  };

  const deleteFavoritePlace = async (placeId: string): Promise<void> => {
    const userId = await getUserId();
    const { error } = await supabase
      .from('favorite_places')
      .delete()
      .eq('id', placeId)
      .eq('user_id', userId);
    if (error) throw error;
  };

  const checkAtFavoritePlace = async (
    lat: number,
    lon: number,
    userId?: string
  ): Promise<FavoritePlace | null> => {
    const places = await getFavoritePlaces(userId);
    for (const place of places) {
      const distance = calculateDistance(lat, lon, place.lat, place.lon);
      if (distance <= place.radius_meters) {
        return place;
      }
    }
    return null;
  };

  const getVisibleFriendsWithPlaces = async (): Promise<(LocationCurrentRow & { place?: FavoritePlace })[]> => {
    try {
      const friends = await getFriendsLocations();
      if (friends.length === 0) return [];

      // Batch fetch all favorite places for all visible friends at once (avoids N+1)
      const userIds = friends.map(f => f.user_id);
      const { data: allPlaces } = await supabase
        .from('favorite_places')
        .select('*')
        .in('user_id', userIds);

      const placesByUser = new Map<string, FavoritePlace[]>();
      for (const place of (allPlaces ?? []) as FavoritePlace[]) {
        const list = placesByUser.get(place.user_id) ?? [];
        list.push(place);
        placesByUser.set(place.user_id, list);
      }

      return friends.map(friend => {
        const userPlaces = placesByUser.get(friend.user_id) ?? [];
        const matchedPlace = userPlaces.find(p =>
          calculateDistance(friend.lat, friend.lon, p.lat, p.lon) <= p.radius_meters
        );
        return { ...friend, place: matchedPlace };
      });
    } catch (err: unknown) {
      // 認証エラーは再throw
      const e = err as { code?: string; message?: string };
      if (e?.code === 'PGRST301' || e?.message?.includes('JWT')) throw err;
      console.warn(`[zairn/sdk] getVisibleFriendsWithPlaces failed: ${e?.message ?? err}`);
      return [];
    }
  };

  // =====================
  // アバター
  // =====================
  const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const ALLOWED_AVATAR_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5MB

  const uploadAvatar = async (file: { arrayBuffer(): Promise<ArrayBuffer>; type: string; name?: string }): Promise<string> => {
    const userId = await getUserId();
    const ext = (file.name ?? 'avatar.jpg').split('.').pop()?.toLowerCase() || 'jpg';

    // Validate file extension
    if (!ALLOWED_AVATAR_EXTS.includes(ext)) throw new Error(`Invalid file type: .${ext}. Allowed: ${ALLOWED_AVATAR_EXTS.join(', ')}`);
    // Validate MIME type (required — reject if missing to prevent SVG/HTML XSS)
    if (!file.type || !ALLOWED_AVATAR_TYPES.includes(file.type)) {
      throw new Error(`Invalid or missing content type: ${file.type ?? 'undefined'}. Allowed: ${ALLOWED_AVATAR_TYPES.join(', ')}`);
    }

    // サイズチェックを旧アバター削除の前に実行（失敗時にアバターが消えるのを防ぐ）
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_AVATAR_SIZE) throw new Error(`File too large (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB). Max: 5MB`);

    const filePath = `${userId}/${Date.now()}.${ext}`;

    // 古いアバター一覧を取得（削除は新アバターのアップロード成功後に行う）
    const { data: existing } = await supabase.storage.from('avatars').list(userId);

    const { error: uploadError } = await supabase.storage.from('avatars').upload(filePath, buffer, {
      contentType: file.type,
    });
    if (uploadError) throw uploadError;

    // アップロード成功後に古いアバターを削除（失敗してもアバターが消えない）
    if (existing && existing.length > 0) {
      const oldFiles = existing.map(f => `${userId}/${f.name}`).filter(p => p !== filePath);
      if (oldFiles.length > 0) {
        await supabase.storage.from('avatars').remove(oldFiles);
      }
    }

    const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(filePath);
    const publicUrl = urlData.publicUrl;

    await updateProfile({ avatar_url: publicUrl });
    return publicUrl;
  };

  const deleteAvatar = async (): Promise<void> => {
    const userId = await getUserId();
    const { data: existing } = await supabase.storage.from('avatars').list(userId);
    if (existing && existing.length > 0) {
      await supabase.storage.from('avatars').remove(existing.map(f => `${userId}/${f.name}`));
    }
    await updateProfile({ avatar_url: null });
  };

  // =====================
  // ステータス絵文字
  // =====================
  const setStatus = async (emoji: string, text?: string, durationMinutes?: number): Promise<void> => {
    const expiresAt = durationMinutes
      ? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
      : null;
    await updateProfile({
      status_emoji: emoji,
      status_text: text ?? null,
      status_expires_at: expiresAt,
    } as Partial<Profile>);
  };

  const clearStatus = async (): Promise<void> => {
    await updateProfile({
      status_emoji: null,
      status_text: null,
      status_expires_at: null,
    } as Partial<Profile>);
  };

  // =====================
  // ブロック機能
  // =====================
  const blockUser = async (userId: string): Promise<void> => {
    assertUuid(userId, 'userId');
    const { error } = await supabase.rpc('block_user_atomic', { p_blocked_id: userId });
    if (error) throw error;
  };

  const unblockUser = async (userId: string): Promise<void> => {
    assertUuid(userId, 'userId');
    const blockerId = await getUserId();
    const { error } = await supabase
      .from('blocked_users')
      .delete()
      .eq('blocker_id', blockerId)
      .eq('blocked_id', userId);
    if (error) throw error;
  };

  const getBlockedUsers = async (): Promise<string[]> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('blocked_users')
      .select('blocked_id')
      .eq('blocker_id', userId);
    if (error) throw error;
    return (data ?? []).map(r => r.blocked_id);
  };

  const isBlocked = async (targetUserId: string): Promise<boolean> => {
    const userId = await getUserId();
    assertUuid(userId, 'userId');
    assertUuid(targetUserId, 'targetUserId');
    const { data } = await supabase
      .from('blocked_users')
      .select('blocker_id')
      .or(`and(blocker_id.eq.${userId},blocked_id.eq.${targetUserId}),and(blocker_id.eq.${targetUserId},blocked_id.eq.${userId})`)
      .limit(1);
    return (data ?? []).length > 0;
  };

  // =====================
  // 共有期限
  // =====================
  const setShareExpiry = async (viewerId: string, expiresAt: Date): Promise<void> => {
    assertUuid(viewerId, 'viewerId');
    const ownerId = await getUserId();
    const { error } = await supabase
      .from('share_rules')
      .update({ expires_at: expiresAt.toISOString() })
      .eq('owner_id', ownerId)
      .eq('viewer_id', viewerId);
    if (error) throw error;
  };

  // =====================
  // プッシュ通知
  // =====================
  const registerPushSubscription = async (
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
  ): Promise<void> => {
    const userId = await getUserId();
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth_key: subscription.keys.auth,
      });
    if (error) throw error;
  };

  const unregisterPushSubscription = async (endpoint: string): Promise<void> => {
    const userId = await getUserId();
    const { error } = await supabase
      .from('push_subscriptions')
      .delete()
      .eq('user_id', userId)
      .eq('endpoint', endpoint);
    if (error) throw error;
  };

  const getNotificationPreferences = async (): Promise<NotificationPreferences | null> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return data as NotificationPreferences | null;
  };

  const updateNotificationPreferences = async (
    prefs: Partial<Omit<NotificationPreferences, 'user_id' | 'updated_at'>>
  ): Promise<NotificationPreferences> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('notification_preferences')
      .upsert({
        user_id: userId,
        ...prefs,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    return data as NotificationPreferences;
  };

  // =====================
  // ストリーク
  // =====================
  const recordInteraction = async (friendId: string): Promise<void> => {
    assertUuid(friendId, 'friendId');
    const userId = await getUserId();
    const { error } = await supabase.rpc('record_interaction', {
      p_user_id: userId,
      p_friend_id: friendId,
    });
    if (error) throw error;
  };

  const getStreak = async (friendId: string): Promise<FriendStreak | null> => {
    assertUuid(friendId, 'friendId');
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('friend_streaks')
      .select('*')
      .eq('user_id', userId)
      .eq('friend_id', friendId)
      .maybeSingle();
    if (error) throw error;
    return data as FriendStreak | null;
  };

  const getStreaks = async (): Promise<FriendStreak[]> => {
    const userId = await getUserId();
    assertUuid(userId, 'userId');
    const { data, error } = await supabase
      .from('friend_streaks')
      .select('*')
      .or(`user_id.eq.${userId},friend_id.eq.${userId}`);
    if (error) throw error;
    return (data ?? []) as FriendStreak[];
  };

  // =====================
  // フレンドのフレンド
  // =====================
  const getFriendsOfFriends = async (): Promise<FriendOfFriend[]> => {
    const userId = await getUserId();
    const { data, error } = await supabase.rpc('get_friends_of_friends', {
      current_user_id: userId,
    });
    if (error) throw error;

    // グループ化: user_id → mutual_friend_ids[]
    const map = new Map<string, string[]>();
    for (const row of (data ?? [])) {
      const existing = map.get(row.user_id) ?? [];
      existing.push(row.mutual_friend_id);
      map.set(row.user_id, existing);
    }

    return Array.from(map.entries()).map(([uid, mutuals]) => ({
      user_id: uid,
      mutual_friend_ids: [...new Set(mutuals)],
    }));
  };

  // =====================
  // 訪問セル（エリア塗りつぶし）
  // =====================
  const getMyVisitedCells = async (
    options?: { areaPrefix?: string; since?: Date }
  ): Promise<VisitedCell[]> => {
    const userId = await getUserId();
    let query = supabase
      .from('visited_cells')
      .select('*')
      .eq('user_id', userId);

    if (options?.areaPrefix) {
      query = query.like('geohash', `${sanitizeGeohashPrefix(options.areaPrefix)}%`);
    }
    if (options?.since) {
      query = query.gte('last_visited_at', options.since.toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as VisitedCell[];
  };

  const getFriendVisitedCells = async (
    friendId: string,
    options?: { areaPrefix?: string }
  ): Promise<VisitedCell[]> => {
    // Verify the caller is actually friends with the target user
    const userId = await getUserId();
    assertUuid(userId, 'userId');
    assertUuid(friendId, 'friendId');
    const { data: friendCheck } = await supabase
      .from('friend_requests')
      .select('id')
      .eq('status', 'accepted')
      .or(`and(from_user_id.eq.${userId},to_user_id.eq.${friendId}),and(from_user_id.eq.${friendId},to_user_id.eq.${userId})`)
      .limit(1);
    if (!friendCheck || friendCheck.length === 0) {
      throw new Error('Not friends with this user');
    }

    let query = supabase
      .from('visited_cells')
      .select('*')
      .eq('user_id', friendId);

    if (options?.areaPrefix) {
      query = query.like('geohash', `${sanitizeGeohashPrefix(options.areaPrefix)}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as VisitedCell[];
  };

  const getMyExplorationStats = async (): Promise<VisitedCellStats | null> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('visited_cell_stats')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw error;
    return data as VisitedCellStats | null;
  };

  const getAreaRanking = async (
    areaPrefix: string,
    limit: number = 20
  ): Promise<AreaRanking[]> => {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const { data, error } = await supabase.rpc('get_area_rankings', {
      area_prefix: sanitizeGeohashPrefix(areaPrefix),
      result_limit: safeLimit,
    });
    if (error) throw error;
    return (data ?? []) as AreaRanking[];
  };

  const getFriendRanking = async (
    options?: { areaPrefix?: string }
  ): Promise<AreaRanking[]> => {
    const userId = await getUserId();
    const friendIds = await getFriends();
    const allIds = [userId, ...friendIds];

    // Batch: fetch all counts in parallel instead of sequential N+1
    const countPromises = allIds.map(async (id) => {
      let query = supabase
        .from('visited_cells')
        .select('geohash', { count: 'exact', head: true })
        .eq('user_id', id);

      if (options?.areaPrefix) {
        query = query.like('geohash', `${sanitizeGeohashPrefix(options.areaPrefix)}%`);
      }

      const { count } = await query;
      return { user_id: id, cell_count: count ?? 0, rank: 0 } as AreaRanking;
    });

    const results = await Promise.all(countPromises);

    // ランキング計算
    results.sort((a, b) => b.cell_count - a.cell_count);
    results.forEach((r, i) => { r.rank = i + 1; });

    return results;
  };

  return {
    supabase,
    // 位置情報
    sendLocation,
    sendLocationWithTrail,
    getFriendsLocations,
    /** @deprecated Use getFriendsLocations instead */
    getVisibleFriends: getFriendsLocations,
    getLocationHistory,
    saveLocationHistory,
    getTrailFriendIds,
    // 共有ルール
    allow,
    revoke,
    // 共有ポリシー（SecureCheck）
    addSharingPolicy,
    getSharingPolicies,
    updateSharingPolicy,
    deleteSharingPolicy,
    getVisibleFriendsFiltered,
    // プロフィール
    getProfile,
    updateProfile,
    searchProfiles,
    // フレンド
    sendFriendRequest,
    getPendingRequests,
    getSentRequests,
    acceptFriendRequest,
    rejectFriendRequest,
    cancelFriendRequest,
    getFriends,
    removeFriend,
    // ユーザー設定
    getSettings,
    updateSettings,
    enableGhostMode,
    disableGhostMode,
    // グループ
    createGroup,
    getGroups,
    getGroupMembers,
    joinGroup,
    leaveGroup,
    deleteGroup,
    // Realtime
    subscribeLocations,
    subscribeFriendRequests,
    // チャット
    getOrCreateDirectChat,
    getOrCreateGroupChat,
    getChatRooms,
    getChatRoomMembers,
    sendMessage,
    getMessages,
    markAsRead,
    subscribeMessages,
    // リアクション
    sendReaction,
    getReceivedReactions,
    getSentReactions,
    subscribeReactions,
    // Bump
    findNearbyFriends,
    recordBump,
    getBumpHistory,
    // お気に入りの場所
    addFavoritePlace,
    getFavoritePlaces,
    updateFavoritePlace,
    deleteFavoritePlace,
    checkAtFavoritePlace,
    getVisibleFriendsWithPlaces,
    // アバター
    uploadAvatar,
    deleteAvatar,
    // ステータス絵文字
    setStatus,
    clearStatus,
    // ブロック
    blockUser,
    unblockUser,
    getBlockedUsers,
    isBlocked,
    // 共有期限
    setShareExpiry,
    // プッシュ通知
    registerPushSubscription,
    unregisterPushSubscription,
    getNotificationPreferences,
    updateNotificationPreferences,
    // ストリーク
    recordInteraction,
    getStreak,
    getStreaks,
    // フレンドのフレンド
    getFriendsOfFriends,
    // 訪問セル（エリア塗りつぶし）
    getMyVisitedCells,
    getFriendVisitedCells,
    getMyExplorationStats,
    getAreaRanking,
    getFriendRanking,
    encodeGeohash,
    decodeGeohash,
    // ユーティリティ
    calculateDistance,
    estimateMotionType,
  };
}
