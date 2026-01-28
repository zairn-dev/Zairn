import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// 型定義
export type ShareLevel = 'none' | 'current' | 'history';
export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected';
export type ChatRoomType = 'direct' | 'group';
export type MessageType = 'text' | 'image' | 'location' | 'reaction';

export interface LocationCurrentRow {
  user_id: string;
  lat: number;
  lon: number;
  accuracy: number | null;
  updated_at: string;
}

export interface ShareRule {
  owner_id: string;
  viewer_id: string;
  level: ShareLevel;
  expires_at: string | null;
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

export interface LocationReaction {
  id: number;
  from_user_id: string;
  to_user_id: string;
  emoji: string;
  message: string | null;
  created_at: string;
}

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
