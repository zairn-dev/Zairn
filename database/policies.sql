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
  or exists (
    select 1 from share_rules
    where owner_id = user_id
      and viewer_id = auth.uid()
      and level in ('current','history')
      and (expires_at is null or expires_at > now())
  )
);

create policy "manage_own_share_rules"
on share_rules
for all
using (auth.uid() = owner_id)
with check (auth.uid() = owner_id);

create policy "read_rules_as_viewer"
on share_rules for select
using (auth.uid() = viewer_id);

-- フレンドリクエスト承認時の双方向共有ルール作成を許可
create policy "share_rules_insert_mutual"
on share_rules for insert
with check (
  auth.uid() = owner_id
  or exists (
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user_id = auth.uid() and to_user_id = owner_id)
        or (to_user_id = auth.uid() and from_user_id = owner_id))
  )
);

create policy "write_own_history"
on locations_history for insert
with check (auth.uid() = user_id);

create policy "read_history_when_allowed"
on locations_history for select
using (
  auth.uid() = user_id
  or exists (
    select 1 from share_rules
    where owner_id = user_id
      and viewer_id = auth.uid()
      and level = 'history'
      and (expires_at is null or expires_at > now())
  )
);

-- =====================
-- profiles ポリシー
-- =====================
alter table profiles enable row level security;

create policy "profiles_read_public"
on profiles for select
using (true);

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
with check (auth.uid() = from_user_id);

create policy "friend_requests_read"
on friend_requests for select
using (auth.uid() = from_user_id or auth.uid() = to_user_id);

create policy "friend_requests_update"
on friend_requests for update
using (auth.uid() = to_user_id);

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
-- groups ポリシー
-- =====================
alter table groups enable row level security;

create policy "groups_read_member"
on groups for select
using (
  auth.uid() = owner_id
  or exists (
    select 1 from group_members
    where group_id = groups.id and user_id = auth.uid()
  )
);

create policy "groups_read_by_invite"
on groups for select
using (invite_code is not null);

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

create policy "group_members_select"
on group_members for select
using (true);

create policy "group_members_insert"
on group_members for insert
with check (auth.uid() = user_id);

create policy "group_members_delete"
on group_members for delete
using (auth.uid() = user_id);

-- =====================
-- chat_rooms ポリシー
-- =====================
-- NOTE: Node.jsテスト環境ではRLSが正しく動作しない場合があります
-- ブラウザ環境では正常に動作します。開発時は disable にして、本番では enable にしてください
alter table chat_rooms enable row level security;

create policy "chat_rooms_select"
on chat_rooms for select
using (
  exists (
    select 1 from chat_room_members
    where room_id = chat_rooms.id and user_id = auth.uid()
  )
  or (
    type = 'group' and exists (
      select 1 from group_members
      where group_id = chat_rooms.group_id and user_id = auth.uid()
    )
  )
);

create policy "chat_rooms_insert"
on chat_rooms for insert
with check (true);

-- =====================
-- chat_room_members ポリシー
-- =====================
alter table chat_room_members enable row level security;

create policy "chat_room_members_select"
on chat_room_members for select
using (
  user_id = auth.uid()
  or room_id in (
    select room_id from chat_room_members where user_id = auth.uid()
  )
);

create policy "chat_room_members_insert"
on chat_room_members for insert
with check (true);

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
  exists (
    select 1 from chat_room_members
    where room_id = messages.room_id and user_id = auth.uid()
  )
  or exists (
    select 1 from chat_rooms cr
    join group_members gm on gm.group_id = cr.group_id
    where cr.id = messages.room_id and gm.user_id = auth.uid()
  )
);

create policy "messages_insert"
on messages for insert
with check (
  auth.uid() = sender_id
  and (
    exists (
      select 1 from chat_room_members
      where room_id = messages.room_id and user_id = auth.uid()
    )
    or exists (
      select 1 from chat_rooms cr
      join group_members gm on gm.group_id = cr.group_id
      where cr.id = messages.room_id and gm.user_id = auth.uid()
    )
  )
);

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
with check (auth.uid() = user_id);
