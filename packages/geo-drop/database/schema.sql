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
  ipfs_cid text not null,
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
create or replace function increment_claim_count(drop_id uuid)
returns boolean as $$
declare
  updated_rows integer;
begin
  update geo_drops
  set claim_count = claim_count + 1, updated_at = now()
  where id = drop_id
    and (max_claims is null or claim_count < max_claims);
  get diagnostics updated_rows = row_count;
  return updated_rows > 0;
end;
$$ language plpgsql security definer;

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
