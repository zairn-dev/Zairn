# Alternate Reality Games (ARG)

## Problem

ARG designers need to hide encrypted clues at real-world locations with multi-factor verification. Players should physically visit sites, scan QR codes or interact with physical props, and solve puzzles to advance. Existing tools either lack location verification or require building custom infrastructure from scratch. Chaining clues -- where each unlock reveals the next destination -- is especially tedious to implement securely.

## Solution with Zairn

GeoDrop supports chained unlocks with multi-factor proof configurations. Each drop can require GPS proximity **and** a secret (obtained from a QR code, NFC tag, or spoken passphrase at the site). When a player unlocks a drop, the decrypted content contains the next location and secret hint, forming a treasure trail.

- **GPS + secret combo** -- `proof_config` with `mode: 'all'` requires both physical presence and a site-specific secret.
- **Chained clues** -- each drop's content includes coordinates and hints for the next drop.
- **Claim limits** -- use `max_claims` to make drops first-come-first-served for competitive games.
- **Expiration** -- time-limited events with `expires_at`.

## Code Snippet

```typescript
import { createGeoDrop } from '@zairn/geo-drop';

const geo = createGeoDrop({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY!,
  encryptionSecret: process.env.ENCRYPTION_SECRET!,
});

// --- Game designer: create a 3-clue treasure trail ---

// Clue 3 (final) -- placed first so we have its ID for clue 2's content
const clue3 = await geo.createDrop(
  {
    title: 'The Final Key',
    content_type: 'text',
    lat: 48.8584,
    lon: 2.2945,
    unlock_radius_meters: 20,
    visibility: 'public',
    max_claims: 10, // only first 10 players win
    proof_config: {
      mode: 'all',
      requirements: [
        { method: 'gps', params: {} },
        { method: 'secret', params: { secret: 'IRON-LATTICE-1889', label: 'Find the plaque' } },
      ],
    },
  },
  'Congratulations! You solved the Parisian Cipher. Claim your prize at the gift shop.',
);

// Clue 2 -- content reveals clue 3's location and hint
const clue2 = await geo.createDrop(
  {
    title: 'The River Crossing',
    content_type: 'text',
    lat: 48.8566,
    lon: 2.3522,
    unlock_radius_meters: 30,
    proof_config: {
      mode: 'all',
      requirements: [
        { method: 'gps', params: {} },
        { method: 'secret', params: { secret: 'SEINE-MIRROR', label: 'Scan the QR on the bridge' } },
      ],
    },
  },
  `Next: Head to the iron tower. Look for a plaque near the south pillar. ` +
  `Coordinates: 48.8584, 2.2945 | Passphrase is engraved on it.`,
);

// Clue 1 (starting point) -- shared publicly as the game entry
const clue1 = await geo.createDrop(
  {
    title: 'The Parisian Cipher - START',
    content_type: 'text',
    lat: 48.8606,
    lon: 2.3376,
    unlock_radius_meters: 50,
    proof_config: {
      mode: 'all',
      requirements: [
        { method: 'gps', params: {} },
        { method: 'secret', params: { secret: 'GLASS-PYRAMID', label: 'Find the QR near the entrance' } },
      ],
    },
  },
  `Well done! The next clue awaits at the river. ` +
  `Head to: 48.8566, 2.3522. Scan the QR code on the bridge railing.`,
);

console.log(`Game starts at drop: ${clue1.id}`);

// --- Player: at clue 1's location with the QR secret ---
const { content } = await geo.unlockDrop(
  clue1.id,
  48.8607,  // player lat
  2.3377,   // player lon
  8,        // accuracy
  undefined,
  [
    { method: 'gps', data: { lat: 48.8607, lon: 2.3377, accuracy: 8 } },
    { method: 'secret', data: { secret: 'GLASS-PYRAMID' } },
  ],
);

console.log(content);
// => "Well done! The next clue awaits at the river. Head to: 48.8566, 2.3522..."
```

## Next Steps

- **ZKP for competitive privacy** -- In multiplayer ARGs, use `generateProximityProof()` so the server confirms a player reached a checkpoint without learning their exact coordinates. Other players cannot stalk competitors by watching GPS logs.
- **On-chain persistence** -- Set `persistence: 'on-chain'` to create permanent game worlds where clue chains are anchored on-chain and can be replayed or extended by the community.
- **AR proof for landmark puzzles** -- Add `ar` requirements so players must photograph a specific mural or statue, verified via DINOv2 feature matching, adding a visual puzzle layer.
- **Time-gated chapters** -- Use `expires_at` to release new clue chains on a schedule, turning the ARG into a serialized event.
