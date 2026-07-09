-- SBPP (Search-Bound Proximity Proofs) schema
-- Adds session management and encrypted search index tables

-- Search sessions: server-issued nonces for search-proof binding
CREATE TABLE IF NOT EXISTS search_sessions (
  session_id  text PRIMARY KEY,
  nonce       text NOT NULL,
  user_id     uuid NOT NULL REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,  -- set when proof is verified; NULL = active

  CONSTRAINT search_sessions_nonce_unique UNIQUE (nonce)
);

-- Index: fast lookup by user for cleanup
CREATE INDEX IF NOT EXISTS idx_search_sessions_user
  ON search_sessions(user_id, created_at DESC);

-- Index: fast expiry purge
CREATE INDEX IF NOT EXISTS idx_search_sessions_expires
  ON search_sessions(expires_at)
  WHERE consumed_at IS NULL;

-- RLS: users can only see their own sessions. No client-side INSERT/UPDATE
-- policy — a client-choosable nonce would defeat the "server-issued
-- nonce" anti-replay property. All writes go through the SECURITY DEFINER
-- functions below (issue_search_session / consume_search_session), which
-- enforce auth.uid() themselves and bypass RLS for their own writes.
ALTER TABLE search_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY search_sessions_select_own ON search_sessions
  FOR SELECT USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION issue_search_session(p_ttl_seconds integer DEFAULT 300)
RETURNS TABLE (session_id text, nonce text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_session_id text;
  v_nonce text;
  v_expires_at timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  v_session_id := encode(gen_random_bytes(16), 'hex');
  v_nonce := encode(gen_random_bytes(32), 'hex');
  v_expires_at := now() + make_interval(secs => greatest(1, p_ttl_seconds));
  INSERT INTO search_sessions (session_id, nonce, user_id, expires_at)
  VALUES (v_session_id, v_nonce, auth.uid(), v_expires_at);
  RETURN QUERY SELECT v_session_id, v_nonce, v_expires_at;
END;
$$;

-- Atomic validate-and-consume: single UPDATE, all conditions in WHERE.
CREATE OR REPLACE FUNCTION consume_search_session(p_session_id text, p_nonce text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_updated integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  UPDATE search_sessions
  SET consumed_at = now()
  WHERE session_id = p_session_id
    AND nonce = p_nonce
    AND user_id = auth.uid()
    AND consumed_at IS NULL
    AND expires_at > now();
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION issue_search_session(integer) FROM public;
REVOKE ALL ON FUNCTION consume_search_session(text, text) FROM public;
GRANT EXECUTE ON FUNCTION issue_search_session(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION consume_search_session(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION cleanup_expired_search_sessions()
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  DELETE FROM search_sessions WHERE expires_at < now() - interval '1 hour';
$$;
REVOKE ALL ON FUNCTION cleanup_expired_search_sessions() FROM public;
GRANT EXECUTE ON FUNCTION cleanup_expired_search_sessions() TO authenticated, service_role;


-- Drop index tokens: HMAC-based encrypted search tokens per drop
CREATE TABLE IF NOT EXISTS drop_index_tokens (
  drop_id    uuid NOT NULL REFERENCES geo_drops(id) ON DELETE CASCADE,
  precision  smallint NOT NULL,
  token      text NOT NULL,

  PRIMARY KEY (drop_id, precision)
);

-- Index: token matching (the core search operation)
CREATE INDEX IF NOT EXISTS idx_drop_index_tokens_token
  ON drop_index_tokens(token);

-- RLS: tokens are readable by anyone (they're opaque HMAC hashes)
-- but only writable by the drop creator
ALTER TABLE drop_index_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY drop_index_tokens_read ON drop_index_tokens
  FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY drop_index_tokens_write ON drop_index_tokens
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM geo_drops WHERE id = drop_id AND creator_id = auth.uid())
  );

CREATE POLICY drop_index_tokens_delete ON drop_index_tokens
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM geo_drops WHERE id = drop_id AND creator_id = auth.uid())
  );
