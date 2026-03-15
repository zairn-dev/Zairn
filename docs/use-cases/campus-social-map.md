# Campus/Event Social Maps

## Problem

Student groups, conference attendees, and event organizers need private real-time location sharing without relying on big tech platforms that harvest data. They want features like "find my friends in the food court" or "see who is at the lecture hall," but with strong privacy controls -- nobody should be trackable when they go home for the night. Existing solutions are either all-or-nothing (share everything or nothing) or lack group-level granularity.

## Solution with Zairn

`@zairn/sdk` provides groups with real-time location sharing, ghost mode for instant opt-out, and sharing policies that automatically coarsen or hide location based on time of day, geofence, or proximity. Students can share precise location on campus during the day and automatically switch to coarse or hidden mode at night near their dorm.

- **Groups** -- create invite-code groups for a class, dorm floor, or conference track.
- **Ghost mode** -- one call to disappear instantly, with optional auto-expiry.
- **Sharing policies** -- rule-based conditions (time range, geofence, proximity) that control what viewers see without manual toggling.
- **Favorite places** -- label lecture halls, cafeterias, and dorms for contextual presence ("Alex is at the Library").

## Code Snippet

```typescript
import { createLocationCore } from '@zairn/sdk';

const core = createLocationCore({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
});

// --- Organizer: create a group for the CS department ---
const group = await core.createGroup('CS 2026 Cohort', 'Location sharing for the CS department');
console.log(`Share this invite code: ${group.invite_code}`);

// --- Student: join and start sharing ---
await core.joinGroup(group.invite_code);

// Send current location with motion context
await core.sendLocation({
  lat: 35.6586,
  lon: 139.7454,
  accuracy: 10,
  speed: 1.2,
  battery_level: 72,
});

// --- Privacy: auto-hide location near the dorm at night ---
await core.addSharingPolicy({
  conditions: [
    { type: 'time_range', start: '22:00', end: '07:00', timezone: 'Asia/Tokyo' },
    { type: 'geofence', lat: 35.6550, lon: 139.7440, radius_m: 200, inside: true },
  ],
  effect_level: 'none',   // fully hidden when both conditions match
  priority: 10,
  label: 'Ghost at dorm after 10 PM',
});

// Daytime on-campus: coarsen to 500 m for non-close-friends
await core.addSharingPolicy({
  conditions: [
    { type: 'proximity', max_distance_m: 1000 }, // only affects viewers > 1 km away
  ],
  effect_level: 'coarse',
  coarse_radius_m: 500,
  priority: 5,
  label: 'Coarse for distant viewers',
});

// --- Label important places ---
await core.addFavoritePlace({
  name: 'Main Lecture Hall',
  lat: 35.6590,
  lon: 139.7460,
  radius_meters: 50,
  category: 'school',
});

await core.addFavoritePlace({
  name: 'Dorm Room',
  lat: 35.6550,
  lon: 139.7440,
  radius_meters: 30,
  category: 'home',
});

// --- Quick ghost mode for a study break ---
await core.enableGhostMode(60); // invisible for 60 minutes

// --- See friends on the map ---
const friends = await core.getVisibleFriendsFiltered(35.6586, 139.7454);
for (const f of friends) {
  const motion = core.estimateMotionType(f.speed);
  console.log(`${f.user_id}: ${motion} at (${f.lat}, ${f.lon})${f.coarsened ? ' [approx]' : ''}`);
}

// --- Real-time updates ---
const channel = core.subscribeLocations((location) => {
  console.log(`${location.user_id} moved to (${location.lat}, ${location.lon})`);
});
```

## Next Steps

- **Favorite place presence** -- Use `checkAtFavoritePlace()` and `getVisibleFriendsWithPlaces()` to show contextual labels like "Alex is at the Library" instead of raw coordinates.
- **Bump detection** -- Call `findNearbyFriends()` to detect when friends are within Bluetooth range in a hallway, then `recordBump()` to log serendipitous meetups. Build a "hallway encounters" feed.
- **Group chat** -- Use `getOrCreateDirectChat()` and `sendMessage()` to add in-app messaging tied to location context (e.g., "I'm at the cafeteria, want to grab lunch?").
- **Event-scoped sharing** -- Set `expires_at` on share rules so location access automatically revokes when the conference ends.
