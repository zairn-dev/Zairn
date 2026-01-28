import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

// =====================
// 型定義
// =====================
export type ShareLevel = 'none' | 'current' | 'history';
export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected';

export interface LocationCoreOptions {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface LocationCurrentRow {
  user_id: string;
  lat: number;
  lon: number;
  accuracy: number | null;
  updated_at: string;
}

export interface LocationHistoryRow {
  id: number;
  user_id: string;
  lat: number;
  lon: number;
  accuracy: number | null;
  recorded_at: string;
}

export interface Profile {
  user_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface FriendRequest {
  id: number;
  from_user_id: string;
  to_user_id: string;
  status: FriendRequestStatus;
  created_at: string;
  updated_at: string;
}

export interface UserSettings {
  user_id: string;
  ghost_mode: boolean;
  ghost_until: string | null;
  location_update_interval: number;
  updated_at: string;
}

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

// チャット関連
export type ChatRoomType = 'direct' | 'group';
export type MessageType = 'text' | 'image' | 'location' | 'reaction';

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

// リアクション関連
export interface LocationReaction {
  id: number;
  from_user_id: string;
  to_user_id: string;
  emoji: string;
  message: string | null;
  created_at: string;
}

// Bump関連
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
// メインファクトリ関数
// =====================
export function createLocationCore(opts: LocationCoreOptions) {
  const supabase: SupabaseClient = createClient(opts.supabaseUrl, opts.supabaseAnonKey);

  const getUserId = async (): Promise<string> => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new Error('Not authenticated');
    return data.user.id;
  };

  // =====================
  // 位置情報
  // =====================
  const sendLocation = async (
    lat: number,
    lon: number,
    accuracy?: number | null
  ): Promise<void> => {
    const userId = await getUserId();

    // ゴーストモードチェック
    const settings = await getSettings();
    if (settings?.ghost_mode) {
      if (!settings.ghost_until || new Date(settings.ghost_until) > new Date()) {
        return; // ゴーストモード中は位置を送信しない
      }
    }

    const { error } = await supabase
      .from('locations_current')
      .upsert({
        user_id: userId,
        lat,
        lon,
        accuracy: accuracy ?? null,
        updated_at: new Date().toISOString(),
      });
    if (error) throw error;
  };

  const getVisibleFriends = async (): Promise<LocationCurrentRow[]> => {
    const { data, error } = await supabase.from('locations_current').select('*');
    if (error) throw error;
    return (data ?? []) as LocationCurrentRow[];
  };

  const getLocationHistory = async (
    userId: string,
    options?: { limit?: number; since?: Date }
  ): Promise<LocationHistoryRow[]> => {
    let query = supabase
      .from('locations_history')
      .select('*')
      .eq('user_id', userId)
      .order('recorded_at', { ascending: false });

    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.since) {
      query = query.gte('recorded_at', options.since.toISOString());
    }

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
      .insert({
        user_id: userId,
        lat,
        lon,
        accuracy: accuracy ?? null,
      });
    if (error) throw error;
  };

  // =====================
  // 共有ルール（レガシー互換）
  // =====================
  const allow = async (viewerId: string, level: ShareLevel = 'current'): Promise<void> => {
    const ownerId = await getUserId();
    const { error } = await supabase
      .from('share_rules')
      .upsert({ owner_id: ownerId, viewer_id: viewerId, level });
    if (error) throw error;
  };

  const revoke = async (viewerId: string): Promise<void> => {
    const ownerId = await getUserId();
    const { error } = await supabase
      .from('share_rules')
      .delete()
      .eq('owner_id', ownerId)
      .eq('viewer_id', viewerId);
    if (error) throw error;
  };

  // =====================
  // プロフィール
  // =====================
  const getProfile = async (userId?: string): Promise<Profile | null> => {
    const targetId = userId ?? await getUserId();
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', targetId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data as Profile | null;
  };

  const updateProfile = async (profile: Partial<Omit<Profile, 'user_id' | 'created_at' | 'updated_at'>>): Promise<Profile> => {
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
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
      .limit(20);
    if (error) throw error;
    return (data ?? []) as Profile[];
  };

  // =====================
  // フレンドリクエスト
  // =====================
  const sendFriendRequest = async (toUserId: string): Promise<FriendRequest> => {
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
    const userId = await getUserId();

    // リクエストを承認
    const { data: request, error: updateError } = await supabase
      .from('friend_requests')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('to_user_id', userId)
      .select()
      .single();
    if (updateError) throw updateError;

    const req = request as FriendRequest;

    // 双方向で共有ルールを作成
    const { error: shareError } = await supabase
      .from('share_rules')
      .upsert([
        { owner_id: req.from_user_id, viewer_id: req.to_user_id, level: 'current' },
        { owner_id: req.to_user_id, viewer_id: req.from_user_id, level: 'current' },
      ]);
    if (shareError) throw shareError;
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
    const userId = await getUserId();

    // フレンドリクエストを削除
    await supabase
      .from('friend_requests')
      .delete()
      .eq('status', 'accepted')
      .or(`and(from_user_id.eq.${userId},to_user_id.eq.${friendId}),and(from_user_id.eq.${friendId},to_user_id.eq.${userId})`);

    // 双方向の共有ルールを削除
    await supabase
      .from('share_rules')
      .delete()
      .or(`and(owner_id.eq.${userId},viewer_id.eq.${friendId}),and(owner_id.eq.${friendId},viewer_id.eq.${userId})`);
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
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data as UserSettings | null;
  };

  const updateSettings = async (settings: Partial<Omit<UserSettings, 'user_id' | 'updated_at'>>): Promise<UserSettings> => {
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
    const userId = await getUserId();
    const inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();

    const { data: group, error: groupError } = await supabase
      .from('groups')
      .insert({
        name,
        description: description ?? null,
        owner_id: userId,
        invite_code: inviteCode,
      })
      .select()
      .single();
    if (groupError) throw groupError;

    // オーナーをメンバーとして追加
    const { error: memberError } = await supabase
      .from('group_members')
      .insert({
        group_id: (group as Group).id,
        user_id: userId,
        role: 'owner',
      });
    if (memberError) throw memberError;

    return group as Group;
  };

  const getGroups = async (): Promise<Group[]> => {
    const userId = await getUserId();
    const { data, error } = await supabase
      .from('group_members')
      .select('group_id, groups(*)')
      .eq('user_id', userId);
    if (error) throw error;
    return (data ?? []).map(d => d.groups) as Group[];
  };

  const getGroupMembers = async (groupId: string): Promise<GroupMember[]> => {
    const { data, error } = await supabase
      .from('group_members')
      .select('*')
      .eq('group_id', groupId);
    if (error) throw error;
    return (data ?? []) as GroupMember[];
  };

  const joinGroup = async (inviteCode: string): Promise<Group> => {
    const userId = await getUserId();

    const { data: group, error: groupError } = await supabase
      .from('groups')
      .select('*')
      .eq('invite_code', inviteCode.toUpperCase())
      .single();
    if (groupError) throw new Error('Invalid invite code');

    const { error: memberError } = await supabase
      .from('group_members')
      .insert({
        group_id: (group as Group).id,
        user_id: userId,
        role: 'member',
      });
    if (memberError) throw memberError;

    return group as Group;
  };

  const leaveGroup = async (groupId: string): Promise<void> => {
    const userId = await getUserId();
    const { error } = await supabase
      .from('group_members')
      .delete()
      .eq('group_id', groupId)
      .eq('user_id', userId);
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
  const subscribeLocations = (onUpdate: (row: LocationCurrentRow) => void): RealtimeChannel => {
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
      .subscribe();
  };

  const subscribeFriendRequests = (onUpdate: (request: FriendRequest) => void): RealtimeChannel => {
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
      .subscribe();
  };

  // =====================
  // チャット機能
  // =====================
  const getOrCreateDirectChat = async (otherUserId: string): Promise<ChatRoom> => {
    const userId = await getUserId();

    // 既存のダイレクトチャットを探す
    const { data: existingRooms } = await supabase
      .from('chat_room_members')
      .select('room_id')
      .eq('user_id', userId);

    if (existingRooms && existingRooms.length > 0) {
      const roomIds = existingRooms.map(r => r.room_id);
      const { data: otherMember } = await supabase
        .from('chat_room_members')
        .select('room_id, chat_rooms!inner(id, type)')
        .eq('user_id', otherUserId)
        .in('room_id', roomIds);

      const directRoom = otherMember?.find((m: any) => m.chat_rooms?.type === 'direct');
      if (directRoom) {
        const { data: room } = await supabase
          .from('chat_rooms')
          .select('*')
          .eq('id', directRoom.room_id)
          .single();
        if (room) return room as ChatRoom;
      }
    }

    // 新しいチャットルームを作成
    const { data: newRoom, error: roomError } = await supabase
      .from('chat_rooms')
      .insert({ type: 'direct' })
      .select()
      .single();
    if (roomError) throw roomError;

    // メンバーを追加
    const { error: memberError } = await supabase
      .from('chat_room_members')
      .insert([
        { room_id: (newRoom as ChatRoom).id, user_id: userId },
        { room_id: (newRoom as ChatRoom).id, user_id: otherUserId },
      ]);
    if (memberError) throw memberError;

    return newRoom as ChatRoom;
  };

  const getOrCreateGroupChat = async (groupId: string): Promise<ChatRoom> => {
    // 既存のグループチャットを探す
    const { data: existingRoom } = await supabase
      .from('chat_rooms')
      .select('*')
      .eq('group_id', groupId)
      .eq('type', 'group')
      .single();

    if (existingRoom) return existingRoom as ChatRoom;

    // 新しいグループチャットを作成
    const { data: newRoom, error } = await supabase
      .from('chat_rooms')
      .insert({ type: 'group', group_id: groupId })
      .select()
      .single();
    if (error) throw error;

    return newRoom as ChatRoom;
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

  const sendMessage = async (
    roomId: string,
    content: string,
    messageType: MessageType = 'text',
    metadata?: Record<string, unknown>
  ): Promise<Message> => {
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
    return data as Message;
  };

  const getMessages = async (
    roomId: string,
    options?: { limit?: number; before?: number }
  ): Promise<Message[]> => {
    let query = supabase
      .from('messages')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: false });

    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.before) {
      query = query.lt('id', options.before);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as Message[];
  };

  const markAsRead = async (roomId: string): Promise<void> => {
    const userId = await getUserId();
    const { error } = await supabase
      .from('chat_room_members')
      .update({ last_read_at: new Date().toISOString() })
      .eq('room_id', roomId)
      .eq('user_id', userId);
    if (error) throw error;
  };

  const subscribeMessages = (roomId: string, onMessage: (message: Message) => void): RealtimeChannel => {
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
      .subscribe();
  };

  // =====================
  // リアクション機能（絵文字ポーク）
  // =====================
  const sendReaction = async (toUserId: string, emoji: string, message?: string): Promise<LocationReaction> => {
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
    return data as LocationReaction;
  };

  const getReceivedReactions = async (options?: { limit?: number; since?: Date }): Promise<LocationReaction[]> => {
    const userId = await getUserId();
    let query = supabase
      .from('location_reactions')
      .select('*')
      .eq('to_user_id', userId)
      .order('created_at', { ascending: false });

    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.since) {
      query = query.gte('created_at', options.since.toISOString());
    }

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
      .order('created_at', { ascending: false });

    if (options?.limit) {
      query = query.limit(options.limit);
    }

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
  // Bump機能（近くの人検出）
  // =====================
  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371000; // 地球の半径（メートル）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const findNearbyFriends = async (
    myLat: number,
    myLon: number,
    radiusMeters: number = 500
  ): Promise<NearbyUser[]> => {
    const friends = await getVisibleFriends();
    const userId = await getUserId();

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
    return data as BumpEvent;
  };

  const getBumpHistory = async (options?: { limit?: number; since?: Date }): Promise<BumpEvent[]> => {
    const userId = await getUserId();
    let query = supabase
      .from('bump_events')
      .select('*')
      .or(`user_id.eq.${userId},nearby_user_id.eq.${userId}`)
      .order('created_at', { ascending: false });

    if (options?.limit) {
      query = query.limit(options.limit);
    }
    if (options?.since) {
      query = query.gte('created_at', options.since.toISOString());
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as BumpEvent[];
  };

  return {
    supabase,
    // 位置情報
    sendLocation,
    getVisibleFriends,
    getLocationHistory,
    saveLocationHistory,
    // 共有ルール（レガシー）
    allow,
    revoke,
    // プロフィール
    getProfile,
    updateProfile,
    searchProfiles,
    // フレンドリクエスト
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
  };
}
