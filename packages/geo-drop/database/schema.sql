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
  -- Encrypted search (GridSE tokens)
  search_tokens jsonb, -- [{ precision: number, token: string }, ...]
  -- Timestamps
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_geo_drops_creator on geo_drops (creator_id);
create index if not exists idx_geo_drops_geohash on geo_drops (geohash);
create index if not exists idx_geo_drops_status on geo_drops (status);
create index if not exists idx_geo_drops_geohash_status on geo_drops (geohash, status);
create index if not exists idx_geo_drops_search_tokens on geo_drops using gin (search_tokens jsonb_path_ops);

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
