# @zairn/sdk

TypeScript SDK for the **Zairn** location sharing platform. Built on Supabase.

## Installation

```bash
pnpm add @zairn/sdk @supabase/supabase-js
```

## Quick Start

```typescript
import { createLocationCore } from '@zairn/sdk';

const core = createLocationCore({
  supabaseUrl: 'https://your-project.supabase.co',
  supabaseAnonKey: 'your-anon-key',
});

// Sign in
await core.signIn('user@example.com', 'password');

// Share your location
await core.sendLocation({ lat: 35.6812, lon: 139.7671, accuracy: 10 });

// See friends on the map
const friends = await core.getVisibleFriends();

// Real-time location updates
const channel = core.subscribeLocations(row => {
  console.log('Friend moved:', row);
});
```

## Features

### Location Sharing
- `sendLocation(update)` — Send current location
- `sendLocationWithTrail(update)` — Send location + record trail history
- `getVisibleFriends()` — Get all friends whose locations you can see
- `getLocationHistory(userId, options?)` — Get location trail

### Friends
- `sendFriendRequest(toUserId)` — Send a friend request
- `acceptFriendRequest(requestId)` — Accept a request (creates bidirectional share rules)
- `getFriends()` — List all friends
- `removeFriend(friendId)` — Remove a friend

### Profile
- `getProfile(userId)` — Get user profile
- `updateProfile(data)` — Update your profile
- `searchProfiles(query)` — Search users by name

### Groups
- `createGroup(name, memberIds)` — Create a group
- `joinGroup(inviteCode)` — Join via invite code
- `getGroups()` — List your groups
- `leaveGroup(groupId)` — Leave a group

### Chat
- `getOrCreateDirectChat(userId)` — Open a DM
- `sendMessage(roomId, body)` — Send a message
- `getMessages(roomId, options?)` — Get message history
- `subscribeMessages(roomId, callback)` — Real-time messages

### Reactions & Bump
- `sendReaction(toUserId, emoji)` — Send an emoji poke
- `getReceivedReactions()` — Get reactions received
- `findNearbyFriends(lat, lon)` — Detect friends nearby
- `recordBump(friendId, lat, lon)` — Record a bump event

### Favorites
- `addFavoritePlace(data)` — Add a favorite place (home, work, school, etc.)
- `getFavoritePlaces()` — List favorite places
- `updateFavoritePlace(id, data)` / `deleteFavoritePlace(id)`

### Settings
- `enableGhostMode(until?)` — Hide your location
- `disableGhostMode()` — Become visible again
- `updateSettings(data)` — Update user settings

### Realtime
- `subscribeLocations(callback)` — Real-time friend location updates
- `subscribeFriendRequests(callback)` — Real-time friend request notifications
- `subscribeReactions(callback)` — Real-time reaction notifications

## Database Setup

Apply the core schema and RLS policies to your Supabase project:

```bash
# In Supabase SQL Editor, run:
# 1. database/schema.sql
# 2. database/policies.sql
```

## Security

- All tables use Row Level Security (RLS)
- Location viewing requires explicit share rules
- Ghost mode prevents location tracking
- GPS coordinate validation prevents NaN/Infinity injection
- All user-provided IDs are validated before use in queries

## License

MIT
