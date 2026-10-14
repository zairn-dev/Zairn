-- =====================================================================
-- Secret-requirement authorization bypass fix (2026-07-09)
--
-- geo_drops.proof_config can declare a `secret`-method requirement
-- (params.secret, checked client-side by verification.ts's pluggable
-- engine). That verifier only runs on the dev-only client-side unlock
-- path. The production path (supabase/functions/unlock-drop) never
-- checked it — a drop configured to require a secret could be unlocked
-- by anyone within GPS radius, without ever supplying the secret.
--
-- Fix: secrets are hashed (PBKDF2-SHA256, same format as password_hash)
-- into a new server-only column at createDrop() time, and stripped from
-- the client-readable proof_config. unlock-drop now verifies every
-- requirement server-side and fails closed on unsupported methods.
--
-- This column follows the same pattern as encryption_salt/password_hash/
-- encrypted_content: present in the base table, withheld from the
-- authenticated/anon column GRANT, accessible only via service_role.
-- =====================================================================

alter table geo_drops add column if not exists proof_secret_hashes jsonb;
comment on column geo_drops.proof_secret_hashes is
  'Server-only: PBKDF2-SHA256 hashes of secret-method proof requirements, keyed by requirement index. Never exposed to authenticated/anon roles. See unlock-drop Edge Function.';

-- Re-grant the same public column list as the 20260706000013 migration —
-- proof_secret_hashes is deliberately excluded (withheld by omission, the
-- fail-safe default documented in that migration).
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
--   server_secret_version, proof_secret_hashes.

-- ---------------------------------------------------------------------
-- Extend the existing sensitive-column-protection trigger (defense in
-- depth alongside the column GRANT above) to also block client updates
-- to proof_secret_hashes.
-- ---------------------------------------------------------------------
create or replace function protect_drop_sensitive_columns()
returns trigger as $$
begin
  if NEW.creator_id is distinct from OLD.creator_id then
    raise exception 'Cannot modify creator_id';
  end if;
  if NEW.encryption_salt is distinct from OLD.encryption_salt then
    raise exception 'Cannot modify encryption_salt';
  end if;
  if NEW.geohash is distinct from OLD.geohash then
    raise exception 'Cannot modify geohash';
  end if;
  -- Write-once: allow the one-time backfill (NULL -> value, e.g. via
  -- scripts/migrate-proof-secrets.mjs) but block modifying an
  -- already-set value.
  if OLD.proof_secret_hashes is not null
     and NEW.proof_secret_hashes is distinct from OLD.proof_secret_hashes then
    raise exception 'Cannot modify proof_secret_hashes once set';
  end if;
  return NEW;
end;
$$ language plpgsql;
