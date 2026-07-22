-- Add versioned encryption metadata used by @zairn/geo-drop.
alter table geo_drops
  add column if not exists key_derivation_version smallint not null default 1;

alter table geo_drops
  add column if not exists encryption_algorithm text not null default 'aes-256-gcm';

alter table geo_drops
  add column if not exists server_secret_version smallint not null default 1;

comment on column geo_drops.key_derivation_version is
  'Key derivation format version. 1=v1 (geodrop:...), 2=v2 (length-prefixed). Required for decryption.';

comment on column geo_drops.encryption_algorithm is
  'Encryption algorithm identifier. Currently aes-256-gcm. Stored for future migration to post-quantum algorithms.';

comment on column geo_drops.server_secret_version is
  'Version of GEODROP_ENCRYPTION_SECRET used to encrypt this drop. Enables secret rotation without re-encrypting old drops.';
