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
