create type share_level as enum ('none','current','history');

create table if not exists locations_current (
  user_id uuid primary key,
  lat double precision not null,
  lon double precision not null,
  accuracy real,
  updated_at timestamptz not null default now()
);

create table if not exists share_rules (
  owner_id uuid not null,
  viewer_id uuid not null,
  level share_level not null default 'current',
  expires_at timestamptz,
  primary key (owner_id, viewer_id)
);

create table if not exists locations_history (
  id bigserial primary key,
  user_id uuid not null,
  lat double precision not null,
  lon double precision not null,
  accuracy real,
  recorded_at timestamptz not null default now()
);

create index if not exists idx_share_rules_owner on share_rules (owner_id);
create index if not exists idx_share_rules_owner_expiry on share_rules (owner_id, expires_at);
create index if not exists idx_history_user_time on locations_history (user_id, recorded_at desc);

-- プロフィール
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text,
  avatar_url text,
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
  unique (from_user_id, to_user_id)
);

create index if not exists idx_friend_requests_to_user on friend_requests (to_user_id, status);
create index if not exists idx_friend_requests_from_user on friend_requests (from_user_id, status);

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
  role text not null default 'member',
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
