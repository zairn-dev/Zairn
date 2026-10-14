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
