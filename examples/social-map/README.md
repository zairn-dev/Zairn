# Social Map Example

Minimal private location sharing app using `@zairn/sdk`.

Demonstrates:
- Sign up / sign in two users
- Send & accept friend requests
- Share GPS location in real-time
- See friends on a Leaflet map

## Setup

```bash
# From the repo root
pnpm demo:bootstrap    # or manual: pnpm install && pnpm db:start

# Start the example
pnpm --filter social-map-example dev
```

Open two browser tabs (or use two devices) to sign in as different users.

## How it works

1. **Auth** — Uses Supabase Auth via `core.signIn()` / `core.signUp()`
2. **Friends** — `core.sendFriendRequest()` + `core.acceptFriendRequest()` creates bidirectional share rules
3. **Location** — `core.sendLocation()` writes to `locations_current`; `core.getVisibleFriends()` reads based on share rules
4. **Realtime** — `core.subscribeLocations()` for live updates via Supabase Realtime

All data is protected by Row Level Security — you can only see friends who have shared with you.
