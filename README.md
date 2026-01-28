# Supabase Location Core (minimal)

Minimal Zenly-like location sharing core using Supabase. Includes SQL + RLS and a JS/TS SDK.

## Quickstart (about 5 minutes)
1) Create a Supabase project and grab `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
2) Apply `database/schema.sql` then `database/policies.sql` in the Supabase SQL editor (or `supabase db push`).
3) In your app, install `@supabase/supabase-js` and initialize the SDK:

```ts
import { createLocationCore } from './sdk/javascript/index';

const core = createLocationCore({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
});

await core.sendLocation(35.0, 139.0, 10);
const friends = await core.getVisibleFriends();
await core.allow('viewer-uuid', 'current');

const channel = core.subscribeLocations(row => {
  console.log('location updated', row);
});
// later: supabase.removeChannel(channel);
```

## Tables
- `locations_current`: latest position per user (upsert only).
- `share_rules`: who can see whose location; level in `('none','current','history')`; optional `expires_at` to time-limit visibility.
- `locations_history`: optional history log.

## RLS overview
- Users can write/update only their own location.
- Users can manage only their own share rules.
- Readers must be the owner or be allowed in `share_rules` with an unexpired rule.
- History requires `level = 'history'` and an unexpired rule.

## Recommended flow
- Auth: use Supabase Auth; the SDK throws if not authenticated.
- Background: call `sendLocation` on an interval (respect OS background policies).
- Sharing: call `allow(viewerId, level)` to grant visibility; `revoke` to remove.
- Reading: call `getVisibleFriends()`; RLS filters invisible users automatically.
- Realtime (optional): subscribe to `locations_current` updates for live UI.

## Notes
- Keep `locations_history` insert optional if you want battery/network savings.
- Add client-side rate limits for location uploads.
- You can extend `share_rules` to support groups or temporary links without API changes.
