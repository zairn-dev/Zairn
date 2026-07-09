#!/usr/bin/env node
/**
 * Post-deploy Realtime RLS verification.
 *
 * migration 20240101000007_realtime_rls.sql restricts the
 * supabase_realtime publication to an explicit table list, and
 * 20260709000016_realtime_rls_healthcheck.sql adds a Postgres-side
 * healthcheck for publication membership. Neither can verify the OTHER
 * half of the requirement: hosted Supabase projects need "Realtime RLS"
 * toggled on in Dashboard > Database > Replication, which lives outside
 * pg_catalog and cannot be checked by SQL.
 *
 * This script is the only thing that actually exercises it: user B (who
 * has NO share_rule granting access to user A's location) subscribes to
 * locations_current, user A updates their location, and we assert B does
 * NOT receive the event within a timeout. If B DOES receive it, Realtime
 * RLS is not enforced and every user's raw location is broadcast to
 * everyone — run this after every deploy that touches Realtime config.
 *
 * (test/realtime-test.ts covers the POSITIVE case — an authorized viewer
 * DOES receive updates. This script covers the negative case that
 * actually matters for the security property.)
 *
 * Requires: SUPABASE_URL, SUPABASE_ANON_KEY in the environment.
 * Usage: node scripts/check-realtime-rls.mjs
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnonKey) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set.');
  process.exit(1);
}

const password = 'check-realtime-rls-test-pw-123';

async function signUpAndIn(email) {
  const client = createClient(supabaseUrl, supabaseAnonKey);
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw error;
  return { client, userId: data.user.id };
}

async function main() {
  console.log('=== Realtime RLS negative-case check ===\n');

  const stamp = Date.now();
  const { client: clientA, userId: userIdA } = await signUpAndIn(`rls-check-a-${stamp}@example.invalid`);
  const { client: clientB, userId: userIdB } = await signUpAndIn(`rls-check-b-${stamp}@example.invalid`);
  console.log(`User A: ${userIdA}`);
  console.log(`User B: ${userIdB} (no share_rule from A — should NOT see A's updates)\n`);

  // Deliberately do NOT create a share_rule from A to B.

  console.log('User B subscribing to locations_current...');
  let leaked = false;
  let leakedRow = null;
  const channel = clientB
    .channel('rls-check')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'locations_current' }, (payload) => {
      const row = payload.new ?? payload.old;
      if (row?.user_id === userIdA) {
        leaked = true;
        leakedRow = row;
      }
    })
    .subscribe();

  await new Promise((r) => setTimeout(r, 2000));

  console.log('User A sending a location update (no permission granted to B)...');
  const { error: upsertError } = await clientA.from('locations_current').upsert({
    user_id: userIdA,
    lat: 35.6812,
    lon: 139.7671,
    updated_at: new Date().toISOString(),
  });
  if (upsertError) {
    console.error('Failed to write test location:', upsertError.message);
    process.exitCode = 1;
  }

  const timeoutMs = 5000;
  const start = Date.now();
  while (!leaked && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
  }

  clientB.removeChannel(channel);

  console.log('');
  if (leaked) {
    console.error('FAIL: User B received User A\'s Realtime update with no share_rule granting access.');
    console.error('Realtime RLS is NOT enforced on this project — check Dashboard > Database > Replication.');
    console.error('Leaked row:', JSON.stringify(leakedRow));
    process.exitCode = 1;
  } else {
    console.log('PASS: User B received nothing in', timeoutMs, 'ms. Realtime RLS appears enforced.');
  }

  console.log('\n(Test users are not deleted — sign-up-only accounts, no cleanup endpoint from the anon key.');
  console.log(' If run against a shared project repeatedly, prune rls-check-*@example.invalid accounts periodically.)');
}

main().catch((err) => {
  console.error('check-realtime-rls failed:', err);
  process.exitCode = 1;
});
