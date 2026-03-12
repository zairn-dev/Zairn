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
