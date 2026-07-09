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
