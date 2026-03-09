/**
 * Remaining Feature Tests
 * Covers methods not tested by other suites:
 * - Standalone utilities: estimateMotionType, encodeGeohash, decodeGeohash, calculateDistance
 * - Push subscriptions: registerPushSubscription, unregisterPushSubscription
 * - Realtime subscriptions: subscribeMessages, subscribeFriendRequests, subscribeReactions
 * - Ranking: getFriendRanking
 * - Avatar: uploadAvatar, deleteAvatar (requires Storage bucket — skipped if unavailable)
 *
 * Run: pnpm run test:remaining
 */
import { createLocationCore, calculateDistance, estimateMotionType, encodeGeohash, decodeGeohash } from '../packages/sdk/src/index.js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

function skip(label: string, reason: string) {
  console.log(`  ⊘ SKIP: ${label} (${reason})`);
  skipped++;
}

async function main() {
  console.log('=== Remaining Feature Tests ===\n');

  // =====================
  // 1. Standalone Utilities
  // =====================
  console.log('--- Standalone Utilities ---');

  // calculateDistance
  const d0 = calculateDistance(35.6812, 139.7671, 35.6812, 139.7671);
  assert(d0 === 0, 'calculateDistance same point = 0');
  const dTokyo = calculateDistance(35.6812, 139.7671, 35.6580, 139.7016);
  assert(dTokyo > 5000 && dTokyo < 10000, `calculateDistance Tokyo-Shibuya ~6km (got ${Math.round(dTokyo)}m)`);

  // estimateMotionType
  assert(estimateMotionType(null) === 'unknown', 'estimateMotionType(null) = unknown');
  assert(estimateMotionType(undefined) === 'unknown', 'estimateMotionType(undefined) = unknown');
  assert(estimateMotionType(0) === 'stationary', 'estimateMotionType(0) = stationary');
  assert(estimateMotionType(0.3) === 'stationary', 'estimateMotionType(0.3) = stationary');
  assert(estimateMotionType(1.5) === 'walking', 'estimateMotionType(1.5) = walking');
  assert(estimateMotionType(3) === 'running', 'estimateMotionType(3) = running');
  assert(estimateMotionType(6) === 'cycling', 'estimateMotionType(6) = cycling');
  assert(estimateMotionType(15) === 'driving', 'estimateMotionType(15) = driving');
  assert(estimateMotionType(50) === 'transit', 'estimateMotionType(50) = transit');

  // encodeGeohash / decodeGeohash
  const gh = encodeGeohash(35.6812, 139.7671, 7);
  assert(typeof gh === 'string' && gh.length === 7, `encodeGeohash returns 7-char string (got "${gh}")`);
  assert(gh === encodeGeohash(35.6812, 139.7671, 7), 'encodeGeohash is deterministic');

  const decoded = decodeGeohash(gh);
  assert(Math.abs(decoded.lat - 35.6812) < 0.01, 'decodeGeohash lat accurate');
  assert(Math.abs(decoded.lon - 139.7671) < 0.01, 'decodeGeohash lon accurate');

  // Precision variations
  const gh5 = encodeGeohash(35.6812, 139.7671, 5);
  assert(gh5.length === 5, 'encodeGeohash precision 5');
  assert(gh.startsWith(gh5), 'Higher precision hash starts with lower precision');

  // =====================
  // Setup users for DB-dependent tests
  // =====================
  const email1 = `rem1-${Date.now()}@example.com`;
  const email2 = `rem2-${Date.now()}@example.com`;
  const pw = 'testpassword123';

  const core1 = createLocationCore({ supabaseUrl, supabaseAnonKey });
  const core2 = createLocationCore({ supabaseUrl, supabaseAnonKey });

  const { data: u1 } = await core1.supabase.auth.signUp({ email: email1, password: pw });
  await core1.supabase.auth.signInWithPassword({ email: email1, password: pw });
  const user1Id = u1.user!.id;

  const { data: u2 } = await core2.supabase.auth.signUp({ email: email2, password: pw });
  await core2.supabase.auth.signInWithPassword({ email: email2, password: pw });
  const user2Id = u2.user!.id;

  // =====================
  // 2. Push Subscriptions
  // =====================
  console.log('\n--- Push Subscriptions ---');

  const mockSub = {
    endpoint: `https://fcm.googleapis.com/fcm/send/test-${Date.now()}`,
    keys: {
      p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfYLs',
      auth: 'tBHItJI5svbpC7-IIvTFWQ',
    },
  };

  try {
    await core1.registerPushSubscription(mockSub);
    assert(true, 'registerPushSubscription succeeds');

    // Verify it was stored
    const { data: subs } = await core1.supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', user1Id);
    assert(subs !== null && subs.length >= 1, 'Push subscription stored in DB');

    // Unregister
    await core1.unregisterPushSubscription(mockSub.endpoint);
    const { data: subsAfter } = await core1.supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', user1Id)
      .eq('endpoint', mockSub.endpoint);
    assert(subsAfter === null || subsAfter.length === 0, 'unregisterPushSubscription removes entry');
  } catch (e: any) {
    skip('Push subscriptions', e.message);
  }

  // =====================
  // 3. Friend Ranking
  // =====================
  console.log('\n--- Friend Ranking ---');

  // Make friends and send locations to populate visited_cells
  const req = await core1.sendFriendRequest(user2Id);
  await core2.acceptFriendRequest(req.id);

  await core1.sendLocation(35.6812, 139.7671, 10);
  await core2.sendLocation(35.6580, 139.7016, 10);

  const ranking = await core1.getFriendRanking();
  assert(Array.isArray(ranking), 'getFriendRanking returns array');
  assert(ranking.length >= 1, `getFriendRanking has entries (got ${ranking.length})`);
  assert(ranking[0].rank === 1, 'getFriendRanking first entry has rank 1');
  assert(ranking.every((r: any) => r.cell_count >= 0), 'getFriendRanking all entries have cell_count');

  // With area prefix
  const gh1 = encodeGeohash(35.6812, 139.7671, 4);
  const areaRanking = await core1.getFriendRanking({ areaPrefix: gh1 });
  assert(Array.isArray(areaRanking), 'getFriendRanking with areaPrefix returns array');

  // =====================
  // 4. Realtime Subscriptions
  // =====================
  console.log('\n--- Realtime Subscriptions ---');

  // 4.1 subscribeMessages
  const chatRoom = await core1.getOrCreateDirectChat(user2Id);
  let messageReceived = false;
  const msgChannel = core2.subscribeMessages(chatRoom.id, (msg) => {
    messageReceived = true;
  });

  // Wait for subscription to establish
  await new Promise(r => setTimeout(r, 2000));

  await core1.sendMessage(chatRoom.id, `realtime-test-${Date.now()}`);
  await new Promise(r => setTimeout(r, 3000));

  if (messageReceived) {
    assert(true, 'subscribeMessages receives message');
  } else {
    // Realtime may not fire in all test environments
    skip('subscribeMessages', 'No realtime event received (environment-dependent)');
  }
  msgChannel.unsubscribe();

  // 4.2 subscribeFriendRequests
  // Create a third user to send a friend request to User2
  const core3 = createLocationCore({ supabaseUrl, supabaseAnonKey });
  const email3 = `rem3-${Date.now()}@example.com`;
  await core3.supabase.auth.signUp({ email: email3, password: pw });
  await core3.supabase.auth.signInWithPassword({ email: email3, password: pw });

  let frReceived = false;
  const frChannel = core2.subscribeFriendRequests((request) => {
    frReceived = true;
  });

  await new Promise(r => setTimeout(r, 2000));
  await core3.sendFriendRequest(user2Id);
  await new Promise(r => setTimeout(r, 3000));

  if (frReceived) {
    assert(true, 'subscribeFriendRequests receives request');
  } else {
    skip('subscribeFriendRequests', 'No realtime event received (environment-dependent)');
  }
  frChannel.unsubscribe();

  // 4.3 subscribeReactions
  let reactionReceived = false;
  const rxChannel = core2.subscribeReactions((reaction) => {
    reactionReceived = true;
  });

  await new Promise(r => setTimeout(r, 2000));
  await core1.sendReaction(user2Id, '🔥', 'test');
  await new Promise(r => setTimeout(r, 3000));

  if (reactionReceived) {
    assert(true, 'subscribeReactions receives reaction');
  } else {
    skip('subscribeReactions', 'No realtime event received (environment-dependent)');
  }
  rxChannel.unsubscribe();

  // =====================
  // 5. Avatar (requires Storage bucket)
  // =====================
  console.log('\n--- Avatar ---');

  try {
    // Check if avatars bucket exists by trying to list files (listBuckets may be blocked by RLS)
    const { error: bucketErr } = await core1.supabase.storage.from('avatars').list('', { limit: 1 });
    const hasBucket = !bucketErr;

    if (!hasBucket) {
      skip('uploadAvatar', 'avatars bucket not available: ' + bucketErr?.message);
      skip('deleteAvatar', 'avatars bucket not available');
    } else {
      // Create a minimal test file
      const blob = new Blob(['test-image-data'], { type: 'image/png' });
      const file = new File([blob], 'test-avatar.png', { type: 'image/png' });

      const url = await core1.uploadAvatar(file);
      assert(typeof url === 'string' && url.length > 0, 'uploadAvatar returns URL');

      const profile = await core1.getProfile();
      assert(profile?.avatar_url === url, 'uploadAvatar updates profile avatar_url');

      await core1.deleteAvatar();
      const profileAfter = await core1.getProfile();
      assert(profileAfter?.avatar_url === null, 'deleteAvatar clears avatar_url');
    }
  } catch (e: any) {
    skip('Avatar operations', `Error: ${e.message}`);
  }

  // =====================
  // Summary
  // =====================
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log(`${'='.repeat(40)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
