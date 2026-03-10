# zairn

An open-source location-sharing platform inspired by **Zenly** and **Sekai Camera**. Combining Zenly's real-time friend location sharing with Sekai Camera's vision of leaving digital content anchored to physical locations.

**Open source. Self-hostable. Privacy-first.**

## Why zairn?

Zenly made location sharing fun and meaningful with friends. Sekai Camera pioneered the concept of "air tagging" — attaching digital information to real-world places that others can discover when they visit. Both apps were ahead of their time and are no longer available.

zairn brings back these ideas as a unified open-source platform:
- **Zenly-style social map** — see where your friends are, chat, react, and explore together
- **Sekai Camera-style GeoDrop** — leave encrypted messages, images, and media at real locations for others to discover and unlock on-site

## Features

### Location Sharing (`@zairn/sdk`)
- Real-time location sharing with friends
- Friend requests and management
- Ghost mode (temporarily hide your location)
- Groups for sharing with multiple people
- Direct and group chat
- Location reactions (emoji pokes)
- Bump detection (nearby friends)
- Location history & trail recording
- Area exploration tracking (visited cells)
- Time-limited sharing with expiration

### GeoDrop (`@zairn/geo-drop`)
- Location-bound encrypted data drops
- AES-256-GCM encryption with location-derived keys
- Pluggable verification (GPS / secret / AR / custom)
- IPFS storage (optional — works in DB-only mode too)
- EVM on-chain persistence (optional)
- Image / audio / video / file content support
- Password-protected & private drops

## Tech Stack

- **Backend**: Supabase (PostgreSQL + Auth + Realtime)
- **SDK**: TypeScript
- **Web Frontend**: Vite + React 19 + Tailwind CSS 4 + Leaflet
- **Security**: Row Level Security (RLS) for all data
- **Storage**: IPFS via Pinata / web3.storage (optional)

## Project Structure

```
zairn/
├── packages/
│   ├── sdk/                # @zairn/sdk — location sharing core
│   │   └── src/
│   └── geo-drop/           # @zairn/geo-drop — location-bound drops
│       ├── src/
│       ├── database/       # GeoDrop schema & RLS policies
│       ├── contracts/      # Solidity smart contracts
│       └── protocol/       # Protocol specification
├── apps/
│   ├── web/                # Main web app (map, friends, chat, trails)
│   └── geo-drop-demo/      # GeoDrop demo app
├── database/
│   ├── schema.sql          # Core table definitions and indexes
│   └── policies.sql        # RLS policies for all tables
└── test/                   # Integration tests
```

## Quickstart

### Prerequisites

- Node.js 18+
- [pnpm](https://pnpm.io/) 9+
- A [Supabase](https://supabase.com/) project

### Setup

```bash
# Clone and install
git clone https://github.com/yourname/zairn.git
cd zairn
pnpm install

# Apply database schema
# Paste database/schema.sql then database/policies.sql in Supabase SQL Editor

# Configure environment
cp apps/web/.env.example apps/web/.env.local
# Edit with your VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY

# Start the web app
pnpm dev:web
```

### GeoDrop Demo

```bash
cp apps/geo-drop-demo/.env.example apps/geo-drop-demo/.env
# Edit with Supabase credentials (IPFS key is optional)

# Apply geo-drop tables
# Paste packages/geo-drop/database/schema.sql then policies.sql in Supabase SQL Editor

pnpm --filter geo-drop-demo dev
```

### SDK Usage

```ts
import { createLocationCore } from '@zairn/sdk';

const core = createLocationCore({
  supabaseUrl: 'https://your-project.supabase.co',
  supabaseAnonKey: 'your-anon-key',
});

await core.sendLocation({ lat: 35.0, lon: 139.0, accuracy: 10 });
const friends = await core.getVisibleFriends();

const channel = core.subscribeLocations(row => {
  console.log('location updated', row);
});
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

This project is not affiliated with Zenly, Snap Inc., or Tonchidot (Sekai Camera). It is an independent open-source project inspired by their concepts.
