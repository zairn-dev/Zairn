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
