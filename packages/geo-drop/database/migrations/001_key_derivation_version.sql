-- Migration: Add key derivation version and encryption metadata
-- Required for crypto algorithm upgrades and post-quantum migration path

-- Key derivation version (1 = original, 2 = length-prefixed v2)
alter table geo_drops
  add column if not exists key_derivation_version smallint not null default 1;

-- Encryption algorithm identifier (for future migration)
alter table geo_drops
  add column if not exists encryption_algorithm text not null default 'aes-256-gcm';

-- Server secret version (for key rotation support)
-- When rotating GEODROP_ENCRYPTION_SECRET, old drops retain their
-- secret version. The server maintains a versioned secret map:
--   { 1: "old-secret", 2: "new-secret" }
alter table geo_drops
  add column if not exists server_secret_version smallint not null default 1;

comment on column geo_drops.key_derivation_version is
  'Key derivation format version. 1=v1 (geodrop:...), 2=v2 (length-prefixed). Required for decryption.';

comment on column geo_drops.encryption_algorithm is
  'Encryption algorithm identifier. Currently aes-256-gcm. Stored for future migration to post-quantum algorithms.';

comment on column geo_drops.server_secret_version is
  'Version of GEODROP_ENCRYPTION_SECRET used to encrypt this drop. Enables secret rotation without re-encrypting old drops.';
