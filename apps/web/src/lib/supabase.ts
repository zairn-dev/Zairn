import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// 型定義はSDKから再エクスポート
export type {
  ShareLevel,
  FriendRequestStatus,
  MotionType,
  PlaceType,
  ChatRoomType,
  MessageType,
  LocationCurrentRow,
  LocationUpdate,
  LocationHistoryRow,
  ShareRule,
  Profile,
  FriendRequest,
  UserSettings,
  Group,
  GroupMember,
  ChatRoom,
  ChatRoomMember,
  Message,
  LocationReaction,
  BumpEvent,
  NearbyUser,
  FavoritePlace,
  LocationCore,
} from '@zen-map/sdk';
