# OpenZenly

An open-source clone of Zenly, the beloved location-sharing app that was shut down in 2023. This project aims to recreate Zenly's core features using modern, open technologies.

**Open source. Self-hostable. Privacy-first.**

## Why OpenZenly?

Zenly was a unique app that made location sharing fun and meaningful with friends. When it was discontinued, many users lost a way to stay connected with their loved ones. OpenZenly aims to bring back that experience as an open-source alternative that anyone can use, modify, and self-host.

## Features

- Real-time location sharing with friends
- Friend requests and management
- Ghost mode (temporarily hide your location)
- Groups for sharing with multiple people
- Direct and group chat
- Location reactions (emoji pokes)
- Bump detection (nearby friends)
- Location history (with permission)
- Time-limited sharing with expiration

## Tech Stack

- **Backend**: Supabase (PostgreSQL + Auth + Realtime)
- **SDK**: TypeScript
- **Web Frontend**: Next.js 16 + React 19 + Tailwind CSS + Leaflet
- **Security**: Row Level Security (RLS) for data protection

## Quickstart

1. Create a Supabase project and grab `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
2. Apply `database/schema.sql` then `database/policies.sql` in the Supabase SQL editor (or `supabase db push`).
3. In your app, install `@supabase/supabase-js` and initialize the SDK:

```ts
import { createLocationCore } from './sdk/javascript/index';

const core = createLocationCore({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
});

await core.sendLocation(35.0, 139.0, 10);
const friends = await core.getVisibleFriends();

const channel = core.subscribeLocations(row => {
  console.log('location updated', row);
});
```

## Project Structure

```
├── database/
│   ├── schema.sql      # Table definitions and indexes
│   └── policies.sql    # RLS policies for all tables
├── sdk/
│   └── javascript/
│       └── index.ts    # TypeScript SDK
├── web/                # Next.js web frontend
└── test/               # Integration tests
```

## RLS Overview

- Users can only write/update their own data
- Location viewing requires permission via `share_rules`
- Friend request acceptance creates bidirectional share rules
- Chat access is restricted to room/group members
- All tables have RLS enabled by default

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This project is not affiliated with Zenly or Snap Inc. It is an independent open-source project inspired by Zenly's features.
