-- =====================================================================
-- GENERATED FILE — do not edit by hand.
-- Source of truth: supabase/migrations/ (applied in filename order).
-- Regenerate with: pnpm db:snapshot
--
-- Apply to a fresh Supabase project in the SQL editor, or prefer the CLI:
--   supabase db push
-- =====================================================================

-- ---------------------------------------------------------------------
-- migration: 20240101000001_core_schema.sql
-- ---------------------------------------------------------------------
create type share_level as enum ('none','current','history');

-- 移動ステータスの種類
create type motion_type as enum ('stationary', 'walking', 'running', 'cycling', 'driving', 'transit', 'unknown');

create table if not exists locations_current (
  user_id uuid primary key references auth.users(id) on delete cascade,
  lat double precision not null,
  lon double precision not null,
  accuracy real,
  updated_at timestamptz not null default now(),
  -- バッテリー情報
  battery_level smallint check (battery_level >= 0 and battery_level <= 100),
  is_charging boolean default false,
  -- 滞在時間（この場所にいつからいるか）
  location_since timestamptz default now(),
  -- 移動ステータス
  speed real,  -- m/s
  heading real,
  altitude real,
  motion motion_type default 'unknown'
);

create table if not exists share_rules (
  owner_id uuid not null references auth.users(id) on delete cascade,
  viewer_id uuid not null references auth.users(id) on delete cascade,
  level share_level not null default 'current',
  expires_at timestamptz,
  primary key (owner_id, viewer_id)
);

create table if not exists locations_history (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  lat double precision not null,
  lon double precision not null,
  accuracy real,
  recorded_at timestamptz not null default now()
);

create index if not exists idx_share_rules_owner on share_rules (owner_id);
create index if not exists idx_share_rules_viewer on share_rules (viewer_id);
create index if not exists idx_share_rules_owner_expiry on share_rules (owner_id, expires_at);
create index if not exists idx_history_user_time on locations_history (user_id, recorded_at desc);

-- プロフィール
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text,
  avatar_url text,
  status_emoji text,
  status_text text,
  status_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_profiles_username on profiles (username);

-- フレンドリクエスト
create type friend_request_status as enum ('pending', 'accepted', 'rejected');

create table if not exists friend_requests (
  id bigserial primary key,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  to_user_id uuid not null references auth.users(id) on delete cascade,
  status friend_request_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (from_user_id, to_user_id),
  check (from_user_id != to_user_id)
);

create index if not exists idx_friend_requests_to_user on friend_requests (to_user_id, status);
create index if not exists idx_friend_requests_from_user on friend_requests (from_user_id, status);

-- friend_requests の保護トリガー
-- 1. from_user_id / to_user_id 変更禁止
-- 2. accepted → rejected への直接遷移禁止（share_rules 孤立防止）
create or replace function protect_friend_request_ids()
returns trigger as $$
begin
  if NEW.from_user_id != OLD.from_user_id then
    raise exception 'Cannot change from_user_id';
  end if;
  if NEW.to_user_id != OLD.to_user_id then
    raise exception 'Cannot change to_user_id';
  end if;
  -- accepted状態からのステータス変更は security definer (remove_friend) 経由のみ
  if OLD.status = 'accepted' and NEW.status != 'accepted' then
    raise exception 'Cannot change status of accepted friend request directly';
  end if;
  -- rejected状態からpendingへの巻き戻しを防止
  if OLD.status = 'rejected' and NEW.status = 'pending' then
    raise exception 'Cannot reactivate a rejected friend request';
  end if;
  return NEW;
end;
$$ language plpgsql;

create or replace trigger trg_protect_friend_request_ids
before update on friend_requests
for each row execute function protect_friend_request_ids();

-- ユーザー設定（ゴーストモード等）
create table if not exists user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ghost_mode boolean not null default false,
  ghost_until timestamptz,
  location_update_interval integer not null default 30,
  updated_at timestamptz not null default now()
);

-- グループ
create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  owner_id uuid not null references auth.users(id) on delete cascade,
  invite_code text unique,
  created_at timestamptz not null default now()
);

create table if not exists group_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member', 'admin')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create index if not exists idx_group_members_user on group_members (user_id);
create index if not exists idx_groups_invite_code on groups (invite_code);

-- =====================
-- チャット機能
-- =====================

-- チャットルーム（1対1はuser_id pair、グループはgroup_idで管理）
create table if not exists chat_rooms (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('direct', 'group')),
  group_id uuid references groups(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- 1対1チャットの参加者（directタイプ用）
create table if not exists chat_room_members (
  room_id uuid not null references chat_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz,
  primary key (room_id, user_id)
);

-- メッセージ
create table if not exists messages (
  id bigserial primary key,
  room_id uuid not null references chat_rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text,
  message_type text not null default 'text' check (message_type in ('text', 'image', 'location', 'reaction')),
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_messages_room_time on messages (room_id, created_at desc);
create index if not exists idx_chat_room_members_user on chat_room_members (user_id);
create index if not exists idx_chat_rooms_group on chat_rooms (group_id);

-- =====================
-- リアクション機能（位置への絵文字ポーク）
-- =====================
create table if not exists location_reactions (
  id bigserial primary key,
  from_user_id uuid not null references auth.users(id) on delete cascade,
  to_user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null,
  message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_location_reactions_to_user on location_reactions (to_user_id, created_at desc);
create index if not exists idx_location_reactions_from_user on location_reactions (from_user_id, created_at desc);

-- =====================
-- Bump機能（近くの人検出ログ）
-- =====================
create table if not exists bump_events (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  nearby_user_id uuid not null references auth.users(id) on delete cascade,
  distance_meters real not null,
  lat double precision not null,
  lon double precision not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_bump_events_user on bump_events (user_id, created_at desc);

-- =====================
-- お気に入りの場所（家、学校、職場など）
-- =====================
create type place_type as enum ('home', 'work', 'school', 'gym', 'custom');

create table if not exists favorite_places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  place_type place_type not null default 'custom',
  lat double precision not null,
  lon double precision not null,
  radius_meters real not null default 100,
  icon text,  -- カスタムアイコン（絵文字など）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_favorite_places_user on favorite_places (user_id);

-- =====================
-- ブロック機能
-- =====================
create table if not exists blocked_users (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id != blocked_id)
);

create index if not exists idx_blocked_users_blocker on blocked_users (blocker_id);
create index if not exists idx_blocked_users_blocked on blocked_users (blocked_id);

-- =====================
-- プッシュ通知
-- =====================
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, endpoint)
);

create index if not exists idx_push_subscriptions_user on push_subscriptions (user_id);

create table if not exists notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  friend_requests boolean not null default true,
  reactions boolean not null default true,
  chat_messages boolean not null default true,
  bumps boolean not null default true,
  updated_at timestamptz not null default now()
);

-- =====================
-- ストリーク（連続交流日数）
-- =====================
create table if not exists friend_streaks (
  user_id uuid not null references auth.users(id) on delete cascade,
  friend_id uuid not null references auth.users(id) on delete cascade,
  current_streak integer not null default 0,
  longest_streak integer not null default 0,
  last_interaction_date date not null default current_date,
  updated_at timestamptz not null default now(),
  primary key (user_id, friend_id)
);

create index if not exists idx_friend_streaks_user on friend_streaks (user_id);

-- ---------------------------------------------------------------------
-- migration: 20240101000002_core_functions.sql
-- ---------------------------------------------------------------------

-- =====================
-- 共有期限の自動クリーンアップ
-- =====================
create or replace function cleanup_expired_share_rules()
returns void as $$
begin
  delete from share_rules
  where expires_at is not null and expires_at <= now();
end;
$$ language plpgsql security definer;

-- pg_cronが有効な環境で実行:
-- select cron.schedule('cleanup-expired-share-rules', '*/15 * * * *', 'select cleanup_expired_share_rules()');

-- =====================
-- ストリーク記録関数
-- =====================
create or replace function record_interaction(p_user_id uuid, p_friend_id uuid)
returns void as $$
declare
  v_last_date date;
  v_streak integer;
  v_longest integer;
begin
  -- Only allow recording interactions for the authenticated user
  if auth.uid() is null or auth.uid() != p_user_id then
    raise exception 'Can only record interactions for yourself';
  end if;

  -- Verify users are friends
  if not exists (
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user_id = p_user_id and to_user_id = p_friend_id)
        or (to_user_id = p_user_id and from_user_id = p_friend_id))
  ) then
    raise exception 'Users are not friends';
  end if;

  select last_interaction_date, current_streak, longest_streak
  into v_last_date, v_streak, v_longest
  from friend_streaks
  where user_id = p_user_id and friend_id = p_friend_id
  for update;

  if not found then
    insert into friend_streaks (user_id, friend_id, current_streak, longest_streak, last_interaction_date)
    values (p_user_id, p_friend_id, 1, 1, current_date);
    return;
  end if;

  if v_last_date = current_date then return; end if;

  if v_last_date = current_date - 1 then
    v_streak := v_streak + 1;
  else
    v_streak := 1;
  end if;

  v_longest := greatest(v_longest, v_streak);

  update friend_streaks
  set current_streak = v_streak, longest_streak = v_longest,
      last_interaction_date = current_date, updated_at = now()
  where user_id = p_user_id and friend_id = p_friend_id;
end;
$$ language plpgsql security definer;

-- =====================
-- フレンドのフレンド取得関数
-- =====================
create or replace function get_friends_of_friends(current_user_id uuid)
returns table(user_id uuid, mutual_friend_id uuid) as $$
begin
  if auth.uid() is null or auth.uid() != current_user_id then
    raise exception 'Can only query own friends-of-friends';
  end if;

  return query
  with my_friends as (
    select case when fr.from_user_id = current_user_id then fr.to_user_id else fr.from_user_id end as friend_id
    from friend_requests fr
    where fr.status = 'accepted'
      and (fr.from_user_id = current_user_id or fr.to_user_id = current_user_id)
  ),
  fof as (
    select case when fr2.from_user_id = mf.friend_id then fr2.to_user_id else fr2.from_user_id end as fof_id,
           mf.friend_id as via_friend_id
    from friend_requests fr2
    join my_friends mf on (fr2.from_user_id = mf.friend_id or fr2.to_user_id = mf.friend_id)
    where fr2.status = 'accepted'
  )
  select fof.fof_id as user_id, fof.via_friend_id as mutual_friend_id
  from fof
  where fof.fof_id != current_user_id
    and fof.fof_id not in (select mf2.friend_id from my_friends mf2);
end;
$$ language plpgsql security definer;

-- =====================
-- 訪問セル（エリア塗りつぶし）
-- =====================
-- Geohash precision 7 ≒ 約150m×150mセル
create table if not exists visited_cells (
  user_id uuid not null references auth.users(id) on delete cascade,
  geohash text not null,
  first_visited_at timestamptz not null default now(),
  last_visited_at timestamptz not null default now(),
  visit_count integer not null default 1,
  primary key (user_id, geohash)
);

create index if not exists idx_visited_cells_user on visited_cells (user_id);
create index if not exists idx_visited_cells_geohash on visited_cells (geohash);

-- 訪問セル集計ビュー（ランキング用）
-- security_barrier prevents leaking data through predicate pushdown
create or replace view visited_cell_stats with (security_barrier = true) as
select
  user_id,
  count(*) as total_cells,
  min(first_visited_at) as exploring_since,
  max(last_visited_at) as last_explored_at
from visited_cells
group by user_id;

-- エリア別（geohash prefix）集計関数
-- prefix_len: 4=約40km, 5=約5km, 6=約1.2km
-- Only returns rankings for the caller and their friends
create or replace function get_area_rankings(
  area_prefix text,
  result_limit integer default 20
)
returns table(user_id uuid, cell_count bigint, rank bigint) as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Validate geohash prefix (only base32 chars, prevent LIKE injection)
  if area_prefix !~ '^[0-9bcdefghjkmnpqrstuvwxyz]+$' then
    raise exception 'Invalid geohash prefix';
  end if;

  -- 短すぎるprefixは大量行スキャンを引き起こすため拒否
  if length(area_prefix) < 2 then
    raise exception 'Geohash prefix too short (min 2 characters)';
  end if;

  return query
  select
    v.user_id,
    count(*) as cell_count,
    rank() over (order by count(*) desc) as rank
  from visited_cells v
  where v.geohash like area_prefix || '%'
    and (
      v.user_id = auth.uid()
      or exists (
        select 1 from friend_requests fr
        where fr.status = 'accepted'
          and ((fr.from_user_id = auth.uid() and fr.to_user_id = v.user_id)
            or (fr.to_user_id = auth.uid() and fr.from_user_id = v.user_id))
      )
    )
  group by v.user_id
  order by cell_count desc
  limit result_limit;
end;
$$ language plpgsql security definer;

-- Geohashエンコード関数（DB側で位置→geohashを計算）
create or replace function encode_geohash(lat double precision, lon double precision, precision_len integer default 7)
returns text as $$
declare
  base32 text := '0123456789bcdefghjkmnpqrstuvwxyz';
  min_lat double precision := -90;
  max_lat double precision := 90;
  min_lon double precision := -180;
  max_lon double precision := 180;
  mid double precision;
  bits integer := 0;
  hash_val integer := 0;
  is_lon boolean := true;
  result text := '';
begin
  precision_len := least(precision_len, 12);
  while length(result) < precision_len loop
    if is_lon then
      mid := (min_lon + max_lon) / 2;
      if lon >= mid then
        hash_val := hash_val * 2 + 1;
        min_lon := mid;
      else
        hash_val := hash_val * 2;
        max_lon := mid;
      end if;
    else
      mid := (min_lat + max_lat) / 2;
      if lat >= mid then
        hash_val := hash_val * 2 + 1;
        min_lat := mid;
      else
        hash_val := hash_val * 2;
        max_lat := mid;
      end if;
    end if;
    is_lon := not is_lon;
    bits := bits + 1;
    if bits = 5 then
      result := result || substr(base32, hash_val + 1, 1);
      bits := 0;
      hash_val := 0;
    end if;
  end loop;
  return result;
end;
$$ language plpgsql immutable;

-- 位置送信時にセルを自動記録するトリガー
create or replace function record_visited_cell()
returns trigger as $$
declare
  gh text;
begin
  gh := encode_geohash(NEW.lat, NEW.lon, 7);
  insert into visited_cells (user_id, geohash, first_visited_at, last_visited_at, visit_count)
  values (NEW.user_id, gh, now(), now(), 1)
  on conflict (user_id, geohash) do update
  set last_visited_at = now(), visit_count = visited_cells.visit_count + 1;
  return NEW;
end;
$$ language plpgsql security definer;

create or replace trigger trg_record_visited_cell
after insert or update on locations_current
for each row execute function record_visited_cell();

-- =====================
-- DM チャットルーム作成（アトミック、競合状態なし）
-- =====================
create or replace function create_direct_chat(p_other_user_id uuid)
returns uuid as $$
declare
  v_user_id uuid := auth.uid();
  v_room_id uuid;
begin
  -- ブロックチェック
  if exists (
    select 1 from blocked_users
    where (blocker_id = v_user_id and blocked_id = p_other_user_id)
       or (blocker_id = p_other_user_id and blocked_id = v_user_id)
  ) then
    raise exception 'Cannot create chat with blocked user';
  end if;

  -- フレンドチェック
  if not exists (
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user_id = v_user_id and to_user_id = p_other_user_id)
        or (to_user_id = v_user_id and from_user_id = p_other_user_id))
  ) then
    raise exception 'Users are not friends';
  end if;

  -- Advisory lock to prevent concurrent duplicate DM room creation
  -- Use a deterministic lock key from both user IDs (order-independent)
  perform pg_advisory_xact_lock(
    hashtext(least(v_user_id::text, p_other_user_id::text) || ':' || greatest(v_user_id::text, p_other_user_id::text))
  );

  -- 既存のDMルームを検索
  select cm1.room_id into v_room_id
  from chat_room_members cm1
  join chat_room_members cm2 on cm1.room_id = cm2.room_id
  join chat_rooms cr on cr.id = cm1.room_id
  where cm1.user_id = v_user_id
    and cm2.user_id = p_other_user_id
    and cr.type = 'direct'
  limit 1;

  if v_room_id is not null then
    return v_room_id;
  end if;

  -- 新規ルーム作成 + 両メンバー追加をアトミックに実行
  insert into chat_rooms (type) values ('direct')
  returning id into v_room_id;

  insert into chat_room_members (room_id, user_id)
  values (v_room_id, v_user_id), (v_room_id, p_other_user_id);

  return v_room_id;
end;
$$ language plpgsql security definer;

-- =====================
-- グループチャットルーム作成（アトミック、競合状態なし）
-- =====================
create or replace function create_group_chat(p_group_id uuid)
returns uuid as $$
declare
  v_room_id uuid;
begin
  -- メンバーチェック
  if not exists (
    select 1 from group_members
    where group_id = p_group_id and user_id = auth.uid()
  ) then
    raise exception 'Not a member of this group';
  end if;

  -- Advisory lock to prevent concurrent duplicate group chat creation
  perform pg_advisory_xact_lock(hashtext('group_chat:' || p_group_id::text));

  -- 既存のグループチャットルームを検索
  select id into v_room_id
  from chat_rooms
  where group_id = p_group_id and type = 'group'
  limit 1;

  if v_room_id is not null then
    return v_room_id;
  end if;

  -- 新規ルーム作成
  insert into chat_rooms (type, group_id) values ('group', p_group_id)
  returning id into v_room_id;

  return v_room_id;
end;
$$ language plpgsql security definer;

-- =====================
-- グループ参加（invite_codeを検証してメンバー追加）
-- =====================
create or replace function join_group_by_invite(p_invite_code text)
returns uuid as $$
declare
  v_group_id uuid;
begin
  select id into v_group_id from groups where invite_code = p_invite_code;
  if v_group_id is null then
    raise exception 'Invalid invite code';
  end if;

  -- ブロックチェック（グループオーナーがブロックしている場合は参加不可）
  if exists (
    select 1 from blocked_users bu
    join groups g on g.id = v_group_id
    where (bu.blocker_id = g.owner_id and bu.blocked_id = auth.uid())
       or (bu.blocker_id = auth.uid() and bu.blocked_id = g.owner_id)
  ) then
    raise exception 'Cannot join this group';
  end if;

  -- 既にメンバーなら何もしない
  if exists (select 1 from group_members where group_id = v_group_id and user_id = auth.uid()) then
    return v_group_id;
  end if;

  insert into group_members (group_id, user_id, role, joined_at)
  values (v_group_id, auth.uid(), 'member', now());

  return v_group_id;
end;
$$ language plpgsql security definer;

-- =====================
-- フレンドリクエスト承認（双方向share_rules作成）
-- =====================
-- RLSでは自分のowner_idのみINSERT可能なので、相手側のルールは
-- security definer関数で作成する
create or replace function accept_friend_request(p_request_id bigint)
returns void as $$
declare
  v_from_user_id uuid;
  v_to_user_id uuid;
begin
  -- 呼び出し元が to_user_id であることを確認
  update friend_requests
  set status = 'accepted', updated_at = now()
  where id = p_request_id
    and to_user_id = auth.uid()
    and status = 'pending'
  returning from_user_id, to_user_id into v_from_user_id, v_to_user_id;

  if v_from_user_id is null then
    raise exception 'Friend request not found or not authorized';
  end if;

  -- 双方向の共有ルールを作成（history レベル）
  insert into share_rules (owner_id, viewer_id, level)
  values
    (v_from_user_id, v_to_user_id, 'history'),
    (v_to_user_id, v_from_user_id, 'history')
  on conflict (owner_id, viewer_id) do update set level = 'history';
end;
$$ language plpgsql security definer;

-- =====================
-- ゴーストモード制御トリガー
-- =====================
-- ゴーストモードが有効な場合、位置更新をサーバー側で拒否
create or replace function enforce_ghost_mode()
returns trigger as $$
begin
  if exists (
    select 1 from user_settings
    where user_id = NEW.user_id
      and ghost_mode = true
      and (ghost_until is null or ghost_until > now())
  ) then
    raise exception 'Location update blocked: ghost mode is active';
  end if;
  return NEW;
end;
$$ language plpgsql security definer;

create or replace trigger trg_enforce_ghost_mode
before insert or update on locations_current
for each row execute function enforce_ghost_mode();

-- =====================
-- グループ作成（アトミック: groups + group_members を同一トランザクションで処理）
-- =====================
create or replace function create_group_atomic(p_name text, p_description text, p_invite_code text)
returns uuid as $$
declare
  v_group_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into groups (name, description, owner_id, invite_code)
  values (p_name, p_description, auth.uid(), p_invite_code)
  returning id into v_group_id;

  insert into group_members (group_id, user_id, role)
  values (v_group_id, auth.uid(), 'owner');

  return v_group_id;
end;
$$ language plpgsql security definer;

-- =====================
-- フレンド削除（アトミック: friend_requests + share_rules を同一トランザクションで処理）
-- =====================
create or replace function remove_friend(p_friend_id uuid)
returns void as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  -- Delete friend request
  delete from friend_requests
  where status = 'accepted'
    and ((from_user_id = v_user_id and to_user_id = p_friend_id)
      or (from_user_id = p_friend_id and to_user_id = v_user_id));

  -- Delete both directions of share rules
  delete from share_rules
  where (owner_id = v_user_id and viewer_id = p_friend_id)
     or (owner_id = p_friend_id and viewer_id = v_user_id);
end;
$$ language plpgsql security definer;

-- =====================
-- leave_group（原子的グループ退出 — オーナーチェック＋退出を単一トランザクション）
-- =====================
create or replace function leave_group(p_group_id uuid)
returns void as $$
declare
  v_user_id uuid := auth.uid();
  v_owner_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  select owner_id into v_owner_id from groups where id = p_group_id;
  if v_owner_id is null then
    raise exception 'Group not found';
  end if;
  if v_owner_id = v_user_id then
    raise exception 'Group owner cannot leave. Delete the group or transfer ownership first.';
  end if;
  delete from group_members where group_id = p_group_id and user_id = v_user_id;
  if not found then
    raise exception 'Not a member of this group';
  end if;
end;
$$ language plpgsql security definer;

-- =====================
-- block_user_atomic（原子的ブロック — ブロック＋フレンド解除を単一トランザクション）
-- =====================
create or replace function block_user_atomic(p_blocked_id uuid)
returns void as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if v_user_id = p_blocked_id then
    raise exception 'Cannot block yourself';
  end if;

  insert into blocked_users (blocker_id, blocked_id)
  values (v_user_id, p_blocked_id)
  on conflict do nothing;

  -- フレンド関係も解除
  delete from friend_requests
  where status = 'accepted'
    and ((from_user_id = v_user_id and to_user_id = p_blocked_id)
      or (from_user_id = p_blocked_id and to_user_id = v_user_id));

  -- 共有ルールも削除
  delete from share_rules
  where (owner_id = v_user_id and viewer_id = p_blocked_id)
     or (owner_id = p_blocked_id and viewer_id = v_user_id);
end;
$$ language plpgsql security definer;

-- =====================
-- Supabase Storageバケット（avatars）
-- =====================
-- Supabaseダッシュボードまたはマイグレーションで実行:
-- insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);

-- ---------------------------------------------------------------------
-- migration: 20240101000003_core_policies.sql
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- migration: 20240101000004_storage_setup.sql
-- ---------------------------------------------------------------------
-- Create avatars storage bucket
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Storage policies for avatars bucket
create policy "avatars_read_public" on storage.objects for select using (bucket_id = 'avatars');
create policy "avatars_insert_own" on storage.objects for insert with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "avatars_update_own" on storage.objects for update using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "avatars_delete_own" on storage.objects for delete using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- ---------------------------------------------------------------------
-- migration: 20240101000005_geodrop_schema.sql
-- ---------------------------------------------------------------------
-- =====================
-- geo-drop table definitions
-- Location-bound data drops
-- =====================

create type drop_visibility as enum ('public', 'friends', 'private', 'password');
create type drop_content_type as enum ('text', 'image', 'audio', 'video', 'file', 'nft');
create type drop_status as enum ('active', 'expired', 'claimed', 'deleted');

-- Main table
create table if not exists geo_drops (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  -- Location
  lat double precision not null,
  lon double precision not null,
  geohash text not null,
  unlock_radius_meters real not null default 50,
  -- Content
  title text not null,
  description text,
  content_type drop_content_type not null default 'text',
  ipfs_cid text,
  encrypted_content text, -- stores encrypted payload when IPFS is not used (db-only mode)
  encrypted boolean not null default true,
  encryption_salt text,
  -- Access control
  visibility drop_visibility not null default 'public',
  password_hash text,
  max_claims integer,
  claim_count integer not null default 0,
  -- Location proof (non-GPS: QR, BLE, WiFi, AR, custom)
  proof_config jsonb, -- { mode: 'all'|'any', requirements: [...] }
  -- Expiration
  expires_at timestamptz,
  status drop_status not null default 'active',
  -- Metadata
  preview_url text,
  metadata jsonb,
  -- Persistence (reference info for DB-independent recovery)
  persistence_level text not null default 'db-only',
  metadata_cid text,
  chain_tx_hash text,
  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_geo_drops_creator on geo_drops (creator_id);
create index if not exists idx_geo_drops_geohash on geo_drops (geohash);
create index if not exists idx_geo_drops_status on geo_drops (status);
create index if not exists idx_geo_drops_geohash_status on geo_drops (geohash, status);

-- Claims (collection records)
create table if not exists drop_claims (
  id uuid primary key default gen_random_uuid(),
  drop_id uuid not null references geo_drops(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  lat double precision not null,
  lon double precision not null,
  distance_meters real not null,
  proof_results jsonb, -- Verification result records [{ method, verified, details }]
  claimed_at timestamptz not null default now(),
  unique (drop_id, user_id)
);

create index if not exists idx_drop_claims_drop on drop_claims (drop_id);
create index if not exists idx_drop_claims_user on drop_claims (user_id);

-- Private sharing (share private drops with specific users)
create table if not exists drop_shares (
  drop_id uuid not null references geo_drops(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (drop_id, user_id)
);

create index if not exists idx_drop_shares_user on drop_shares (user_id);
create index if not exists idx_drop_shares_drop on drop_shares (drop_id);

-- Rate limit logs (GPS spoofing countermeasure)
create table if not exists drop_location_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lat double precision not null,
  lon double precision not null,
  geohash text not null,
  action text not null, -- 'unlock_attempt', 'create', 'search'
  created_at timestamptz not null default now()
);

create index if not exists idx_drop_location_logs_user on drop_location_logs (user_id, created_at desc);

-- Atomic increment of claim_count (with max_claims check, prevents race conditions)
-- increment_claim_count: security definer but requires authenticated user
-- and checks that the caller has not already claimed this drop
create or replace function increment_claim_count(p_drop_id uuid)
returns boolean as $$
declare
  v_max_claims integer;
  v_claim_count integer;
  updated_rows integer;
begin
  -- Require authentication
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Lock the drop row to prevent TOCTOU race condition
  select max_claims, claim_count into v_max_claims, v_claim_count
  from geo_drops
  where id = p_drop_id
  for update;

  if not found then
    raise exception 'Drop not found';
  end if;

  -- Check max claims under lock
  if v_max_claims is not null and v_claim_count >= v_max_claims then
    return false;
  end if;

  -- Prevent double-claim (checked under the row lock)
  if exists (select 1 from drop_claims where drop_id = p_drop_id and user_id = auth.uid()) then
    raise exception 'Already claimed';
  end if;

  -- Set session flag so protect_claim_count trigger allows the change
  perform set_config('app.claim_count_update', 'true', true);
  update geo_drops
  set claim_count = claim_count + 1, updated_at = now()
  where id = p_drop_id;
  get diagnostics updated_rows = row_count;
  return updated_rows > 0;
end;
$$ language plpgsql security definer;

-- Compensating decrement if claim INSERT fails after increment
create or replace function decrement_claim_count(p_drop_id uuid)
returns void as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform set_config('app.claim_count_update', 'true', true);
  update geo_drops
  set claim_count = greatest(claim_count - 1, 0), updated_at = now()
  where id = p_drop_id;
end;
$$ language plpgsql security definer;

-- Prevent direct manipulation of claim_count by non-service-role users
-- Only increment_claim_count() should modify this column
create or replace function protect_claim_count()
returns trigger as $$
begin
  -- Allow if called from increment_claim_count (session variable set by that function)
  -- or if claim_count hasn't changed
  if NEW.claim_count != OLD.claim_count then
    -- Only allow if called from increment/decrement_claim_count (session flag)
    if coalesce(current_setting('app.claim_count_update', true), '') != 'true' then
      NEW.claim_count := OLD.claim_count; -- silently reset to old value
    end if;
  end if;
  return NEW;
end;
$$ language plpgsql;

create or replace trigger trg_protect_claim_count
before update on geo_drops
for each row execute function protect_claim_count();

-- Automatic processing of expired drops
create or replace function cleanup_expired_drops()
returns void as $$
begin
  update geo_drops
  set status = 'expired', updated_at = now()
  where status = 'active'
    and expires_at is not null
    and expires_at <= now();
end;
$$ language plpgsql security definer;

-- Run in environments with pg_cron enabled:
-- select cron.schedule('cleanup-expired-drops', '*/15 * * * *', 'select cleanup_expired_drops()');

-- ---------------------------------------------------------------------
-- migration: 20240101000006_geodrop_policies.sql
-- ---------------------------------------------------------------------
-- =====================
-- geo_drops ポリシー
-- =====================
alter table geo_drops enable row level security;

-- publicドロップは誰でも見える
create policy "geo_drops_select_public"
on geo_drops for select
using (
  visibility = 'public'
  and status = 'active'
  and (expires_at is null or expires_at > now())
);

-- friendsドロップはフレンドのみ
create policy "geo_drops_select_friends"
on geo_drops for select
using (
  visibility = 'friends'
  and status = 'active'
  and (expires_at is null or expires_at > now())
  and (
    creator_id = auth.uid()
    or exists (
      select 1 from friend_requests
      where status = 'accepted'
        and ((from_user_id = auth.uid() and to_user_id = geo_drops.creator_id)
          or (to_user_id = auth.uid() and from_user_id = geo_drops.creator_id))
    )
  )
);

-- 自分のドロップは常に見える（ステータス問わず）
create policy "geo_drops_select_own"
on geo_drops for select
using (creator_id = auth.uid());

-- パスワード付きドロップは誰でも見える（中身はパスワードで保護）
create policy "geo_drops_select_password"
on geo_drops for select
using (
  visibility = 'password'
  and status = 'active'
  and (expires_at is null or expires_at > now())
);

-- privateドロップは共有先ユーザーのみ
create policy "geo_drops_select_private_shared"
on geo_drops for select
using (
  visibility = 'private'
  and status = 'active'
  and (expires_at is null or expires_at > now())
  and exists (
    select 1 from drop_shares
    where drop_id = geo_drops.id
      and user_id = auth.uid()
  )
);

-- 作成は認証ユーザーのみ
create policy "geo_drops_insert"
on geo_drops for insert
with check (auth.uid() = creator_id);

-- 更新は作成者のみ（creator_id の変更も禁止）
create policy "geo_drops_update"
on geo_drops for update
using (auth.uid() = creator_id)
with check (auth.uid() = creator_id);

-- 削除は作成者のみ（論理削除推奨だが物理削除も許可）
create policy "geo_drops_delete"
on geo_drops for delete
using (auth.uid() = creator_id);

-- NOTE: RLSはカラムレベルの制限不可。センシティブカラム (encryption_salt,
-- password_hash, encrypted_content) はSDK側のSELECTでカラム指定して除外済み。
-- unlock-drop Edge FunctionはサービスロールでアクセスするためRLS非適用。

-- 更新時にセンシティブカラム・セキュリティカラムの不正変更を防止するトリガー
create or replace function protect_drop_sensitive_columns()
returns trigger as $$
begin
  -- creator_id は変更不可（所有権移転防止）
  if NEW.creator_id is distinct from OLD.creator_id then
    raise exception 'Cannot modify creator_id';
  end if;
  -- encryption_salt は変更不可
  if NEW.encryption_salt is distinct from OLD.encryption_salt then
    raise exception 'Cannot modify encryption_salt';
  end if;
  -- geohash は変更不可 (暗号化キーに使われる)
  if NEW.geohash is distinct from OLD.geohash then
    raise exception 'Cannot modify geohash';
  end if;
  return NEW;
end;
$$ language plpgsql;

create or replace trigger trg_protect_drop_sensitive_columns
before update on geo_drops
for each row execute function protect_drop_sensitive_columns();

-- =====================
-- drop_claims ポリシー
-- =====================
alter table drop_claims enable row level security;

-- 自分のクレームは見える
create policy "drop_claims_select_own"
on drop_claims for select
using (user_id = auth.uid());

-- ドロップ作成者はそのドロップのクレームが見える
create policy "drop_claims_select_creator"
on drop_claims for select
using (
  exists (
    select 1 from geo_drops
    where id = drop_claims.drop_id
      and creator_id = auth.uid()
  )
);

-- クレーム作成はEdge Function(service_role)経由のみ
-- 直接INSERTを禁止（距離検証はEdge Functionで行う）
create policy "drop_claims_insert"
on drop_claims for insert
with check (false);

-- =====================
-- drop_shares ポリシー
-- =====================
alter table drop_shares enable row level security;

-- 共有先ユーザーは自分の共有を見れる
create policy "drop_shares_select_shared"
on drop_shares for select
using (user_id = auth.uid());

-- ドロップ作成者は共有一覧を見れる
create policy "drop_shares_select_creator"
on drop_shares for select
using (
  exists (
    select 1 from geo_drops
    where id = drop_shares.drop_id
      and creator_id = auth.uid()
  )
);

-- 作成者のみ共有を追加・削除できる
create policy "drop_shares_insert"
on drop_shares for insert
with check (
  exists (
    select 1 from geo_drops
    where id = drop_shares.drop_id
      and creator_id = auth.uid()
  )
);

create policy "drop_shares_delete"
on drop_shares for delete
using (
  exists (
    select 1 from geo_drops
    where id = drop_shares.drop_id
      and creator_id = auth.uid()
  )
);

-- =====================
-- drop_location_logs ポリシー
-- =====================
alter table drop_location_logs enable row level security;

-- 自分のログのみ見える
create policy "drop_location_logs_select_own"
on drop_location_logs for select
using (auth.uid() = user_id);

-- ログ書き込みは認証ユーザーのみ
create policy "drop_location_logs_insert"
on drop_location_logs for insert
with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- migration: 20240101000007_realtime_rls.sql
-- ---------------------------------------------------------------------
-- Enable Realtime RLS enforcement
-- Supabase Realtime uses the `supabase_realtime` publication.
-- By default, it publishes ALL tables without RLS filtering.
-- This migration restricts it to specific tables and enables
-- row-level security on the Realtime stream.

-- Drop existing default publication (publishes all tables)
drop publication if exists supabase_realtime;

-- Re-create with explicit table list (excludes sensitive tables)
-- Only tables that need real-time updates are included.
create publication supabase_realtime for table
  locations_current,
  friend_requests,
  messages,
  location_reactions,
  geo_drops;

-- Enable RLS on the publication (Supabase Realtime will apply
-- the same RLS policies that apply to SELECT queries).
-- This ensures users only receive events for rows they can read.
alter publication supabase_realtime set (publish = 'insert, update, delete');

-- Note: For this to take effect on hosted Supabase, the project must have
-- "Realtime RLS" enabled in Dashboard > Database > Replication.
-- For local development (supabase start), this migration is sufficient.

-- ---------------------------------------------------------------------
-- migration: 20260401000008_relationship_settings.sql
-- ---------------------------------------------------------------------
create table if not exists relationship_settings (
  owner_id uuid not null references auth.users(id) on delete cascade,
  target_id uuid not null references auth.users(id) on delete cascade,
  intimacy_score integer not null default 20,
  updated_at timestamptz not null default now(),
  primary key (owner_id, target_id),
  check (owner_id <> target_id),
  check (intimacy_score >= 0 and intimacy_score <= 100)
);

create index if not exists idx_relationship_settings_owner
  on relationship_settings (owner_id);

create index if not exists idx_relationship_settings_target
  on relationship_settings (target_id);

alter table relationship_settings enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'relationship_settings'
      and policyname = 'relationship_settings_select_own'
  ) then
    create policy relationship_settings_select_own
      on relationship_settings
      for select
      to authenticated
      using (owner_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'relationship_settings'
      and policyname = 'relationship_settings_insert_own'
  ) then
    create policy relationship_settings_insert_own
      on relationship_settings
      for insert
      to authenticated
      with check (owner_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'relationship_settings'
      and policyname = 'relationship_settings_update_own'
  ) then
    create policy relationship_settings_update_own
      on relationship_settings
      for update
      to authenticated
      using (owner_id = auth.uid())
      with check (owner_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'relationship_settings'
      and policyname = 'relationship_settings_delete_own'
  ) then
    create policy relationship_settings_delete_own
      on relationship_settings
      for delete
      to authenticated
      using (owner_id = auth.uid());
  end if;
end
$$;

grant select, insert, update, delete
  on relationship_settings
  to authenticated;

insert into relationship_settings (owner_id, target_id, intimacy_score)
select from_user_id, to_user_id, 20
from friend_requests
where status = 'accepted'
on conflict (owner_id, target_id) do nothing;

insert into relationship_settings (owner_id, target_id, intimacy_score)
select to_user_id, from_user_id, 20
from friend_requests
where status = 'accepted'
on conflict (owner_id, target_id) do nothing;

create or replace function set_relationship_intimacy(
  p_target_id uuid,
  p_intimacy_score integer
)
returns void as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_target_id is null or p_target_id = v_user_id then
    raise exception 'Invalid target user';
  end if;

  if p_intimacy_score < 0 or p_intimacy_score > 100 then
    raise exception 'Intimacy score must be between 0 and 100';
  end if;

  if not exists (
    select 1
    from friend_requests
    where status = 'accepted'
      and (
        (from_user_id = v_user_id and to_user_id = p_target_id)
        or (from_user_id = p_target_id and to_user_id = v_user_id)
      )
  ) then
    raise exception 'Users are not connected';
  end if;

  insert into relationship_settings (
    owner_id,
    target_id,
    intimacy_score,
    updated_at
  )
  values (
    v_user_id,
    p_target_id,
    p_intimacy_score,
    now()
  )
  on conflict (owner_id, target_id) do update
    set intimacy_score = excluded.intimacy_score,
        updated_at = now();
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function set_relationship_intimacy(uuid, integer)
  to authenticated;

grant execute on function set_relationship_intimacy(uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------
-- migration: 20260401000009_posts.sql
-- ---------------------------------------------------------------------
create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  text text,
  image_url text,
  visibility_value integer not null default 50,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (visibility_value >= 0 and visibility_value <= 100),
  check (coalesce(length(trim(text)), 0) > 0 or image_url is not null)
);

create index if not exists idx_posts_author_created
  on posts (author_id, created_at desc);

create index if not exists idx_posts_expires_at
  on posts (expires_at);

alter table posts enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'posts_select_own'
  ) then
    create policy posts_select_own
      on posts
      for select
      to authenticated
      using (author_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'posts_insert_own'
  ) then
    create policy posts_insert_own
      on posts
      for insert
      to authenticated
      with check (author_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'posts_update_own'
  ) then
    create policy posts_update_own
      on posts
      for update
      to authenticated
      using (author_id = auth.uid())
      with check (author_id = auth.uid());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'posts'
      and policyname = 'posts_delete_own'
  ) then
    create policy posts_delete_own
      on posts
      for delete
      to authenticated
      using (author_id = auth.uid());
  end if;
end
$$;

grant select, insert, update, delete
  on posts
  to authenticated;

create or replace function get_post_feed(p_limit integer default 50)
returns table (
  post_id uuid,
  author_id uuid,
  author_username text,
  author_display_name text,
  text text,
  image_url text,
  visibility_value integer,
  expires_at timestamptz,
  created_at timestamptz,
  viewer_tier text,
  is_author boolean
) as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  return query
  with visible_candidates as (
    select
      p.id,
      p.author_id,
      pr.username as author_username,
      pr.display_name as author_display_name,
      p.text,
      p.image_url,
      p.visibility_value,
      p.expires_at,
      p.created_at,
      (p.author_id = v_user_id) as is_author,
      case
        when p.author_id = v_user_id then 'full'
        when fr.id is not null then
          case
            when coalesce(rs.intimacy_score, 20) >= greatest(0, 100 - p.visibility_value)
              then 'full'
            when coalesce(rs.intimacy_score, 20) >= greatest(0, 70 - p.visibility_value)
              then 'partial'
            else 'hidden'
          end
        else null
      end as viewer_tier
    from posts p
    left join profiles pr
      on pr.user_id = p.author_id
    left join friend_requests fr
      on fr.status = 'accepted'
      and (
        (fr.from_user_id = p.author_id and fr.to_user_id = v_user_id)
        or (fr.to_user_id = p.author_id and fr.from_user_id = v_user_id)
      )
    left join relationship_settings rs
      on rs.owner_id = p.author_id
      and rs.target_id = v_user_id
    where p.deleted_at is null
      and p.expires_at > now()
  )
  select
    vc.id as post_id,
    vc.author_id,
    vc.author_username,
    vc.author_display_name,
    case vc.viewer_tier
      when 'full' then vc.text
      when 'partial' then
        case
          when vc.text is null then null
          when length(vc.text) <= 80 then vc.text
          else left(vc.text, 80) || '...'
        end
      else null
    end as text,
    case
      when vc.viewer_tier = 'full' then vc.image_url
      else null
    end as image_url,
    vc.visibility_value,
    vc.expires_at,
    vc.created_at,
    vc.viewer_tier,
    vc.is_author
  from visible_candidates vc
  where vc.viewer_tier is not null
  order by vc.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function get_post_feed(integer)
  to authenticated;

grant execute on function get_post_feed(integer)
  to service_role;

-- ---------------------------------------------------------------------
-- migration: 20260401000010_post_images.sql
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('post-images', 'post-images', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'post_images_read_public'
  ) then
    create policy post_images_read_public
      on storage.objects
      for select
      using (bucket_id = 'post-images');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'post_images_insert_own'
  ) then
    create policy post_images_insert_own
      on storage.objects
      for insert
      to authenticated
      with check (
        bucket_id = 'post-images'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'post_images_update_own'
  ) then
    create policy post_images_update_own
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'post-images'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'post_images_delete_own'
  ) then
    create policy post_images_delete_own
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'post-images'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- migration: 20260401000011_post_feed_partial_images.sql
-- ---------------------------------------------------------------------
create or replace function get_post_feed(p_limit integer default 50)
returns table (
  post_id uuid,
  author_id uuid,
  author_username text,
  author_display_name text,
  text text,
  image_url text,
  visibility_value integer,
  expires_at timestamptz,
  created_at timestamptz,
  viewer_tier text,
  is_author boolean
) as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  return query
  with visible_candidates as (
    select
      p.id,
      p.author_id,
      pr.username as author_username,
      pr.display_name as author_display_name,
      p.text,
      p.image_url,
      p.visibility_value,
      p.expires_at,
      p.created_at,
      (p.author_id = v_user_id) as is_author,
      case
        when p.author_id = v_user_id then 'full'
        when fr.id is not null then
          case
            when coalesce(rs.intimacy_score, 20) >= greatest(0, 100 - p.visibility_value)
              then 'full'
            when coalesce(rs.intimacy_score, 20) >= greatest(0, 70 - p.visibility_value)
              then 'partial'
            else 'hidden'
          end
        else null
      end as viewer_tier
    from posts p
    left join profiles pr
      on pr.user_id = p.author_id
    left join friend_requests fr
      on fr.status = 'accepted'
      and (
        (fr.from_user_id = p.author_id and fr.to_user_id = v_user_id)
        or (fr.to_user_id = p.author_id and fr.from_user_id = v_user_id)
      )
    left join relationship_settings rs
      on rs.owner_id = p.author_id
      and rs.target_id = v_user_id
    where p.deleted_at is null
      and p.expires_at > now()
  )
  select
    vc.id as post_id,
    vc.author_id,
    vc.author_username,
    vc.author_display_name,
    case vc.viewer_tier
      when 'full' then vc.text
      when 'partial' then
        case
          when vc.text is null then null
          when length(vc.text) <= 80 then vc.text
          else left(vc.text, 80) || '...'
        end
      else null
    end as text,
    case
      when vc.viewer_tier in ('full', 'partial') then vc.image_url
      else null
    end as image_url,
    vc.visibility_value,
    vc.expires_at,
    vc.created_at,
    vc.viewer_tier,
    vc.is_author
  from visible_candidates vc
  where vc.viewer_tier is not null
  order by vc.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function get_post_feed(integer)
  to authenticated;

grant execute on function get_post_feed(integer)
  to service_role;

-- ---------------------------------------------------------------------
-- migration: 20260401000012_post_locations.sql
-- ---------------------------------------------------------------------
alter table posts
  add column if not exists lat double precision,
  add column if not exists lon double precision,
  add column if not exists location_radius_m integer,
  add column if not exists location_blur_level integer;

alter table posts
  drop constraint if exists posts_location_pair_check;

alter table posts
  add constraint posts_location_pair_check
  check (
    (lat is null and lon is null and location_radius_m is null and location_blur_level is null)
    or (
      lat is not null
      and lon is not null
      and location_radius_m is not null
      and location_radius_m > 0
      and location_blur_level is not null
      and location_blur_level between 0 and 3
    )
  );

drop function if exists get_post_feed(integer);

create or replace function get_post_feed(p_limit integer default 50)
returns table (
  post_id uuid,
  author_id uuid,
  author_username text,
  author_display_name text,
  text text,
  image_url text,
  visibility_value integer,
  expires_at timestamptz,
  created_at timestamptz,
  viewer_tier text,
  is_author boolean,
  lat double precision,
  lon double precision,
  location_radius_m integer,
  location_blur_level integer
) as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  return query
  with visible_candidates as (
    select
      p.id,
      p.author_id,
      pr.username as author_username,
      pr.display_name as author_display_name,
      p.text,
      p.image_url,
      p.visibility_value,
      p.expires_at,
      p.created_at,
      (p.author_id = v_user_id) as is_author,
      p.lat,
      p.lon,
      p.location_radius_m,
      p.location_blur_level,
      case
        when p.author_id = v_user_id then 'full'
        when fr.id is not null then
          case
            when coalesce(rs.intimacy_score, 20) >= greatest(0, 100 - p.visibility_value)
              then 'full'
            when coalesce(rs.intimacy_score, 20) >= greatest(0, 70 - p.visibility_value)
              then 'partial'
            else 'hidden'
          end
        else null
      end as viewer_tier
    from posts p
    left join profiles pr
      on pr.user_id = p.author_id
    left join friend_requests fr
      on fr.status = 'accepted'
      and (
        (fr.from_user_id = p.author_id and fr.to_user_id = v_user_id)
        or (fr.to_user_id = p.author_id and fr.from_user_id = v_user_id)
      )
    left join relationship_settings rs
      on rs.owner_id = p.author_id
      and rs.target_id = v_user_id
    where p.deleted_at is null
      and p.expires_at > now()
  )
  select
    vc.id as post_id,
    vc.author_id,
    vc.author_username,
    vc.author_display_name,
    case vc.viewer_tier
      when 'full' then vc.text
      when 'partial' then
        case
          when vc.text is null then null
          when length(vc.text) <= 80 then vc.text
          else left(vc.text, 80) || '...'
        end
      else null
    end as text,
    case
      when vc.viewer_tier in ('full', 'partial') then vc.image_url
      else null
    end as image_url,
    vc.visibility_value,
    vc.expires_at,
    vc.created_at,
    vc.viewer_tier,
    vc.is_author,
    case
      when vc.viewer_tier in ('full', 'partial') then vc.lat
      else null
    end as lat,
    case
      when vc.viewer_tier in ('full', 'partial') then vc.lon
      else null
    end as lon,
    case
      when vc.viewer_tier in ('full', 'partial') then vc.location_radius_m
      else null
    end as location_radius_m,
    case
      when vc.viewer_tier = 'full' then vc.location_blur_level
      when vc.viewer_tier = 'partial' and vc.location_blur_level is not null
        then least(3, vc.location_blur_level + 1)
      else null
    end as location_blur_level
  from visible_candidates vc
  where vc.viewer_tier is not null
  order by vc.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function get_post_feed(integer)
  to authenticated;

grant execute on function get_post_feed(integer)
  to service_role;

-- ---------------------------------------------------------------------
-- migration: 20260706000013_security_hardening.sql
-- ---------------------------------------------------------------------
-- =====================================================================
-- Security hardening migration (2026-07-06)
--
-- Closes three RLS/view leaks found in the security audit:
--   1. geo_drops secret columns (encrypted_content, encryption_salt,
--      password_hash, search_tokens) were readable by any authenticated
--      user because RLS grants row-level SELECT on the whole row. The SDK
--      excludes them by naming columns, but a raw PostgREST query
--      (`select encryption_salt from geo_drops`) still returned them,
--      enabling offline password brute-force and offline decryption.
--   2. geo_drops_public view ran as owner (no security_invoker), bypassing
--      RLS and exposing private/friends-only drops' coordinates to everyone.
--   3. visited_cell_stats view (security_barrier only) likewise bypassed
--      RLS, leaking every user's exploration aggregates.
--
-- The unlock-drop Edge Function uses the service_role, which bypasses both
-- RLS and column grants, so server-side decryption is unaffected.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Column-level SELECT on geo_drops for the API roles.
--
-- Postgres column privileges are additive: a table-level SELECT grant
-- exposes ALL columns regardless of any per-column REVOKE. So we must
-- drop the table-level grant and re-grant only the non-secret columns.
--
-- NOTE FOR MAINTAINERS: any NEW column added to geo_drops is private to
-- authenticated/anon until you add it to this GRANT list. That is the
-- intended fail-safe default — expose columns deliberately.
-- ---------------------------------------------------------------------
revoke select on geo_drops from authenticated;
revoke select on geo_drops from anon;

grant select (
  id, creator_id,
  lat, lon, geohash, unlock_radius_meters,
  title, description, content_type, ipfs_cid, encrypted,
  visibility, max_claims, claim_count, proof_config,
  expires_at, status,
  preview_url, metadata,
  persistence_level, metadata_cid, chain_tx_hash,
  created_at, updated_at
) on geo_drops to authenticated;

grant select (
  id, creator_id,
  lat, lon, geohash, unlock_radius_meters,
  title, description, content_type, ipfs_cid, encrypted,
  visibility, max_claims, claim_count, proof_config,
  expires_at, status,
  preview_url, metadata,
  persistence_level, metadata_cid, chain_tx_hash,
  created_at, updated_at
) on geo_drops to anon;

-- Withheld (never exposed to client roles):
--   encrypted_content, encryption_salt, password_hash, search_tokens,
--   pin_status, key_derivation_version, encryption_algorithm,
--   server_secret_version.
--
-- FOLLOW-UP (code, not covered here): proof_config for 'secret'-method
-- drops currently stores the plaintext unlock secret. It is exposed above
-- because clients need the unlock requirements, so the secret must be
-- HASHED (like password_hash) in createDrop / verified server-side —
-- see verification.ts secret verifier.

-- ---------------------------------------------------------------------
-- 2. + 3. Make views respect the querying user's RLS.
--     security_invoker requires PostgreSQL 15+ (Supabase default).
-- ---------------------------------------------------------------------
-- geo_drops_public was historically created only by
-- packages/geo-drop/database/schema.sql, never by a migration, so an
-- `alter view` here aborts a migration-only deploy. Create it instead.
create or replace view geo_drops_public
with (security_invoker = on) as
select id, creator_id, lat, lon, geohash, unlock_radius_meters,
       title, description, content_type, visibility,
       max_claims, claim_count, proof_config, expires_at, status,
       preview_url, metadata, persistence_level,
       metadata_cid, chain_tx_hash, ipfs_cid, encrypted,
       created_at, updated_at
from geo_drops;
alter view visited_cell_stats set (security_invoker = on);

-- ---------------------------------------------------------------------
-- migration: 20260709000014_secret_requirement_hardening.sql
-- ---------------------------------------------------------------------
-- =====================================================================
-- Secret-requirement authorization bypass fix (2026-07-09)
--
-- geo_drops.proof_config can declare a `secret`-method requirement
-- (params.secret, checked client-side by verification.ts's pluggable
-- engine). That verifier only runs on the dev-only client-side unlock
-- path. The production path (supabase/functions/unlock-drop) never
-- checked it — a drop configured to require a secret could be unlocked
-- by anyone within GPS radius, without ever supplying the secret.
--
-- Fix: secrets are hashed (PBKDF2-SHA256, same format as password_hash)
-- into a new server-only column at createDrop() time, and stripped from
-- the client-readable proof_config. unlock-drop now verifies every
-- requirement server-side and fails closed on unsupported methods.
--
-- This column follows the same pattern as encryption_salt/password_hash/
-- encrypted_content: present in the base table, withheld from the
-- authenticated/anon column GRANT, accessible only via service_role.
-- =====================================================================

alter table geo_drops add column if not exists proof_secret_hashes jsonb;
comment on column geo_drops.proof_secret_hashes is
  'Server-only: PBKDF2-SHA256 hashes of secret-method proof requirements, keyed by requirement index. Never exposed to authenticated/anon roles. See unlock-drop Edge Function.';

-- Re-grant the same public column list as the 20260706000013 migration —
-- proof_secret_hashes is deliberately excluded (withheld by omission, the
-- fail-safe default documented in that migration).
revoke select on geo_drops from authenticated;
revoke select on geo_drops from anon;

grant select (
  id, creator_id,
  lat, lon, geohash, unlock_radius_meters,
  title, description, content_type, ipfs_cid, encrypted,
  visibility, max_claims, claim_count, proof_config,
  expires_at, status,
  preview_url, metadata,
  persistence_level, metadata_cid, chain_tx_hash,
  created_at, updated_at
) on geo_drops to authenticated;

grant select (
  id, creator_id,
  lat, lon, geohash, unlock_radius_meters,
  title, description, content_type, ipfs_cid, encrypted,
  visibility, max_claims, claim_count, proof_config,
  expires_at, status,
  preview_url, metadata,
  persistence_level, metadata_cid, chain_tx_hash,
  created_at, updated_at
) on geo_drops to anon;

-- Withheld (never exposed to client roles):
--   encrypted_content, encryption_salt, password_hash, search_tokens,
--   pin_status, key_derivation_version, encryption_algorithm,
--   server_secret_version, proof_secret_hashes.

-- ---------------------------------------------------------------------
-- Extend the existing sensitive-column-protection trigger (defense in
-- depth alongside the column GRANT above) to also block client updates
-- to proof_secret_hashes.
-- ---------------------------------------------------------------------
create or replace function protect_drop_sensitive_columns()
returns trigger as $$
begin
  if NEW.creator_id is distinct from OLD.creator_id then
    raise exception 'Cannot modify creator_id';
  end if;
  if NEW.encryption_salt is distinct from OLD.encryption_salt then
    raise exception 'Cannot modify encryption_salt';
  end if;
  if NEW.geohash is distinct from OLD.geohash then
    raise exception 'Cannot modify geohash';
  end if;
  -- Write-once: allow the one-time backfill (NULL -> value, e.g. via
  -- scripts/migrate-proof-secrets.mjs) but block modifying an
  -- already-set value.
  if OLD.proof_secret_hashes is not null
     and NEW.proof_secret_hashes is distinct from OLD.proof_secret_hashes then
    raise exception 'Cannot modify proof_secret_hashes once set';
  end if;
  return NEW;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- migration: 20260709000015_persistent_rate_limit.sql
-- ---------------------------------------------------------------------
-- =====================================================================
-- Persistent rate limiting (2026-07-09)
--
-- unlock-drop's rate limiter was an in-memory Map, scoped to a single
-- Edge Function instance. Deno Deploy runs multiple instances and recycles
-- them on cold start, so the limit resets constantly and is trivially
-- bypassed by traffic landing on a fresh instance. This moves the
-- authoritative check into Postgres (shared across every instance/fn),
-- using the same "lock the row, check-then-update in one statement"
-- pattern as increment_claim_count.
--
-- Table is shared across Edge Functions — bucket_key is namespaced
-- '{function_name}:{identity}' so unlock-drop, ipfs-proxy, etc. can all
-- use the same table/function without colliding.
-- =====================================================================

create table if not exists edge_rate_limits (
  bucket_key   text primary key,
  window_start timestamptz not null,
  count        integer not null
);

-- Atomic check-and-increment: single UPSERT under the row's implicit lock,
-- so concurrent requests for the same bucket_key cannot race past the
-- limit (unlike separate SELECT-then-UPDATE).
create or replace function check_rate_limit(
  p_key text,
  p_max integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
as $$
declare
  v_count integer;
begin
  insert into edge_rate_limits (bucket_key, window_start, count)
  values (p_key, now(), 1)
  on conflict (bucket_key) do update
    set window_start = case
          when edge_rate_limits.window_start <= now() - make_interval(secs => p_window_seconds)
          then now()
          else edge_rate_limits.window_start
        end,
        count = case
          when edge_rate_limits.window_start <= now() - make_interval(secs => p_window_seconds)
          then 1
          else edge_rate_limits.count + 1
        end
  returning count into v_count;

  return v_count <= p_max;
end;
$$;

-- Only service_role (Edge Functions) may call this — it takes an
-- arbitrary caller-supplied key, so granting it to authenticated/anon
-- would let a client fabricate/collide other users' buckets.
revoke all on function check_rate_limit(text, integer, integer) from public;
grant execute on function check_rate_limit(text, integer, integer) to service_role;

revoke all on edge_rate_limits from public, authenticated, anon;

-- Opportunistic cleanup: called at low probability from the Edge Function
-- hot path (see unlock-drop/index.ts) instead of requiring pg_cron, which
-- may not be available on every Supabase plan.
create or replace function cleanup_stale_rate_limits(p_older_than_seconds integer default 3600)
returns void
language sql
security definer
as $$
  delete from edge_rate_limits
  where window_start < now() - make_interval(secs => p_older_than_seconds);
$$;

revoke all on function cleanup_stale_rate_limits(integer) from public;
grant execute on function cleanup_stale_rate_limits(integer) to service_role;

-- ---------------------------------------------------------------------
-- migration: 20260709000016_realtime_rls_healthcheck.sql
-- ---------------------------------------------------------------------
-- =====================================================================
-- Realtime RLS self-diagnosis (2026-07-09)
--
-- Migration 20240101000007_realtime_rls.sql already restricts the
-- supabase_realtime publication to an explicit table list, which is the
-- part SQL can enforce. It cannot enforce the other half: hosted Supabase
-- projects also require "Realtime RLS" to be toggled on in
-- Dashboard > Database > Replication — that setting lives in the Realtime
-- service's own config, outside anything pg_catalog can see, so no SQL
-- function can fully self-certify it.
--
-- What THIS migration adds is the part that IS observable from Postgres:
-- a healthcheck that detects publication-membership regressions (e.g. a
-- future migration that does `create publication supabase_realtime for
-- all tables`, silently re-exposing every table). Pair with
-- scripts/check-realtime-rls.mjs, which is the only thing that can
-- actually verify the Dashboard toggle (it does a live cross-user
-- subscribe-and-assert against a running project).
-- =====================================================================

create or replace function realtime_publication_healthcheck()
returns jsonb
language plpgsql
security definer
as $$
declare
  expected text[] := array['locations_current', 'friend_requests', 'messages', 'location_reactions', 'geo_drops'];
  actual text[];
  unexpected text[];
  missing text[];
  publication_exists boolean;
begin
  select exists(select 1 from pg_publication where pubname = 'supabase_realtime') into publication_exists;

  if not publication_exists then
    return jsonb_build_object(
      'ok', false,
      'error', 'supabase_realtime publication does not exist',
      'expected_tables', to_jsonb(expected)
    );
  end if;

  select coalesce(array_agg(tablename order by tablename), array[]::text[])
  into actual
  from pg_publication_tables
  where pubname = 'supabase_realtime';

  select coalesce(array_agg(t), array[]::text[]) into unexpected
  from unnest(actual) t where t != all(expected);

  select coalesce(array_agg(t), array[]::text[]) into missing
  from unnest(expected) t where t != all(actual);

  return jsonb_build_object(
    'ok', array_length(unexpected, 1) is null and array_length(missing, 1) is null,
    'expected_tables', to_jsonb(expected),
    'actual_tables', to_jsonb(actual),
    'unexpected_tables', to_jsonb(unexpected),
    'missing_tables', to_jsonb(missing),
    'note', 'This only checks publication membership. It CANNOT verify the hosted-Supabase "Realtime RLS" Dashboard toggle — run scripts/check-realtime-rls.mjs against a live deploy for that.'
  );
end;
$$;

-- Callable by service_role for ops/CI checks (post-deploy scripts), and by
-- authenticated so it can be wired into an admin-only health endpoint if
-- desired — it reveals no user data, only publication table names.
revoke all on function realtime_publication_healthcheck() from public;
grant execute on function realtime_publication_healthcheck() to service_role, authenticated;

-- ---------------------------------------------------------------------
-- migration: 20260709000017_sbpp_session_persistence.sql
-- ---------------------------------------------------------------------
-- =====================================================================
-- SBPP search-session persistence (2026-07-09)
--
-- search_sessions (packages/geo-drop/database/sbpp_schema.sql) has existed
-- since SBPP was added, but no application code ever used it — the SDK's
-- SbppSessionStore (packages/geo-drop/src/sbpp.ts) is an in-memory Map,
-- explicitly documented "for evaluation". That in-memory store correctly
-- implements atomic validate-and-consume (single-use nonces), but only
-- within one process; a self-hosted SBPP deployment running multiple
-- instances (or restarting) would lose sessions and, more importantly,
-- lose the single-use guarantee across instances.
--
-- This wires the existing table up via two SECURITY DEFINER functions,
-- following the same atomic-single-statement pattern as
-- increment_claim_count / check_rate_limit, for deployments that need a
-- persistent, multi-instance-safe session store.
--
-- Also fixes a latent issue in the table's own RLS: the existing
-- `search_sessions_own` policy is FOR ALL, which lets an authenticated
-- client INSERT a session row directly with a SELF-CHOSEN nonce. The
-- entire security property of a "server-issued nonce" is that the server
-- picks it — a client-choosable nonce defeats the anti-replay binding.
-- Since nothing used this table yet, nothing depended on client-side
-- INSERT, so this tightens it to SELECT-only before anything does.
-- =====================================================================

-- The table itself was only ever created by sbpp_schema.sql, never by a
-- migration; create it here so a migration-only deploy does not abort.
create table if not exists search_sessions (
  session_id  text primary key,
  nonce       text not null,
  user_id     uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  constraint search_sessions_nonce_unique unique (nonce)
);
create index if not exists idx_search_sessions_user
  on search_sessions(user_id, created_at desc);
create index if not exists idx_search_sessions_expires
  on search_sessions(expires_at)
  where consumed_at is null;
alter table search_sessions enable row level security;

drop policy if exists search_sessions_own on search_sessions;

create policy search_sessions_select_own on search_sessions
  for select using (auth.uid() = user_id);
-- No client INSERT/UPDATE/DELETE policy: all writes go through the
-- SECURITY DEFINER functions below, which run as the function owner and
-- so bypass RLS for their own writes while still enforcing auth.uid().

create or replace function issue_search_session(p_ttl_seconds integer default 300)
returns table (session_id text, nonce text, expires_at timestamptz)
language plpgsql
security definer
as $$
declare
  v_session_id text;
  v_nonce text;
  v_expires_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  v_session_id := encode(gen_random_bytes(16), 'hex');
  v_nonce := encode(gen_random_bytes(32), 'hex');
  v_expires_at := now() + make_interval(secs => greatest(1, p_ttl_seconds));

  insert into search_sessions (session_id, nonce, user_id, expires_at)
  values (v_session_id, v_nonce, auth.uid(), v_expires_at);

  return query select v_session_id, v_nonce, v_expires_at;
end;
$$;

-- Atomic validate-and-consume: single UPDATE with all conditions in the
-- WHERE clause, so concurrent callers can't both observe "not yet
-- consumed" before either writes (the TOCTOU race consumeIfValid's
-- in-memory version avoids via a single-threaded Map).
create or replace function consume_search_session(p_session_id text, p_nonce text)
returns boolean
language plpgsql
security definer
as $$
declare
  v_updated integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update search_sessions
  set consumed_at = now()
  where session_id = p_session_id
    and nonce = p_nonce
    and user_id = auth.uid()
    and consumed_at is null
    and expires_at > now();

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function issue_search_session(integer) from public;
revoke all on function consume_search_session(text, text) from public;
grant execute on function issue_search_session(integer) to authenticated;
grant execute on function consume_search_session(text, text) to authenticated;

-- Opportunistic cleanup, same low-probability-call pattern as
-- cleanup_stale_rate_limits (no pg_cron dependency).
create or replace function cleanup_expired_search_sessions()
returns void
language sql
security definer
as $$
  delete from search_sessions where expires_at < now() - interval '1 hour';
$$;
revoke all on function cleanup_expired_search_sessions() from public;
grant execute on function cleanup_expired_search_sessions() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- migration: 20260722000013_geodrop_encryption_metadata.sql
-- ---------------------------------------------------------------------
-- Add versioned encryption metadata used by @zairn/geo-drop.
alter table geo_drops
  add column if not exists key_derivation_version smallint not null default 1;

alter table geo_drops
  add column if not exists encryption_algorithm text not null default 'aes-256-gcm';

alter table geo_drops
  add column if not exists server_secret_version smallint not null default 1;

comment on column geo_drops.key_derivation_version is
  'Key derivation format version. 1=v1 (geodrop:...), 2=v2 (length-prefixed). Required for decryption.';

comment on column geo_drops.encryption_algorithm is
  'Encryption algorithm identifier. Currently aes-256-gcm. Stored for future migration to post-quantum algorithms.';

comment on column geo_drops.server_secret_version is
  'Version of GEODROP_ENCRYPTION_SECRET used to encrypt this drop. Enables secret rotation without re-encrypting old drops.';

-- ---------------------------------------------------------------------
-- migration: 20261014000017_reconcile_production_drift.sql
-- ---------------------------------------------------------------------
-- Reconcile databases created from early versions of migrations 0001–0012.
--
-- Migrations 0001–0012 were edited in place after the first deployment
-- applied them, so that deployment never received the later definitions
-- (security fixes, helper functions, triggers, constraints). Migration
-- 20261014000018 then failed on it ("function enforce_ghost_mode() does not
-- exist"). This file re-asserts the current definitions. Every statement is
-- idempotent: on a database built from the current migrations it changes
-- nothing (verified by dumping both and diffing).
--
-- It also fixes a defect present in every database built from these
-- migrations: the geo_drops ⇄ drop_shares policies referenced each other, so
-- any non-owner SELECT on geo_drops, drop_shares or drop_claims failed with
-- "infinite recursion detected in policy". The cycle is now broken through
-- two SECURITY DEFINER helpers that only answer for the calling user.
--
-- RLS impact (on an early-version database):
--   * dropped: share_rules_insert_for_friends (a friend could create share
--     rules on the owner's behalf), groups_read_by_invite (every group with an
--     invite code, including the code, was readable), profiles_read_public
--     (profiles readable without signing in)
--   * replaced: group/chat membership policies that allowed reading every
--     room and membership and joining any chat room; friend-request,
--     reaction, bump, location-history and visited-cell policies now match the
--     current definitions
--   * rows of locations_current / locations_history / share_rules that point
--     at deleted accounts are removed before the missing ON DELETE CASCADE
--     foreign keys are added (the cascade would have removed them)

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.locations_current add column if not exists heading real;
alter table public.locations_current add column if not exists altitude real;

-- ---------------------------------------------------------------------
-- 2. Constraints (orphaned rows of deleted accounts first)
-- ---------------------------------------------------------------------
delete from public.locations_current t where not exists (select 1 from auth.users u where u.id = t.user_id);
delete from public.locations_history t where not exists (select 1 from auth.users u where u.id = t.user_id);
delete from public.share_rules t where not exists (select 1 from auth.users u where u.id = t.owner_id)
   or not exists (select 1 from auth.users u where u.id = t.viewer_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.locations_current'::regclass and conname = 'locations_current_user_id_fkey') then
    alter table public.locations_current add constraint locations_current_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.share_rules'::regclass and conname = 'share_rules_owner_id_fkey') then
    alter table public.share_rules add constraint share_rules_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.share_rules'::regclass and conname = 'share_rules_viewer_id_fkey') then
    alter table public.share_rules add constraint share_rules_viewer_id_fkey FOREIGN KEY (viewer_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.locations_history'::regclass and conname = 'locations_history_user_id_fkey') then
    alter table public.locations_history add constraint locations_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.friend_requests'::regclass and conname = 'friend_requests_check') then
    alter table public.friend_requests add constraint friend_requests_check CHECK ((from_user_id <> to_user_id));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.group_members'::regclass and conname = 'group_members_role_check') then
    alter table public.group_members add constraint group_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text, 'admin'::text])));
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.blocked_users'::regclass and conname = 'blocked_users_check') then
    alter table public.blocked_users add constraint blocked_users_check CHECK ((blocker_id <> blocked_id));
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_share_rules_viewer ON public.share_rules USING btree (viewer_id);
CREATE INDEX IF NOT EXISTS idx_chat_rooms_group ON public.chat_rooms USING btree (group_id);

-- ---------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_expired_drops()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  update geo_drops
  set status = 'expired', updated_at = now()
  where status = 'active'
    and expires_at is not null
    and expires_at <= now();
end;
$function$;

CREATE OR REPLACE FUNCTION public.decrement_claim_count(p_drop_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform set_config('app.claim_count_update', 'true', true);
  update geo_drops
  set claim_count = greatest(claim_count - 1, 0), updated_at = now()
  where id = p_drop_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.protect_claim_count()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Allow if called from increment_claim_count (session variable set by that function)
  -- or if claim_count hasn't changed
  if NEW.claim_count != OLD.claim_count then
    -- Only allow if called from increment/decrement_claim_count (session flag)
    if coalesce(current_setting('app.claim_count_update', true), '') != 'true' then
      NEW.claim_count := OLD.claim_count; -- silently reset to old value
    end if;
  end if;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.remove_friend(p_friend_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  -- Delete friend request
  delete from friend_requests
  where status = 'accepted'
    and ((from_user_id = v_user_id and to_user_id = p_friend_id)
      or (from_user_id = p_friend_id and to_user_id = v_user_id));

  -- Delete both directions of share rules
  delete from share_rules
  where (owner_id = v_user_id and viewer_id = p_friend_id)
     or (owner_id = p_friend_id and viewer_id = v_user_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.accept_friend_request(p_request_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_from_user_id uuid;
  v_to_user_id uuid;
begin
  -- 呼び出し元が to_user_id であることを確認
  update friend_requests
  set status = 'accepted', updated_at = now()
  where id = p_request_id
    and to_user_id = auth.uid()
    and status = 'pending'
  returning from_user_id, to_user_id into v_from_user_id, v_to_user_id;

  if v_from_user_id is null then
    raise exception 'Friend request not found or not authorized';
  end if;

  -- 双方向の共有ルールを作成（history レベル）
  insert into share_rules (owner_id, viewer_id, level)
  values
    (v_from_user_id, v_to_user_id, 'history'),
    (v_to_user_id, v_from_user_id, 'history')
  on conflict (owner_id, viewer_id) do update set level = 'history';
end;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_ghost_mode()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if exists (
    select 1 from user_settings
    where user_id = NEW.user_id
      and ghost_mode = true
      and (ghost_until is null or ghost_until > now())
  ) then
    raise exception 'Location update blocked: ghost mode is active';
  end if;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_group_atomic(p_name text, p_description text, p_invite_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_group_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into groups (name, description, owner_id, invite_code)
  values (p_name, p_description, auth.uid(), p_invite_code)
  returning id into v_group_id;

  insert into group_members (group_id, user_id, role)
  values (v_group_id, auth.uid(), 'owner');

  return v_group_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.leave_group(p_group_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_owner_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  select owner_id into v_owner_id from groups where id = p_group_id;
  if v_owner_id is null then
    raise exception 'Group not found';
  end if;
  if v_owner_id = v_user_id then
    raise exception 'Group owner cannot leave. Delete the group or transfer ownership first.';
  end if;
  delete from group_members where group_id = p_group_id and user_id = v_user_id;
  if not found then
    raise exception 'Not a member of this group';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.block_user_atomic(p_blocked_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if v_user_id = p_blocked_id then
    raise exception 'Cannot block yourself';
  end if;

  insert into blocked_users (blocker_id, blocked_id)
  values (v_user_id, p_blocked_id)
  on conflict do nothing;

  -- フレンド関係も解除
  delete from friend_requests
  where status = 'accepted'
    and ((from_user_id = v_user_id and to_user_id = p_blocked_id)
      or (from_user_id = p_blocked_id and to_user_id = v_user_id));

  -- 共有ルールも削除
  delete from share_rules
  where (owner_id = v_user_id and viewer_id = p_blocked_id)
     or (owner_id = p_blocked_id and viewer_id = v_user_id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select exists (
    select 1 from group_members
    where group_id = p_group_id and user_id = p_user_id
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_chat_room_member(p_room_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
  select exists (
    select 1 from chat_room_members
    where room_id = p_room_id and user_id = p_user_id
  );
$function$;

CREATE OR REPLACE FUNCTION public.protect_friend_request_ids()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if NEW.from_user_id != OLD.from_user_id then
    raise exception 'Cannot change from_user_id';
  end if;
  if NEW.to_user_id != OLD.to_user_id then
    raise exception 'Cannot change to_user_id';
  end if;
  -- accepted状態からのステータス変更は security definer (remove_friend) 経由のみ
  if OLD.status = 'accepted' and NEW.status != 'accepted' then
    raise exception 'Cannot change status of accepted friend request directly';
  end if;
  -- rejected状態からpendingへの巻き戻しを防止
  if OLD.status = 'rejected' and NEW.status = 'pending' then
    raise exception 'Cannot reactivate a rejected friend request';
  end if;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_expired_share_rules()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  delete from share_rules
  where expires_at is not null and expires_at <= now();
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_interaction(p_user_id uuid, p_friend_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_last_date date;
  v_streak integer;
  v_longest integer;
begin
  -- Only allow recording interactions for the authenticated user
  if auth.uid() is null or auth.uid() != p_user_id then
    raise exception 'Can only record interactions for yourself';
  end if;

  -- Verify users are friends
  if not exists (
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user_id = p_user_id and to_user_id = p_friend_id)
        or (to_user_id = p_user_id and from_user_id = p_friend_id))
  ) then
    raise exception 'Users are not friends';
  end if;

  select last_interaction_date, current_streak, longest_streak
  into v_last_date, v_streak, v_longest
  from friend_streaks
  where user_id = p_user_id and friend_id = p_friend_id
  for update;

  if not found then
    insert into friend_streaks (user_id, friend_id, current_streak, longest_streak, last_interaction_date)
    values (p_user_id, p_friend_id, 1, 1, current_date);
    return;
  end if;

  if v_last_date = current_date then return; end if;

  if v_last_date = current_date - 1 then
    v_streak := v_streak + 1;
  else
    v_streak := 1;
  end if;

  v_longest := greatest(v_longest, v_streak);

  update friend_streaks
  set current_streak = v_streak, longest_streak = v_longest,
      last_interaction_date = current_date, updated_at = now()
  where user_id = p_user_id and friend_id = p_friend_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_friends_of_friends(current_user_id uuid)
 RETURNS TABLE(user_id uuid, mutual_friend_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if auth.uid() is null or auth.uid() != current_user_id then
    raise exception 'Can only query own friends-of-friends';
  end if;

  return query
  with my_friends as (
    select case when fr.from_user_id = current_user_id then fr.to_user_id else fr.from_user_id end as friend_id
    from friend_requests fr
    where fr.status = 'accepted'
      and (fr.from_user_id = current_user_id or fr.to_user_id = current_user_id)
  ),
  fof as (
    select case when fr2.from_user_id = mf.friend_id then fr2.to_user_id else fr2.from_user_id end as fof_id,
           mf.friend_id as via_friend_id
    from friend_requests fr2
    join my_friends mf on (fr2.from_user_id = mf.friend_id or fr2.to_user_id = mf.friend_id)
    where fr2.status = 'accepted'
  )
  select fof.fof_id as user_id, fof.via_friend_id as mutual_friend_id
  from fof
  where fof.fof_id != current_user_id
    and fof.fof_id not in (select mf2.friend_id from my_friends mf2);
end;
$function$;

drop function if exists public.increment_claim_count(uuid);
CREATE OR REPLACE FUNCTION public.increment_claim_count(p_drop_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_max_claims integer;
  v_claim_count integer;
  updated_rows integer;
begin
  -- Require authentication
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Lock the drop row to prevent TOCTOU race condition
  select max_claims, claim_count into v_max_claims, v_claim_count
  from geo_drops
  where id = p_drop_id
  for update;

  if not found then
    raise exception 'Drop not found';
  end if;

  -- Check max claims under lock
  if v_max_claims is not null and v_claim_count >= v_max_claims then
    return false;
  end if;

  -- Prevent double-claim (checked under the row lock)
  if exists (select 1 from drop_claims where drop_id = p_drop_id and user_id = auth.uid()) then
    raise exception 'Already claimed';
  end if;

  -- Set session flag so protect_claim_count trigger allows the change
  perform set_config('app.claim_count_update', 'true', true);
  update geo_drops
  set claim_count = claim_count + 1, updated_at = now()
  where id = p_drop_id;
  get diagnostics updated_rows = row_count;
  return updated_rows > 0;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_area_rankings(area_prefix text, result_limit integer DEFAULT 20)
 RETURNS TABLE(user_id uuid, cell_count bigint, rank bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  -- Validate geohash prefix (only base32 chars, prevent LIKE injection)
  if area_prefix !~ '^[0-9bcdefghjkmnpqrstuvwxyz]+$' then
    raise exception 'Invalid geohash prefix';
  end if;

  -- 短すぎるprefixは大量行スキャンを引き起こすため拒否
  if length(area_prefix) < 2 then
    raise exception 'Geohash prefix too short (min 2 characters)';
  end if;

  return query
  select
    v.user_id,
    count(*) as cell_count,
    rank() over (order by count(*) desc) as rank
  from visited_cells v
  where v.geohash like area_prefix || '%'
    and (
      v.user_id = auth.uid()
      or exists (
        select 1 from friend_requests fr
        where fr.status = 'accepted'
          and ((fr.from_user_id = auth.uid() and fr.to_user_id = v.user_id)
            or (fr.to_user_id = auth.uid() and fr.from_user_id = v.user_id))
      )
    )
  group by v.user_id
  order by cell_count desc
  limit result_limit;
end;
$function$;

CREATE OR REPLACE FUNCTION public.encode_geohash(lat double precision, lon double precision, precision_len integer DEFAULT 7)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  base32 text := '0123456789bcdefghjkmnpqrstuvwxyz';
  min_lat double precision := -90;
  max_lat double precision := 90;
  min_lon double precision := -180;
  max_lon double precision := 180;
  mid double precision;
  bits integer := 0;
  hash_val integer := 0;
  is_lon boolean := true;
  result text := '';
begin
  precision_len := least(precision_len, 12);
  while length(result) < precision_len loop
    if is_lon then
      mid := (min_lon + max_lon) / 2;
      if lon >= mid then
        hash_val := hash_val * 2 + 1;
        min_lon := mid;
      else
        hash_val := hash_val * 2;
        max_lon := mid;
      end if;
    else
      mid := (min_lat + max_lat) / 2;
      if lat >= mid then
        hash_val := hash_val * 2 + 1;
        min_lat := mid;
      else
        hash_val := hash_val * 2;
        max_lat := mid;
      end if;
    end if;
    is_lon := not is_lon;
    bits := bits + 1;
    if bits = 5 then
      result := result || substr(base32, hash_val + 1, 1);
      bits := 0;
      hash_val := 0;
    end if;
  end loop;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_visited_cell()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  gh text;
begin
  gh := encode_geohash(NEW.lat, NEW.lon, 7);
  insert into visited_cells (user_id, geohash, first_visited_at, last_visited_at, visit_count)
  values (NEW.user_id, gh, now(), now(), 1)
  on conflict (user_id, geohash) do update
  set last_visited_at = now(), visit_count = visited_cells.visit_count + 1;
  return NEW;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_direct_chat(p_other_user_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_room_id uuid;
begin
  -- ブロックチェック
  if exists (
    select 1 from blocked_users
    where (blocker_id = v_user_id and blocked_id = p_other_user_id)
       or (blocker_id = p_other_user_id and blocked_id = v_user_id)
  ) then
    raise exception 'Cannot create chat with blocked user';
  end if;

  -- フレンドチェック
  if not exists (
    select 1 from friend_requests
    where status = 'accepted'
      and ((from_user_id = v_user_id and to_user_id = p_other_user_id)
        or (to_user_id = v_user_id and from_user_id = p_other_user_id))
  ) then
    raise exception 'Users are not friends';
  end if;

  -- Advisory lock to prevent concurrent duplicate DM room creation
  -- Use a deterministic lock key from both user IDs (order-independent)
  perform pg_advisory_xact_lock(
    hashtext(least(v_user_id::text, p_other_user_id::text) || ':' || greatest(v_user_id::text, p_other_user_id::text))
  );

  -- 既存のDMルームを検索
  select cm1.room_id into v_room_id
  from chat_room_members cm1
  join chat_room_members cm2 on cm1.room_id = cm2.room_id
  join chat_rooms cr on cr.id = cm1.room_id
  where cm1.user_id = v_user_id
    and cm2.user_id = p_other_user_id
    and cr.type = 'direct'
  limit 1;

  if v_room_id is not null then
    return v_room_id;
  end if;

  -- 新規ルーム作成 + 両メンバー追加をアトミックに実行
  insert into chat_rooms (type) values ('direct')
  returning id into v_room_id;

  insert into chat_room_members (room_id, user_id)
  values (v_room_id, v_user_id), (v_room_id, p_other_user_id);

  return v_room_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_group_chat(p_group_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_room_id uuid;
begin
  -- メンバーチェック
  if not exists (
    select 1 from group_members
    where group_id = p_group_id and user_id = auth.uid()
  ) then
    raise exception 'Not a member of this group';
  end if;

  -- Advisory lock to prevent concurrent duplicate group chat creation
  perform pg_advisory_xact_lock(hashtext('group_chat:' || p_group_id::text));

  -- 既存のグループチャットルームを検索
  select id into v_room_id
  from chat_rooms
  where group_id = p_group_id and type = 'group'
  limit 1;

  if v_room_id is not null then
    return v_room_id;
  end if;

  -- 新規ルーム作成
  insert into chat_rooms (type, group_id) values ('group', p_group_id)
  returning id into v_room_id;

  return v_room_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.join_group_by_invite(p_invite_code text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  v_group_id uuid;
begin
  select id into v_group_id from groups where invite_code = p_invite_code;
  if v_group_id is null then
    raise exception 'Invalid invite code';
  end if;

  -- ブロックチェック（グループオーナーがブロックしている場合は参加不可）
  if exists (
    select 1 from blocked_users bu
    join groups g on g.id = v_group_id
    where (bu.blocker_id = g.owner_id and bu.blocked_id = auth.uid())
       or (bu.blocker_id = auth.uid() and bu.blocked_id = g.owner_id)
  ) then
    raise exception 'Cannot join this group';
  end if;

  -- 既にメンバーなら何もしない
  if exists (select 1 from group_members where group_id = v_group_id and user_id = auth.uid()) then
    return v_group_id;
  end if;

  insert into group_members (group_id, user_id, role, joined_at)
  values (v_group_id, auth.uid(), 'member', now());

  return v_group_id;
end;
$function$;

-- ---------------------------------------------------------------------
-- 5. Triggers
-- ---------------------------------------------------------------------
drop trigger if exists trg_protect_friend_request_ids on public.friend_requests;
CREATE TRIGGER trg_protect_friend_request_ids BEFORE UPDATE ON public.friend_requests FOR EACH ROW EXECUTE FUNCTION public.protect_friend_request_ids();
drop trigger if exists trg_enforce_ghost_mode on public.locations_current;
CREATE TRIGGER trg_enforce_ghost_mode BEFORE INSERT OR UPDATE ON public.locations_current FOR EACH ROW EXECUTE FUNCTION public.enforce_ghost_mode();
drop trigger if exists trg_protect_claim_count on public.geo_drops;
CREATE TRIGGER trg_protect_claim_count BEFORE UPDATE ON public.geo_drops FOR EACH ROW EXECUTE FUNCTION public.protect_claim_count();
drop trigger if exists trg_protect_drop_sensitive_columns on public.geo_drops;
CREATE TRIGGER trg_protect_drop_sensitive_columns BEFORE UPDATE ON public.geo_drops FOR EACH ROW EXECUTE FUNCTION public.protect_drop_sensitive_columns();

-- ---------------------------------------------------------------------
-- 6. Policies
-- ---------------------------------------------------------------------
drop policy if exists groups_read_by_invite on public.groups;
drop policy if exists profiles_read_public on public.profiles;
drop policy if exists share_rules_insert_for_friends on public.share_rules;
drop policy if exists read_visible_locations on public.locations_current;
create policy read_visible_locations on public.locations_current as permissive for select to public
  using (((auth.uid() = user_id) OR ((EXISTS ( SELECT 1
   FROM public.share_rules
  WHERE ((share_rules.owner_id = locations_current.user_id) AND (share_rules.viewer_id = auth.uid()) AND (share_rules.level = ANY (ARRAY['current'::public.share_level, 'history'::public.share_level])) AND ((share_rules.expires_at IS NULL) OR (share_rules.expires_at > now()))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = locations_current.user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = locations_current.user_id)))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.user_settings
  WHERE ((user_settings.user_id = locations_current.user_id) AND (user_settings.ghost_mode = true) AND ((user_settings.ghost_until IS NULL) OR (user_settings.ghost_until > now())))))))));
drop policy if exists delete_own_location on public.locations_current;
create policy delete_own_location on public.locations_current as permissive for delete to public
  using ((auth.uid() = user_id));
drop policy if exists delete_own_history on public.locations_history;
create policy delete_own_history on public.locations_history as permissive for delete to public
  using ((auth.uid() = user_id));
drop policy if exists read_history_when_allowed on public.locations_history;
create policy read_history_when_allowed on public.locations_history as permissive for select to public
  using (((auth.uid() = user_id) OR ((EXISTS ( SELECT 1
   FROM public.share_rules
  WHERE ((share_rules.owner_id = locations_history.user_id) AND (share_rules.viewer_id = auth.uid()) AND (share_rules.level = 'history'::public.share_level) AND ((share_rules.expires_at IS NULL) OR (share_rules.expires_at > now()))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = locations_history.user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = locations_history.user_id)))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.user_settings
  WHERE ((user_settings.user_id = locations_history.user_id) AND (user_settings.ghost_mode = true) AND ((user_settings.ghost_until IS NULL) OR (user_settings.ghost_until > now())))))))));
drop policy if exists profiles_read_authenticated on public.profiles;
create policy profiles_read_authenticated on public.profiles as permissive for select to public
  using ((auth.uid() IS NOT NULL));
drop policy if exists friend_requests_insert on public.friend_requests;
create policy friend_requests_insert on public.friend_requests as permissive for insert to public
  with check (((auth.uid() = from_user_id) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = friend_requests.to_user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = friend_requests.to_user_id))))))));
drop policy if exists friend_requests_update on public.friend_requests;
create policy friend_requests_update on public.friend_requests as permissive for update to public
  using ((auth.uid() = to_user_id))
  with check (((auth.uid() = to_user_id) AND (status = 'rejected'::public.friend_request_status)));
drop policy if exists groups_read_member on public.groups;
create policy groups_read_member on public.groups as permissive for select to public
  using (((auth.uid() = owner_id) OR public.is_group_member(id, auth.uid())));
drop policy if exists group_members_select on public.group_members;
create policy group_members_select on public.group_members as permissive for select to public
  using (public.is_group_member(group_id, auth.uid()));
drop policy if exists group_members_insert on public.group_members;
create policy group_members_insert on public.group_members as permissive for insert to public
  with check (((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM public.groups g
  WHERE ((g.id = group_members.group_id) AND (g.owner_id = auth.uid()))))));
drop policy if exists chat_rooms_select on public.chat_rooms;
create policy chat_rooms_select on public.chat_rooms as permissive for select to public
  using ((public.is_chat_room_member(id, auth.uid()) OR ((type = 'group'::text) AND public.is_group_member(group_id, auth.uid()))));
drop policy if exists chat_rooms_insert on public.chat_rooms;
create policy chat_rooms_insert on public.chat_rooms as permissive for insert to public
  with check (false);
drop policy if exists chat_room_members_select on public.chat_room_members;
create policy chat_room_members_select on public.chat_room_members as permissive for select to public
  using (((user_id = auth.uid()) OR public.is_chat_room_member(room_id, auth.uid())));
drop policy if exists chat_room_members_insert on public.chat_room_members;
create policy chat_room_members_insert on public.chat_room_members as permissive for insert to public
  with check ((auth.uid() = user_id));
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages as permissive for select to public
  using (public.is_chat_room_member(room_id, auth.uid()));
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages as permissive for insert to public
  with check (((auth.uid() = sender_id) AND public.is_chat_room_member(room_id, auth.uid())));
drop policy if exists messages_update_own on public.messages;
create policy messages_update_own on public.messages as permissive for update to public
  using ((auth.uid() = sender_id))
  with check ((auth.uid() = sender_id));
drop policy if exists messages_delete_own on public.messages;
create policy messages_delete_own on public.messages as permissive for delete to public
  using ((auth.uid() = sender_id));
drop policy if exists location_reactions_insert on public.location_reactions;
create policy location_reactions_insert on public.location_reactions as permissive for insert to public
  with check (((auth.uid() = from_user_id) AND (EXISTS ( SELECT 1
   FROM public.friend_requests
  WHERE ((friend_requests.status = 'accepted'::public.friend_request_status) AND (((friend_requests.from_user_id = auth.uid()) AND (friend_requests.to_user_id = location_reactions.to_user_id)) OR ((friend_requests.to_user_id = auth.uid()) AND (friend_requests.from_user_id = location_reactions.to_user_id)))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = location_reactions.to_user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = location_reactions.to_user_id))))))));
drop policy if exists bump_events_insert on public.bump_events;
create policy bump_events_insert on public.bump_events as permissive for insert to public
  with check (((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM public.friend_requests
  WHERE ((friend_requests.status = 'accepted'::public.friend_request_status) AND (((friend_requests.from_user_id = auth.uid()) AND (friend_requests.to_user_id = bump_events.nearby_user_id)) OR ((friend_requests.to_user_id = auth.uid()) AND (friend_requests.from_user_id = bump_events.nearby_user_id)))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = bump_events.nearby_user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = bump_events.nearby_user_id))))))));
drop policy if exists favorite_places_select_friends on public.favorite_places;
create policy favorite_places_select_friends on public.favorite_places as permissive for select to public
  using (((EXISTS ( SELECT 1
   FROM public.share_rules
  WHERE ((share_rules.owner_id = favorite_places.user_id) AND (share_rules.viewer_id = auth.uid()) AND (share_rules.level = ANY (ARRAY['current'::public.share_level, 'history'::public.share_level])) AND ((share_rules.expires_at IS NULL) OR (share_rules.expires_at > now()))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = favorite_places.user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = favorite_places.user_id))))))));
drop policy if exists blocked_users_select_own on public.blocked_users;
create policy blocked_users_select_own on public.blocked_users as permissive for select to public
  using (((auth.uid() = blocker_id) OR (auth.uid() = blocked_id)));
drop policy if exists friend_streaks_select on public.friend_streaks;
create policy friend_streaks_select on public.friend_streaks as permissive for select to public
  using ((auth.uid() = user_id));
drop policy if exists visited_cells_select_friends on public.visited_cells;
create policy visited_cells_select_friends on public.visited_cells as permissive for select to public
  using (((EXISTS ( SELECT 1
   FROM public.friend_requests
  WHERE ((friend_requests.status = 'accepted'::public.friend_request_status) AND (((friend_requests.from_user_id = auth.uid()) AND (friend_requests.to_user_id = visited_cells.user_id)) OR ((friend_requests.to_user_id = auth.uid()) AND (friend_requests.from_user_id = visited_cells.user_id)))))) AND (NOT (EXISTS ( SELECT 1
   FROM public.blocked_users
  WHERE (((blocked_users.blocker_id = visited_cells.user_id) AND (blocked_users.blocked_id = auth.uid())) OR ((blocked_users.blocker_id = auth.uid()) AND (blocked_users.blocked_id = visited_cells.user_id))))))));
drop policy if exists visited_cells_update_own on public.visited_cells;
create policy visited_cells_update_own on public.visited_cells as permissive for update to public
  using ((auth.uid() = user_id))
  with check ((auth.uid() = user_id));
drop policy if exists geo_drops_select_friends on public.geo_drops;
create policy geo_drops_select_friends on public.geo_drops as permissive for select to public
  using (((visibility = 'friends'::public.drop_visibility) AND (status = 'active'::public.drop_status) AND ((expires_at IS NULL) OR (expires_at > now())) AND ((creator_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.friend_requests
  WHERE ((friend_requests.status = 'accepted'::public.friend_request_status) AND (((friend_requests.from_user_id = auth.uid()) AND (friend_requests.to_user_id = geo_drops.creator_id)) OR ((friend_requests.to_user_id = auth.uid()) AND (friend_requests.from_user_id = geo_drops.creator_id)))))))));
drop policy if exists geo_drops_update on public.geo_drops;
create policy geo_drops_update on public.geo_drops as permissive for update to public
  using ((auth.uid() = creator_id))
  with check ((auth.uid() = creator_id));
drop policy if exists drop_claims_insert on public.drop_claims;
create policy drop_claims_insert on public.drop_claims as permissive for insert to public
  with check (false);
-- ---------------------------------------------------------------------
-- 7. GeoDrop policy recursion. geo_drops (private) read drop_shares, whose
--    creator policies read geo_drops again. The helpers below run as the
--    owner, so the inner lookup skips RLS and the cycle is gone. They answer
--    only for the calling user, so they cannot be used to probe who created
--    or received a drop.
-- ---------------------------------------------------------------------
create or replace function public.is_drop_creator(p_drop_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(p_user_id = auth.uid(), false)
     and exists (select 1 from geo_drops where id = p_drop_id and creator_id = p_user_id);
$$;

create or replace function public.is_drop_shared_with(p_drop_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(p_user_id = auth.uid(), false)
     and exists (select 1 from drop_shares where drop_id = p_drop_id and user_id = p_user_id);
$$;

revoke all on function public.is_drop_creator(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.is_drop_shared_with(uuid, uuid) from public, anon, authenticated, service_role;
-- anon needs EXECUTE because these policies apply to every role.
grant execute on function public.is_drop_creator(uuid, uuid) to anon, authenticated, service_role;
grant execute on function public.is_drop_shared_with(uuid, uuid) to anon, authenticated, service_role;

drop policy if exists geo_drops_select_private_shared on public.geo_drops;
create policy geo_drops_select_private_shared on public.geo_drops
for select using (
  visibility = 'private'
  and status = 'active'
  and (expires_at is null or expires_at > now())
  and public.is_drop_shared_with(id, auth.uid())
);

drop policy if exists drop_shares_select_creator on public.drop_shares;
create policy drop_shares_select_creator on public.drop_shares
for select using (public.is_drop_creator(drop_id, auth.uid()));

drop policy if exists drop_shares_insert on public.drop_shares;
create policy drop_shares_insert on public.drop_shares
for insert with check (public.is_drop_creator(drop_id, auth.uid()));

drop policy if exists drop_shares_delete on public.drop_shares;
create policy drop_shares_delete on public.drop_shares
for delete using (public.is_drop_creator(drop_id, auth.uid()));

drop policy if exists drop_claims_select_creator on public.drop_claims;
create policy drop_claims_select_creator on public.drop_claims
for select using (public.is_drop_creator(drop_id, auth.uid()));

-- Early deployments also had is_friend(a, b), callable by anyone, which
-- disclosed whether any two users are friends. Nothing uses it any more.
drop function if exists public.is_friend(uuid, uuid);
-- ---------------------------------------------------------------------
-- 8. View options
-- ---------------------------------------------------------------------
alter view public.visited_cell_stats set (security_barrier = true);

-- ---------------------------------------------------------------------
-- 9. Realtime publication as 20240101000007 defines it. Only adds missing
--    tables; a FOR ALL TABLES publication is left alone. A publication this
--    role cannot alter is reported instead of failing the migration.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not (select puballtables from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['locations_current', 'friend_requests', 'messages', 'location_reactions', 'geo_drops'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
  alter publication supabase_realtime set (publish = 'insert, update, delete');
exception
  when insufficient_privilege then
    raise warning 'supabase_realtime publication not updated: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 10. Function privileges (as created by the current migrations)
-- ---------------------------------------------------------------------
revoke all on function public.decrement_claim_count(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.decrement_claim_count(uuid) to public;
grant EXECUTE on function public.decrement_claim_count(uuid) to anon;
grant EXECUTE on function public.decrement_claim_count(uuid) to authenticated;
grant EXECUTE on function public.decrement_claim_count(uuid) to service_role;
revoke all on function public.protect_claim_count() from public, anon, authenticated, service_role;
grant EXECUTE on function public.protect_claim_count() to public;
grant EXECUTE on function public.protect_claim_count() to anon;
grant EXECUTE on function public.protect_claim_count() to authenticated;
grant EXECUTE on function public.protect_claim_count() to service_role;
revoke all on function public.remove_friend(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.remove_friend(uuid) to public;
grant EXECUTE on function public.remove_friend(uuid) to anon;
grant EXECUTE on function public.remove_friend(uuid) to authenticated;
grant EXECUTE on function public.remove_friend(uuid) to service_role;
revoke all on function public.accept_friend_request(bigint) from public, anon, authenticated, service_role;
grant EXECUTE on function public.accept_friend_request(bigint) to public;
grant EXECUTE on function public.accept_friend_request(bigint) to anon;
grant EXECUTE on function public.accept_friend_request(bigint) to authenticated;
grant EXECUTE on function public.accept_friend_request(bigint) to service_role;
revoke all on function public.enforce_ghost_mode() from public, anon, authenticated, service_role;
grant EXECUTE on function public.enforce_ghost_mode() to public;
grant EXECUTE on function public.enforce_ghost_mode() to anon;
grant EXECUTE on function public.enforce_ghost_mode() to authenticated;
grant EXECUTE on function public.enforce_ghost_mode() to service_role;
revoke all on function public.create_group_atomic(text,text,text) from public, anon, authenticated, service_role;
grant EXECUTE on function public.create_group_atomic(text,text,text) to public;
grant EXECUTE on function public.create_group_atomic(text,text,text) to anon;
grant EXECUTE on function public.create_group_atomic(text,text,text) to authenticated;
grant EXECUTE on function public.create_group_atomic(text,text,text) to service_role;
revoke all on function public.leave_group(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.leave_group(uuid) to public;
grant EXECUTE on function public.leave_group(uuid) to anon;
grant EXECUTE on function public.leave_group(uuid) to authenticated;
grant EXECUTE on function public.leave_group(uuid) to service_role;
revoke all on function public.block_user_atomic(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.block_user_atomic(uuid) to public;
grant EXECUTE on function public.block_user_atomic(uuid) to anon;
grant EXECUTE on function public.block_user_atomic(uuid) to authenticated;
grant EXECUTE on function public.block_user_atomic(uuid) to service_role;
revoke all on function public.is_group_member(uuid,uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.is_group_member(uuid,uuid) to public;
grant EXECUTE on function public.is_group_member(uuid,uuid) to anon;
grant EXECUTE on function public.is_group_member(uuid,uuid) to authenticated;
grant EXECUTE on function public.is_group_member(uuid,uuid) to service_role;
revoke all on function public.is_chat_room_member(uuid,uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.is_chat_room_member(uuid,uuid) to public;
grant EXECUTE on function public.is_chat_room_member(uuid,uuid) to anon;
grant EXECUTE on function public.is_chat_room_member(uuid,uuid) to authenticated;
grant EXECUTE on function public.is_chat_room_member(uuid,uuid) to service_role;
revoke all on function public.protect_friend_request_ids() from public, anon, authenticated, service_role;
grant EXECUTE on function public.protect_friend_request_ids() to public;
grant EXECUTE on function public.protect_friend_request_ids() to anon;
grant EXECUTE on function public.protect_friend_request_ids() to authenticated;
grant EXECUTE on function public.protect_friend_request_ids() to service_role;
revoke all on function public.increment_claim_count(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.increment_claim_count(uuid) to public;
grant EXECUTE on function public.increment_claim_count(uuid) to anon;
grant EXECUTE on function public.increment_claim_count(uuid) to authenticated;
grant EXECUTE on function public.increment_claim_count(uuid) to service_role;
revoke all on function public.create_direct_chat(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.create_direct_chat(uuid) to public;
grant EXECUTE on function public.create_direct_chat(uuid) to anon;
grant EXECUTE on function public.create_direct_chat(uuid) to authenticated;
grant EXECUTE on function public.create_direct_chat(uuid) to service_role;
revoke all on function public.create_group_chat(uuid) from public, anon, authenticated, service_role;
grant EXECUTE on function public.create_group_chat(uuid) to public;
grant EXECUTE on function public.create_group_chat(uuid) to anon;
grant EXECUTE on function public.create_group_chat(uuid) to authenticated;
grant EXECUTE on function public.create_group_chat(uuid) to service_role;
revoke all on function public.join_group_by_invite(text) from public, anon, authenticated, service_role;
grant EXECUTE on function public.join_group_by_invite(text) to public;
grant EXECUTE on function public.join_group_by_invite(text) to anon;
grant EXECUTE on function public.join_group_by_invite(text) to authenticated;
grant EXECUTE on function public.join_group_by_invite(text) to service_role;

-- ---------------------------------------------------------------------
-- migration: 20261014000018_security_fixes.sql
-- ---------------------------------------------------------------------
-- =====================================================================
-- Security fixes from the 2026-10 audit. Regression tests:
-- test/db/rls-security.test.mjs (run with `pnpm test:db`).
--
-- RLS impact (summary):
--   * friend_requests: clients may only INSERT status='pending' and may no
--     longer DELETE accepted rows (use remove_friend(), which also removes
--     the share rules).
--   * locations_current / locations_history / visited_cells /
--     favorite_places: ghost mode is now enforced for viewers; visited
--     cells require an active 'history' share rule instead of friendship.
--   * chat_room_members: no direct client INSERT; UPDATE limited to
--     last_read_at. messages: UPDATE limited to content/metadata/updated_at.
--     Leaving (or being removed from) a group removes its chat membership.
--   * drop_location_logs: clients may only log 'create'/'search', and the
--     server sets created_at; 'unlock_attempt' rows are server-written.
--   * Claim counting moves to the service-role-only claim_drop().
--   * Rate-limit / maintenance functions are service-role only.
--   * Ports objects that previously existed only in database/*.sql (the CI
--     schema) and were therefore missing in migration-based deployments.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Private helper schema. Functions here are usable from RLS policies but
--    are not exposed through the REST API (only `public` is exposed).
-- ---------------------------------------------------------------------
create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;

create or replace function private.is_ghosted(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.user_settings
    where user_id = p_user_id
      and ghost_mode = true
      and (ghost_until is null or ghost_until > now())
  );
$$;
revoke all on function private.is_ghosted(uuid) from public;
grant execute on function private.is_ghosted(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. Friend requests. The INSERT policy never checked status, so a client
--    could insert a row that was already 'accepted' and pass every
--    friendship check (visited cells, friends-only drops, post feed, ...).
-- ---------------------------------------------------------------------
drop policy if exists friend_requests_insert on friend_requests;
create policy friend_requests_insert on friend_requests
for insert with check (
  auth.uid() = from_user_id
  and status = 'pending'
  and not exists (
    select 1 from blocked_users
    where (blocker_id = friend_requests.to_user_id and blocked_id = auth.uid())
       or (blocker_id = auth.uid() and blocked_id = friend_requests.to_user_id)
  )
);

-- Deleting an accepted row directly left both share rules in place, so the
-- other side kept location access after disappearing from the friend list.
drop policy if exists friend_requests_delete on friend_requests;
create policy friend_requests_delete on friend_requests
for delete using (
  (auth.uid() = from_user_id or auth.uid() = to_user_id)
  and status <> 'accepted'
);

-- ---------------------------------------------------------------------
-- 2. Ghost mode. The old policies checked user_settings in a subquery, but
--    RLS on user_settings only lets a viewer see their OWN row, so the
--    owner's ghost flag was never visible and ghost mode never hid anything.
-- ---------------------------------------------------------------------
drop policy if exists read_visible_locations on locations_current;
create policy read_visible_locations on locations_current
for select using (
  auth.uid() = user_id
  or (
    exists (
      select 1 from share_rules
      where owner_id = locations_current.user_id
        and viewer_id = auth.uid()
        and level in ('current', 'history')
        and (expires_at is null or expires_at > now())
    )
    and not exists (
      select 1 from blocked_users
      where (blocker_id = locations_current.user_id and blocked_id = auth.uid())
         or (blocker_id = auth.uid() and blocked_id = locations_current.user_id)
    )
    and not private.is_ghosted(locations_current.user_id)
  )
);

drop policy if exists read_history_when_allowed on locations_history;
create policy read_history_when_allowed on locations_history
for select using (
  auth.uid() = user_id
  or (
    exists (
      select 1 from share_rules
      where owner_id = locations_history.user_id
        and viewer_id = auth.uid()
        and level = 'history'
        and (expires_at is null or expires_at > now())
    )
    and not exists (
      select 1 from blocked_users
      where (blocker_id = locations_history.user_id and blocked_id = auth.uid())
         or (blocker_id = auth.uid() and blocked_id = locations_history.user_id)
    )
    and not private.is_ghosted(locations_history.user_id)
  )
);

-- Previously only in database/schema.sql: block history writes while ghosted.
create or replace trigger trg_enforce_ghost_mode_history
before insert on locations_history
for each row execute function enforce_ghost_mode();

drop policy if exists favorite_places_select_friends on favorite_places;
create policy favorite_places_select_friends on favorite_places
for select using (
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
  and not private.is_ghosted(favorite_places.user_id)
);

-- ---------------------------------------------------------------------
-- 3. Visited cells are updated on every location write (~150 m cells with
--    last_visited_at), i.e. they are location history. Friendship alone
--    exposed them even after sharing was set to none or revoked.
-- ---------------------------------------------------------------------
drop policy if exists visited_cells_select_friends on visited_cells;
create policy visited_cells_select_friends on visited_cells
for select using (
  exists (
    select 1 from share_rules
    where owner_id = visited_cells.user_id
      and viewer_id = auth.uid()
      and level = 'history'
      and (expires_at is null or expires_at > now())
  )
  and not exists (
    select 1 from blocked_users
    where (blocker_id = visited_cells.user_id and blocked_id = auth.uid())
       or (blocker_id = auth.uid() and blocked_id = visited_cells.user_id)
  )
  and not private.is_ghosted(visited_cells.user_id)
);

-- ---------------------------------------------------------------------
-- 4. Chat. chat_room_members INSERT only checked user_id, so anyone who
--    knew a room id could join it and read its history; UPDATE allowed
--    changing room_id. Rooms are populated by SECURITY DEFINER functions.
-- ---------------------------------------------------------------------
drop policy if exists chat_room_members_insert on chat_room_members;
create policy chat_room_members_insert on chat_room_members
for insert with check (false);

revoke update on chat_room_members from anon, authenticated;
grant update (last_read_at) on chat_room_members to authenticated;

revoke update on messages from anon, authenticated;
grant update (content, metadata, updated_at) on messages to authenticated;

-- leave_group() and owner removals deleted group_members only, so former
-- members kept reading the group chat.
create or replace function remove_group_chat_membership()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  delete from chat_room_members m
  using chat_rooms r
  where r.id = m.room_id
    and r.group_id = OLD.group_id
    and m.user_id = OLD.user_id;
  return OLD;
end;
$$;
revoke all on function remove_group_chat_membership() from public, anon, authenticated;

create or replace trigger trg_remove_group_chat_membership
after delete on group_members
for each row execute function remove_group_chat_membership();

-- Previously only in database/schema.sql.
create or replace function rate_limit_messages()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if exists (
    select 1 from messages
    where sender_id = NEW.sender_id
      and created_at > now() - interval '1 second'
  ) then
    raise exception 'Message rate limit exceeded';
  end if;
  return NEW;
end;
$$;
create or replace trigger trg_rate_limit_messages
before insert on messages
for each row execute function rate_limit_messages();

create or replace function rate_limit_location_update()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if TG_OP = 'UPDATE' and OLD.updated_at > now() - interval '1 second' then
    -- Silently skip (don't error — clients may retry)
    return OLD;
  end if;
  return NEW;
end;
$$;
create or replace trigger trg_rate_limit_location
before update on locations_current
for each row execute function rate_limit_location_update();

-- ---------------------------------------------------------------------
-- 5. drop_location_logs feed the server-side anti-spoofing gate. Clients
--    could insert any position with any created_at and pass the gate with
--    a fabricated trail. Clients keep 'create'/'search' logging; the gate
--    reads only server-written 'unlock_attempt' rows.
-- ---------------------------------------------------------------------
drop policy if exists drop_location_logs_insert on drop_location_logs;
create policy drop_location_logs_insert on drop_location_logs
for insert to authenticated
with check (auth.uid() = user_id and action in ('create', 'search'));

revoke insert, update, delete on drop_location_logs from anon;
revoke update, delete on drop_location_logs from authenticated;

create or replace function force_server_created_at()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  NEW.created_at := now();
  return NEW;
end;
$$;
create or replace trigger trg_drop_location_logs_server_time
before insert on drop_location_logs
for each row execute function force_server_created_at();

-- ---------------------------------------------------------------------
-- 6. Claims. increment/decrement_claim_count were executable by every
--    client: looping decrement reset max_claims, looping increment
--    exhausted any drop without claiming it. claim_drop() does the claim
--    insert and the count update atomically under a row lock.
-- ---------------------------------------------------------------------
revoke execute on function increment_claim_count(uuid) from public, anon, authenticated;
revoke execute on function decrement_claim_count(uuid) from public, anon, authenticated;
grant execute on function increment_claim_count(uuid) to service_role;
grant execute on function decrement_claim_count(uuid) to service_role;

create or replace function claim_drop(
  p_drop_id uuid,
  p_user_id uuid,
  p_lat double precision,
  p_lon double precision,
  p_distance_meters real,
  p_proof_results jsonb
)
returns table (claimed boolean, claim_id uuid, claimed_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_max_claims integer;
  v_claim_count integer;
  v_status drop_status;
  v_expires_at timestamptz;
  v_claim_id uuid;
  v_claimed_at timestamptz;
begin
  if p_user_id is null then
    raise exception 'User required';
  end if;

  select max_claims, claim_count, status, expires_at
    into v_max_claims, v_claim_count, v_status, v_expires_at
  from geo_drops
  where id = p_drop_id
  for update;

  if not found then
    raise exception 'Drop not found';
  end if;
  if v_status <> 'active' or (v_expires_at is not null and v_expires_at <= now()) then
    raise exception 'Drop is not available';
  end if;
  if exists (select 1 from drop_claims where drop_id = p_drop_id and user_id = p_user_id) then
    raise exception 'Already claimed' using errcode = 'unique_violation';
  end if;
  if v_max_claims is not null and v_claim_count >= v_max_claims then
    return query select false, null::uuid, null::timestamptz;
    return;
  end if;

  insert into drop_claims (drop_id, user_id, lat, lon, distance_meters, proof_results)
  values (p_drop_id, p_user_id, p_lat, p_lon, p_distance_meters, p_proof_results)
  returning id, drop_claims.claimed_at into v_claim_id, v_claimed_at;

  perform set_config('app.claim_count_update', 'true', true);
  update geo_drops
  set claim_count = claim_count + 1, updated_at = now()
  where id = p_drop_id;
  perform set_config('app.claim_count_update', 'false', true);

  return query select true, v_claim_id, v_claimed_at;
end;
$$;
revoke all on function claim_drop(uuid, uuid, double precision, double precision, real, jsonb)
  from public, anon, authenticated;
grant execute on function claim_drop(uuid, uuid, double precision, double precision, real, jsonb)
  to service_role;

-- ---------------------------------------------------------------------
-- 7. Rate-limit and maintenance functions. Earlier migrations revoked
--    EXECUTE only from PUBLIC, but Supabase grants it to anon and
--    authenticated directly, so clients could reset their own bucket,
--    wipe all buckets, or lock a victim out.
-- ---------------------------------------------------------------------
create or replace function check_rate_limit(p_key text, p_max integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_window integer := least(greatest(coalesce(p_window_seconds, 60), 1), 86400);
  v_count integer;
begin
  insert into edge_rate_limits (bucket_key, window_start, count)
  values (p_key, now(), 1)
  on conflict (bucket_key) do update
    set window_start = case
          when edge_rate_limits.window_start <= now() - make_interval(secs => v_window)
          then now()
          else edge_rate_limits.window_start
        end,
        count = case
          when edge_rate_limits.window_start <= now() - make_interval(secs => v_window)
          then 1
          else edge_rate_limits.count + 1
        end
  returning count into v_count;

  return v_count <= greatest(coalesce(p_max, 0), 0);
end;
$$;

create or replace function cleanup_stale_rate_limits(p_older_than_seconds integer default 3600)
returns void
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  delete from edge_rate_limits
  where window_start < now() - make_interval(secs => greatest(coalesce(p_older_than_seconds, 3600), 60));
$$;

alter table edge_rate_limits enable row level security;

revoke execute on function check_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke execute on function cleanup_stale_rate_limits(integer) from public, anon, authenticated;
revoke execute on function cleanup_expired_search_sessions() from public, anon, authenticated;
revoke execute on function realtime_publication_healthcheck() from public, anon, authenticated;
grant execute on function check_rate_limit(text, integer, integer) to service_role;
grant execute on function cleanup_stale_rate_limits(integer) to service_role;
grant execute on function cleanup_expired_search_sessions() to service_role;
grant execute on function realtime_publication_healthcheck() to service_role;

-- Search sessions: authenticated only, TTL bounded server-side.
create or replace function issue_search_session(p_ttl_seconds integer default 300)
returns table (session_id text, nonce text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_session_id text;
  v_nonce text;
  v_expires_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  v_session_id := encode(gen_random_bytes(16), 'hex');
  v_nonce := encode(gen_random_bytes(32), 'hex');
  v_expires_at := now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 300), 1), 600));

  insert into search_sessions (session_id, nonce, user_id, expires_at)
  values (v_session_id, v_nonce, auth.uid(), v_expires_at);

  return query select v_session_id, v_nonce, v_expires_at;
end;
$$;
revoke execute on function issue_search_session(integer) from public, anon;
revoke execute on function consume_search_session(text, text) from public, anon;
grant execute on function issue_search_session(integer) to authenticated, service_role;
grant execute on function consume_search_session(text, text) to authenticated, service_role;

-- Membership helpers are needed by RLS for authenticated users only.
revoke execute on function is_group_member(uuid, uuid) from public, anon;
revoke execute on function is_chat_room_member(uuid, uuid) from public, anon;
grant execute on function is_group_member(uuid, uuid) to authenticated, service_role;
grant execute on function is_chat_room_member(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. Objects that existed only in database/*.sql.
-- ---------------------------------------------------------------------
do $$
begin
  create type sharing_effect_level as enum ('none', 'coarse', 'current', 'history');
exception
  when duplicate_object then null;
end $$;

create table if not exists sharing_policies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- NULL viewer_id = applies to all friends
  viewer_id uuid references auth.users(id) on delete cascade,
  conditions jsonb not null default '[]'
    check (pg_column_size(conditions) <= 8192),
  effect_level sharing_effect_level not null default 'current',
  coarse_radius_m real,
  priority integer not null default 0,
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_sharing_policies_owner on sharing_policies (owner_id);
create index if not exists idx_sharing_policies_viewer on sharing_policies (owner_id, viewer_id);

-- A 'coarse' policy without a radius used to fall through to exact
-- coordinates. NOT VALID: enforced for new/updated rows only.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sharing_policies_coarse_radius'
  ) then
    alter table sharing_policies
      add constraint sharing_policies_coarse_radius
      check (effect_level <> 'coarse' or (coarse_radius_m is not null and coarse_radius_m > 0))
      not valid;
  end if;
end $$;

alter table sharing_policies enable row level security;
drop policy if exists sharing_policies_manage_own on sharing_policies;
create policy sharing_policies_manage_own on sharing_policies
for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
drop policy if exists sharing_policies_read_as_viewer on sharing_policies;
create policy sharing_policies_read_as_viewer on sharing_policies
for select using (auth.uid() = viewer_id);

-- Size limits that only the CI schema had. NOT VALID: enforced for new rows
-- without failing on any oversized rows already stored.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_content_check') then
    alter table messages add constraint messages_content_check
      check (length(content) <= 10000) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'location_reactions_emoji_check') then
    alter table location_reactions add constraint location_reactions_emoji_check
      check (length(emoji) <= 10) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'location_reactions_message_check') then
    alter table location_reactions add constraint location_reactions_message_check
      check (length(message) <= 500) not valid;
  end if;
end $$;

-- join_group_by_invite with the join-rate limit the CI schema had.
create or replace function join_group_by_invite(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_group_id uuid;
  v_recent_joins int;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select count(*) into v_recent_joins
  from group_members
  where user_id = auth.uid()
    and joined_at > now() - interval '1 minute';
  if v_recent_joins >= 10 then
    raise exception 'Too many join attempts. Please wait.';
  end if;

  select id into v_group_id from groups where invite_code = p_invite_code;
  if v_group_id is null then
    raise exception 'Invalid invite code';
  end if;

  if exists (
    select 1 from blocked_users bu
    join groups g on g.id = v_group_id
    where (bu.blocker_id = g.owner_id and bu.blocked_id = auth.uid())
       or (bu.blocker_id = auth.uid() and bu.blocked_id = g.owner_id)
  ) then
    raise exception 'Cannot join this group';
  end if;

  if exists (select 1 from group_members where group_id = v_group_id and user_id = auth.uid()) then
    return v_group_id;
  end if;

  insert into group_members (group_id, user_id, role, joined_at)
  values (v_group_id, auth.uid(), 'member', now());

  return v_group_id;
end;
$$;

-- Guard the CI schema had; now also unreachable by clients (section 6).
create or replace function decrement_claim_count(p_drop_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if coalesce(current_setting('app.claim_count_update', true), '') <> 'true' then
    raise exception 'Forbidden: can only be called as compensation after increment_claim_count';
  end if;
  update geo_drops
  set claim_count = greatest(claim_count - 1, 0), updated_at = now()
  where id = p_drop_id;
end;
$$;

-- geo_drops columns used by pin-monitor and SBPP. Not added to the column
-- GRANT lists, so clients cannot read them.
alter table geo_drops add column if not exists pin_status jsonb;
alter table geo_drops add column if not exists search_tokens jsonb;
create index if not exists idx_geo_drops_search_tokens
  on geo_drops using gin (search_tokens jsonb_path_ops);

-- ---------------------------------------------------------------------
-- 9. Post images: the read policy let anyone (including anon) list every
--    user's folder. The bucket is public, so known URLs still load; only
--    listing is restricted to the owner's own folder.
-- ---------------------------------------------------------------------
drop policy if exists post_images_read_public on storage.objects;
create policy post_images_read_own on storage.objects
for select to authenticated
using (bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------
-- 10. Pin search_path on every SECURITY DEFINER function in public, so a
--     caller-controlled search_path cannot redirect unqualified names.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'
      )
  loop
    execute format('alter function %s set search_path = public, extensions, pg_temp', r.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- migration: 20261014000019_server_side_drop_creation.sql
-- ---------------------------------------------------------------------
-- =====================================================================
-- Server-side drop creation (create-drop Edge Function).
--
-- Drop content is encrypted with a key derived from the server secret, which
-- clients never hold. A client-inserted geo_drops row therefore cannot carry
-- content anyone can decrypt, and it would skip create-drop's validation and
-- rate limits (e.g. map spam with undecryptable drops). Creation is now
-- server-only.
--
-- RLS impact: anon/authenticated lose INSERT on geo_drops; the existing
-- geo_drops_insert policy stays for documentation but no longer applies to
-- clients. SELECT/UPDATE/DELETE are unchanged. drop_shares inserts (sharing
-- an existing drop) are unchanged.
-- =====================================================================

revoke insert on geo_drops from anon, authenticated;
grant insert on geo_drops to service_role;
