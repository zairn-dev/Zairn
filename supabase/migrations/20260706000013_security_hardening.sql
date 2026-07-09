-- =====================================================================
-- Security hardening migration (2026-07-06)
--
-- Closes three RLS/view leaks found in the security audit:
--   1. geo_drops secret columns (encrypted_content, encryption_salt,
--      password_hash, search_tokens) were readable by any authenticated
--      user because RLS grants row-level SELECT on the whole row. The SDK
--      excludes them by naming columns, but a raw PostgREST query
--      (`select encryption_salt from geo_drops`) still returned them,
--      enabling offline password brute-force and offline decryption.
--   2. geo_drops_public view ran as owner (no security_invoker), bypassing
--      RLS and exposing private/friends-only drops' coordinates to everyone.
--   3. visited_cell_stats view (security_barrier only) likewise bypassed
--      RLS, leaking every user's exploration aggregates.
--
-- The unlock-drop Edge Function uses the service_role, which bypasses both
-- RLS and column grants, so server-side decryption is unaffected.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Column-level SELECT on geo_drops for the API roles.
--
-- Postgres column privileges are additive: a table-level SELECT grant
-- exposes ALL columns regardless of any per-column REVOKE. So we must
-- drop the table-level grant and re-grant only the non-secret columns.
--
-- NOTE FOR MAINTAINERS: any NEW column added to geo_drops is private to
-- authenticated/anon until you add it to this GRANT list. That is the
-- intended fail-safe default — expose columns deliberately.
-- ---------------------------------------------------------------------
revoke select on geo_drops from authenticated;
revoke select on geo_drops from anon;

grant select (
  id, creator_id,
  lat, lon, geohash, unlock_radius_meters,
  title, description, content_type, ipfs_cid, encrypted,
  visibility, max_claims, claim_count, proof_config,
  expires_at, status,
  preview_url, metadata,
  persistence_level, metadata_cid, chain_tx_hash,
  created_at, updated_at
) on geo_drops to authenticated;

grant select (
  id, creator_id,
  lat, lon, geohash, unlock_radius_meters,
  title, description, content_type, ipfs_cid, encrypted,
  visibility, max_claims, claim_count, proof_config,
  expires_at, status,
  preview_url, metadata,
  persistence_level, metadata_cid, chain_tx_hash,
  created_at, updated_at
) on geo_drops to anon;

-- Withheld (never exposed to client roles):
--   encrypted_content, encryption_salt, password_hash, search_tokens,
--   pin_status, key_derivation_version, encryption_algorithm,
--   server_secret_version.
--
-- FOLLOW-UP (code, not covered here): proof_config for 'secret'-method
-- drops currently stores the plaintext unlock secret. It is exposed above
-- because clients need the unlock requirements, so the secret must be
-- HASHED (like password_hash) in createDrop / verified server-side —
-- see verification.ts secret verifier.

-- ---------------------------------------------------------------------
-- 2. + 3. Make views respect the querying user's RLS.
--     security_invoker requires PostgreSQL 15+ (Supabase default).
-- ---------------------------------------------------------------------
alter view geo_drops_public set (security_invoker = on);
alter view visited_cell_stats set (security_invoker = on);
