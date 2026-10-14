#!/usr/bin/env node
/**
 * One-time migration: hash plaintext `secret`-method proof_config.requirements
 * into the new geo_drops.proof_secret_hashes column, and strip the plaintext
 * from proof_config.
 *
 * Context: prior to the 2026-07-09 security fix, createDrop() stored
 * secret-method requirements' params.secret in plaintext inside proof_config
 * (a client-readable column), AND the production unlock-drop Edge Function
 * never checked it at all — a complete server-side authorization bypass for
 * secret-gated drops. Run this ONCE against production after applying
 * migration 20260709000014_secret_requirement_hardening.sql, before relying
 * on the new server-side enforcement in unlock-drop/index.ts.
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in the environment
 * (service role — this needs to read/write proof_secret_hashes and the
 * plaintext-bearing proof_config, both withheld from anon/authenticated).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate-proof-secrets.mjs [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';

const DRY_RUN = process.argv.includes('--dry-run');

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey);

/** Same format as @zairn/geo-drop crypto.ts hashPassword: PBKDF2-SHA256, "salt_b64:hash_b64". */
async function hashSecret(secret) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
  return `${toB64(salt)}:${toB64(new Uint8Array(hash))}`;
}

async function main() {
  console.log(DRY_RUN ? 'Dry run — no writes will be made.' : 'LIVE run — this will modify geo_drops rows.');

  // proof_config is a JSONB column; filter client-side since JSONB path
  // queries would need to know the requirement index up front.
  const { data: drops, error } = await supabase
    .from('geo_drops')
    .select('id, proof_config, proof_secret_hashes')
    .not('proof_config', 'is', null);

  if (error) {
    console.error('Failed to fetch drops:', error.message);
    process.exit(1);
  }

  let scanned = 0;
  let migrated = 0;
  let skipped = 0;

  for (const drop of drops ?? []) {
    scanned++;
    const config = drop.proof_config;
    if (!config || !Array.isArray(config.requirements)) { skipped++; continue; }

    const existingHashes = drop.proof_secret_hashes ?? {};
    const newHashes = { ...existingHashes };
    let touched = false;

    const requirements = await Promise.all(config.requirements.map(async (req, idx) => {
      if (req?.method !== 'secret') return req;
      const plaintext = req.params?.secret;
      if (typeof plaintext !== 'string' || plaintext.length === 0) return req; // already migrated or empty
      touched = true;
      newHashes[String(idx)] = await hashSecret(plaintext);
      const { secret: _drop, ...restParams } = req.params ?? {};
      return { ...req, params: restParams };
    }));

    if (!touched) { skipped++; continue; }

    migrated++;
    console.log(`${DRY_RUN ? '[dry-run] would migrate' : 'migrating'} drop ${drop.id} (${Object.keys(newHashes).length - Object.keys(existingHashes).length} secret requirement(s))`);

    if (!DRY_RUN) {
      const { error: updateError } = await supabase
        .from('geo_drops')
        .update({ proof_config: { ...config, requirements }, proof_secret_hashes: newHashes })
        .eq('id', drop.id);
      if (updateError) {
        console.error(`  FAILED to update drop ${drop.id}:`, updateError.message);
      }
    }
  }

  console.log(`\nScanned ${scanned} drops with proof_config. Migrated ${migrated}. Skipped (no plaintext secret) ${skipped}.`);
  if (DRY_RUN && migrated > 0) {
    console.log('Re-run without --dry-run to apply.');
  }
}

main();
