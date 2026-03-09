/**
 * Extended Feature Tests
 * Tests SDK methods not covered by existing test suites:
 * - Favorite places, blocking, status, share expiry
 * - Friend streaks, exploration/visited cells, area ranking
 * - Friend request reject/cancel, groups extended
 * - Trail (sendLocationWithTrail, getTrailFriendIds)
 *
 * Run: pnpm run test:extended
 */
import { createLocationCore } from '../packages/sdk/src/index.js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

async function setup() {
  const email1 = `ext1-${Date.now()}@example.com`;
  const email2 = `ext2-${Date.now()}@example.com`;
  const pw = 'testpassword123';

  const core1 = createLocationCore({ supabaseUrl, supabaseAnonKey });
  const core2 = createLocationCore({ supabaseUrl, supabaseAnonKey });

  const { data: u1 } = await core1.supabase.auth.signUp({ email: email1, password: pw });
  await core1.supabase.auth.signInWithPassword({ email: email1, password: pw });
  const user1Id = u1.user!.id;

  const { data: u2 } = await core2.supabase.auth.signUp({ email: email2, password: pw });
  await core2.supabase.auth.signInWithPassword({ email: email2, password: pw });
  const user2Id = u2.user!.id;

  return { core1, core2, user1Id, user2Id };
}

async function makeFriends(core1: any, core2: any, user2Id: string) {
  const req = await core1.sendFriendRequest(user2Id);
  await core2.acceptFriendRequest(req.id);
}

async function main() {
  console.log('=== Extended Feature Tests ===\n');

  const { core1, core2, user1Id, user2Id } = await setup();

  // =====================
  // Favorite Places
  // =====================
  console.log('--- Favorite Places ---');

  const place = await core1.addFavoritePlace({
    name: 'My Home',
    place_type: 'home',
    lat: 35.6812,
    lon: 139.7671,
    radius_meters: 100,
    icon: '🏠',
  });
  assert(place.id !== undefined, 'addFavoritePlace returns id');
  assert(place.name === 'My Home', 'addFavoritePlace name correct');
  assert(place.place_type === 'home', 'addFavoritePlace type correct');

  const places = await core1.getFavoritePlaces();
  assert(places.length >= 1, `getFavoritePlaces returns >= 1 (got ${places.length})`);
  assert(places.some((p: any) => p.id === place.id), 'getFavoritePlaces includes created place');

  const updated = await core1.updateFavoritePlace(place.id, { name: 'Home Sweet Home' });
  assert(updated.name === 'Home Sweet Home', 'updateFavoritePlace name updated');

  // checkAtFavoritePlace - at the location
  const atHome = await core1.checkAtFavoritePlace(35.6812, 139.7671);
  assert(atHome !== null, 'checkAtFavoritePlace detects presence at place');
  if (atHome) assert(atHome.id === place.id, 'checkAtFavoritePlace returns correct place');

  // checkAtFavoritePlace - far away
  const notAtHome = await core1.checkAtFavoritePlace(34.0, 135.0);
  assert(notAtHome === null, 'checkAtFavoritePlace returns null when far away');

  await core1.deleteFavoritePlace(place.id);
  const placesAfter = await core1.getFavoritePlaces();
  assert(!placesAfter.some((p: any) => p.id === place.id), 'deleteFavoritePlace removes place');

  // =====================
  // Status (emoji/text)
  // =====================
  console.log('\n--- Status ---');

  await core1.updateProfile({ username: `ext_user1_${Date.now()}`, display_name: 'Ext User 1' });

  await core1.setStatus('☕', 'Coffee time', 60);
  const profile = await core1.getProfile();
  assert(profile?.status_emoji === '☕', 'setStatus emoji saved');
  assert(profile?.status_text === 'Coffee time', 'setStatus text saved');
  assert(profile?.status_expires_at !== null, 'setStatus expires_at set');

  await core1.clearStatus();
  const profileCleared = await core1.getProfile();
  assert(profileCleared?.status_emoji === null, 'clearStatus removes emoji');
  assert(profileCleared?.status_text === null, 'clearStatus removes text');

  // =====================
  // Block/Unblock
  // =====================
  console.log('\n--- Block/Unblock ---');

  await core1.blockUser(user2Id);
  const blocked = await core1.getBlockedUsers();
  assert(blocked.includes(user2Id), 'blockUser adds to blocked list');

  const isBlocked = await core1.isBlocked(user2Id);
  assert(isBlocked === true, 'isBlocked returns true for blocked user');

  await core1.unblockUser(user2Id);
  const isBlockedAfter = await core1.isBlocked(user2Id);
  assert(isBlockedAfter === false, 'unblockUser removes block');

  const blockedAfter = await core1.getBlockedUsers();
  assert(!blockedAfter.includes(user2Id), 'getBlockedUsers no longer includes unblocked user');

  // =====================
  // Share Expiry
  // =====================
  console.log('\n--- Share Expiry ---');

  await core1.allow(user2Id, 'current');
  // Set expiry 1 hour from now
  await core1.setShareExpiry(user2Id, new Date(Date.now() + 3600000));

  // Verify via raw query that expires_at is set
  const { data: ruleData } = await core1.supabase
    .from('share_rules')
    .select('expires_at')
    .eq('owner_id', user1Id)
    .eq('viewer_id', user2Id)
    .single();
  assert(ruleData?.expires_at !== null, 'setShareExpiry sets expires_at');

  // Clean up
  await core1.revoke(user2Id);

  // =====================
  // Friend Request: reject & cancel
  // =====================
  console.log('\n--- Friend Request Reject/Cancel ---');

  // Reject flow
  const req1 = await core1.sendFriendRequest(user2Id);
  assert(req1.status === 'pending', 'sendFriendRequest creates pending request');

  const sentReqs = await core1.getSentRequests();
  assert(sentReqs.some((r: any) => r.id === req1.id), 'getSentRequests includes sent request');

  await core2.rejectFriendRequest(req1.id);
  const reqAfterReject = await core2.supabase
    .from('friend_requests')
    .select('status')
    .eq('id', req1.id)
    .single();
  assert(reqAfterReject.data?.status === 'rejected', 'rejectFriendRequest sets status to rejected');

  // Cancel flow: send new request, then cancel
  // Delete old rejected request first
  await core1.supabase.from('friend_requests').delete().eq('id', req1.id);

  const req2 = await core1.sendFriendRequest(user2Id);
  await core1.cancelFriendRequest(req2.id);
  const reqAfterCancel = await core1.supabase
    .from('friend_requests')
    .select('*')
    .eq('id', req2.id)
    .single();
  assert(reqAfterCancel.error?.code === 'PGRST116' || reqAfterCancel.data === null, 'cancelFriendRequest removes request');

  // =====================
  // Settings (updateSettings)
  // =====================
  console.log('\n--- Settings ---');

  await core1.updateSettings({ location_update_interval: 60 });
  const settings = await core1.getSettings();
  assert(settings?.location_update_interval === 60, 'updateSettings changes interval');

  await core1.updateSettings({ location_update_interval: 30 });
  const settings2 = await core1.getSettings();
  assert(settings2?.location_update_interval === 30, 'updateSettings reverts interval');

  // =====================
  // Make friends for remaining tests
  // =====================
  await makeFriends(core1, core2, user2Id);

  // =====================
  // Groups Extended (getGroups, getOrCreateGroupChat)
  // =====================
  console.log('\n--- Groups Extended ---');

  const group = await core1.createGroup('Ext Test Group', 'A test group');
  await core2.joinGroup(group.invite_code!);

  const groups1 = await core1.getGroups();
  assert(groups1.some((g: any) => g.id === group.id), 'getGroups returns created group');

  const groupChat = await core1.getOrCreateGroupChat(group.id);
  assert(groupChat.type === 'group', 'getOrCreateGroupChat returns group type');
  assert(groupChat.group_id === group.id, 'getOrCreateGroupChat links to correct group');

  const members = await core1.getChatRoomMembers(groupChat.id);
  // Group chat members might be 0 if it uses group_members table directly
  assert(Array.isArray(members), 'getChatRoomMembers returns array');

  await core2.leaveGroup(group.id);
  await core1.deleteGroup(group.id);

  // =====================
  // Trail (sendLocationWithTrail, getTrailFriendIds)
  // =====================
  console.log('\n--- Trail ---');

  // sendLocationWithTrail should save location + history
  await core1.sendLocationWithTrail({ lat: 35.6812, lon: 139.7671, accuracy: 10 });
  const { data: histCheck } = await core1.supabase
    .from('locations_history')
    .select('*')
    .eq('user_id', user1Id)
    .order('recorded_at', { ascending: false })
    .limit(1);
  assert(histCheck !== null && histCheck.length > 0, 'sendLocationWithTrail saves history point');

  // Move 50m+ to trigger another history save
  await core1.sendLocationWithTrail({ lat: 35.6816, lon: 139.7676, accuracy: 10 });
  const { data: histCheck2 } = await core1.supabase
    .from('locations_history')
    .select('*')
    .eq('user_id', user1Id)
    .order('recorded_at', { ascending: false })
    .limit(5);
  assert(histCheck2 !== null && histCheck2.length >= 2, `sendLocationWithTrail records multiple history points (got ${histCheck2?.length})`);

  const trailFriends = await core1.getTrailFriendIds();
  assert(Array.isArray(trailFriends), 'getTrailFriendIds returns array');

  // =====================
  // getVisibleFriendsWithPlaces
  // =====================
  console.log('\n--- Visible Friends with Places ---');

  // Add a favorite place for User2
  const place2 = await core2.addFavoritePlace({
    name: 'Office',
    place_type: 'work',
    lat: 35.6815,
    lon: 139.7675,
    radius_meters: 50,
  });
  // User2 sends location at their office
  await core2.sendLocation(35.6815, 139.7675, 10);

  const friendsWithPlaces = await core1.getVisibleFriendsWithPlaces();
  assert(Array.isArray(friendsWithPlaces), 'getVisibleFriendsWithPlaces returns array');
  // At least User2 should be visible since they're friends
  const user2Entry = friendsWithPlaces.find((f: any) => f.user_id === user2Id);
  if (user2Entry) {
    assert(user2Entry.lat !== undefined, 'getVisibleFriendsWithPlaces includes location');
    // Place info might be included depending on implementation
    console.log(`  (User2 at_place: ${user2Entry.at_place_name ?? 'none'})`);
  }

  await core2.deleteFavoritePlace(place2.id);

  // =====================
  // Notification Preferences
  // =====================
  console.log('\n--- Notification Preferences ---');

  await core1.updateNotificationPreferences({
    friend_requests: true,
    reactions: false,
    chat_messages: true,
    bumps: false,
  });
  const prefs = await core1.getNotificationPreferences();
  assert(prefs !== null, 'getNotificationPreferences returns data');
  if (prefs) {
    assert(prefs.reactions === false, 'updateNotificationPreferences: reactions=false');
    assert(prefs.bumps === false, 'updateNotificationPreferences: bumps=false');
    assert(prefs.friend_requests === true, 'updateNotificationPreferences: friend_requests=true');
  }

  // =====================
  // Streaks
  // =====================
  console.log('\n--- Streaks ---');

  await core1.recordInteraction(user2Id);
  const streak = await core1.getStreak(user2Id);
  assert(streak !== null, 'getStreak returns data after interaction');
  if (streak) {
    assert(streak.current_streak >= 1, `getStreak current_streak >= 1 (got ${streak.current_streak})`);
  }

  const streaks = await core1.getStreaks();
  assert(Array.isArray(streaks), 'getStreaks returns array');
  assert(streaks.length >= 1, `getStreaks has at least 1 entry (got ${streaks.length})`);

  // =====================
  // Friends of Friends
  // =====================
  console.log('\n--- Friends of Friends ---');

  const fof = await core1.getFriendsOfFriends();
  assert(Array.isArray(fof), 'getFriendsOfFriends returns array');
  // With only 2 test users, there are no friends-of-friends
  assert(fof.length === 0, 'getFriendsOfFriends returns 0 with no mutual connections');

  // =====================
  // Visited Cells / Exploration
  // =====================
  console.log('\n--- Exploration / Visited Cells ---');

  // Location was already sent, so visited_cells should have entries via trigger
  const myCells = await core1.getMyVisitedCells();
  assert(Array.isArray(myCells), 'getMyVisitedCells returns array');
  assert(myCells.length >= 1, `getMyVisitedCells has entries (got ${myCells.length})`);

  const myStats = await core1.getMyExplorationStats();
  assert(myStats !== null, 'getMyExplorationStats returns data');
  if (myStats) {
    assert(Number(myStats.total_cells) >= 1, `total_cells >= 1 (got ${myStats.total_cells})`);
  }

  // Friend's visited cells (should be visible since we're friends)
  const friendCells = await core1.getFriendVisitedCells(user2Id);
  assert(Array.isArray(friendCells), 'getFriendVisitedCells returns array');

  // Area ranking
  const geohashPrefix = myCells.length > 0 ? myCells[0].geohash.slice(0, 4) : 'xn77';
  const ranking = await core1.getAreaRanking(geohashPrefix);
  assert(Array.isArray(ranking), 'getAreaRanking returns array');

  // =====================
  // Summary
  // =====================
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(40)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
