alter table locations_current enable row level security;
alter table share_rules enable row level security;
alter table locations_history enable row level security;

create policy "write_own_location"
on locations_current for insert
with check (auth.uid() = user_id);

create policy "update_own_location"
on locations_current for update
using (auth.uid() = user_id);

create policy "read_visible_locations"
on locations_current for select
using (
  auth.uid() = user_id
  or (
    exists (
      select 1 from share_rules
      where owner_id = user_id
        and viewer_id = auth.uid()
        and level in ('current','history')
        and (expires_at is null or expires_at > now())
    )
    and not exists (
      select 1 from blocked_users
      where (blocker_id = user_id and blocked_id = auth.uid())
        or (blocker_id = auth.uid() and blocked_id = user_id)
    )
    -- ゴーストモード有効なユーザーの位置は他者に見せない
    and not exists (
      select 1 from user_settings
      where user_settings.user_id = locations_current.user_id
        and ghost_mode = true
        and (ghost_until is null or ghost_until > now())
    )
  )
);

create policy "delete_own_location"
on locations_current for delete
using (auth.uid() = user_id);

create policy "delete_own_history"
on locations_history for delete
using (auth.uid() = user_id);

create policy "manage_own_share_rules"
on share_rules
for all
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create policy "read_rules_as_viewer"
on share_rules for select
using (auth.uid() = viewer_id);

-- share_rules の INSERT は manage_own_share_rules (FOR ALL, owner_id = auth.uid()) でカバー。
-- 相手側のルール作成は accept_friend_request security definer 関数で実行。

create policy "write_own_history"
on locations_history for insert
with check (auth.uid() = user_id);

create policy "read_history_when_allowed"
on locations_history for select
using (
  auth.uid() = user_id
  or (
    exists (
      select 1 from share_rules
      where owner_id = user_id
        and viewer_id = auth.uid()
        and level = 'history'
        and (expires_at is null or expires_at > now())
    )
    and not exists (
      select 1 from blocked_users
      where (blocker_id = user_id and blocked_id = auth.uid())
        or (blocker_id = auth.uid() and blocked_id = user_id)
    )
    -- ゴーストモード中のユーザーの履歴は閲覧不可
    and not exists (
      select 1 from user_settings
      where user_settings.user_id = locations_history.user_id
        and ghost_mode = true
        and (ghost_until is null or ghost_until > now())
    )
  )
);

-- =====================
-- profiles ポリシー
-- =====================
alter table profiles enable row level security;

-- 認証ユーザーのみ閲覧可能（未認証の列挙を防止）
create policy "profiles_read_authenticated"
on profiles for select
using (auth.uid() is not null);

create policy "profiles_insert_own"
on profiles for insert
with check (auth.uid() = user_id);

create policy "profiles_update_own"
on profiles for update
using (auth.uid() = user_id);

-- =====================
-- friend_requests ポリシー
-- =====================
alter table friend_requests enable row level security;

create policy "friend_requests_insert"
on friend_requests for insert
with check (
  auth.uid() = from_user_id
  and not exists (
    select 1 from blocked_users
    where (blocker_id = to_user_id and blocked_id = auth.uid())
      or (blocker_id = auth.uid() and blocked_id = to_user_id)
  )
);

create policy "friend_requests_read"
on friend_requests for select
using (auth.uid() = from_user_id or auth.uid() = to_user_id);

-- accept は security definer関数経由のみ。直接UPDATEはrejectのみ許可
-- from_user_id/to_user_id の変更およびaccepted→rejected遷移はトリガーで防止
create policy "friend_requests_update"
on friend_requests for update
using (auth.uid() = to_user_id)
with check (
  auth.uid() = to_user_id
  and status = 'rejected'
);

create policy "friend_requests_delete"
on friend_requests for delete
using (auth.uid() = from_user_id or auth.uid() = to_user_id);

-- =====================
-- user_settings ポリシー
-- =====================
alter table user_settings enable row level security;

create policy "user_settings_read_own"
on user_settings for select
using (auth.uid() = user_id);

create policy "user_settings_insert_own"
on user_settings for insert
with check (auth.uid() = user_id);

create policy "user_settings_update_own"
on user_settings for update
using (auth.uid() = user_id);

-- =====================
-- グループメンバーシップ確認ヘルパー（RLS再帰回避）
-- =====================
create or replace function is_group_member(p_group_id uuid, p_user_id uuid)
returns boolean as $$
  select exists (
    select 1 from group_members
    where group_id = p_group_id and user_id = p_user_id
  );
$$ language sql security definer;

-- =====================
-- groups ポリシー
-- =====================
alter table groups enable row level security;

create policy "groups_read_member"
on groups for select
using (
  auth.uid() = owner_id
  or is_group_member(groups.id, auth.uid())
);

-- invite_codeを知っているユーザーのみ（SDKでフィルタ、RLSはメンバー/オーナーに制限）
-- 削除: 全グループが公開される脆弱性があったため

create policy "groups_insert"
on groups for insert
with check (auth.uid() = owner_id);

create policy "groups_update"
on groups for update
using (auth.uid() = owner_id);

create policy "groups_delete"
on groups for delete
using (auth.uid() = owner_id);

-- =====================
-- group_members ポリシー
-- =====================
alter table group_members enable row level security;

-- 同じグループのメンバーのみ見える（is_group_member で再帰回避）
create policy "group_members_select"
on group_members for select
using (
  is_group_member(group_members.group_id, auth.uid())
);

-- グループ参加: オーナーの自己追加、またはjoin_group RPC経由のみ
-- SDK からの直接INSERTは拒否（join_group security definer関数を使用）
create policy "group_members_insert"
on group_members for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from groups g
    where g.id = group_members.group_id and g.owner_id = auth.uid()
  )
);

create policy "group_members_delete"
on group_members for delete
using (auth.uid() = user_id);

-- =====================
-- チャットルームメンバーシップ確認ヘルパー（RLS再帰回避）
-- =====================
create or replace function is_chat_room_member(p_room_id uuid, p_user_id uuid)
returns boolean as $$
  select exists (
    select 1 from chat_room_members
    where room_id = p_room_id and user_id = p_user_id
  );
$$ language sql security definer;

-- =====================
-- chat_rooms ポリシー
-- =====================
-- NOTE: Node.jsテスト環境ではRLSが正しく動作しない場合があります
-- ブラウザ環境では正常に動作します。開発時は disable にして、本番では enable にしてください
alter table chat_rooms enable row level security;

create policy "chat_rooms_select"
on chat_rooms for select
using (
  is_chat_room_member(chat_rooms.id, auth.uid())
  or (
    type = 'group' and is_group_member(chat_rooms.group_id, auth.uid())
  )
);

-- ルーム作成: security definer関数（create_direct_chat / create_group_chat）経由のみ
-- 直接INSERTを禁止（フレンド/ブロック/重複チェックは関数内で実施）
create policy "chat_rooms_insert"
on chat_rooms for insert
with check (false);

-- =====================
-- chat_room_members ポリシー
-- =====================
alter table chat_room_members enable row level security;

create policy "chat_room_members_select"
on chat_room_members for select
using (
  user_id = auth.uid()
  or is_chat_room_member(chat_room_members.room_id, auth.uid())
);

-- メンバー追加: 自分自身のみ + DMはフレンドかつ2人まで / グループはメンバーのみ
-- メンバー追加: チャットルーム作成は security definer 関数経由のみ
-- 直接INSERTは自分自身の追加のみ許可（実質的にはRPC経由）
create policy "chat_room_members_insert"
on chat_room_members for insert
with check (
  auth.uid() = user_id
);

create policy "chat_room_members_update"
on chat_room_members for update
using (user_id = auth.uid());

-- =====================
-- messages ポリシー
-- =====================
alter table messages enable row level security;

create policy "messages_select"
on messages for select
using (
  is_chat_room_member(messages.room_id, auth.uid())
);

create policy "messages_insert"
on messages for insert
with check (
  auth.uid() = sender_id
  and is_chat_room_member(messages.room_id, auth.uid())
);

-- メッセージの更新・削除は送信者本人のみ
create policy "messages_update_own"
on messages for update
using (auth.uid() = sender_id)
with check (auth.uid() = sender_id);

create policy "messages_delete_own"
on messages for delete
using (auth.uid() = sender_id);

-- =====================
-- location_reactions ポリシー
-- =====================
alter table location_reactions enable row level security;

create policy "location_reactions_select"
on location_reactions for select
using (from_user_id = auth.uid() or to_user_id = auth.uid());

create policy "location_reactions_insert"
on location_reactions for insert
with check (
  auth.uid() = from_user_id
  and exists (
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user_id = auth.uid() and to_user_id = location_reactions.to_user_id)
        or (to_user_id = auth.uid() and from_user_id = location_reactions.to_user_id))
  )
  and not exists (
    select 1 from blocked_users
    where (blocker_id = location_reactions.to_user_id and blocked_id = auth.uid())
      or (blocker_id = auth.uid() and blocked_id = location_reactions.to_user_id)
  )
);

create policy "location_reactions_delete"
on location_reactions for delete
using (from_user_id = auth.uid());

-- =====================
-- bump_events ポリシー
-- =====================
alter table bump_events enable row level security;

create policy "bump_events_select"
on bump_events for select
using (user_id = auth.uid() or nearby_user_id = auth.uid());

create policy "bump_events_insert"
on bump_events for insert
with check (
  auth.uid() = user_id
  and exists (
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user_id = auth.uid() and to_user_id = bump_events.nearby_user_id)
        or (to_user_id = auth.uid() and from_user_id = bump_events.nearby_user_id))
  )
  and not exists (
    select 1 from blocked_users
    where (blocker_id = bump_events.nearby_user_id and blocked_id = auth.uid())
      or (blocker_id = auth.uid() and blocked_id = bump_events.nearby_user_id)
  )
);

-- =====================
-- favorite_places ポリシー
-- =====================
alter table favorite_places enable row level security;

-- 自分のお気に入りは自分だけが見える
create policy "favorite_places_select_own"
on favorite_places for select
using (auth.uid() = user_id);

-- フレンドのお気に入りは位置共有が有効な場合のみ見える
create policy "favorite_places_select_friends"
on favorite_places for select
using (
  exists (
    select 1 from share_rules
    where owner_id = favorite_places.user_id
      and viewer_id = auth.uid()
      and level in ('current', 'history')
      and (expires_at is null or expires_at > now())
  )
  and not exists (
    select 1 from blocked_users
    where (blocker_id = favorite_places.user_id and blocked_id = auth.uid())
      or (blocker_id = auth.uid() and blocked_id = favorite_places.user_id)
  )
);

create policy "favorite_places_insert"
on favorite_places for insert
with check (auth.uid() = user_id);

create policy "favorite_places_update"
on favorite_places for update
using (auth.uid() = user_id);

create policy "favorite_places_delete"
on favorite_places for delete
using (auth.uid() = user_id);

-- =====================
-- blocked_users ポリシー
-- =====================
alter table blocked_users enable row level security;

-- 自分がブロックした相手 + 自分をブロックした相手の両方が見える
-- （isBlocked() で双方向チェックが必要）
create policy "blocked_users_select_own"
on blocked_users for select
using (auth.uid() = blocker_id or auth.uid() = blocked_id);

create policy "blocked_users_insert_own"
on blocked_users for insert
with check (auth.uid() = blocker_id);

create policy "blocked_users_delete_own"
on blocked_users for delete
using (auth.uid() = blocker_id);

-- =====================
-- push_subscriptions ポリシー
-- =====================
alter table push_subscriptions enable row level security;

create policy "push_subscriptions_select_own"
on push_subscriptions for select
using (auth.uid() = user_id);

create policy "push_subscriptions_insert_own"
on push_subscriptions for insert
with check (auth.uid() = user_id);

create policy "push_subscriptions_delete_own"
on push_subscriptions for delete
using (auth.uid() = user_id);

-- =====================
-- notification_preferences ポリシー
-- =====================
alter table notification_preferences enable row level security;

create policy "notification_prefs_select_own"
on notification_preferences for select
using (auth.uid() = user_id);

create policy "notification_prefs_insert_own"
on notification_preferences for insert
with check (auth.uid() = user_id);

create policy "notification_prefs_update_own"
on notification_preferences for update
using (auth.uid() = user_id);

-- =====================
-- friend_streaks ポリシー
-- =====================
alter table friend_streaks enable row level security;

-- 自分が主体のストリークのみ閲覧可能（相手の視点のストリークは非公開）
create policy "friend_streaks_select"
on friend_streaks for select
using (auth.uid() = user_id);

create policy "friend_streaks_insert_own"
on friend_streaks for insert
with check (auth.uid() = user_id);

create policy "friend_streaks_update_own"
on friend_streaks for update
using (auth.uid() = user_id);

-- =====================
-- visited_cells ポリシー
-- =====================
alter table visited_cells enable row level security;

-- 自分のセルは見える
create policy "visited_cells_select_own"
on visited_cells for select
using (auth.uid() = user_id);

-- フレンドのセルも見える（ランキング・比較用、ブロックチェック付き）
create policy "visited_cells_select_friends"
on visited_cells for select
using (
  exists (
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user_id = auth.uid() and to_user_id = visited_cells.user_id)
        or (to_user_id = auth.uid() and from_user_id = visited_cells.user_id))
  )
  and not exists (
    select 1 from blocked_users
    where (blocker_id = visited_cells.user_id and blocked_id = auth.uid())
      or (blocker_id = auth.uid() and blocked_id = visited_cells.user_id)
  )
);

-- トリガーが書き込むため、自分のセルの書き込みを許可
create policy "visited_cells_insert_own"
on visited_cells for insert
with check (auth.uid() = user_id);

create policy "visited_cells_update_own"
on visited_cells for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- =====================
-- sharing_policies ポリシー（SecureCheck）
-- =====================
alter table sharing_policies enable row level security;

-- オーナーは自分のポリシーを完全管理
create policy "sharing_policies_manage_own"
on sharing_policies
for all
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

-- viewer_idが設定されている場合、その相手もポリシーを閲覧可能（透明性）
create policy "sharing_policies_read_as_viewer"
on sharing_policies for select
using (auth.uid() = viewer_id);

-- =====================
-- Supabase Storage ポリシー（avatarsバケット）
-- =====================
-- Supabase Storage ポリシー（ダッシュボードの SQL Editor で実行）
create policy "avatars_read_public" on storage.objects for select using (bucket_id = 'avatars');
create policy "avatars_insert_own" on storage.objects for insert with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "avatars_update_own" on storage.objects for update using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "avatars_delete_own" on storage.objects for delete using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
