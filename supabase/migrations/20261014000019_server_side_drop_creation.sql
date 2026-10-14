-- =====================================================================
-- Server-side drop creation (create-drop Edge Function).
--
-- Drop content is encrypted with a key derived from the server secret, which
-- clients never hold. A client-inserted geo_drops row therefore cannot carry
-- content anyone can decrypt, and it would skip create-drop's validation and
-- rate limits (e.g. map spam with undecryptable drops). Creation is now
-- server-only.
--
-- RLS impact: anon/authenticated lose INSERT on geo_drops; the existing
-- geo_drops_insert policy stays for documentation but no longer applies to
-- clients. SELECT/UPDATE/DELETE are unchanged. drop_shares inserts (sharing
-- an existing drop) are unchanged.
-- =====================================================================

revoke insert on geo_drops from anon, authenticated;
grant insert on geo_drops to service_role;
