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

-- RLS: users can only see/use their own sessions
ALTER TABLE search_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY search_sessions_own ON search_sessions
  FOR ALL USING (auth.uid() = user_id);


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
  FOR SELECT USING (true);

CREATE POLICY drop_index_tokens_write ON drop_index_tokens
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM geo_drops WHERE id = drop_id AND creator_id = auth.uid())
  );

CREATE POLICY drop_index_tokens_delete ON drop_index_tokens
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM geo_drops WHERE id = drop_id AND creator_id = auth.uid())
  );
