-- =====================
-- geo-drop テーブル定義
-- 場所に紐づいたデータドロップ
-- =====================

create type drop_visibility as enum ('public', 'friends', 'private', 'password');
create type drop_content_type as enum ('text', 'image', 'audio', 'video', 'file', 'nft');
create type drop_status as enum ('active', 'expired', 'claimed', 'deleted');

-- メインテーブル
create table if not exists geo_drops (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users(id) on delete cascade,
  -- 場所
  lat double precision not null,
  lon double precision not null,
  geohash text not null,
  unlock_radius_meters real not null default 50,
  -- コンテンツ
  title text not null,
  description text,
  content_type drop_content_type not null default 'text',
  ipfs_cid text not null,
  encrypted boolean not null default true,
  encryption_salt text,
  -- アクセス制御
  visibility drop_visibility not null default 'public',
  password_hash text,
  max_claims integer,
  claim_count integer not null default 0,
  -- 期限
  expires_at timestamptz,
  status drop_status not null default 'active',
  -- メタデータ
  preview_url text,
  metadata jsonb,
  -- タイムスタンプ
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_geo_drops_creator on geo_drops (creator_id);
create index if not exists idx_geo_drops_geohash on geo_drops (geohash);
create index if not exists idx_geo_drops_status on geo_drops (status);
create index if not exists idx_geo_drops_geohash_status on geo_drops (geohash, status);

-- クレーム（受け取り記録）
create table if not exists drop_claims (
  id uuid primary key default gen_random_uuid(),
  drop_id uuid not null references geo_drops(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  lat double precision not null,
  lon double precision not null,
  distance_meters real not null,
  claimed_at timestamptz not null default now(),
  unique (drop_id, user_id)
);

create index if not exists idx_drop_claims_drop on drop_claims (drop_id);
create index if not exists idx_drop_claims_user on drop_claims (user_id);

-- レート制限ログ（GPS偽装対策）
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

-- 期限切れドロップの自動処理
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

-- pg_cronが有効な環境で実行:
-- select cron.schedule('cleanup-expired-drops', '*/15 * * * *', 'select cleanup_expired_drops()');
